/**
 * 免安装版打包：直接基于 node_modules/electron/dist 组装可双击运行的目录。
 * 产出：dist/SF2 MIDI Ensemble/SF2 MIDI Ensemble.exe
 * 运行：node tools/make-portable.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const OUT = path.join(ROOT, 'dist', 'SF2 MIDI Ensemble');
const APP = path.join(OUT, 'resources', 'app');
const EXE_NAME = 'SF2 MIDI Ensemble.exe';

const RCEDIT = path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
const ICON = path.join(ROOT, 'assets', 'icon.ico');

/** 写入 exe 图标与版本信息（复用 electron-winstaller 自带的 rcedit，无需联网） */
function applyExeMeta(exePath) {
    if (process.platform !== 'win32') return;
    if (!fs.existsSync(RCEDIT)) {
        console.warn('未找到 rcedit，跳过图标写入：', path.relative(ROOT, RCEDIT));
        return;
    }
    if (!fs.existsSync(ICON)) {
        console.warn('未找到图标 assets/icon.ico，可先执行 node tools/make-icon.js');
        return;
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const args = [
        exePath,
        '--set-icon', ICON,
        '--set-file-version', pkg.version,
        '--set-product-version', pkg.version,
        '--set-version-string', 'ProductName', pkg.productName || 'SF2 MIDI Ensemble',
        '--set-version-string', 'FileDescription', 'SF2 MIDI Ensemble · 多手柄合奏器',
        '--set-version-string', 'CompanyName', 'SF2 MIDI Ensemble',
        '--set-version-string', 'LegalCopyright', 'MIT License',
        '--set-version-string', 'OriginalFilename', EXE_NAME,
    ];
    execFileSync(RCEDIT, args, { stdio: 'inherit' });
    console.log('已写入图标与版本信息');
}

function copyDir(from, to, filter) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name);
        const dest = path.join(to, entry.name);
        if (filter && !filter(src, entry)) continue;
        if (entry.isDirectory()) copyDir(src, dest, filter);
        else if (entry.isFile()) fs.copyFileSync(src, dest);
    }
}

function main() {
    if (!fs.existsSync(ELECTRON_DIST)) throw new Error('未找到 Electron 运行时，请先 npm install');
    for (const need of ['src/renderer/index.html', 'src/renderer/dist/app.js',
        'src/renderer/dist/spessasynth_processor.min.js']) {
        if (!fs.existsSync(path.join(ROOT, need))) throw new Error(`缺少构建产物 ${need}，请先 npm run build`);
    }

    fs.rmSync(OUT, { recursive: true, force: true });
    copyDir(ELECTRON_DIST, OUT);
    fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

    // 应用文件（与 package.json 的 build.files 一致）
    fs.mkdirSync(path.join(APP, 'src'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(APP, 'package.json'));
    copyDir(path.join(ROOT, 'src', 'main'), path.join(APP, 'src', 'main'));
    copyDir(path.join(ROOT, 'src', 'renderer'), path.join(APP, 'src', 'renderer'));
    copyDir(path.join(ROOT, 'assets'), path.join(APP, 'assets'));

    // 重命名可执行文件
    const srcExe = path.join(OUT, 'electron.exe');
    const exePath = path.join(OUT, EXE_NAME);
    if (fs.existsSync(srcExe)) fs.renameSync(srcExe, exePath);

    applyExeMeta(exePath);

    console.log('免安装版已生成：', path.relative(ROOT, exePath));
}

main();
