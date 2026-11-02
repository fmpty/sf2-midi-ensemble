/**
 * 原生合成引擎（Android）：AAudio 低延迟输出 + TinySoundFont 合成 SF2。
 *
 * 设计要点：
 * - 输出用 AAudio：EXCLUSIVE 共享模式 + LOW_LATENCY 性能模式，缓冲取一个 burst（通常 48~192 帧），
 *   端到端延迟一般在 10~20 ms，远低于 WebView 的 WebAudio（部分机型 300~400 ms 的深度缓冲）。
 * - TinySoundFont 不是线程安全的：所有音符/控制事件先写入无锁环形队列，
 *   由音频回调线程统一取出并交给 TSF，tsf 实例只在回调线程被访问。
 * - 通道 9 或显式指定时按鼓组（bank 128）取音色。
 */
#include <jni.h>

#include <aaudio/AAudio.h>
#include <android/log.h>

#include <atomic>
#include <cmath>
#include <cstring>
#include <new>

#define TSF_IMPLEMENTATION
#include "vendor/tsf.h"

#define LOG_TAG "NativeSynth"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

constexpr int QUEUE_SIZE = 4096; // 必须是 2 的幂
constexpr int MAX_QUEUE_MASK = QUEUE_SIZE - 1;

enum EventType {
    EV_NOTE_ON = 1,
    EV_NOTE_OFF,
    EV_CC,
    EV_PROGRAM,
    EV_BANK,
    EV_PITCH,
    EV_CH_VOLUME,
    EV_CH_PAN,
    EV_CH_SOUNDS_OFF,
    EV_ALL_NOTES_OFF,
    EV_VOICE_CAP,
};

struct MidiEvent {
    int type;
    int ch;
    int a;
    int b;
    float f;
};

MidiEvent g_queue[QUEUE_SIZE];
std::atomic<int> g_write{0};
std::atomic<int> g_read{0};

tsf *g_synth = nullptr;
AAudioStream *g_stream = nullptr;
std::atomic<int> g_sampleRate{48000};
std::atomic<int> g_framesPerBurst{0};
std::atomic<int> g_bufferFrames{0};
std::atomic<int> g_voices{0};
std::atomic<float> g_master{0.9f};
std::atomic<float> g_reverb{0.0f};

void pushEvent(const MidiEvent &e) {
    const int w = g_write.load(std::memory_order_relaxed);
    const int next = (w + 1) & MAX_QUEUE_MASK;
    if (next == g_read.load(std::memory_order_acquire)) return; // 满：丢弃最旧的声音事件，避免阻塞
    g_queue[w] = e;
    g_write.store(next, std::memory_order_release);
}

/* ----------------------------- 轻量混响（Freeverb 简化版） ----------------------------- */

const int COMB_L[3] = {1116, 1188, 1277};
const int COMB_R[3] = {1139, 1211, 1303};
const int ALLPASS_L[2] = {556, 441};
const int ALLPASS_R[2] = {579, 464};
const int RV_SIZE = 2048;

struct Comb {
    float buf[RV_SIZE] = {0};
    int idx = 0;
    float store = 0;
};

struct Allpass {
    float buf[RV_SIZE] = {0};
    int idx = 0;
};

struct ReverbState {
    Comb combL[3];
    Comb combR[3];
    Allpass apL[2];
    Allpass apR[2];
    bool init = false;
} g_rv;

float combProcess(Comb &c, int delay, float input, float feedback, float damp) {
    const int idx = (c.idx + 1) % RV_SIZE;
    int readIdx = idx - delay;
    while (readIdx < 0) readIdx += RV_SIZE;
    const float out = c.buf[readIdx];
    c.store = out * (1.0f - damp) + c.store * damp;
    c.buf[idx] = input + c.store * feedback;
    c.idx = idx;
    return out;
}

float allpassProcess(Allpass &a, int delay, float input, float g) {
    const int idx = (a.idx + 1) % RV_SIZE;
    int readIdx = idx - delay;
    while (readIdx < 0) readIdx += RV_SIZE;
    const float bufout = a.buf[readIdx];
    a.buf[idx] = input + bufout * g;
    a.idx = idx;
    return bufout - input;
}

