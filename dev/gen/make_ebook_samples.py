#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
0.4 の確認用の電子書籍・コミックの見本を作る(文章・絵はすべてこの場で作ったもの)。

作るもの(tools/test-server/samples/ に置く)
  novel-vertical.epub   縦書き・右綴じの小説(3章、ルビ、挿絵、目次、表紙、<script> 入り)
  novel-horizontal.epub 横書きの短い本
  manga-fxl.epub        画像だけの固定レイアウトの漫画(右綴じ、白紙ページ、目次)
  comic.cbz             画像の ZIP(ComicInfo.xml で右綴じ、見開きの画像 1 枚)
  comic.cbr             画像の RAR(RAR4、無圧縮)
  comic-nocomicinfo.cbz ComicInfo.xml の無い画像の ZIP(WebP・GIF も入れる)
  drm.epub              DRM 付き(META-INF/rights.xml と暗号化)の見本(表示できないことの確認)
  fake.kfx              KFX の見本(先頭が CONT)
"""

import io
import os
import struct
import sys
import time
import zipfile
import zlib

from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"


def font(size):
    try:
        return ImageFont.truetype(FONT, size, index=0)
    except Exception:
        return ImageFont.load_default()


def page_image(label, w=1000, h=1420, color=(255, 255, 255), fmt="JPEG", spread=False):
    im = Image.new("RGB", (w, h), color)
    d = ImageDraw.Draw(im)
    d.rectangle([30, 30, w - 31, h - 31], outline=(0, 0, 0), width=10)
    if spread:
        d.line([w // 2, 30, w // 2, h - 30], fill=(160, 160, 160), width=4)
        d.text((w * 3 // 4, h // 2), "右", font=font(200), fill=(0, 0, 0), anchor="mm")
        d.text((w // 4, h // 2), "左", font=font(200), fill=(0, 0, 0), anchor="mm")
    d.text((w // 2, h // 5), label, font=font(120), fill=(0, 0, 0), anchor="mm")
    buf = io.BytesIO()
    if fmt == "JPEG":
        im.save(buf, "JPEG", quality=88)
    else:
        im.save(buf, fmt)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# EPUB
# ---------------------------------------------------------------------------

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""


def write_epub(path, files, extra_meta_inf=None):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER, compress_type=zipfile.ZIP_DEFLATED)
        for name, data in (extra_meta_inf or {}).items():
            z.writestr("META-INF/" + name, data, compress_type=zipfile.ZIP_DEFLATED)
        for name, data in files.items():
            ctype = zipfile.ZIP_STORED if name.endswith((".jpg", ".png")) else zipfile.ZIP_DEFLATED
            z.writestr("OEBPS/" + name, data, compress_type=ctype)


def xhtml(title, body, css="style.css", lang="ja", extra_head=""):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{lang}" lang="{lang}">
<head><meta charset="UTF-8"/><title>{title}</title><link rel="stylesheet" type="text/css" href="{css}"/>{extra_head}</head>
<body>
{body}
</body>
</html>
"""


PROSE = [
    "朝から降りつづいた雨は、昼を過ぎても弱まる気配を見せなかった。駅前の古本屋の軒先で、わたしは傘をたたんだまま、しばらく通りをながめていた。",
    "店の奥では、主人が帳場で算盤をはじいている。ぱちり、ぱちりという音が、雨だれの音にまじって、妙に心地よく聞こえた。",
    "棚の一番下に、背の焼けた一冊の本があった。題名はかすれて読めない。手に取ると、紙の匂いとともに、遠い夏の記憶がよみがえってきた。",
    "「その本は、もう三十年も売れ残っていましてね」と主人は言った。「だれかが迎えに来るのを、待っているのかもしれません」",
    "わたしはその本を買うことにした。代金を払い、包み紙にくるんでもらうあいだ、雨の音はいつのまにか小さくなっていた。",
]


