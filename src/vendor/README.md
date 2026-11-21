# 端末内で利用する処理ライブラリ

- qpdfのWebAssembly版はnpmの `@jspawn/qpdf-wasm@0.0.2` から qpdf.js と qpdf.wasm を収録。PDFの構造修復と暗号化に使います。[配布元](https://github.com/jsscheller/qpdf-wasm)
- Tesseract.js 6.0.1 と tesseract.js-core 6.0.0 のLSTM版を使用します。言語モデルは `@tesseract.js-data/jpn@1.0.0`、`@tesseract.js-data/eng@1.0.0` の 4.0.0_best_int を同梱しています。[Tesseract.js](https://github.com/naptha/tesseract.js)・[言語モデル](https://github.com/naptha/tessdata)
- 各ディレクトリに配布物のライセンスを収録しています。処理時のスクリプト・WebAssembly・文字認識データは拡張内から読み込みます。


ストア配布に向け、Tesseract.jsの既定のワーカー・コア・辞書の参照先も同梱ファイルに変更しています。
