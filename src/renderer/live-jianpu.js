/**
 * 多轨简谱时间轴：参考 midi_jianpu_player.html 的小节+数字排版，横轴按小节对齐时间。
 */
import { DRUM_NOTES } from './gm.js';
import { buildTrackNoteIndex } from './performance-midi.js';
import { isElectron, isMobile } from './platform.js';

const MAX_NOTES_PER_LANE = isMobile() ? 650 : isElectron() ? 900 : 1200;
const LANE_LABEL_W = 96;
const MEASURE_MS = 2000;
const BEAT_MS = 500;
const CHORD_MS = 48;
/** 单音 + 高低音点的基准行高（px） */
const LANE_BASE_H = 46;
/** 和弦每多叠一个音增加的高度 */
const LANE_STACK_STEP = 18;
const DENSE_CHORD_N = 3;
const DENSE_MEASURE_N = 14;
/** 小节内相邻事件最小水平间距（px） */
const EVENT_GAP = 4;
const MAX_COLLISION_ROWS = 6;
/** 小节右缘留给分格线的空白（px），音符不进入此区 */
const MEASURE_GUTTER = 8;
/** 单页最多显示轨数（防止极高叠加轨拖垮性能） */
const MAX_TRACKS_PER_PAGE = isMobile() ? 8 : 12;
const TRACKS_PER_VIEW_FALLBACK = isMobile() ? 2 : 3;

const MAJOR = [0, 2, 4, 5, 7, 9, 11];

function eventMinWidth(dense, chordSize) {
    if (dense || chordSize >= DENSE_CHORD_N) return 14;
    if (chordSize >= 2) return 17;
    return 20;
}

function listToBatches(list) {
    const batches = [];
    let i = 0;
    while (i < list.length) {
        const batch = [list[i]];
        let j = i + 1;
        while (j < list.length && list[j].ms - list[i].ms < CHORD_MS) {
            batch.push(list[j]);
            j++;
        }
        const gap = j < list.length ? list[j].ms - batch[0].ms : BEAT_MS;
        batches.push({ batch, durKey: durClassFromGap(gap), ms: batch[0].ms });
        i = j;
    }
    return batches;
}

/** 时间对齐 + 水平防叠：放不下则换「子行」或略向右让位 */
function layoutMeasureEvents(metaList, measW, maxRows, dense) {
    const sorted = metaList.slice().sort((a, b) => a.idealLeft - b.idealLeft);
    const rowEnds = new Array(maxRows).fill(0);
    let maxRowUsed = 0;
    const placements = [];
    for (const item of sorted) {
        const w = item.minW;
        let pick = { left: item.idealLeft, row: 0 };
        for (let r = 0; r < maxRows; r++) {
            const minLeft = rowEnds[r] > 0 ? rowEnds[r] + EVENT_GAP : 0;
            const left = Math.max(item.idealLeft, minLeft);
            if (
                r === 0
                || left < pick.left
                || (left === pick.left && r < pick.row)
            ) {
                pick = { left, row: r };
            }
        }
        if (pick.left > item.idealLeft + 0.5) item._shifted = true;
        rowEnds[pick.row] = pick.left + w;
        maxRowUsed = Math.max(maxRowUsed, pick.row);
        placements.push({ ...item, ...pick });
    }
    return { placements, rowCount: maxRowUsed + 1 };
}

function clampMidi(n) {
    return Math.max(0, Math.min(127, Math.round(n)));
}

function guessKey(pitches) {
    const hist = {};
    for (const p of pitches) {
        const k = (p | 0) % 12;
        hist[k] = (hist[k] || 0) + 1;
    }
    let best = 0;
    let score = -1;
    for (let t = 0; t < 12; t++) {
        let s = 0;
        for (const off of MAJOR) s += hist[(t + off) % 12] || 0;
        if (s > score) {
            score = s;
            best = t;
        }
    }
    return best;
}

