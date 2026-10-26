@echo off
setlocal enabledelayedexpansion
title Local AI

set "APP_DIR=%~dp0"
set "PORT=8090"
set "PHP=C:\xampp\php\php.exe"
if not exist "%PHP%" set "PHP=php"
set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"

echo ============================================
echo    Local AI  -  private, on-device assistant
echo ============================================
echo.

rem --- 1. Make sure the Ollama engine responds -----------------
echo [1/2] Checking the local AI engine...
curl -s --max-time 3 http://127.0.0.1:11434/api/version >nul 2>&1
if not errorlevel 1 (
  echo       Engine already running.
  goto :engine_ready
)

echo       Engine not responding - starting it...

rem Clear any stuck Ollama processes (the tray app can get wedged).
taskkill /IM "ollama app.exe" /F >nul 2>&1
taskkill /IM "ollama.exe" /F >nul 2>&1
timeout /t 1 /nobreak >nul

if not exist "%OLLAMA_EXE%" (
  echo       [WARN] Ollama not found. Install it from https://ollama.com
  goto :engine_ready
)

start "Ollama" /min "%OLLAMA_EXE%" serve
echo       Waiting for the engine...
for /L %%i in (1,1,30) do (
  curl -s --max-time 2 http://127.0.0.1:11434/api/version >nul 2>&1
  if not errorlevel 1 goto :engine_ready
  timeout /t 1 /nobreak >nul
)
echo       [WARN] Engine did not respond in time. It may still be starting.

:engine_ready
echo.

rem --- 2. Serve the web app, bound to this machine only --------
echo [2/2] Starting the web app on http://127.0.0.1:%PORT%/
start "" "http://127.0.0.1:%PORT%/"
echo.
echo       Keep this window open while you use Local AI.
echo       Close it to stop the app.
echo.

cd /d "%APP_DIR%"
"%PHP%" -d upload_max_filesize=64M -d post_max_size=72M -d max_execution_time=0 -d memory_limit=512M -S 127.0.0.1:%PORT% -t .
