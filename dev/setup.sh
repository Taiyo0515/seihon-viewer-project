#!/bin/sh
# 試験の準備(最初に1回。何度やり直してもよい): dev/pdfs に、試験が使う PDF・電子書籍をそろえる
#   1. お預かりしたスキャン(examples/scans)を、試験が使う名前で写す
#   2. 作り直せない小さな見本(dev/fixtures)を写す
#   3. 傾き・横置きの見本を作る(gen/make_skew_samples.py。Python 3・Pillow・img2pdf・poppler-utils の pdfimages が必要)
#      大きなコミックの見本(gen/make_big_cbz.py。約 48MB)も作る
#   4. libarchive.js の Node 版(dev/vendor/libarchivejs)が読む libarchive.wasm を、拡張機能の同梱物から写す
set -e
DEV=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DEV/.." && pwd)
EX=$ROOT/examples
PDFS=$DEV/pdfs
mkdir -p "$PDFS" "$DEV/logs"

cp "$EX/scans/sample1_book-spreads.pdf" "$PDFS/scan1.pdf"
cp "$EX/scans/sample2_notebook-spreads.pdf" "$PDFS/scan2.pdf"
cp "$EX/scans/sample3_booklet-sheets.pdf" "$PDFS/scan3.pdf"
cp "$EX/scans/kokugo2018_spreads.pdf" "$PDFS/kokugo2018.pdf"
cp "$EX/scans/IMG_20261018010841.pdf" "$PDFS/side-a.pdf"
cp "$EX/scans/IMG_20261018011032.pdf" "$PDFS/side-b.pdf"

cp "$DEV/fixtures/pdfs/"*.pdf "$DEV/fixtures/books/"* "$PDFS/"

# 作る PDF の中の画像は毎回同じ(PDF の作成日時だけが変わる)
python3 -I "$DEV/gen/make_skew_samples.py" "$PDFS" "$EX/scan-images/0.6_tilted-kokugo-p90.png" "$PDFS/kokugo2018.pdf"
python3 -I "$DEV/gen/make_big_cbz.py" "$PDFS/big-200.cbz"

cp "$ROOT/src/lib/libarchive/libarchive.wasm" "$DEV/vendor/libarchivejs/libarchive.wasm"

echo "準備ができました: $PDFS"
ls "$PDFS"