def make_vertical_epub(path):
    css = """@charset "UTF-8";
html { writing-mode: vertical-rl; -epub-writing-mode: vertical-rl; -webkit-writing-mode: vertical-rl; }
body { font-family: serif; line-height: 1.8; }
h1 { font-size: 1.4em; margin-inline-start: 2em; }
p { text-indent: 1em; margin: 0; }
.fig { text-align: center; margin: 1em 0; }
.fig img { max-height: 60%; }
"""
    chapters = []
    titles = ["第一章 雨の日の古本屋", "第二章 包み紙の中", "第三章 迎えに来た人"]
    for c, t in enumerate(titles, 1):
        paras = []
        for k in range(14):
            p = PROSE[(k + c) % len(PROSE)]
            if k == 2:
                p = p.replace("古本屋", "<ruby>古本屋<rt>ふるほんや</rt></ruby>")
            paras.append(f"<p>{p}</p>")
        if c == 2:
            paras.insert(5, '<div class="fig"><img src="images/illust.png" alt="挿絵"/></div>')
        extra = ""
        if c == 3:
            # 本の中のスクリプト(実行されないことの確認用)
            extra = '<script type="text/javascript">try{parent.__seihonEpubScript=1;top.__seihonEpubScript=1;document.title="SCRIPT-RAN";}catch(e){}</script>'
        body = f'<section epub:type="chapter"><h1 id="c{c}">{t}</h1>\n' + "\n".join(paras) + f'\n<p id="end{c}">（{t[:3]} 終わり）</p></section>'
        chapters.append(xhtml(t, body, extra_head=extra))
    cover_xhtml = xhtml("表紙", '<div style="text-align:center"><img src="images/cover.jpg" alt="表紙" style="max-width:100%;max-height:100%"/></div>')
    nav = xhtml("目次", """<nav epub:type="toc" id="toc"><h1>目次</h1><ol>
<li><a href="chap1.xhtml">第一章 雨の日の古本屋</a></li>
<li><a href="chap2.xhtml">第二章 包み紙の中</a></li>
<li><a href="chap3.xhtml#c3">第三章 迎えに来た人</a></li>
</ol></nav>""")
    opf = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ja">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">urn:uuid:seihon-sample-vertical-0001</dc:identifier>
<dc:title>雨の日の古本屋(見本)</dc:title>
<dc:creator>製本ビューア 見本</dc:creator>
<dc:language>ja</dc:language>
<meta property="dcterms:modified">2026-10-01T00:00:00Z</meta>
<meta name="cover" content="cover-img"/>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
<item id="illust" href="images/illust.png" media-type="image/png"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>
<item id="c3" href="chap3.xhtml" media-type="application/xhtml+xml" properties="scripted"/>
</manifest>
<spine page-progression-direction="rtl">
<itemref idref="cover"/><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/>
</spine>
</package>
"""
    illust = Image.new("RGB", (600, 400), (230, 240, 255))
    d = ImageDraw.Draw(illust)
    d.ellipse([150, 60, 450, 340], outline=(30, 60, 120), width=8)
    d.text((300, 200), "挿絵", font=font(80), fill=(30, 60, 120), anchor="mm")
    b = io.BytesIO()
    illust.save(b, "PNG")
    write_epub(path, {
        "content.opf": opf,
        "nav.xhtml": nav,
        "cover.xhtml": cover_xhtml,
        "style.css": css,
        "chap1.xhtml": chapters[0],
        "chap2.xhtml": chapters[1],
        "chap3.xhtml": chapters[2],
        "images/cover.jpg": page_image("表紙", 800, 1150, (250, 235, 215)),
        "images/illust.png": b.getvalue(),
    })


def make_horizontal_epub(path):
    css = "body { font-family: sans-serif; line-height: 1.7; } h1 { color: #224; }"
    paras = "\n".join(f"<p>{PROSE[k % len(PROSE)]}</p>" for k in range(10))
    ch1 = xhtml("はじめに", f'<h1 id="intro">はじめに(HORIZONTAL-MARK)</h1>{paras}<p><a href="chap2.xhtml#s2">次の章へ</a></p>')
    ch2 = xhtml("使い方", f'<h1 id="s2">使い方</h1><p>The quick brown fox jumps over the lazy dog.</p>{paras}')
    nav = xhtml("目次", '<nav epub:type="toc"><ol><li><a href="chap1.xhtml">はじめに</a></li><li><a href="chap2.xhtml#s2">使い方</a></li></ol></nav>')
    opf = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">urn:uuid:seihon-sample-horizontal-0001</dc:identifier>
<dc:title>横書きの見本</dc:title><dc:language>ja</dc:language>
<meta property="dcterms:modified">2026-10-01T00:00:00Z</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>
"""
    write_epub(path, {"content.opf": opf, "nav.xhtml": nav, "style.css": css, "chap1.xhtml": ch1, "chap2.xhtml": ch2})


