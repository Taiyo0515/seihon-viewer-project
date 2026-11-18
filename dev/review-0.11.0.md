# 0.11.0 最適化・コード確認記録

確認日: 2026-10-30。対象は今回の UI・スキャン変更と並行して確認した自作コード。以下の製品ソースは全文を読み、データの寿命、重複処理、保存・出力結果への影響を確認した。既存の未コミット変更を引き継いだ状態での確認であり、すべての OS・入力 PDF の完全な動作保証を意味しない。

## 実装した最適化

| 箇所 | 変更 | 同等性の根拠 |
| --- | --- | --- |
| `src/viewer/page-export.js` / `buildPageInfos` | 出力ページを重複ごとの層に分ける際、過去の全ページを毎回検索する処理を登場回数の Map に置換 | 同じ PDF・同じページの第 n 回目を第 n 層に置く規則、PDF ごとの順序、層内のソート、出力位置を維持。ページ番号は既存の契約どおり有効な整数 |
| 同上 / `editedDocumentBytes` | 注釈の `serializable` を 2 回取得していたところを 1 回に統合 | 同じ取得結果から map と transfer を受け取り、ページ番号の変換や保存パラメーターを維持 |
| `src/common/db.js` / `putScanCache` | 同じトランザクションで行っていたキャッシュ全件取得を 2 回から 1 回に削減 | 最初に得た一覧から同じ元 PDF の古いレコードを除外。削除対象・保存バイト列・既存の容量判定を維持 |
| `src/common/handoff.js` / `cleanup` | 保持対象への所属判定を配列検索から Set に置換 | オブジェクト同一性、時刻順、期限、容量判定、削除対象を維持 |
| `src/viewer/bookbinding-export.js` / `rasterizePdf` | 画像化後の補助文書を `loadingTask.destroy()` で解放 | 同梱 PDF.js では文書の `destroy` が存在せず旧処理が実行されなかった。出力を変えずに文書の資源を解放 |

これらとは別に `page-export.js` の補助 Worker 管理、`db.js` の収集編集・検査結果保存が変更されているが、この最適化 5 点の成果としては数えていない。

## 検証

追加した `dev/tests/optimization.cjs` を Node 24 と一時プロファイルの Chromium で実行し、全項目成功、ページ内の未処理エラー 0 件。

- 抽出指定を従来の実装と比較。複数の元 PDF と重複を混ぜた固定シードの 120 ケースで一致。
- 12,000 ページの抽出指定でも従来出力と一致。ローカルの単回測定で約 48.6 ms → 1.5 ms。これは指定を組み立てる部分だけの測定で、PDF 全体の処理時間ではない。
- 注釈の取得が 1 回であること、並べ替え後のページ番号、転送対象を確認。
- 実際の IndexedDB でキャッシュの全件取得が 1 回になり、同じ元 PDF の旧版と容量超過時の古いレコードだけが消え、保存内容が変わらないことを確認。
- 受け渡しデータの期限切れと容量制限を確認。従来と同じ対象が残る。
- 実 PDF の画像化で文書解放が 1 回行われ、ページ寸法と画像の出力が維持されることを確認。
- 実 PDF の重複抽出で `THIRD, FIRST, THIRD, SECOND, FIRST` のページ順になることを確認。

この試験は利用者のブラウザプロファイル、実クリップボード、補助プログラムの OS 登録を変更しない。全自作 JavaScript の構文確認と UI・補正・既存回帰試験は別担当の検証に含まれる。

## 全文確認した製品コード

各行のファイル名は、その行のディレクトリーに対する相対名。

