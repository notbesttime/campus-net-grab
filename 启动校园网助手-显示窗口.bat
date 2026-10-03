@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [Error] Node.js not found.
  echo  Install: https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)
echo  Starting local service (visible window for debug)...
echo  Close this window to stop the service.
echo  Closing the console web page also stops the service.
echo.
node server.js
if errorlevel 1 (
  echo.
  echo  [Error] Service exited with error. Screenshot this window.
  pause
)