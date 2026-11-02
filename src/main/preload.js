/**
 * 预加载脚本：向渲染层暴露受控的主进程能力。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getProcessorCode: () => ipcRenderer.invoke('app:processor-code'),
    getBuiltinSoundfont: () => ipcRenderer.invoke('app:builtin-soundfont'),
    openSoundfont: () => ipcRenderer.invoke('app:open-soundfont'),
    loadSoundfontPaths: (paths) => ipcRenderer.invoke('app:load-soundfont-paths', paths),
    storeGet: (key) => ipcRenderer.invoke('app:store-get', key),
    storeSet: (key, value) => ipcRenderer.invoke('app:store-set', key, value),
    getInfo: () => ipcRenderer.invoke('app:info'),
});
