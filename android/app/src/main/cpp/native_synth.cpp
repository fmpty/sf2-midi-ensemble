/**
 * 原生合成引擎（Android）：AAudio 低延迟输出 + TinySoundFont 合成 SF2。
 *
 * 设计要点：
 * - 输出用 AAudio：默认 SHARED（与系统其它播放器共存）；缓冲约 2~3 个 burst，避免欠载丢音。
 * - TinySoundFont 不是线程安全的：所有音符/控制事件先写入无锁环形队列，
 *   由音频回调线程统一取出并交给 TSF，tsf 实例只在回调线程被访问。
 * - 通道 9 或显式指定时按鼓组（bank 128）取音色。
 */
#include <jni.h>

#include <aaudio/AAudio.h>
#include <android/log.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <mutex>
#include <new>
#include <thread>
#include <vector>
#include <algorithm>

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

struct LoadedBank {
    tsf *font = nullptr;
};

std::vector<LoadedBank> g_banks;
std::vector<int> g_bankOrder;
int g_channelBank[16] = {0};
AAudioStream *g_stream = nullptr;
std::mutex g_streamMu;
std::atomic<int> g_wantRunning{0};
std::atomic<int> g_streamBroken{0};
std::atomic<int> g_restartPosted{0};
std::atomic<int> g_relaxedNext{0};
static thread_local std::vector<float> g_mixScratch;
std::atomic<int> g_sampleRate{48000};
std::atomic<int> g_framesPerBurst{0};
std::atomic<int> g_bufferFrames{0};
std::atomic<int> g_voices{0};
std::atomic<float> g_master{0.9f};
std::atomic<float> g_reverb{0.0f};

