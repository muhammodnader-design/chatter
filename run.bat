@echo off
setlocal
cd /d "%~dp0"

echo ================================
echo   Chatter - start full stack
echo ================================

rem --- setup ---
if not exist node_modules (
  echo [setup] Installing dependencies...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo [setup] npm install failed.
    pause
    exit /b 1
  )
)

rem --- front ---
if not exist public\index.html (
  echo [front] Frontend files missing in public\.
  pause
  exit /b 1
)
echo [front] Ready - public\ (index.html, app.js, style.css)

rem --- db ---
echo [db] Opening database...
node -e "require('./db')"
if errorlevel 1 (
  echo [db] Failed to open database.
  pause
  exit /b 1
)
if exist chat.db (echo [db] Ready - chat.db) else (echo [db] Ready)

rem --- port check ---
netstat -ano | findstr /c:":3000 " | findstr /c:"LISTENING" >nul
if not errorlevel 1 (
  echo [back] Port 3000 already in use - Chatter may already be running.
  start "" http://localhost:3000
  pause
  exit /b 1
)

rem --- back ---
echo [back] Starting server on port 3000...
start "Chatter server (close window to stop)" /b node server.js

echo [front] Waiting for frontend to respond...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; $d=(Get-Date).AddSeconds(15); while((Get-Date) -lt $d){ try { $r=Invoke-WebRequest 'http://localhost:3000' -UseBasicParsing -TimeoutSec 1; if($r.StatusCode -eq 200){ $ok=$true; break } } catch { Start-Sleep -Milliseconds 300 } }; if(-not $ok){ exit 1 }"
if errorlevel 1 (
  echo [back] Server did not respond on port 3000. Check errors above.
  pause
  exit /b 1
)

if /i not "%~1"=="--no-browser" (
  echo [front] Opening http://localhost:3000 ...
  start "" http://localhost:3000
)

echo.
echo Stack running:
echo   [back]  node server.js  (port 3000)
echo   [front] http://localhost:3000
echo   [db]    chat.db
echo.
echo Close this window to stop everything.
pause
