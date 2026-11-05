package com.sf2ensemble.midi;

import android.Manifest;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
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
import android.util.Log;

import org.json.JSONObject;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 原生 MIDI 桥（Android）。
 *
 * 通过 android.media.midi 接入 USB-MIDI 与 BLE-MIDI 设备，
 * 把设备列表与原始 MIDI 字节流通过 Capacitor 事件（midiMessage / devicesChanged）送入 WebView。
 */
@CapacitorPlugin(
        name = "MidiBridge",
        permissions = {
                @Permission(
                        alias = "bluetooth",
                        strings = {
                                Manifest.permission.BLUETOOTH_SCAN,
                                Manifest.permission.BLUETOOTH_CONNECT,
                                Manifest.permission.ACCESS_FINE_LOCATION
                        }
                )
        }
)
public class MidiBridgePlugin extends Plugin {

    private static final String MIDI_SERVICE_UUID = "03B80E5A-EDE8-4B33-A751-6CE34EC4C700";
    private static final long SCAN_MS = 8000L;
    private static final String LAYER_LOG = "MidiBridgeLayer";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private static void layerLog(String layer, String msg) {
        Log.i(LAYER_LOG, "[MIDI scan][" + layer + "] " + msg);
    }
    private MidiManager midiManager;
    private final Map<String, MidiDevice> opened = new LinkedHashMap<>();
    private final Map<String, MidiOutputPort> ports = new LinkedHashMap<>();
    private final Map<String, JSObject> meta = new LinkedHashMap<>();
    private final Map<String, BluetoothDevice> bleFound = new LinkedHashMap<>();
    private BluetoothLeScanner scanner;
    private boolean scanning = false;
    /** 等待蓝牙权限对话框时排队；避免后一次 openAll 覆盖前一次导致 PluginCall 永不 resolve */
    private final List<PendingBluetoothAction> pendingBluetoothActions = new ArrayList<>();
    private boolean bluetoothPermissionRequestInFlight = false;
    private BroadcastReceiver btStateReceiver;
    private boolean btReceiverRegistered;
    /** 防止 openAll 与 onDeviceAdded 并发重复 openDevice（部分 ROM 会抛 NPE） */
    private final Set<String> opening = new HashSet<>();

