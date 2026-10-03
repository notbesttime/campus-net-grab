@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [Error] Node.js not found.
  echo  Install: https://nodejs.org/zh-cn/download
  echo  Then run this bat again.
  echo.
  pause
  exit /b 1
)

rem This window closes immediately. All waiting happens in a hidden PowerShell,
rem so the console is visible only for the moment it takes to hand off.
rem The child gets its own hidden console (start without /b), which is why it
rem survives after this script exits.
rem KEEP EVERY COMMENT IN THIS FILE ASCII: cmd.exe reads UTF-8 bytes as GBK on a
rem Chinese Windows, so Chinese text here gets garbled and can run as a command.
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$ok=$false; $u=''; $f=Get-Content 'console.url' -TotalCount 1 -ErrorAction SilentlyContinue; if ($f) { $u=$f.Trim().TrimStart([char]0xFEFF) }; if ($u) { try { $r=Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 1; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) { Start-Process $u; $ok=$true } } catch {} }; if (-not $ok) { Remove-Item 'console.url' -Force -ErrorAction SilentlyContinue; $env:NO_OPEN='1'; Start-Process -FilePath 'node' -ArgumentList 'server.js' -WindowStyle Hidden; for($i=0;$i -lt 60;$i++){ if(Test-Path 'console.url'){ $f=Get-Content 'console.url' -TotalCount 1 -ErrorAction SilentlyContinue; if($f){ $u=$f.Trim().TrimStart([char]0xFEFF); try { $r=Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 1; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 400){ Start-Process $u; $ok=$true; break } } catch {} } }; Start-Sleep -Milliseconds 150 } }; if (-not $ok) { Start-Process -FilePath 'cmd.exe' -ArgumentList '/k','echo  [Error] The local service did not start. Run the visible debug bat in this folder.' }" >nul 2>nul
exit /b 0