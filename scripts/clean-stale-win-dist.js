/**
 * 删除历史上 make-portable 产出的 dist/SF2 MIDI Ensemble/，避免与 electron-builder 的 win-unpacked 混淆。
 */
const fs = require('node:fs');
const path = require('node:path');

const dist = path.join(__dirname, '..', 'dist');
const legacy = path.join(dist, 'SF2 MIDI Ensemble');
if (fs.existsSync(legacy)) {
    try {
        fs.rmSync(legacy, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 });
        console.log('已删除过期的 dist/SF2 MIDI Ensemble/');
    } catch {
        /* 忽略 */
    }
}
const pointer = path.join(dist, 'latest-pack-dir.txt');
if (fs.existsSync(pointer)) {
    try { fs.unlinkSync(pointer); } catch { /* 忽略 */ }
}
if (fs.existsSync(dist)) {
    for (const name of fs.readdirSync(dist)) {
        if (!name.startsWith('_win-unpacked-stale-') && !name.startsWith('.pack-')) continue;
        try {
            fs.rmSync(path.join(dist, name), { recursive: true, force: true, maxRetries: 2, retryDelay: 300 });
            console.log(`已删除 ${name}`);
        } catch {
            /* 仍占用则保留 */
        }
    }
}
