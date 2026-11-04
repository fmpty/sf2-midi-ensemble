/**
 * Windows Electron：主进程 RTMidi + Web MIDI；演奏优先 Web（蓝牙常仅 Web 可达），避免 WinMM 独占。
 */
import { MidiHub, routeMidiMessage } from './midi.js';

export function isElectronDesktopMidiAvailable() {
    return typeof window !== 'undefined' && !!window.api?.midiListDevices;
}

function normName(name) {
    return String(name || '').trim().toLowerCase();
}

/** 同名设备保留 Web MIDI 的 id（路由与 onmidimessage 一致） */
function mergeDeviceLists(webList, rtList) {
    const map = new Map();
    for (const d of rtList) map.set(normName(d.name), d);
    for (const d of webList) map.set(normName(d.name), d);
    return [...map.values()];
}

export class ElectronMidiHub {
    constructor(engine) {
        this.engine = engine;
        this.web = new MidiHub(engine);
        this.devices = [];
        this.useWebFallback = false;
        this._resolveRoute = () => null;
        this._onActivity = () => {};
        this.onDevices = () => {};
        this.onError = () => {};
        this.sysex = false;
        this._unsubMidi = null;
    }

    get resolveRoute() {
        return this._resolveRoute;
    }

    set resolveRoute(fn) {
        this._resolveRoute = fn;
        this.web.resolveRoute = fn;
    }

    get onActivity() {
        return this._onActivity;
    }

    set onActivity(fn) {
        this._onActivity = fn;
        this.web.onActivity = fn;
    }

    get available() {
        return isElectronDesktopMidiAvailable() || this.web.available;
    }

    async connect(_opts = {}) {
        if (!this._unsubMidi && window.api.onMidiBytes) {
            this._unsubMidi = window.api.onMidiBytes(({ deviceId, data }) => {
                this.handleRt(deviceId, new Uint8Array(data));
            });
        }
        await this.rescan();
        return true;
    }

    async rescan() {
        let webList = [];
        try {
            await this.web.connect({ force: true });
            webList = this.web.devices;
        } catch (e) {
            this.onError(e);
        }

        let rtList = [];
        if (webList.length > 0) {
            this.useWebFallback = true;
            if (window.api.midiCloseAll) await window.api.midiCloseAll().catch(() => {});
            this.devices = mergeDeviceLists(webList, rtList);
        } else {
            this.useWebFallback = false;
            this.web.releaseInputs();
            try {
                rtList = await window.api.midiListDevices();
                if (rtList.length) rtList = await window.api.midiOpenAll();
            } catch (e) {
                this.onError(e);
            }
            this.devices = rtList;
        }
        this.onDevices(this.devices, { rawNative: this.devices });
    }

    refresh() {
        return this.rescan();
    }

    handleRt(deviceId, data) {
        if (this.useWebFallback) return;
        const route = this._resolveRoute(deviceId);
        const info = routeMidiMessage(this.engine, route, data);
        if (info) this._onActivity(deviceId, info);
    }

    handle(deviceId, data) {
        return this.web.handle(deviceId, data);
    }
}