void applyReverb(float *data, int frames, int channels, float wet) {
    if (!g_rv.init) {
        g_rv.init = true;
    }
    if (wet <= 0.001f) return;
    const float feedback = 0.78f;
    const float damp = 0.35f;
    const float apG = 0.5f;
    for (int i = 0; i < frames; i++) {
        const int base = i * channels;
        float inL = data[base];
        float inR = data[base + 1];
        float accL = 0.0f;
        float accR = 0.0f;
        for (int k = 0; k < 3; k++) {
            accL += combProcess(g_rv.combL[k], COMB_L[k], inL, feedback, damp);
            accR += combProcess(g_rv.combR[k], COMB_R[k], inR, feedback, damp);
        }
        for (int k = 0; k < 2; k++) {
            accL = allpassProcess(g_rv.apL[k], ALLPASS_L[k], accL, apG);
            accR = allpassProcess(g_rv.apR[k], ALLPASS_R[k], accR, apG);
        }
        data[base] = inL + accL * wet * 0.35f;
        data[base + 1] = inR + accR * wet * 0.35f;
    }
}

/* --------------------------------- 事件应用 --------------------------------- */

void applyEvent(tsf *f, const MidiEvent &e) {
    switch (e.type) {
        case EV_NOTE_ON:
            tsf_channel_note_on(f, e.ch, e.a, e.b / 127.0f);
            break;
        case EV_NOTE_OFF:
            tsf_channel_note_off(f, e.ch, e.a);
            break;
        case EV_CC:
            tsf_channel_midi_control(f, e.ch, e.a, e.b);
            break;
        case EV_PROGRAM:
            tsf_channel_set_presetnumber(f, e.ch, e.a, e.b);
            break;
        case EV_BANK:
            tsf_channel_set_bank(f, e.ch, e.a);
            break;
        case EV_PITCH:
            tsf_channel_set_pitchwheel(f, e.ch, e.a);
            break;
        case EV_CH_VOLUME:
            tsf_channel_set_volume(f, e.ch, e.f);
            break;
        case EV_CH_PAN:
            tsf_channel_set_pan(f, e.ch, e.f);
            break;
        case EV_CH_SOUNDS_OFF:
            tsf_channel_sounds_off_all(f, e.ch);
            break;
        case EV_ALL_NOTES_OFF:
            tsf_note_off_all(f);
            break;
        case EV_VOICE_CAP:
            tsf_set_max_voices(f, e.a);
            break;
        default:
            break;
    }
}

void drainEvents(tsf *f) {
    const int w = g_write.load(std::memory_order_acquire);
    int r = g_read.load(std::memory_order_relaxed);
    while (r != w) {
        applyEvent(f, g_queue[r]);
        r = (r + 1) & MAX_QUEUE_MASK;
    }
    g_read.store(r, std::memory_order_release);
}

/* --------------------------------- AAudio 回调 --------------------------------- */

aaudio_data_callback_result_t dataCallback(AAudioStream *stream, void *userData, void *audioData,
                                           int32_t numFrames) {
    (void)stream;
    (void)userData;
    float *out = static_cast<float *>(audioData);
    const int samples = numFrames * 2;
    tsf *f = g_synth;
    if (!f) {
        memset(out, 0, samples * sizeof(float));
        return AAUDIO_CALLBACK_RESULT_CONTINUE;
    }
    drainEvents(f);
    tsf_render_float(f, out, numFrames, 0);

    const float wet = g_reverb.load(std::memory_order_relaxed);
    if (wet > 0.001f) applyReverb(out, numFrames, 2, wet);

    const float vol = g_master.load(std::memory_order_relaxed);
    if (vol < 0.999f || vol > 1.001f) {
        for (int i = 0; i < samples; i++) out[i] *= vol;
    }
    g_voices.store(tsf_active_voice_count(f), std::memory_order_relaxed);
    return AAUDIO_CALLBACK_RESULT_CONTINUE;
}

void errorCallback(AAudioStream *stream, void *userData, aaudio_result_t error) {
    (void)stream;
    (void)userData;
    LOGE("AAudio 错误：%d", error);
}

