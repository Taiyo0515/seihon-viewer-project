@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Uninstall
if errorlevel 1 exit /b 1
echo TeX Live helper removed.
pause