/** @returns {{ digit: string, high: number, low: number, acc: boolean }} */
function glyph(midiNum, tonic) {
    const n = clampMidi(midiNum);
    const rel = ((n % 12) - tonic + 12) % 12;
    /** 中央 C = MIDI 60 → 无高低点；每 12 半音一个点 */
    const oct = Math.floor(n / 12) - 5;
    let digit;
    let acc = false;
    const i = MAJOR.indexOf(rel);
    if (i >= 0) digit = String(i + 1);
    else {
        let ni = 0;
        let d = 99;
        MAJOR.forEach((off, j) => {
            const dd = Math.min(Math.abs(off - rel), 12 - Math.abs(off - rel));
            if (dd < d) {
                d = dd;
                ni = j;
            }
        });
        digit = String(ni + 1);
        acc = true;
    }
    return {
        digit: acc ? `${digit}♯` : digit,
        high: Math.min(Math.max(oct, 0), 3),
        low: oct < 0 ? Math.min(-oct, 3) : 0,
        acc,
    };
}

function durClassFromGap(gapMs) {
    const q = gapMs / BEAT_MS;
    if (q >= 3.5) return 'whole';
    if (q >= 1.9) return 'half';
    if (q >= 1.4) return 'dotted';
    if (q >= 0.9) return 'quarter';
    if (q >= 0.4) return 'eighth';
    return 'sixteenth';
}

/** @param {number} count @param {'jp-high' | 'jp-low'} place */
function appendOctaveDots(stack, count, place) {
    const n = count | 0;
    if (n <= 0) return;
    const wrap = document.createElement('span');
    wrap.className = `${place} jp-oct-wrap`;
    wrap.textContent = '·'.repeat(n);
    wrap.setAttribute('aria-hidden', 'true');
    stack.appendChild(wrap);
}

function buildNoteEl(g, durKey, { drum = false, drumText = '' } = {}) {
    const note = document.createElement('span');
    note.className = `jp-note dur-${durKey}${drum ? ' drum' : ''}`;
    if (drum) {
        const core = document.createElement('span');
        core.className = 'jp-n';
        core.textContent = drumText || '?';
        note.appendChild(core);
        return note;
    }
    const head = document.createElement('span');
    head.className = 'jp-head';
    const stack = document.createElement('span');
    stack.className = 'jp-n-stack';
    appendOctaveDots(stack, g.high, 'jp-high');
    const core = document.createElement('span');
    core.className = 'jp-n';
    core.textContent = g.digit;
    stack.appendChild(core);
    appendOctaveDots(stack, g.low, 'jp-low');
    head.appendChild(stack);
    if (durKey === 'dotted') {
        const durDot = document.createElement('span');
        durDot.className = 'jp-dur-dot';
        durDot.textContent = '·';
        head.appendChild(durDot);
    }
    note.appendChild(head);
    if (durKey === 'eighth' || durKey === 'sixteenth') {
        const ul = document.createElement('span');
        ul.className = 'jp-ul';
        note.appendChild(ul);
        if (durKey === 'sixteenth') {
            const ul2 = document.createElement('span');
            ul2.className = 'jp-ul jp-ul2';
            note.appendChild(ul2);
        }
    }
    if (durKey === 'half') note.classList.add('dur-half-line');
    if (durKey === 'whole') note.classList.add('dur-whole-line');
    return note;
}

/** @deprecated 导出保留 */
export function midiToJianpu(midi, { transpose = 0, drum = false } = {}) {
    const n = clampMidi(midi + transpose);
    if (drum) {
        const name = DRUM_NOTES[n];
        return { drum: true, text: name || String(n) };
    }
    const g = glyph(n, 0);
    return { drum: false, text: g.digit, num: parseInt(g.digit, 10) || 0 };
}

function batchSizesInList(list) {
    const sizes = [];
    let i = 0;
    while (i < list.length) {
        let j = i + 1;
        while (j < list.length && list[j].ms - list[i].ms < CHORD_MS) j++;
        sizes.push(j - i);
        i = j;
    }
    return sizes;
}

