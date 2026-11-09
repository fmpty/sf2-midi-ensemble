/**
 * Windows：按 package.json 的 win.target 打包（dir 绿色版 + nsis 安装程序）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const UNPACKED = path.join(DIST, 'win-unpacked');
const EXE = 'SF2 MIDI Ensemble.exe';

const outArg = DIST.replace(/\\/g, '/');
execSync(`npx electron-builder --win --config.directories.output="${outArg}"`, {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});

const exe = path.join(UNPACKED, EXE);
console.log('');
console.log('绿色版（免安装）:');
console.log(`  ${exe}`);
if (fs.existsSync(DIST)) {
    for (const name of fs.readdirSync(DIST)) {
        if (name.endsWith('.exe') && /Setup/i.test(name)) {
            console.log('安装程序:');
            console.log(`  ${path.join(DIST, name)}`);
        }
    }
}
