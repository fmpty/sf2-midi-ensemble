/**
 * 演奏记录：标准 MIDI 文件（.mid），只记音符 / 控键 / 音色，不录音频。
 * 多出来的通道（超过 16）写在分轨名称 ch-N 里，本应用导入时能还原。
 */
import { transformVelocity } from './midi.js';

const PPQ = 480;
const DEFAULT_USPQ = 500000;

const wrapped = new WeakSet();
let capturing = false;
let suppress = false;
let startedAt = 0;
let seq = 0;
/** @type {object[]} */
let events = [];
/** 导入的多轨 SMF（录制数据为 false） */
let importedSmfMultiTrack = false;
const held = new Set();
const lastProgram = new Map();
let playTimer = 0;
let playNotes = [];
let playGen = 0;
let playStarted = 0;

/** 避免播放/静音判断时对整表反复 slice+sort */
let sortedEventsCache = null;
let sortedEventsLen = -1;
let jianpuTrackModeCache = null;

function invalidatePerformanceCaches() {
    sortedEventsCache = null;
    sortedEventsLen = -1;
    jianpuTrackModeCache = null;
}

function nowMs() {
    return capturing ? Math.max(0, performance.now() - startedAt) : 0;
}

export function hasPerformance() {
    if (!events.length) return false;
    return events.some((e) => (e.type === 0x90 && e.b > 0) || e.live);
}

export function performanceDurationMs() {
    let max = 0;
    for (const e of events) if (e.ms > max) max = e.ms;
    return max;
}

export function isCapturing() {
    return capturing;
}

function shouldCapture() {
    return capturing && !suppress;
}

function keyOf(ch, note) {
    return `${ch | 0}:${note | 0}`;
}

function push(ev) {
    ev.ord = seq++;
    events.push(ev);
    invalidatePerformanceCaches();
}

function pushNoteOn(ch, note, vel) {
    const n = Math.max(0, Math.min(127, note | 0));
    const v = Math.max(1, Math.min(127, vel | 0));
    held.add(keyOf(ch, n));
    push({ ms: nowMs(), live: true, ch: ch | 0, type: 0x90, a: n, b: v });
}

function pushNoteOff(ch, note) {
    const n = Math.max(0, Math.min(127, note | 0));
    held.delete(keyOf(ch, n));
    push({ ms: nowMs(), live: true, ch: ch | 0, type: 0x80, a: n, b: 0 });
}

export function installPerformanceCapture(engine) {
    if (!engine || wrapped.has(engine)) return;
    wrapped.add(engine);
    const noteOn = engine.noteOn.bind(engine);
    const noteOff = engine.noteOff.bind(engine);
    const sendMessage = engine.sendMessage.bind(engine);
    engine.noteOn = (ch, n, v) => {
        if (shouldCapture()) {
            if ((v | 0) > 0) pushNoteOn(ch, n, v);
            else pushNoteOff(ch, n);
        }
        noteOn(ch, n, v);
    };
    engine.noteOff = (ch, n) => {
        if (shouldCapture()) pushNoteOff(ch, n);
        noteOff(ch, n);
    };
    engine.sendMessage = (bytes, offset = 0) => {
        if (shouldCapture() && bytes && bytes.length) {
            const status = bytes[0] | 0;
            if (status < 0xf0) {
                const type = status & 0xf0;
                const ch = (status & 0x0f) + (offset | 0);
                if (type === 0xb0 && bytes.length >= 3) {
                    push({ ms: nowMs(), live: true, ch, type, a: bytes[1] & 127, b: bytes[2] & 127 });
                } else if (type === 0xe0 && bytes.length >= 3) {
                    push({
                        ms: nowMs(),
                        live: true,
                        ch,
                        type,
                        a: bytes[1] & 127,
                        b: bytes[2] & 127,
                    });
                } else if (type === 0xc0 && bytes.length >= 2) {
                    push({ ms: nowMs(), live: true, ch, type, a: bytes[1] & 127, b: 0 });
                }
            }
        }
        sendMessage(bytes, offset);
    };
}

