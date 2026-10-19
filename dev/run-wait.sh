#!/bin/sh
# 試験を流して、終わる(ログに「passed」の行が出る)まで待つ: run-wait.sh <試験の名前> [項目…]
DEV=$(cd "$(dirname "$0")" && pwd)
name=$(basename "$1" .mjs)
shift
log=$DEV/logs/$name${1:+-part}.log
rm -f "$log"
sh "$DEV/run-tests.sh" "$name" "$@" > /dev/null
i=0
while [ $i -lt 1100 ]; do
  if [ -f "$log" ] && grep -q "passed$" "$log"; then break; fi
  if ! pgrep -f "node $DEV/tests/$name.mjs" > /dev/null && [ $i -gt 5 ]; then break; fi
  sleep 1
  i=$((i+1))
done
sleep 1
cat "$log"
