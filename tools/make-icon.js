/**
 * 程序化绘制应用图标：
 * 1. 以 1024×1024 超采样渲染（SDF 抗锯齿），合成暗色底 + 青色声波 + 钢琴键盘 + 八分音符；
 * 2. 盒式降采样到 256/128/64/48/32/24/16；
 * 3. 写出经典 DIB 格式（32bpp BGRA + AND 掩码）的 .ico，兼容 rcedit / electron-builder；
 * 4. 附带输出一份 512×512 的 PNG 预览图，方便肉眼查看。
 *
 * 运行：node tools/make-icon.js
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const N = 1024;
const ICON_SIZES = [256, 128, 64, 48, 32, 24, 16];
const ICO_PATH = path.join(ROOT, 'assets', 'icon.ico');
const PNG_PATH = path.join(ROOT, 'assets', 'icons', 'icon-512.png');

/* ------------------------------ 渲染 ------------------------------ */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// 距离 d（画布归一化单位）→ 覆盖率，羽化约 1.3 px
const cover = (d) => clamp01(0.5 - d * N / 1.3);
const smoothstep = (a, b, x) => {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
};

const sRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
    const c = i / 255;
    sRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LINEAR_TO_SRGB = new Float64Array(256);
for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LINEAR_TO_SRGB[i] = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

const hex = (s) => [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];

const BG_TOP = hex('16202c');
const BG_BOTTOM = hex('090c11');
const GLOW = hex('1ec8ac');
const ARC = hex('3ee0c4');
const KEY_WHITE = hex('e9eef4');
const KEY_WHITE_BOTTOM = hex('c2cbd6');
const KEY_BLACK = hex('0b0f13');
const NOTE = hex('46e8cd');

function sdRoundBox(px, py, cx, cy, hw, hh, r) {
    const qx = Math.abs(px - cx) - hw + r;
    const qy = Math.abs(py - cy) - hh + r;
    const mx = qx > 0 ? qx : 0;
    const my = qy > 0 ? qy : 0;
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(mx, my) - r;
}

function sdEllipse(px, py, cx, cy, rx, ry, rot) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const dx = px - cx;
    const dy = py - cy;
    const lx = dx * c + dy * s;
    const ly = -dx * s + dy * c;
    const k = Math.hypot(lx / rx, ly / ry) - 1;
    return k * Math.min(rx, ry);
}

/** 二次贝塞尔离散成折线，用于音符的符尾 */
function bezierPoints(p0, c, p1, steps) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        pts.push([
            mt * mt * p0[0] + 2 * mt * t * c[0] + t * t * p1[0],
            mt * mt * p0[1] + 2 * mt * t * c[1] + t * t * p1[1],
        ]);
    }
    return pts;
}

const NOTE_CX = 0.455;
const NOTE_CY = 0.44;
const FLAG_PTS = bezierPoints([0.529, 0.262], [0.642, 0.318], [0.612, 0.398], 40);
const FLAG_BBOX = (() => {
    let x0 = 1; let y0 = 1; let x1 = 0; let y1 = 0;
    for (const [x, y] of FLAG_PTS) {
        const pad = 0.06;
        x0 = Math.min(x0, x - pad); y0 = Math.min(y0, y - pad);
        x1 = Math.max(x1, x + pad); y1 = Math.max(y1, y + pad);
    }
    return [x0, y0, x1, y1];
})();

function sdPolyline(px, py, pts, thickness) {
    let best = 1e9;
    for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[i + 1];
        const ex = bx - ax;
        const ey = by - ay;
        const len2 = ex * ex + ey * ey;
        let t = len2 ? ((px - ax) * ex + (py - ay) * ey) / len2 : 0;
        t = clamp01(t);
        const dx = px - (ax + ex * t);
        const dy = py - (ay + ey * t);
        const d = Math.hypot(dx, dy);
        if (d < best) best = d;
    }
    return best - thickness / 2;
}