/** 原生层已直接发声、没有经过 engine.noteOn 的 MIDI */
export function captureNativePlayed(route, data) {
    if (!shouldCapture() || !route || !data || !data.length) return;
    const status = data[0] | 0;
    if (status >= 0xf0) return;
    const type = status & 0xf0;
    const ch = route.channel | 0;
    if ((type === 0x90 || type === 0x80) && data.length >= 3) {
        let note = data[1] | 0;
        if (route.transpose) note += route.transpose | 0;
        const vel = type === 0x80 ? 0 : transformVelocity(data[2], route);
        if (vel > 0) pushNoteOn(ch, note, vel);
        else pushNoteOff(ch, note);
        return;
    }
    if (type === 0xb0 && data.length >= 3) {
        push({ ms: nowMs(), live: true, ch, type, a: data[1] & 127, b: data[2] & 127 });
    } else if (type === 0xe0 && data.length >= 3) {
        push({ ms: nowMs(), live: true, ch, type, a: data[1] & 127, b: data[2] & 127 });
    } else if (type === 0xc0 && route.allowProgramChange && data.length >= 2) {
        push({ ms: nowMs(), live: true, ch, type, a: data[1] & 127, b: 0, drum: !!route.isDrum });
    }
}

function rememberProgram(route) {
    const ch = route.channel | 0;
    const program = route.isDrum ? (route.drumProgram | 0) : (route.program | 0);
    const sig = `${route.isDrum ? 1 : 0}:${route.bankMSB & 127}:${route.bankLSB & 127}:${program & 127}`;
    return { ch, program: program & 127, sig };
}

function writeProgram(route, ms, live) {
    const { ch, program } = rememberProgram(route);
    push({ ms, live, ch, type: 0xb0, a: 0, b: route.bankMSB & 127 });
    push({ ms, live, ch, type: 0xb0, a: 32, b: route.bankLSB & 127 });
    push({ ms, live, ch, type: 0xc0, a: program, b: 0, drum: !!route.isDrum });
}

export function captureRouteProgram(route) {
    if (!shouldCapture() || !route || route.enabled === false) return;
    if (route.kind !== 'midi' && route.kind !== 'virtual') return;
    const { ch, sig } = rememberProgram(route);
    if (lastProgram.get(ch) === sig) return;
    lastProgram.set(ch, sig);
    writeProgram(route, nowMs(), true);
}

export function startRecording(routes) {
    events = [];
    invalidatePerformanceCaches();
    importedSmfMultiTrack = false;
    held.clear();
    lastProgram.clear();
    seq = 0;
    startedAt = performance.now();
    capturing = true;
    const seen = new Set();
    for (const r of routes || []) {
        if (!r || r.enabled === false) continue;
        if (r.kind !== 'midi' && r.kind !== 'virtual') continue;
        const ch = r.channel | 0;
        if (seen.has(ch)) continue;
        seen.add(ch);
        lastProgram.set(ch, rememberProgram(r).sig);
        writeProgram(r, 0, false);
    }
}

export function stopRecording() {
    if (!capturing) return;
    for (const k of [...held]) {
        const [ch, note] = k.split(':');
        pushNoteOff(Number(ch), Number(note));
    }
    capturing = false;
}

function sortedEvents() {
    if (sortedEventsCache && sortedEventsLen === events.length) return sortedEventsCache;
    sortedEventsCache = events.slice().sort((a, b) => a.ms - b.ms || a.ord - b.ord);
    sortedEventsLen = events.length;
    return sortedEventsCache;
}

export function getPerformanceEvents() {
    return sortedEvents();
}

/** 简谱轨 ID 模式；不依赖全表排序 */
export function getJianpuTrackMode() {
    if (jianpuTrackModeCache) return jianpuTrackModeCache;
    if (importedSmfMultiTrack) {
        jianpuTrackModeCache = 'smf';
        return jianpuTrackModeCache;
    }
    const trks = new Set();
    let sawTrk = false;
    for (const e of events) {
        if (e.trk == null) continue;
        sawTrk = true;
        trks.add(e.trk | 0);
    }
    jianpuTrackModeCache = !sawTrk ? 'channel' : trks.size > 1 ? 'smf' : 'channel';
    return jianpuTrackModeCache;
}

