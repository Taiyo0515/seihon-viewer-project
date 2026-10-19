# 製本ビューア 開発用の一式(dev/)

拡張機能の配布物(`src/` → `seihon-viewer-<版>.zip`)には入れない、開発環境の自動試験と道具です。
普段の利用には要りません。全体の説明は、リポジトリの直下の `HANDOVER.md` と `README.md` を見てください。

## 中身

| ファイル・フォルダ | 役割 |
|---|---|
| `setup.sh` | 試験の準備(最初に1回。何度やり直してもよい)。`dev/pdfs/` に試験の PDF・電子書籍をそろえる |
| `run-tests.sh <試験> [項目…]` | 試験を1つ、裏で流す(結果は `logs/<名前>.log`。項目を指定したときは `logs/<名前>-part.log`) |
| `run-wait.sh <試験> [項目…]` | 試験を流して、終わるまで待って結果を出す |
| `run-all.sh` | 全部の試験を1つずつ順に流す(終わると `logs/runall.done` に各試験の結果の行) |
| `run-node.sh <スクリプト> [引数…]` | Playwright を使うスクリプトを、試験と同じ環境(Xvfb・試験用サーバー)で動かす |
| `start-servers.sh` | 試験用サーバー(`src/tools/test-server/server.py`)を 127.0.0.1:8765 で起動する。`/files/` で `dev/pdfs/` を配る |
| `make_dist.py` | 配布用の zip を `src/` から作る(`python3 dev/make_dist.py` → `dist/seihon-viewer-<版>.zip`。中は `seihon-viewer/` フォルダ。同じ名前があれば上書きしない) |
| `tests/lib.mjs` | 試験の共通部品(拡張機能を読み込んだ Chromium の起動、保存先を選ぶ画面の偽物、結果の記録など) |
| `tests/regress.mjs` | 0.0.4・0.1 の回帰試験(16 項目) |
| `tests/phase6.mjs`〜`phase12.mjs` | 0.2〜0.6.1 の試験(33・24・27・8・12・10・8 項目) |
| `tests/phase13.mjs` | 0.6.3 の試験(段階1 で見つけた不具合の再現と確認。7 項目) |
| `gen/make_scan_samples.py` | 0.3 のスキャンの見本(`src/tools/test-server/samples/` の `scan-spread.pdf`・`scan-booklet.pdf`・`scan-rotated.pdf`)を作る |
| `gen/make_ebook_samples.py` | 0.4 の電子書籍・コミックの見本(`src/tools/test-server/samples/books/`)を作る |
| `gen/make_skew_samples.py` | 0.6 の傾き・横置きの見本(`skew-portrait.pdf`・`skew-kokugo.pdf`・`turned-cw.pdf`・`turned-ccw.pdf`)を、お預かりした国語のスキャンから作る |
| `gen/make_big_cbz.py` | 大きなコミック(`big-200.cbz`。200 ページ・約 48MB)を作る |
| `fixtures/pdfs/` | 作り直せない小さな見本(作り方の記録が無い): `ocr-sample.pdf`(Tesseract 5.3.4 で作った、OCR の文字つきの3ページの画像の PDF。中身はテスト用サーバーの8ページの本)、`xmp-title.pdf`(文書情報と XMP の両方に題名「古い題名」がある 12ページの PDF) |
| `fixtures/books/` | MOBI・AZW3・DRM 付き AZW の見本(Python の mobi パッケージ(iscc/mobi)の試験用ファイル `demo.mobi` から作ったもの。中の本は Project Gutenberg の "Children's Literature"(米国でパブリックドメイン)) |
| `fixtures/dummy-dl-extension/` | 0.4.2 の試験で一緒に読み込むダミーの拡張機能(`downloads.onDeterminingFilename` を使い、Chrome がファイル名を GUID にする状態を作る) |
| `fakebin/xclip` | 補助プログラム(Linux)の試験で使う偽物の xclip(受け取った内容を記録するだけ) |
| `vendor/libarchivejs/` | libarchive.js 2.0.2(コミット 0989c1a)の Node 版(MIT License。`LICENSE`)。試験で RAR の中の画像を取り出すのに使う。`libarchive.wasm` は `setup.sh` が `src/lib/libarchive/` から写す |
| `opt-0.6.3/` | 0.6.3 の段階2・3(最適化と、その前後で結果が同じかの確認)に使ったスクリプト(下の「0.6.3 の確認の道具」) |
| `lint/` | 静的な確認(下の「静的な確認」) |
| `pdfs/`・`logs/` | `setup.sh` と試験が作るもの(git では管理しない) |

## 必要なもの

- Linux(試験は Xvfb の画面 `:99` を使う)
- Node.js 22、Playwright 1.56 と、その Chromium(`npm install playwright` と `npx playwright install chromium`。
  別の場所に入っているときは、環境変数 `PLAYWRIGHT_MODULE` で `playwright/index.mjs` の場所を指定)
- Xvfb、curl、poppler-utils(`pdfinfo`・`pdftotext`・`pdfimages`・`pdftoppm`)、qpdf、ImageMagick(`identify`)
- Python 3 と Pillow・img2pdf・pikepdf
- 見本を作り直すとき(`gen/make_scan_samples.py`・`make_ebook_samples.py`)は、Noto CJK のフォント(`/usr/share/fonts/opentype/noto/`)
- お預かりしたスキャン(リポジトリの `examples/scans/` と `examples/scan-images/`)。git では管理していないので、引き継ぎの zip から取り出したものを使う

