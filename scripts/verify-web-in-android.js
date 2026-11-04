/**
 * cap sync 之后：确认 android/assets 与 www 一致，并剔除 dist 里 cap 未删掉的旧 chunk。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const wwwBoot = path.join(ROOT, 'www', 'dist', 'boot.js');
const andPublic = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public');
const andBoot = path.join(andPublic, 'dist', 'boot.js');
const wwwDist = path.join(ROOT, 'www', 'dist');
const andDist = path.join(andPublic, 'dist');

function sha12(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
}

function listFilesRecursive(dir, base = dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...listFilesRecursive(p, base));
        else out.push(path.relative(base, p).replace(/\\/g, '/'));
    }
    return out;
}

function pruneStaleDist() {
    if (!fs.existsSync(wwwDist) || !fs.existsSync(andDist)) return;
    const allowed = new Set(listFilesRecursive(wwwDist, wwwDist));
    for (const rel of listFilesRecursive(andDist, andDist)) {
        if (allowed.has(rel)) continue;
        const target = path.join(andDist, rel);
        fs.rmSync(target, { force: true });
        console.log(`已删除 stale 资源 android/.../dist/${rel}`);
    }
}

function fail(msg) {
    console.error(`\n[verify-web-in-android] ${msg}`);
    process.exit(1);
}

if (!fs.existsSync(wwwBoot)) fail('缺少 www/dist/boot.js，请先 node scripts/build.js');
if (!fs.existsSync(andBoot)) {
    fail('缺少 android/.../assets/public/dist/boot.js，请执行 npx cap sync android');
}

pruneStaleDist();

const hWww = sha12(wwwBoot);
const hAnd = sha12(andBoot);
if (hWww !== hAnd) {
    fail(`boot.js 不一致：www=${hWww} android=${hAnd}（cap sync 未成功或跳过了 mobile:sync）`);
}

const text = fs.readFileSync(andBoot, 'utf8');
if (text.includes('正在读取系统设备')) {
    fail('android assets 里 boot.js 仍是旧 UI（含「正在读取系统设备」）');
}
if (!text.includes('refreshList')) {
    fail('android assets 里 boot.js 不含 refreshList，Web  bundle 过旧');
}

const htmlPath = path.join(andPublic, 'index.html');
if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    if (!html.includes('boot.js?v=')) {
        fail('index.html 未带 boot.js 版本参数，WebView 可能缓存旧脚本');
    }
}

console.log(`Web → Android 资源 OK（boot.js ${hAnd}）`);