export function jianpuTrackGrouping(events) {
    if (importedSmfMultiTrack) return 'smf';
    const list = events || [];
    const withTrk = list.filter((e) => e.trk != null);
    if (!withTrk.length) return 'channel';
    const trks = new Set(withTrk.map((e) => e.trk | 0));
    return trks.size > 1 ? 'smf' : 'channel';
}

/** 与 summarize / filter / 静音 共用的练习轨 ID */
export function practiceIdForEvent(e, events = null) {
    if (!e) return 'ch-0';
    const mode = events ? jianpuTrackGrouping(events) : getJianpuTrackMode();
    const ch = e.ch | 0;
    if (mode === 'smf' && e.trk != null) return `t-${e.trk | 0}`;
    return `ch-${ch}`;
}

/** 一次扫描按轨收集 note-on，供简谱排版（避免每轨 filter 全表） */
export function buildTrackNoteIndex(trackIds) {
    const ids = trackIds instanceof Set ? trackIds : new Set(trackIds);
    const map = new Map();
    for (const id of ids) map.set(id, []);
    const mode = getJianpuTrackMode();
    for (const e of events) {
        if (e.type !== 0x90 || e.b <= 0) continue;
        let id;
        if (mode === 'smf' && e.trk != null) id = `t-${e.trk | 0}`;
        else id = `ch-${e.ch | 0}`;
        if (!ids.has(id)) continue;
        map.get(id).push(e);
    }
    for (const arr of map.values()) {
        if (arr.length > 1) arr.sort((a, b) => a.ms - b.ms || (a.ord | 0) - (b.ord | 0));
    }
    return map;
}

function smfTrackId(trk) {
    return `t-${trk | 0}`;
}

function resolvedPerformanceList(events) {
    return events && events.length ? events : getPerformanceEvents();
}

export function eventMatchesPracticePick(e, selectedIds, events) {
    const set = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
    if (!set.size || !e) return false;
    const list = resolvedPerformanceList(events);
    const mode = jianpuTrackGrouping(list);
    const ch = e.ch | 0;
    if (mode === 'smf' && e.trk != null) {
        const trk = e.trk | 0;
        for (const id of set) {
            const whole = /^t-(\d+)$/.exec(id);
            if (whole && trk === Number(whole[1])) return true;
            const leg = /^t-(\d+)-ch-(\d+)$/.exec(id);
            if (leg && trk === Number(leg[1]) && ch === Number(leg[2])) return true;
        }
        return false;
    }
    return set.has(`ch-${ch}`);
}

/** 回放光标与简谱格子对齐用 */
export function performanceNoteKey(e) {
    if (!e) return '';
    const trk = e.trk == null ? -1 : e.trk | 0;
    return `${e.ms ?? 0}|${e.ch | 0}|${e.a | 0}|${trk}|${e.ord ?? 0}`;
}

function channelLabel(ch, drum) {
    if (drum || ch === 9) return `鼓 · 通道 ${ch + 1}`;
    return `通道 ${ch + 1}`;
}

/** @returns {{ id: string, trk?: number, ch?: number, name: string, noteOns: number }[]} */
export function summarizePerformanceTracks(events) {
    const list = events || [];
    const mode = jianpuTrackGrouping(list);
    const map = new Map();
    if (mode === 'smf') {
        for (const e of list) {
            if (e.trk == null) continue;
            const ch = e.ch | 0;
            const id = smfTrackId(e.trk);
            if (!map.has(id)) {
                const base = (e.trkName || '').trim() || `轨 ${(e.trk | 0) + 1}`;
                map.set(id, {
                    id,
                    trk: e.trk | 0,
                    ch,
                    name: base,
                    noteOns: 0,
                    drumCh: 0,
                });
            }
            const row = map.get(id);
            if (e.type === 0x90 && e.b > 0) row.noteOns += 1;
            if (ch === 9 || e.drum) row.drumCh += 1;
        }
        for (const row of map.values()) {
            if (row.drumCh > row.noteOns * 0.5) {
                row.name = `${row.name} · 鼓`;
            } else if (row.ch != null) {
                row.name = `${row.name} · ${channelLabel(row.ch, row.drumCh > 0)}`;
            }
        }
    } else {
        for (const e of list) {
            const ch = e.ch | 0;
            const id = `ch-${ch}`;
            if (!map.has(id)) {
                map.set(id, { id, ch, name: channelLabel(ch, e.drum), noteOns: 0 });
            }
            if (e.type === 0x90 && e.b > 0) map.get(id).noteOns += 1;
        }
    }
    const out = [...map.values()];
    out.sort((a, b) => {
        if (a.trk != null && b.trk != null) return a.trk - b.trk;
        return (a.ch | 0) - (b.ch | 0);
    });
    for (const t of out) {
        if (!t.noteOns) t.name += '（无旋律）';
    }
    return out;
}

