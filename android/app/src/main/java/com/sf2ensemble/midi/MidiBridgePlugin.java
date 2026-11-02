package com.sf2ensemble.midi;

import android.Manifest;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.midi.MidiDevice;
import android.media.midi.MidiDeviceInfo;
import android.media.midi.MidiManager;
import android.media.midi.MidiOutputPort;
import android.media.midi.MidiReceiver;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 原生 MIDI 桥（Android）。
 *
 * 通过 android.media.midi 接入 USB-MIDI 与 BLE-MIDI 设备，
 * 把设备列表与原始 MIDI 字节流通过 Capacitor 事件（midiMessage / devicesChanged）送入 WebView。
 */
@CapacitorPlugin(name = "MidiBridge")
public class MidiBridgePlugin extends Plugin {

    private static final String MIDI_SERVICE_UUID = "03B80E5A-EDE8-4B33-A751-6CE34EC4C700";
    private static final int REQ_BLUETOOTH = 1001;
    private static final long SCAN_MS = 8000L;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private MidiManager midiManager;
    private final Map<String, MidiDevice> opened = new LinkedHashMap<>();
    private final Map<String, MidiOutputPort> ports = new LinkedHashMap<>();
    private final Map<String, JSObject> meta = new LinkedHashMap<>();
    private final Map<String, BluetoothDevice> bleFound = new LinkedHashMap<>();
    private BluetoothLeScanner scanner;
    private boolean scanning = false;
    private Runnable pendingAction;

