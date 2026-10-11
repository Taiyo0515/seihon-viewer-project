#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
製本ビューア: ファイルをクリップボードに入れる補助プログラム(Linux。Chrome のネイティブ メッセージングで呼ばれる)

製本ビューアがダウンロードフォルダに保存した PDF・画像の場所を受け取り、
ファイルとしてクリップボードに入れる(text/uri-list)。xclip(X11)または wl-copy(Wayland)を使う。
Chrome から1回だけ依頼を受け取り、クリップボードに入れて終わる。ネットワークは使わない。

依頼(4バイトの長さ + UTF-8 の JSON): {"type":"ping"} / {"type":"copy-files","paths":["/home/…/a.pdf"]}
"""

import json
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path


def read_exact(count):
    data = b""
    while len(data) < count:
        chunk = sys.stdin.buffer.read(count - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def send(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def clipboard_command():
    """使えるクリップボードの道具(Wayland なら wl-copy、X11 なら xclip)"""
    if os.environ.get("WAYLAND_DISPLAY") and shutil.which("wl-copy"):
        return ["wl-copy", "--type", "text/uri-list"]
    if shutil.which("xclip"):
        return ["xclip", "-selection", "clipboard", "-t", "text/uri-list", "-i"]
    if shutil.which("wl-copy"):
        return ["wl-copy", "--type", "text/uri-list"]
    return None


def copy_files(paths):
    files = [str(Path(p).resolve()) for p in paths if isinstance(p, str) and os.path.isfile(p)]
    if not files:
        return {"ok": False, "error": "not-found"}
    command = clipboard_command()
    if not command:
        return {"ok": False, "error": "xclip または wl-clipboard(wl-copy)が入っていません"}
    uris = "".join(Path(f).as_uri() + "\r\n" for f in files).encode("utf-8")
    # クリップボードの中身を渡し続けるため、xclip / wl-copy はこのプログラムが終わった後も動き続ける
    proc = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )
    try:
        proc.communicate(uris, timeout=5)
    except subprocess.TimeoutExpired:
        # 入力を読み終えて、クリップボードの番をしている(正常)
        pass
    if proc.returncode not in (None, 0):
        return {"ok": False, "error": "クリップボードに入れられませんでした(%s)" % command[0]}
    return {"ok": True, "count": len(files)}


def main():
    header = read_exact(4)
    if header is None:
        return
    (length,) = struct.unpack("<I", header)
    if length <= 0 or length > 1048576:
        send({"ok": False, "error": "bad-length"})
        return
    body = read_exact(length)
    if body is None:
        return
    try:
        message = json.loads(body.decode("utf-8"))
    except ValueError:
        send({"ok": False, "error": "bad-json"})
        return
    kind = message.get("type") if isinstance(message, dict) else None
    if kind == "ping":
        send({"ok": True, "version": 1, "os": "linux"})
    elif kind == "copy-files":
        paths = message.get("paths")
        send(copy_files(paths if isinstance(paths, list) else []))
    else:
        send({"ok": False, "error": "unknown-type"})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        try:
            send({"ok": False, "error": str(e)})
        except Exception:  # noqa: BLE001
            pass