/** 当前练习轨的全部 Note On（按时间排序）——简谱与跟奏唯一数据源 */
export function buildPracticeNoteList(events, selectedIds) {
    const set = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
    if (!set.size) return [];
    const list = resolvedPerformanceList(events);
    const out = [];
    for (const e of list) {
        if (e.type !== 0x90 || e.b <= 0) continue;
        if (!eventMatchesPracticePick(e, set, list)) continue;
        out.push(e);
    }
    out.sort((a, b) => a.ms - b.ms || (a.ord | 0) - (b.ord | 0));
    return out;
}

export function filterJianpuNoteEvents(events, selectedIds) {
    return buildPracticeNoteList(events, selectedIds);
}

export function shouldAdvanceJianpuCursor(e, selectedIds) {
    if (!e || e.type !== 0x90 || e.b <= 0) return false;
    return eventMatchesPracticePick(e, selectedIds, getPerformanceEvents());
}

export function isPracticeTrackMuted(e, selectedIds) {
    if (!selectedIds || !selectedIds.size) return false;
    if (e.type !== 0x90 && e.type !== 0x80 && !(e.type === 0x90 && e.b === 0)) {
        return false;
    }
    return eventMatchesPracticePick(e, selectedIds, getPerformanceEvents());
}

const MAIN_MELODY_NAME =
    /melody|vocal|voice|主旋律|人声|主唱|主音|唱歌|主律|song|singer|lead\s/i;
const ACCOMP_NAME =
    /鼓|drum|perc|hit|kick|snare|bass|ba\b|低音|和弦|chord|pad|comp|accomp|rhythm|gm drum|drum\s*--/i;

/** 从多轨 MIDI 猜「主旋律」轨，用于常规单线简谱 */
export function detectMainMelodyTrack(tracks, events = null) {
    const list = resolvedPerformanceList(events);
    const playable = (tracks || []).filter((t) => t.noteOns > 0);
    if (!playable.length) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const t of playable) {
        let score = 0;
        const name = t.name || '';
        if (MAIN_MELODY_NAME.test(name)) score += 120;
        if (/^melody:/i.test(name) || /\bwn\s+pan/i.test(name)) score += 80;
        if (/piano|pn\b|keyboard|键盘/i.test(name) && !/chord|和弦/i.test(name)) score += 35;
        if (/lead/i.test(name) && !/drum/i.test(name)) score += 45;
        if (ACCOMP_NAME.test(name)) score -= 200;
        if ((t.ch | 0) === 9) score -= 160;
        if (t.noteOns > 1800) score -= 90;
        if (t.noteOns >= 60 && t.noteOns <= 1400) score += 25;
        if (t.noteOns < 30) score -= 40;
        const notes = buildPracticeNoteList(list, new Set([t.id]));
        if (notes.length) {
            const avg = notes.reduce((s, n) => s + (n.a | 0), 0) / notes.length;
            if (avg >= 58 && avg <= 88) score += 30;
            if (avg < 52) score -= 50;
        }
        if (score > bestScore) {
            bestScore = score;
            best = t;
        }
    }
    return best?.id ?? playable[0].id;
}

export function defaultJianpuTrackSelection(tracks) {
    const id = detectMainMelodyTrack(tracks);
    return id ? new Set([id]) : new Set();
}

