#!/bin/sh
# 全部の試験を1つずつ順に流す(前の試験が終わってから次へ)。終わると logs/runall.done を作り、各試験の結果の行を出す
DEV=$(cd "$(dirname "$0")" && pwd)
TESTS="regress phase6 phase7 phase8 phase9 phase10 phase11 phase12 phase13"
mkdir -p "$DEV/logs"
rm -f "$DEV/logs/runall.done"
for t in $TESTS; do
  sh "$DEV/run-tests.sh" $t > /dev/null
  sleep 3
  while pgrep -f "node $DEV/tests/" > /dev/null; do sleep 5; done
done
for t in $TESTS; do
  grep -h " passed$" "$DEV/logs/$t.log" || echo "$t: 結果の行がありません(logs/$t.log を見てください)"
done | tee "$DEV/logs/runall.done"
