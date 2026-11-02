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

    syncJianpuPianoMetrics();

    return { tier, orient, width: w, height: h, touch };
}

/**
 * 竖屏三排高度：按 piano-wrap 实际宽高计算（避免 cqw/cqh 与 .piano 全局高度冲突）。
 * 理想总高 = 3×(宽/7×aspect)+间距；若 slot 不够高则压到 slot 内三等分。
 */
export function syncJianpuPianoMetrics() {
    const root = document.documentElement;
    if (root.dataset.orient !== 'portrait') {
        root.style.removeProperty('--jianpu-slot-w');
        root.style.removeProperty('--jianpu-slot-h');
        root.style.removeProperty('--jianpu-total-h');
        return;
    }
    const wrap = document.querySelector('#pane-play .piano-wrap');
    const piano = document.getElementById('piano');
    if (!wrap || !piano?.classList.contains('jianpu')) return;

    const slotW = wrap.clientWidth;
    const slotH = wrap.clientHeight;
    if (slotW < 1 || slotH < 1) return;

    const rowH = (slotW / 7) * JIANPU_WHITE_ASPECT;
    const ideal = 3 * rowH + 2 * JIANPU_ROW_GAP;
    const total = Math.min(ideal, slotH);

    root.style.setProperty('--jianpu-slot-w', `${slotW}px`);
    root.style.setProperty('--jianpu-slot-h', `${slotH}px`);
    root.style.setProperty('--jianpu-total-h', `${total}px`);
}

function debounce(fn, ms) {
    let t = 0;
    return () => {
        clearTimeout(t);
        t = setTimeout(fn, ms);
    };
}

/** @param {(info: ReturnType<typeof applyLayout>) => void} [onChange] */
export function initLayout(onChange) {
    const run = () => {
        const info = applyLayout();
        if (onChange) onChange(info);
    };
    run();
    window.addEventListener('resize', debounce(run, 100));
    window.addEventListener('orientationchange', () => setTimeout(run, 150));
    return run;
}
