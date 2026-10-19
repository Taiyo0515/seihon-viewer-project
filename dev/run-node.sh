#!/bin/sh
# Playwright を使う node のスクリプトを、試験と同じ環境(Xvfb・試験用サーバー)で動かす: run-node.sh <スクリプト> [引数…]
DEV=$(cd "$(dirname "$0")" && pwd)
export LANG=C.UTF-8 LC_ALL=C.UTF-8 DISPLAY=:99
mkdir -p "$DEV/logs"
if ! pgrep -x Xvfb > /dev/null; then
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  setsid nohup Xvfb :99 -screen 0 1920x1200x24 -nolisten tcp > "$DEV/logs/xvfb.log" 2>&1 < /dev/null &
  sleep 1.5
fi
sh "$DEV/start-servers.sh" > /dev/null
exec node "$@"
