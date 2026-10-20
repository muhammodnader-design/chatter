@echo off
setlocal
cd /d "%~dp0"

where vercel >nul 2>nul
if errorlevel 1 (
  echo Vercel CLI not found. Install it first: npm i -g vercel
  exit /b 1
)

vercel --prod %*
