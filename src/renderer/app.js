/**
 * 应用主逻辑：界面渲染、设备-乐器映射、配置持久化。
 */
import { SynthEngine, DEFAULT_CHANNELS } from './synth.js';
import { NativeSynthEngine, isNativeSynthAvailable } from './native-synth.js';
import { MidiHub } from './midi.js';
import { NativeMidiHub, isNativeMidiAvailable } from './native-midi.js';
import { VirtualKeyboard } from './keyboard.js';
import { GM_PROGRAMS, DRUM_NOTES, noteName, programLabel } from './gm.js';
import { getBuiltinSoundfont, openSoundfont, loadSoundfontPaths, storeGet, storeSet, getInfo, isMobile, isElectron, keepAwake } from './platform.js';

const VIRTUAL_KEY = 'virtual:keyboard';

const state = {
    routes: {},
    order: [],
    master: { volume: 0.9, voiceCap: 160, lowLatency: true },
    keyboardEnabled: true,
    selected: null,
    midiReady: false,
};

// 原生安装包走原生合成（AAudio + TinySoundFont），其余走 WebAudio + spessasynth
let engine = isNativeSynthAvailable() ? new NativeSynthEngine() : new SynthEngine();
let MAX_CHANNELS = engine.maxChannels || 32;

/** 引擎切换（原生合成不可用时回退） */
function swapEngine(next) {
    engine = next;
    MAX_CHANNELS = next.maxChannels || 32;
    hub.engine = next;
    vkb.engine = next;
}
// 原生安装包走原生 MIDI 插件，桌面/浏览器走 Web MIDI
const hub = isNativeMidiAvailable() ? new NativeMidiHub(engine) : new MidiHub(engine);
const vkb = new VirtualKeyboard(engine);

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
        deviceId: kind === 'midi' ? key.slice(5) : '',
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

function syncDevices(list) {
    let changed = false;
    const seen = new Set();
    for (const dev of list) {
        const key = `midi:${dev.id}`;
        seen.add(key);
        if (!state.routes[key]) {
            state.routes[key] = defaultRoute(key, dev.name, 'midi', pickChannel(null));
            state.routes[key].guessBluetooth = dev.guessBluetooth;
            state.order.push(key);
            changed = true;
            log(`检测到 MIDI 设备：${dev.name}${dev.guessBluetooth ? '（疑似蓝牙）' : ''}`, 'ok');
        } else {
            state.routes[key].guessBluetooth = dev.guessBluetooth;
        }
    }
    // 已断开的设备保留配置，但标记为离线
    for (const r of Object.values(state.routes)) {
        r.online = r.kind !== 'midi' || seen.has(r.key);
    }
    if (!state.routes[VIRTUAL_KEY]) {
        state.routes[VIRTUAL_KEY] = defaultRoute(VIRTUAL_KEY, '电脑键盘（虚拟手柄）', 'virtual', pickChannel(null));
        state.order.push(VIRTUAL_KEY);
        changed = true;
    }
    state.routes[VIRTUAL_KEY].online = true;
    if (changed) saveConfig();
    renderDevices();
    renderPiano();
}

/* ------------------------------ 界面渲染 ------------------------------ */

