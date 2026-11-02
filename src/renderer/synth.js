/**
 * 合成引擎：封装 spessasynth_lib 的 WorkletSynthesizer。
 * 负责音源（SF2/SF3/DLS）管理、通道分配、乐器切换与 MIDI 消息转发。
 */
import { WorkletSynthesizer } from 'spessasynth_lib';
import { getProcessorCode } from './platform.js';

export const DEFAULT_CHANNELS = 16;

/** 默认被屏蔽的控制器：音色库选择、声像、效果发送由本应用统一管理 */
const BLOCKED_CC = new Set([0, 32, 10, 91, 93]);

export class SynthEngine {
    constructor() {
        this.ctx = null;
        this.synth = null;
        this.master = null;
        this.analyser = null;
        this.banks = [];
        this.presets = [];
        this.createdChannels = DEFAULT_CHANNELS;
        this.masterVolume = 0.9;
        this.lowLatency = false;
        this.bankSeq = 0;
        this.listeners = new Map();
        this.startError = null;
    }

    on(name, fn) {
        this.listeners.set(name, fn);
    }

    emit(name, payload) {
        const fn = this.listeners.get(name);
        if (fn) fn(payload);
    }

    get started() {
        return !!this.synth;
    }

    get running() {
        return !!this.ctx && this.ctx.state === 'running';
    }

    get sampleRate() {
        return this.ctx ? this.ctx.sampleRate : 0;
    }

    get latencyMs() {
        return Math.round(this.latencySec * 1000);
    }

    get latencySec() {
        if (!this.ctx) return 0;
        const l = this.ctx.outputLatency || this.ctx.baseLatency || 0;
        return l;
    }

    get latencyInfo() {
        if (!this.ctx) return { base: 0, output: 0 };
        return {
            base: this.ctx.baseLatency || 0,
            output: this.ctx.outputLatency || 0,
        };
    }

    get voiceCount() {
        return this.synth ? this.synth.voiceCount || 0 : 0;
    }

    /** 初始化 AudioContext 与 AudioWorklet（需要用户手势） */
    async start(opts = {}) {
        if (this.synth) {
            if (this.ctx.state !== 'running') await this.ctx.resume();
            return;
        }
        // 低延迟模式请求最小音频缓冲（移动端 WebView 默认常走 400ms 级的深度缓冲）
        const latencyHint = opts.lowLatency === false ? 'interactive' : 0;
        const ctxOpts = { latencyHint };
        const ctx = new (window.AudioContext || window.webkitAudioContext)(ctxOpts);
        this.ctx = ctx;
        this.lowLatency = latencyHint === 0;
        const code = await getProcessorCode();
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        this.synth = new WorkletSynthesizer(ctx, { eventsEnabled: true, convolverMode: false });
        // 音源尚未载入时，通道初始化会产生告警，先静默
        this.synth.setLogLevel(false, false, false);
        this.master = ctx.createGain();
        this.master.gain.value = this.masterVolume;
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.synth.connect(this.master);
        this.master.connect(this.analyser);
        this.analyser.connect(ctx.destination);

        this.synth.eventHandler.addEvent('presetListChange', 'app', () => {
            this.presets = [...(this.synth.presetList || [])];
            this.emit('presets', this.presets);
        });
        this.synth.eventHandler.addEvent('soundBankError', 'app', (err) => {
            this.emit('bankError', err);
        });

        await this.synth.isReady;
        await ctx.resume();
        this.synth.setLogLevel(false, true, false);
        this.presets = [...(this.synth.presetList || [])];
        this.emit('presets', this.presets);
        this.emit('started');
    }

    /** 添加音源（SF2/SF3/DLS） */
    async addBank(arrayBuffer, name) {
        const id = `bank${++this.bankSeq}`;
        await this.synth.soundBankManager.addSoundBank(arrayBuffer, id);
        this.banks.push({ id, name });
        this.presets = [...(this.synth.presetList || [])];
        this.emit('banks', this.banks);
        this.emit('presets', this.presets);
        return id;
    }

    async removeBank(id) {
        if (this.banks.length <= 1) return false;
        await this.synth.soundBankManager.deleteSoundBank(id);
        this.banks = this.banks.filter((b) => b.id !== id);
        this.presets = [...(this.synth.presetList || [])];
        this.emit('banks', this.banks);
        this.emit('presets', this.presets);
        return true;
    }

    setBankOrder(ids) {
        this.synth.soundBankManager.priorityOrder = ids;
    }

    setMasterVolume(v) {
        this.masterVolume = v;
        if (this.master) this.master.gain.value = v;
    }

    setVoiceCap(n) {
        if (!this.synth) return;
        this.synth.setSystemParameter('voiceCap', n);
    }

    /** 扩展可用 MIDI 通道，支持超过 16 个手柄同时演奏 */
    ensureChannels(count) {
        while (this.createdChannels < count) {
            this.synth.addNewChannel();
            this.createdChannels++;
        }
    }

    /** 把一条「设备路由」的参数写入合成器通道 */
    applyRoute(route) {
        if (!this.synth) return;
        this.ensureChannels(route.channel + 1);
        const ch = this.synth.midiChannels[route.channel];
        if (!ch) return;
        ch.setSystemParameter('gain', route.volume);
        ch.setSystemParameter('pan', route.pan);
        ch.setSystemParameter('isMuted', !!route.muted);
        ch.setSystemParameter('keyShift', route.isDrum ? 0 : route.transpose || 0);
        ch.setSystemParameter('fineTune', route.fineTune || 0);
        ch.setDrums(!!route.isDrum);
        if (route.isDrum) {
            this.synth.programChange(route.channel, route.drumProgram || 0);
        } else {
            this.synth.controllerChange(route.channel, 0, route.bankMSB || 0);
            this.synth.controllerChange(route.channel, 32, route.bankLSB || 0);
            this.synth.programChange(route.channel, route.program || 0);
        }
        this.synth.controllerChange(route.channel, 91, Math.round((route.reverb ?? 0.3) * 127));
        this.synth.controllerChange(route.channel, 93, Math.round((route.chorus ?? 0.15) * 127));
    }

    noteOn(channel, note, velocity) {
        this.synth?.noteOn(channel, clampNote(note), clampVel(velocity));
    }

    noteOff(channel, note) {
        this.synth?.noteOff(channel, clampNote(note));
    }

    /** 转发原始 MIDI 消息，channelOffset 用于把不同手柄映射到不同通道 */
    sendMessage(bytes, channelOffset = 0) {
        if (!this.synth) return;
        const status = bytes[0];
        if (status < 0xf0) {
            const type = status & 0xf0;
            if (type === 0xb0 && BLOCKED_CC.has(bytes[1])) return;
            if (type === 0xc0 || type === 0xd0) return; // 程序变换/触后由应用统一管理
        }
        this.synth.sendMessage(bytes, channelOffset);
    }

    controllerChange(channel, cc, value) {
        this.synth?.controllerChange(channel, cc, clamp127(value));
    }

    pitchWheel(channel, value) {
        this.synth?.pitchWheel(channel, value);
    }

    stopAll() {
        this.synth?.stopAll();
    }

    reset() {
        this.synth?.reset();
    }
}

function clampNote(n) {
    return Math.max(0, Math.min(127, Math.round(n)));
}

function clampVel(v) {
    return Math.max(1, Math.min(127, Math.round(v)));
}

function clamp127(v) {
    return Math.max(0, Math.min(127, Math.round(v)));
}
