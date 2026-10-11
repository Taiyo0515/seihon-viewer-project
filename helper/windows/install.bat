@echo off
rem 製本ビューア: ファイルをクリップボードに入れる補助プログラムを Chrome で使えるようにします(このユーザーだけ)。
rem このファイルは日本語の Windows 用(シフト JIS)で保存しています。
setlocal
set "HOST=com.seihon_viewer.clipboard"
set "MANIFEST=%~dp0%HOST%.json"
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
if errorlevel 1 (
  echo 設定できませんでした。
  pause
  exit /b 1
)
echo.
echo 製本ビューアの補助プログラムを使えるようにしました。
echo   %MANIFEST%
echo.
echo 製本ビューアの「詳細設定」の「補助プログラム」で「もう一度確かめる」を押してください。
echo 製本ビューアのフォルダを移動したときは、もう一度このファイルを実行してください。
echo.
pause
