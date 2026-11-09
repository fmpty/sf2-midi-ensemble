/**
 * 组装仅含 Web 静态站 + serve CLI 的 npm 发布目录（不含 Electron / Android 源码）。
 * 用法：npm run publish:npm
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const STAGING = path.join(ROOT, '.npm-staging');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NPM_NAME = process.env.NPM_PACKAGE_NAME || 'sf2-midi-ensemble';

function rm(dir) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function copyFile(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
}

function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const sf = path.join(from, entry.name);
        const st = path.join(to, entry.name);
        if (entry.isDirectory()) copyDir(sf, st);
        else copyFile(sf, st);
    }
}

function shebangServe() {
    const src = path.join(ROOT, 'tools', 'serve.js');
    let body = fs.readFileSync(src, 'utf8');
    if (!body.startsWith('#!')) body = `#!/usr/bin/env node\n${body}`;
    const dest = path.join(STAGING, 'tools', 'serve.js');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    try {
        fs.chmodSync(dest, 0o755);
    } catch {
        /* Windows */
    }
}

execSync('node scripts/build.js', { cwd: ROOT, stdio: 'inherit' });

rm(STAGING);
fs.mkdirSync(STAGING, { recursive: true });

copyDir(path.join(ROOT, 'www'), path.join(STAGING, 'www'));
shebangServe();
for (const f of ['LICENSE', 'COMMERCIAL.md', 'THIRD_PARTY_NOTICES.md']) {
    copyFile(path.join(ROOT, f), path.join(STAGING, f));
}

const readme = `# sf2-midi-ensemble (npm)

预构建 **Web 版** SF2 MIDI Ensemble：本地起静态站，Chrome/Edge 下可用 Web MIDI。

## 许可

非商业使用见 \`LICENSE\`；商用 **179990830@qq.com**（\`COMMERCIAL.md\`）。

## 安装

\`\`\`bash
npm install -g sf2-midi-ensemble
# 或
npx sf2-midi-ensemble
\`\`\`

## 使用

\`\`\`bash
sf2-midi-ensemble
# 默认 http://127.0.0.1:8765/
sf2-midi-ensemble --lan --https -p 8765
\`\`\`

源码与桌面/Android 版：https://github.com/fmpty/sf2-midi-ensemble
`;

fs.writeFileSync(path.join(STAGING, 'README.md'), readme);

const stagingPkg = {
    name: NPM_NAME,
    version: PKG.version,
    description:
        'SF2 MIDI合奏器 Web 版本地服务（内置 SoundFont，Web MIDI）。非商业许可，商用见 COMMERCIAL.md',
    license: PKG.license,
    author: PKG.author,
    repository: {
        type: 'git',
        url: 'git+https://github.com/fmpty/sf2-midi-ensemble.git',
    },
    homepage: 'https://fmpty.github.io/sf2-midi-ensemble/',
    bugs: { url: 'https://github.com/fmpty/sf2-midi-ensemble/issues' },
    engines: { node: '>=18' },
    bin: { 'sf2-midi-ensemble': 'tools/serve.js' },
    keywords: ['midi', 'soundfont', 'sf2', 'webmidi', 'ensemble'],
    dependencies: {},
};

fs.writeFileSync(path.join(STAGING, 'package.json'), JSON.stringify(stagingPkg, null, 2) + '\n');

const packed = execSync('npm pack --dry-run', { cwd: STAGING, encoding: 'utf8' });
console.log(packed);
console.log(`\n就绪：${STAGING}`);
console.log('发布：npm publish .npm-staging --access public  （scoped 包名时须 --access public）');
