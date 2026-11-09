# 第三方组件与资源声明

本仓库在构建/运行时依赖下列组件。其许可**独立**于根目录 `LICENSE`（本项目自有代码为非商业许可）。
使用、修改或再分发时须同时遵守下列条款。

## 运行时依赖（节选）

| 组件 | 许可 | 说明 |
|------|------|------|
| [spessasynth_lib](https://github.com/spessasus/spessasynth_lib) | Apache-2.0 | Web/Electron 合成引擎（AudioWorklet） |
| [spessasynth_core](https://github.com/spessasus/spessasynth_core) | Apache-2.0 | SF2 解析核心 |
| [Electron](https://www.electronjs.org/) | MIT | 桌面壳 |
| [@capacitor/core](https://capacitorjs.com/) 等 | MIT | 移动端壳 |
| [@julusian/midi](https://www.npmjs.com/package/@julusian/midi) | MIT | Windows 桌面 MIDI |
| [esbuild](https://esbuild.github.io/) | MIT | 构建 |
| Android: TinySoundFont、AAudio | 见各源码文件头 / 系统 API | 原生合成路径 |

完整依赖树见 `package-lock.json`。

## 内置音源（构建时从 npm 复制，不入 Git）

| 资源 | 许可 / 说明 |
|------|-------------|
| [generaluser](https://www.npmjs.com/package/generaluser)（GeneralUser GS） | 免费分发；须遵守作者 S. Christian Collins 的使用与署名要求，**不得声称为原创** |
| [freepats](https://www.npmjs.com/package/freepats)（备选） | 依包内说明 |

在线版（GitHub Pages）部署时会将音源打包进静态站点，访客下载使用仍须遵守音源作者条款。

## 商标

「SF2 MIDI Ensemble」及项目图标为项目标识；第三方产品名称归其各自所有者。
