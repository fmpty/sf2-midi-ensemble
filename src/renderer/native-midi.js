/**
 * 原生 MIDI 通道（Android / iOS 安装包）。
 *
 * Android：android.media.midi（USB-MIDI + BLE-MIDI）
 * iOS    ：CoreMIDI（系统自动接管 BLE-MIDI / USB-MIDI）
 *
 * 原生插件把设备列表与 MIDI 字节流通过 Capacitor 事件送到 WebView，
 * 之后复用与 Web MIDI 完全相同的路由逻辑（routeMidiMessage）。
 */
import { routeMidiMessage } from './midi.js';
import { routeAcceptsMidiInput } from './route-midi.js';
import { deviceMac, macFromDeviceId, normalizeMac } from './device-id.js';
import { midiLayerLog, MIDI_LAYER_LOG_REV } from './midi-layer-log.js';
import { midiTrace } from './midi-debug.js';
import { trackFromRouteMidi } from './note-leak-guard.js';
import { captureNativePlayed } from './performance-midi.js';

export function nativeMidiPlugin() {
    if (typeof window === 'undefined') return null;
    const cap = window.Capacitor;
    if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;
    if (cap.Plugins && cap.Plugins.MidiBridge) return cap.Plugins.MidiBridge;
    if (typeof cap.registerPlugin === 'function') {
        try {
            return cap.registerPlugin('MidiBridge');
        } catch {
            return null;
        }
    }
    return null;
}

export function isNativeMidiAvailable() {
    return !!nativeMidiPlugin();
}

function toDev(d) {
    const id = String(d.id ?? '');
    let mac = d.mac ? String(d.mac) : '';
    if (!mac && id.startsWith('bt#') && id.length >= 15) {
        mac = id.slice(3).match(/.{2}/g).join(':').toUpperCase();
    }
    const portOpen = d.portOpen === true;
    return {
        id,
        mac,
        name: d.name || id,
        manufacturer: d.manufacturer || '',
        type: d.type != null ? String(d.type) : '',
        connected: portOpen,
        portOpen,
        statusCode: d.statusCode != null ? Number(d.statusCode) : (portOpen ? 3 : 0),
        online: portOpen || d.statusCode === 3,
        state: portOpen ? 'connected' : 'disconnected',
        connection: portOpen ? 'open' : '',
        guessBluetooth: /bluetooth|ble/i.test(d.type || '') || !!d.bluetooth,
        /** 原生插件返回的完整字段，便于 logcat / 日志里对照 */
        nativeRaw: typeof d === 'object' && d ? { ...d } : d,
    };
}

export class NativeMidiHub {
    constructor(engine) {
        this.engine = engine;
        this.devices = [];
        this.resolveRoute = () => null;
        this.onDevices = () => {};
        this.onActivity = () => {};
        /** 任意 MIDI 入站（用于纠正 UI 在线状态，须在 routeMidiMessage 之前） */
        this.onRawMidi = () => {};
        this.onError = () => {};
        this.bound = false;
        this._devTimer = 0;
        /** @type {Map<string, number>} id 或规范化 MAC → 最近一次收到 MIDI 的时间 */
        this._midiSeenAt = new Map();
        /** @type {boolean} 是否至少见过一次非空设备列表（用于启动时空列表不误伤） */
        this._nativeScanSeen = false;
        /** @type {unknown[]} 与 devices 同一次 publish 的原生 payload（避免 sync 用旧缓存） */
        this._lastRawNative = [];
    }

