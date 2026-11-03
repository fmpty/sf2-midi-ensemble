/**
 * Web MIDI 管理器：枚举（含蓝牙 BLE-MIDI）输入设备，并按路由转发到合成器。
 * Chrome/Edge/Electron 的 Web MIDI 原生支持蓝牙 MIDI 设备，
 * 因此本模块可同时接入多个蓝牙/USB MIDI 手柄。
 */

const BLE_HINTS = /bluetooth|ble\b|wireless|widi|airturn|cme|xkey|widi|bud|midi\+|le-|_le\b/i;

export class MidiHub {
    constructor(engine) {
        this.engine = engine;
        this.access = null;
        this.devices = [];
        this.bound = new Map(); // id -> MIDIInput
        this.resolveRoute = () => null;
        this.onDevices = () => {};
        this.onActivity = () => {};
        this.onError = () => {};
        this.sysex = false;
    }

    get available() {
        return typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess;
    }

    async connect(options = {}) {
        if (!this.available) throw new Error('当前运行环境不支持 Web MIDI API');
        const force = options.force === true;
        if (this.access && !force) {
            await this.probeInputs();
            this.refresh();
            return true;
        }
        let access = null;
        let lastError = null;
        for (const opts of [{ sysex: true }, { sysex: false }]) {
            try {
                access = await navigator.requestMIDIAccess(opts);
                this.sysex = opts.sysex;
                break;
            } catch (e) {
                lastError = e;
            }
        }
        if (!access) throw lastError || new Error('MIDI 设备访问被拒绝');
        this.access = access;
        this.bound.clear();
        access.onstatechange = () => this.refresh();
        await this.probeInputs();
        this.refresh();
        return true;
    }

    /** 用户点「刷新」时调用：Windows 上新配对的蓝牙 MIDI 常需再次 requestMIDIAccess */
    async rescan() {
        await this.connect({ force: true });
        await new Promise((r) => setTimeout(r, 400));
        await this.probeInputs();
        this.refresh();
        if (this.devices.length === 0) {
            await new Promise((r) => setTimeout(r, 800));
            await this.probeInputs();
            this.refresh();
        }
    }

    async probeInputs() {
        if (!this.access) return;
        const opens = [];
        for (const input of this.access.inputs.values()) {
            if (typeof input.open === 'function') {
                opens.push(Promise.resolve(input.open()).catch(() => {}));
            }
        }
        if (opens.length) await Promise.all(opens);
    }

    refresh() {
        if (!this.access) return;
        const list = [];
        for (const input of this.access.inputs.values()) {
            const idStr = String(input.id || '');
            const dev = {
                id: input.id,
                name: input.name || input.id,
                manufacturer: input.manufacturer || '',
                state: input.state,
                connection: input.connection || 'closed',
                guessBluetooth: BLE_HINTS.test(`${input.name || ''} ${input.manufacturer || ''} ${idStr}`),
            };
            this.bind(input);
            list.push(dev);
        }
        this.devices = list;
        this.onDevices(list);
    }

    bind(input) {
        if (this.bound.get(input.id) === input) return;
        this.bound.set(input.id, input);
        input.onmidimessage = (e) => this.handle(input.id, e.data);
    }

    /** 释放 Web MIDI 输入占用（Windows 上与 WinMM 互斥时使用） */
    releaseInputs() {
        for (const input of this.bound.values()) {
            input.onmidimessage = null;
            if (typeof input.close === 'function') {
                try { input.close(); } catch { /* 忽略 */ }
            }
        }
        this.bound.clear();
    }

    handle(deviceId, data) {
        const route = this.resolveRoute(deviceId);
        const info = routeMidiMessage(this.engine, route, data);
        if (info) this.onActivity(deviceId, info);
    }
}

/**
 * 把一条 MIDI 消息按路由转发到合成器，返回可用于界面高亮的演奏信息。
 * Web MIDI（桌面浏览器 / Android Chrome）与原生插件（Android / iOS）共用该逻辑。
 */
export function routeMidiMessage(engine, route, data) {
    if (!route || !route.enabled || !engine.started) return null;
    const status = data[0];
    if (status >= 0xf0) {
        if (status >= 0xf8) engine.sendMessage(data, 0); // 实时消息直接转发
        return null;
    }
    const type = status & 0xf0;
    const msgChannel = status & 0x0f;
    const offset = route.channel - msgChannel;

    if (type === 0x90 || type === 0x80) {
        const note = data[1];
        const vel = type === 0x80 ? 0 : transformVelocity(data[2], route);
        if (vel > 0) engine.noteOn(route.channel, note, vel);
        else engine.noteOff(route.channel, note);
        return { note, velocity: vel, on: vel > 0 };
    }
    if (type === 0xb0 || type === 0xa0 || type === 0xe0) {
        engine.sendMessage(data, offset);
        return null;
    }
    if (type === 0xc0 && route.allowProgramChange) {
        // 乐器变换默认忽略，避免手柄覆盖应用内分配的乐器
        engine.sendMessage(data, offset);
    }
    return null;
}

export function transformVelocity(vel, route) {
    const gain = route.velocityGain != null ? route.velocityGain : 1;
    const curve = route.velocityCurve || 'linear';
    const x = Math.max(0, Math.min(127, vel)) / 127;
    let v;
    switch (curve) {
        case 'soft':
            v = Math.pow(x, 1.6);
            break;
        case 'hard':
            v = Math.pow(x, 0.6);
            break;
        case 'fixed':
            v = (route.fixedVelocity != null ? route.fixedVelocity : 100) / 127;
            break;
        default:
            v = x;
    }
    return Math.max(1, Math.min(127, Math.round(v * 127 * gain)));
}

export function describeDevice(dev) {
    const tag = dev.guessBluetooth ? '蓝牙' : 'USB/其他';
    return `${dev.name}${dev.manufacturer ? ' · ' + dev.manufacturer : ''} (${tag})`;
}
