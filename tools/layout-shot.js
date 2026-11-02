/**
 * 布局检查：在多种窗口尺寸/分页下截图，输出 tools/shot-*.png
 * 运行：npx electron tools/layout-shot.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

require(path.join(ROOT, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
    await sleep(1600);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) { console.log('no window'); app.quit(); return; }
    win.setResizable(true);
    win.setMinimumSize(320, 480);
    win.webContents.setZoomFactor(1);
    win.webContents.on('console-message', (e) => {
        if (e.level === 'error') console.log('[console error]', e.message);
    });

    const shots = [
        ['desktop-play', 1180, 760, 'play'],
        ['desktop-devices', 1180, 760, 'devices'],
        ['tablet-port-play', 800, 1280, 'play'],
        ['tablet-port-devices', 800, 1280, 'devices'],
        ['tablet-land-play', 1280, 800, 'play'],
        ['phone-port-play', 390, 844, 'play'],
        ['phone-port-devices', 390, 844, 'devices'],
        ['phone-land-play', 844, 390, 'play'],
    ];

    const logLines = [];

    for (const [name, w, h, tab] of shots) {
        win.setContentSize(w, h);
        await sleep(500);
        const meta = await win.webContents.executeJavaScript(
            `(() => {
                document.getElementById('start-overlay').classList.add('hidden');
                window.__ensemble.showTab('${tab}');
                window.__ensemble.renderPiano();
                return {
                    innerWidth: window.innerWidth,
                    innerHeight: window.innerHeight,
                    layout: document.documentElement.dataset.layout,
                    orient: document.documentElement.dataset.orient,
                };
            })()`
        );
        await sleep(350);
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, `shot-${name}.png`), img.toPNG());
        const line = `shot ${name} content=${w}x${h} inner=${meta.innerWidth}x${meta.innerHeight} layout=${meta.layout}/${meta.orient} capture=${img.getSize().width}x${img.getSize().height}`;
        console.log(line);
        logLines.push(line);
    }
    fs.writeFileSync(path.join(__dirname, 'shot.log'), logLines.join('\n') + '\n');
    app.quit();
});