bool openStream() {
    AAudioStreamBuilder *builder = nullptr;
    if (AAudio_createStreamBuilder(&builder) != AAUDIO_OK || !builder) return false;

    AAudioStreamBuilder_setDirection(builder, AAUDIO_DIRECTION_OUTPUT);
    AAudioStreamBuilder_setPerformanceMode(builder, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
    AAudioStreamBuilder_setSharingMode(builder, AAUDIO_SHARING_MODE_EXCLUSIVE);
    AAudioStreamBuilder_setFormat(builder, AAUDIO_FORMAT_PCM_FLOAT);
    AAudioStreamBuilder_setChannelCount(builder, 2);
    AAudioStreamBuilder_setSampleRate(builder, AAUDIO_UNSPECIFIED);
    AAudioStreamBuilder_setUsage(builder, AAUDIO_USAGE_GAME);
    AAudioStreamBuilder_setContentType(builder, AAUDIO_CONTENT_TYPE_MUSIC);
    AAudioStreamBuilder_setDataCallback(builder, dataCallback, nullptr);
    AAudioStreamBuilder_setErrorCallback(builder, errorCallback, nullptr);

    AAudioStream *stream = nullptr;
    aaudio_result_t r = AAudioStreamBuilder_openStream(builder, &stream);
    if (r != AAUDIO_OK || !stream) {
        // 独占模式可能被占用，退回共享模式
        LOGI("独占模式打开失败（%d），改用共享模式", r);
        AAudioStreamBuilder_setSharingMode(builder, AAUDIO_SHARING_MODE_SHARED);
        r = AAudioStreamBuilder_openStream(builder, &stream);
    }
    AAudioStreamBuilder_delete(builder);
    if (r != AAUDIO_OK || !stream) {
        LOGE("AAudio 打开失败：%d", r);
        return false;
    }

    const int32_t rate = AAudioStream_getSampleRate(stream);
    const int32_t burst = AAudioStream_getFramesPerBurst(stream);
    g_sampleRate.store(rate > 0 ? rate : 48000, std::memory_order_relaxed);
    g_framesPerBurst.store(burst > 0 ? burst : 0, std::memory_order_relaxed);

    if (g_synth) {
        tsf_set_output(g_synth, TSF_STEREO_INTERLEAVED, g_sampleRate.load(std::memory_order_relaxed), 0);
    }

    // 缓冲压到一个 burst：这是低延迟的关键（系统允许的最小值）
    if (burst > 0) {
        AAudioStream_setBufferSizeInFrames(stream, burst);
    }
    g_bufferFrames.store(AAudioStream_getBufferSizeInFrames(stream), std::memory_order_relaxed);

    r = AAudioStream_requestStart(stream);
    if (r != AAUDIO_OK) {
        LOGE("AAudio 启动失败：%d", r);
        AAudioStream_close(stream);
        return false;
    }
    g_stream = stream;
    LOGI("AAudio 已启动：%d Hz，burst=%d，buffer=%d 帧（约 %d ms）",
         (int)rate, (int)burst, (int)g_bufferFrames.load(std::memory_order_relaxed),
         (int)(g_bufferFrames.load(std::memory_order_relaxed) * 1000 / (rate > 0 ? rate : 48000)));
    return true;
}

} // namespace

