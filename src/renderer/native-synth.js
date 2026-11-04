/**
 * 原生合成引擎（Android 安装包）。
 *
 * 发声放在原生层：AAudio（低延迟通路）+ TinySoundFont 渲染 SF2，
 * 避开 WebView 的 WebAudio（部分机型 300~400 ms 深度缓冲），端到端延迟通常 10~20 ms。
 *
 * 对外接口与 SynthEngine 保持一致，界面与路由逻辑无需区分。
 */
import { nativeSynthPlugin, nativePianoBridge } from './platform.js';

/** TinySoundFont 单实例为 16 个 MIDI 通道 */
export const NATIVE_CHANNELS = 16;

export function isNativeSynthAvailable() {
    return !!nativeSynthPlugin();
}

function clampCh(ch) {
    return Math.max(0, Math.min(NATIVE_CHANNELS - 1, ch | 0));
}

export class NativeSynthEngine {
    constructor() {
        this.native = true;
        this.started = false;
        this.running = false;
        this.sampleRate = 0;
        this.bufferFrames = 0;
        this.bufferMs = 0;
        this.burstFrames = 0;
        this.voiceCount = 0;
        this.banks = [];
        /** @type {{ name: string, path?: string, builtin?: boolean }[]} */
        this.bankMeta = [];
        this.presets = [];
        this.masterVolume = 0.9;
        this.voiceCap = 96;
        this.maxChannels = NATIVE_CHANNELS;
        this.createdChannels = NATIVE_CHANNELS;
        this.listeners = new Map();
        this.startError = null;
        this.pollTimer = null;
    }

    on(name, fn) {
        this.listeners.set(name, fn);
    }

    emit(name, payload) {
        const fn = this.listeners.get(name);
        if (fn) fn(payload);
    }

    /** 顶栏：HAL burst 周期（随设备变化），非整段 AAudio 队列 */
    get latencyMs() {
        const rate = this.sampleRate || 48000;
        if (this.burstFrames > 0 && rate > 0) {
            return Math.max(1, Math.round((this.burstFrames * 1000) / rate));
        }
        return this.bufferMs || 0;
    }

    /** 实际 AAudio 输出队列长度 */
    get outputBufferMs() {
        return this.bufferMs || 0;
    }

    get burstMs() {
        return this.latencyMs;
    }

    get latencyInfo() {
        const rate = this.sampleRate || 48000;
        return {
            base: this.burstFrames / rate,
            output: this.bufferMs / 1000,
        };
    }

    get lowLatency() {
        return true;
    }

    /* ------------------------------ 启动 ------------------------------ */

    async start() {
        const p = nativeSynthPlugin();
        if (!p) throw new Error('未找到原生合成插件（SynthBridge）');
        if (this.started) return;

        const bank = await p.loadBank({});
        if (!bank || !bank.ok) throw new Error('原生音源载入失败（未找到内置 SF2）');

        const res = await p.start();
        if (!res || !res.running) {
            throw new Error('原生音频输出未启动（AAudio 不可用或被占用）');
        }
        this.sampleRate = res.sampleRate || 0;
        this.bufferFrames = res.bufferFrames || 0;
        this.burstFrames = res.burstFrames || 0;
        this.bufferMs = res.bufferMs || 0;
        this.started = true;
        this.running = true;

        const label = bank.path ? bank.path.split('/').pop() : '内置音源';
        this.bankMeta = [{ name: label, path: bank.path || '', builtin: true }];
        this.syncBankIds();
        this.emit('banks', this.banks);

        this.emit('started');
        this.pollTimer = setInterval(() => this.refreshStatus(), 500);
        setTimeout(() => {
            this.refreshPresets().catch(() => {});
        }, 0);
    }

    async refreshPresets() {
        const p = nativeSynthPlugin();
        if (!p) return;
        const res = await p.getPresets();
        this.presets = res.presets || [];
        this.emit('presets', this.presets);
    }

    async refreshStatus() {
        const p = nativeSynthPlugin();
        if (!p || !this.started) return;
        try {
            const info = await p.getInfo();
            this.voiceCount = info.voices || 0;
            this.running = !!info.running;
            if (info.sampleRate) this.sampleRate = info.sampleRate;
            if (info.burstFrames) this.burstFrames = info.burstFrames;
            if (info.bufferFrames) this.bufferFrames = info.bufferFrames;
            this.bufferMs = info.bufferMs ?? this.bufferMs;
        } catch {
            /* 忽略 */
        }
    }

    /* ------------------------------ 音源 ------------------------------ */

    syncBankIds() {
        this.banks = this.bankMeta.map((m, i) => ({
            id: `native${i}`,
            name: m.name,
            builtin: !!m.builtin,
        }));
    }

    /** 原生层按文件路径追加音源（可多个并存，与 PC 一致） */
    async addBank(arrayBuffer, name) {
        if (typeof arrayBuffer !== 'string') {
            throw new Error('原生合成模式不支持从内存载入音源');
        }
        const p = nativeSynthPlugin();
        const res = await p.loadBank({ path: arrayBuffer });
        if (!res || !res.ok) throw new Error('原生音源载入失败');
        this.bankMeta.push({ name, path: arrayBuffer, builtin: false });
        this.syncBankIds();
        this.emit('banks', this.banks);
        await this.refreshPresets();
        const idx = typeof res.bankIndex === 'number' ? res.bankIndex : this.bankMeta.length - 1;
        return `native${idx}`;
    }

