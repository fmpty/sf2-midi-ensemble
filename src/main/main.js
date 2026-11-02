/**
 * Electron 主进程：窗口、权限（Web MIDI / 蓝牙 MIDI）、文件访问与配置持久化。
 */
const { app, BrowserWindow, ipcMain, dialog, session, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer');
const SOUNDFONT_DIR = path.join(ROOT, 'assets', 'soundfonts');
const PROCESSOR = path.join(RENDERER_DIR, 'dist', 'spessasynth_processor.min.js');
const SOUNDFONT_EXT = ['sf2', 'sf3', 'sfogg', 'dls'];

let win = null;
let storePath = '';
let store = {};

function processorCode() {
    if (!fs.existsSync(PROCESSOR)) {
        throw new Error(`缺少 AudioWorklet 处理器文件：${PROCESSOR}，请先执行 npm run build`);
    }
    return fs.readFileSync(PROCESSOR, 'utf8');
}

function findBuiltinSoundfont() {
    if (!fs.existsSync(SOUNDFONT_DIR)) return null;
    const files = fs.readdirSync(SOUNDFONT_DIR)
        .filter((f) => SOUNDFONT_EXT.includes(path.extname(f).slice(1).toLowerCase()))
        .sort();
    return files.length ? path.join(SOUNDFONT_DIR, files[0]) : null;
}

async function readSoundfontFiles(filePaths) {
    const out = [];
    for (const p of filePaths) {
        try {
            const data = await fsp.readFile(p);
            out.push({ name: path.basename(p), path: p, data });
        } catch (e) {
            console.warn('读取音源失败', p, e.message);
        }
    }
    return out;
}

async function loadStore() {
    storePath = path.join(app.getPath('userData'), 'config.json');
    try {
        store = JSON.parse(await fsp.readFile(storePath, 'utf8'));
    } catch {
        store = {};
    }
}

async function persistStore() {
    try {
        await fsp.writeFile(storePath, JSON.stringify(store));
    } catch (e) {
        console.warn('配置保存失败', e.message);
    }
}

function createMenu(show) {
    if (!show) {
        Menu.setApplicationMenu(null);
        return;
    }
    const template = [
        {
            label: '文件',
            submenu: [
                {
                    label: '载入音源…',
                    accelerator: 'CmdOrCtrl+O',
                    click: async () => {
                        const files = await pickSoundfonts();
                        if (files.length) win.webContents.send('app:open-soundfont-files', files.map((f) => ({ name: f.name, path: f.path })));
                    },
                },
                { type: 'separator' },
                { role: 'quit', label: '退出' },
            ],
        },
        {
            label: '视图',
            submenu: [
                { role: 'reload', label: '重新加载' },
                { role: 'toggleDevTools', label: '开发者工具' },
                { role: 'togglefullscreen', label: '全屏' },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function pickSoundfonts() {
    const res = await dialog.showOpenDialog(win, {
        title: '选择 SoundFont / DLS 音源文件',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '音源文件', extensions: SOUNDFONT_EXT }, { name: '所有文件', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePaths.length) return [];
    return readSoundfontFiles(res.filePaths);
}

function createWindow() {
    const platform = process.platform;
    const useOverlay = platform === 'win32';
    const opts = {
        width: 1360,
        height: 900,
        minWidth: 1080,
        minHeight: 700,
        backgroundColor: '#0e1116',
        title: 'SF2 MIDI Ensemble',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false,
        },
    };
    if (useOverlay) {
        opts.titleBarStyle = 'hidden';
        opts.titleBarOverlay = {
            color: '#151a22',
            symbolColor: '#e6edf6',
            height: 36,
        };
    } else if (platform === 'darwin') {
        opts.titleBarStyle = 'hiddenInset';
    }
    win = new BrowserWindow(opts);
    if (app.isPackaged) win.setMenuBarVisibility(false);

    // Web MIDI（含蓝牙 MIDI / SysEx）权限
    const allow = (permission) => ['midi', 'midiSysex'].includes(permission);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allow(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allow(permission));

    win.loadFile(path.join(RENDERER_DIR, 'index.html'));
}

app.whenReady().then(async () => {
    await loadStore();
    createMenu(!app.isPackaged);
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:processor-code', () => processorCode());

ipcMain.handle('app:builtin-soundfont', async () => {
    const file = findBuiltinSoundfont();
    if (!file) return null;
    const data = await fsp.readFile(file);
    return { name: path.basename(file), data };
});

ipcMain.handle('app:open-soundfont', async () => pickSoundfonts());

ipcMain.handle('app:load-soundfont-paths', async (_e, paths) => {
    const valid = (paths || []).filter((p) => typeof p === 'string' && fs.existsSync(p));
    return readSoundfontFiles(valid);
});

ipcMain.handle('app:store-get', (_e, key) => store[key]);

ipcMain.handle('app:store-set', async (_e, key, value) => {
    store[key] = value;
    await persistStore();
    return true;
});

ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
    hasBuiltin: !!findBuiltinSoundfont(),
    compactChrome: true,
}));