extern "C" {

JNIEXPORT jboolean JNICALL
Java_com_sf2ensemble_synth_SynthBridge_nativeLoadBank(JNIEnv *env, jclass, jstring jpath) {
    const char *path = env->GetStringUTFChars(jpath, nullptr);
    if (!path) return JNI_FALSE;
    tsf *loaded = tsf_load_filename(path);
    env->ReleaseStringUTFChars(jpath, path);
    if (!loaded) {
        LOGE("音源加载失败");
        return JNI_FALSE;
    }
    tsf *old = g_synth;
    g_synth = loaded;
    tsf_set_output(loaded, TSF_STEREO_INTERLEAVED, g_sampleRate.load(std::memory_order_relaxed), 0);
    tsf_set_max_voices(loaded, 96);
    for (int ch = 0; ch < 16; ch++) tsf_channel_set_presetnumber(loaded, ch, 0, ch == 9 ? 1 : 0);
    if (old) tsf_close(old);
    LOGI("音源已加载：%d 个预设", tsf_get_presetcount(loaded));
    return JNI_TRUE;
}

JNIEXPORT jboolean JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeStart(JNIEnv *, jclass) {
    if (g_stream) return JNI_TRUE;
    return openStream() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeStop(JNIEnv *, jclass) {
    if (!g_stream) return;
    AAudioStream_requestStop(g_stream);
    AAudioStream_close(g_stream);
    g_stream = nullptr;
}

JNIEXPORT jboolean JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeIsRunning(JNIEnv *, jclass) {
    return g_stream ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeNoteOn(JNIEnv *, jclass, jint ch,
                                                                          jint note, jint vel) {
    MidiEvent e{EV_NOTE_ON, ch & 15, note & 127, vel & 127, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeNoteOff(JNIEnv *, jclass, jint ch,
                                                                           jint note) {
    MidiEvent e{EV_NOTE_OFF, ch & 15, note & 127, 0, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeControlChange(JNIEnv *, jclass, jint ch,
                                                                                 jint cc, jint value) {
    MidiEvent e{EV_CC, ch & 15, cc & 127, value & 127, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeProgramChange(JNIEnv *, jclass, jint ch,
                                                                                 jint program, jint drum) {
    MidiEvent e{EV_PROGRAM, ch & 15, program & 127, drum ? 1 : 0, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeBankSelect(JNIEnv *, jclass, jint ch,
                                                                              jint bank) {
    MidiEvent e{EV_BANK, ch & 15, bank & 0x7FFF, 0, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativePitchBend(JNIEnv *, jclass, jint ch,
                                                                             jint value) {
    MidiEvent e{EV_PITCH, ch & 15, value & 0x3FFF, 0, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeSetChannelVolume(JNIEnv *, jclass, jint ch,
                                                                                    jfloat v) {
    MidiEvent e{EV_CH_VOLUME, ch & 15, 0, 0, v};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeSetChannelPan(JNIEnv *, jclass, jint ch,
                                                                                 jfloat pan01) {
    MidiEvent e{EV_CH_PAN, ch & 15, 0, 0, pan01};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeChannelSoundsOff(JNIEnv *, jclass, jint ch) {
    MidiEvent e{EV_CH_SOUNDS_OFF, ch & 15, 0, 0, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeAllNotesOff(JNIEnv *, jclass) {
    MidiEvent e{EV_ALL_NOTES_OFF, 0, 0, 0, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeSetMasterVolume(JNIEnv *, jclass, jfloat v) {
    g_master.store(v, std::memory_order_relaxed);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeSetReverb(JNIEnv *, jclass, jfloat wet) {
    g_reverb.store(wet, std::memory_order_relaxed);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeSetVoiceCap(JNIEnv *, jclass, jint n) {
    MidiEvent e{EV_VOICE_CAP, 0, n, 0, 0};
    pushEvent(e);
}

JNIEXPORT jint JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeGetVoices(JNIEnv *, jclass) {
    return g_voices.load(std::memory_order_relaxed);
}

JNIEXPORT jint JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeGetSampleRate(JNIEnv *, jclass) {
    return g_sampleRate.load(std::memory_order_relaxed);
}

JNIEXPORT jint JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeGetBufferFrames(JNIEnv *, jclass) {
    return g_bufferFrames.load(std::memory_order_relaxed);
}

JNIEXPORT jint JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeGetBurstFrames(JNIEnv *, jclass) {
    return g_framesPerBurst.load(std::memory_order_relaxed);
}

JNIEXPORT jint JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeGetPresetCount(JNIEnv *, jclass) {
    return g_synth ? tsf_get_presetcount(g_synth) : 0;
}

/** 返回 "名称|bank|program"（bank 为 MSB<<7|LSB），供 JS 侧构造音色列表 */
JNIEXPORT jstring JNICALL Java_com_sf2ensemble_synth_SynthBridge_nativeGetPresetInfo(JNIEnv *env, jclass, jint index) {
    if (!g_synth || index < 0 || index >= tsf_get_presetcount(g_synth)) return env->NewStringUTF("");
    const char *name = tsf_get_presetname(g_synth, index);
    const struct tsf_preset *p = &g_synth->presets[index];
    char buf[320];
    snprintf(buf, sizeof(buf), "%s|%d|%d", name ? name : "Preset", (int)p->bank, (int)p->preset);
    return env->NewStringUTF(buf);
}

} // extern "C"
