@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo npm install failed.
    exit /b 1
  )
)

echo === Chatter test suite ===
node test\e2e.js
if errorlevel 1 (
  echo.
  echo RESULT: FAILED
  exit /b 1
)

echo.
echo === Poll transport suite ===
node test\poll-transport.js
if errorlevel 1 (
  echo.
  echo RESULT: FAILED
  exit /b 1
)

echo.
echo === Static assets suite ===
node test\smoke.js
if errorlevel 1 (
  echo.
  echo RESULT: FAILED
  exit /b 1
)

echo.
echo === Vercel mode suite ===
node test\vercel-mode.js
if errorlevel 1 (
  echo.
  echo RESULT: FAILED
  exit /b 1
)

echo.
echo RESULT: ALL PASSED
