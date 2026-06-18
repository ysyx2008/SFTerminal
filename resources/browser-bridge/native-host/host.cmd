@echo off
setlocal
set "HOST_DIR=%~dp0"
set "GATEWAY_FILE="
if defined SAILFISH_BROWSER_BRIDGE_GATEWAY set "GATEWAY_FILE=%SAILFISH_BROWSER_BRIDGE_GATEWAY%"

if defined SAILFISH_ELECTRON_EXE (
  set "ELECTRON_RUN_AS_NODE=1"
  "%SAILFISH_ELECTRON_EXE%" "%HOST_DIR%host.mjs" %*
) else if exist "%HOST_DIR%electron.exe" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%HOST_DIR%electron.exe" "%HOST_DIR%host.mjs" %*
) else (
  node "%HOST_DIR%host.mjs" %*
)
