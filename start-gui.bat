@echo off
cd /d "%~dp0"
title Maestro Web GUI

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [FATAL ERROR] Node.js was not found. Please install Node.js first.
    pause
    exit /b 1
)

echo Starting Maestro Web GUI...
echo.
node web-gui.js
pause