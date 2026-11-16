/**
 * 伴奏 MIDI 跟奏简谱：多行分页静态排版，播放时仅高亮移动，整页播完切下一页。
 */
import { DRUM_NOTES } from './gm.js';
import { performanceNoteKey } from './performance-midi.js';
const REF_OCTAVE = 4;
const BUILD_CHUNK = 72;
const SCORE_MAX = 1200;
const ROWS_PER_PAGE = 4;
const PCS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const JIANPU_NUM = { C: 1, D: 2, E: 3, F: 4, G: 5, A: 6, B: 7 };

function clampMidi(n) {
    return Math.max(0, Math.min(127, Math.round(n)));
}

/** @returns {{ drum: boolean, text: string, num?: number, acc?: string, high?: number, low?: number }} */
export function midiToJianpu(midi, { transpose = 0, drum = false } = {}) {
    const n = clampMidi(midi + transpose);
    if (drum) {
        const name = DRUM_NOTES[n];
        if (name) return { drum: true, text: name };
        return { drum: true, text: String(n) };
    }
    const pc = n % 12;
    const letter = PCS[pc].replace('#', '');
    const num = JIANPU_NUM[letter] ?? 0;
    const acc = PCS[pc].includes('#') ? '♯' : '';
    const oct = Math.floor(n / 12) - 1;
    const shift = oct - REF_OCTAVE;
    return {
        drum: false,
        text: `${num}${acc}`,
        num,
        acc,
        high: shift > 0 ? shift : 0,
        low: shift < 0 ? -shift : 0,
    };
}

function spanForJianpu(j, { underlines = 0 } = {}) {
    const el = document.createElement('span');
    el.className = `jp-cell${j.drum ? ' drum' : ''}`;
    if (j.drum) {
        el.textContent = j.text;
        return el;
    }
    if (j.high) {
        const d = document.createElement('span');
        d.className = 'jp-dots high';
        d.textContent = '·'.repeat(Math.min(3, j.high));
        el.appendChild(d);
    }
    const core = document.createElement('span');
    core.className = 'jp-num';
    core.textContent = String(j.num || '?');
    el.appendChild(core);
    if (j.acc) {
        const a = document.createElement('span');
        a.className = 'jp-acc';
        a.textContent = j.acc;
        el.appendChild(a);
    }
    if (j.low) {
        const d = document.createElement('span');
        d.className = 'jp-dots low';
        d.textContent = '·'.repeat(Math.min(3, j.low));
        el.appendChild(d);
    }
    if (underlines > 0) {
        const u = document.createElement('span');
        u.className = 'jp-underlines';
        u.textContent = '—'.repeat(Math.min(2, underlines));
        el.appendChild(u);
    }
    return el;
}

export class LiveJianpuPanel {
    constructor(root) {
        this.root = root;
        this.statusEl = root?.querySelector('.live-jianpu-status');
        this.pagesHost = root?.querySelector('.live-jianpu-pages');
        this.streamWrap = root?.querySelector('.live-jianpu-stream-wrap');
        /** @type {{ el: HTMLElement, key: string }[]} */
        this.scoreItems = [];
        /** @type {HTMLElement[]} */
        this.pageEls = [];
        this.hasScore = false;
        this.cursorIndex = -1;
        this.currentPage = 0;
        this.cols = 12;
        this.pageSize = 48;
        this.truncated = false;
        this._pianoMetrics = null;
        this._loadGen = 0;
        this._loadPickKey = '';
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
        if (!show) this.setStatus('');
        this.syncPaneLayout();
        if (!show && this._pianoMetrics && !this.isLandscape()) {
            this._pianoMetrics();
        }
    }

    setStatus(text) {
        if (this.statusEl) this.statusEl.textContent = text || '';
    }

    setPracticeTitle(trackName) {
        const el = this.root?.querySelector('.live-jianpu-label');
        if (!el) return;
        el.textContent = trackName ? `练习：${trackName}` : '伴奏简谱';
    }

    measureCols() {
        const w = this.streamWrap?.clientWidth || this.root?.clientWidth || 320;
        return Math.max(8, Math.min(16, Math.floor((w - 8) / 26)));
    }

    finalizeRowLayouts() {
        if (!this.pagesHost) return;
        for (const row of this.pagesHost.querySelectorAll('.jp-row')) {
            const n = row.childElementCount;
            if (n > 0) row.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
        }
    }

    clearScore() {
        this._loadGen += 1;
        this._loadPickKey = '';
        this.scoreItems = [];
        this.pageEls = [];
        this.hasScore = false;
        this.cursorIndex = -1;
        this.currentPage = 0;
        this.truncated = false;
        if (this.pagesHost) this.pagesHost.innerHTML = '';
        this.setStatus('');
        this.syncVisible();
    }

    /**
     * @param {object[]} events
     * @param {(ch: number, drum?: boolean) => { transpose?: number, isDrum?: boolean }} routeForChannel
     */
    loadScore(events, routeForChannel) {
        this.loadScoreSync(events, routeForChannel);
    }

