/**
 * 构建脚本：
 * 1. 用 esbuild 打包渲染层；
 * 2. 复制 AudioWorklet 处理器文件；
 * 3. 若 assets/soundfonts 为空，则从 npm 音源包（generaluser / freepats）复制内置音源。
 */
const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'src', 'renderer', 'dist');
const SF_DIR = path.join(ROOT, 'assets', 'soundfonts');
const SF_EXT = /\.(sf2|sf3|sfogg|dls)$/i;
const PROVIDERS = ['generaluser', 'freepats'];

const watch = process.argv.includes('--watch');

function findIn(dir) {
    if (!fs.existsSync(dir)) return null;
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
            const p = path.join(cur, entry.name);
            if (entry.isDirectory()) stack.push(p);
            else if (SF_EXT.test(entry.name)) return p;
        }
    }
    return null;
}

function ensureSoundfont() {
    fs.mkdirSync(SF_DIR, { recursive: true });
    if (fs.readdirSync(SF_DIR).some((f) => SF_EXT.test(f))) {
        writeManifest();
        return;
    }
    for (const pkg of PROVIDERS) {
        const src = findIn(path.join(ROOT, 'node_modules', pkg));
        if (!src) continue;
        const dest = path.join(SF_DIR, path.basename(src));
        fs.copyFileSync(src, dest);
        console.log(`内置音源：${path.basename(src)} (${(fs.statSync(dest).size / 1048576).toFixed(1)} MB)`);
        writeManifest();
        return;
    }
    console.warn('未找到内置音源，可执行 npm install 后在应用内手动载入 .sf2 文件');
    writeManifest();
}

/** 生成音源清单，供浏览器 / Capacitor 模式通过 fetch 发现内置音源 */
function writeManifest() {
    const files = fs.readdirSync(SF_DIR)
        .filter((f) => SF_EXT.test(f))
        .map((f) => ({ name: f, size: fs.statSync(path.join(SF_DIR, f)).size }));
    fs.writeFileSync(path.join(SF_DIR, 'manifest.json'), JSON.stringify({ files }, null, 2) + '\n');
}

function copyDirSync(fromDir, toDir) {
    fs.mkdirSync(toDir, { recursive: true });
    for (const name of fs.readdirSync(fromDir, { withFileTypes: true })) {
        const from = path.join(fromDir, name.name);
        const to = path.join(toDir, name.name);
        if (name.isDirectory()) copyDirSync(from, to);
        else fs.copyFileSync(from, to);
    }
}

function readWebBuildId() {
    const p = path.join(ROOT, 'src', 'renderer', 'midi-build-id.js');
    const m = fs.readFileSync(p, 'utf8').match(/MIDI_WEB_BUILD_ID = "([^"]+)"/);
    return m ? m[1] : String(Date.now());
}

/** GitHub Pages 项目站子路径，如 /sf2-midi-ensemble/（由 CI 注入） */
function pagesBaseHref() {
    const raw = process.env.GITHUB_PAGES_BASE || '';
    if (!raw) return '';
    const t = raw.trim();
    if (!t || t === '/') return '';
    const withSlashes = t.startsWith('/') ? t : `/${t}`;
    return withSlashes.endsWith('/') ? withSlashes : `${withSlashes}/`;
}

