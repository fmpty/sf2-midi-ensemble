@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0.."
set "JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8 -Duser.language=en -Duser.country=US"
echo [SF2 MIDI Ensemble] Android - mobile:android
call npm run mobile:android
if errorlevel 1 (
    echo BUILD FAILED - mobile:android
    exit /b 1
)
echo DONE - android\app\build\outputs\apk\debug\app-debug.apk
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
exit /b 0
