#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
配布用の zip を作る: src/ の全ファイルを、zip の中の seihon-viewer/ フォルダに入れる。

    python3 dev/make_dist.py            → dist/seihon-viewer-<版>.zip(版は src/manifest.json の version)
    python3 dev/make_dist.py <出力先>   → 指定した名前の zip

- git で管理しているときは、git が管理しているファイル(git ls-files src)だけを入れる(作業中のごみを入れないため)。
  git が無いときは、src/ の中の全ファイル(__pycache__・.DS_Store などを除く)を入れる。
- 同じ名前の zip があるときは上書きしない(--force を付けたときだけ置き換える)。
- 標準ライブラリだけで動く(Windows・Mac・Linux)。
"""

import json
import os
import subprocess
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
TOP = "seihon-viewer"
SKIP_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}


def tracked_files():
    """src/ の中の入れるファイル(src/ からの相対パス、/ 区切り)"""
    try:
        out = subprocess.run(
            ["git", "-C", ROOT, "ls-files", "-z", "--", "src"],
            capture_output=True, check=True,
        ).stdout
        names = [n.decode("utf-8") for n in out.split(b"\0") if n]
        if names:
            return sorted(n[len("src/"):] for n in names if n.startswith("src/"))
    except (OSError, subprocess.CalledProcessError):
        pass
    found = []
    for base, dirs, files in os.walk(SRC):
        dirs[:] = [d for d in dirs if d not in ("__pycache__", ".git")]
        for f in files:
            if f in SKIP_NAMES or f.endswith(".pyc"):
                continue
            found.append(os.path.relpath(os.path.join(base, f), SRC).replace(os.sep, "/"))
    return sorted(found)


def main(argv):
    force = "--force" in argv
    args = [a for a in argv if a != "--force"]
    with open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as fh:
        version = json.load(fh)["version"]
    out = os.path.abspath(args[0]) if args else os.path.join(ROOT, "dist", "%s-%s.zip" % (TOP, version))
    if os.path.exists(out) and not force:
        print("すでにあります(上書きしません。置き換えるときは --force): %s" % out)
        return 1
    os.makedirs(os.path.dirname(out), exist_ok=True)
    files = tracked_files()
    dirs = set()
    for f in files:
        parts = f.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            dirs.add("/".join(parts[:i]))
    tmp = out + ".part"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        root_info = zipfile.ZipInfo(TOP + "/", time.localtime(os.path.getmtime(SRC))[:6])
        root_info.external_attr = (0o40755 << 16) | 0x10
        z.writestr(root_info, b"")
        for d in sorted(dirs):
            info = zipfile.ZipInfo("%s/%s/" % (TOP, d), time.localtime(os.path.getmtime(os.path.join(SRC, d)))[:6])
            info.external_attr = (0o40755 << 16) | 0x10
            z.writestr(info, b"")
        for f in files:
            path = os.path.join(SRC, *f.split("/"))
            st = os.stat(path)
            info = zipfile.ZipInfo("%s/%s" % (TOP, f), time.localtime(st.st_mtime)[:6])
            info.external_attr = ((st.st_mode & 0o777) | 0o100000) << 16  # 実行できるファイル(補助プログラム)はそのまま
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(path, "rb") as fh:
                z.writestr(info, fh.read())
    os.replace(tmp, out)
    print("作りました: %s(%d ファイル、版 %s)" % (out, len(files), version))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
