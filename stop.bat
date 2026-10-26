@echo off
title Local AI - stop
echo Stopping the Local AI web server (port 8090)...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8090" ^| findstr "LISTENING"') do (
  taskkill /PID %%p /F >nul 2>&1
)
echo Done. (The Ollama engine keeps running in the background.)
echo To stop the engine too, right-click the Ollama tray icon and choose Quit.
pause
