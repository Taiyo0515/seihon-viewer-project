#!/bin/sh
# 製本ビューア: ファイルをクリップボードに入れる補助プログラムを Chrome で使えるようにする(Mac。このユーザーだけ)。
# Finder でこのファイルを右クリック →「開く」で実行する。
cd "$(dirname "$0")" || exit 1
DIR="$(pwd)"
HOST=com.seihon_viewer.clipboard
TARGET="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$TARGET" || exit 1
chmod +x "$DIR/seihon-clipboard"
# ダウンロードした ZIP から取り出したファイルに付く「インターネットから入手した」印を外す
xattr -d com.apple.quarantine "$DIR/seihon-clipboard" "$DIR/seihon-clipboard.js" 2>/dev/null
# JSON の中で使えない文字(\ と ")を逃がす
ESCAPED=$(printf '%s' "$DIR/seihon-clipboard" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
cat > "$TARGET/$HOST.json" <<JSON
{
  "name": "$HOST",
  "description": "Seihon Viewer clipboard helper (puts saved files on the clipboard)",
  "path": "$ESCAPED",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/"]
}
JSON
echo ""
echo "製本ビューアの補助プログラムを使えるようにしました。"
echo "  $TARGET/$HOST.json"
echo ""
echo "製本ビューアの「詳細設定」の「補助プログラム」で「もう一度確かめる」を押してください。"
echo "製本ビューアのフォルダを移動したときは、もう一度このファイルを開いてください。"