def make_fxl_epub(path):
    pages = ["表紙", "1", "2", None, "4", "5", "裏表紙"]
    files = {}
    items = []
    spine = []
    for i, p in enumerate(pages):
        name = f"p{i:03d}.xhtml"
        head = '<meta name="viewport" content="width=1000, height=1420"/>'
        if p is None:
            body = '<div style="width:1000px;height:1420px"></div>'
        else:
            img = f"images/i{i:03d}.jpg"
            files[img] = page_image(f"FXL {p}", color=(255, 255, 250))
            items.append(f'<item id="img{i}" href="{img}" media-type="image/jpeg"{" properties=\"cover-image\"" if i == 0 else ""}/>')
            body = f'<div><img src="{img}" alt="" style="width:1000px;height:1420px"/></div>'
        files[name] = xhtml(f"p{i}", body, extra_head=head)
        items.append(f'<item id="p{i}" href="{name}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="p{i}" properties="page-spread-{"left" if i % 2 else "right"}"/>')
    files["style.css"] = "body{margin:0}"
    files["nav.xhtml"] = xhtml("目次", '<nav epub:type="toc"><ol><li><a href="p000.xhtml">表紙</a></li><li><a href="p001.xhtml">第1話</a></li><li><a href="p004.xhtml">第2話</a></li></ol></nav>')
    opf = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">urn:uuid:seihon-sample-fxl-0001</dc:identifier>
<dc:title>固定レイアウトの漫画(見本)</dc:title><dc:language>ja</dc:language>
<meta property="dcterms:modified">2026-10-01T00:00:00Z</meta>
<meta property="rendition:layout">pre-paginated</meta>
<meta property="rendition:spread">landscape</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
{chr(10).join(items)}
</manifest>
<spine page-progression-direction="rtl">
{chr(10).join(spine)}
</spine>
</package>
"""
    files["content.opf"] = opf
    write_epub(path, files)


def make_drm_epub(path):
    rights = '<?xml version="1.0"?><rights xmlns="http://ns.adobe.com/adept"><licenseToken/></rights>'
    enc = """<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
<enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
<enc:CipherData><enc:CipherReference URI="OEBPS/chap1.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>"""
    opf = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">x</dc:identifier><dc:title>DRM</dc:title><dc:language>ja</dc:language></metadata>
<manifest><item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/></spine></package>"""
    write_epub(path, {"content.opf": opf, "chap1.xhtml": os.urandom(400)}, {"rights.xml": rights, "encryption.xml": enc})


# ---------------------------------------------------------------------------
# CBZ / CBR
# ---------------------------------------------------------------------------

COMIC_INFO = """<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Title>見本のコミック</Title>
  <Series>見本</Series>
  <Number>1</Number>
  <Manga>YesAndRightToLeft</Manga>
  <LanguageISO>ja</LanguageISO>
