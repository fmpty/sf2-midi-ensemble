/**
 * 极小的启动入口：先让 HTML/CSS 画出启动遮罩，再加载主逻辑。
 * Android 原生包不会在这里拉 spessasynth（仅在回退 WebAudio 时 dynamic import）。
 */
import { startApp } from './app.js';

function onBootError(e) {
    console.error(e);
    const overlay = document.getElementById('start-overlay');
    if (overlay) overlay.classList.remove('hidden');
    const btn = document.getElementById('btn-start');
    if (btn) {
        btn.disabled = false;
        btn.textContent = '启动音频引擎';
    }
    const box = document.querySelector('.overlay-box');
    if (box && !box.querySelector('.boot-error')) {
        const p = document.createElement('p');
        p.className = 'tip boot-error error';
        p.textContent = `界面初始化失败：${e && e.message ? e.message : e}`;
        box.appendChild(p);
    }
}

function run() {
    startApp().catch(onBootError);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
} else {
    run();
}
