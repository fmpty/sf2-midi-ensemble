/**
 * 电脑键盘虚拟 MIDI 手柄：可像一台真实手柄一样被分配到任意通道/乐器。
 * 数字键与字母键按键盘从左到右物理顺序对应连续半音；Shift+↑↓ 移调，Shift+←→ 换乐器。
 */
const PHYSICAL_KEY_CODES = [
    'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
    'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP',
    'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL',
    'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM',
];
const KEY_OFFSETS = Object.fromEntries(PHYSICAL_KEY_CODES.map((code, i) => [code, i]));

export class VirtualKeyboard {
    constructor(engine) {
        this.engine = engine;
        this.enabled = false;
        this.octave = 4;
        this.resolveRoute = () => null;
        this.onActivity = () => {};
        this.onTransposeChange = null;
        this.onInstrumentChange = null;
        this.held = new Set();
        this._down = this.handleDown.bind(this);
        this._up = this.handleUp.bind(this);
    }

    setEnabled(on) {
        this.enabled = !!on;
        if (!this.enabled) this.releaseAll();
    }

    attach(target = window) {
        target.addEventListener('keydown', this._down);
        target.addEventListener('keyup', this._up);
        window.addEventListener('blur', () => this.releaseAll());
    }

    baseNote() {
        return 12 * (this.octave + 1);
    }

    noteForCode(code) {
        const off = KEY_OFFSETS[code];
        if (off === undefined) return null;
        const route = this.resolveRoute();
        let note = this.baseNote() + off;
        if (route && this.engine.native) note += route.transpose || 0;
        return Math.max(0, Math.min(127, note));
    }

    handleDown(e) {
        if (!this.enabled) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        if (e.shiftKey) {
            if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
                e.preventDefault();
                if (e.repeat) return;
                const delta = e.code === 'ArrowUp' ? 1 : -1;
                if (this.onTransposeChange) this.onTransposeChange(delta);
                this.onActivity({ transposeDelta: delta });
                return;
            }
            if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
                e.preventDefault();
                if (e.repeat) return;
                const delta = e.code === 'ArrowRight' ? 1 : -1;
                if (this.onInstrumentChange) this.onInstrumentChange(delta);
                this.onActivity({ instrumentDelta: delta });
                return;
            }
            return;
        }

        if (e.repeat) return;
        const off = KEY_OFFSETS[e.code];
        if (off === undefined) return;
        e.preventDefault();
        const route = this.resolveRoute();
        if (!route || !route.enabled) return;
        const note = this.noteForCode(e.code);
        if (note == null) return;
        if (this.held.has(e.code)) return;
        this.held.add(e.code);
        const vel = Math.round(100 * (route.velocityGain != null ? route.velocityGain : 1));
        this.engine.noteOn(route.channel, note, Math.max(1, Math.min(127, vel)));
        this.onActivity({ note, velocity: vel, on: true });
    }

    handleUp(e) {
        const off = KEY_OFFSETS[e.code];
        if (off === undefined) return;
        if (!this.held.has(e.code)) return;
        this.held.delete(e.code);
        const route = this.resolveRoute();
        if (!route) return;
        const note = this.noteForCode(e.code);
        if (note == null) return;
        this.engine.noteOff(route.channel, note);
        this.onActivity({ note, velocity: 0, on: false });
    }

    releaseAll() {
        const route = this.resolveRoute();
        for (const code of [...this.held]) {
            const note = this.noteForCode(code);
            if (note != null && route) this.engine.noteOff(route.channel, note);
            this.held.delete(code);
        }
    }
}
