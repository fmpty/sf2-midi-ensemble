/**
 * 平台适配层：统一「主进程能力」与「浏览器能力」。
 *
 * - Electron 桌面端：走 preload 暴露的 window.api（IPC）
 * - 浏览器 / PWA / 手机：走 fetch + localStorage + <input type=file>
 *
 * 渲染层其它模块只依赖本模块，从而同一套代码可运行在桌面与移动端浏览器。
 */

const SF_DIR = 'assets/soundfonts';
const MANIFEST = `${SF_DIR}/manifest.json`;
const STORE_PREFIX = 'sf2ensemble:';

export function isElectron() {
    return typeof window !== 'undefined' && !!window.api;
}

/** 原生合成插件（Android 安装包）：AAudio + TinySoundFont */
export function nativeSynthPlugin() {
    if (typeof window === 'undefined') return null;
    const cap = window.Capacitor;
    return cap && cap.Plugins ? cap.Plugins.SynthBridge || null : null;
}

export function isMobile() {
    if (typeof navigator === 'undefined') return false;
    return /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent) ||
        (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
}

/** AudioWorklet 处理器源码 */
export async function getProcessorCode() {
    if (isElectron()) return window.api.getProcessorCode();
    const res = await fetch('dist/spessasynth_processor.min.js');
    if (!res.ok) throw new Error(`读取处理器文件失败：${res.status}`);
    return res.text();
}

/** 内置音源清单（Web 模式由构建脚本生成 manifest.json） */
export async function listBuiltinSoundfonts() {
    if (isElectron()) {
        const info = await window.api.getInfo();
        return info.hasBuiltin ? [{ name: '' }] : [];
    }
    try {
        const res = await fetch(MANIFEST, { cache: 'no-cache' });
        if (!res.ok) return [];
        const json = await res.json();
        return (json.files || []).slice().sort((a, b) => (a.size || 0) - (b.size || 0));
    } catch {
        return [];
    }
}

/** 内置音源数据；Web 模式默认取体积最小的一个（移动端更友好），可用 ?sf=文件名 指定 */
export async function getBuiltinSoundfont() {
    if (isElectron()) return window.api.getBuiltinSoundfont();
    const files = await listBuiltinSoundfonts();
    if (!files.length) return null;
    const want = new URLSearchParams(location.search).get('sf');
    const pick = (want && files.find((f) => f.name === want)) || files[0];
    const res = await fetch(`${SF_DIR}/${encodeURIComponent(pick.name)}`);
    if (!res.ok) throw new Error(`读取内置音源失败：${res.status}`);
    return { name: pick.name, data: await res.arrayBuffer() };
}

/** 选择音源文件对话框（浏览器模式用 <input type=file>） */
export function openSoundfont() {
    if (isElectron()) return window.api.openSoundfont();
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.sf2,.sf3,.sfogg,.dls';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', async () => {
            const files = [...input.files];
            const out = [];
            for (const f of files) out.push({ name: f.name, path: '', data: await f.arrayBuffer() });
            input.remove();
            resolve(out);
        });
        input.click();
    });
}

/** 按路径恢复上次载入的外部音源（仅桌面端可用） */
export async function loadSoundfontPaths(paths) {
    if (isElectron()) return window.api.loadSoundfontPaths(paths);
    return [];
}

export async function storeGet(key) {
    if (isElectron()) return window.api.storeGet(key);
    try {
        const raw = localStorage.getItem(STORE_PREFIX + key);
        return raw == null ? undefined : JSON.parse(raw);
    } catch {
        return undefined;
    }
}

export async function storeSet(key, value) {
    if (isElectron()) return window.api.storeSet(key, value);
    try {
        localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
    } catch {
        /* 忽略配额错误 */
    }
    return true;
}

export async function getInfo() {
    if (isElectron()) return window.api.getInfo();
    const files = await listBuiltinSoundfonts();
    return {
        version: 'web',
        platform: isMobile() ? 'mobile-browser' : 'browser',
        hasBuiltin: files.length > 0,
        secureContext: window.isSecureContext,
        webMidi: typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess,
    };
}

/** 请求屏幕常亮（移动端合奏时避免息屏） */
let wakeLock = null;
export async function keepAwake(on) {
    try {
        if (!on) {
            if (wakeLock) { await wakeLock.release(); wakeLock = null; }
            return;
        }
        if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    } catch {
        /* 不支持则忽略 */
    }
}
