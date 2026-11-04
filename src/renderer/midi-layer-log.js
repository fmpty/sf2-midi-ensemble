/** 分层诊断（与 [MIDI scan] 同前缀，adb 只筛 [MIDI scan] 即可看到 L1–L6） */

export const MIDI_LAYER_LOG_REV = 'layer-v3-trace';

export function midiLayerLog(layer, message, detail) {
    let extra = '';
    if (detail !== undefined) {
        try {
            extra = ` ${JSON.stringify(detail)}`;
        } catch {
            extra = ` ${String(detail)}`;
        }
    }
    const line = `[MIDI scan][${layer}] ${message}${extra}`;
    console.log(line);
    return line;
}
