/**
 * 是否允许该路由接收并播放 MIDI（与 syncDevices / portOpen 一致，不用「有输入就算在线」）。
 */
export function routeAcceptsMidiInput(route) {
    if (!route || route.enabled === false) return false;
    if (route.kind !== 'midi') return true;
    return route.online !== false;
}
