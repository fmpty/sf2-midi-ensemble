/**
 * Windows 桌面端：通过 WinMM/RTMidi 枚举 MIDI 输入（Web MIDI 常看不到蓝牙手柄）。
 */
let midiLib = null;
try {
    midiLib = require('@julusian/midi');
} catch (e) {
    console.warn('[midi-bridge] @julusian/midi 未加载:', e.message);
}

/** @type {Map<string, import('@julusian/midi').Input>} */
const openInputs = new Map();

function supported() {
    return !!midiLib;
}

function listDevices() {
    if (!midiLib) return [];
    const probe = new midiLib.Input();
    const count = probe.getPortCount();
    const out = [];
    for (let i = 0; i < count; i++) {
        const name = probe.getPortName(i) || `MIDI IN ${i + 1}`;
        out.push({
            id: `electron-midi:${i}`,
            name,
            manufacturer: '',
            state: 'connected',
            connection: openInputs.has(`electron-midi:${i}`) ? 'open' : 'closed',
            portIndex: i,
            guessBluetooth: /bluetooth|ble\b|wireless|widi|airturn|le-midi|midi\+/i.test(name),
        });
    }
    return out;
}

function closeAll() {
    for (const input of openInputs.values()) {
        try { input.closePort(); } catch { /* 忽略 */ }
    }
    openInputs.clear();
}

/**
 * @param {import('electron').WebContents} webContents
 */
function openAll(webContents) {
    if (!midiLib || !webContents) return listDevices();
    closeAll();
    const probe = new midiLib.Input();
    const count = probe.getPortCount();
    for (let i = 0; i < count; i++) {
        const id = `electron-midi:${i}`;
        const input = new midiLib.Input();
        try {
            input.ignoreTypes(false, false, false);
            input.openPort(i);
            input.on('message', (_delta, data) => {
                if (!webContents.isDestroyed()) {
                    webContents.send('app:midi-bytes', { deviceId: id, data: Array.from(data) });
                }
            });
            openInputs.set(id, input);
        } catch (e) {
            console.warn('[midi-bridge] 打开端口失败', i, e.message);
        }
    }
    return listDevices();
}

module.exports = { supported, listDevices, openAll, closeAll };
