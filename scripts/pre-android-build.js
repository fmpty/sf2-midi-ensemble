/**
 * F6 / build_android.bat 之前执行：清掉 Capacitor 打包目录里的旧 Web 资源，
 * 避免只改 boot.js 时 APK 里仍留着过期的 app.js、旧 hash chunk。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function rmDir(rel) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) return;
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`已删除 ${rel}`);
}

console.log('=== pre-android-build：清理 stale Web 缓存 ===');
rmDir('src/renderer/dist');
rmDir('www/dist');
rmDir('android/app/src/main/assets/public');
console.log('（随后 build.js 重建 www/dist，cap sync 再写入 assets/public）\n');
