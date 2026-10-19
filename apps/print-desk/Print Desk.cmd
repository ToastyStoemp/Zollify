@echo off
rem Zollify Print Desk: double-click to build and start the app.
rem Runs from the repo root, because the dependencies live there (npm workspaces).
pushd "%~dp0..\.."

where npm >/dev/null 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and run this again.
  goto :failed
)

rem First run, or Electron missing: install the dependencies once.
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies, this takes a minute the first time...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :failed
)

call npm run start -w @zollify/print-desk
if errorlevel 1 goto :failed
popd
exit /b 0

:failed
echo.
echo Print Desk could not start. The message above says why.
popd
pause
exit /b 1