## 流し方

```sh
sh dev/setup.sh            # 1回だけ(dev/pdfs をそろえる)
sh dev/run-wait.sh phase13 # 1つの試験を流して結果を見る
sh dev/run-wait.sh phase7 K21 K22   # 項目を指定して流す
sh dev/run-all.sh          # 全部(145 項目。開発に使った環境で 10 分ほど)
```

- 読み込む拡張機能は、初期値ではリポジトリの `src/`。ほかのフォルダを試すときは環境変数 `EXT_DIR` で指定する
  (ただし `phase11`〜`phase13` が直接読み込む解析の部品は、いつも `src/` のもの)。
- ブラウザのプロファイル・ダウンロード先は、`$TMPDIR/seihon-viewer-tests/`(環境変数 `SEIHON_TEST_TMP` で変えられる)に作る。使い終わっても消さないので、ときどき消す。
- 拡張機能の ID は `manifest.json` の `key` で固定しているので(`miiaicaobmegmjkmicojhmajnancjnjp`)、置き場所によらず同じ。
- 試験はクリップボードと画面を使うので、同時に2つ流さないこと。
- phase11 の S10(エラーが出ていないこと)は、まれに PDF.js のコンソールエラーで失敗する(`HANDOVER.md` 6.1 節の「別件」)。流し直すと通る。

## 静的な確認

```sh
NODE_PATH=/opt/npm-tools/node_modules node dev/lint/check/imports.mjs   # import / export の名前・パスのずれ(acorn・acorn-walk が必要)
node dev/lint/check/ids.mjs                                             # JS が使う要素の id が HTML にあるか
npx tsc -p dev/lint/tsconfig.json                                       # TypeScript の checkJs(DOM の型の警告がたくさん出る。新しく増えたものだけを見る)
```

- `imports.mjs` は、使われていない export の一覧を `dev/logs/unused-exports.txt` に書く(試験が直接使っているものも含む)。0.6.3 では問題 0 件。
- `ids.mjs` は、0.6.3 で `viewer/ui/bookbinding-dialog.js` の `shBindCover`・`shBindBack` を4件「missing」と出すが、
  これらの id は表(`SINGLE_IDS`)から付けているための見落としで、問題ではない。
- `tsc` は、DOM の型(`Element` に `hidden` が無い など)の警告が 2500 行ほど出て、終わりの値は 2 になる。0.6.3 の時点の出力と比べて、増えたものだけを見る。

## 0.6.3 の確認の道具(opt-0.6.3/)

0.6.3 の段階2(最適化)の前後で、スキャンを調べた結果と、整えた PDF が同じことを確かめたスクリプトです(記録として残してある)。
比べる前の版は、git の履歴から作ります。

```sh
git show 77a16f0:viewer/scan/scan-analysis.js > dev/opt-0.6.3/sa-base.mjs   # 段階1 の後・段階2 の前の解析の部品
node dev/opt-0.6.3/cmp.mjs <PGM の画像…>        # findSkew の結果が同じか・時間
node dev/opt-0.6.3/edge.mjs                     # 境界の入力(白紙・真っ黒・ノイズ・とても小さい など 9 例)で同じか
node dev/opt-0.6.3/timing2.mjs <PGM の画像…>    # analyzeFull の時間の比較
MOD=<解析の部品> node dev/opt-0.6.3/snap-analysis.mjs <出力フォルダ> <PGM の画像…>   # analyzeFull の結果を JSON に保存
node dev/opt-0.6.3/cmp-analysis.mjs <前の出力> <後の出力>                         # 保存した結果を比べる
sh dev/run-node.sh dev/opt-0.6.3/snap-e2e.mjs <出力フォルダ>                     # 拡張機能で整えた PDF(MD5)とページの計画を保存
```

- PGM の画像は、スキャンのページを長辺 1100 画素ほどの灰色にしたもの(例: `pdftoppm -gray -r 50 dev/pdfs/scan1.pdf out` で作った `.pgm`)。
  0.6.3 では、お預かりしたスキャンと試験の見本から作った 88 枚で比べました(個人のファイルから作ったものなので、ここには入れていません)。
- `snap-e2e.mjs` は、整えた PDF の中身を `<出力フォルダ>` に書き出す。前後で2回動かし、`summary.json` の MD5 を比べる。

## 補足

- 0.6.3 の納品時は、この一式は `/home/claude/dev`・拡張機能は `/home/claude/seihon-viewer` という固定の場所を前提にしていました。
  引き継ぎ用の構成にするときに、リポジトリの中の相対の場所を使うように直しました(試験の中身・判定は変えていません)。
- `big-200.cbz` は、0.4 の試験で使ったもの(作り方の記録が無い)と同じ大きさ・枚数・形式のものを `gen/make_big_cbz.py` で作ります。絵は違います。
- 試験の見本(`skew-*.pdf`・`turned-*.pdf`)は作るたびに PDF の作成日時だけが変わり、中の画像は毎回同じです。
