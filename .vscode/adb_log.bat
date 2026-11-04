@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0.."
rem 若提示找不到 adb，把下面一行取消注释（路径按本机 SDK 改）
rem set PATH=%LOCALAPPDATA%\Android\Sdk\platform-tools;%PATH%

echo.
echo 【看日志】本应用 SF2，Ctrl+C 停止
echo.

echo 清空旧日志...
adb logcat -c

echo 打开应用...
adb shell am start -n com.sf2.ensemble/.MainActivity >nul 2>&1

echo 开始输出...
echo.
for /f %%p in ('adb shell pidof -s com.sf2.ensemble 2^>nul') do adb logcat -v time --pid=%%p
