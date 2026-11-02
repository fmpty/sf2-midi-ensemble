/**
 * 电脑键盘虚拟 MIDI 手柄：可像一台真实手柄一样被分配到任意通道/乐器。
 * 用于在无硬件时试音，也可作为额外的「一路控制器」参与合奏。
 */
const KEY_OFFSETS = {
    KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7,
    KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14,
    KeyP: 15, Semicolon: 16, Quote: 17,
    Digit1: -12, Digit2: -10, Digit3: -8, Digit4: -5, Digit5: -3,
};

export class VirtualKeyboard {
    constructor(engine) {
        this.engine = engine;
        this.enabled = false;
        this.octave = 4;
        this.resolveRoute = () => null;
        this.onActivity = () => {};
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

    handleDown(e) {
        if (!this.enabled) return;
        if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.code === 'KeyZ') { this.octave = Math.max(0, this.octave - 1); this.onActivity({ octave: this.octave }); return; }
        if (e.code === 'KeyX') { this.octave = Math.min(8, this.octave + 1); this.onActivity({ octave: this.octave }); return; }
        const off = KEY_OFFSETS[e.code];
        if (off === undefined) return;
        e.preventDefault();
        const route = this.resolveRoute();
        if (!route || !route.enabled) return;
        const note = this.baseNote() + off;
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
        const note = this.baseNote() + off;
        this.engine.noteOff(route.channel, note);
        this.onActivity({ note, velocity: 0, on: false });
    }

    releaseAll() {
        const route = this.resolveRoute();
        for (const code of [...this.held]) {
            const off = KEY_OFFSETS[code];
            if (off === undefined) continue;
            if (route) this.engine.noteOff(route.channel, this.baseNote() + off);
            this.held.delete(code);
        }
    }
}
