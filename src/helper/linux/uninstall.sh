#!/bin/sh
# 製本ビューア: 補助プログラムを使わないようにする(Linux)。
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
for browser in google-chrome google-chrome-beta google-chrome-unstable chromium; do
  rm -f "$CONF/$browser/NativeMessagingHosts/com.seihon_viewer.clipboard.json"
done
echo "製本ビューアの補助プログラムを使わないようにしました。"
