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
    return {
        id: String(d.id),
        name: d.name || String(d.id),
        manufacturer: d.manufacturer || '',
        state: d.connected === false ? 'disconnected' : 'connected',
        connection: 'open',
        guessBluetooth: /bluetooth|ble/i.test(d.type || '') || !!d.bluetooth,
    };
}

export class NativeMidiHub {
    constructor(engine) {
        this.engine = engine;
        this.devices = [];
        this.resolveRoute = () => null;
        this.onDevices = () => {};
        this.onActivity = () => {};
        this.onError = () => {};
        this.bound = false;
    }

    get available() {
        return isNativeMidiAvailable();
    }

    get sysex() {
        return true;
    }

    async connect() {
        const p = nativeMidiPlugin();
        if (!p) throw new Error('未找到原生 MIDI 插件（MidiBridge）');
        if (!this.bound) {
            this.bound = true;
            // 不同注入路径下 addListener 可能返回 Promise 也可能同步返回，统一包一层
            await Promise.resolve(p.addListener('midiMessage', (ev) => this.handle(ev)));
            await Promise.resolve(p.addListener('devicesChanged', (ev) => this.refreshFromEvent(ev))).catch(() => {});
        }
        try {
            await p.openAll();
        } catch (e) {
            this.onError(e);
        }
        await this.refresh();
        return true;
    }

    async rescan() {
        const p = nativeMidiPlugin();
        if (!p) return;
        // Android 需要扫描蓝牙 MIDI 设备；iOS 由系统自动接入，scanBle 为空实现
        if (typeof p.scanBle === 'function') await p.scanBle().catch(() => {});
        await p.openAll().catch(() => {});
        await this.refresh();
    }

    async refresh() {
        const p = nativeMidiPlugin();
        if (!p) return;
        const res = await p.getDevices();
        this.devices = (res.devices || []).map(toDev);
        this.onDevices(this.devices);
    }

    refreshFromEvent(ev) {
        if (ev && ev.devices) {
            this.devices = ev.devices.map(toDev);
            this.onDevices(this.devices);
        } else {
            this.refresh().catch(() => {});
        }
    }

    handle(ev) {
        const id = String(ev.id);
        const data = ev.data;
        if (!data || !data.length) return;
        // played=true：原生插件已按路由直接发声（低延迟路径），这里只做界面高亮
        if (ev.played) {
            const info = peekNote(data);
            if (info) this.onActivity(id, info);
            return;
        }
        const route = this.resolveRoute(id);
        const info = routeMidiMessage(this.engine, route, data);
        if (info) this.onActivity(id, info);
    }
}

function peekNote(data) {
    const status = data[0];
    const type = status & 0xf0;
    if (type !== 0x90 && type !== 0x80) return null;
    const vel = type === 0x80 ? 0 : data[2];
    return { note: data[1], velocity: vel, on: vel > 0 };
}
