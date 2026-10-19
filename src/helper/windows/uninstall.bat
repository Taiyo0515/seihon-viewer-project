@echo off
rem 製本ビューア: 補助プログラムを使わないようにします。
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.seihon_viewer.clipboard" /f >nul 2>&1
echo 製本ビューアの補助プログラムを使わないようにしました。
pause
