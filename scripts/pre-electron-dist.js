/**
 * 打包前：尝试删除 dist/win-unpacked（删不掉只警告，不阻断；重启或关掉占用后通常即可）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const UNPACKED = path.join(DIST, 'win-unpacked');

function tryRm(dir) {
    if (!fs.existsSync(dir)) return true;
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 400 });
        return true;
    } catch {
        return false;
    }
}

function purgeOldPackDirs() {
    if (!fs.existsSync(DIST)) return;
    for (const name of fs.readdirSync(DIST)) {
        if (!name.startsWith('_win-unpacked-stale-')) continue;
        tryRm(path.join(DIST, name));
    }
}

purgeOldPackDirs();
if (tryRm(UNPACKED)) {
    console.log('pre-electron-dist: 已删除 dist/win-unpacked');
} else if (fs.existsSync(UNPACKED)) {
    console.warn('pre-electron-dist: dist/win-unpacked 仍被占用，后续打包可能 EBUSY');
}