/**
 * 同一时刻多音（和弦垫）只保留最高音，排成常规单旋律简谱
 * @param {object[]} noteOns 已按时间排序
 */
export function collapseToMelodyLine(noteOns, windowMs = 50) {
    if (!noteOns?.length) return [];
    const out = [];
    let batch = [noteOns[0]];
    const flush = () => {
        const pick = batch.reduce((a, b) => ((a.a | 0) >= (b.a | 0) ? a : b));
        out.push(pick);
    };
    for (let i = 1; i < noteOns.length; i++) {
        const e = noteOns[i];
        if (e.ms - batch[0].ms <= windowMs) batch.push(e);
        else {
            flush();
            batch = [e];
        }
    }
    flush();
    return out;
}

function vlq(n) {
    let v = Math.max(0, n | 0);
    const out = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
        out.push((v & 0x7f) | 0x80);
        v >>= 7;
    }
    out.reverse();
    return out;
}

function u32(n) {
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function u16(n) {
    return [(n >>> 8) & 255, n & 255];
}

function msToTick(ms) {
    return Math.round((ms * PPQ) / (DEFAULT_USPQ / 1000));
}

function trackBytes(items) {
    const body = [];
    let tick = 0;
    for (const item of items) {
        body.push(...vlq(Math.max(0, item.tick - tick)));
        tick = item.tick;
        body.push(...item.bytes);
    }
    body.push(...vlq(0), 0xff, 0x2f, 0x00);
    return body;
}

function chunk(type, data) {
    return [...type, ...u32(data.length), ...data];
}

export function toMidiBytes() {
    const list = sortedEvents();
    const byCh = new Map();
    for (const e of list) {
        if (!byCh.has(e.ch)) byCh.set(e.ch, []);
        byCh.get(e.ch).push(e);
    }
    const channels = [...byCh.keys()].sort((a, b) => a - b);
    const tempo = trackBytes([{ tick: 0, bytes: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] }]);
    const tracks = [tempo];
    for (const ch of channels) {
        const drum = byCh.get(ch).some((e) => e.type === 0xc0 && e.drum);
        const name = `ch-${ch}${drum ? 'd' : ''}`;
        const nameBytes = [...new TextEncoder().encode(name)];
        const items = [{ tick: 0, bytes: [0xff, 0x03, nameBytes.length, ...nameBytes] }];
        for (const e of byCh.get(ch)) {
            const status = (e.type & 0xf0) | (ch & 15);
            const bytes = e.type === 0xc0 ? [status, e.a & 127] : [status, e.a & 127, e.b & 127];
            items.push({ tick: msToTick(e.ms), bytes });
        }
        tracks.push(trackBytes(items));
    }
    const head = chunk([0x4d, 0x54, 0x68, 0x64], [...u16(1), ...u16(tracks.length), ...u16(PPQ)]);
    const out = [...head];
    for (const tr of tracks) out.push(...chunk([0x4d, 0x54, 0x72, 0x6b], tr));
    return new Uint8Array(out);
}

function readU16(b, i) {
    return (b[i] << 8) | b[i + 1];
}

