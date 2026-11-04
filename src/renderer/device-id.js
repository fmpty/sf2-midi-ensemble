/**
 * MIDI 设备稳定标识：蓝牙按 MAC 去重，配置与路由 key 与系统分配的 id 解耦。
 */

export function normalizeMac(raw) {
    if (raw == null || raw === '') return '';
    const hex = String(raw).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (hex.length !== 12) return hex;
    return hex.match(/.{2}/g).join(':');
}

export function macFromCompact(compact) {
    return normalizeMac(compact);
}

/** 从原生 id（bt#AABBCC…）或 Web MIDI id 字符串中提取 MAC */
export function macFromDeviceId(id) {
    const s = String(id || '');
    if (s.startsWith('bt#')) return macFromCompact(s.slice(3));
    const m = s.match(/([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/);
    return m ? normalizeMac(m[0]) : '';
}

export function deviceMac(dev) {
    if (dev.mac) return normalizeMac(dev.mac);
    return macFromDeviceId(dev.id);
}

/** 蓝牙手柄：名称须包含 midi（不区分大小写） */
export function isMidiNamedDevice(dev) {
    return /midi/i.test(String(dev?.name || ''));
}

/** Android 系统占位 MIDI 口（英文管理/虚拟名），非真实手柄 */
export function isGenericMidiPlaceholderName(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return true;
    if (n === 'midi' || n === 'ble midi' || n === 'bluetooth midi') return true;
    if (n.includes('android') && n.includes('bluetooth') && n.includes('midi')) return true;
    return /^midi\s*device\s*\d*$/.test(n);
}

export function isBluetoothMidiEntry(dev) {
    const id = String(dev?.id || '');
    const type = String(dev?.type || '').toLowerCase();
    return type === 'bluetooth' || id.startsWith('bt#') || !!dev?.guessBluetooth;
}

/** 在线：Android/iOS 看 portOpen；Web MIDI 看 state/connection */
export function isMidiDeviceOnline(dev) {
    if (dev.portOpen === true) return true;
    if (dev.statusCode === 3) return true;
    if (dev.state === 'disconnected') return false;
    if (dev.state === 'connected') return true;
    if (dev.connection === 'open') return true;
    return false;
}

/**
 * @returns {{ routeKey: string, deviceId: string, deviceMac: string }}
 */
export function identityForDevice(dev) {
    const deviceId = String(dev.id);
    const mac = deviceMac(dev);
    if (mac) {
        return { routeKey: `midi:mac:${mac}`, deviceId, deviceMac: mac };
    }
    // 与早期版本一致：midi:${id}，否则 seen 对不上会误标「已断开」
    return { routeKey: `midi:${deviceId}`, deviceId, deviceMac: '' };
}

/** 同一 MAC 多条记录时优先：已连接、id 为 bt#、名称更长等 */
export function pickPreferredDevice(a, b) {
    const score = (d) => {
        let s = 0;
        if (isMidiDeviceOnline(d)) s += 8;
        if (String(d.id).startsWith('bt#')) s += 4;
        if (d.mac) s += 2;
        if (isGenericMidiPlaceholderName(d.name)) s -= 16;
        s += Math.min(4, (d.name || '').length / 20);
        return s;
    };
    return score(a) >= score(b) ? a : b;
}

/** 按 MAC（或无 MAC 则 routeKey）去重；含尚未打开端口的项（避免「系统有设备但列表全空」） */
export function dedupeDevices(list) {
    const map = new Map();
    for (const dev of Array.isArray(list) ? list : []) {
        const { routeKey, deviceMac: mac } = identityForDevice(dev);
        const mapKey = mac || routeKey;
        const prev = map.get(mapKey);
        map.set(mapKey, prev ? pickPreferredDevice(prev, dev) : dev);
    }
    return [...map.values()];
}

const PROFILE_SKIP = new Set(['key', 'deviceId', 'deviceMac', 'name', 'online', 'guessBluetooth', 'kind']);

export function snapshotRouteProfile(route) {
    const out = {};
    for (const [k, v] of Object.entries(route)) {
        if (!PROFILE_SKIP.has(k)) out[k] = v;
    }
    return out;
}

export function applyRouteProfile(route, profile) {
    if (!profile) return;
    for (const [k, v] of Object.entries(profile)) {
        if (!PROFILE_SKIP.has(k)) route[k] = v;
    }
}