    _pluginCallWithTimeout(promise, ms, label) {
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms);
            }),
        ]);
    }

    /** 后台打开端口（原生：USB MIDI + 蓝牙名含 midi）；不阻塞「刷新列表」 */
    _openPortsInBackground() {
        const p = nativeMidiPlugin();
        if (!p || typeof p.openAll !== 'function') return;
        midiTrace('openPorts-background');
        void p
            .openAll()
            .catch((e) => this.onError(e))
            .then(() => this.refresh().catch(() => {}));
    }

    /** 供 UI 判断「列表暂时为空但仍在演奏」 */
    /** 从上报 id（含系统 3#xx）解析 MAC，供「有 MIDI 即在线」判定 */
    _macForActivityId(deviceId) {
        const id = String(deviceId || '');
        let mac = normalizeMac(macFromDeviceId(id));
        if (!mac && id) {
            const dev = this.devices.find((d) => String(d.id) === id);
            mac = normalizeMac(deviceMac(dev));
        }
        return mac;
    }

    isDeviceRecentlyActive(deviceId, deviceMac) {
        /** 原生 MIDI 上报比扫描列表更可靠；略长窗口覆盖 open 与 scan 之间的空窗 */
        const windowMs = 6000;
        const now = Date.now();
        const id = String(deviceId || '');
        let mac = normalizeMac(deviceMac || macFromDeviceId(id));
        if (!mac && id) mac = this._macForActivityId(id);
        if (id && now - (this._midiSeenAt.get(id) || 0) < windowMs) return true;
        if (mac && now - (this._midiSeenAt.get(mac) || 0) < windowMs) return true;
        for (const [key, t] of this._midiSeenAt) {
            if (now - t >= windowMs) continue;
            if (key === id || (mac && key === mac)) return true;
            const km = this._macForActivityId(key);
            if (mac && km === mac) return true;
        }
        return false;
    }

    _touchMidiActivity(id) {
        const now = Date.now();
        const s = String(id);
        this._midiSeenAt.set(s, now);
        const mac = this._macForActivityId(s);
        if (mac) this._midiSeenAt.set(mac, now);
    }

    _clearActivityForMac(mac) {
        const norm = normalizeMac(mac);
        if (!norm) return;
        for (const key of [...this._midiSeenAt.keys()]) {
            if (normalizeMac(key) === norm || normalizeMac(macFromDeviceId(key)) === norm) {
                this._midiSeenAt.delete(key);
            }
        }
    }

    _purgeActivityNotInDeviceList(devs) {
        if (!devs.length) return;
        const ids = new Set();
        const macs = new Set();
        for (const d of devs) {
            ids.add(String(d.id));
            const m = normalizeMac(d.mac || macFromDeviceId(d.id));
            if (m) macs.add(m);
        }
        for (const key of [...this._midiSeenAt.keys()]) {
            if (key.startsWith('bt#') && !ids.has(key)) {
                this._midiSeenAt.delete(key);
                continue;
            }
            const km = normalizeMac(key);
            if (km && km.includes(':') && !macs.has(km)) {
                this._midiSeenAt.delete(key);
            }
        }
    }

    _publishDevices(raw, extra = {}) {
        const rawArr = Array.isArray(raw) ? raw : [];
        const list = rawArr.map(toDev);
        this._lastRawNative = rawArr;
        this._purgeActivityNotInDeviceList(list);
        if (extra.disconnectedMac) this._clearActivityForMac(extra.disconnectedMac);
        this.devices = list;
        if (list.length > 0) this._nativeScanSeen = true;
        midiLayerLog('L4-cap', 'publish', {
            n: list.length,
            ids: list.map((d) => d.id),
            portOpen: list.map((d) => d.portOpen),
            macs: list.map((d) => d.mac || ''),
            manualProbe: !!extra.manualProbe,
            disconnectedMac: extra.disconnectedMac || '',
        });
        this.onDevices(this.devices, {
            ...extra,
            rawNative: rawArr,
            nativeDebug: extra.nativeDebug ?? null,
        });
    }

    get available() {
        return isNativeMidiAvailable();
    }

    get sysex() {
        return true;
    }

    async _bindNativeListeners() {
        if (this.bound) return;
        const p = nativeMidiPlugin();
        if (!p) return;
        this.bound = true;
        midiLayerLog('L4-cap', 'bundle', { rev: MIDI_LAYER_LOG_REV });
        await Promise.resolve(p.addListener('midiMessage', (ev) => this.handle(ev)));
        await Promise.resolve(p.addListener('devicesChanged', (ev) => this.refreshFromEvent(ev))).catch(() => {});
        await Promise.resolve(
            p.addListener('bluetoothPermissionsReady', (ev) => {
                midiLayerLog('L4-cap', 'bluetoothPermissionsReady', ev || {});
                if (ev && ev.granted === false) return;
                this.rescan({ quick: true }).catch((e) => this.onError(e));
            }),
        ).catch(() => {});
    }

    /** 打开应用即请求蓝牙权限（Android 12+），不等待用户点「启动音频引擎」 */
    async requestBluetoothPermissionsAtLaunch() {
        const p = nativeMidiPlugin();
        if (!p || typeof p.requestBluetoothPermissions !== 'function') return { granted: true };
        await this._bindNativeListeners();
        midiTrace('perm-at-launch-start');
        let lastErr = null;
        for (let attempt = 0; attempt < 8; attempt++) {
            try {
                if (typeof p.getBluetoothPermissionState === 'function') {
                    const st = await this._pluginCallWithTimeout(
                        p.getBluetoothPermissionState(),
                        8000,
                        'getBluetoothPermissionState',
                    );
                    if (st && st.granted) {
                        midiTrace('perm-at-launch-already');
                        return st;
                    }
                }
                return await this._pluginCallWithTimeout(
                    p.requestBluetoothPermissions(),
                    90000,
                    '蓝牙权限',
                );
            } catch (e) {
                lastErr = e;
                const msg = e && e.message ? String(e.message) : '';
                if (!/Activity 未就绪|not ready/i.test(msg)) throw e;
                await new Promise((r) => setTimeout(r, 350));
            }
        }
        throw lastErr || new Error('蓝牙权限请求失败');
    }

    /** @param {{ openPorts?: boolean }} [opts] 启动阶段勿 openPorts，避免蓝牙权限/打开端口导致闪退 */
    async connect(opts = {}) {
        const p = nativeMidiPlugin();
        if (!p) throw new Error('未找到原生 MIDI 插件（MidiBridge）');
        await this._bindNativeListeners();
        await this.refresh();
        if (opts.openPorts !== false) {
            p.openAll().catch((e) => this.onError(e)).then(() => this.refresh());
        }
        return true;
    }

    /**
     * @param {{ deep?: boolean, quick?: boolean }} [opts]
     * quick=true：只读系统列表（getDevices），openAll 放后台——用户点「刷新手柄列表」用此路径
     * deep=true：probeDevices 探测（调试）
     */
    async rescan(opts = {}) {
        const p = nativeMidiPlugin();
        if (!p) return;

        if (opts.quick) {
            midiTrace('rescan-quick');
            await this.refresh();
            this._openPortsInBackground();
            return;
        }

        if (opts.deep && typeof p.probeDevices === 'function') {
            midiLayerLog('L4-cap', 'probeDevices call');
            try {
                const res = await this._pluginCallWithTimeout(p.probeDevices(), 25000, 'probeDevices');
                midiLayerLog('L4-cap', 'probeDevices result', {
                    n: (res.devices || []).length,
                    probe: res.probe,
                });
                this._publishDevices(res.devices || [], {
                    nativeDebug: res.debug || null,
                    manualProbe: true,
                    probe: res.probe || null,
                });
                return;
            } catch (e) {
                this.onError(e);
                midiLayerLog('L4-cap', 'probeDevices fallback openAll');
            }
        }

        midiTrace('rescan-full');
        let first = null;
        try {
            first = await p.openAll();
        } catch (e) {
            this.onError(e);
        }
        await this.refresh();
        const systemCount = first && first.systemCount != null ? first.systemCount : 0;
        if (this.devices.length === 0 && systemCount > 0) {
            await new Promise((r) => setTimeout(r, 600));
            await p.openAll().catch((e) => this.onError(e));
            await this.refresh();
        }
        if (this.devices.length === 0 && systemCount === 0 && typeof p.scanBle === 'function') {
            await p.scanBle().catch((e) => this.onError(e));
            await p.openAll().catch((e) => this.onError(e));
            await this.refresh();
        }
        midiTrace('rescan-done', { n: this.devices.length });
    }

    async refresh() {
        const p = nativeMidiPlugin();
        if (!p) return;
        midiTrace('getDevices-call');
        const res = await this._pluginCallWithTimeout(p.getDevices(), 8000, 'getDevices');
        midiTrace('getDevices-ok', { n: (res.devices || []).length });
        this._publishDevices(res.devices || [], { nativeDebug: res.debug || null });
    }

    /** UI「刷新手柄列表」：先挂上 devicesChanged，再读列表；open 在后台，列表会随端口打开更新 */
    async refreshList() {
        await this._bindNativeListeners();
        await this.refresh();
        this._openPortsInBackground();
    }

    refreshFromEvent(ev) {
        const disc = ev && ev.disconnectedMac ? String(ev.disconnectedMac) : '';
        midiLayerLog('L4-cap', 'devicesChanged', {
            disc: disc || null,
            n: Array.isArray(ev?.devices) ? ev.devices.length : -1,
        });
        if (disc) {
            clearTimeout(this._devTimer);
            const raw = ev && ev.devices;
            if (Array.isArray(raw)) {
                this._publishDevices(raw, {
                    disconnectedMac: disc,
                    immediate: true,
                    nativeDebug: ev.debug || null,
                });
            } else {
                this._clearActivityForMac(disc);
                this.refresh().catch(() => {});
            }
            return;
        }
        clearTimeout(this._devTimer);
        this._devTimer = setTimeout(() => {
            const raw = ev && ev.devices;
            if (Array.isArray(raw)) {
                this._publishDevices(raw, { nativeDebug: ev && ev.debug ? ev.debug : null });
            } else {
                this.refresh().catch(() => {});
            }
        }, 80);
    }

    handle(ev) {
        const id = String(ev.id);
        const data = ev.data;
        if (!data || !data.length) return;
        this._touchMidiActivity(id);
        const macHint = ev.mac ? String(ev.mac) : '';
        if (!this._lastMidiLogAt || Date.now() - this._lastMidiLogAt > 2000) {
            this._lastMidiLogAt = Date.now();
            midiLayerLog('L4-cap', 'midiMessage sample', { id, mac: macHint || null, played: !!ev.played });
        }
        this.onRawMidi(id, macHint);
        const route = this.resolveRoute(id);
        if (!routeAcceptsMidiInput(route)) return;
        // played=true：原生已发声；离线路由已从 setRoutes 剔除，此处不应再亮 UI
        if (ev.played) {
            trackFromRouteMidi(route, data, { applyTranspose: true });
            captureNativePlayed(route, data);
            const info = peekNote(data);
            if (info) this.onActivity(id, info);
            return;
        }
        const info = routeMidiMessage(this.engine, route, data);
        if (info) {
            this.onActivity(id, info);
        }
    }
}

function peekNote(data) {
    const status = data[0];
    const type = status & 0xf0;
    if (type !== 0x90 && type !== 0x80) return null;
    const vel = type === 0x80 ? 0 : data[2];
    return { note: data[1], velocity: vel, on: vel > 0 };
}