function readU32(b, i) {
    return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function readVlq(b, i) {
    let v = 0;
    while (i < b.length) {
        const byte = b[i++];
        v = (v << 7) | (byte & 0x7f);
        if ((byte & 0x80) === 0) break;
    }
    return [v, i];
}

function parseTrack(b, start, end) {
    let i = start;
    let tick = 0;
    let running = 0;
    let name = '';
    const evs = [];
    const tempos = [];
    while (i < end) {
        let delta;
        [delta, i] = readVlq(b, i);
        tick += delta;
        if (i >= end) break;
        let status = b[i];
        if (status < 0x80) status = running;
        else {
            i++;
            if (status < 0xf0) running = status;
        }
        if (status === 0xff) {
            const meta = b[i++];
            let len;
            [len, i] = readVlq(b, i);
            const data = b.subarray(i, i + len);
            i += len;
            if (meta === 0x51 && data.length >= 3) {
                tempos.push({ tick, uspq: (data[0] << 16) | (data[1] << 8) | data[2] });
            } else if (meta === 0x03) {
                name = new TextDecoder().decode(data);
            } else if (meta === 0x2f) break;
            continue;
        }
        if (status === 0xf0 || status === 0xf7) {
            let len;
            [len, i] = readVlq(b, i);
            i += len;
            continue;
        }
        if (status < 0x80) break;
        const type = status & 0xf0;
        const one = type === 0xc0 || type === 0xd0;
        const a = b[i++] & 127;
        const c = one || i >= end ? 0 : b[i++] & 127;
        evs.push({ tick, type, ch: status & 15, a, b: c });
    }
    return { name, evs, tempos };
}

function tickToMs(tick, map, division) {
    if (division & 0x8000) {
        const frames = (division >> 8) & 0x7f;
        const fps = frames === 29 ? 29.97 : frames || 25;
        const tpf = division & 0xff || 1;
        return (tick / (fps * tpf)) * 1000;
    }
    const ppq = division || PPQ;
    let ms = 0;
    const points = map.length ? map : [{ tick: 0, uspq: DEFAULT_USPQ }];
    for (let i = 0; i < points.length; i++) {
        const start = points[i].tick;
        if (start >= tick) break;
        const end = i + 1 < points.length ? Math.min(tick, points[i + 1].tick) : tick;
        ms += ((end - start) * points[i].uspq) / ppq / 1000;
    }
    return ms;
}

export function parseMidi(buffer) {
    const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (b.length < 14 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'MThd') {
        throw new Error('不是 MIDI 文件');
    }
    const headerLen = readU32(b, 4);
    let ntrks = readU16(b, 10);
    let division = readU16(b, 12);
    // 早期导出会在头里多写一个 4 字节长度，分辨率因此被读成 1。
    if (headerLen === 10 && readU32(b, 8) === 6) {
        ntrks = readU16(b, 14);
        division = readU16(b, 16);
    }
    let pos = 8 + headerLen;
    const tracks = [];
    for (let t = 0; t < ntrks && pos + 8 <= b.length; t++) {
        if (String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]) !== 'MTrk') break;
        const len = readU32(b, pos + 4);
        const end = Math.min(b.length, pos + 8 + len);
        tracks.push(parseTrack(b, pos + 8, end));
        pos = end;
    }
    const map = [{ tick: 0, uspq: DEFAULT_USPQ }];
    for (const tr of tracks) map.push(...tr.tempos);
    map.sort((x, y) => x.tick - y.tick);
    const out = [];
    for (let t = 0; t < tracks.length; t++) {
        const tr = tracks[t];
        const named = /^ch-(\d+)(d)?$/.exec((tr.name || '').trim());
        const fixedCh = named ? Number(named[1]) : null;
        const drumTrack = !!(named && named[2]);
        const trkName = (tr.name || '').trim();
        for (const e of tr.evs) {
            if (e.type < 0x80 || e.type > 0xe0) continue;
            out.push({
                ms: tickToMs(e.tick, map, division),
                live: e.type !== 0xc0 && !(e.type === 0xb0 && (e.a === 0 || e.a === 32)),
                ch: fixedCh == null ? e.ch : fixedCh,
                type: e.type,
                a: e.a,
                b: e.b,
                drum: e.type === 0xc0 && (drumTrack || (fixedCh == null && e.ch === 9)),
                trk: t,
                trkName: trkName || undefined,
            });
        }
    }
    out.sort((a, c) => a.ms - c.ms);
    return out;
}

export function loadPerformance(list) {
    stopPlayback();
    events = (list || []).map((e, i) => ({ ...e, ord: i }));
    invalidatePerformanceCaches();
    const trks = new Set(events.map((e) => e.trk).filter((t) => t != null));
    importedSmfMultiTrack = trks.size > 1;
    getJianpuTrackMode();
    seq = events.length;
    capturing = false;
    held.clear();
}

let playing = false;
/** @type {null | (() => void)} */
let playTick = null;
let playT0 = 0;
let playClockPaused = 0;
let playClockPauseStart = 0;
const PLAY_EVENTS_PER_STEP = 24;

