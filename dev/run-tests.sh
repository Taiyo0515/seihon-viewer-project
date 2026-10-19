#!/bin/sh
# 試験を流す: run-tests.sh <試験のファイル> [項目…]  (結果は logs/<名前>.log)
# 試験はクリップボードと画面を使うので、同時に2つ流さないこと。
DEV=$(cd "$(dirname "$0")" && pwd)
export LANG=C.UTF-8 LC_ALL=C.UTF-8 DISPLAY=:99
mkdir -p "$DEV/logs"
if ! pgrep -x Xvfb > /dev/null; then
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  setsid nohup Xvfb :99 -screen 0 1920x1200x24 -nolisten tcp > "$DEV/logs/xvfb.log" 2>&1 < /dev/null &
  sleep 1.5
fi
sh "$DEV/start-servers.sh" > /dev/null
name=$(basename "$1" .mjs)
shift
log=$DEV/logs/$name${1:+-part}.log
setsid nohup node "$DEV/tests/$name.mjs" "$@" > "$log" 2>&1 < /dev/null &
echo "log: $log"