    @Override
    public void load() {
        Context ctx = getContext();
        if (ctx == null || !ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_MIDI)) {
            return;
        }
        midiManager = (MidiManager) ctx.getSystemService(Context.MIDI_SERVICE);
        if (midiManager != null) {
            midiManager.registerDeviceCallback(deviceCallback, mainHandler);
        }
    }

    private final MidiManager.DeviceCallback deviceCallback = new MidiManager.DeviceCallback() {
        @Override
        public void onDeviceAdded(MidiDeviceInfo info) {
            openInfo(info);
            mainHandler.post(MidiBridgePlugin.this::emitDevices);
        }

        @Override
        public void onDeviceRemoved(MidiDeviceInfo info) {
            closeDevice(keyFor(info));
            mainHandler.post(MidiBridgePlugin.this::emitDevices);
        }
    };

    private final ScanCallback bleCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice dev = result.getDevice();
            if (dev == null) return;
            String addr = dev.getAddress();
            if (addr == null || bleFound.containsKey(addr)) return;
            bleFound.put(addr, dev);
            openBluetooth(dev, addr);
        }

        @Override
        public void onScanFailed(int errorCode) {
            scanning = false;
        }
    };

    private static String keyFor(MidiDeviceInfo info) {
        return info.getType() + "#" + info.getId();
    }

    private void openInfo(MidiDeviceInfo info) {
        if (midiManager == null) return;
        final String key = keyFor(info);
        if (opened.containsKey(key)) return;
        String name = info.getProperties().getString(MidiDeviceInfo.PROPERTY_NAME);
        if (name == null) name = "MIDI 设备 " + info.getId();
        String manufacturer = info.getProperties().getString(MidiDeviceInfo.PROPERTY_MANUFACTURER);
        if (manufacturer == null) manufacturer = "";
        JSObject obj = new JSObject();
        obj.put("id", key);
        obj.put("name", name);
        obj.put("manufacturer", manufacturer);
        obj.put("type", info.getType() == MidiDeviceInfo.TYPE_BLUETOOTH ? "bluetooth" : "usb");
        obj.put("connected", true);
        meta.put(key, obj);
        midiManager.openDevice(info, device -> {
            if (device == null) {
                JSObject m = meta.get(key);
                if (m != null) m.put("connected", false);
                return;
            }
            attachOutputPort(key, device);
        }, mainHandler);
    }

    private void openBluetooth(BluetoothDevice dev, String addr) {
        if (midiManager == null) return;
        final String key = "bt#" + addr.replace(":", "");
        if (opened.containsKey(key)) return;
        String name = null;
        try {
            name = dev.getName();
        } catch (SecurityException ignored) {
        }
        if (name == null) name = addr;
        JSObject obj = new JSObject();
        obj.put("id", key);
        obj.put("name", name);
        obj.put("manufacturer", "");
        obj.put("type", "bluetooth");
        obj.put("connected", true);
        meta.put(key, obj);
        midiManager.openBluetoothDevice(dev, device -> {
            if (device == null) {
                JSObject m = meta.get(key);
                if (m != null) m.put("connected", false);
                return;
            }
            attachOutputPort(key, device);
        }, mainHandler);
    }

    /** 打开设备的输出端口（设备 → 主机），并挂上接收器 */
    private void attachOutputPort(final String key, MidiDevice device) {
        opened.put(key, device);
        MidiOutputPort port = device.openOutputPort(0);
        if (port == null) {
            JSObject m = meta.get(key);
            if (m != null) m.put("connected", false);
            return;
        }
        ports.put(key, port);
        port.connect(new MidiReceiver() {
            @Override
            public void onSend(byte[] msg, int offset, int count, long timestamp) {
                // 原生合成可用时直接在这里发声，避免绕 WebView（显著降低延迟）
                boolean played = com.sf2ensemble.synth.SynthBridgePlugin.deliver(key, msg, offset, count);
                JSArray arr = new JSArray();
                for (int i = offset; i < offset + count && i < msg.length; i++) {
                    arr.put(msg[i] & 0xff);
                }
                JSObject payload = new JSObject();
                payload.put("id", key);
                payload.put("data", arr);
                payload.put("played", played);
                notifyListeners("midiMessage", payload);
            }
        });
    }

    private void closeDevice(String key) {
        try {
            MidiOutputPort port = ports.remove(key);
            if (port != null) port.close();
        } catch (Exception ignored) {
        }
        try {
            MidiDevice dev = opened.remove(key);
            if (dev != null) dev.close();
        } catch (Exception ignored) {
        }
        meta.remove(key);
    }

    private JSArray deviceArray() {
        JSArray arr = new JSArray();
        for (JSObject o : meta.values()) arr.put(o);
        return arr;
    }

    private void emitDevices() {
        JSObject payload = new JSObject();
        payload.put("devices", deviceArray());
        notifyListeners("devicesChanged", payload);
    }

    private String[] neededPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return new String[]{Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT};
        }
        return new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
    }

    private void ensureBluetoothPermissions(final Runnable action) {
        List<String> missing = new ArrayList<>();
        for (String p : neededPermissions()) {
            if (getActivity().checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) {
                missing.add(p);
            }
        }
        if (missing.isEmpty()) {
            action.run();
            return;
        }
        pendingAction = action;
        getActivity().requestPermissions(missing.toArray(new String[0]), REQ_BLUETOOTH);
    }

    @Override
    protected void handleRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.handleRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_BLUETOOTH && pendingAction != null) {
            Runnable action = pendingAction;
            pendingAction = null;
            action.run();
        }
    }

    @PluginMethod
    public void getDevices(PluginCall call) {
        JSObject res = new JSObject();
        res.put("devices", deviceArray());
        call.resolve(res);
    }

    /** 打开系统当前可见的所有 MIDI 设备（USB + 已配对的蓝牙） */
    @PluginMethod
    public void openAll(PluginCall call) {
        if (midiManager != null) {
            MidiDeviceInfo[] infos = midiManager.getDevices();
            if (infos != null) {
                for (MidiDeviceInfo info : infos) openInfo(info);
            }
        }
        mainHandler.postDelayed(() -> {
            JSObject res = new JSObject();
            res.put("devices", deviceArray());
            call.resolve(res);
        }, 600);
    }

    /** 扫描蓝牙 MIDI（BLE-MIDI）设备并打开 */
    @PluginMethod
    public void scanBle(PluginCall call) {
        ensureBluetoothPermissions(() -> {
            BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothLeScanner sc = bm == null || bm.getAdapter() == null ? null : bm.getAdapter().getBluetoothLeScanner();
            if (sc == null) {
                call.reject("蓝牙不可用");
                return;
            }
            scanner = sc;
            ScanFilter filter = new ScanFilter.Builder()
                    .setServiceUuid(ParcelUuid.fromString(MIDI_SERVICE_UUID))
                    .build();
            ScanSettings settings = new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                    .build();
            scanning = true;
            try {
                sc.startScan(java.util.Collections.singletonList(filter), settings, bleCallback);
            } catch (SecurityException e) {
                scanning = false;
                call.reject("缺少蓝牙权限");
                return;
            }
            mainHandler.postDelayed(() -> {
                if (scanning) {
                    scanning = false;
                    try {
                        sc.stopScan(bleCallback);
                    } catch (Exception ignored) {
                    }
                }
                JSObject res = new JSObject();
                res.put("devices", deviceArray());
                call.resolve(res);
            }, SCAN_MS);
        });
    }

    @PluginMethod
    public void closeAll(PluginCall call) {
        for (String key : new ArrayList<>(meta.keySet())) closeDevice(key);
        emitDevices();
        call.resolve();
    }

    @Override
    public void handleOnDestroy() {
        for (String key : new ArrayList<>(meta.keySet())) closeDevice(key);
        super.handleOnDestroy();
    }
}
