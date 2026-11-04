/**
 * Debug 构建专用 trace（esbuild define __MIDI_DEBUG__）。
 * 正式版构建时设 __MIDI_DEBUG__=false 即可静默。
 */
import { midiLayerLog } from './midi-layer-log.js';

// eslint-disable-next-line no-undef
export const MIDI_DEBUG = typeof __MIDI_DEBUG__ !== 'undefined' && __MIDI_DEBUG__;

/** @type {(msg: string, detail?: unknown) => void} */
let sink = (msg) => console.log(msg);

export function setMidiDebugSink(fn) {
    if (typeof fn === 'function') sink = fn;
}

export function midiTrace(step, detail) {
    if (!MIDI_DEBUG) return;
    const line = midiLayerLog('L4-trace', step, detail);
    try {
        sink(line);
    } catch {
        /* ignore */
    }
}