function playbackTimelineMs() {
    let pause = playClockPaused;
    if (playClockPauseStart) pause += performance.now() - playClockPauseStart;
    return performance.now() - playT0 - pause;
}

/** 应用休眠/唤醒：冻结时间轴，避免积压事件一口气播完 */
export function onPlaybackVisibility(hidden) {
    if (!playing) return;
    if (hidden) {
        if (!playClockPauseStart) playClockPauseStart = performance.now();
        if (playTimer) {
            clearTimeout(playTimer);
            playTimer = 0;
        }
        return;
    }
    if (playClockPauseStart) {
        playClockPaused += performance.now() - playClockPauseStart;
        playClockPauseStart = 0;
    }
    if (playTick) playTick();
}

export function isPlaying() {
    return playing;
}

export function recordingElapsedMs() {
    if (!capturing) return performanceDurationMs();
    return Math.max(0, performance.now() - startedAt);
}

export function playbackElapsedMs() {
    if (!playing) return 0;
    return Math.max(0, performance.now() - playStarted);
}

export function stopPlayback(noteOff) {
    const was = playing;
    playing = false;
    playGen++;
    if (playTimer) {
        clearTimeout(playTimer);
        playTimer = 0;
    }
    const notes = playNotes;
    playNotes = [];
    if (was && noteOff) {
        for (const n of notes) noteOff(n.ch, n.note);
    }
    suppress = false;
    playTick = null;
    playClockPaused = 0;
    playClockPauseStart = 0;
    return was;
}

export function playPerformance(sink, onDone) {
    if (playing) stopPlayback();
    const list = sortedEvents();
    if (!list.length) {
        if (onDone) onDone();
        return;
    }
    playing = true;
    const gen = ++playGen;
    suppress = true;
    playNotes = [];
    playStarted = performance.now();
    playT0 = playStarted;
    playClockPaused = 0;
    playClockPauseStart = 0;
    const banks = new Map();
    let i = 0;
    const finish = () => {
        if (gen !== playGen) return;
        playing = false;
        playGen++;
        playTimer = 0;
        playTick = null;
        playClockPaused = 0;
        playClockPauseStart = 0;
        const hanging = playNotes;
        playNotes = [];
        for (const n of hanging) {
            sink({
                type: 0x80,
                ch: n.ch,
                a: n.note,
                b: 0,
                trk: n.trk,
                drum: n.drum,
                bank: { msb: 0, lsb: 0 },
            });
        }
        suppress = false;
        if (onDone) onDone();
    };
    const step = () => {
        if (gen !== playGen) return;
        playTick = step;
        const elapsed = playbackTimelineMs();
        let burst = 0;
        while (i < list.length && list[i].ms <= elapsed + 2 && burst < PLAY_EVENTS_PER_STEP) {
            burst++;
            const e = list[i++];
            if (e.type === 0xb0 && (e.a === 0 || e.a === 32)) {
                const bank = banks.get(e.ch) || { msb: 0, lsb: 0 };
                if (e.a === 0) bank.msb = e.b;
                else bank.lsb = e.b;
                banks.set(e.ch, bank);
            }
            if (e.type === 0x90 && e.b > 0) {
                playNotes.push({ ch: e.ch, note: e.a, trk: e.trk, drum: e.drum });
            } else if (e.type === 0x80 || (e.type === 0x90 && e.b === 0)) {
                for (let pi = playNotes.length - 1; pi >= 0; pi--) {
                    const n = playNotes[pi];
                    if (n.ch === e.ch && n.note === e.a) playNotes.splice(pi, 1);
                }
            }
            const bank = banks.get(e.ch) || { msb: 0, lsb: 0 };
            sink({ ...e, bank });
        }
        if (gen !== playGen) return;
        if (i < list.length) {
            const wait = Math.max(0, list[i].ms - elapsed);
            playTimer = setTimeout(step, Math.min(wait, 40));
        } else finish();
    };
    step();
}

export function midiFileBase64() {
    const bytes = toMidiBytes();
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(bin);
}

export function downloadMidiFile(filename) {
    const bytes = toMidiBytes();
    const blob = new Blob([bytes], { type: 'audio/midi' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