/** 合成单点颜色（返回线性空间的 rgb 与 alpha） */
function shade(u, v) {
    // 1. 背景：圆角矩形 + 竖直渐变 + 青色辉光
    const bg = sdRoundBox(u, v, 0.5, 0.5, 0.465, 0.465, 0.2);
    let r = BG_BOTTOM[0] + (BG_TOP[0] - BG_BOTTOM[0]) * (1 - v);
    let g = BG_BOTTOM[1] + (BG_TOP[1] - BG_BOTTOM[1]) * (1 - v);
    let b = BG_BOTTOM[2] + (BG_TOP[2] - BG_BOTTOM[2]) * (1 - v);

    const gd = Math.hypot(u - 0.5, v - 0.52) / 0.42;
    const glow = Math.exp(-gd * gd) * 0.35;
    r += (GLOW[0] - r) * glow;
    g += (GLOW[1] - g) * glow;
    b += (GLOW[2] - b) * glow;

    let a = cover(bg);
    let lr = sRGB_TO_LINEAR[Math.round(r)];
    let lg = sRGB_TO_LINEAR[Math.round(g)];
    let lb = sRGB_TO_LINEAR[Math.round(b)];

    const over = (cr, cg, cb, alpha) => {
        if (alpha <= 0) return;
        lr = lr * (1 - alpha) + cr * alpha;
        lg = lg * (1 - alpha) + cg * alpha;
        lb = lb * (1 - alpha) + cb * alpha;
    };

    // 2. 声波：以音符头为圆心的三段同心弧，只保留上方，两端渐隐
    const arcDefs = [
        { R: 0.175, th: 0.016, alpha: 0.9 },
        { R: 0.275, th: 0.015, alpha: 0.6 },
        { R: 0.375, th: 0.014, alpha: 0.35 },
    ];
    const ang = Math.atan2(v - NOTE_CY - 0.02, u - NOTE_CX);
    const norm = (ang + 2 * Math.PI) % (2 * Math.PI);
    const t = (norm > Math.PI ? norm - 2 * Math.PI : norm); // (-π, π]
    const fade = smoothstep(-2.62, -2.3, t) * smoothstep(-0.62, -0.95, t);
    for (const arc of arcDefs) {
        const cov = cover(Math.abs(Math.hypot(u - NOTE_CX, v - NOTE_CY - 0.02) - arc.R) - arc.th / 2);
        over(sRGB_TO_LINEAR[ARC[0]], sRGB_TO_LINEAR[ARC[1]], sRGB_TO_LINEAR[ARC[2]],
            cov * fade * arc.alpha);
    }

    // 3. 键盘：7 个白键 + 5 个黑键
    const KHW = 0.36;
    const KCX = 0.5;
    const KCY = 0.735;
    const KHH = 0.15;
    const kbIn = cover(sdRoundBox(u, v, KCX, KCY, KHW, KHH, 0.05));
    if (kbIn > 0) {
        const left = KCX - KHW + 0.035;
        const right = KCX + KHW - 0.035;
        const kw = (right - left) / 7;
        const kbTop = KCY - KHH + 0.024;
        let keyA = 0;
        let kr = 0; let kg = 0; let kb2 = 0;
        for (let i = 0; i < 7; i++) {
            const cx = left + kw * (i + 0.5);
            const d = sdRoundBox(u, v, cx, KCY, kw / 2 - 0.004, KHH - 0.024, 0.012);
            const c = cover(d);
            if (c > 0) {
                const shade = 1 - (v - (KCY - KHH)) / (2 * KHH);
                const lr2 = 1 - (1 - sRGB_TO_LINEAR[KEY_WHITE[0]]) * shade;
                const lg2 = 1 - (1 - sRGB_TO_LINEAR[KEY_WHITE[1]]) * shade;
                const lb2 = 1 - (1 - sRGB_TO_LINEAR[KEY_WHITE[2]]) * shade;
                const mix = clamp01(shade * 0.85);
                kr = kr * (1 - c) + (lr2 * (1 - mix) + sRGB_TO_LINEAR[KEY_WHITE_BOTTOM[0]] * mix) * c;
                kg = kg * (1 - c) + (lg2 * (1 - mix) + sRGB_TO_LINEAR[KEY_WHITE_BOTTOM[1]] * mix) * c;
                kb2 = kb2 * (1 - c) + (lb2 * (1 - mix) + sRGB_TO_LINEAR[KEY_WHITE_BOTTOM[2]] * mix) * c;
                keyA = keyA * (1 - c) + c;
            }
        }
        for (const i of [0, 1, 3, 4, 5]) {
            const cx = left + kw * (i + 1);
            const d = sdRoundBox(u, v, cx, kbTop + 0.095, kw * 0.3, 0.095, 0.008);
            const c = cover(d);
            if (c > 0) {
                kr = kr * (1 - c) + sRGB_TO_LINEAR[KEY_BLACK[0]] * c;
                kg = kg * (1 - c) + sRGB_TO_LINEAR[KEY_BLACK[1]] * c;
                kb2 = kb2 * (1 - c) + sRGB_TO_LINEAR[KEY_BLACK[2]] * c;
                keyA = keyA * (1 - c) + c;
            }
        }
        over(kr, kg, kb2, keyA);
    }

    // 4. 八分音符：符头（旋转椭圆）+ 符干 + 符尾
    const noteA = Math.max(
        cover(sdEllipse(u, v, NOTE_CX, NOTE_CY, 0.082, 0.06, -0.38)),
        cover(sdRoundBox(u, v, NOTE_CX + 0.073, NOTE_CY - 0.085, 0.011, 0.095, 0.006))
    );
    let flagA = 0;
    const [bx0, by0, bx1, by1] = FLAG_BBOX;
    if (u >= bx0 && u <= bx1 && v >= by0 && v <= by1) {
        flagA = cover(sdPolyline(u, v, FLAG_PTS, 0.02));
    }
    const na = Math.max(noteA, flagA);
    if (na > 0) {
        over(sRGB_TO_LINEAR[NOTE[0]], sRGB_TO_LINEAR[NOTE[1]], sRGB_TO_LINEAR[NOTE[2]], na);
    }

    // 圆角外的像素直接透明
    const finalA = Math.min(a, 1);
    return [lr, lg, lb, finalA];
}