function renderDevices() {
    const wrap = dom.devices;
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
                    ${r.guessBluetooth ? '<span class="tag tag-ble">蓝牙</span>' : ''}
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
                <span class="hint">通道 ${r.channel + 1} · ${r.isDrum ? '打击乐' : programLabel(r.program)}</span>
                <span class="activity" data-activity></span>
            </div>`;
        wireCard(card, r);
        wrap.appendChild(card);
    }
    if (!keys.length) {
        wrap.innerHTML = '<div class="empty">尚未检测到 MIDI 设备。请打开蓝牙 MIDI 手柄并点击「扫描设备」。</div>';
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
        const mark = c === 9 ? '（打击乐通道）' : c >= DEFAULT_CHANNELS ? '（扩展）' : '';
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
        const value = `${p.bankMSB}|${p.bankLSB}|${p.program}`;
        const sel = !isDrum && !route.isDrum && route.bankMSB === p.bankMSB && route.bankLSB === p.bankLSB && route.program === p.program;
        const selD = isDrum && route.isDrum && route.drumProgram === p.program && route.bankMSB === p.bankMSB;
        return `<option value="${value}" ${sel || selD ? 'selected' : ''}>${escapeHtml(p.name || '')}</option>`;
    };
}

function wireCard(card, route) {
    card.querySelectorAll('[data-field]').forEach((input) => {
        const field = input.dataset.field;
        input.addEventListener('input', () => {
            if (input.type === 'checkbox') route[field] = input.checked;
            else if (field === 'instrument') {
                const [msb, lsb, prog] = input.value.split('|').map(Number);
                route.bankMSB = msb; route.bankLSB = lsb; route.program = prog; route.isDrum = false;
            } else if (field === 'drumProgram') {
                const [msb, lsb, prog] = input.value.split('|').map(Number);
                route.bankMSB = msb; route.bankLSB = lsb; route.drumProgram = prog; route.isDrum = true;
            } else if (field === 'channel') route.channel = Number(input.value);
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
    if (foot) foot.textContent = `通道 ${route.channel + 1} · ${route.isDrum ? '打击乐' : programLabel(route.program)}`;
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
/** 屏幕较窄时（手机竖屏）收窄到两个八度，保证琴键点得准 */
function pianoRange() {
    const narrow = typeof window !== 'undefined' && (window.innerWidth < 760);
    return narrow ? [48, 72] : [PIANO_START, PIANO_END];
}
/** pointerId -> { note, el, routeKey, channel }：支持多点触控与滑奏 */
const pianoActive = new Map();
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

/** 滑奏时每个音的最短时长：太短会听不见，导致轮指「丢音」 */
const GLIDE_NOTE_MS = 70;

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
    const finish = () => {
        // 手指/鼠标又滑回同一个音时，不要把它掐掉
        const cur = pianoActive.get(pointerId);
        if (cur && cur.note === a.note && cur.channel === a.channel) return;
        engine.noteOff(a.channel, a.note);
    };
    if (glide) setTimeout(finish, GLIDE_NOTE_MS);
    else finish();
}

function releaseAllPiano() {
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
        });
    }
    piano.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', releaseAllPiano);
    let lastRange = pianoRange().join('-');
    const onResize = () => {
        const now = pianoRange().join('-');
        if (now !== lastRange) {
            lastRange = now;
            renderPiano();
        }
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => setTimeout(onResize, 200));
}

let pianoRangeKey = '';

function renderPiano() {
    const piano = dom.piano;
    const route = currentPianoRoute();
    const [start, end] = pianoRange();
    const rangeKey = `${start}-${end}`;
    // 设备列表变化会频繁触发重绘：琴键布局未变时只更新提示，避免打断正在按住的音
    if (rangeKey !== pianoRangeKey) {
        releaseAllPiano();
        pianoRangeKey = rangeKey;
        piano.innerHTML = '';
        const whites = [];
        for (let n = start; n <= end; n++) if (!BLACK_KEYS.includes(n % 12)) whites.push(n);
        const w = 100 / whites.length;
        let whiteIndex = 0;
        for (let n = start; n <= end; n++) {
            const isBlack = BLACK_KEYS.includes(n % 12);
            const key = document.createElement('div');
            key.className = `pkey ${isBlack ? 'black' : 'white'}`;
            key.dataset.note = n;
            key.title = `${noteName(n)}${DRUM_NOTES[n] ? ' · ' + DRUM_NOTES[n] : ''}`;
            if (isBlack) {
                key.style.left = `calc(${whiteIndex * w}% - var(--bw) / 2)`;
            } else {
                whiteIndex++;
            }
            key.innerHTML = `<span>${DRUM_NOTES[n] ? '' : noteName(n)}</span>`;
            piano.appendChild(key);
        }
        bindPiano();
    }
    renderTargetChips();
    dom.pianoInfo.textContent = route ? `当前目标：${route.label || route.name}` : '请先在「手柄」页选择一个设备';
}

/* ------------------------------ 演奏目标快捷切换 ------------------------------ */

let chipBound = false;

function renderTargetChips() {
    const wrap = dom.targetChips;
    if (!wrap) return;
    const cur = currentPianoRoute();
    const keys = state.order.filter((k) => state.routes[k]);
    wrap.innerHTML = keys.map((k) => {
        const r = state.routes[k];
        const on = cur && cur.key === k;
        const cls = `chip${on ? ' on' : ''}${r.online === false ? ' off' : ''}`;
        return `<button class="${cls}" data-key="${k}">${escapeHtml(r.label || r.name)}</button>`;
    }).join('') || '<span class="hint">暂无设备</span>';
    if (!chipBound) {
        chipBound = true;
        wrap.addEventListener('click', (e) => {
            const btn = e.target.closest ? e.target.closest('.chip') : null;
            if (!btn) return;
            state.selected = btn.dataset.key;
            renderDevices();
            renderPiano();
        });
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
    const id = await engine.addBank(arrayBuffer, name);
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
        await apiSet('config', {
            routes: state.routes,
            order: state.order,
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

async function loadConfig() {
    const cfg = await apiGet('config');
    if (!cfg) return;
    if (cfg.routes) state.routes = cfg.routes;
    if (cfg.order) state.order = cfg.order;
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
            ? `原生合成已启动（AAudio ${engine.sampleRate} Hz，缓冲 ${engine.latencyMs} ms）`
            : `音频引擎已启动（${engine.sampleRate} Hz，缓冲 ${Math.round((info.base || 0) * 1000)} ms / 输出 ${Math.round((info.output || 0) * 1000)} ms${engine.lowLatency ? '，低延迟模式' : ''}）`, 'ok');
        if (engine.native && engine.latencyMs >= 60) {
            log(`缓冲偏大（${engine.latencyMs} ms）：多为蓝牙输出或系统未给独占低延迟通路，可改用有线耳机`, 'warn');
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
            swapEngine(new SynthEngine());
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
        dom.midiStatus.textContent = `MIDI 就绪${hub.sysex ? '（含 SysEx）' : ''}`;
        dom.midiStatus.className = 'ok';
    } catch (e) {
        dom.midiStatus.textContent = `MIDI 不可用：${e.message}`;
        dom.midiStatus.className = 'warn';
        log(`MIDI 初始化失败：${e.message}`, 'warn');
    }
    syncDevices(hub.devices);
}

function updateStatus() {
    dom.statRate.textContent = `${engine.sampleRate} Hz`;
    dom.statLatency.textContent = `${engine.latencyMs} ms`;
    dom.statVoices.textContent = String(engine.voiceCount);
    dom.statState.textContent = engine.running ? '运行中' : '已暂停';
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

function bindUI() {
    bindTabs();
    dom.btnStart.addEventListener('click', () => ensureEngine());
    dom.btnRescan.addEventListener('click', async () => {
        hub.rescan();
        await connectMidi().catch(() => {});
        syncDevices(hub.devices);
        log('已重新扫描 MIDI 设备（含蓝牙）', 'info');
    });
    dom.btnPanic.addEventListener('click', () => {
        engine.stopAll();
        vkb.releaseAll();
        releaseAllPiano();
        log('已停止所有音符', 'info');
    });
    dom.btnLoadBank.addEventListener('click', async () => {
        if (engine.native) {
            log('原生合成模式已内置音源；如需更换，请把 SF2 放入安装包的 assets 后重新打包', 'warn');
            return;
        }
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

async function main() {
    const ids = ['btn-start', 'start-overlay', 'status-audio', 'audio-dot', 'master-volume', 'master-volume-val',
        'voice-cap', 'voice-cap-val', 'bank-list', 'bank-count', 'btn-load-bank', 'device-list', 'btn-rescan',
        'midi-status', 'btn-panic', 'btn-reset', 'kbd-toggle', 'piano', 'piano-info', 'stat-rate', 'stat-latency',
        'stat-voices', 'stat-state', 'log', 'app-version', 'low-latency', 'tabs', 'target-chips', 'dev-count'];
    ids.forEach((id) => { dom[camel(id)] = el(id); });
    dom.devices = el('device-list');

    bindUI();

    hub.resolveRoute = (deviceId) => state.routes[`midi:${deviceId}`] || null;
    hub.onDevices = (list) => syncDevices(list);
    hub.onActivity = (deviceId, info) => flashActivity(`midi:${deviceId}`, info.note, info.velocity);
    hub.onError = (e) => log(`MIDI 错误：${e.message}`, 'error');

    vkb.resolveRoute = () => state.routes[VIRTUAL_KEY] || null;
    vkb.onActivity = (info) => {
        if (info.octave != null) { dom.pianoInfo.textContent = `键盘八度：${info.octave}`; return; }
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
    // 手机 CPU 有限，复音过多会导致音频线程欠载，间接放大延迟与卡顿
    if (isMobile() && !state.master.tuned) {
        if (state.master.voiceCap > 96) state.master.voiceCap = 64;
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
        dom.appVersion.textContent = `v${info.version} · ${info.platform}`;
        if (!info.hasBuiltin) log('未检测到内置音源（assets/soundfonts），启动时可手动载入 SF2', 'warn');
        if (!isElectron()) {
            if (info.secureContext === false) log('当前非安全上下文（需 HTTPS 或 localhost），Web MIDI 不可用', 'warn');
            if (!info.webMidi) log('当前浏览器不支持 Web MIDI（如 iOS Safari），可使用电脑键盘/屏幕键盘演奏', 'warn');
        }
        if (isMobile()) {
            document.body.classList.add('mobile');
            await keepAwake(true);
        }
    } catch (e) {
        log(`读取应用信息失败：${e.message}`, 'warn');
    }

    // 尚未连上设备时也渲染已保存的路由
    syncDevices([]);
    setInterval(updateStatus, 500);
    // 便于调试 / 自动化测试
    window.__ensemble = { engine, hub, vkb, state, pianoActive, pianoPress, pianoRelease, renderPiano, showTab };
}

function camel(id) {
    return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

window.addEventListener('DOMContentLoaded', main);
