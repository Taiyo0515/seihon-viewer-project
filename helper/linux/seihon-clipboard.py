#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
製本ビューア: ファイルをクリップボードに入れる補助プログラム(Linux。Chrome のネイティブ メッセージングで呼ばれる)

製本ビューアから PDF・画像のデータを受け取って「ダウンロード」フォルダの「製本ビューア_コピー」に保存し、
ファイルとしてクリップボードに入れる(text/uri-list)。xclip(X11)または wl-copy(Wayland)を使う。
保存は Chrome のダウンロードを通さないので、Chrome の「保存する前に保存場所を確認する」の設定でも聞かれない。
ネットワークは使わない。同じ名前のファイルがあっても上書きしない(「名前 (1).pdf」のようにする)。

依頼(4バイトの長さ + UTF-8 の JSON):
  {"type":"ping"}
  {"type":"begin","root":"製本ビューア_コピー","folder":"","files":[{"name":"a.pdf","size":123}]}
  {"type":"chunk","index":0,"data":"<base64>"}   … ファイルの中身(順番に)
  {"type":"finish"}                               … 保存を終えて、クリップボードに入れる
  {"type":"copy-files","paths":["/home/…/a.pdf"]} … 保存済みのファイルをクリップボードに入れる
  {"type":"reveal","path":"/home/…/a.pdf"}        … ファイルのあるフォルダを開く
"""

import base64
import json
import os
import re
import shutil
import struct
import subprocess
import sys
from pathlib import Path

VERSION = 2
MAX_MESSAGE = 64 * 1024 * 1024


def read_exact(count):
    data = b""
    while len(data) < count:
        chunk = sys.stdin.buffer.read(count - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def read_message():
    header = read_exact(4)
    if header is None:
        return None
    (length,) = struct.unpack("<I", header)
    if length <= 0 or length > MAX_MESSAGE:
        raise ValueError("bad-length")
    body = read_exact(length)
    if body is None:
        return None
    return json.loads(body.decode("utf-8"))


def send(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def downloads_dir():
    """「ダウンロード」フォルダ(xdg-user-dir があればそれ、無ければ ~/Downloads)"""
    try:
        out = subprocess.run(["xdg-user-dir", "DOWNLOAD"], capture_output=True, text=True, timeout=3).stdout.strip()
        if out and os.path.isdir(out) and out != str(Path.home()):
            return out
    except (OSError, subprocess.SubprocessError):
        pass
    home = Path.home() / "Downloads"
    return str(home) if home.is_dir() else str(Path.home())


def safe_name(name):
    """ファイル名・フォルダ名に使えない文字を置き換える(フォルダの外を指せないようにする)"""
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", str(name or "")).strip().strip(".")
    return s[:150] or "file"


def unique_path(directory, name):
    path = Path(directory) / name
    if not path.exists():
        return path
    stem, suffix = os.path.splitext(name)
    n = 1
    while True:
        candidate = Path(directory) / ("%s (%d)%s" % (stem, n, suffix))
        if not candidate.exists():
            return candidate
        n += 1


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
        return {"ok": False, "error": "xclip または wl-clipboard(wl-copy)が入っていません", "paths": files}
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
        pass  # 入力を読み終えて、クリップボードの番をしている(正常)
    if proc.returncode not in (None, 0):
        return {"ok": False, "error": "クリップボードに入れられませんでした(%s)" % command[0], "paths": files}
    return {"ok": True, "count": len(files), "paths": files}


class Session:
    """begin → chunk… → finish の1回分の保存"""

    def __init__(self):
        self.paths = []
        self.sizes = []

    def begin(self, message):
        root = safe_name(message.get("root") or "SeihonViewer")
        folder = message.get("folder") or ""
        files = message.get("files") or []
        if not isinstance(files, list) or not files:
            return {"ok": False, "error": "no-files"}
        directory = Path(downloads_dir()) / root
        directory.mkdir(parents=True, exist_ok=True)
        if folder:
            directory = unique_path(directory, safe_name(folder))
            directory.mkdir(parents=True, exist_ok=False)
        self.paths = []
        self.sizes = []
        for f in files:
            path = unique_path(directory, safe_name(f.get("name")))
            path.write_bytes(b"")
            self.paths.append(path)
            self.sizes.append(int(f.get("size") or 0))
        return {"ok": True, "paths": [str(p) for p in self.paths], "dir": str(directory)}

    def chunk(self, message):
        index = message.get("index")
        if not isinstance(index, int) or not 0 <= index < len(self.paths):
            return {"ok": False, "error": "bad-index"}
        with open(self.paths[index], "ab") as fh:
            fh.write(base64.b64decode(message.get("data") or ""))
        return {"ok": True}

    def finish(self):
        for path, size in zip(self.paths, self.sizes):
            if path.stat().st_size != size:
                return {"ok": False, "error": "size-mismatch"}
        return copy_files([str(p) for p in self.paths])


def reveal(path):
    if not isinstance(path, str) or not os.path.exists(path):
        return {"ok": False, "error": "not-found"}
    folder = path if os.path.isdir(path) else os.path.dirname(path)
    if not shutil.which("xdg-open"):
        return {"ok": False, "error": "xdg-open が見つかりません"}
    subprocess.Popen(["xdg-open", folder], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return {"ok": True}


def main():
    session = Session()
    while True:
        message = read_message()
        if message is None:
            return
        kind = message.get("type") if isinstance(message, dict) else None
        try:
            if kind == "ping":
                send({"ok": True, "version": VERSION, "os": "linux", "dir": str(Path(downloads_dir()))})
            elif kind == "begin":
                send(session.begin(message))
            elif kind == "chunk":
                send(session.chunk(message))
            elif kind == "finish":
                send(session.finish())
            elif kind == "copy-files":
                paths = message.get("paths")
                send(copy_files(paths if isinstance(paths, list) else []))
            elif kind == "reveal":
                send(reveal(message.get("path")))
            else:
                send({"ok": False, "error": "unknown-type"})
        except Exception as e:  # noqa: BLE001
            send({"ok": False, "error": str(e)})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        try:
            send({"ok": False, "error": str(e)})
        except Exception:  # noqa: BLE001
            pass
