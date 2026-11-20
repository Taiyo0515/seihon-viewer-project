TeX Liveとの連携（Windows版Google Chrome）

1. TeX Liveの日本語環境をインストールします。コマンドプロンプトで
   uplatex --version と dvipdfmx --version を実行できる状態にしてください。
2. このフォルダーの install.bat を実行します。管理者権限は不要です。
   現在のユーザー用に連携アプリを作成し、WindowsのChromeへ登録します。
3. 製本ビューアで .tex を選び、TeX Liveと接続します。接続確認では
   日本語と数式を含む短い原稿を組版します。

対応する原稿はUTF-8の単一ファイルです。日本語の文書クラスには
   \documentclass[uplatex]{jsarticle}
を使えます。外部の画像、別ファイルの章、BibTeX処理には未対応です。
組版ごとに専用の一時フォルダーを作ります。原稿からのシェル実行を無効にし、
原稿4 MB、完成PDF 64 MB、各組版処理30秒の上限を設けています。
TeX原稿はPC上で処理するプログラムなので、自分が信頼する原稿を組版してください。

TeX Liveを移動または更新して接続できなくなったら install.bat を再実行します。
連携アプリを取り除くには uninstall.bat を実行します。