/** 和弦叠音 + 小节内防叠行数 → 行高 */
function scanLaneLayout(notes, pxPerMs) {
    const byMeas = new Map();
    for (const e of notes) {
        const mi = Math.floor(e.ms / MEASURE_MS);
        if (!byMeas.has(mi)) byMeas.set(mi, []);
        byMeas.get(mi).push(e);
    }
    let maxChord = 1;
    let maxMeasNotes = 0;
    let maxHRows = 1;
    const ppm = pxPerMs || 0.05;
    const measW = MEASURE_MS * ppm;

    for (const [mi, raw] of byMeas.entries()) {
        const list = raw.slice().sort((a, b) => a.ms - b.ms);
        maxMeasNotes = Math.max(maxMeasNotes, list.length);
        const dense = list.length >= DENSE_MEASURE_N;
        for (const sz of batchSizesInList(list)) maxChord = Math.max(maxChord, sz);
        const meta = listToBatches(list).map((b) => ({
            idealLeft: (b.ms - mi * MEASURE_MS) * ppm,
            minW: eventMinWidth(dense, b.batch.length),
            chordSize: b.batch.length,
        }));
        const { rowCount } = layoutMeasureEvents(meta, measW, MAX_COLLISION_ROWS, dense);
        maxHRows = Math.max(maxHRows, rowCount);
    }

    const verticalNeed = Math.max(1, Math.min(8, Math.max(maxChord, maxHRows)));
    const railHeight = LANE_BASE_H + (verticalNeed - 1) * LANE_STACK_STEP;
    return {
        maxStack: verticalNeed,
        maxMeasNotes,
        railHeight,
    };
}

function collectTrackNotes(trackId, noteIndex) {
    let notes = noteIndex?.get(trackId);
    if (!notes?.length) notes = [];
    if (notes.length > MAX_NOTES_PER_LANE) notes = notes.slice(0, MAX_NOTES_PER_LANE);
    return notes;
}

function buildMeasureIndex(notes) {
    const byMeas = new Map();
    for (const e of notes) {
        const mi = Math.floor(e.ms / MEASURE_MS);
        if (!byMeas.has(mi)) byMeas.set(mi, []);
        byMeas.get(mi).push(e);
    }
    const mel = notes.filter((e) => !e.drum && (e.ch | 0) !== 9).map((e) => e.a | 0);
    const tonic = mel.length ? guessKey(mel) : 0;
    return { byMeas, tonic };
}

function appendMeasures(rail, index, routeForChannel, layout, miFrom, miTo, pageMiStart) {
    const { byMeas, tonic } = index;
    const ppm = rail._pxPerMs;
    for (let mi = miFrom; mi < miTo; mi++) {
        const meas = document.createElement('div');
        meas.className = 'jp-measure';
        const left = (mi - pageMiStart) * MEASURE_MS * ppm;
        const w = MEASURE_MS * rail._pxPerMs;
        meas.style.left = `${left}px`;
        meas.style.width = `${w}px`;

        const list = (byMeas.get(mi) || []).slice().sort((a, b) => a.ms - b.ms);
        const dense = list.length >= DENSE_MEASURE_N;
        if (dense) meas.classList.add('jp-measure-dense');

        const pending = [];
        for (const { batch, durKey, ms } of listToBatches(list)) {
            const ev = document.createElement('span');
            ev.className = 'jp-event';
            ev.dataset.ms = String(ms);
            if (batch.length >= 2) ev.classList.add(`jp-event-stack-${Math.min(8, batch.length)}`);
            if (batch.length >= DENSE_CHORD_N) ev.classList.add('jp-event-dense');

            if (batch.length === 1) {
                const e = batch[0];
                const route = routeForChannel(e.ch | 0, e.drum);
                const drum = !!(route.isDrum || e.drum);
                if (drum) {
                    const txt = DRUM_NOTES[e.a | 0] || String(e.a | 0);
                    ev.appendChild(buildNoteEl(null, durKey, { drum: true, drumText: txt }));
                } else {
                    const midi = (e.a | 0) + (route.transpose || 0);
                    ev.appendChild(buildNoteEl(glyph(midi, tonic), durKey));
                }
            } else {
                const chord = document.createElement('span');
                chord.className = 'jp-chord';
                if (batch.length >= DENSE_CHORD_N) chord.classList.add('jp-chord-dense');
                for (const e of batch.slice().sort((a, b) => (b.a | 0) - (a.a | 0))) {
                    const route = routeForChannel(e.ch | 0, e.drum);
                    const midi = (e.a | 0) + (route.transpose || 0);
                    chord.appendChild(buildNoteEl(glyph(midi, tonic), durKey));
                }
                ev.appendChild(chord);
            }

            pending.push({
                ev,
                idealLeft: (ms - mi * MEASURE_MS) * ppm,
                minW: eventMinWidth(dense, batch.length),
            });
        }

        const contentW = Math.max(12, w - MEASURE_GUTTER);
        const { placements } = layoutMeasureEvents(pending, contentW, MAX_COLLISION_ROWS, dense);
        const rowStep = Math.max(
            13,
            Math.floor(((layout?.railHeight || LANE_BASE_H) - 8) / MAX_COLLISION_ROWS),
        );

        for (const p of placements) {
            const { ev, left, row, _shifted } = p;
            if (_shifted) ev.classList.add('jp-event-shifted');
            ev.style.left = `${left}px`;
            ev.style.bottom = `${4 + row * rowStep}px`;
            meas.appendChild(ev);
        }
        rail.appendChild(meas);
    }
}

