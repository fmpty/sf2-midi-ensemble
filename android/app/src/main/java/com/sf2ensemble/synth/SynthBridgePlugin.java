package com.sf2ensemble.synth;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.res.AssetManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 原生合成桥（Android）。
 *
 * 合成放在 native 层：AAudio（低延迟通路）输出 + TinySoundFont 渲染 SF2，
 * 不再经过 WebView 的 WebAudio，端到端延迟从部分机型的 300~400 ms 降到 10~20 ms 级。
 *
 * 同时保存设备路由表，MIDI 插件（MidiBridge）可把 MIDI 字节流直接送到这里发声，
 * 不必绕 WebView，进一步降低手柄到出声的延迟。
 */
@CapacitorPlugin(name = "SynthBridge")
public class SynthBridgePlugin extends Plugin {

    private static SynthBridgePlugin instance;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, Route> routes = new LinkedHashMap<>();
    private boolean bankLoaded = false;
    private int[] bankPriority = new int[0];

    /* ------------------------------ native 声明 ------------------------------ */

    private static volatile boolean libOk = false;

    static {
        try {
            System.loadLibrary("nativesynth");
            libOk = true;
        } catch (Throwable t) {
            android.util.Log.e("SynthBridge", "加载 nativesynth 失败：" + t.getMessage());
        }
    }

    public static native int nativeAddBank(String path);

    public static native boolean nativeRemoveBank(int index);

    public static native void nativeSetBankOrder(int[] order);

    public static native void nativeSetChannelBank(int channel, int bankIndex);

    public static native boolean nativeStart();

    public static native void nativeStop();

    public static native boolean nativeIsRunning();

    public static native void nativeNoteOn(int channel, int note, int velocity);

    public static native void nativeNoteOff(int channel, int note);

    public static native void nativeControlChange(int channel, int cc, int value);

    public static native void nativeProgramChange(int channel, int program, int drum);

    public static native void nativeBankSelect(int channel, int bank);

    public static native void nativePitchBend(int channel, int value);

    public static native void nativeSetChannelVolume(int channel, float volume);

    public static native void nativeSetChannelPan(int channel, float pan01);

    public static native void nativeChannelSoundsOff(int channel);

    public static native void nativeAllNotesOff();

    public static native void nativeSetMasterVolume(float volume);

    public static native void nativeSetReverb(float wet);

    public static native void nativeSetVoiceCap(int n);

    public static native int nativeGetVoices();

    public static native int nativeGetSampleRate();

    public static native int nativeGetBufferFrames();

    public static native int nativeGetBurstFrames();

    public static native int nativeGetBankCount();

    public static native int nativeGetPresetCount(int bankIndex);

    public static native String nativeGetPresetInfo(int bankIndex, int presetIndex);

    /* -------------------------------- 路由 -------------------------------- */

    static final class Route {
        int channel;
        int transpose;
        float velocityGain;
        String velocityCurve = "linear";
        boolean muted;
        boolean enabled = true;
        boolean allowProgramChange;
    }

    @Override
    public void load() {
        instance = this;
    }

    public static boolean isAvailable() {
        return instance != null;
    }

    /** MIDI 插件直连接口：设备 MIDI 数据不经过 WebView，直接在这里发声 */
    public static boolean deliver(String deviceId, byte[] msg, int offset, int count) {
        if (instance == null || !libOk || !instance.bankLoaded) return false;
        return instance.handleMidi(deviceId, msg, offset, count);
    }

