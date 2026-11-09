@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0.."
rem 若提示找不到 adb，把下面一行取消注释
rem set PATH=%LOCALAPPDATA%\Android\Sdk\platform-tools;%PATH%

set "APK_DIR=android\app\build\outputs\apk\debug"
set "APK="
for /f "delims=" %%I in ('dir /b /o-d "%APK_DIR%\sf2-midi-ensemble-*.apk" 2^>nul') do (
    set "APK=%APK_DIR%\%%I"
    goto :found
)
for /f "delims=" %%I in ('dir /b /o-d "%APK_DIR%\*.apk" 2^>nul') do (
    set "APK=%APK_DIR%\%%I"
    goto :found
)

echo 还没有 APK，请先 F6 编译。
exit /b 1

:found
if not exist "%APK%" (
    echo 还没有 APK，请先 F6 编译。
    exit /b 1
)

echo.
echo 安装到平板...
echo APK: %APK%
echo （若界面文案/逻辑仍是旧版：先卸载应用，或 adb shell pm clear com.sf2.ensemble 后再装）
adb install -r "%APK%"
if errorlevel 1 (
    echo 安装失败，检查 USB 调试和平板连接。
    exit /b 1
)

echo 打开应用...
adb shell am start -n com.sf2.ensemble/.MainActivity

call .vscode\adb_log.bat
