#!/bin/sh
# 製本ビューア: ファイルをクリップボードに入れる補助プログラムを Chrome で使えるようにする(Linux。このユーザーだけ)。
#   sh helper/linux/install.sh
# xclip(X11)または wl-clipboard(Wayland)が必要です(例: sudo apt install xclip)。
DIR="$(cd "$(dirname "$0")" && pwd)"
HOST=com.seihon_viewer.clipboard
chmod +x "$DIR/seihon-clipboard.py"
ESCAPED=$(printf '%s' "$DIR/seihon-clipboard.py" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
DONE=""
for browser in google-chrome google-chrome-beta google-chrome-unstable chromium; do
  if [ "$browser" = "google-chrome" ] || [ -d "$CONF/$browser" ]; then
    TARGET="$CONF/$browser/NativeMessagingHosts"
    mkdir -p "$TARGET" || continue
    cat > "$TARGET/$HOST.json" <<JSON
{
  "name": "$HOST",
  "description": "Seihon Viewer clipboard helper (puts saved files on the clipboard)",
  "path": "$ESCAPED",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/"]
}
JSON
    DONE="$DONE
  $TARGET/$HOST.json"
  fi
done
echo "製本ビューアの補助プログラムを使えるようにしました:$DONE"
if ! command -v xclip >/dev/null 2>&1 && ! command -v wl-copy >/dev/null 2>&1; then
  echo "注意: xclip も wl-copy も見つかりません。どちらかを入れてください(例: sudo apt install xclip)。"
fi
echo "製本ビューアの「詳細設定」の「補助プログラム」で「もう一度確かめる」を押してください。"