| ディレクトリー | ファイル |
| --- | --- |
| `src/common/` | `backup.js`, `db.js`, `ebook-formats.js`, `files.js`, `handoff.js`, `page.css`, `role-items.js`, `settings.js`, `shortcut.js`, `viewer-url.js` |
| `src/background/` | `dnr-rules.js`, `service-worker.js` |
| `src/content/` | `link-guard.js` |
| `src/offscreen/` | `sniff.html`, `sniff.js` |
| `src/options/` | `options.html`, `options.js` |
| `src/reader/` | `print-book.js`, `reader.css`, `reader.html`, `reader.js` |
| `src/welcome/` | `welcome.html`, `welcome.js` |
| `src/viewer/` | `bookbinding-export.js`, `bookbinding.js`, `boot.js`, `collection-edit.js`, `collection.js`, `doc-source.js`, `file-clipboard.js`, `image-export.js`, `page-copy.js`, `page-edit.js`, `page-export.js`, `page-map.js`, `perf.js`, `print-native.js`, `render-budget.js`, `roles.js`, `theme.js` |
| `src/viewer/ebook/` | `comic-build.js`, `comic-names.js`, `convert-worker.js`, `ebook-open.js`, `ebook-router.js`, `pdf-convert.js` |
| `src/helper/windows/` | `com.seihon_viewer.clipboard.json`, `install.bat`, `seihon-clipboard.bat`, `seihon-clipboard.ps1`, `uninstall.bat` |
| `src/helper/mac/` | `install.command`, `seihon-clipboard`, `seihon-clipboard.js`, `uninstall.command` |
| `src/helper/linux/` | `install.sh`, `seihon-clipboard.py`, `uninstall.sh` |
| `src/tools/test-server/` | `server.py` (内包する HTML・JavaScript も含む) |
| その他 | `src/manifest.json`, `src/icons/icon.svg` |

`src/viewer/main.js`, `book-layout.js`, `icons.js`, `viewer.html`, `seihon.css`, `src/viewer/ui/` と `src/viewer/scan/` は UI・補正担当が確認する範囲。今回の記録には、それらをこの最適化担当が全文確認したとは記載しない。

## 開発補助コードの確認範囲

全文確認: `dev/run-all.sh`, `run-wait.sh`, `run-node.sh`, `run-tests.sh`, `start-servers.sh`, `setup.sh`, `make_dist.py`; `dev/fakebin/xclip`; `dev/lint/tsconfig.json`, `shim.d.ts`, `check/imports.mjs`, `check/ids.mjs`; `dev/gen/make_big_cbz.py`, `make_skew_samples.py`, `make_scan_samples.py`, `make_ebook_samples.py`; `dev/fixtures/dummy-dl-extension/sw.js`, `manifest.json`。

`dev/tests/optimization.cjs` は今回作成・実行。既存の `dev/tests/phase*.mjs`・`regress.mjs`・`lib.mjs` と過去の `dev/opt-0.6.3/` は今回の全文レビュー対象に含めていない。UI・補正・収集の新規試験はそれぞれの担当が検証する。

## 変更を見送った箇所と限界

- キャッシュ容量の算定は従来の仕様をそのまま保った。保存中の 1 文書を容量計算に含める変更は削除対象を変えるため、今回の最適化には混ぜていない。
- 書籍の基準寸法を決める許容差のグループ化や電子書籍の目次の探索は、単純な置換で同順位や解決順が変わる可能性があるため維持。
- 収集の通知や設定変更の反映をまとめる変更は、画面の反映タイミングや他のタブとの同期に影響するため維持。
- OS 別クリップボード補助プログラムは静的確認のみ。macOS・Linux の実環境、利用者のクリップボードを使う試験、ネイティブ印刷画面の操作は行っていない。
- `src/pdfjs/`, `src/lib/`, `dev/vendor/` の第三者ライブラリ内部は全面レビュー・改変の対象外。同梱版との呼び出し・文書解放・出力結果を確認した。
- UI の旧説明（モードの巡回、本＋下矢印）は担当へ共有し、今回の UI に合う説明更新を依頼した。

新しい外部通信、権限、ライブラリ依存は追加していない。元 PDF の書き換えは行わない。
