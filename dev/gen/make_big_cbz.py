#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
大きなコミックの見本(試験 phase8 の L24: 200 ページ・約 48MB の CBZ を PDF にして表示する速さ)を作る(開発用)。

    python3 make_big_cbz.py <出力ファイル(例: dev/pdfs/big-200.cbz)>

1600×2300 の JPEG(灰色の四角を散らした絵)を 200 枚、無圧縮の ZIP に入れる。
毎回同じ絵になる(乱数の種を固定)。試験で見るのはページ数と表示までの時間だけ。
0.4 の試験で使った big-200.cbz(同じ大きさ・枚数・形式。作り方の記録は無い)の代わりに作ったもの。
"""

import io
import random
import sys
import zipfile

from PIL import Image, ImageDraw

W, H, PAGES = 1600, 2300, 200


def page(rng):
    im = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(im)
    for _ in range(320):
        x = rng.randrange(0, W - 40)
        y = rng.randrange(0, H - 10)
        w = rng.randrange(40, 330)
        h = rng.randrange(6, 70)
        g = rng.randrange(0, 200)
        d.rectangle([x, y, min(W - 1, x + w), min(H - 1, y + h)], fill=(g, g, g))
    b = io.BytesIO()
    im.save(b, "JPEG", quality=88)
    return b.getvalue()


def main(out):
    rng = random.Random(200)
    total = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
        for i in range(1, PAGES + 1):
            data = page(rng)
            total += len(data)
            info = zipfile.ZipInfo("%03d.jpg" % i, (2026, 10, 11, 23, 19, 0))
            z.writestr(info, data)
    print("ok", out, PAGES, "pages", round(total / 1e6, 1), "MB")


if __name__ == "__main__":
    main(sys.argv[1])