    private boolean handleMidi(String deviceId, byte[] msg, int offset, int count) {
        if (count < 1) return false;
        Route r = routes.get(deviceId);
        if (r == null || !r.enabled || r.muted) return false;
        int status = msg[offset] & 0xff;
        if (status >= 0xf0) return false; // 系统消息（时钟等）不处理
        int type = status & 0xf0;
        int ch = r.channel & 15;
        if (type == 0x90 || type == 0x80) {
            if (count < 3) return false;
            int note = msg[offset + 1] & 0x7f;
            int vel = type == 0x80 ? 0 : transformVelocity(msg[offset + 2] & 0x7f, r);
            note += r.transpose;
            if (note < 0) note = 0;
            if (note > 127) note = 127;
            if (vel > 0) {
                nativeNoteOff(ch, note);
                nativeNoteOn(ch, note, vel);
            } else nativeNoteOff(ch, note);
            return true;
        }
        if (type == 0xb0) {
            if (count < 3) return false;
            nativeControlChange(ch, msg[offset + 1] & 0x7f, msg[offset + 2] & 0x7f);
            return true;
        }
        if (type == 0xe0) {
            if (count < 3) return false;
            nativePitchBend(ch, ((msg[offset + 2] & 0x7f) << 7) | (msg[offset + 1] & 0x7f));
            return true;
        }
        if (type == 0xc0 && r.allowProgramChange && count >= 2) {
            nativeProgramChange(ch, msg[offset + 1] & 0x7f, 0);
            return true;
        }
        return false;
    }

    private static int transformVelocity(int raw, Route r) {
        if (raw == 0) return 0;
        float v = raw / 127.0f;
        switch (r.velocityCurve) {
            case "soft":
                v = (float) Math.pow(v, 1.6);
                break;
            case "hard":
                v = (float) Math.pow(v, 0.65);
                break;
            case "fixed":
                v = 0.85f;
                break;
            default:
                break;
        }
        v *= r.velocityGain;
        int out = Math.round(v * 127);
        if (out > 127) out = 127;
        return out < 1 ? 1 : out;
    }

    /* ------------------------------ 插件方法 ------------------------------ */

