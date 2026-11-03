/**
 * 冒烟测试：启动真实主进程（src/main/main.js），自动点击「启动音频引擎」，
 * 检查渲染层是否报错、内置音源是否载入、设备卡片是否渲染。
 * 运行：npx electron tools/smoke.js   （结果写入 tools/smoke.log）
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(__dirname, 'smoke.log');
const lines = [];
const log = (s) => lines.push(String(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 复用真实主进程：注册 IPC、创建窗口、授权 MIDI 权限
require(path.join(ROOT, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
    await sleep(1500);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
        log('未找到窗口');
        fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
        app.quit();
        return;
    }
    win.webContents.on('console-message', (e) => log(`[console:${e.level}] ${e.message}`));
    win.webContents.on('did-fail-load', (_e, code, desc) => log(`did-fail-load ${code} ${desc}`));

    await win.webContents.executeJavaScript(
        "(() => { const b = document.getElementById('btn-start'); if (b) b.click(); return !!b; })()"
    );
    await sleep(6000);

    // 发声测试：三路通道同时演奏不同乐器
    await win.webContents.executeJavaScript(`(() => {
        const e = window.__ensemble.engine;
        [0, 1, 2].forEach((ch, i) => {
            e.applyRoute({ channel: ch, program: [0, 40, 56][i], bankMSB: 0, bankLSB: 0,
                isDrum: false, volume: 1, pan: 0, reverb: 0.3, chorus: 0.1, transpose: 0 });
            e.noteOn(ch, 60 + i * 4, 110);
        });
        return 1;
    })()`);
    await sleep(600);
    const voices = await win.webContents.executeJavaScript('window.__ensemble.engine.voiceCount');
    log('同时发声的声部数 voiceCount=' + voices);
    await win.webContents.executeJavaScript('window.__ensemble.engine.stopAll()');

    // 屏幕键盘测试：按下发声 + 拖动滑奏（轮指）+ 松手释放
    const piano = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const box = document.getElementById('piano');
        const keys = [...box.querySelectorAll('.pkey.white')];
        if (!keys.length) return { error: '未渲染琴键' };
        const center = (k) => { const r = k.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.8 }; };
        const ev = (type, p, id) => new PointerEvent(type, { pointerId: id, pointerType: 'mouse', clientX: p.x, clientY: p.y, bubbles: true, cancelable: true });
        const seen = [];
        ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'].forEach(t =>
            box.addEventListener(t, (e) => seen.push(t + '#' + e.pointerId), true));
        const a = center(keys[2]);
        const b = center(keys[6]);
        keys[2].dispatchEvent(ev('pointerdown', a, 1));
        const down = { notes: [...window.__ensemble.pianoActive.values()].map(v => v.note), voices: window.__ensemble.engine.voiceCount };
        await wait(250);
        const down2 = { notes: [...window.__ensemble.pianoActive.values()].map(v => v.note), voices: window.__ensemble.engine.voiceCount };
        box.dispatchEvent(ev('pointermove', b, 1));
        await wait(250);
        const glide = { notes: [...window.__ensemble.pianoActive.values()].map(v => v.note), voices: window.__ensemble.engine.voiceCount };
        box.dispatchEvent(ev('pointerup', b, 1));
        await wait(250);
        const up = { size: window.__ensemble.pianoActive.size };
        window.__ensemble.engine.stopAll();
        return { down, down2, glide, up, seen, attached: keys[2].isConnected, key0: keys[2].dataset.note, key1: keys[6].dataset.note };
    })()`);
    log('屏幕键盘 ' + JSON.stringify(piano));

    // 快速滑奏（轮指）测试：大跨度拖动不应跳音
    const glide = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const box = document.getElementById('piano');
        const keys = [...box.querySelectorAll('.pkey.white')];
        const e = window.__ensemble.engine;
        const played = [];
        const orig = e.noteOn.bind(e);
        e.noteOn = (ch, n, v) => { played.push(n); orig(ch, n, v); };
        const rect = box.getBoundingClientRect();
        const y = rect.top + rect.height * 0.85;
        const ev = (type, x, id) => new PointerEvent(type, { pointerId: id, pointerType: 'mouse', clientX: x, clientY: y, bubbles: true, cancelable: true });
        const x0 = keys[1].getBoundingClientRect().left + 4;
        const x1 = keys[keys.length - 2].getBoundingClientRect().right - 4;
        const steps = 6;
        box.dispatchEvent(ev('pointerdown', x0, 9));
        for (let i = 1; i <= steps; i++) box.dispatchEvent(ev('pointermove', x0 + (x1 - x0) * i / steps, 9));
        await wait(400);
        box.dispatchEvent(ev('pointerup', x1, 9));
        await wait(200);
        e.noteOn = orig;
        e.stopAll();
        const uniq = [...new Set(played)];
        return { total: played.length, distinct: uniq.length, notes: uniq, keys: keys.length };
    })()`);
    log('快速滑奏 ' + JSON.stringify(glide));

    const state = await win.webContents.executeJavaScript(`(() => {
        const e = window.__ensemble;
        return JSON.stringify({
            started: !!(e && e.engine.started),
            ctxState: e && e.engine.ctx ? e.engine.ctx.state : null,
            sampleRate: e ? e.engine.sampleRate : 0,
            banks: e ? e.engine.banks.map(b => b.name) : [],
            presets: e ? e.engine.presets.length : 0,
            cards: document.querySelectorAll('.card').length,
            bankInfo: document.getElementById('bank-count').textContent,
            midiStatus: document.getElementById('midi-status')?.textContent ?? '',
            logLines: [...document.querySelectorAll('.log-line')].slice(0, 12).map(x => x.textContent)
        }, null, 2);
    })()`);
    log('STATE ' + state);
    fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
    app.quit();
});