function fillLaneRailPage(rail, notes, routeForChannel, layout, miStart, miEnd) {
    rail.style.width = '100%';
    rail.style.minWidth = '0';
    if (layout?.railHeight) {
        rail.style.height = `${layout.railHeight}px`;
        rail.style.minHeight = `${layout.railHeight}px`;
    }
    const index = buildMeasureIndex(notes);
    appendMeasures(rail, index, routeForChannel, layout, miStart, miEnd, miStart);
}

export class LiveJianpuPanel {
    constructor(root) {
        this.root = root;
        this.streamWrap = root?.querySelector('.live-jianpu-stream-wrap');
        this.scrollEl = root?.querySelector('.jp-timeline-scroll');
        this.innerEl = root?.querySelector('.jp-timeline-inner');
        this.playheadEl = root?.querySelector('.jp-playhead');
        this.lanesHost = root?.querySelector('.jp-lanes') || root?.querySelector('.live-jianpu-pages');
        this.pagerBar = root?.querySelector('.jp-pager-bar');
        this.trackPageEl = root?.querySelector('#jp-track-page');
        this.timePageEl = root?.querySelector('#jp-time-page');
        this.hasScore = false;
        this.durationMs = 0;
        this.pxPerMs = 0.04;
        this._pianoMetrics = null;
        this._loadGen = 0;
        /** @type {Set<string>} */
        this.mutedTracks = new Set();
        /** @type {Map<string, HTMLElement>} */
        this.laneEls = new Map();
        this._playheadPx = -1;
        this._lastPlayheadMs = 0;
        this._scoreCtx = null;
        this._trackPage = 0;
        this._timePage = 0;
        this._measuresPerView = 6;
        this._nMeas = 0;
        this._trackPageCount = 1;
        this._timePageCount = 1;
        /** @type {{ start: number, count: number }[]} */
        this._trackSlices = [];
        this._lastAvailH = -1;
        this._bindPager();
    }