function renderFull() {
    const px = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const u = (x + 0.5) / N;
            const v = (y + 0.5) / N;
            const [r, g, b, a] = shade(u, v);
            const i = (y * N + x) * 4;
            px[i] = Math.round(clamp01(LINEAR_TO_SRGB[Math.round(clamp01(r) * 255)]) * 255);
            px[i + 1] = Math.round(clamp01(LINEAR_TO_SRGB[Math.round(clamp01(g) * 255)]) * 255);
            px[i + 2] = Math.round(clamp01(LINEAR_TO_SRGB[Math.round(clamp01(b) * 255)]) * 255);
            px[i + 3] = Math.round(clamp01(a) * 255);
        }
    }
    return px;
}

/** 线性光盒式降采样 */
function downsample(src, srcSize, dstSize) {
    const out = new Uint8Array(dstSize * dstSize * 4);
    const step = srcSize / dstSize;
    const lin = new Float32Array(dstSize * dstSize * 4);
    const cnt = new Float32Array(dstSize * dstSize);
    for (let y = 0; y < srcSize; y++) {
        const dy = Math.min(dstSize - 1, Math.floor(y / step));
        for (let x = 0; x < srcSize; x++) {
            const dx = Math.min(dstSize - 1, Math.floor(x / step));
            const si = (y * srcSize + x) * 4;
            const di = (dy * dstSize + dx) * 4;
            const a = src[si + 3] / 255;
            if (a <= 0) continue;
            lin[di] += sRGB_TO_LINEAR[src[si]] * a;
            lin[di + 1] += sRGB_TO_LINEAR[src[si + 1]] * a;
            lin[di + 2] += sRGB_TO_LINEAR[src[si + 2]] * a;
            lin[di + 3] += a;
            cnt[dy * dstSize + dx] += a;
        }
    }
    for (let i = 0; i < dstSize * dstSize; i++) {
        const w = cnt[i];
        const o = i * 4;
        if (w <= 0) continue;
        out[o] = Math.round(clamp01(LINEAR_TO_SRGB[Math.round(clamp01(lin[o] / w) * 255)]) * 255);
        out[o + 1] = Math.round(clamp01(LINEAR_TO_SRGB[Math.round(clamp01(lin[o + 1] / w) * 255)]) * 255);
        out[o + 2] = Math.round(clamp01(LINEAR_TO_SRGB[Math.round(clamp01(lin[o + 2] / w) * 255)]) * 255);
        out[o + 3] = Math.round(clamp01(w / (step * step)) * 255);
    }
    return out;
}