    async removeBank(id) {
        if (this.bankMeta.length <= 1) return false;
        const m = String(id).match(/^native(\d+)$/);
        if (!m) return false;
        const index = parseInt(m[1], 10);
        const p = nativeSynthPlugin();
        if (!p || !p.removeBank) return false;
        const res = await p.removeBank({ index });
        if (!res || !res.ok) return false;
        this.bankMeta.splice(index, 1);
        this.syncBankIds();
        this.emit('banks', this.banks);
        await this.refreshPresets();
        return true;
    }

    async setBankOrder(ids) {
        const p = nativeSynthPlugin();
        if (!p || !p.setBankOrder || !ids.length) return;
        const order = ids.map((id) => {
            const m = String(id).match(/^native(\d+)$/);
            return m ? parseInt(m[1], 10) : 0;
        });
        await p.setBankOrder({ order: JSON.stringify(order) });
        await this.refreshPresets();
    }

    /* ------------------------------ 参数 ------------------------------ */

    setMasterVolume(v) {
        this.masterVolume = v;
        const p = nativeSynthPlugin();
        if (p) p.setMasterVolume({ volume: v }).catch(() => {});
    }

    setVoiceCap(n) {
        this.voiceCap = n;
        const p = nativeSynthPlugin();
        if (p) p.setVoiceCap({ cap: n }).catch(() => {});
    }

    setReverb(wet) {
        const p = nativeSynthPlugin();
        if (p) p.setReverb({ wet }).catch(() => {});
    }

    ensureChannels(count) {
        this.createdChannels = Math.min(NATIVE_CHANNELS, Math.max(this.createdChannels, count));
    }

    /** 把一条设备路由的参数写入原生通道 */
    applyRoute(route) {
        const p = nativeSynthPlugin();
        if (!p) return;
        const ch = clampCh(route.channel);
        this.ensureChannels(ch + 1);
        const program = route.isDrum ? route.drumProgram : route.program;
        let bankIndex = 0;
        if (route.soundBankId) {
            const hit = String(route.soundBankId).match(/^native(\d+)$/);
            if (hit) bankIndex = parseInt(hit[1], 10);
        }
        p.setChannel({
            channel: ch,
            bankIndex,
            program,
            isDrum: !!route.isDrum,
            bank: ((route.bankMSB || 0) << 7) | (route.bankLSB || 0),
            volume: route.muted ? 0 : route.volume,
            pan: route.pan,
        }).catch(() => {});
    }

    /** 下发路由表：原生 MIDI 插件据此直接发声，不再绕 WebView */
    setRoutes(routes) {
        const p = nativeSynthPlugin();
        if (!p) return;
        const list = routes.map((r) => ({
            deviceId: r.deviceId,
            mac: r.deviceMac || '',
            mac: r.deviceMac || '',
            channel: clampCh(r.channel),
            transpose: r.transpose,
            velocityGain: r.velocityGain,
            velocityCurve: r.velocityCurve,
            muted: !!r.muted,
            enabled: r.enabled !== false,
            allowProgramChange: !!r.allowProgramChange,
        }));
        p.setRoutes({ routes: JSON.stringify(list) }).catch(() => {});
        let wet = 0;
        let n = 0;
        for (const r of routes) {
            if (r.muted) continue;
            wet += r.reverb || 0;
            n++;
        }
        p.setReverb({ wet: n ? Math.min(1, wet / n) : 0 }).catch(() => {});
    }

    /* ------------------------------ 演奏 ------------------------------ */

    noteOn(channel, note, velocity) {
        const ch = clampCh(channel);
        const n = note | 0;
        const vel = velocity | 0;
        const fast = nativePianoBridge();
        if (fast) {
            try {
                fast.noteOn(ch, n, vel);
                return;
            } catch { /* 回退 Capacitor */ }
        }
        const p = nativeSynthPlugin();
        if (p) p.noteOn({ channel: ch, note: n, velocity: vel }).catch(() => {});
    }

    noteOff(channel, note) {
        const ch = clampCh(channel);
        const n = note | 0;
        const fast = nativePianoBridge();
        if (fast) {
            try {
                fast.noteOff(ch, n);
                return;
            } catch { /* 回退 */ }
        }
        const p = nativeSynthPlugin();
        if (p) p.noteOff({ channel: ch, note: n }).catch(() => {});
    }

    /** 转发原始 MIDI 消息（键盘/滑条等场景使用） */
    sendMessage(bytes, channelOffset = 0) {
        const p = nativeSynthPlugin();
        if (!p || !bytes || !bytes.length) return;
        const status = bytes[0];
        if (status >= 0xf0) return;
        const type = status & 0xf0;
        const ch = clampCh((status & 0x0f) + channelOffset);
        if ((type === 0x90 || type === 0x80) && bytes.length >= 3) {
            const vel = type === 0x80 ? 0 : bytes[2];
            if (vel > 0) this.noteOn(ch, bytes[1], vel);
            else this.noteOff(ch, bytes[1]);
            return;
        }
        if (type === 0xb0 && bytes.length >= 3) {
            p.controlChange({ channel: ch, cc: bytes[1], value: bytes[2] }).catch(() => {});
            return;
        }
        if (type === 0xe0 && bytes.length >= 3) {
            p.pitchBend({ channel: ch, value: ((bytes[2] & 0x7f) << 7) | (bytes[1] & 0x7f) }).catch(() => {});
        }
    }

    stopAll() {
        const p = nativeSynthPlugin();
        if (p) p.panic().catch(() => {});
    }

    reset() {
        this.stopAll();
    }
}
