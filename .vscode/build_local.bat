@echo off
setlocal
cd /d "%~dp0.."
echo [SF2 MIDI Ensemble] local dist - esbuild + electron-builder
echo Close any running SF2 MIDI Ensemble / npm start window before pack
taskkill /IM "SF2 MIDI Ensemble.exe" /F >nul 2>&1
call npm run dist
if errorlevel 1 (
    echo BUILD FAILED - npm run dist
    echo If EBUSY, quit Electron app and delete dist\win-unpacked then retry
    exit /b 1
)
echo.
echo DONE -
echo   Portable exe  dist\win-unpacked\SF2 MIDI Ensemble.exe
echo   Setup installer  dist\*.exe
dir /b dist\*.exe 2>nul
exit /b 0