/* ------------------------------ 编码 ------------------------------ */

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, size) {
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
        const rowStart = y * (size * 4 + 1);
        raw[rowStart] = 0;
        for (let x = 0; x < size; x++) {
            const s = (y * size + x) * 4;
            const d = rowStart + 1 + x * 4;
            raw[d] = rgba[s];
            raw[d + 1] = rgba[s + 1];
            raw[d + 2] = rgba[s + 2];
            raw[d + 3] = rgba[s + 3];
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

/** 经典 DIB 条目（32bpp BGRA 自下而上 + 1bpp AND 掩码） */
function icoImage(rgba, size) {
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(size, 4);
    header.writeInt32LE(size * 2, 8); // XOR + AND
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    const xorSize = size * size * 4;
    const maskRow = Math.ceil(size / 32) * 4;
    const xor = Buffer.alloc(xorSize);
    const mask = Buffer.alloc(maskRow * size);
    for (let y = 0; y < size; y++) {
        const dst = (size - 1 - y) * size * 4;
        for (let x = 0; x < size; x++) {
            const s = (y * size + x) * 4;
            xor[dst + x * 4] = rgba[s + 2];
            xor[dst + x * 4 + 1] = rgba[s + 1];
            xor[dst + x * 4 + 2] = rgba[s];
            xor[dst + x * 4 + 3] = rgba[s + 3];
            if (rgba[s + 3] === 0) mask[y * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
        }
    }
    return Buffer.concat([header, xor, mask]);
}

function encodeICO(images) {
    const dir = Buffer.alloc(6);
    dir.writeUInt16LE(1, 2); // type: icon
    dir.writeUInt16LE(images.length, 4);
    let offset = 6 + images.length * 16;
    const entries = [];
    for (const { size, data } of images) {
        const e = Buffer.alloc(16);
        e[0] = size >= 256 ? 0 : size;
        e[1] = size >= 256 ? 0 : size;
        e[2] = 0;
        e[3] = 0;
        e.writeUInt16LE(1, 4);
        e.writeUInt16LE(32, 6);
        e.writeUInt32LE(data.length, 8);
        e.writeUInt32LE(offset, 12);
        offset += data.length;
        entries.push(e);
    }
    return Buffer.concat([dir, ...entries, ...images.map((i) => i.data)]);
}

/* ------------------------------ 主流程 ------------------------------ */

function main() {
    console.time('render');
    const full = renderFull();
    console.timeEnd('render');

    const images = ICON_SIZES.map((size) => ({
        size,
        data: icoImage(downsample(full, N, size), size),
    }));

    fs.mkdirSync(path.join(ROOT, 'assets', 'icons'), { recursive: true });
    fs.writeFileSync(ICO_PATH, encodeICO(images));
    fs.writeFileSync(PNG_PATH, encodePNG(downsample(full, N, 512), 512));
    console.log('图标已生成：', path.relative(ROOT, ICO_PATH),
        `(${(fs.statSync(ICO_PATH).size / 1024).toFixed(0)} KB, ${ICON_SIZES.join('/')} px)`);
    console.log('预览图：', path.relative(ROOT, PNG_PATH));
}

main();
