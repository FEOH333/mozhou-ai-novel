@echo off
title AI Novel Writer Server
cd /d "%~dp0"

rem ============================================
rem  AI Novel Writer - single-window launcher
rem  (ASCII only, safe for any Windows codepage)
rem
rem  V0.95.4: THIS WINDOW IS THE SERVER.
rem  - Double-click: if server already up, just
rem    open the browser and exit.
rem  - Otherwise node runs in the FOREGROUND of
rem    this window. Close this window = stop the
rem    backend (no more hidden minimized window).
rem  - /helper: waits for health then opens the
rem    browser once (spawned minimized, exits).
rem  - 30s stale lock guards against double-click.
rem ============================================

set "URL=http://127.0.0.1:8770/api/health"
set "LOCK=%TEMP%\anw_start.lock"
rem Node 24: let fetch honor HTTP_PROXY/HTTPS_PROXY when the machine uses a local proxy.
set "NODE_USE_ENV_PROXY=1"

if "%~1"=="/helper" goto helper

rem ---- already running? open browser only ----
call :probe
if "%PROBE%"=="200" (
  echo Server is already running on http://localhost:8770
  start "" "http://localhost:8770"
  exit /b 0
)

rem ---- single-instance lock (stale >30s is ignored) ----
powershell -NoProfile -Command "$l='%TEMP%\anw_start.lock'; if((Test-Path $l) -and (((Get-Date)-(Get-Item $l).LastWriteTime).TotalSeconds -lt 30)){ exit 0 } else { New-Item -ItemType File -Path $l -Force | Out-Null; exit 1 }"
if not errorlevel 1 (
  echo Another launcher is starting the server.
  echo The browser will open once it is ready.
  exit /b 0
)

rem ---- helper: waits for health, opens browser once ----
start "AI Novel Browser Helper" /min cmd /c ""%~f0" /helper"

echo ============================================================
echo   Starting server on http://localhost:8770 ...
echo   First run downloads the local embedding model (~100MB).
echo.
echo   THIS WINDOW IS THE SERVER.
echo   Keep it open while writing; CLOSE IT TO STOP the backend.
echo ============================================================
node server\index.js

echo.
echo [STOPPED] Server exited. Window stays open so errors stay readable.
del "%LOCK%" >NUL 2>NUL
pause
exit /b 0

:helper
set /a TRIES=0
:hloop
timeout /t 1 /nobreak >NUL
call :probe
if "%PROBE%"=="200" goto hopen
set /a TRIES+=1
if %TRIES% LSS 45 goto hloop
exit /b 0
:hopen
start "" "http://localhost:8770"
exit /b 0

:probe
curl.exe -s -o NUL -w "%%{http_code}" %URL% > "%TEMP%\anw_probe.txt" 2>NUL
set /p PROBE=<"%TEMP%\anw_probe.txt"
del "%TEMP%\anw_probe.txt" >NUL 2>NUL
exit /b 0
