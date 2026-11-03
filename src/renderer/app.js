/**
 * 应用主逻辑：界面渲染、设备-乐器映射、配置持久化。
 */
import { NativeSynthEngine, isNativeSynthAvailable } from './native-synth.js';
import { MidiHub } from './midi.js';
import { NativeMidiHub, isNativeMidiAvailable } from './native-midi.js';
import { VirtualKeyboard } from './keyboard.js';
import {
    GM_PROGRAMS, drumKitChinese, noteName, noteNameOnKey, presetDisplayName, programLabel,
} from './gm.js';
import { getBuiltinSoundfont, openSoundfont, loadSoundfontPaths, storeGet, storeSet, getInfo, isMobile, isElectron, keepAwake, nativePianoBridge } from './platform.js';
import { initLayout, tierFromWidth, scheduleSyncJianpuPianoMetrics } from './layout.js';
import {
    dedupeDevices,
    deviceMac,
    normalizeMac,
    macFromDeviceId,
    applyRouteProfile,
    snapshotRouteProfile,
    isMidiNamedDevice,
    isBluetoothMidiEntry,
    isMidiDeviceOnline,
} from './device-id.js';

const VIRTUAL_KEY = 'virtual:keyboard';

const state = {
    routes: {},
    order: [],
    /** 按蓝牙 MAC 保存的手柄映射（断开后仍保留） */
    deviceProfiles: {},
    master: { volume: 0.9, voiceCap: 160, lowLatency: true },
    keyboardEnabled: true,
    selected: null,
    midiReady: false,
};

/** WebAudio + spessasynth 仅在桌面/回退时按需加载（Android 原生包首屏不下载 ~1.3MB） */
let webSynthModule = null;
async function createWebSynthEngine() {
    if (!webSynthModule) webSynthModule = await import('./synth.js');
    return new webSynthModule.SynthEngine();
}

let engine;
let hub;
let vkb;
let MAX_CHANNELS = 32;

/** 引擎切换（原生合成不可用时回退） */
function swapEngine(next) {
    engine = next;
    MAX_CHANNELS = next.maxChannels || 32;
    if (hub) hub.engine = next;
    if (vkb) vkb.engine = next;
}

async function initRuntime() {
    if (isNativeSynthAvailable()) {
        engine = new NativeSynthEngine();
    } else {
        engine = await createWebSynthEngine();
    }
    MAX_CHANNELS = engine.maxChannels || 32;
    hub = isNativeMidiAvailable() ? new NativeMidiHub(engine) : new MidiHub(engine);
    vkb = new VirtualKeyboard(engine);
}

const el = (id) => document.getElementById(id);
const dom = {};

function log(msg, kind = 'info') {
    const box = dom.log;
    if (!box) return;
    const line = document.createElement('div');
    line.className = `log-line log-${kind}`;
    line.textContent = msg;
    box.prepend(line);
    while (box.childElementCount > 60) box.lastElementChild.remove();
}

function defaultRoute(key, name, kind, channel) {
    return {
        key,
        name,
        kind,
        deviceId: kind === 'midi' ? '' : '',
        deviceMac: '',
        label: '',
        enabled: true,
        channel,
        program: 0,
        bankMSB: 0,
        bankLSB: 0,
        isDrum: false,
        drumProgram: 0,
        volume: 1,
        pan: 0,
        reverb: 0.3,
        chorus: 0.15,
        transpose: 0,
        velocityGain: 1,
        velocityCurve: 'linear',
        allowProgramChange: false,
        muted: false,
        solo: false,
    };
}

function usedChannels(excludeKey) {
    const set = new Set();
    for (const r of Object.values(state.routes)) {
        if (r.key !== excludeKey) set.add(r.channel);
    }
    return set;
}

function pickChannel(route) {
    if (route && route.channel != null) return route.channel;
    const used = usedChannels(route && route.key);
    for (let c = 0; c < MAX_CHANNELS; c++) {
        if (c === 9) continue; // 保留给打击乐
        if (!used.has(c)) return c;
    }
    for (let c = 0; c < MAX_CHANNELS; c++) if (!used.has(c)) return c;
    return 0;
}

function effectiveMuted(route) {
    const anySolo = Object.values(state.routes).some((r) => r.solo);
    return route.muted || (anySolo && !route.solo);
}

function applyRoute(route) {
    if (!engine.started) return;
    route.muted = effectiveMuted(route);
    engine.applyRoute(route);
    pushRoutesToNative();
}

/** 原生合成时把路由表下发给原生层，MIDI 插件据此直接发声（不绕 WebView） */
let routePushTimer = null;
function pushRoutesToNative() {
    if (!engine.native || !engine.setRoutes) return;
    clearTimeout(routePushTimer);
    routePushTimer = setTimeout(() => {
        engine.setRoutes(Object.values(state.routes).filter((r) => r.kind === 'midi' && r.deviceId));
    }, 60);
}

function applyAllRoutes() {
    for (const r of Object.values(state.routes)) applyRoute(r);
}

/* ------------------------------ 设备同步 ------------------------------ */

function persistDeviceProfilesFromRoutes() {
    for (const r of Object.values(state.routes)) {
        if (r.kind === 'midi' && r.deviceMac) {
            state.deviceProfiles[r.deviceMac] = snapshotRouteProfile(r);
        }
    }
}

function findMidiRouteByMac(mac) {
    if (!mac) return null;
    const norm = normalizeMac(mac);
    for (const r of Object.values(state.routes)) {
        if (r.kind === 'midi' && normalizeMac(r.deviceMac) === norm) return r;
    }
    return null;
}

function routeKeyForDev(dev) {
    const mac = deviceMac(dev);
    return mac ? `midi:mac:${mac}` : `midi:${dev.id}`;
}

function isSameMidiRoute(r, key, id, mac) {
    if (!r || r.kind !== 'midi') return false;
    if (r.key === key || r.key === `midi:${id}` || r.deviceId === id) return true;
    if (!mac) return false;
    const rm = normalizeMac(r.deviceMac) || macFromDeviceId(r.deviceId) || macFromDeviceId(r.key);
    return rm === mac;
}

let syncDevicesTimer = 0;

/**
 * @param {unknown[]} list
 * @param {{ markOfflineWhenEmpty?: boolean, immediate?: boolean }} [opts]
 */
