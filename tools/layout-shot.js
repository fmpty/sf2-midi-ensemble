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
    win.webContents.on('console-message', (e) => {
        if (e.level === 'error') console.log('[console error]', e.message);
    });

    const shots = [
        ['pad-play', 1180, 760, 'play'],
        ['pad-devices', 1180, 760, 'devices'],
        ['pad-sound', 1180, 760, 'sound'],
        ['pad-more', 1180, 760, 'more'],
        ['phone-play', 400, 860, 'play'],
        ['phone-devices', 400, 860, 'devices'],
        ['phone-sound', 400, 860, 'sound'],
        ['phone-more', 400, 860, 'more'],
    ];

    for (const [name, w, h, tab] of shots) {
        win.setContentSize(w, h);
        await sleep(450);
        await win.webContents.executeJavaScript(
            `(() => { document.getElementById('start-overlay').classList.add('hidden');
                      window.__ensemble.showTab('${tab}');
                      window.__ensemble.renderPiano(); return 1; })()`
        );
        await sleep(450);
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, `shot-${name}.png`), img.toPNG());
        console.log('shot', name, img.getSize());
    }
    app.quit();
});