    loadScoreSync(events, routeForChannel, pickKey = '') {
        if (!this.pagesHost) return 0;
        const gen = ++this._loadGen;
        this._loadPickKey = pickKey || '';
        this.scoreItems = [];
        this.pageEls = [];
        this.cursorIndex = -1;
        this.currentPage = 0;
        this.truncated = false;
        this.hasScore = false;
        this.pagesHost.innerHTML = '';
        const list = (events || [])
            .filter((e) => e.type === 0x90 && e.b > 0)
            .sort((a, b) => a.ms - b.ms || (a.ord | 0) - (b.ord | 0));
        this.truncated = list.length > SCORE_MAX;
        const slice = list.slice(0, SCORE_MAX);
        if (!slice.length) {
            if (gen === this._loadGen) this.syncVisible();
            return 0;
        }

        this.cols = this.measureCols();
        this.pageSize = this.cols * ROWS_PER_PAGE;

        let pageEl = null;
        let rowEl = null;
        let colInRow = 0;
        let rowInPage = 0;

        const startPage = () => {
            pageEl = document.createElement('div');
            pageEl.className = 'jp-page';
            this.pagesHost.appendChild(pageEl);
            this.pageEls.push(pageEl);
            rowInPage = 0;
            startRow();
        };

        const startRow = () => {
            rowEl = document.createElement('div');
            rowEl.className = 'jp-row';
            pageEl.appendChild(rowEl);
            colInRow = 0;
            rowInPage++;
        };

        startPage();

        for (let i = 0; i < slice.length; i++) {
            if (gen !== this._loadGen) return 0;
            const e = slice[i];
            if (colInRow >= this.cols) {
                if (rowInPage >= ROWS_PER_PAGE) startPage();
                else startRow();
            }
            const route = routeForChannel(e.ch | 0, e.drum);
            const drum = !!(route.isDrum || e.drum);
            const gap = i + 1 < slice.length ? slice[i + 1].ms - e.ms : 480;
            let underlines = 0;
            if (!drum) {
                if (gap < 140) underlines = 2;
                else if (gap < 300) underlines = 1;
            }
            const j = midiToJianpu(e.a, { transpose: drum ? 0 : (route.transpose || 0), drum });
            const el = spanForJianpu(j, { underlines });
            el.classList.add('score-item');
            rowEl.appendChild(el);
            this.scoreItems.push({ el, key: performanceNoteKey(e) });
            colInRow++;
        }
        if (gen !== this._loadGen) return 0;
        if (pickKey && this._loadPickKey !== pickKey) return 0;

        this.finalizeRowLayouts();
        this.hasScore = true;
        this.showPage(0, { instant: true });
        const pages = this.pageEls.length;
        const extra = this.truncated ? `（前 ${SCORE_MAX} 个音）` : '';
        this.setStatus(`${slice.length} 音 · ${pages} 页${extra} · 点播放跟奏`);
        this.syncVisible();
        return slice.length;
    }

    async loadScoreAsync(events, routeForChannel, pickKey = '') {
        this.loadScoreSync(events, routeForChannel, pickKey);
    }

    showPage(index, { instant = false } = {}) {
        const p = Math.max(0, Math.min(index, this.pageEls.length - 1));
        this.currentPage = p;
        this.pageEls.forEach((el, i) => {
            el.classList.toggle('active', i === p);
            if (!instant && i === p) {
                el.classList.remove('jp-page-enter');
                void el.offsetWidth;
                el.classList.add('jp-page-enter');
            }
        });
        const pages = this.pageEls.length;
        if (pages > 1 && this.cursorIndex >= 0) {
            this.setStatus(`跟奏中 · 第 ${p + 1}/${pages} 页 · 音 ${this.cursorIndex + 1}/${this.scoreItems.length}`);
        }
    }

    pageOfIndex(index) {
        return Math.floor(index / this.pageSize);
    }

    resetPlaybackCursor() {
        for (const item of this.scoreItems) {
            item.el.classList.remove('cursor', 'past');
        }
        this.cursorIndex = -1;
        this.showPage(0, { instant: true });
        if (this.hasScore) {
            const pages = this.pageEls.length;
            this.setStatus(`${this.scoreItems.length} 音 · ${pages} 页 · 点播放跟奏`);
        }
    }

    /** 按当前播放音符定位简谱格（勿用自增下标，避免简谱与全曲时间轴错位） */
    advanceCursorForEvent(e) {
        if (!this.scoreItems.length || !e) return false;
        const key = performanceNoteKey(e);
        const start = this.cursorIndex < 0 ? 0 : this.cursorIndex;
        for (let i = start; i < this.scoreItems.length; i++) {
            if (this.scoreItems[i].key === key) {
                this.setPlaybackCursor(i);
                return true;
            }
        }
        for (let i = 0; i < start; i++) {
            if (this.scoreItems[i].key === key) {
                this.setPlaybackCursor(i);
                return true;
            }
        }
        return false;
    }

    setPlaybackCursor(index) {
        if (!this.scoreItems.length) return;
        if (index > this.cursorIndex) {
            for (let k = Math.max(0, this.cursorIndex + 1); k < index; k++) {
                const mid = this.scoreItems[k]?.el;
                if (mid) {
                    mid.classList.remove('cursor');
                    mid.classList.add('past');
                }
            }
        }
        if (this.cursorIndex >= 0 && this.scoreItems[this.cursorIndex]) {
            const prevEl = this.scoreItems[this.cursorIndex].el;
            prevEl.classList.remove('cursor');
            if (index > this.cursorIndex) prevEl.classList.add('past');
        }
        this.cursorIndex = index;
        if (index < 0 || index >= this.scoreItems.length) return;

        const page = this.pageOfIndex(index);
        if (page !== this.currentPage) this.showPage(page);

        const el = this.scoreItems[index].el;
        el.classList.remove('past');
        el.classList.add('cursor');

        const pages = this.pageEls.length;
        const pageNo = page + 1;
        this.setStatus(`跟奏中 · 第 ${pageNo}/${pages} 页 · 音 ${index + 1}/${this.scoreItems.length}`);
    }

    clear() {
        this.clearScore();
    }
}