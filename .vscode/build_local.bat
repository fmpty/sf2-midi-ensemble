@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0.."

echo.
echo [SF2 MIDI Ensemble] Win dist - esbuild + electron-builder
echo.

call npm run dist
if errorlevel 1 (
    echo.
    echo BUILD FAILED - see errors above
    exit /b 1
)

echo.
echo DONE
echo   portable: dist\win-unpacked\SF2 MIDI Ensemble.exe
if exist "dist\SF2 MIDI Ensemble Setup 1.0.0.exe" (
    echo   setup:    dist\SF2 MIDI Ensemble Setup 1.0.0.exe
) else (
    echo   setup:    ^(none - check electron-builder log above^)
)
echo.
dir /b dist\*.exe 2>nul
exit /b 0
