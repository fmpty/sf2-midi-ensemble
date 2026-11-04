/**
 * 漏抬键 / 丢 Note Off 兜底：在「认为没有按键按下」或长时间无 MIDI 时自动 stopAll。
 */

const LEAK_DEBOUNCE_MS = 500;
/** 最后一次 Note On/Off 后仍持续发声则清掉（长按单音会受限，可改大） */
const IDLE_CUT_MS = 8000;

const active = new Set();
let lastNoteAt = 0;
let intervalId = 0;
let leakTimer = 0;

function key(ch, note) {
    return `${ch | 0}:${note | 0}`;
}

function clampNote(n) {
    return Math.max(0, Math.min(127, n | 0));
}

export function touchNote(channel, note, on) {
    lastNoteAt = Date.now();
    const k = key(channel, note);
    if (on) active.add(k);
    else active.delete(k);
}

/** 与路由一致的 note/ch（native 直发声路径需 applyTranspose） */
export function trackFromRouteMidi(route, data, opts = {}) {
    if (!route || !data?.length) return;
    const status = data[0];
    if (status >= 0xf0) return;
    const type = status & 0xf0;
    if (type !== 0x90 && type !== 0x80) return;
    if (data.length < 3) return;
    let note = clampNote(data[1]);
    if (opts.applyTranspose && route.transpose) note = clampNote(note + route.transpose);
    const vel = type === 0x80 ? 0 : data[2];
    touchNote(route.channel, note, vel > 0);
}

function clearTracking() {
    active.clear();
}

/**
 * @param {import('./native-synth.js').NativeSynthEngine | import('./synth.js').WebSynthEngine} engine
 * @param {(msg: string) => void} [log]
 */
export function installNoteLeakGuard(engine, log) {
    if (intervalId) return;

    const origOn = engine.noteOn.bind(engine);
    const origOff = engine.noteOff.bind(engine);
    const origStop = engine.stopAll.bind(engine);

    engine.noteOn = (ch, n, v) => {
        touchNote(ch, n, true);
        origOn(ch, n, v);
    };
    engine.noteOff = (ch, n) => {
        touchNote(ch, n, false);
        origOff(ch, n);
    };
    engine.stopAll = () => {
        clearTracking();
        lastNoteAt = Date.now();
        origStop();
    };

    const runLeakCheck = async () => {
        if (!engine.started) return;
        if (engine.native && typeof engine.refreshStatus === 'function') {
            await engine.refreshStatus();
        }
        const voices = engine.voiceCount || 0;
        if (voices <= 0) {
            clearTracking();
            return;
        }

        const idle = Date.now() - lastNoteAt;
        if (idle >= IDLE_CUT_MS) {
            origStop();
            clearTracking();
            lastNoteAt = Date.now();
            log?.('长时间无 MIDI 活动，已自动清除残留发声');
            return;
        }

        if (active.size === 0) {
            clearTimeout(leakTimer);
            leakTimer = setTimeout(() => {
                if (!engine.started) return;
                const v = engine.voiceCount || 0;
                if (v > 0 && active.size === 0) {
                    origStop();
                    log?.('检测到无按键记录仍在发声，已自动静音');
                    lastNoteAt = Date.now();
                }
            }, LEAK_DEBOUNCE_MS);
        }
    };

    intervalId = setInterval(() => {
        runLeakCheck().catch(() => {});
    }, 1000);
}
