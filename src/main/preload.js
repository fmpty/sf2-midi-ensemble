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
    midiListDevices: () => ipcRenderer.invoke('app:midi-list'),
    midiOpenAll: () => ipcRenderer.invoke('app:midi-open-all'),
    midiCloseAll: () => ipcRenderer.invoke('app:midi-close-all'),
    onMidiBytes: (handler) => {
        const listener = (_event, payload) => handler(payload);
        ipcRenderer.on('app:midi-bytes', listener);
        return () => ipcRenderer.removeListener('app:midi-bytes', listener);
    },
});
