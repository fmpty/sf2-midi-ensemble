/**
 * Windows 绿色版：输出到 dist/win-unpacked（与原先 electron-builder 位置一致）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const UNPACKED = path.join(DIST, 'win-unpacked');
const EXE = 'SF2 MIDI Ensemble.exe';

function sleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 等待 */ }
}

function runBuilder() {
    const outArg = DIST.replace(/\\/g, '/');
    execSync(`npx electron-builder --win dir --config.directories.output="${outArg}"`, {
        stdio: 'inherit',
        cwd: ROOT,
        env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    });
}

fs.mkdirSync(DIST, { recursive: true });

let lastErr;
for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
        console.warn(`打包重试 ${attempt}/3…`);
        sleep(2500);
    }
    try {
        runBuilder();
        const exe = path.join(UNPACKED, EXE);
        console.log('');
        console.log('绿色版（免安装）:');
        console.log(`  ${exe}`);
        process.exit(0);
    } catch (e) {
        lastErr = e;
    }
}

console.error('');
console.error('打包失败。请关闭 dist\\win-unpacked 里正在运行的程序、npm start，并关闭资源管理器中打开的 dist 目录后重试。');
throw lastErr;