    _bindPager() {
        if (!this.pagerBar || this.pagerBar.dataset.bound) return;
        this.pagerBar.dataset.bound = '1';
        this.pagerBar.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-page]');
            if (!btn) return;
            this._onPageNav(btn.getAttribute('data-page'));
        });
    }

    _calcMeasuresPerView(viewW) {
        const usable = Math.max(160, (viewW | 0) - LANE_LABEL_W);
        const perMeasPxTarget = isMobile() ? 72 : 88;
        return Math.max(3, Math.min(6, Math.floor(usable / perMeasPxTarget)));
    }

    _viewRailWidthPx() {
        const viewW = this.scrollEl?.clientWidth || this.streamWrap?.clientWidth || 480;
        return Math.max(120, (viewW | 0) - LANE_LABEL_W);
    }

    _syncPxPerMsForPage(pageMeas) {
        const count = Math.max(1, pageMeas | 0);
        const usable = this._viewRailWidthPx();
        this.pxPerMs = usable / count / MEASURE_MS;
    }

    _availableLaneHeightPx() {
        const box = this.scrollEl || this.streamWrap;
        let h = box?.clientHeight || 0;
        if (h < 32 && this.root?.parentElement) {
            const pane = document.getElementById('pane-play');
            const pr = pane?.getBoundingClientRect();
            const jr = this.root.getBoundingClientRect();
            if (pr?.height && jr.height) h = Math.max(h, jr.height);
            else if (pr?.height) h = Math.max(h, pr.height * 0.38);
        }
        const pagerOn = this.pagerBar && !this.pagerBar.classList.contains('hidden');
        const pager = pagerOn ? (this.pagerBar.offsetHeight || 22) : 0;
        return Math.max(40, (h | 0) - pager - 2);
    }

    _laneHeightForTrack(trackMeta, ctx) {
        const notes = collectTrackNotes(trackMeta.id, ctx.noteIndex);
        if (!notes.length) return LANE_BASE_H + 1;
        return scanLaneLayout(notes, this.pxPerMs).railHeight + 1;
    }

    _rebuildTrackSlices() {
        const ctx = this._scoreCtx;
        if (!ctx?.playable?.length) {
            this._trackSlices = [];
            this._trackPageCount = 1;
            return;
        }
        const available = this._availableLaneHeightPx();
        const slices = [];
        let i = 0;
        while (i < ctx.playable.length) {
            let used = 0;
            let count = 0;
            while (i + count < ctx.playable.length && count < MAX_TRACKS_PER_PAGE) {
                const h = this._laneHeightForTrack(ctx.playable[i + count], ctx);
                if (count > 0 && used + h > available) break;
                used += h;
                count++;
            }
            if (!count) {
                count = 1;
            }
            slices.push({ start: i, count });
            i += count;
        }
        this._trackSlices = slices;
        this._trackPageCount = Math.max(1, slices.length);
        this._lastAvailH = available;
        if (this._trackPage >= this._trackPageCount) {
            this._trackPage = Math.max(0, this._trackPageCount - 1);
        }
    }

    _rebuildTrackSlicesIfNeeded() {
        const h = this._availableLaneHeightPx();
        if (this._trackSlices.length && Math.abs(h - this._lastAvailH) < 6) return;
        this._rebuildTrackSlices();
    }

    _onPageNav(action) {
        if (!this._scoreCtx || this._scoreCtx.gen !== this._loadGen) return;
        if (action === 'time-prev' && this._timePage > 0) {
            this._timePage--;
            this.renderCurrentPage();
        } else if (action === 'time-next' && this._timePage < this._timePageCount - 1) {
            this._timePage++;
            this.renderCurrentPage();
        } else if (action === 'track-prev' && this._trackPage > 0) {
            this._trackPage--;
            this.renderCurrentPage();
        } else if (action === 'track-next' && this._trackPage < this._trackPageCount - 1) {
            this._trackPage++;
            this.renderCurrentPage();
        }
    }

    _updatePagerUi() {
        const tp = this._trackPage + 1;
        const tt = this._trackPageCount;
        const mp = this._timePage + 1;
        const mt = this._timePageCount;
        if (this.trackPageEl) this.trackPageEl.textContent = tt > 1 ? `${tp}/${tt}` : '';
        if (this.timePageEl) this.timePageEl.textContent = mt > 1 ? `${mp}/${mt}` : '';
        if (!this.pagerBar) return;
        const prevT = this.pagerBar.querySelector('[data-page="track-prev"]');
        const nextT = this.pagerBar.querySelector('[data-page="track-next"]');
        const prevM = this.pagerBar.querySelector('[data-page="time-prev"]');
        const nextM = this.pagerBar.querySelector('[data-page="time-next"]');
        if (prevT) prevT.disabled = this._trackPage <= 0;
        if (nextT) nextT.disabled = this._trackPage >= this._trackPageCount - 1;
        if (prevM) prevM.disabled = this._timePage <= 0;
        if (nextM) nextM.disabled = this._timePage >= this._timePageCount - 1;
        const hideTrack = this._trackPageCount <= 1;
        const hideTime = this._timePageCount <= 1;
        this.pagerBar.querySelector('.jp-pager-tracks')?.classList.toggle('hidden', hideTrack);
        this.pagerBar.querySelector('.jp-pager-time')?.classList.toggle('hidden', hideTime);
        this.pagerBar.classList.toggle('hidden', hideTrack && hideTime);
    }

    renderCurrentPage() {
        const ctx = this._scoreCtx;
        if (!ctx || ctx.gen !== this._loadGen || !this.lanesHost) return;

        const miStart = this._timePage * this._measuresPerView;
        const miEnd = Math.min(this._nMeas, miStart + this._measuresPerView);
        const pageMeas = Math.max(1, miEnd - miStart);
        this._syncPxPerMsForPage(pageMeas);
        if (this.innerEl) this.innerEl.style.width = '100%';

        this._rebuildTrackSlicesIfNeeded();
        const slice = this._trackSlices[this._trackPage];
        if (!slice && ctx.playable.length) {
            this._rebuildTrackSlices();
        }
        const trkSlice = this._trackSlices[this._trackPage] || {
            start: 0,
            count: Math.min(TRACKS_PER_VIEW_FALLBACK, ctx.playable.length),
        };

        this.laneEls.clear();
        this.lanesHost.innerHTML = '';

        const tracks = ctx.playable.slice(trkSlice.start, trkSlice.start + trkSlice.count);

        for (const t of tracks) {
            const notes = collectTrackNotes(t.id, ctx.noteIndex);
            if (!notes.length) continue;
            const layout = scanLaneLayout(notes, this.pxPerMs);

            const lane = document.createElement('div');
            lane.className = 'jp-lane';
            lane.classList.add(`jp-lane-stack-${layout.maxStack}`);
            if (layout.maxMeasNotes >= DENSE_MEASURE_N) lane.classList.add('jp-lane-busy');
            lane.style.minHeight = `${layout.railHeight}px`;
            lane.dataset.trackId = t.id;
            lane.title = '点本行：静音（变灰）/ 再点恢复';
            if (this.mutedTracks.has(t.id)) lane.classList.add('muted');

            const label = document.createElement('button');
            label.type = 'button';
            label.className = 'jp-lane-label';
            label.style.minHeight = `${layout.railHeight}px`;
            label.textContent = t.name;
            label.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this.toggleTrackMute(t.id);
            });
            lane.addEventListener('click', () => this.toggleTrackMute(t.id));
            lane.style.cursor = 'pointer';

            const rail = document.createElement('div');
            rail.className = 'jp-lane-rail';
            rail._pxPerMs = this.pxPerMs;
            fillLaneRailPage(rail, notes, ctx.routeForChannel, layout, miStart, miEnd);

            lane.appendChild(label);
            lane.appendChild(rail);
            this.lanesHost.appendChild(lane);
            this.laneEls.set(t.id, lane);
        }

        this._updatePagerUi();
        this._playheadPx = -1;
        this.setPlayheadMs(this._lastPlayheadMs, { autoPage: false });
    }

    setPianoMetricsHook(fn) {
        this._pianoMetrics = typeof fn === 'function' ? fn : null;
    }

    onPlayTab() {
        const pane = document.getElementById('pane-play');
        return !!(pane && pane.classList.contains('active'));
    }

    isLandscape() {
        return document.documentElement.dataset.orient === 'landscape';
    }

    shouldShow() {
        return this.onPlayTab() && this.hasScore && this.isLandscape();
    }

    syncPaneLayout() {
        const pane = document.getElementById('pane-play');
        if (pane) pane.classList.toggle('has-accomp-score', this.shouldShow());
        if (this._pianoMetrics && document.documentElement.dataset.orient === 'portrait') {
            this._pianoMetrics();
        }
    }

    syncVisible() {
        if (!this.root) return;
        const show = this.shouldShow();
        this.root.classList.toggle('hidden', !show);
        this.root.setAttribute('aria-hidden', show ? 'false' : 'true');
        this.syncPaneLayout();
        if (!show && this._pianoMetrics && !this.isLandscape()) {
            this._pianoMetrics();
        }
        if (show && this.hasScore && this._scoreCtx) {
            requestAnimationFrame(() => {
                this._lastAvailH = -1;
                this.renderCurrentPage();
            });
        }
    }

    setStatus() {
        /* 说明文字已去掉，省竖屏空间 */
    }

    setPracticeTitle(text) {
        if (this.root && text) this.root.setAttribute('aria-label', text);
    }

    clearScore() {
        this._loadGen += 1;
        this._scoreCtx = null;
        this._trackPage = 0;
        this._timePage = 0;
        this._trackSlices = [];
        this._lastAvailH = -1;
        this.hasScore = false;
        this.durationMs = 0;
        this.mutedTracks.clear();
        this.laneEls.clear();
        if (this.lanesHost) this.lanesHost.innerHTML = '';
        if (this.innerEl) this.innerEl.style.width = '';
        this._playheadPx = -1;
        this.setPlayheadMs(0);
        this.syncVisible();
    }

    isTrackMuted(trackId) {
        return !!(trackId && this.mutedTracks.has(trackId));
    }

    toggleTrackMute(trackId) {
        if (!trackId) return;
        if (this.mutedTracks.has(trackId)) this.mutedTracks.delete(trackId);
        else this.mutedTracks.add(trackId);
        const lane = this.laneEls.get(trackId);
        if (lane) lane.classList.toggle('muted', this.mutedTracks.has(trackId));
    }

    loadMultiTrackTimeline(allEvents, trackMeta, durationMs, routeForChannel) {
        if (!this.lanesHost || !this.innerEl) return 0;
        const gen = ++this._loadGen;
        this._scoreCtx = null;
        this.hasScore = false;
        this.mutedTracks.clear();
        this.laneEls.clear();
        this.lanesHost.innerHTML = '';
        this._trackPage = 0;
        this._timePage = 0;
        this._lastPlayheadMs = 0;

        const dur = Math.max(MEASURE_MS, durationMs || MEASURE_MS);
        this.durationMs = dur;
        const viewW = this.scrollEl?.clientWidth || this.streamWrap?.clientWidth || 480;
        this._measuresPerView = this._calcMeasuresPerView(viewW);
        this._nMeas = Math.ceil(dur / MEASURE_MS);
        this._timePageCount = Math.max(1, Math.ceil(this._nMeas / this._measuresPerView));
        this._lastAvailH = -1;

        const playable = (trackMeta || []).filter((t) => t.noteOns > 0);
        const noteIndex = buildTrackNoteIndex(playable.map((t) => t.id));
        let totalNotes = 0;
        for (const t of playable) totalNotes += (noteIndex.get(t.id)?.length || 0);
        const laneCount = playable.length;

        if (gen !== this._loadGen) return 0;
        if (!laneCount) {
            this.hasScore = false;
            this._updatePagerUi();
            return 0;
        }

        this._scoreCtx = {
            gen,
            allEvents,
            playable,
            dur,
            routeForChannel,
            noteIndex,
        };
        this.hasScore = laneCount > 0;
        this.setPracticeTitle(laneCount ? `简谱 ${laneCount} 轨` : '简谱');
        this.syncVisible();
        requestAnimationFrame(() => {
            if (gen !== this._loadGen) return;
            this.renderCurrentPage();
            this.setPlayheadMs(0, { autoPage: false });
        });
        return totalNotes;
    }

    /**
     * 仅渲染当前时间页；播放时自动翻时间页，竖线用 transform。
     */
    setPlayheadMs(ms, { autoPage = true } = {}) {
        if (!this.playheadEl) return;
        this._lastPlayheadMs = Math.max(0, ms | 0);
        if (!this._measuresPerView || !this._timePageCount) return;

        const needTimePage = Math.floor(this._lastPlayheadMs / MEASURE_MS / this._measuresPerView);
        if (
            autoPage
            && needTimePage !== this._timePage
            && needTimePage >= 0
            && needTimePage < this._timePageCount
        ) {
            this._timePage = needTimePage;
            this.renderCurrentPage();
            return;
        }

        const pageStartMs = this._timePage * this._measuresPerView * MEASURE_MS;
        const pageEndMs = pageStartMs + this._measuresPerView * MEASURE_MS;
        if (this._lastPlayheadMs < pageStartMs || this._lastPlayheadMs >= pageEndMs) {
            this.playheadEl.style.opacity = '0';
            return;
        }
        this.playheadEl.style.opacity = '1';
        const x = Math.round(LANE_LABEL_W + (this._lastPlayheadMs - pageStartMs) * this.pxPerMs);
        if (x === this._playheadPx) return;
        this._playheadPx = x;
        this.playheadEl.style.transform = `translate3d(${x}px,0,0)`;
    }

    resetPlaybackCursor() {
        this._timePage = 0;
        this._lastPlayheadMs = 0;
        if (this._scoreCtx) this.renderCurrentPage();
        else this.setPlayheadMs(0, { autoPage: false });
    }

    loadScoreSync() {
        return 0;
    }

    async loadScoreAsync() {
        return 0;
    }

    clear() {
        this.clearScore();
    }
}