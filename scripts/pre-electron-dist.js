/**
 * 打包前：尽量结束占用进程并清理 dist/win-unpacked。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const UNPACKED = path.join(DIST, 'win-unpacked');

function sleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 等待 */ }
}

function killWindows() {
    if (process.platform !== 'win32') return;
    try {
        execSync('taskkill /IM "SF2 MIDI Ensemble.exe" /F', { stdio: 'ignore' });
    } catch { /* 无进程 */ }
    const cmd = [
        'Get-CimInstance Win32_Process -EA SilentlyContinue',
        '| Where-Object {',
        '  ($_.Name -eq "electron.exe" -and $_.CommandLine -match "mid14|sf2-midi-ensemble")',
        '  -or ($_.ExecutablePath -like "*win-unpacked*SF2 MIDI Ensemble.exe")',
        '}',
        '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }',
    ].join(' ');
    try {
        execSync(`powershell -NoProfile -Command "${cmd}"`, { stdio: 'ignore' });
    } catch { /* 忽略 */ }
    sleep(800);
}

function tryRm(dir) {
    if (!fs.existsSync(dir)) return true;
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 400 });
        return true;
    } catch {
        return false;
    }
}

function purgeOldPackDirs() {
    if (!fs.existsSync(DIST)) return;
    for (const name of fs.readdirSync(DIST)) {
        if (!name.startsWith('.pack-') && !name.startsWith('_win-unpacked-stale-')) continue;
        tryRm(path.join(DIST, name));
    }
}

killWindows();
purgeOldPackDirs();
if (tryRm(UNPACKED)) {
    console.log('pre-electron-dist: 已删除 dist/win-unpacked');
} else {
    console.warn('pre-electron-dist: dist/win-unpacked 仍被占用，后续打包可能 EBUSY');
}