function syncDevices(list, opts = {}) {
    const run = () => {
        let changed = false;
        const raw = Array.isArray(list) ? list : [];
        const devices = dedupeDevices(raw);
        /** 仅「当前在线」设备参与在线判定，断开/空列表也要标离线 */
        const seenOnline = new Set();

        for (const dev of devices) {
            if (isBluetoothMidiEntry(dev) && !isMidiNamedDevice(dev)) continue;
            const id = String(dev.id);
            const mac = deviceMac(dev);
            const key = routeKeyForDev(dev);
            const online = isMidiDeviceOnline(dev);
            if (online) {
                seenOnline.add(key);
                seenOnline.add(`midi:${id}`);
            }

            for (const k of [...state.order]) {
                if (k === key) continue;
                const r = state.routes[k];
                if (!isSameMidiRoute(r, key, id, mac)) continue;
                if (mac) {
                    state.deviceProfiles[mac] = {
                        ...state.deviceProfiles[mac],
                        ...snapshotRouteProfile(r),
                    };
                }
                delete state.routes[k];
                state.order = state.order.filter((x) => x !== k);
                changed = true;
            }

            if (!state.routes[key]) {
                const route = defaultRoute(key, dev.name, 'midi', pickChannel(null));
                if (mac && state.deviceProfiles[mac]) applyRouteProfile(route, state.deviceProfiles[mac]);
                state.routes[key] = route;
                if (!state.order.includes(key)) state.order.push(key);
                changed = true;
                log(`检测到 MIDI 设备：${dev.name}${dev.guessBluetooth ? '（蓝牙）' : ''}${mac ? ` · ${mac}` : ''}`, 'ok');
            }

            const route = state.routes[key];
            route.key = key;
            route.name = dev.name;
            route.deviceId = id;
            route.deviceMac = mac || route.deviceMac || '';
            route.guessBluetooth = dev.guessBluetooth;
            route.online = online;
        }

        for (const r of Object.values(state.routes)) {
            if (r.kind !== 'midi') continue;
            const mac = normalizeMac(r.deviceMac) || macFromDeviceId(r.deviceId);
            let on = seenOnline.has(r.key) || (r.deviceId && seenOnline.has(`midi:${r.deviceId}`));
            if (!on && mac) {
                on = devices.some((d) => isMidiDeviceOnline(d) && deviceMac(d) === mac);
            }
            if (r.online !== on) changed = true;
            r.online = on;
            if (!on && r.deviceMac) state.deviceProfiles[r.deviceMac] = snapshotRouteProfile(r);
        }

        if (!state.routes[VIRTUAL_KEY]) {
            state.routes[VIRTUAL_KEY] = defaultRoute(VIRTUAL_KEY, '电脑键盘（虚拟手柄）', 'virtual', pickChannel(null));
            state.order.push(VIRTUAL_KEY);
            changed = true;
        }
        state.routes[VIRTUAL_KEY].online = true;

        if (changed) {
            persistDeviceProfilesFromRoutes();
            saveConfig();
            pushRoutesToNative();
        }
        renderDevices();
        renderPiano();
    };

    if (opts.immediate) {
        run();
        return;
    }
    clearTimeout(syncDevicesTimer);
    syncDevicesTimer = setTimeout(run, 100);
}

function resolveRouteForDeviceId(deviceId) {
    const id = String(deviceId);
    for (const r of Object.values(state.routes)) {
        if (r.kind === 'midi' && r.deviceId === id) return r;
    }
    const mac = macFromDeviceId(id);
    if (mac) return findMidiRouteByMac(mac);
    return state.routes[`midi:${id}`] || state.routes[`midi:mac:${mac}`] || null;
}

/* ------------------------------ 界面渲染 ------------------------------ */

