/**
 * 实时简谱冒烟：启动引擎 → 演奏页 → 检查面板可见性与 feed 后 DOM。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(__dirname, 'smoke-jianpu.log');
const lines = [];
const log = (s) => lines.push(String(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

require(path.join(ROOT, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
    await sleep(1200);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
        log('FAIL: 无窗口');
        fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
        app.quit();
        return;
    }
    win.webContents.on('console-message', (e) => {
        if (e.level >= 2) log(`[console:${e.level}] ${e.message}`);
    });

    await win.webContents.executeJavaScript(
        "(() => { const b = document.getElementById('btn-start'); if (b) b.click(); return !!b; })()"
    );
    await sleep(5000);

    const diag = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const e = window.__ensemble;
        if (!e) return { error: 'no __ensemble' };
        e.showTab('play');
        await wait(100);
        const root = document.getElementById('live-jianpu');
        const orient = document.documentElement.dataset.orient;
        const pane = document.getElementById('pane-play');
        const cs = root ? getComputedStyle(root) : null;
        const before = {
            orient,
            paneActive: pane?.classList.contains('active'),
            rootExists: !!root,
            rootClass: root?.className,
            display: cs?.display,
            visibility: cs?.visibility,
            height: cs?.height,
        };
        const jp = e.liveJianpu;
        jp.loadScore([
            { ms: 0, type: 0x90, ch: 0, a: 67, b: 90, ord: 0 },
            { ms: 100, type: 0x90, ch: 0, a: 69, b: 90, ord: 1 },
        ], () => ({ transpose: 0, isDrum: false }));
        jp.setPlaybackCursor(0);
        await wait(40);
        const pagesEl = root?.querySelector('.live-jianpu-pages');
        const scoreCount = pagesEl?.querySelectorAll('.jp-cell').length ?? 0;
        const hasCursor = !!pagesEl?.querySelector('.jp-cell.cursor');
        return {
            before,
            scoreCount,
            hasCursor,
            label: root?.querySelector('.live-jianpu-label')?.textContent,
        };
    })()`);

    log('DIAG ' + JSON.stringify(diag, null, 2));
    const cells = diag?.activeCount >= 0 ? diag.activeCount : (diag?.sampleHtml ? 1 : 0);
    const ok = diag && !diag.error && diag.scoreCount >= 2 && diag.hasCursor;
    log(ok ? 'PASS: 伴奏简谱加载且光标正常' : 'FAIL: 伴奏简谱异常');
    fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
    app.quit();
});