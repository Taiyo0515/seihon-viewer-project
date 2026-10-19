#!/bin/sh
# 試験用サーバー(拡張機能に同梱の tools/test-server/server.py)を起動する(起動済みなら何もしない)
# /files/ で dev/pdfs の中身を配る(dev/setup.sh でそろえておく)
DEV=$(cd "$(dirname "$0")" && pwd)
SRV=$(cd "$DEV/.." && pwd)/src/tools/test-server/server.py
mkdir -p "$DEV/logs"
if ! curl -s -o /dev/null http://127.0.0.1:8765/ ; then
  setsid nohup python3 -I "$SRV" --port 8765 --dir "$DEV/pdfs" > "$DEV/logs/server-8765.log" 2>&1 < /dev/null &
fi
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -o /dev/null http://127.0.0.1:8765/ ; then break; fi
  sleep 0.5
done
curl -s -o /dev/null -w "8765:%{http_code}\n" http://127.0.0.1:8765/
