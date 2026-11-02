# SF2 MIDI Ensemble

跨平台桌面应用：**内置 / 加载 SoundFont（SF2/SF3/DLS）音源**，同时接入**多个蓝牙 MIDI 手柄**，各手柄独立占用一个 MIDI 通道、独立选择乐器，实现多人同时演奏多个乐器。

- 图形/音频栈：Electron（Windows / macOS / Linux）
- 合成引擎：[spessasynth_lib](https://github.com/spessasus/spessasynth_lib)（基于 AudioWorklet，运行在独立音频线程，支持 SF2/SF3/SFOGG/DLS、GM/GS/XG、多通道、多音源库）
- MIDI：Web MIDI API（Chromium 原生支持蓝牙 BLE-MIDI 与 USB MIDI）

## 快速开始

```bash
npm install          # 安装依赖（含 Electron）
npm run build        # 用 esbuild 打包渲染层，并复制 AudioWorklet 处理器
npm start            # 启动应用
```

开发模式（监听文件变化）：

```bash
npm run watch        # 另一个终端执行 npm start
```

打包成安装包 / 可执行文件：

```bash
npm run dist         # 产出 Windows NSIS / macOS dmg / Linux AppImage
```

移动端安装包（Capacitor 原生壳）：

```bash
npm run mobile:android   # 自动下载 JDK 21、编译 APK
npm run mobile:ios       # 同步 Web 资源并打开 Xcode（需 macOS）
```

也可直接在浏览器 / PWA 打开（`tools/serve.js` 静态服务），无需安装。

自动化冒烟测试（启动应用、载入内置音源、检查多路同时发声，结果写入 `tools/smoke.log`）：

```bash
npm run smoke
```

## 内置音源

内置音源为 **GeneralUser GS**（S. Christian Collins 制作的免费 GM/GS 音源），以 npm 包
[`generaluser`](https://www.npmjs.com/package/generaluser) 形式引入，无需外网下载。

执行 `npm run build` 时会自动把它复制到 `assets/soundfonts/`（约 30 MB，已 271 个可用音色）。
若该目录已有 `.sf2/.sf3/.dls` 文件，则优先使用你自己的文件。

也可以随时通过界面按钮或**拖拽文件**载入自己的音源（推荐 FluidR3_GM、MuseScore_General 等）。

## 使用说明

1. 点击 **启动音频引擎**（浏览器策略要求用户手势），应用会自动载入内置音源并扫描 MIDI 设备。
2. 蓝牙 MIDI 手柄：先在操作系统蓝牙设置里完成配对，然后点 **扫描设备**。
   - Windows 10/11、macOS、Linux 上的 Chromium 均原生支持 BLE-MIDI。
   - 若设备显示「已断开」，点击扫描会尝试重新打开端口触发连接。
3. 每个手柄卡片可独立设置：
   - **通道**：默认自动分配互不冲突的通道（最多可扩展到 32 路），支持多手柄同时演奏不串音；
   - **乐器**：来自当前音源的全部预设（含鼓组/打击乐）；
   - **音量 / 声像 / 混响 / 合唱 / 移调 / 力度曲线**；
   - **静音 / 独奏 / 允许手柄自身切换音色**。
4. **电脑键盘虚拟手柄**：`A W S E D F T G Y H U J K O L P` 演奏，`Z / X` 切换八度；它是一个独立的「手柄」，可分配到任意通道与乐器，方便无硬件时试音或多人分键盘合奏。
5. 底栏虚拟钢琴：点选某个设备卡片后点击「选中」，即可用鼠标试奏该路乐器。
6. **全部停音**（Panic）用于紧急静音；**复位**重置合成器状态。
7. 所有映射与参数会自动保存（Electron 用户数据目录 `config.json`），下次启动自动恢复；外部音源路径也会记住并自动重新载入。

## 目录结构

```
src/main/        Electron 主进程：窗口、MIDI 权限、文件对话框、配置持久化
src/main/preload.js  受控 API 桥（contextBridge）
src/renderer/    界面与逻辑（ES 模块，经 esbuild 打包）
  ├─ app.js      界面渲染、设备-乐器映射、配置持久化
  ├─ synth.js    合成引擎封装（音源管理、通道分配、乐器切换）
  ├─ midi.js     Web MIDI 设备管理（蓝牙/USB）与消息路由
  ├─ keyboard.js 电脑键盘虚拟手柄
  └─ gm.js       GM 音色名称表
assets/soundfonts/   内置音源
scripts/build.js     esbuild 构建 + 复制 AudioWorklet 处理器
tools/smoke.js  自动化冒烟测试（npx electron tools/smoke.js）
mobile/              原生 MIDI 插件源码（Android Kotlin / iOS Swift），由 scripts/sync-native.js 注入工程
android/ ios/        Capacitor 生成的原生工程（由 npx cap add 生成）
www/                 供 Capacitor 使用的 Web 资源（构建时生成）
```

## 移动端（Android / iOS 安装包）

Electron 不支持移动端，因此移动端用 **Capacitor** 复用同一套 Web 内核：

```
渲染层（HTML/CSS/JS + spessasynth + 界面）  ←→  平台适配层 platform.js
   ├─ Electron（桌面，window.api IPC）
   ├─ 浏览器 / PWA（fetch + localStorage + <input type=file>）
   └─ Capacitor（Android / iOS 安装包，原生 MIDI 插件）
```

### 音频延迟（尤其 Android）

顶栏新增「低延迟」开关（默认开）：以 `latencyHint: 0` 创建 AudioContext，请求系统最小音频缓冲；
启动日志会打印 `缓冲 x ms / 输出 y ms`，便于对比。其余降延迟措施：

- 移动端默认把复音上限从 160 降到 64（CPU 欠载会间接放大延迟与卡顿）；
- 关闭卷积混响，仅使用合成器内置效果；
- 不强制采样率，避免系统重采样带来的额外缓冲。

> 若某台 Android 机器仍显示 300~400 ms，那是该系统 WebView 走的是 Android「深度缓冲」音频通路，
> JS 侧无法再压低，需要原生 AAudio/Oboe 输出通道（Android 8.1+ 支持）才能到 20 ms 级。

| 平台 | 方式 |
|---|---|
| 桌面 Electron | Web MIDI（含 SysEx，蓝牙/USB 皆可） |
| Android App | **原生插件 `MidiBridge`（Java / `android.media.midi`）**：USB-MIDI + BLE-MIDI 扫描（`03B80E5A-…` 服务 UUID）。用 Java 而非 Kotlin，是因为 Capacitor 的 app 模块默认不启用 Kotlin 插件 |
| iOS App | **原生插件 `MidiBridge`（Swift / CoreMIDI）**：系统已接管 BLE-MIDI 与 USB-MIDI，直接枚举所有 MIDI 源 |

> 注：Android WebView 与 iOS WebKit 都**不提供** Web MIDI，因此 App 内统一走原生插件；浏览器 / PWA 模式下 Android Chrome 仍可用 Web MIDI，iOS 只能用屏幕键盘。

### 编译

```bash
npm run mobile:android
# 自动：下载 JDK 21 → Gradle 镜像加速 → 输出 android/app/build/outputs/apk/debug/app-debug.apk
```

```bash
npm run mobile:ios      # 需在 macOS 上执行（Xcode + CocoaPods）
```

原生插件源码位于 `mobile/`，由 `node scripts/sync-native.js` 注入 `android/` 与 `ios/` 工程
（同时补齐蓝牙权限、后台音频、Xcode 工程引用），因此 `npx cap sync` 之后重新执行同步即可。

### 移动端使用

1. 安装 APK / IPA 后打开应用，点「启动音频引擎」；
2. 点「扫描设备」：Android 会申请蓝牙权限并扫描 BLE-MIDI；iOS 需在系统「设置 → 蓝牙」里先连好手柄；
3. 每个手柄卡片独立选择乐器与混音参数，可同时演奏。

### 屏幕键盘的滑奏（轮指）

- 事件绑在琴键容器上并做指针捕获，`pointermove` 用 `document.elementFromPoint` 定位当前琴键；
- 用 `getCoalescedEvents()` 取回被浏览器合并的中间点，并在两点之间每约 6px 补一次采样，快速拖动不会跳音；
- 琴键之间的 2px 缝隙不再断音（落在缝隙上保持当前音，移出琴键区域才松手）；
- 滑奏换键时前一个音延迟 70ms 再停，保证每个音都能听到；手指滑回同一音不会被掐掉。

- 每个 MIDI 输入按「路由」转发到合成器的**独立通道**，通道参数（乐器、音量、声像、效果、移调）互不影响；
- 默认屏蔽来自手柄的音色库选择（CC0/CC32）、声像（CC10）与效果发送（CC91/93），保证界面上的配置不被手柄覆盖；
- 超过 16 路时通过 `addNewChannel()` 动态扩展通道，最多 32 路；
- 力度增益与力度曲线可按手柄分别调整，适配不同手感的手柄。

## 常见问题

- **看不到蓝牙 MIDI 设备**：请确认已在系统设置中配对；Windows 上部分 BLE-MIDI 设备需要「蓝牙和其他设备 → 添加蓝牙设备」后才能被 Chromium 枚举。
- **没有声音**：确认已点击「启动音频引擎」、主音量不为 0、路由未被静音；可点击卡片上的「试奏」验证。
- **音源加载失败**：检查文件是否为有效的 SF2/SF3/DLS；日志面板会显示解析错误。

## 许可

- 本项目：MIT
- spessasynth_lib / spessasynth_core：Apache-2.0
- 内置音源请遵循其各自的授权条款