function renderDevices() {
    const wrap = dom.devices;
    if (!wrap) return;
    wrap.innerHTML = '';
    const keys = state.order.filter((k) => state.routes[k]);
    for (const key of keys) {
        const r = state.routes[key];
        const card = document.createElement('div');
        card.className = `card${r.online === false ? ' offline' : ''}${state.selected === key ? ' selected' : ''}`;
        card.dataset.key = key;
        card.innerHTML = `
            <div class="card-head">
                <div class="card-title">
                    <span class="dot ${r.online === false ? 'dot-off' : 'dot-on'}"></span>
                    <input class="label-input" value="${escapeHtml(r.label || r.name)}" title="自定义名称" />
                    ${r.kind === 'virtual' ? '<span class="tag">虚拟</span>' : ''}
                    ${r.guessBluetooth || r.deviceMac ? '<span class="tag tag-ble">蓝牙</span>' : ''}
                    ${r.online === false ? '<span class="tag tag-off">已断开</span>' : ''}
                </div>
                <div class="card-actions">
                    <label class="switch"><input type="checkbox" data-field="enabled" ${r.enabled ? 'checked' : ''}><span>启用</span></label>
                    <button class="mini" data-act="test">试奏</button>
                    <button class="mini" data-act="select">选中</button>
                </div>
            </div>
            <div class="card-body">
                ${rowSelect('通道', 'channel', channelOptions(r.channel))}
                ${rowInstrument(r)}
                <div class="row"><label>音量</label><input type="range" data-field="volume" min="0" max="1.5" step="0.01" value="${r.volume}"><span class="val">${Math.round(r.volume * 100)}</span></div>
                <div class="row"><label>声像</label><input type="range" data-field="pan" min="-1" max="1" step="0.02" value="${r.pan}"><span class="val">${panLabel(r.pan)}</span></div>
                <div class="row"><label>混响</label><input type="range" data-field="reverb" min="0" max="1" step="0.01" value="${r.reverb}"><span class="val">${Math.round(r.reverb * 100)}</span></div>
                <div class="row"><label>合唱</label><input type="range" data-field="chorus" min="0" max="1" step="0.01" value="${r.chorus}"><span class="val">${Math.round(r.chorus * 100)}</span></div>
                <div class="row"><label>移调</label><input type="range" data-field="transpose" min="-24" max="24" step="1" value="${r.transpose}"><span class="val">${r.transpose > 0 ? '+' : ''}${r.transpose}</span></div>
                <div class="row"><label>力度</label><input type="range" data-field="velocityGain" min="0.2" max="2" step="0.05" value="${r.velocityGain}"><span class="val">×${r.velocityGain.toFixed(2)}</span></div>
                <div class="row">
                    <label>力度曲线</label>
                    <select data-field="velocityCurve">
                        ${['linear', 'soft', 'hard', 'fixed'].map((c) => `<option value="${c}" ${r.velocityCurve === c ? 'selected' : ''}>${{ linear: '线性', soft: '柔和', hard: '强劲', fixed: '固定' }[c]}</option>`).join('')}
                    </select>
                </div>
                <div class="row row-toggles">
                    <label class="chk"><input type="checkbox" data-field="muted" ${r.muted ? 'checked' : ''}>静音</label>
                    <label class="chk"><input type="checkbox" data-field="solo" ${r.solo ? 'checked' : ''}>独奏</label>
                    <label class="chk" title="允许手柄自身切换音色"><input type="checkbox" data-field="allowProgramChange" ${r.allowProgramChange ? 'checked' : ''}>手柄可换音色</label>
                </div>
            </div>
            <div class="card-foot">
                <span class="hint">通道 ${r.channel + 1} · ${r.isDrum ? `Drums（${drumKitChinese(r.drumProgram)}）` : programLabel(r.program)}</span>
                <span class="activity" data-activity></span>
            </div>`;
        wireCard(card, r);
        wrap.appendChild(card);
    }
    if (!keys.length) {
        wrap.innerHTML = '<div class="empty">尚未检测到 MIDI 手柄。请先在系统蓝牙中配对手柄，再点击下方「刷新手柄列表」。</div>';
    }
    const online = keys.filter((k) => state.routes[k].online !== false).length;
    if (dom.devCount) {
        dom.devCount.textContent = String(online);
        dom.devCount.classList.toggle('show', online > 0);
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function panLabel(p) {
    if (Math.abs(p) < 0.02) return 'C';
    return `${p < 0 ? 'L' : 'R'}${Math.round(Math.abs(p) * 100)}`;
}

function channelOptions(current) {
    let opts = '';
    for (let c = 0; c < MAX_CHANNELS; c++) {
        const mark = c === 9 ? '（打击乐通道）' : c >= 16 ? '（扩展）' : '';
        opts += `<option value="${c}" ${c === current ? 'selected' : ''}>${c + 1}${mark}</option>`;
    }
    return opts;
}

function rowSelect(label, field, options) {
    return `<div class="row"><label>${label}</label><select data-field="${field}">${options}</select></div>`;
}

function rowInstrument(r) {
    const melodic = engine.presets.filter((p) => !p.isDrum);
    const drums = engine.presets.filter((p) => p.isDrum);
    const drumChecked = r.isDrum ? 'checked' : '';
    let opts = '';
    if (melodic.length) {
        const main = melodic.filter((p) => p.bankMSB === 0).sort((a, b) => a.program - b.program);
        const other = melodic.filter((p) => p.bankMSB !== 0).sort((a, b) => a.bankMSB - b.bankMSB || a.program - b.program);
        if (main.length) opts += `<optgroup label="标准音色">${main.map(presetOption(r, false)).join('')}</optgroup>`;
        if (other.length) opts += `<optgroup label="扩展音色库">${other.map((p) => presetOption(r, false)(p)).join('')}</optgroup>`;
    } else {
        opts = GM_PROGRAMS.map((_, i) => `<option value="0|0|${i}">${programLabel(i)}</option>`).join('');
    }
    let drumOpts = '';
    if (drums.length) {
        drumOpts = drums.sort((a, b) => a.bankMSB - b.bankMSB || a.program - b.program).map((p) => presetOption(r, true)(p)).join('');
    }
    return `
        <div class="row">
            <label>乐器</label>
            <select data-field="instrument">${opts}</select>
        </div>
        <div class="row">
            <label>鼓组</label>
            <select data-field="drumProgram">${drumOpts || '<option value="0">标准鼓组</option>'}</select>
            <label class="chk inline"><input type="checkbox" data-field="isDrum" ${drumChecked}>打击乐</label>
        </div>`;
}

function presetOption(route, isDrum) {
    return (p) => {
        const prefix = p.bankId ? `${p.bankId}|` : '';
        const value = `${prefix}${p.bankMSB}|${p.bankLSB}|${p.program}`;
        const bankMatch = !p.bankId || route.soundBankId === p.bankId;
        const sel = bankMatch && !isDrum && !route.isDrum && route.bankMSB === p.bankMSB && route.bankLSB === p.bankLSB && route.program === p.program;
        const selD = bankMatch && isDrum && route.isDrum && route.drumProgram === p.program && route.bankMSB === p.bankMSB;
        let label = presetDisplayName(p);
        if (p.bankId && engine.banks.length > 1) {
            const bank = engine.banks.find((b) => b.id === p.bankId)?.name || p.bankId;
            label = `[${bank}] ${label}`;
        }
        return `<option value="${value}" ${sel || selD ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    };
}

function applyInstrumentValue(route, raw) {
    const parts = raw.split('|');
    if (parts.length >= 4 && /^native\d+$/.test(parts[0])) {
        route.soundBankId = parts[0];
        route.bankMSB = Number(parts[1]);
        route.bankLSB = Number(parts[2]);
        route.program = Number(parts[3]);
        route.isDrum = false;
        return;
    }
    route.soundBankId = undefined;
    const [msb, lsb, prog] = parts.map(Number);
    route.bankMSB = msb;
    route.bankLSB = lsb;
    route.program = prog;
    route.isDrum = false;
}

function applyDrumValue(route, raw) {
    const parts = raw.split('|');
    if (parts.length >= 4 && /^native\d+$/.test(parts[0])) {
        route.soundBankId = parts[0];
        route.bankMSB = Number(parts[1]);
        route.bankLSB = Number(parts[2]);
        route.drumProgram = Number(parts[3]);
        route.isDrum = true;
        return;
    }
    route.soundBankId = undefined;
    const [msb, lsb, prog] = parts.map(Number);
    route.bankMSB = msb;
    route.bankLSB = lsb;
    route.drumProgram = prog;
    route.isDrum = true;
}

function wireCard(card, route) {
    card.querySelectorAll('[data-field]').forEach((input) => {
        const field = input.dataset.field;
        input.addEventListener('input', () => {
            if (input.type === 'checkbox') route[field] = input.checked;
            else if (field === 'instrument') applyInstrumentValue(route, input.value);
            else if (field === 'drumProgram') applyDrumValue(route, input.value);
            else if (field === 'channel') route.channel = Number(input.value);
            else if (typeof route[field] === 'number' || ['volume', 'pan', 'reverb', 'chorus', 'transpose', 'velocityGain'].includes(field)) {
                route[field] = Number(input.value);
            } else route[field] = input.value;
            if (field === 'isDrum') renderDevices();
            applyAllRoutes();
            saveConfig();
            refreshCardValues(card, route);
        });
        input.addEventListener('change', () => {
            if (field === 'isDrum') renderDevices();
        });
    });
    card.querySelector('.label-input').addEventListener('input', (e) => {
        route.label = e.target.value;
        if (route.deviceMac) state.deviceProfiles[route.deviceMac] = snapshotRouteProfile(route);
        saveConfig();
    });
    card.querySelector('[data-act="test"]').addEventListener('click', () => testRoute(route));
    card.querySelector('[data-act="select"]').addEventListener('click', () => {
        state.selected = route.key;
        renderDevices();
        renderPiano();
    });
}

function refreshCardValues(card, route) {
    const vals = card.querySelectorAll('.row .val');
    const map = [Math.round(route.volume * 100), panLabel(route.pan), Math.round(route.reverb * 100), Math.round(route.chorus * 100), (route.transpose > 0 ? '+' : '') + route.transpose, '×' + route.velocityGain.toFixed(2)];
    vals.forEach((v, i) => { if (map[i] != null) v.textContent = map[i]; });
    const foot = card.querySelector('.card-foot .hint');
    if (foot) {
        foot.textContent = route.isDrum
            ? `通道 ${route.channel + 1} · Drums（${drumKitChinese(route.drumProgram)}）`
            : `通道 ${route.channel + 1} · ${programLabel(route.program)}`;
    }
}

function testRoute(route) {
    if (!engine.started) { log('请先启动音频引擎', 'warn'); return; }
    applyRoute(route);
    const base = route.isDrum ? 38 : 60;
    const notes = route.isDrum ? [38, 42, 46, 49] : [60, 64, 67, 72];
    notes.forEach((n, i) => {
        setTimeout(() => {
            engine.noteOn(route.channel, n + (route.isDrum ? 0 : 0), 100);
            flashActivity(route.key, n, 100);
            setTimeout(() => engine.noteOff(route.channel, n), 320);
        }, i * 180);
    });
    void base;
}

function flashActivity(key, note, velocity) {
    const card = dom.devices.querySelector(`.card[data-key="${cssEscape(key)}"]`);
    if (!card) return;
    const badge = card.querySelector('[data-activity]');
    if (badge) {
        badge.textContent = `${noteName(note)} (${velocity})`;
        badge.classList.add('on');
        clearTimeout(badge._t);
        badge._t = setTimeout(() => { badge.textContent = ''; badge.classList.remove('on'); }, 400);
    }
    const dot = card.querySelector('.dot');
    if (dot) {
        dot.classList.add('flash');
        setTimeout(() => dot.classList.remove('flash'), 160);
    }
}

function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
}

/* ------------------------------ 虚拟钢琴 ------------------------------ */

const PIANO_START = 48;
const PIANO_END = 84;
const BLACK_KEYS = [1, 3, 6, 8, 10];

/** 竖屏：三排钢琴（与横屏同款琴键，仅叠成三行）；横屏：单条 */
function pianoLayoutMode() {
    if (typeof document === 'undefined') return 'keyboard';
    return document.documentElement.dataset.orient === 'portrait' ? 'jianpu' : 'keyboard';
}

/** 竖屏三排：每排一个八度 C–B（上 C5 / 中 C4 / 下 C3） */
const PORTRAIT_OCTAVES = [72, 60, 48];
const PIANO_OCT_MIN = -2;
const PIANO_OCT_MAX = 3;
/** 屏幕键盘整体移调（八度）；竖屏三排与横屏条同步 */
let pianoOctaveShift = 0;

function portraitOctaveStarts() {
    const shift = pianoOctaveShift * 12;
    return PORTRAIT_OCTAVES.map((n) => Math.max(0, Math.min(116, n + shift)));
}

function pianoLayoutKey() {
    if (pianoLayoutMode() === 'jianpu') return `jianpu-${pianoOctaveShift}`;
    const [start, end] = pianoKeyboardRange();
    return `kb-${start}-${end}`;
}

/** 横屏钢琴条音域 */
function pianoKeyboardRange() {
    const narrow = typeof window !== 'undefined' && window.innerWidth < 760;
    const [baseStart, baseEnd] = narrow ? [48, 72] : [PIANO_START, PIANO_END];
    const shift = pianoOctaveShift * 12;
    return [
        Math.max(0, Math.min(127, baseStart + shift)),
        Math.max(0, Math.min(127, baseEnd + shift)),
    ];
}

function shiftPianoOctave(delta) {
    const next = Math.max(PIANO_OCT_MIN, Math.min(PIANO_OCT_MAX, pianoOctaveShift + delta));
    if (next === pianoOctaveShift) return;
    pianoOctaveShift = next;
    pianoLayoutCache = '';
    renderPiano();
}

/** @deprecated 保留旧名供外部调试 */
function pianoRange() {
    return pianoKeyboardRange();
}

/** pointerId -> { note, el, routeKey, channel }：支持多点触控与滑奏 */
const pianoActive = new Map();
/** pointerId -> 滑奏延迟 noteOff 的 timer（抬手时需全部 flush，避免余音） */
const pianoGlidePending = new Map();
let pianoBound = false;

function ensureVirtualRoute() {
    if (!state.routes[VIRTUAL_KEY]) {
        state.routes[VIRTUAL_KEY] = defaultRoute(VIRTUAL_KEY, '电脑键盘（虚拟手柄）', 'virtual', pickChannel(null));
        state.order.push(VIRTUAL_KEY);
    }
    state.routes[VIRTUAL_KEY].online = true;
}

/** 未选择设备时回落到虚拟手柄通道，保证屏幕键盘始终能发声 */
function currentPianoRoute() {
    if (state.selected && state.routes[state.selected]) return state.routes[state.selected];
    ensureVirtualRoute();
    return state.routes[VIRTUAL_KEY] || null;
}

function keyElementAt(x, y) {
    const target = document.elementFromPoint(x, y);
    return target && target.closest ? target.closest('.pkey') : null;
}

/** 滑奏时每个音的最短时长：直连 JNI 时可略短，减少拖泥带水 */
function glideNoteMs() {
    return engine?.native && nativePianoBridge() ? 28 : 70;
}

function flushGlidePending(pointerId, includeCurrent = null) {
    const list = pianoGlidePending.get(pointerId);
    if (list) {
        for (const t of list) clearTimeout(t.id);
        pianoGlidePending.delete(pointerId);
        for (const t of list) {
            try { engine.noteOff(t.channel, t.note); } catch { /* 忽略 */ }
        }
    }
    if (includeCurrent) {
        try { engine.noteOff(includeCurrent.channel, includeCurrent.note); } catch { /* 忽略 */ }
    }
}

function scheduleGlideNoteOff(pointerId, channel, note) {
    const id = setTimeout(() => {
        const list = pianoGlidePending.get(pointerId);
        if (list) {
            const i = list.findIndex((t) => t.id === id);
            if (i >= 0) list.splice(i, 1);
            if (!list.length) pianoGlidePending.delete(pointerId);
        }
        try { engine.noteOff(channel, note); } catch { /* 忽略 */ }
    }, glideNoteMs());
    if (!pianoGlidePending.has(pointerId)) pianoGlidePending.set(pointerId, []);
    pianoGlidePending.get(pointerId).push({ id, channel, note });
}

function pianoPress(pointerId, keyEl, velocity = 100) {
    if (!keyEl) return;
    if (!engine.started) {
        // 触摸/点击本身就是用户手势，移动端可直接借它启动音频引擎
        ensureEngine();
        return;
    }
    const route = currentPianoRoute();
    if (!route) return;
    const prev = pianoActive.get(pointerId);
    if (prev && prev.el === keyEl) return;
    if (prev) pianoRelease(pointerId, true); // 滑奏换键：延迟一点再停，保证前一个音听得到
    const note = Number(keyEl.dataset.note);
    // 快速滑回同一音高时会叠第二层 noteOn，旧 noteOff 又被跳过 → 余音嗡嗡
    engine.noteOff(route.channel, note);
    engine.noteOn(route.channel, note, velocity);
    keyEl.classList.add('active');
    pianoActive.set(pointerId, { note, el: keyEl, routeKey: route.key, channel: route.channel });
    flashActivity(route.key, note, velocity);
}

function pianoRelease(pointerId, glide = false) {
    const a = pianoActive.get(pointerId);
    if (!a) return;
    pianoActive.delete(pointerId);
    a.el.classList.remove('active');
    if (glide) scheduleGlideNoteOff(pointerId, a.channel, a.note);
    else flushGlidePending(pointerId, a);
}

function releaseAllPiano() {
    for (const id of [...pianoGlidePending.keys()]) flushGlidePending(id);
    for (const id of [...pianoActive.keys()]) pianoRelease(id);
}

/** pointerId -> 上一次坐标，用于补齐快速滑动时被合并掉的中间点 */
const pianoLastPoint = new Map();

/** 移动到某点：先补采样再落点，避免快速滑动跳音 */
function pianoMoveTo(pointerId, x, y, isFirst = false) {
    const box = dom.piano.getBoundingClientRect();
    const tol = 8;
    if (x < box.left - tol || x > box.right + tol || y < box.top - tol || y > box.bottom + tol) {
        pianoLastPoint.delete(pointerId);
        pianoRelease(pointerId);
        return;
    }
    const keyEl = keyElementAt(x, y);
    if (!keyEl) return; // 琴键之间的缝隙：保持当前音，避免中间断一下
    if (!isFirst) {
        const last = pianoLastPoint.get(pointerId);
        if (last) {
            const dx = x - last.x;
            const dy = y - last.y;
            const steps = Math.min(24, Math.floor(Math.hypot(dx, dy) / 6));
            for (let i = 1; i <= steps; i++) {
                const t = i / (steps + 1);
                const mid = keyElementAt(last.x + dx * t, last.y + dy * t);
                if (mid && mid !== keyEl) pianoPress(pointerId, mid);
            }
        }
    }
    pianoLastPoint.set(pointerId, { x, y });
    pianoPress(pointerId, keyEl);
}

/**
 * 事件绑在琴键容器上：
 * - pointerdown 后捕获指针，pointermove 时按坐标找新琴键，实现鼠标/手指滑奏（轮指）
 * - pointercancel / lostpointercapture 一并释放，避免移动端滚动导致音符卡住
 */
function bindPiano() {
    if (pianoBound) return;
    pianoBound = true;
    const piano = dom.piano;
    piano.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const keyEl = (e.target.closest ? e.target.closest('.pkey') : null) || keyElementAt(e.clientX, e.clientY);
        if (!keyEl) return;
        try { piano.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
        pianoLastPoint.set(e.pointerId, { x: e.clientX, y: e.clientY });
        pianoPress(e.pointerId, keyEl);
    });
    piano.addEventListener('pointermove', (e) => {
        if (!pianoActive.has(e.pointerId)) return;
        // 浏览器会把高频移动合并成一个事件，取回被合并的中间点，避免快速轮指跳音
        let points = [e];
        if (typeof e.getCoalescedEvents === 'function') {
            const raw = e.getCoalescedEvents();
            if (raw && raw.length) points = raw;
        }
        for (const p of points) pianoMoveTo(e.pointerId, p.clientX, p.clientY);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        piano.addEventListener(type, (e) => {
            pianoLastPoint.delete(e.pointerId);
            pianoRelease(e.pointerId);
            if (pianoGlidePending.has(e.pointerId)) flushGlidePending(e.pointerId);
        });
    }
    piano.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', releaseAllPiano);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') releaseAllPiano();
    });
    let lastLayoutKey = pianoLayoutKey();
    const onResize = () => {
        const now = pianoLayoutKey();
        if (now !== lastLayoutKey) {
            lastLayoutKey = now;
            renderPiano();
        }
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => setTimeout(onResize, 200));
}

let pianoLayoutCache = '';

/** 与横屏完全相同的琴键 DOM（白/黑键 + 底部音名角标） */
function appendPianoKeys(container, start, end) {
    const whites = [];
    for (let n = start; n <= end; n++) if (!BLACK_KEYS.includes(n % 12)) whites.push(n);
    const w = 100 / whites.length;
    let whiteIndex = 0;
    for (let n = start; n <= end; n++) {
        const isBlack = BLACK_KEYS.includes(n % 12);
        const key = document.createElement('div');
        key.className = `pkey ${isBlack ? 'black' : 'white'}`;
        key.dataset.note = n;
        key.title = noteName(n);
        if (isBlack) {
            key.style.left = `calc(${whiteIndex * w}% - var(--bw) / 2)`;
        } else {
            whiteIndex++;
        }
        key.innerHTML = `<span class="pk-label">${noteNameOnKey(n)}</span>`;
        container.appendChild(key);
    }
}

function renderPianoKeyboard(piano, start, end) {
    piano.classList.remove('jianpu');
    piano.innerHTML = '';
    appendPianoKeys(piano, start, end);
}

function renderPianoJianpu(piano) {
    piano.classList.add('jianpu');
    piano.innerHTML = '';
    for (const start of portraitOctaveStarts()) {
        const strip = document.createElement('div');
        strip.className = 'piano-bar';
        appendPianoKeys(strip, start, start + 11);
        piano.appendChild(strip);
    }
}

function renderPiano() {
    const piano = dom.piano;
    const layoutKey = pianoLayoutKey();
    if (layoutKey !== pianoLayoutCache) {
        releaseAllPiano();
        pianoLayoutCache = layoutKey;
        if (pianoLayoutMode() === 'jianpu') {
            renderPianoJianpu(piano);
        } else {
            const [start, end] = pianoKeyboardRange();
            renderPianoKeyboard(piano, start, end);
        }
        bindPiano();
    }
    if (pianoLayoutMode() === 'jianpu') {
        scheduleSyncJianpuPianoMetrics();
    }
}

/* ------------------------------ 音源管理 ------------------------------ */

function renderBanks() {
    const list = engine.banks;
    dom.bankList.innerHTML = '';
    list.forEach((b, i) => {
        const item = document.createElement('div');
        item.className = 'bank-item';
        item.innerHTML = `
            <span class="bank-name">${escapeHtml(b.name)}${b.builtin ? ' <span class="tag">内置</span>' : ''}</span>
            <span class="bank-ops">
                <button class="mini" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
                <button class="mini" data-act="down" ${i === list.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="mini danger" data-act="del" ${list.length <= 1 ? 'disabled' : ''}>移除</button>
            </span>`;
        item.querySelector('[data-act="up"]').addEventListener('click', () => moveBank(i, -1));
        item.querySelector('[data-act="down"]').addEventListener('click', () => moveBank(i, 1));
        item.querySelector('[data-act="del"]').addEventListener('click', () => {
            engine.removeBank(b.id).then(() => { renderBanks(); renderDevices(); });
        });
        dom.bankList.appendChild(item);
    });
    dom.bankCount.textContent = `${list.length} 个音源 · ${engine.presets.length} 个可用音色`;
}

async function moveBank(i, dir) {
    const list = [...engine.banks];
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    engine.setBankOrder(list.map((b) => b.id));
    engine.banks = list;
    renderBanks();
}

async function addBankFile(name, arrayBuffer, builtin = false, filePath = '') {
    const payload = engine.native && filePath ? filePath : arrayBuffer;
    const id = await engine.addBank(payload, name);
    const bank = engine.banks.find((b) => b.id === id);
    if (bank) bank.builtin = builtin;
    renderBanks();
    renderDevices();
    applyAllRoutes();
    await saveBankRef({ name, path: filePath }, builtin);
    log(`已载入音源：${name}`, 'ok');
}

async function saveBankRef(ref, builtin) {
    if (builtin || !ref.path) return;
    const refs = (await apiGet('bankRefs')) || [];
    if (!refs.some((r) => r.path === ref.path)) refs.push(ref);
    await apiSet('bankRefs', refs);
}

/* ------------------------------ 配置持久化 ------------------------------ */

let saveTimer = null;
function saveConfig() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        persistDeviceProfilesFromRoutes();
        await apiSet('config', {
            routes: state.routes,
            order: state.order,
            deviceProfiles: state.deviceProfiles,
            master: state.master,
            keyboardEnabled: state.keyboardEnabled,
            selected: state.selected,
        });
    }, 400);
}

async function apiGet(key) {
    try { return await storeGet(key); } catch { return null; }
}

async function apiSet(key, value) {
    try { await storeSet(key, value); } catch { /* 忽略 */ }
}

function importLegacyRouteProfiles(routes) {
    if (!routes) return;
    for (const r of Object.values(routes)) {
        if (!r || r.kind !== 'midi') continue;
        const mac = normalizeMac(r.deviceMac) || macFromDeviceId(r.deviceId) || macFromDeviceId(r.key);
        if (mac) {
            state.deviceProfiles[mac] = {
                ...state.deviceProfiles[mac],
                ...snapshotRouteProfile(r),
            };
        }
    }
}

async function loadConfig() {
    const cfg = await apiGet('config');
    if (!cfg) return;
    if (cfg.routes) state.routes = cfg.routes;
    if (cfg.order) state.order = cfg.order;
    if (cfg.deviceProfiles) state.deviceProfiles = cfg.deviceProfiles;
    importLegacyRouteProfiles(cfg.routes);
    if (cfg.master) state.master = cfg.master;
    if (state.master.lowLatency == null) state.master.lowLatency = true;
    if (cfg.keyboardEnabled != null) state.keyboardEnabled = cfg.keyboardEnabled;
    if (cfg.selected) state.selected = cfg.selected;
}

/* ------------------------------ 启动流程 ------------------------------ */

async function ensureEngine(retry = false) {
    if (engine.started) { if (engine.ctx) await engine.ctx.resume(); return; }
    dom.btnStart.disabled = true;
    dom.btnStart.textContent = '启动中…';
    try {
        await engine.start({ lowLatency: state.master.lowLatency !== false });
        engine.setMasterVolume(state.master.volume);
        engine.setVoiceCap(state.master.voiceCap);
        const info = engine.latencyInfo;
        log(engine.native
            ? `原生合成已启动（AAudio ${engine.sampleRate} Hz，周期约 ${engine.latencyMs} ms，输出队列约 ${engine.outputBufferMs} ms）`
            : `音频引擎已启动（${engine.sampleRate} Hz，缓冲 ${Math.round((info.base || 0) * 1000)} ms / 输出 ${Math.round((info.output || 0) * 1000)} ms${engine.lowLatency ? '，低延迟模式' : ''}）`, 'ok');
        if (engine.native && isMobile() && nativePianoBridge()) {
            log('屏幕钢琴：直连原生发声', 'ok');
        }
        if (engine.native && engine.outputBufferMs >= 60) {
            log(`输出队列 ${engine.outputBufferMs} ms 偏大（周期约 ${engine.latencyMs} ms），可试有线耳机或机身扬声器`, 'warn');
        }
        if (!engine.native) {
            const builtin = await getBuiltinSoundfont();
            if (builtin && builtin.data) {
                const ab = toArrayBuffer(builtin.data);
                await addBankFile(builtin.name || '内置音源', ab, true);
            } else {
                log('未找到内置音源，请通过「载入音源」导入 .sf2/.sf3/.dls 文件', 'warn');
            }
            await restoreExternalBanks();
        }
        applyAllRoutes();
        await connectMidi();
        updateStatus();
        dom.startOverlay.classList.add('hidden');
    } catch (e) {
        // 原生合成不可用（老设备 / 缺 AAudio / 音源缺失）时回退到 WebAudio，保证能发声
        if (!retry && engine.native) {
            log(`原生合成不可用（${e.message}），回退 WebAudio + spessasynth`, 'warn');
            swapEngine(await createWebSynthEngine());
            return ensureEngine(true);
        }
        log(`启动失败：${e.message}`, 'error');
        dom.btnStart.disabled = false;
        dom.btnStart.textContent = '启动音频引擎';
    }
}

async function restoreExternalBanks() {
    const refs = (await apiGet('bankRefs')) || [];
    const paths = refs.map((r) => r.path).filter(Boolean);
    if (!paths.length) return;
    const files = await loadSoundfontPaths(paths);
    for (const f of files || []) {
        try {
            await engine.addBank(toArrayBuffer(f.data), f.name);
        } catch (e) {
            log(`恢复音源失败：${f.name}（${e.message}）`, 'warn');
        }
    }
    renderBanks();
}

function toArrayBuffer(data) {
    if (data instanceof ArrayBuffer) return data;
    if (data && data.buffer instanceof ArrayBuffer) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return new Uint8Array(data).buffer;
}

async function connectMidi() {
    try {
        await hub.connect();
        state.midiReady = true;
        if (dom.midiStatus) {
            dom.midiStatus.textContent = `MIDI 就绪${hub.sysex ? '（含 SysEx）' : ''}`;
            dom.midiStatus.className = 'ok';
        }
    } catch (e) {
        if (dom.midiStatus) {
            dom.midiStatus.textContent = `MIDI 不可用：${e.message}`;
            dom.midiStatus.className = 'warn';
        }
        log(`MIDI 初始化失败：${e.message}`, 'warn');
    }
    syncDevices(hub.devices, { immediate: true });
}

function updateStatus() {
    dom.statRate.textContent = `${engine.sampleRate} Hz`;
    const lat = engine.latencyMs;
    if (engine.native) {
        const queue = engine.outputBufferMs || 0;
        dom.statLatency.textContent = `${lat} ms`;
        dom.statLatency.title = queue > 0 && queue !== lat
            ? `HAL 周期约 ${lat} ms；AAudio 输出队列约 ${queue} ms`
            : `HAL 周期约 ${lat} ms`;
    } else {
        dom.statLatency.textContent = `${lat} ms`;
        dom.statLatency.title = 'WebAudio 报告的输出延迟';
    }
    dom.statVoices.textContent = String(engine.voiceCount);
}

/* ------------------------------ 事件绑定 ------------------------------ */

/* ------------------------------ 分页 ------------------------------ */

const TABS = ['play', 'devices', 'sound', 'more'];

function showTab(name) {
    const tab = TABS.includes(name) ? name : 'play';
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${tab}`));
    try { localStorage.setItem('uiTab', tab); } catch { /* 忽略 */ }
}

function bindTabs() {
    dom.tabs.addEventListener('click', (e) => {
        const btn = e.target.closest ? e.target.closest('.tab') : null;
        if (btn) showTab(btn.dataset.tab);
    });
    let saved = 'play';
    try { saved = localStorage.getItem('uiTab') || 'play'; } catch { /* 忽略 */ }
    showTab(saved);
}

const RESCAN_LABEL = '刷新手柄列表';

async function rescanMidiDevices() {
    const btn = dom.btnRescan;
    if (btn) {
        btn.disabled = true;
        btn.textContent = '正在读取系统设备…';
    }
    try {
        if (!state.midiReady) await connectMidi().catch(() => {});
        await hub.rescan();
        syncDevices(hub.devices, { immediate: true, markOfflineWhenEmpty: true });
        log(hub.devices.length ? `已刷新，当前 ${hub.devices.length} 个 MIDI 设备` : '未发现 MIDI 设备', hub.devices.length ? 'ok' : 'warn');
    } catch (e) {
        log(`刷新失败：${e.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = RESCAN_LABEL;
        }
    }
}

function bindUI() {
    bindTabs();
    dom.btnStart.addEventListener('click', () => ensureEngine());
    dom.btnRescan.addEventListener('click', () => rescanMidiDevices());
    if (dom.btnOctDown) dom.btnOctDown.addEventListener('click', () => shiftPianoOctave(-1));
    if (dom.btnOctUp) dom.btnOctUp.addEventListener('click', () => shiftPianoOctave(1));
    dom.btnPanic.addEventListener('click', () => {
        engine.stopAll();
        vkb.releaseAll();
        releaseAllPiano();
        log('已停止所有音符', 'info');
    });
    dom.btnLoadBank.addEventListener('click', async () => {
        const files = await openSoundfont();
        if (!files || !files.length) return;
        for (const f of files) {
            try {
                await addBankFile(f.name, toArrayBuffer(f.data), false, f.path || '');
            } catch (e) {
                log(`载入失败 ${f.name}：${e.message}`, 'error');
            }
        }
    });
    dom.masterVolume.addEventListener('input', () => {
        state.master.volume = Number(dom.masterVolume.value);
        engine.setMasterVolume(state.master.volume);
        dom.masterVolumeVal.textContent = Math.round(state.master.volume * 100);
        saveConfig();
    });
    dom.voiceCap.addEventListener('input', () => {
        state.master.voiceCap = Number(dom.voiceCap.value);
        engine.setVoiceCap(state.master.voiceCap);
        dom.voiceCapVal.textContent = state.master.voiceCap;
        saveConfig();
    });
    dom.lowLatency.addEventListener('change', () => {
        state.master.lowLatency = dom.lowLatency.checked;
        saveConfig();
        log(`低延迟模式：${state.master.lowLatency ? '开' : '关'}（重启音频引擎后生效）`, 'info');
    });
    dom.kbdToggle.addEventListener('change', () => {
        state.keyboardEnabled = dom.kbdToggle.checked;
        vkb.setEnabled(state.keyboardEnabled);
        saveConfig();
    });
    dom.btnReset.addEventListener('click', () => {
        engine.reset();
        applyAllRoutes();
        log('合成器已复位', 'info');
    });

    // 拖拽载入音源
    window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
    window.addEventListener('dragleave', () => document.body.classList.remove('dropping'));
    window.addEventListener('drop', async (e) => {
        e.preventDefault();
        document.body.classList.remove('dropping');
        if (!engine.started) { log('请先启动音频引擎', 'warn'); return; }
        for (const file of e.dataTransfer.files) {
            try {
                await addBankFile(file.name, await file.arrayBuffer(), false);
            } catch (err) {
                log(`载入失败 ${file.name}：${err.message}`, 'error');
            }
        }
    });
}

/* ------------------------------ 初始化 ------------------------------ */

export async function startApp() {
    await initRuntime();
    await main();
}

async function main() {
    const ids = ['btn-start', 'start-overlay', 'status-audio', 'audio-dot', 'master-volume', 'master-volume-val',
        'voice-cap', 'voice-cap-val', 'bank-list', 'bank-count', 'btn-load-bank', 'device-list', 'btn-rescan',
        'btn-panic', 'btn-reset', 'kbd-toggle', 'piano', 'btn-oct-down', 'btn-oct-up',
        'stat-rate', 'stat-latency',
        'stat-voices', 'log', 'app-version', 'low-latency', 'tabs', 'dev-count'];
    ids.forEach((id) => { dom[camel(id)] = el(id); });
    dom.devices = el('device-list');

    bindUI();

    hub.resolveRoute = (deviceId) => resolveRouteForDeviceId(deviceId);
    hub.onDevices = (list) => syncDevices(list, { immediate: true });
    hub.onActivity = (deviceId, info) => {
        const route = resolveRouteForDeviceId(deviceId);
        flashActivity(route ? route.key : `midi:${deviceId}`, info.note, info.velocity);
    };
    hub.onError = (e) => log(`MIDI 错误：${e.message}`, 'error');

    vkb.resolveRoute = () => state.routes[VIRTUAL_KEY] || null;
    vkb.onActivity = (info) => {
        if (info.octave != null) return;
        flashActivity(VIRTUAL_KEY, info.note, info.velocity);
    };
    vkb.setEnabled(true);
    vkb.attach();
    dom.kbdToggle.checked = true;

    engine.on('presets', () => { renderDevices(); renderBanks(); });
    engine.on('bankError', (e) => log(`音源解析失败：${e && e.message}`, 'error'));
    engine.on('started', () => {
        dom.statusAudio.textContent = '运行中';
        dom.statusAudio.className = 'ok';
        if (dom.audioDot) dom.audioDot.className = 'dot dot-on';
    });

    await loadConfig();
    initLayout(() => renderPiano());
    // 手机 / 平板 CPU 有限，复音过多会导致欠载与卡顿
    if (!state.master.tuned) {
        const tier = tierFromWidth(window.innerWidth);
        if (tier === 'phone' || isMobile()) {
            if (state.master.voiceCap > 96) state.master.voiceCap = 64;
        } else if (tier === 'tablet' && state.master.voiceCap > 128) {
            state.master.voiceCap = 96;
        }
        state.master.tuned = true;
    }
    dom.masterVolume.value = state.master.volume;
    dom.masterVolumeVal.textContent = Math.round(state.master.volume * 100);
    dom.voiceCap.value = state.master.voiceCap;
    dom.voiceCapVal.textContent = state.master.voiceCap;
    dom.lowLatency.checked = state.master.lowLatency !== false;
    dom.kbdToggle.checked = state.keyboardEnabled;

    try {
        const info = await getInfo();
        if (isElectron()) {
            document.documentElement.classList.add('electron', `platform-${info.platform}`);
        }
        const cap = typeof window !== 'undefined' ? window.Capacitor : null;
        if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
            const plat = typeof cap.getPlatform === 'function' ? cap.getPlatform() : 'native';
            document.documentElement.classList.add('native-app', `platform-${plat}`);
        }
        dom.appVersion.textContent = info.version ? `v${info.version}` : '';
        if (!info.hasBuiltin) log('未检测到内置音源（assets/soundfonts），启动时可手动载入 SF2', 'warn');
        if (!isElectron()) {
            if (info.secureContext === false) log('当前非安全上下文（需 HTTPS 或 localhost），Web MIDI 不可用', 'warn');
            if (!info.webMidi) log('当前浏览器不支持 Web MIDI（如 iOS Safari），可使用电脑键盘/屏幕键盘演奏', 'warn');
        }
        if (isMobile() || tierFromWidth(window.innerWidth) !== 'desktop') {
            await keepAwake(true);
        }
    } catch (e) {
        log(`读取应用信息失败：${e.message}`, 'warn');
    }

    // 尚未连上设备时也渲染已保存的路由
    syncDevices([]);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || !state.midiReady || !isNativeMidiAvailable()) return;
        hub.refresh()
            .then(() => syncDevices(hub.devices, { immediate: true }))
            .catch(() => {});
    });
    setInterval(updateStatus, 500);
    // 便于调试 / 自动化测试
    window.__ensemble = { engine, hub, vkb, state, pianoActive, pianoPress, pianoRelease, renderPiano, showTab };
}

function camel(id) {
    return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
