@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0.."
set "JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8 -Duser.language=en -Duser.country=US"

echo.
echo 【F6 编译 Android】打包 + 装平板 + 跟日志（Ctrl+C 停）
echo.

call npm run mobile:android
if errorlevel 1 (
    echo.
    echo 编译失败，请看上面的报错。
    exit /b 1
)

echo.
echo 编译成功，开始安装...
call "%~dp0adb_install.bat"
exit /b %ERRORLEVEL%
