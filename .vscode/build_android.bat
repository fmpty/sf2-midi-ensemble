@echo off
setlocal
cd /d "%~dp0.."
echo [SF2 MIDI Ensemble] Android - mobile:android
call npm run mobile:android
if errorlevel 1 (
    echo BUILD FAILED - mobile:android
    exit /b 1
)
echo DONE - android\app\build\outputs\apk\debug\app-debug.apk
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
exit /b 0