/** 组装移动端/网页用的 www 目录（Capacitor 的 webDir） */
function buildWebBundle() {
    const www = path.join(ROOT, 'www');
    const src = path.join(ROOT, 'src', 'renderer');
    const wwwDist = path.join(www, 'dist');
    const baseHref = pagesBaseHref();
    if (fs.existsSync(wwwDist)) fs.rmSync(wwwDist, { recursive: true, force: true });
    fs.mkdirSync(wwwDist, { recursive: true });
    fs.mkdirSync(path.join(www, 'assets', 'soundfonts'), { recursive: true });
    const buildId = readWebBuildId();
    const indexSrc = path.join(src, 'index.html');
    if (fs.existsSync(indexSrc)) {
        let html = fs.readFileSync(indexSrc, 'utf8');
        html = html.replace(
            /src="dist\/boot\.js(?:\?[^"]*)?"/,
            `src="dist/boot.js?v=${encodeURIComponent(buildId)}"`,
        );
        if (baseHref && !/<base\s/i.test(html)) {
            html = html.replace(/<head>/i, `<head>\n    <base href="${baseHref}" />`);
        }
        fs.writeFileSync(path.join(www, 'index.html'), html);
    }
    for (const f of ['styles.css', 'manifest.webmanifest', 'sw.js']) {
        const from = path.join(src, f);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(www, f));
    }
    if (baseHref) {
        const manifestPath = path.join(www, 'manifest.webmanifest');
        if (fs.existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                manifest.start_url = baseHref;
                manifest.scope = baseHref;
                fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
            } catch { /* 忽略 */ }
        }
        console.log(`GitHub Pages base: ${baseHref}`);
    }
    fs.writeFileSync(path.join(www, '.nojekyll'), '\n');
    copyDirSync(path.join(src, 'dist'), wwwDist);
    const iconsFrom = path.join(ROOT, 'assets', 'icons');
    const iconsTo = path.join(www, 'assets', 'icons');
    if (fs.existsSync(iconsFrom)) copyDirSync(iconsFrom, iconsTo);
    // 音源文件较大，用硬链接减少磁盘占用，失败则复制
    for (const f of fs.readdirSync(SF_DIR)) {
        const from = path.join(SF_DIR, f);
        const to = path.join(www, 'assets', 'soundfonts', f);
        try {
            if (fs.existsSync(to)) fs.unlinkSync(to);
            fs.linkSync(from, to);
        } catch {
            fs.copyFileSync(from, to);
        }
    }
    console.log('web 资源已组装 -> www/');
}

async function copyProcessor() {
    const src = path.join(ROOT, 'node_modules', 'spessasynth_lib', 'dist', 'spessasynth_processor.min.js');
    if (!fs.existsSync(src)) throw new Error('未找到 spessasynth_processor.min.js，请先 npm install');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.copyFileSync(src, path.join(OUT_DIR, 'spessasynth_processor.min.js'));
}

function writeAppVersion() {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const buildId = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(
        path.join(ROOT, 'src', 'renderer', 'app-version.js'),
        `/** 构建时从 package.json 写入，勿手改 */\nexport const APP_VERSION = ${JSON.stringify(pkg.version)};\n`,
    );
    fs.writeFileSync(
        path.join(ROOT, 'src', 'renderer', 'midi-build-id.js'),
        `/** 构建时写入，logcat 里对照是否装到新包 */\nexport const MIDI_WEB_BUILD_ID = ${JSON.stringify(buildId)};\n`,
    );
}

async function build() {
    ensureSoundfont();
    writeAppVersion();
    const options = {
        entryPoints: [path.join(ROOT, 'src', 'renderer', 'boot.js')],
        outdir: OUT_DIR,
        bundle: true,
        splitting: true,
        format: 'esm',
        platform: 'browser',
        target: 'chrome120',
        entryNames: '[name]',
        chunkNames: 'chunks/[name]-[hash]',
        sourcemap: false,
        legalComments: 'none',
        logLevel: 'info',
        define: {
            __MIDI_DEBUG__: 'true',
        },
    };
    if (watch) {
        const ctx = await esbuild.context(options);
        await ctx.watch();
        console.log('esbuild: 监听中…');
    } else {
        if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true, force: true });
        fs.mkdirSync(OUT_DIR, { recursive: true });
        const result = await esbuild.build(options);
        await copyProcessor();
        const outs = result.metafile ? Object.keys(result.metafile.outputs) : [];
        console.log('esbuild: 构建完成 ->', outs.map((p) => path.relative(ROOT, p)).join(', ') || OUT_DIR);
        buildWebBundle();
    }
}

build().catch((e) => {
    console.error(e);
    process.exit(1);
});