</ComicInfo>
"""


def comic_pages():
    pages = []
    pages.append(("000_cover.jpg", page_image("CBZ 表紙", color=(250, 230, 230))))
    for i in range(1, 6):
        pages.append((f"{i:03d}.jpg", page_image(f"CBZ {i}")))
    pages.append(("006-007.jpg", page_image("見開き 6-7", w=2000, h=1420, spread=True)))
    for i in range(8, 10):
        pages.append((f"{i:03d}.jpg", page_image(f"CBZ {i}")))
    pages.append(("010.png", page_image("CBZ 10 PNG", fmt="PNG")))
    return pages


def make_cbz(path, with_info=True, extra=None):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:
        if with_info:
            z.writestr("ComicInfo.xml", COMIC_INFO)
        for name, data in (extra if extra is not None else comic_pages()):
            z.writestr("pages/" + name, data)
        z.writestr("__MACOSX/pages/._001.jpg", b"\0\5\26\7junk")
        z.writestr("Thumbs.db", b"junk")


def rar4_stored(files):
    """無圧縮の RAR(バージョン 4)を作る"""

    def block(htype, flags, body, add=b""):
        size = 7 + len(body)
        head = struct.pack("<BHH", htype, flags, size) + body
        crc = zlib.crc32(head) & 0xFFFF
        return struct.pack("<H", crc) + head + add

    out = b"Rar!\x1a\x07\x00"
    out += block(0x73, 0, struct.pack("<HI", 0, 0))
    t = time.localtime(time.mktime((2026, 10, 1, 12, 0, 0, 0, 0, -1)))
    dos = ((t.tm_year - 1980) << 25) | (t.tm_mon << 21) | (t.tm_mday << 16) | (t.tm_hour << 11) | (t.tm_min << 5) | (t.tm_sec // 2)
    for name, data in files:
        n = name.encode("utf-8")
        body = struct.pack("<IIBIIBBHI", len(data), len(data), 2, zlib.crc32(data) & 0xFFFFFFFF, dos, 20, 0x30, len(n), 0x20) + n
        out += block(0x74, 0x8000, body, data)
    out += block(0x7B, 0x4000, b"")
    return out


def make_cbr(path):
    files = [("ComicInfo.xml", COMIC_INFO.encode("utf-8"))]
    for name, data in comic_pages()[:6]:
        files.append(("CBR/" + name.replace("CBZ", "CBR"), data))
    # CBR の画像には CBR と書く
    files = [(n, d) for n, d in files]
    renamed = [files[0]]
    for i, (n, _) in enumerate(files[1:]):
        label = "CBR 表紙" if i == 0 else f"CBR {i}"
        renamed.append((n, page_image(label, color=(230, 240, 230))))
    with open(path, "wb") as f:
        f.write(rar4_stored(renamed))


def make_cbz_no_info(path):
    pages = []
    pages.append(("p1.jpg", page_image("NOINFO 1")))
    pages.append(("p2.webp", page_image("NOINFO 2 WEBP", fmt="WEBP")))
    pages.append(("p10.gif", page_image("NOINFO 10 GIF", fmt="GIF")))
    pages.append(("p3.png", page_image("NOINFO 3 PNG", fmt="PNG")))
    make_cbz(path, with_info=False, extra=pages)


def main():
    os.makedirs(OUT, exist_ok=True)
    make_vertical_epub(os.path.join(OUT, "novel-vertical.epub"))
    make_horizontal_epub(os.path.join(OUT, "novel-horizontal.epub"))
    make_fxl_epub(os.path.join(OUT, "manga-fxl.epub"))
    make_drm_epub(os.path.join(OUT, "drm.epub"))
    make_cbz(os.path.join(OUT, "comic.cbz"))
    make_cbr(os.path.join(OUT, "comic.cbr"))
    make_cbz_no_info(os.path.join(OUT, "comic-noinfo.cbz"))
    with open(os.path.join(OUT, "fake.kfx"), "wb") as f:
        f.write(b"CONT\x02\x00" + os.urandom(2000))
    for n in sorted(os.listdir(OUT)):
        if n.endswith((".epub", ".cbz", ".cbr", ".kfx")):
            print(n, os.path.getsize(os.path.join(OUT, n)))


if __name__ == "__main__":
    main()
