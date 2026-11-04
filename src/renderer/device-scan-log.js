/**
 * 将 MIDI 扫描结果完整打进日志（应用内 + console，便于 adb logcat）。
 */
import { midiLayerLog } from './midi-layer-log.js';
import {
    deviceMac,
    isBluetoothMidiEntry,
    isGenericMidiPlaceholderName,
    isMidiDeviceOnline,
    isMidiNamedDevice,
    normalizeMac,
    macFromDeviceId,
} from './device-id.js';

function safeJson(obj) {
    try {
        return JSON.stringify(obj);
    } catch {
        return String(obj);
    }
}

/**
 * @param {(msg: string, kind?: string) => void} logFn
 */
export function logMidiDeviceScanDiagnostics({
    rawNative,
    listInput,
    deduped,
    onlineIds,
    onlineMacs,
    routes,
    extra,
    hub,
    routeOnlineFromScan,
    logFn,
}) {
    const tag = '[MIDI scan]';
    const emit = (msg, kind = 'info') => {
        console.log(tag, msg);
        logFn?.(msg, kind);
    };

    midiLayerLog('L6-diag', 'scan block begin');
    const t = new Date().toLocaleTimeString();
    emit(`scan_diag ${t}`);
    emit(`—— 扫描诊断 ${t} ——`);
    if (extra?.disconnectedMac) {
        emit(`事件 disconnectedMac=${extra.disconnectedMac}`, 'warn');
    }
    if (extra?.nativeDebug) {
        emit(`native_debug ${safeJson(extra.nativeDebug)}`);
    }
    if (extra?.manualProbe && extra?.probe) {
        emit(`probe ${safeJson(extra.probe)}`, 'ok');
    }

    const raw = Array.isArray(rawNative) ? rawNative : [];
    emit(`原生 raw 条数: ${raw.length}`);
    raw.forEach((item, i) => {
        emit(`raw[${i}] ${safeJson(item)}`);
    });

    emit(`传入 list 条数: ${Array.isArray(listInput) ? listInput.length : 0}`);
    emit(`去重 dedupe 条数: ${deduped.length}`);

    deduped.forEach((dev, i) => {
        const id = String(dev.id);
        const mac = normalizeMac(deviceMac(dev));
        const filtered = (isBluetoothMidiEntry(dev) && !isMidiNamedDevice(dev))
            || isGenericMidiPlaceholderName(dev.name);
        const onlineFlag = isMidiDeviceOnline(dev);
        const analysis = {
            index: i,
            id,
            mac,
            name: dev.name,
            type: dev.type,
            connected: dev.connected,
            portOpen: dev.portOpen,
            state: dev.state,
            connection: dev.connection,
            guessBluetooth: dev.guessBluetooth,
            filteredOutOfSyncLoop: filtered,
            isMidiDeviceOnline: onlineFlag,
            inOnlineIds: onlineIds.has(id),
            inOnlineMacs: mac ? onlineMacs.has(mac) : false,
            nativeRaw: dev.nativeRaw,
        };
        emit(`dev[${i}] ${safeJson(analysis)}`);
    });

    emit('—— 路由在线判定 ——');
    const midiRoutes = Object.values(routes || {}).filter((r) => r.kind === 'midi');
    midiRoutes.forEach((r) => {
        const mac = normalizeMac(r.deviceMac) || normalizeMac(macFromDeviceId(r.deviceId));
        const id = r.deviceId ? String(r.deviceId) : '';
        const recent = hub?.isDeviceRecentlyActive?.(id, mac) ?? false;
        const on = routeOnlineFromScan(id, mac, onlineIds, onlineMacs);
        const scanOnly = (id && onlineIds.has(id)) || (mac && onlineMacs.has(mac));
        emit(`route ${r.key} ${safeJson({
            label: r.label || r.name,
            deviceId: id,
            deviceMac: mac,
            uiOnline: r.online,
            computedOnline: on,
            onlineByScan: scanOnly,
            onlineByMidiReport: recent,
        })}`);
    });
    midiLayerLog('L6-diag', 'scan block end', {
        rawN: raw.length,
        dedupedN: deduped.length,
        onlineIds: [...(onlineIds || [])],
        onlineMacs: [...(onlineMacs || [])],
    });
}