void pushEvent(const MidiEvent &e) {
    int w = g_write.load(std::memory_order_relaxed);
    int r = g_read.load(std::memory_order_acquire);
    int next = (w + 1) & MAX_QUEUE_MASK;
    if (next == r) {
        r = (r + 1) & MAX_QUEUE_MASK;
        g_read.store(r, std::memory_order_release);
    }
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

tsf *fontForChannel(int ch) {
    ch &= 15;
    if (g_banks.empty()) return nullptr;
    int bi = g_channelBank[ch];
    if (bi < 0 || bi >= (int)g_banks.size()) bi = 0;
    return g_banks[(size_t)bi].font;
}

void applyEventRouted(const MidiEvent &e) {
    if (e.type == EV_ALL_NOTES_OFF) {
        for (auto &b : g_banks) {
            if (b.font) tsf_note_off_all(b.font);
        }
        return;
    }
    if (e.type == EV_VOICE_CAP) {
        for (auto &b : g_banks) {
            if (b.font) tsf_set_max_voices(b.font, e.a);
        }
        return;
    }
    tsf *f = fontForChannel(e.ch);
    if (!f) return;
    applyEvent(f, e);
}

void drainEvents() {
    const int w = g_write.load(std::memory_order_acquire);
    int r = g_read.load(std::memory_order_relaxed);
    while (r != w) {
        applyEventRouted(g_queue[r]);
        r = (r + 1) & MAX_QUEUE_MASK;
    }
    g_read.store(r, std::memory_order_release);
}

void setOutputRateOnAllBanks(int rate) {
    if (rate <= 0) rate = 48000;
    for (auto &b : g_banks) {
        if (b.font) tsf_set_output(b.font, TSF_STEREO_INTERLEAVED, rate, 0);
    }
}

/* --------------------------------- AAudio 回调 --------------------------------- */

aaudio_data_callback_result_t dataCallback(AAudioStream *stream, void *userData, void *audioData,
                                           int32_t numFrames) {
    (void)stream;
    (void)userData;
    float *out = static_cast<float *>(audioData);
    const int samples = numFrames * 2;
    if (g_banks.empty()) {
        memset(out, 0, samples * sizeof(float));
        return AAUDIO_CALLBACK_RESULT_CONTINUE;
    }
    drainEvents();
    memset(out, 0, (size_t)samples * sizeof(float));
    if ((int)g_mixScratch.size() < samples) g_mixScratch.resize((size_t)samples);
    int voices = 0;
    for (auto &b : g_banks) {
        if (!b.font) continue;
        memset(g_mixScratch.data(), 0, (size_t)samples * sizeof(float));
        tsf_render_float(b.font, g_mixScratch.data(), numFrames, 0);
        for (int i = 0; i < samples; i++) out[i] += g_mixScratch[i];
        voices += tsf_active_voice_count(b.font);
    }

    const float wet = g_reverb.load(std::memory_order_relaxed);
    if (wet > 0.001f) applyReverb(out, numFrames, 2, wet);

    const float vol = g_master.load(std::memory_order_relaxed);
    if (vol < 0.999f || vol > 1.001f) {
        for (int i = 0; i < samples; i++) out[i] *= vol;
    }
    g_voices.store(voices, std::memory_order_relaxed);
    return AAUDIO_CALLBACK_RESULT_CONTINUE;
}

bool openStream();

void closeStreamLocked() {
    if (!g_stream) return;
    AAudioStream_requestStop(g_stream);
    AAudioStream_close(g_stream);
    g_stream = nullptr;
}

void recoverStreamLocked() {
    if (!g_wantRunning.load(std::memory_order_acquire)) return;
    if (g_stream) {
        const aaudio_stream_state_t st = AAudioStream_getState(g_stream);
        if (st == AAUDIO_STREAM_STATE_STARTED || st == AAUDIO_STREAM_STATE_STARTING) {
            g_streamBroken.store(0, std::memory_order_release);
            return;
        }
        if (st == AAUDIO_STREAM_STATE_PAUSED) {
            if (AAudioStream_requestStart(g_stream) == AAUDIO_OK) {
                g_streamBroken.store(0, std::memory_order_release);
                return;
            }
        }
        closeStreamLocked();
    }
    g_relaxedNext.store(1, std::memory_order_release);
    if (openStream()) {
        g_streamBroken.store(0, std::memory_order_release);
        LOGI("AAudio 已重开");
    } else {
        LOGE("AAudio 重开失败");
    }
}

void scheduleStreamRestart() {
    int expected = 0;
    if (!g_restartPosted.compare_exchange_strong(expected, 1)) return;
    std::thread([] {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        std::lock_guard<std::mutex> lock(g_streamMu);
        g_restartPosted.store(0, std::memory_order_release);
        recoverStreamLocked();
    }).detach();
}

void errorCallback(AAudioStream *stream, void *userData, aaudio_result_t error) {
    (void)stream;
    (void)userData;
    LOGE("AAudio 错误：%d", error);
    g_streamBroken.store(1, std::memory_order_release);
    if (g_wantRunning.load(std::memory_order_acquire)) scheduleStreamRestart();
}

void recoverStreamIfBroken() {
    if (!g_streamBroken.load(std::memory_order_acquire)) return;
    if (!g_wantRunning.load(std::memory_order_acquire)) return;
    std::lock_guard<std::mutex> lock(g_streamMu);
    recoverStreamLocked();
}

bool openStream() {
    AAudioStreamBuilder *builder = nullptr;
    if (AAudio_createStreamBuilder(&builder) != AAUDIO_OK || !builder) return false;

    const bool relaxed = g_relaxedNext.exchange(0, std::memory_order_acq_rel) != 0;
    AAudioStreamBuilder_setDirection(builder, AAUDIO_DIRECTION_OUTPUT);
    AAudioStreamBuilder_setPerformanceMode(builder, relaxed
            ? AAUDIO_PERFORMANCE_MODE_NONE
            : AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
    AAudioStreamBuilder_setSharingMode(builder, AAUDIO_SHARING_MODE_SHARED);
    AAudioStreamBuilder_setFormat(builder, AAUDIO_FORMAT_PCM_FLOAT);
    AAudioStreamBuilder_setChannelCount(builder, 2);
    AAudioStreamBuilder_setSampleRate(builder, AAUDIO_UNSPECIFIED);
    AAudioStreamBuilder_setUsage(builder, AAUDIO_USAGE_MEDIA);
    AAudioStreamBuilder_setContentType(builder, AAUDIO_CONTENT_TYPE_MUSIC);
    AAudioStreamBuilder_setDataCallback(builder, dataCallback, nullptr);
    AAudioStreamBuilder_setErrorCallback(builder, errorCallback, nullptr);

    AAudioStream *stream = nullptr;
    aaudio_result_t r = AAudioStreamBuilder_openStream(builder, &stream);
    AAudioStreamBuilder_delete(builder);
    if (r != AAUDIO_OK || !stream) {
        LOGE("AAudio 打开失败：%d", r);
        return false;
    }

    const int32_t rate = AAudioStream_getSampleRate(stream);
    const int32_t burst = AAudioStream_getFramesPerBurst(stream);
    g_sampleRate.store(rate > 0 ? rate : 48000, std::memory_order_relaxed);
    g_framesPerBurst.store(burst > 0 ? burst : 0, std::memory_order_relaxed);

    setOutputRateOnAllBanks(g_sampleRate.load(std::memory_order_relaxed));

    if (burst > 0) {
        const int32_t rateHz = rate > 0 ? rate : 48000;
        /* 大 burst 平板不必再叠 3 倍；总缓冲上限约 16 ms，兼顾稳定与延迟 */
        int32_t buf = burst >= 256 ? (burst + burst / 2) : (burst * 2);
        if (buf < burst + 64) buf = burst + 64;
        const int32_t capFrames = (rateHz * 16) / 1000;
        if (!relaxed && capFrames > burst && buf > capFrames) buf = capFrames;
        if (relaxed) {
            const int32_t roomy = (rateHz * 48) / 1000;
            if (buf < roomy) buf = roomy;
        }
        AAudioStream_setBufferSizeInFrames(stream, buf);
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

JNIEXPORT jint JNICALL
Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeAddBank(JNIEnv *env, jclass, jstring jpath) {
    const char *path = env->GetStringUTFChars(jpath, nullptr);
    if (!path) return -1;
    tsf *loaded = tsf_load_filename(path);
    env->ReleaseStringUTFChars(jpath, path);
    if (!loaded) {
        LOGE("音源加载失败");
        return -1;
    }
    const int rate = g_sampleRate.load(std::memory_order_relaxed);
    tsf_set_output(loaded, TSF_STEREO_INTERLEAVED, rate > 0 ? rate : 48000, 0);
    tsf_set_max_voices(loaded, 96);
    for (int ch = 0; ch < 16; ch++) tsf_channel_set_presetnumber(loaded, ch, 0, ch == 9 ? 1 : 0);
    LoadedBank slot;
    slot.font = loaded;
    g_banks.push_back(slot);
    const int index = (int)g_banks.size() - 1;
    g_bankOrder.push_back(index);
    LOGI("音源已加入 #%d：%d 个预设，共 %d 个音源", index, tsf_get_presetcount(loaded), (int)g_banks.size());
    return index;
}

JNIEXPORT jboolean JNICALL
Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeRemoveBank(JNIEnv *, jclass, jint index) {
    if (index < 0 || index >= (int)g_banks.size()) return JNI_FALSE;
    if (g_banks.size() <= 1) return JNI_FALSE;
    if (g_banks[(size_t)index].font) tsf_close(g_banks[(size_t)index].font);
    g_banks.erase(g_banks.begin() + index);
    std::vector<int> newOrder;
    for (int o : g_bankOrder) {
        if (o == index) continue;
        newOrder.push_back(o > index ? o - 1 : o);
    }
    if (newOrder.empty() && !g_banks.empty()) newOrder.push_back(0);
    g_bankOrder = newOrder;
    for (int i = 0; i < 16; i++) {
        if (g_channelBank[i] == index) g_channelBank[i] = 0;
        else if (g_channelBank[i] > index) g_channelBank[i]--;
    }
    return JNI_TRUE;
}

JNIEXPORT void JNICALL
Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeSetBankOrder(JNIEnv *env, jclass, jintArray jorder) {
    if (!jorder) return;
    const jsize len = env->GetArrayLength(jorder);
    if (len <= 0) return;
    jint *els = env->GetIntArrayElements(jorder, nullptr);
    if (!els) return;
    g_bankOrder.clear();
    for (jsize i = 0; i < len; i++) {
        const int idx = els[i];
        if (idx >= 0 && idx < (int)g_banks.size()) g_bankOrder.push_back(idx);
    }
    env->ReleaseIntArrayElements(jorder, els, JNI_ABORT);
    if (g_bankOrder.empty() && !g_banks.empty()) g_bankOrder.push_back(0);
}

JNIEXPORT void JNICALL
Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeSetChannelBank(JNIEnv *, jclass, jint ch, jint bankIndex) {
    ch &= 15;
    if (bankIndex < 0 || bankIndex >= (int)g_banks.size()) bankIndex = 0;
    g_channelBank[ch] = bankIndex;
}

JNIEXPORT jboolean JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeStart(JNIEnv *, jclass) {
    std::lock_guard<std::mutex> lock(g_streamMu);
    g_wantRunning.store(1, std::memory_order_release);
    if (g_stream) {
        const aaudio_stream_state_t st = AAudioStream_getState(g_stream);
        if (st == AAUDIO_STREAM_STATE_STARTED || st == AAUDIO_STREAM_STATE_STARTING) return JNI_TRUE;
        closeStreamLocked();
    }
    return openStream() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeStop(JNIEnv *, jclass) {
    g_wantRunning.store(0, std::memory_order_release);
    std::lock_guard<std::mutex> lock(g_streamMu);
    closeStreamLocked();
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeRecover(JNIEnv *, jclass) {
    if (!g_wantRunning.load(std::memory_order_acquire)) return;
    g_streamBroken.store(1, std::memory_order_release);
    std::lock_guard<std::mutex> lock(g_streamMu);
    recoverStreamLocked();
}

JNIEXPORT jboolean JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeIsRunning(JNIEnv *, jclass) {
    return g_stream ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeNoteOn(JNIEnv *, jclass, jint ch,
                                                                          jint note, jint vel) {
    recoverStreamIfBroken();
    MidiEvent e{EV_NOTE_ON, ch & 15, note & 127, vel & 127, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeNoteOff(JNIEnv *, jclass, jint ch,
                                                                           jint note) {
    MidiEvent e{EV_NOTE_OFF, ch & 15, note & 127, 0, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeControlChange(JNIEnv *, jclass, jint ch,
                                                                                 jint cc, jint value) {
    MidiEvent e{EV_CC, ch & 15, cc & 127, value & 127, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeProgramChange(JNIEnv *, jclass, jint ch,
                                                                                 jint program, jint drum) {
    MidiEvent e{EV_PROGRAM, ch & 15, program & 127, drum ? 1 : 0, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeBankSelect(JNIEnv *, jclass, jint ch,
                                                                              jint bank) {
    MidiEvent e{EV_BANK, ch & 15, bank & 0x7FFF, 0, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativePitchBend(JNIEnv *, jclass, jint ch,
                                                                             jint value) {
    MidiEvent e{EV_PITCH, ch & 15, value & 0x3FFF, 0, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeSetChannelVolume(JNIEnv *, jclass, jint ch,
                                                                                    jfloat v) {
    MidiEvent e{EV_CH_VOLUME, ch & 15, 0, 0, v};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeSetChannelPan(JNIEnv *, jclass, jint ch,
                                                                                 jfloat pan01) {
    MidiEvent e{EV_CH_PAN, ch & 15, 0, 0, pan01};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeChannelSoundsOff(JNIEnv *, jclass, jint ch) {
    MidiEvent e{EV_CH_SOUNDS_OFF, ch & 15, 0, 0, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeAllNotesOff(JNIEnv *, jclass) {
    MidiEvent e{EV_ALL_NOTES_OFF, 0, 0, 0, 0};
    pushEvent(e);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeSetMasterVolume(JNIEnv *, jclass, jfloat v) {
    g_master.store(v, std::memory_order_relaxed);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeSetReverb(JNIEnv *, jclass, jfloat wet) {
    g_reverb.store(wet, std::memory_order_relaxed);
}

JNIEXPORT void JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeSetVoiceCap(JNIEnv *, jclass, jint n) {
    MidiEvent e{EV_VOICE_CAP, 0, n, 0, 0};
    pushEvent(e);
}

JNIEXPORT jint JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeGetVoices(JNIEnv *, jclass) {
    return g_voices.load(std::memory_order_relaxed);
}

JNIEXPORT jint JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeGetSampleRate(JNIEnv *, jclass) {
    return g_sampleRate.load(std::memory_order_relaxed);
}

JNIEXPORT jint JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeGetBufferFrames(JNIEnv *, jclass) {
    return g_bufferFrames.load(std::memory_order_relaxed);
}

JNIEXPORT jint JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeGetBurstFrames(JNIEnv *, jclass) {
    return g_framesPerBurst.load(std::memory_order_relaxed);
}

JNIEXPORT jint JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeGetBankCount(JNIEnv *, jclass) {
    return (jint)g_banks.size();
}

JNIEXPORT jint JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeGetPresetCount(JNIEnv *, jclass, jint bankIndex) {
    if (bankIndex < 0 || bankIndex >= (int)g_banks.size() || !g_banks[(size_t)bankIndex].font) return 0;
    return tsf_get_presetcount(g_banks[(size_t)bankIndex].font);
}

/** 返回 "名称|bank|program"（bank 为 MSB<<7|LSB），供 JS 侧构造音色列表 */
JNIEXPORT jstring JNICALL Java_com_sf2ensemble_synth_SynthBridgePlugin_nativeGetPresetInfo(JNIEnv *env, jclass, jint bankIndex,
                                                                                    jint index) {
    if (bankIndex < 0 || bankIndex >= (int)g_banks.size()) return env->NewStringUTF("");
    tsf *f = g_banks[(size_t)bankIndex].font;
    if (!f || index < 0 || index >= tsf_get_presetcount(f)) return env->NewStringUTF("");
    const char *name = tsf_get_presetname(f, index);
    const struct tsf_preset *p = &f->presets[index];
    char buf[320];
    snprintf(buf, sizeof(buf), "%s|%d|%d", name ? name : "Preset", (int)p->bank, (int)p->preset);
    return env->NewStringUTF(buf);
}

} // extern "C"