    @Override
    public void load() {
        layerLog("L2-SYS", "MidiBridgePlugin load layer-v2");
        Context ctx = getContext();
        if (ctx == null || !ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_MIDI)) {
            layerLog("L2-SYS", "load abort no MIDI feature");
            return;
        }
        midiManager = (MidiManager) ctx.getSystemService(Context.MIDI_SERVICE);
        if (midiManager != null) {
            midiManager.registerDeviceCallback(deviceCallback, mainHandler);
        }
        registerBluetoothStateReceiver(ctx);
    }

    private void registerBluetoothStateReceiver(Context ctx) {
        if (btReceiverRegistered || ctx == null) return;
        btStateReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null) return;
                String action = intent.getAction();
                if (BluetoothDevice.ACTION_ACL_DISCONNECTED.equals(action)) {
                    BluetoothDevice dev;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        dev = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice.class);
                    } else {
                        dev = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                    }
                    if (dev != null) {
                        layerLog("L1-BT", "ACL_DISCONNECTED mac=" + macFromAddr(dev.getAddress()));
                        mainHandler.post(() -> handleBluetoothDisconnected(dev.getAddress()));
                    }
                } else if (BluetoothDevice.ACTION_ACL_CONNECTED.equals(action)) {
                    mainHandler.post(() -> {
                        BluetoothDevice dev;
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            dev = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice.class);
                        } else {
                            dev = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                        }
                        if (dev != null && dev.getAddress() != null) {
                            String a = dev.getAddress();
                            layerLog("L1-BT", "ACL_CONNECTED mac=" + macFromAddr(a));
                            bleFound.remove(a);
                            bleFound.remove(macFromAddr(a));
                        }
                        openAllMidiWithRetry();
                    });
                }
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED);
        filter.addAction(BluetoothDevice.ACTION_ACL_CONNECTED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(btStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            ctx.registerReceiver(btStateReceiver, filter);
        }
        btReceiverRegistered = true;
    }

    private final MidiManager.DeviceCallback deviceCallback = new MidiManager.DeviceCallback() {
        @Override
        public void onDeviceAdded(MidiDeviceInfo info) {
            if (info == null) return;
            try {
                layerLog("L2-SYS", "onDeviceAdded id=" + keyFor(info) + " mac=" + macFromMidiInfo(info));
            } catch (Exception ignored) {
            }
            openInfo(info);
            mainHandler.post(MidiBridgePlugin.this::emitDevices);
            // 重连时系统先广播 ACL，MIDI 服务可能稍后才就绪
            mainHandler.postDelayed(MidiBridgePlugin.this::openAllMidiRetryPass, 800);
        }

        @Override
        public void onDeviceRemoved(MidiDeviceInfo info) {
            if (info == null) return;
            try {
                layerLog("L2-SYS", "onDeviceRemoved id=" + keyFor(info) + " mac=" + macFromMidiInfo(info));
                closeDevice(keyFor(info), "onDeviceRemoved");
            } catch (Exception ignored) {
            }
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

    private static String macFromAddr(String addr) {
        if (addr == null) return "";
        return addr.toUpperCase(Locale.US);
    }

    private static void putMac(JSObject obj, String addr) {
        if (addr != null && !addr.isEmpty()) obj.put("mac", macFromAddr(addr));
    }

    private static String btKeyFromAddr(String addr) {
        if (addr == null) return null;
        return "bt#" + addr.replace(":", "").toUpperCase(Locale.US);
    }

    /** 系统蓝牙断开：移除 bt# 及同 MAC 的 type# 缓存，避免 WebView 仍显示已连接 */
    private void handleBluetoothDisconnected(String addr) {
        if (addr == null || addr.isEmpty()) return;
        String norm = macFromAddr(addr);
        String btKey = btKeyFromAddr(addr);
        if (btKey != null) closeDevice(btKey, "ACL");
        for (String key : new ArrayList<>(meta.keySet())) {
            JSObject m = meta.get(key);
            if (m == null) continue;
            String mac = m.optString("mac", "");
            if (!mac.isEmpty() && mac.equalsIgnoreCase(norm)) {
                closeDevice(key, "ACL");
            }
        }
        if (addr != null) {
            bleFound.remove(addr);
            bleFound.remove(norm);
        }
        emitDevices(norm);
    }

    private String macFromMidiInfo(MidiDeviceInfo info) {
        if (info == null || info.getType() != MidiDeviceInfo.TYPE_BLUETOOTH) return "";
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return "";
        try {
            BluetoothDevice bt;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                bt = info.getProperties().getParcelable(MidiDeviceInfo.PROPERTY_BLUETOOTH_DEVICE, BluetoothDevice.class);
            } else {
                bt = info.getProperties().getParcelable(MidiDeviceInfo.PROPERTY_BLUETOOTH_DEVICE);
            }
            if (bt != null && bt.getAddress() != null) return macFromAddr(bt.getAddress());
        } catch (Exception ignored) {
        }
        return "";
    }

    /**
     * 仅刷新 meta 上的 connected 标记，不在此处 closeDevice。
     * 关闭端口只走：ACL 断开、onDeviceRemoved、probeDevices 的 purge、closeAll。
     * （避免每次 getDevices() 调用 sync 时因系统列表瞬时抖动误关 3#xx 端口。）
     */
    private void syncDeviceListState() {
        if (midiManager == null) return;
        Set<String> activeMacs = new HashSet<>();
        MidiDeviceInfo[] infos = midiManager.getDevices();
        if (infos != null) {
            for (MidiDeviceInfo info : infos) {
                String mac = macFromMidiInfo(info);
                if (!mac.isEmpty()) activeMacs.add(mac.toUpperCase(Locale.US));
            }
        }
        for (JSObject m : meta.values()) {
            if (m == null) continue;
            String id = m.optString("id", "");
            boolean live = opened.containsKey(id);
            m.put("connected", live);
            if (!live && !id.startsWith("bt#")) {
                String mac = m.optString("mac", "").toUpperCase(Locale.US);
                if (!mac.isEmpty() && activeMacs.contains(mac)) {
                    m.put("connected", true);
                }
            }
        }
        layerLog("L2-SYS", "sync systemMidi=" + (infos == null ? 0 : infos.length)
                + " activeMacs=" + activeMacs.size() + " opened=" + opened.size() + " opening=" + opening.size());
    }

    private boolean hasBluetoothPermission() {
        if (getActivity() == null) return false;
        for (String p : neededPermissions()) {
            if (getActivity().checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) {
                return false;
            }
        }
        return true;
    }

    /** 蓝牙配对列表里只尝试名称含 midi 的设备（大小写不限） */
    private static boolean looksLikeMidiController(String name) {
        return name != null && !name.isEmpty() && name.toLowerCase(Locale.US).contains("midi");
    }

    /** 系统虚拟/管理用 MIDI 口（英文占位名），非真实手柄 */
    private static boolean isGenericMidiPlaceholder(String name) {
        if (name == null) return true;
        String n = name.trim().toLowerCase(Locale.US);
        if (n.isEmpty()) return true;
        if (n.equals("midi") || n.equals("ble midi") || n.equals("bluetooth midi")) return true;
        if (n.contains("android") && n.contains("bluetooth") && n.contains("midi")) return true;
        return n.matches("^midi\\s*device\\s*\\d*$");
    }

    private static boolean shouldExposeDevice(JSObject o) {
        if (o == null) return false;
        if (!"bluetooth".equals(o.optString("type", ""))) return true;
        String name = o.optString("name", "");
        if (!name.toLowerCase(Locale.US).contains("midi")) return false;
        return !isGenericMidiPlaceholder(name);
    }

    /** 同 MAC 已有成功打开的端口时，勿再 open 第二个口 */
    private boolean hasOpenPortForMac(String macNorm) {
        if (macNorm == null || macNorm.isEmpty()) return false;
        for (JSObject m : new ArrayList<>(meta.values())) {
            if (!macNorm.equalsIgnoreCase(m.optString("mac", ""))) continue;
            if (opened.containsKey(m.optString("id", ""))) return true;
        }
        return false;
    }

    /** 系统换新 type# id（3#95→3#96）时清掉同 MAC 未 opened 的旧 meta，避免 hasOpenPort 挡死 */
    private void closeStaleMetaForMacExcept(String macNorm, String keepKey) {
        if (macNorm == null || macNorm.isEmpty()) return;
        for (String k : new ArrayList<>(meta.keySet())) {
            if (k.equals(keepKey)) continue;
            if (opened.containsKey(k) || opening.contains(k)) continue;
            JSObject m = meta.get(k);
            if (m == null) continue;
            if (!macNorm.equalsIgnoreCase(m.optString("mac", ""))) continue;
            closeDevice(k, "staleMetaSameMac");
        }
    }

    /** 已有同名的 bt# 直连口时，跳过系统 type# 口，避免双开同一手柄 */
    private boolean hasBtMetaForName(String name) {
        if (name == null || name.isEmpty()) return false;
        String n = name.trim();
        for (JSObject m : new ArrayList<>(meta.values())) {
            String id = m.optString("id", "");
            if (!id.startsWith("bt#")) continue;
            if (!opened.containsKey(id) && !opening.contains(id)) continue;
            if (n.equalsIgnoreCase(m.optString("name", "").trim())) return true;
        }
        return false;
    }

    private static boolean preferDeviceMeta(JSObject a, JSObject b) {
        String idA = a.optString("id", "");
        String idB = b.optString("id", "");
        if (idA.startsWith("bt#") && !idB.startsWith("bt#")) return true;
        if (!idA.startsWith("bt#") && idB.startsWith("bt#")) return false;
        String na = a.optString("name", "");
        String nb = b.optString("name", "");
        if (isGenericMidiPlaceholder(nb) && !isGenericMidiPlaceholder(na)) return true;
        if (isGenericMidiPlaceholder(na) && !isGenericMidiPlaceholder(nb)) return false;
        return na.length() >= nb.length();
    }

    private String safeDeviceName(BluetoothDevice dev) {
        try {
            return dev.getName();
        } catch (SecurityException e) {
            return null;
        }
    }

    private void openInfo(MidiDeviceInfo info) {
        if (midiManager == null || info == null) return;
        final String key;
        try {
            key = keyFor(info);
        } catch (Exception e) {
            return;
        }
        if (opened.containsKey(key)) {
            layerLog("L3-open", "openInfo skip alreadyOpened key=" + key);
            return;
        }
        if (opening.contains(key)) {
            layerLog("L3-open", "openInfo skip opening key=" + key);
            return;
        }
        if (meta.containsKey(key) && !opened.containsKey(key)) meta.remove(key);
        String name = info.getProperties().getString(MidiDeviceInfo.PROPERTY_NAME);
        if (info.getType() == MidiDeviceInfo.TYPE_BLUETOOTH) {
            if (!looksLikeMidiController(name)) {
                layerLog("L3-open", "openInfo skip bt name without midi keyword name=" + name);
                return;
            }
            String mac = macFromMidiInfo(info);
            if (!mac.isEmpty()) {
                closeStaleMetaForMacExcept(mac, key);
                if (hasOpenPortForMac(mac)) {
                    layerLog("L3-open", "openInfo skip hasOpenPort mac=" + mac + " key=" + key);
                    return;
                }
            }
            if (hasBtMetaForName(name)) {
                layerLog("L3-open", "openInfo skip hasBtMetaForName name=" + name);
                return;
            }
            if (isGenericMidiPlaceholder(name)) {
                layerLog("L3-open", "openInfo skip placeholder name=" + name);
                return;
            }
        }
        layerLog("L3-open", "openInfo start key=" + key + " name=" + name);
        if (name == null) name = "MIDI 设备 " + info.getId();
        String manufacturer = info.getProperties().getString(MidiDeviceInfo.PROPERTY_MANUFACTURER);
        if (manufacturer == null) manufacturer = "";
        JSObject obj = new JSObject();
        obj.put("id", key);
        obj.put("name", name);
        obj.put("manufacturer", manufacturer);
        obj.put("type", info.getType() == MidiDeviceInfo.TYPE_BLUETOOTH ? "bluetooth" : "usb");
        obj.put("connected", true);
        if (info.getType() == MidiDeviceInfo.TYPE_BLUETOOTH && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                BluetoothDevice bt;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    bt = info.getProperties().getParcelable(MidiDeviceInfo.PROPERTY_BLUETOOTH_DEVICE, BluetoothDevice.class);
                } else {
                    bt = info.getProperties().getParcelable(MidiDeviceInfo.PROPERTY_BLUETOOTH_DEVICE);
                }
                if (bt != null) putMac(obj, bt.getAddress());
            } catch (Exception ignored) {
            }
        }
        meta.put(key, obj);
        opening.add(key);
        try {
            midiManager.openDevice(info, device -> {
                opening.remove(key);
                if (device == null) {
                    layerLog("L3-open", "openDevice null key=" + key + " retry=500ms");
                    closeDevice(key, "openDevice-null");
                    mainHandler.postDelayed(() -> openInfo(info), 500);
                    return;
                }
                layerLog("L3-open", "openDevice ok key=" + key);
                attachOutputPort(key, device);
            }, mainHandler);
        } catch (RuntimeException e) {
            layerLog("L3-open", "openInfo exception key=" + key + " " + e.getMessage());
            opening.remove(key);
            meta.remove(key);
        }
    }

    private void openBluetooth(BluetoothDevice dev, String addr) {
        if (midiManager == null) return;
        final String key = "bt#" + addr.replace(":", "").toUpperCase(Locale.US);
        if (opened.containsKey(key)) return;
        if (opening.contains(key)) return;
        if (meta.containsKey(key) && !opened.containsKey(key)) meta.remove(key);
        layerLog("L3-open", "openBluetooth start key=" + key);
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
        putMac(obj, addr);
        meta.put(key, obj);
        opening.add(key);
        try {
            midiManager.openBluetoothDevice(dev, device -> {
                opening.remove(key);
                if (device == null) {
                    layerLog("L3-open", "openBluetoothDevice null key=" + key);
                    closeDevice(key, "openBluetooth-null");
                    return;
                }
                attachOutputPort(key, device);
            }, mainHandler);
        } catch (RuntimeException e) {
            layerLog("L3-open", "openBluetooth exception key=" + key);
            opening.remove(key);
            meta.remove(key);
        }
    }

    /** 打开设备的输出端口（设备 → 主机），并挂上接收器 */
    private void attachOutputPort(final String key, MidiDevice device) {
        if (device == null) return;
        MidiDeviceInfo info = device.getInfo();
        if (info == null) {
            layerLog("L3-port", "attach fail no info key=" + key);
            try {
                device.close();
            } catch (Exception ignored) {
            }
            JSObject m = meta.get(key);
            if (m != null) m.put("connected", false);
            return;
        }
        MidiOutputPort port = null;
        int outputs = 0;
        try {
            outputs = info.getOutputPortCount();
            for (int i = 0; i < outputs; i++) {
                port = device.openOutputPort(i);
                if (port != null) break;
            }
        } catch (RuntimeException e) {
            // 部分机型蓝牙 MIDI 刚打开时服务端 MidiDeviceInfo 仍为空，openOutputPort 会把空指针抛回主线程
            layerLog("L3-port", "attach fail openOutputPort key=" + key + " " + e.getClass().getSimpleName());
            port = null;
        }
        if (port == null) {
            layerLog("L3-port", "attach fail no outputPort key=" + key + " outputs=" + outputs);
            try {
                device.close();
            } catch (Exception ignored) {
            }
            JSObject m = meta.get(key);
            if (m != null) m.put("connected", false);
            return;
        }
        layerLog("L3-port", "attach OK key=" + key + " mac=" + (meta.get(key) != null ? meta.get(key).optString("mac", "") : ""));
        opened.put(key, device);
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
                JSObject m = meta.get(key);
                if (m != null) {
                    String mac = m.optString("mac", "");
                    if (!mac.isEmpty()) payload.put("mac", mac);
                }
                notifyListeners("midiMessage", payload);
            }
        });
        mainHandler.post(MidiBridgePlugin.this::emitDevices);
    }

    private void closeDevice(String key) {
        closeDevice(key, "legacy");
    }

    private void closeDevice(String key, String reason) {
        boolean hadPort = opened.containsKey(key);
        layerLog("L3-close", "key=" + key + " reason=" + reason + " hadPort=" + hadPort);
        opening.remove(key);
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

    /**
     * 蓝牙已经不在系统 MIDI 列表、也没有 GATT/A2DP 连接时，关掉残留端口。
     * 否则界面会一直显示已连接，而且这个端口收不到新的音符。
     */
    private void closeDroppedBluetoothPorts() {
        if (midiManager == null) return;
        Set<String> listed = new HashSet<>();
        MidiDeviceInfo[] infos = midiManager.getDevices();
        if (infos != null) {
            for (MidiDeviceInfo info : infos) {
                String mac = macFromMidiInfo(info);
                if (!mac.isEmpty()) listed.add(mac.toUpperCase(Locale.US));
            }
        }
        Context ctx = getContext();
        BluetoothManager bm = ctx == null ? null : (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        for (String key : new ArrayList<>(opened.keySet())) {
            JSObject m = meta.get(key);
            if (m == null || !"bluetooth".equals(m.optString("type", ""))) continue;
            String mac = m.optString("mac", "");
            if (mac.isEmpty()) continue;
            if (listed.contains(mac.toUpperCase(Locale.US))) continue;
            if (bondedDeviceStillLinked(bm, mac)) continue;
            closeDevice(key, "link-dropped");
        }
    }

    private boolean bondedDeviceStillLinked(BluetoothManager bm, String macNorm) {
        if (bm == null || bm.getAdapter() == null || macNorm == null || macNorm.isEmpty()) return false;
        try {
            Set<BluetoothDevice> bonded = bm.getAdapter().getBondedDevices();
            if (bonded == null) return false;
            for (BluetoothDevice dev : bonded) {
                if (!macNorm.equalsIgnoreCase(macFromAddr(dev.getAddress()))) continue;
                return isAnyBtProfileConnected(bm, dev);
            }
        } catch (SecurityException ignored) {
        }
        return false;
    }

    private JSArray deviceArray() {
        closeDroppedBluetoothPorts();
        syncDeviceListState();
        LinkedHashMap<String, JSObject> byMac = new LinkedHashMap<>();
        LinkedHashMap<String, JSObject> noMac = new LinkedHashMap<>();
        for (JSObject o : new ArrayList<>(meta.values())) {
            if (!shouldExposeDevice(o)) continue;
            String mac = o.optString("mac", "").toUpperCase(Locale.US);
            if (mac.isEmpty()) {
                noMac.put(o.optString("id", ""), o);
                continue;
            }
            JSObject prev = byMac.get(mac);
            if (prev == null || preferDeviceMeta(o, prev)) byMac.put(mac, o);
        }
        JSArray arr = new JSArray();
        for (JSObject o : byMac.values()) {
            if (!putDeviceIfLive(o, arr)) {
                /* 未真正打开端口的 bt# 不进入列表，避免「已配对=在线」 */
            }
        }
        for (JSObject o : noMac.values()) {
            putDeviceIfLive(o, arr);
        }
        for (String key : opened.keySet()) {
            JSObject m = meta.get(key);
            if (m == null || !shouldExposeDevice(m)) continue;
            String mac = m.optString("mac", "").toUpperCase(Locale.US);
            boolean listed = false;
            if (!mac.isEmpty()) {
                for (String k : byMac.keySet()) {
                    if (k.equals(mac)) {
                        listed = true;
                        break;
                    }
                }
            }
            if (!listed) putDeviceIfLive(m, arr);
        }
        appendBondedMidiPreview(arr);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < arr.length(); i++) {
            if (i > 0) sb.append(';');
            try {
                JSONObject row = arr.getJSONObject(i);
                if (row != null) {
                    sb.append(row.optString("id", "?")).append(":po=").append(row.optBoolean("portOpen", false));
                }
            } catch (Exception ignored) {
            }
        }
        layerLog("L3-list", "out=" + arr.length() + " opened=" + opened.keySet()
                + " opening=" + opening + " meta=" + meta.size() + " rows=" + sb);
        return arr;
    }

    /** 仅上报已打开 MIDI 端口的设备；connected 与 opened 一致 */
    private boolean putDeviceIfLive(JSObject o, JSArray arr) {
        if (o == null) return false;
        String id = o.optString("id", "");
        boolean live = opened.containsKey(id);
        o.put("connected", live);
        o.put("portOpen", live);
        o.put("statusCode", live ? 3 : 0);
        o.put("online", live);
        if ("bluetooth".equals(o.optString("type", "")) && !live) return false;
        arr.put(o);
        return true;
    }

    /** 已配对且名称含 midi、端口尚未打开：先出现在列表（离线），打开成功后再变为在线 */
    private void appendBondedMidiPreview(JSArray arr) {
        if (!hasBluetoothPermission()) return;
        Context ctx = getContext();
        if (ctx == null) return;
        BluetoothManager bm = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bm == null || bm.getAdapter() == null) return;
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < arr.length(); i++) {
            try {
                JSONObject row = arr.getJSONObject(i);
                if (row == null) continue;
                String mac = row.optString("mac", "");
                if (!mac.isEmpty()) seen.add(mac.toUpperCase(Locale.US));
            } catch (Exception ignored) {
            }
        }
        Set<BluetoothDevice> bonded;
        try {
            bonded = bm.getAdapter().getBondedDevices();
        } catch (SecurityException e) {
            return;
        }
        if (bonded == null) return;
        for (BluetoothDevice dev : bonded) {
            String name = safeDeviceName(dev);
            if (!looksLikeMidiController(name) || isGenericMidiPlaceholder(name)) continue;
            if (!isBtLinkConnected(bm, dev)) continue;
            String mac = macFromAddr(dev.getAddress());
            if (mac.isEmpty() || !seen.add(mac.toUpperCase(Locale.US))) continue;
            if (hasOpenPortForMac(mac)) continue;
            boolean link = isBtLinkConnected(bm, dev);
            JSObject row = new JSObject();
            String key = btKeyFromAddr(dev.getAddress());
            row.put("id", key != null ? key : ("bt#" + mac.replace(":", "")));
            row.put("name", name);
            row.put("manufacturer", "");
            row.put("type", "bluetooth");
            row.put("mac", mac);
            row.put("connected", false);
            row.put("portOpen", false);
            row.put("online", false);
            row.put("statusCode", link ? 2 : 1);
            arr.put(row);
        }
    }

    private void emitDevices() {
        emitDevices(null);
    }

    /** @param disconnectedMacNorm 蓝牙 ACL 断开时带上 MAC，Web 端可立刻标「已断开」 */
    private void emitDevices(String disconnectedMacNorm) {
        JSArray devs = deviceArray();
        layerLog("L3-emit", "devicesChanged n=" + devs.length()
                + (disconnectedMacNorm != null ? " disc=" + disconnectedMacNorm : ""));
        JSObject payload = new JSObject();
        payload.put("devices", devs);
        payload.put("debug", buildDebugStatus());
        if (disconnectedMacNorm != null && !disconnectedMacNorm.isEmpty()) {
            payload.put("disconnectedMac", disconnectedMacNorm);
        }
        notifyListeners("devicesChanged", payload);
    }

    private static JSArray jsArrayFromKeys(Set<String> keys) {
        JSArray a = new JSArray();
        if (keys != null) {
            for (String k : keys) a.put(k);
        }
        return a;
    }

    /**
     * 底层快照：系统 MidiManager 列表 + 插件 opened/opening/meta，与上报的 devices（仅 portOpen）对照。
     */
    private JSObject buildDebugStatus() {
        JSObject d = new JSObject();
        int systemCount = 0;
        JSArray systemDevices = new JSArray();
        if (midiManager != null) {
            MidiDeviceInfo[] infos = midiManager.getDevices();
            if (infos != null) {
                systemCount = infos.length;
                for (MidiDeviceInfo info : infos) {
                    if (info == null) continue;
                    JSObject row = new JSObject();
                    try {
                        row.put("id", keyFor(info));
                    } catch (Exception e) {
                        row.put("id", "?");
                    }
                    row.put("mac", macFromMidiInfo(info));
                    String name = info.getProperties().getString(MidiDeviceInfo.PROPERTY_NAME);
                    row.put("name", name != null ? name : "");
                    systemDevices.put(row);
                }
            }
        }
        d.put("systemCount", systemCount);
        d.put("systemDevices", systemDevices);
        d.put("openedKeys", jsArrayFromKeys(opened.keySet()));
        d.put("openingKeys", jsArrayFromKeys(opening));
        d.put("metaKeys", jsArrayFromKeys(meta.keySet()));
        JSArray bondedMidi = new JSArray();
        if (hasBluetoothPermission()) {
            Context ctx = getContext();
            BluetoothManager bm = ctx == null ? null : (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
            if (bm != null && bm.getAdapter() != null) {
                try {
                    Set<BluetoothDevice> bonded = bm.getAdapter().getBondedDevices();
                    if (bonded != null) {
                        for (BluetoothDevice dev : bonded) {
                            String name = safeDeviceName(dev);
                            if (!looksLikeMidiController(name)) continue;
                            JSObject row = new JSObject();
                            row.put("mac", macFromAddr(dev.getAddress()));
                            row.put("name", name != null ? name : "");
                            row.put("aclOrGattConnected", isBtLinkConnected(bm, dev));
                            bondedMidi.put(row);
                        }
                    }
                } catch (SecurityException ignored) {
                }
            }
        }
        d.put("bondedMidi", bondedMidi);
        d.put("listPolicy", "devices[]=portOpen only; use systemDevices vs openedKeys when raw count=0");
        return d;
    }

    private String[] neededPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return new String[]{Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT};
        }
        return new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
    }

    private static final class PendingBluetoothAction {
        final Runnable onGranted;
        final PluginCall callToRejectOnDeny;

        PendingBluetoothAction(Runnable onGranted, PluginCall callToRejectOnDeny) {
            this.onGranted = onGranted;
            this.callToRejectOnDeny = callToRejectOnDeny;
        }
    }

    private void notifyBluetoothPermissionsReady(boolean granted) {
        JSObject payload = new JSObject();
        payload.put("granted", granted);
        notifyListeners("bluetoothPermissionsReady", payload);
    }

    /** 权限刚授予或从系统设置返回：再扫一轮，不依赖可能已丢失的 pendingAction */
    private void recoverAfterBluetoothPermissionsGranted() {
        layerLog("L2-SYS", "bluetooth permissions granted → recovery openAll");
        openAllMidiWithRetry();
        emitDevices();
        notifyBluetoothPermissionsReady(true);
    }

    private void ensureBluetoothPermissions(final Runnable action) {
        ensureBluetoothPermissions(action, null);
    }

    private void ensureBluetoothPermissions(final Runnable action, PluginCall callToRejectOnDeny) {
        if (getActivity() == null) {
            action.run();
            return;
        }
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
        synchronized (pendingBluetoothActions) {
            pendingBluetoothActions.add(new PendingBluetoothAction(action, callToRejectOnDeny));
        }
        if (bluetoothPermissionRequestInFlight) {
            layerLog("L2-SYS", "bluetooth permission request already in flight, queued action");
            return;
        }
        bluetoothPermissionRequestInFlight = true;
        layerLog("L2-SYS", "request bluetooth permissions missing=" + missing.size());
        PluginCall capCall = callToRejectOnDeny;
        if (capCall == null) {
            synchronized (pendingBluetoothActions) {
                for (PendingBluetoothAction p : pendingBluetoothActions) {
                    if (p.callToRejectOnDeny != null) {
                        capCall = p.callToRejectOnDeny;
                        break;
                    }
                }
            }
        }
        if (capCall == null) {
            bluetoothPermissionRequestInFlight = false;
            layerLog("L2-SYS", "bluetooth permission need PluginCall (Capacitor); action queued");
            return;
        }
        requestPermissionForAlias("bluetooth", capCall, "bluetoothPermsCallback");
    }

    /** Capacitor 8 必须把权限走 requestPermissionForAlias，否则 requestCode 1001 无人接，openAll 永不 resolve */
    @PermissionCallback
    private void bluetoothPermsCallback(PluginCall call) {
        bluetoothPermissionRequestInFlight = false;
        List<PendingBluetoothAction> batch;
        synchronized (pendingBluetoothActions) {
            batch = new ArrayList<>(pendingBluetoothActions);
            pendingBluetoothActions.clear();
        }
        boolean granted = hasBluetoothPermission()
                || getPermissionState("bluetooth") == PermissionState.GRANTED;
        layerLog("L2-SYS", "bluetoothPermsCallback granted=" + granted + " batch=" + batch.size());
        if (granted) {
            for (PendingBluetoothAction pending : batch) {
                try {
                    pending.onGranted.run();
                } catch (Exception e) {
                    Log.w(LAYER_LOG, "pending bluetooth action failed", e);
                }
            }
            mainHandler.post(this::recoverAfterBluetoothPermissionsGranted);
        } else {
            for (PendingBluetoothAction pending : batch) {
                if (pending.callToRejectOnDeny != null) {
                    pending.callToRejectOnDeny.reject("蓝牙权限未授予");
                }
            }
            notifyBluetoothPermissionsReady(false);
            if (call != null) {
                call.reject("蓝牙权限未授予");
            }
        }
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (!hasBluetoothPermission()) return;
        mainHandler.postDelayed(() -> {
            if (!hasBluetoothPermission()) return;
            layerLog("L2-SYS", "onResume with BT permissions → openAll retry");
            openAllMidiRetryPass();
            emitDevices();
        }, 400);
    }

    private int openAllSystemMidi() {
        if (midiManager == null) return 0;
        MidiDeviceInfo[] infos = midiManager.getDevices();
        int n = 0;
        if (infos != null) {
            for (MidiDeviceInfo info : infos) {
                openInfo(info);
                n++;
            }
        }
        return n;
    }

    /** 二次尝试：蓝牙重连后 getDevices() / openDevice 常需延迟 */
    private void openAllMidiRetryPass() {
        layerLog("L3-retry", "openAllMidiRetryPass");
        openBondedMidiControllers();
        openAllSystemMidi();
        emitDevices();
    }

    private void openAllMidiWithRetry() {
        openAllMidiRetryPass();
        mainHandler.postDelayed(() -> {
            if (opened.isEmpty()) startBleMidiScanInternal(BLE_RECONNECT_SCAN_MS);
        }, 800);
        mainHandler.postDelayed(this::openAllMidiRetryPass, 1200);
        mainHandler.postDelayed(this::openAllMidiRetryPass, 2800);
        mainHandler.postDelayed(this::openAllMidiRetryPass, 4800);
        mainHandler.postDelayed(this::openAllMidiRetryPass, 6500);
    }

    private static final long BLE_RECONNECT_SCAN_MS = 6000L;

    /** ACL 重连后系统 getDevices 仍为空时短时 BLE 扫描（与 scanBle 同逻辑，无 PluginCall） */
    private void startBleMidiScanInternal(long durationMs) {
        if (scanning || opened.size() > 0) return;
        layerLog("L3-retry", "startBleMidiScanInternal ms=" + durationMs);
        Context ctx = getContext();
        if (ctx == null) return;
        BluetoothManager bm = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothLeScanner sc = bm == null || bm.getAdapter() == null ? null : bm.getAdapter().getBluetoothLeScanner();
        if (sc == null) return;
        ensureBluetoothPermissions(() -> {
            if (scanning || opened.size() > 0) return;
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
                openAllMidiRetryPass();
            }, durationMs);
        });
    }

    /** 系统蓝牙已配对、但尚未出现在 getDevices() 的 MIDI 手柄 */
    /** 已配对但未连上的手柄不要 open，否则 Web 端会误显示「在线」 */
    private boolean isBtLinkConnected(BluetoothManager bm, BluetoothDevice dev) {
        if (dev == null) return false;
        if (isAnyBtProfileConnected(bm, dev)) return true;
        String mac = macFromAddr(dev.getAddress());
        if (mac.isEmpty() || midiManager == null) return false;
        MidiDeviceInfo[] infos = midiManager.getDevices();
        if (infos == null) return false;
        for (MidiDeviceInfo info : infos) {
            if (mac.equalsIgnoreCase(macFromMidiInfo(info))) return true;
        }
        return false;
    }

    private static boolean isAnyBtProfileConnected(BluetoothManager bm, BluetoothDevice dev) {
        if (bm == null || dev == null) return false;
        int[] profiles = {
                BluetoothProfile.GATT,
                BluetoothProfile.HEADSET,
                BluetoothProfile.A2DP,
        };
        for (int profile : profiles) {
            try {
                if (bm.getConnectionState(dev, profile) == BluetoothProfile.STATE_CONNECTED) {
                    return true;
                }
            } catch (RuntimeException ignored) {
                // 部分平板对 HEADSET(1)/A2DP 抛 IllegalArgumentException: Profile not supported
            }
        }
        return false;
    }

    private boolean isMacInSystemMidiList(String macNorm) {
        if (macNorm == null || macNorm.isEmpty() || midiManager == null) return false;
        MidiDeviceInfo[] infos = midiManager.getDevices();
        if (infos == null) return false;
        for (MidiDeviceInfo info : infos) {
            if (macNorm.equalsIgnoreCase(macFromMidiInfo(info))) return true;
        }
        return false;
    }

    /** 0=未知 1=已配对未连 2=已连/已登记MIDI但端口未开 3=端口已开可演奏 */
    private int linkStatusCode(BluetoothManager bm, String macNorm, BluetoothDevice bonded) {
        if (hasOpenPortForMac(macNorm)) return 3;
        if (isMacInSystemMidiList(macNorm)) return 2;
        if (bonded != null && isBtLinkConnected(bm, bonded)) return 2;
        if (bonded != null) return 1;
        return 0;
    }

    private static String linkStatusLabel(int code) {
        switch (code) {
            case 3:
                return "READY";
            case 2:
                return "LINK_OR_MIDI";
            case 1:
                return "BONDED_OFFLINE";
            default:
                return "UNKNOWN";
        }
    }

    private void purgeUnopenedBluetoothMeta() {
        for (String key : new ArrayList<>(meta.keySet())) {
            if (opened.containsKey(key) || opening.contains(key)) continue;
            JSObject m = meta.get(key);
            if (m == null) continue;
            if ("bluetooth".equals(m.optString("type", ""))) closeDevice(key, "probe-purge");
        }
    }

    private JSObject buildProbeReport() {
        JSObject report = new JSObject();
        JSArray entries = new JSArray();
        BluetoothManager bm = null;
        Context ctx = getContext();
        if (ctx != null) {
            bm = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        }
        Set<String> seenMac = new HashSet<>();
        if (hasBluetoothPermission() && bm != null && bm.getAdapter() != null) {
            try {
                Set<BluetoothDevice> bonded = bm.getAdapter().getBondedDevices();
                if (bonded != null) {
                    for (BluetoothDevice dev : bonded) {
                        String name = safeDeviceName(dev);
                        if (!looksLikeMidiController(name)) continue;
                        String mac = macFromAddr(dev.getAddress());
                        if (mac.isEmpty() || !seenMac.add(mac)) continue;
                        int code = linkStatusCode(bm, mac, dev);
                        JSObject row = new JSObject();
                        row.put("mac", mac);
                        row.put("name", name != null ? name : "");
                        row.put("statusCode", code);
                        row.put("status", linkStatusLabel(code));
                        row.put("portOpen", code == 3);
                        row.put("gattOrProfileConnected", isAnyBtProfileConnected(bm, dev));
                        row.put("systemMidiListed", isMacInSystemMidiList(mac));
                        entries.put(row);
                    }
                }
            } catch (SecurityException ignored) {
            }
        }
        if (midiManager != null) {
            MidiDeviceInfo[] infos = midiManager.getDevices();
            if (infos != null) {
                for (MidiDeviceInfo info : infos) {
                    if (info == null || info.getType() != MidiDeviceInfo.TYPE_BLUETOOTH) continue;
                    String mac = macFromMidiInfo(info);
                    if (mac.isEmpty() || !seenMac.add(mac)) continue;
                    int code = linkStatusCode(bm, mac, null);
                    String name = info.getProperties().getString(MidiDeviceInfo.PROPERTY_NAME);
                    JSObject row = new JSObject();
                    row.put("mac", mac);
                    row.put("name", name != null ? name : "");
                    row.put("statusCode", code);
                    row.put("status", linkStatusLabel(code));
                    row.put("portOpen", code == 3);
                    row.put("gattOrProfileConnected", false);
                    row.put("systemMidiListed", true);
                    try {
                        row.put("systemId", keyFor(info));
                    } catch (Exception e) {
                        row.put("systemId", "?");
                    }
                    entries.put(row);
                }
            }
        }
        report.put("entries", entries);
        report.put("statusLegend", "0=UNKNOWN 1=BONDED_OFFLINE 2=LINK_OR_MIDI 3=READY(portOpen)");
        return report;
    }

    /**
     * 手动「刷新手柄列表」：读蓝牙/MidiManager 底层状态，清缓存并重试 open（约 2s）。
     * 日常 devicesChanged 仍用轻量列表；仅点刷新时以 probe 结果为准。
     */
    @PluginMethod
    public void probeDevices(PluginCall call) {
        if (midiManager == null) {
            call.reject("系统不支持 MIDI");
            return;
        }
        ensureBluetoothPermissions(() -> {
            layerLog("L3-probe", "start");
            bleFound.clear();
            purgeUnopenedBluetoothMeta();
            final AtomicBoolean probeDone = new AtomicBoolean(false);
            Runnable finish = () -> {
                if (!probeDone.compareAndSet(false, true)) return;
                openAllMidiRetryPass();
                JSObject probe = buildProbeReport();
                JSArray devs = deviceArray();
                layerLog("L3-probe", "finish listN=" + devs.length() + " probe=" + probe.toString());
                JSObject res = new JSObject();
                res.put("devices", devs);
                res.put("debug", buildDebugStatus());
                res.put("probe", probe);
                emitDevices();
                call.resolve(res);
            };
            mainHandler.postDelayed(() -> {
                if (probeDone.get()) return;
                layerLog("L3-probe", "failSafe timeout resolve");
                finish.run();
            }, 12000);
            openAllMidiRetryPass();
            mainHandler.postDelayed(() -> {
                openAllMidiRetryPass();
                mainHandler.postDelayed(finish, 1200);
            }, 600);
        }, call);
    }

    private int openBondedMidiControllers() {
        if (midiManager == null || !hasBluetoothPermission()) return 0;
        Context ctx = getContext();
        if (ctx == null) return 0;
        BluetoothManager bm = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bm == null || bm.getAdapter() == null) return 0;
        Set<BluetoothDevice> bonded;
        try {
            bonded = bm.getAdapter().getBondedDevices();
        } catch (SecurityException e) {
            return 0;
        }
        if (bonded == null || bonded.isEmpty()) return 0;
        int n = 0;
        for (BluetoothDevice dev : bonded) {
            String addr = dev.getAddress();
            if (addr == null) continue;
            if (!isBtLinkConnected(bm, dev)) continue;
            String key = btKeyFromAddr(addr);
            if (key == null || opened.containsKey(key) || opening.contains(key)) continue;
            String macNorm = macFromAddr(addr);
            if (hasOpenPortForMac(macNorm)) continue;
            if (meta.containsKey(key) && !opened.containsKey(key)) meta.remove(key);
            if (!looksLikeMidiController(safeDeviceName(dev))) continue;
            openBluetooth(dev, addr);
            n++;
        }
        return n;
    }

    private void finishOpenAll(PluginCall call) {
        emitDevices();
        JSObject res = new JSObject();
        res.put("devices", deviceArray());
        if (midiManager != null) {
            MidiDeviceInfo[] infos = midiManager.getDevices();
            res.put("systemCount", infos == null ? 0 : infos.length);
        } else {
            res.put("systemCount", 0);
        }
        call.resolve(res);
    }

    /**
     * 应用启动时调用：缺权限则立刻弹出系统对话框；已授权则立即返回。
     * 用户点「允许」后会走 recovery openAll，并触发 bluetoothPermissionsReady 事件。
     */
    @PluginMethod
    public void getBluetoothPermissionState(PluginCall call) {
        JSObject res = new JSObject();
        res.put("granted", hasBluetoothPermission());
        call.resolve(res);
    }

    @PluginMethod
    public void requestBluetoothPermissions(PluginCall call) {
        if (getActivity() == null) {
            call.reject("Activity 未就绪");
            return;
        }
        if (hasBluetoothPermission()) {
            JSObject res = new JSObject();
            res.put("granted", true);
            res.put("alreadyHad", true);
            call.resolve(res);
            return;
        }
        layerLog("L2-SYS", "requestBluetoothPermissions at launch");
        ensureBluetoothPermissions(() -> {
            JSObject res = new JSObject();
            res.put("granted", true);
            res.put("alreadyHad", false);
            call.resolve(res);
        }, call);
    }

    @PluginMethod
    public void getDevices(PluginCall call) {
        layerLog("L3-api", "getDevices");
        JSObject res = new JSObject();
        res.put("devices", deviceArray());
        res.put("debug", buildDebugStatus());
        call.resolve(res);
    }

    /**
     * 打开需要监听的 MIDI 端口：USB 走 MidiManager 已登记的设备；蓝牙仅名称含 midi 且已连接/已登记。
     * （Android 不 open 端口就不会往应用送 MIDI 字节，不能只靠 getDevices 读列表。）
     */
    @PluginMethod
    public void openAll(PluginCall call) {
        layerLog("L3-api", "openAll enter");
        if (midiManager == null) {
            finishOpenAll(call);
            return;
        }
        Runnable work = () -> {
            layerLog("L3-api", "openAll work run");
            openAllMidiRetryPass();
            finishOpenAll(call);
            mainHandler.postDelayed(this::openAllMidiRetryPass, 1200);
        };
        ensureBluetoothPermissions(work, call);
    }

    /** 扫描蓝牙 MIDI（BLE-MIDI）设备并打开 */
    @PluginMethod
    public void scanBle(PluginCall call) {
        ensureBluetoothPermissions(() -> {
            Context ctx = getContext();
            BluetoothManager bm = ctx == null ? null : (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothLeScanner sc = bm == null || bm.getAdapter() == null ? null : bm.getAdapter().getBluetoothLeScanner();
            if (sc == null) {
                call.reject("蓝牙不可用");
                return;
            }
            startBleMidiScanInternal(SCAN_MS);
            mainHandler.postDelayed(() -> {
                JSObject res = new JSObject();
                res.put("devices", deviceArray());
                call.resolve(res);
            }, SCAN_MS + 200);
        }, call);
    }

    @PluginMethod
    public void closeAll(PluginCall call) {
        for (String key : new ArrayList<>(meta.keySet())) closeDevice(key, "closeAll");
        emitDevices();
        call.resolve();
    }

    @Override
    public void handleOnDestroy() {
        Context ctx = getContext();
        if (btReceiverRegistered && ctx != null && btStateReceiver != null) {
            try {
                ctx.unregisterReceiver(btStateReceiver);
            } catch (Exception ignored) {
            }
            btReceiverRegistered = false;
        }
        for (String key : new ArrayList<>(meta.keySet())) closeDevice(key, "destroy");
        super.handleOnDestroy();
    }
}