    /** 系统文件选择器：选取 SF2/SF3/DLS 并复制到应用私有目录，供 loadBank 使用 */
    @PluginMethod
    public void pickSoundfont(PluginCall call) {
        if (!libOk) {
            call.reject("原生合成库未加载（设备可能不支持 AAudio）");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "application/octet-stream",
                "audio/*",
                "*/*"
        });
        startActivityForResult(call, intent, "pickSoundfontResult");
    }

    @ActivityCallback
    private void pickSoundfontResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject canceled = new JSObject();
            canceled.put("ok", false);
            canceled.put("canceled", true);
            call.resolve(canceled);
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("未获取到文件");
            return;
        }
        worker.execute(() -> {
            try {
                String name = queryDisplayName(uri);
                String path = copyUriToFiles(uri, sanitizeImportName(name));
                JSObject res = new JSObject();
                res.put("ok", true);
                res.put("path", path);
                res.put("name", name);
                call.resolve(res);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "复制音源失败" : e.getMessage());
            }
        });
    }

    /** 把演奏 MIDI 写到系统「下载」文件夹，返回可在日志里展示的位置 */
    @PluginMethod
    public void saveMidi(PluginCall call) {
        String filename = call.getString("filename", "performance.mid");
        String data = call.getString("data");
        if (data == null || data.isEmpty()) {
            call.reject("没有可保存的演奏");
            return;
        }
        final byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("演奏数据无效");
            return;
        }
        if (bytes.length == 0) {
            call.reject("没有可保存的演奏");
            return;
        }
        if (filename == null || filename.isEmpty()) filename = "performance.mid";
        filename = filename.replaceAll("[\\\\/:*?\"<>|]", "_");
        if (!filename.toLowerCase().endsWith(".mid")) filename = filename + ".mid";
        final String name = filename;
        worker.execute(() -> {
            try {
                String where = writeMidiToDownloads(name, bytes);
                JSObject res = new JSObject();
                res.put("ok", true);
                res.put("path", where);
                res.put("name", name);
                call.resolve(res);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "保存失败" : e.getMessage());
            }
        });
    }

    private String writeMidiToDownloads(String name, byte[] bytes) throws java.io.IOException {
        Context ctx = getContext();
        if (ctx == null) throw new java.io.IOException("无 Context");
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver cr = ctx.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, "audio/midi");
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new java.io.IOException("无法写入下载目录");
            try (OutputStream os = cr.openOutputStream(uri)) {
                if (os == null) throw new java.io.IOException("无法写入下载目录");
                os.write(bytes);
            }
            values.clear();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, values, null, null);
            String saved = name;
            try (Cursor c = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    String n = c.getString(0);
                    if (n != null && !n.isEmpty()) saved = n;
                }
            } catch (Exception ignored) {
            }
            return "下载/" + saved;
        }
        File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) dir = ctx.getFilesDir();
        if (!dir.exists() && !dir.mkdirs()) throw new java.io.IOException("无法创建目录");
        File out = new File(dir, name);
        try (FileOutputStream os = new FileOutputStream(out)) {
            os.write(bytes);
        }
        return out.getAbsolutePath();
    }

    /** 载入音源：path 为空时自动取 APK 内置 assets 里的 SF2 */
    @PluginMethod
    public void loadBank(final PluginCall call) {
        if (!libOk) {
            call.reject("原生合成库未加载（设备可能不支持 AAudio）");
            return;
        }
        final String path = call.getString("path");
        worker.execute(() -> {
            String target = null;
            boolean ok = false;
            int bankIndex = -1;
            String error = null;
            try {
                target = path;
                if (target == null || target.isEmpty()) target = copyBuiltinBank();
                if (target != null) bankIndex = nativeAddBank(target);
                ok = bankIndex >= 0;
                bankLoaded = nativeGetBankCount() > 0;
            } catch (Throwable t) {
                error = String.valueOf(t);
                android.util.Log.e("SynthBridge", "载入音源异常", t);
            }
            JSObject res = new JSObject();
            res.put("ok", ok);
            res.put("path", target == null ? "" : target);
            res.put("bankIndex", bankIndex);
            res.put("bankCount", nativeGetBankCount());
            res.put("presets", ok ? nativeGetPresetCount(bankIndex) : 0);
            if (error != null) res.put("error", error);
            call.resolve(res);
        });
    }

    @PluginMethod
    public void removeBank(final PluginCall call) {
        if (!libOk) {
            call.reject("原生合成库未加载");
            return;
        }
        final int index = call.getInt("index", -1);
        worker.execute(() -> {
            boolean ok = nativeRemoveBank(index);
            bankLoaded = nativeGetBankCount() > 0;
            if (ok && bankPriority.length > 0) {
                java.util.ArrayList<Integer> next = new java.util.ArrayList<>();
                for (int o : bankPriority) {
                    if (o == index) continue;
                    next.add(o > index ? o - 1 : o);
                }
                bankPriority = new int[next.size()];
                for (int i = 0; i < next.size(); i++) bankPriority[i] = next.get(i);
                nativeSetBankOrder(bankPriority);
            }
            JSObject res = new JSObject();
            res.put("ok", ok);
            res.put("bankCount", nativeGetBankCount());
            call.resolve(res);
        });
    }

    @PluginMethod
    public void setBankOrder(final PluginCall call) {
        if (!libOk) {
            call.reject("原生合成库未加载");
            return;
        }
        final String json = call.getString("order", "[]");
        worker.execute(() -> {
            try {
                JSONArray arr = new JSONArray(json);
                bankPriority = new int[arr.length()];
                for (int i = 0; i < arr.length(); i++) bankPriority[i] = arr.getInt(i);
                nativeSetBankOrder(bankPriority);
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!libOk) {
            call.reject("原生合成库未加载");
            return;
        }
        if (!bankLoaded || nativeGetBankCount() <= 0) {
            call.reject("请先载入音源");
            return;
        }
        try {
            boolean ok = nativeStart();
            JSObject res = new JSObject();
            res.put("running", ok);
            res.put("sampleRate", nativeGetSampleRate());
            res.put("bufferFrames", nativeGetBufferFrames());
            res.put("burstFrames", nativeGetBurstFrames());
            int rate = nativeGetSampleRate();
            res.put("bufferMs", rate > 0 ? (nativeGetBufferFrames() * 1000 / rate) : 0);
            call.resolve(res);
        } catch (Throwable t) {
            android.util.Log.e("SynthBridge", "start 失败", t);
            call.reject(t.getMessage() != null ? t.getMessage() : "AAudio 启动失败");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        nativeStop();
        call.resolve();
    }

    @PluginMethod
    public void noteOn(PluginCall call) {
        int ch = call.getInt("channel", 0);
        int note = call.getInt("note", 60);
        int vel = call.getInt("velocity", 100);
        nativeNoteOn(clampChannel(ch), clamp(note, 0, 127), clamp(vel, 1, 127));
        call.resolve();
    }

    @PluginMethod
    public void noteOff(PluginCall call) {
        nativeNoteOff(clampChannel(call.getInt("channel", 0)), clamp(call.getInt("note", 60), 0, 127));
        call.resolve();
    }

    @PluginMethod
    public void panic(PluginCall call) {
        nativeAllNotesOff();
        call.resolve();
    }

    @PluginMethod
    public void controlChange(PluginCall call) {
        nativeControlChange(clampChannel(call.getInt("channel", 0)),
                clamp(call.getInt("cc", 0), 0, 127), clamp(call.getInt("value", 0), 0, 127));
        call.resolve();
    }

    @PluginMethod
    public void pitchBend(PluginCall call) {
        nativePitchBend(clampChannel(call.getInt("channel", 0)), call.getInt("value", 8192));
        call.resolve();
    }

    @PluginMethod
    public void setMasterVolume(PluginCall call) {
        double v = call.getDouble("volume", 0.9d);
        nativeSetMasterVolume((float) v);
        call.resolve();
    }

    @PluginMethod
    public void setReverb(PluginCall call) {
        double v = call.getDouble("wet", 0.0d);
        nativeSetReverb((float) v);
        call.resolve();
    }

    @PluginMethod
    public void setVoiceCap(PluginCall call) {
        nativeSetVoiceCap(call.getInt("cap", 96));
        call.resolve();
    }

    /** 下发设备路由表（原生直连 MIDI 时用它做通道/力度/移调映射） */
    @PluginMethod
    public void setRoutes(PluginCall call) {
        String json = call.getString("routes");
        routes.clear();
        if (json != null) {
            try {
                JSONArray arr = new JSONArray(json);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.getJSONObject(i);
                    Route r = new Route();
                    r.channel = o.optInt("channel", 0);
                    r.transpose = o.optInt("transpose", 0);
                    r.velocityGain = (float) o.optDouble("velocityGain", 1.0);
                    r.velocityCurve = o.optString("velocityCurve", "linear");
                    r.muted = o.optBoolean("muted", false);
                    r.enabled = o.optBoolean("enabled", true);
                    r.allowProgramChange = o.optBoolean("allowProgramChange", false);
                    routes.put(o.optString("deviceId", ""), r);
                    String mac = o.optString("mac", "").replace(":", "").replace("-", "").toUpperCase(java.util.Locale.US);
                    if (mac.length() == 12) routes.put("bt#" + mac, r);
                }
            } catch (Exception ignored) {
            }
        }
        call.resolve();
    }

    /** 通道参数：乐器 / 音量 / 声像 */
    @PluginMethod
    public void setChannel(PluginCall call) {
        int ch = clampChannel(call.getInt("channel", 0));
        if (call.getData().has("bankIndex")) {
            nativeSetChannelBank(ch, call.getInt("bankIndex", 0));
        }
        if (call.getData().has("program")) {
            nativeProgramChange(ch, clamp(call.getInt("program", 0), 0, 127),
                    call.getBoolean("isDrum", false) ? 1 : 0);
        }
        if (call.getData().has("bank")) {
            nativeBankSelect(ch, call.getInt("bank", 0));
        }
        if (call.getData().has("volume")) {
            Double v = call.getDouble("volume", Double.valueOf(1.0d));
            nativeSetChannelVolume(ch, v == null ? 1.0f : v.floatValue());
        }
        if (call.getData().has("pan")) {
            Double p = call.getDouble("pan", Double.valueOf(0.0d));
            float pan = p == null ? 0.0f : p.floatValue(); // -1..1
            nativeSetChannelPan(ch, (pan + 1.0f) / 2.0f);
        }
        call.resolve();
    }

    @PluginMethod
    public void getPresets(PluginCall call) {
        int bankCount = nativeGetBankCount();
        JSArray arr = new JSArray();
        int[] order = bankPriority.length > 0 ? bankPriority : null;
        for (int o = 0; o < bankCount; o++) {
            int bankIndex = order != null && o < order.length ? order[o] : o;
            if (bankIndex < 0 || bankIndex >= bankCount) continue;
            int presetCount = nativeGetPresetCount(bankIndex);
            for (int i = 0; i < presetCount; i++) {
                String info = nativeGetPresetInfo(bankIndex, i);
                if (info == null || info.isEmpty()) continue;
                String[] parts = info.split("\\|");
                if (parts.length < 3) continue;
                try {
                    int bank = Integer.parseInt(parts[1]);
                    JSObject preset = new JSObject();
                    preset.put("name", parts[0]);
                    preset.put("bankMSB", (bank >> 7) & 0x7f);
                    preset.put("bankLSB", bank & 0x7f);
                    preset.put("program", Integer.parseInt(parts[2]));
                    preset.put("bankId", "native" + bankIndex);
                    preset.put("isDrum", bank >= 128);
                    arr.put(preset);
                } catch (NumberFormatException ignored) {
                }
            }
        }
        JSObject res = new JSObject();
        res.put("presets", arr);
        call.resolve(res);
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        int rate = nativeGetSampleRate();
        int buf = nativeGetBufferFrames();
        JSObject res = new JSObject();
        res.put("running", nativeIsRunning());
        res.put("sampleRate", rate);
        res.put("bufferFrames", buf);
        res.put("burstFrames", nativeGetBurstFrames());
        res.put("bufferMs", rate > 0 ? (buf * 1000 / rate) : 0);
        res.put("voices", nativeGetVoices());
        res.put("bankLoaded", bankLoaded);
        call.resolve(res);
    }

    /* ------------------------------ 内置音源 ------------------------------ */

    private static String sanitizeImportName(String name) {
        if (name == null || name.isEmpty()) return "imported.sf2";
        String safe = name.replaceAll("[^a-zA-Z0-9._\\-]", "_");
        if (safe.isEmpty()) safe = "imported.sf2";
        String lower = safe.toLowerCase();
        if (!lower.endsWith(".sf2") && !lower.endsWith(".sf3") && !lower.endsWith(".dls")) {
            safe = safe + ".sf2";
        }
        return safe;
    }

    private String queryDisplayName(Uri uri) {
        ContentResolver cr = getContext().getContentResolver();
        try (Cursor c = cr.query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String n = c.getString(idx);
                    if (n != null && !n.isEmpty()) return n;
                }
            }
        } catch (Exception ignored) {
        }
        return "imported.sf2";
    }

    private String copyUriToFiles(Uri uri, String fileName) throws java.io.IOException {
        Context ctx = getContext();
        if (ctx == null) throw new java.io.IOException("无 Context");
        ContentResolver cr = ctx.getContentResolver();
        File out = new File(ctx.getFilesDir(), fileName);
        try (InputStream in = cr.openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
            if (in == null) throw new java.io.IOException("无法读取所选文件");
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
        }
        return out.getAbsolutePath();
    }

    /** 把 APK assets 里的 SF2 复制到内部存储（native 层只能读文件路径） */
    private String copyBuiltinBank() {
        Context ctx = getContext();
        if (ctx == null) return null;
        try {
            AssetManager am = ctx.getAssets();
            String dir = "public/assets/soundfonts";
            String[] files = am.list(dir);
            if (files == null) return null;
            String pick = null;
            for (String f : files) {
                if (f.endsWith(".sf2") || f.endsWith(".sf3") || f.endsWith(".dls")) {
                    pick = f;
                    break;
                }
            }
            if (pick == null) return null;
            File out = new File(ctx.getFilesDir(), pick);
            if (!out.exists() || out.length() == 0) {
                try (InputStream in = am.open(dir + "/" + pick); OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[256 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }
            }
            return out.getAbsolutePath();
        } catch (Exception e) {
            android.util.Log.e("SynthBridge", "复制内置音源失败：" + e.getMessage());
            return null;
        }
    }

    private static int clampChannel(int ch) {
        return ch < 0 ? 0 : (ch > 15 ? 15 : ch);
    }

    private static int clamp(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    @Override
    protected void handleOnDestroy() {
        nativeStop();
        super.handleOnDestroy();
    }
}
