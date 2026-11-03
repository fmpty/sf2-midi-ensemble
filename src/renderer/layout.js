/**
 * 响应式分档：手机 / 平板 / 桌面（与 CSS 的 data-layout 一致）。
 * 断点：<600 phone，600–1023 tablet，≥1024 desktop（CSS 像素）。
 */

export const BREAKPOINTS = { phone: 600, tablet: 1024 };

export function tierFromWidth(w) {
    if (w < BREAKPOINTS.phone) return 'phone';
    if (w < BREAKPOINTS.tablet) return 'tablet';
    return 'desktop';
}

/** 竖屏三排：白键高度 / 白键宽度 */
export const JIANPU_WHITE_ASPECT = 4.2;
export const JIANPU_ROW_GAP = 14;

export function applyLayout() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const tier = tierFromWidth(w);
    const orient = h >= w ? 'portrait' : 'landscape';
    const root = document.documentElement;

    root.dataset.layout = tier;
    root.dataset.orient = orient;

    const touch =
        window.matchMedia('(pointer: coarse)').matches ||
        window.matchMedia('(hover: none)').matches;
    document.body.classList.toggle('touch-ui', touch);

    scheduleSyncJianpuPianoMetrics();

    return { tier, orient, width: w, height: h, touch };
}

/**
 * 竖屏三排高度：按 piano-wrap 实际宽高计算（避免 cqw/cqh 与 .piano 全局高度冲突）。
 * 理想总高 = 3×(宽/7×aspect)+间距；若 slot 不够高则压到 slot 内三等分。
 */
let jianpuWrapObs = null;
let jianpuSyncGen = 0;

function debounce(fn, ms) {
    let t = 0;
    return () => {
        clearTimeout(t);
        t = setTimeout(fn, ms);
    };
}

const onJianpuWrapResize = debounce(() => syncJianpuPianoMetrics(), 60);

function jianpuWrapEl() {
    return document.querySelector('#pane-play .piano-wrap');
}

/** Android 旋转/亮屏后 flex 尺寸常滞后，需多帧重试 + ResizeObserver */
export function scheduleSyncJianpuPianoMetrics() {
    const gen = ++jianpuSyncGen;
    const attempt = (delay) => {
        setTimeout(() => {
            if (gen !== jianpuSyncGen) return;
            syncJianpuPianoMetrics({ gen });
        }, delay);
    };
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (gen !== jianpuSyncGen) return;
            syncJianpuPianoMetrics({ gen });
        });
    });
    attempt(0);
    attempt(80);
    attempt(200);
    attempt(450);
}

function ensureJianpuWrapObserver() {
    const wrap = jianpuWrapEl();
    if (!wrap || jianpuWrapObs) return;
    jianpuWrapObs = new ResizeObserver(() => {
        if (document.documentElement.dataset.orient !== 'portrait') return;
        const piano = document.getElementById('piano');
        if (!piano?.classList.contains('jianpu')) return;
        onJianpuWrapResize();
    });
    jianpuWrapObs.observe(wrap);
}

/** @param {{ gen?: number }} [opts] */
export function syncJianpuPianoMetrics(opts = {}) {
    const root = document.documentElement;
    if (root.dataset.orient !== 'portrait') {
        jianpuSyncGen++;
        root.style.removeProperty('--jianpu-slot-w');
        root.style.removeProperty('--jianpu-slot-h');
        root.style.removeProperty('--jianpu-total-h');
        return;
    }
    ensureJianpuWrapObserver();
    const wrap = jianpuWrapEl();
    const piano = document.getElementById('piano');
    if (!wrap || !piano?.classList.contains('jianpu')) return;

    const slotW = wrap.clientWidth;
    const slotH = wrap.clientHeight;
    const rowH = slotW >= 1 ? (slotW / 7) * JIANPU_WHITE_ASPECT : 0;
    const ideal = rowH > 0 ? 3 * rowH + 2 * JIANPU_ROW_GAP : 0;
    // 布局未完成或 WebView 过渡帧：slot 异常偏小，勿写入否则会被压扁并贴底
    const minSlotH = Math.max(96, Math.round(window.innerHeight * 0.14));
    const layoutReady = slotW >= 48 && slotH >= minSlotH && ideal >= 80;
    if (!layoutReady) return;

    const total = Math.min(ideal, slotH);

    root.style.setProperty('--jianpu-slot-w', `${slotW}px`);
    root.style.setProperty('--jianpu-slot-h', `${slotH}px`);
    root.style.setProperty('--jianpu-total-h', `${total}px`);
}

/** @param {(info: ReturnType<typeof applyLayout>) => void} [onChange] */
export function initLayout(onChange) {
    const run = () => {
        const info = applyLayout();
        if (onChange) onChange(info);
    };
    run();
    window.addEventListener('resize', debounce(run, 100));
    window.addEventListener('orientationchange', () => {
        setTimeout(run, 150);
        scheduleSyncJianpuPianoMetrics();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            run();
            scheduleSyncJianpuPianoMetrics();
        }
    });
    window.addEventListener('pageshow', () => scheduleSyncJianpuPianoMetrics());
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', debounce(() => scheduleSyncJianpuPianoMetrics(), 80));
    }
    return run;
}
