#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
製本ビューア 動作確認用テストサーバー(Python 3 標準ライブラリのみ)

使い方:
    python3 server.py              # http://127.0.0.1:8765/ で起動
    python3 server.py --port 9000  # ポートを変える
    python3 server.py --dir ~/pdfs # 手元のPDFフォルダも /files/ 以下で配信する(Range対応)

ブラウザで http://127.0.0.1:8765/ を開くと、確認用リンクの一覧が出ます。
このサーバーは自分のPCの中だけで動き、外部とは通信しません。
"""

import argparse
import html
import os
import re
import secrets
import sys
import threading
import time
import urllib.parse
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# 簡易PDF生成(外部ライブラリなし)
# ---------------------------------------------------------------------------


def _pdf_str(s):
    """PDF文字列リテラル用のエスケープ(ASCIIのみ想定)"""
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_pdf(num_pages, title="Sample", page_size=(420, 595), with_outline=True, labels=None, sizes=None):
    """番号入りの確認用PDFを作る。page_size は pt 単位(既定は A5 縦)。sizes でページごとの大きさも指定できる。"""
    objects = []  # index 0 = object 1

    def add(obj_bytes):
        objects.append(obj_bytes)
        return len(objects)

    font_id = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    bold_id = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
    pages_id = add(b"")  # 後で埋める
    page_ids = []
    for n in range(1, num_pages + 1):
        w, h = (sizes[n - 1] if sizes else page_size)
        label = (labels or {}).get(n) or (
            "Cover" if n == 1 else ("Back cover" if n == num_pages else "Page %d" % n))
        lines = []
        lines.append("0.2 0.4 0.8 RG 3 w 20 20 %d %d re S" % (w - 40, h - 40))
        lines.append("BT /F2 96 Tf 0 0 0 rg %d %d Td (%d) Tj ET" % (w / 2 - 28 * len(str(n)), h / 2, n))
        lines.append("BT /F2 22 Tf %d %d Td (%s) Tj ET" % (40, h - 70, _pdf_str(label)))
        lines.append("BT /F1 11 Tf 40 %d Td (%s - page %d of %d) Tj ET" % (h - 95, _pdf_str(title), n, num_pages))
        y = h / 2 - 60
        for i in range(8):
            text = "Line %d on page %d. The quick brown fox jumps over the lazy dog." % (i + 1, n)
            lines.append("BT /F1 10 Tf 40 %d Td (%s) Tj ET" % (y, _pdf_str(text)))
            y -= 16
        if n % 2 == 0:
            lines.append("BT /F1 9 Tf 40 30 Td (even page) Tj ET")
        else:
            lines.append("BT /F1 9 Tf %d 30 Td (odd page) Tj ET" % (w - 90))
        content = ("\n".join(lines)).encode("latin-1")
        content_id = add(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
        page_id = add(
            (
                "<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %d %d] "
                "/Resources << /Font << /F1 %d 0 R /F2 %d 0 R >> >> /Contents %d 0 R >>"
                % (pages_id, w, h, font_id, bold_id, content_id)
            ).encode("latin-1")
        )
        page_ids.append(page_id)
    kids = " ".join("%d 0 R" % pid for pid in page_ids)
    objects[pages_id - 1] = ("<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, num_pages)).encode("latin-1")

    outline_ref = ""
    if with_outline:
        outlines_id = add(b"")
        item_ids = []
        for n in range(1, num_pages + 1):
            item_ids.append(add(b""))
        for i, item_id in enumerate(item_ids):
            parts = ["/Title (%s)" % _pdf_str("Page %d" % (i + 1)), "/Parent %d 0 R" % outlines_id,
                     "/Dest [%d 0 R /XYZ null null null]" % page_ids[i]]
            if i > 0:
                parts.append("/Prev %d 0 R" % item_ids[i - 1])
            if i < len(item_ids) - 1:
                parts.append("/Next %d 0 R" % item_ids[i + 1])
            objects[item_id - 1] = ("<< %s >>" % " ".join(parts)).encode("latin-1")
        objects[outlines_id - 1] = (
            "<< /Type /Outlines /First %d 0 R /Last %d 0 R /Count %d >>"
            % (item_ids[0], item_ids[-1], len(item_ids))
        ).encode("latin-1")
        outline_ref = " /Outlines %d 0 R" % outlines_id
    info_id = add(("<< /Title (%s) /Producer (seihon test server) >>" % _pdf_str(title)).encode("latin-1"))
    catalog_id = add(("<< /Type /Catalog /Pages %d 0 R%s >>" % (pages_id, outline_ref)).encode("latin-1"))

    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, obj in enumerate(objects):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % (i + 1) + obj + b"\nendobj\n"
    xref_pos = len(out)
    out += b"xref\n0 %d\n" % (len(objects) + 1)
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += (
        "trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (len(objects) + 1, catalog_id, info_id, xref_pos)
    ).encode("latin-1")
    return bytes(out)


SAMPLES = {
    "sample.pdf": make_pdf(12, "Seihon sample (12 pages)"),
    "book-8.pdf": make_pdf(8, "Book N=8"),
    "book-10.pdf": make_pdf(10, "Book N=10"),
    "book-13.pdf": make_pdf(13, "Book N=13 (odd)"),
    # 表紙・裏表紙だけ大きさの違う本(製本用PDF出力の「大きさがそろっていない」場合の確認用)
    "mixed-8.pdf": make_pdf(8, "Mixed sizes", sizes=[(450, 640)] + [(420, 595)] * 6 + [(430, 610)]),
    # B5 の本(製本用PDF出力の用紙の自動選択の確認用。B4 横になる)
    "b5-12.pdf": make_pdf(12, "B5 book", page_size=(516, 729)),
    # 横長の文字の PDF(スライドなど。スキャンの整えが働かないことの確認用)
    "landscape-4.pdf": make_pdf(4, "Landscape slides", page_size=(842, 595)),
}

# 同梱の確認用 PDF(フォーム・リンク・パスワード付き。samples フォルダにあるもの)
_SAMPLES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples")
if os.path.isdir(_SAMPLES_DIR):
    for _name in sorted(os.listdir(_SAMPLES_DIR)):
        if _name.lower().endswith(".pdf"):
            with open(os.path.join(_SAMPLES_DIR, _name), "rb") as _f:
                SAMPLES.setdefault(_name, _f.read())

# ---------------------------------------------------------------------------
# HTTP ハンドラ
# ---------------------------------------------------------------------------

ONCE_TOKENS = {}  # token -> 使用済みなら True
ONCE_LOCK = threading.Lock()
EXTRA_DIR = None
# 通信の遅いネットワークのまね(速度の確認用。--latency / --bandwidth)
LATENCY_SEC = 0.0
BANDWIDTH_BPS = None


INDEX_HTML = """<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>製本ビューア テストサーバー</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI","Hiragino Sans","Yu Gothic UI",sans-serif;max-width:900px;margin:24px auto;padding:0 16px;line-height:1.7;color:#202124}
h1{font-size:22px} h2{font-size:17px;margin-top:28px;border-bottom:1px solid #ddd}
code{background:#f1f3f4;padding:1px 4px;border-radius:3px}
li{margin:6px 0} .exp{color:#5f6368;font-size:13px}
</style></head><body>
<h1>製本ビューア テストサーバー</h1>
<p>各リンクを開き、<b>期待する結果</b>になるか確認してください。サーバーは <code>%(host)s</code> で動いています。</p>

<h2>基本(フェーズ1)</h2>
<ol>
<li><a href="/pdf/sample.pdf">通常のPDF(12ページ、しおり付き)</a><div class="exp">期待: 製本ビューアで開く</div></li>
<li><a href="/pdf/book-8.pdf">8ページのPDF</a> / <a href="/pdf/book-10.pdf">10ページ</a> / <a href="/pdf/book-13.pdf">13ページ(奇数)</a><div class="exp">期待: 製本表示で表紙が単独、2ページ目以降が見開き。偶数ページ数なら最終ページも単独</div></li>
<li><a href="/pdf/sample.pdf#page=5">#page=5 付きのリンク</a><div class="exp">期待: 5ページ目が表示される</div></li>
</ol>

<h2>強制ダウンロード対策(フェーズ1: 第1層・第2層)</h2>
<ol>
<li><a href="/attachment/sample.pdf">① Content-Disposition: attachment 付きの .pdf</a><div class="exp">期待: ダウンロードされず、ビューアで開く</div></li>
<li><a href="/octet/sample.pdf">② application/octet-stream で配信される .pdf</a><div class="exp">期待: ビューアで開く</div></li>
<li><a href="/octet-cd/get?id=42">②' URLに .pdf が無く、octet-stream + ファイル名 report.pdf</a><div class="exp">期待: ビューアで開く</div></li>
<li><a href="/pdf/sample.pdf" download>③ download 属性付きのリンク(同じサイト)</a><div class="exp">期待: 新しいタブのビューアで開く(Altキーを押しながらクリックすると従来どおり保存)</div></li>
<li><a href="/attachment/book-8.pdf" download="book-8.pdf">③' download属性 + attachment</a><div class="exp">期待: 新しいタブのビューアで開く</div></li>
</ol>

<h2>触ってはいけないもの(誤作動しないことの確認)</h2>
<ol>
<li><a href="/html-ext.pdf">URLは .pdf だが中身は HTML</a><div class="exp">期待: 普通のWebページとして表示(ビューアに切り替わらない)</div></li>
<li><a href="/octet-noext/file?id=7">octet-stream でファイル名も不明(中身はPDF)</a><div class="exp">期待: 第1層・第2層は触らず、通常どおりダウンロードされる。保存後、第3層が中身を確かめてビューアで開く(「ファイルの URL へのアクセス」が許可されている場合)</div></li>
<li><a href="/octet-noext/data.zip?id=8">中身が ZIP のダウンロード(PDFではない)</a><div class="exp">期待: 普通にダウンロードされ、ビューアは開かない</div></li>
<li><form method="post" action="/post-pdf" style="display:inline"><button>POSTの応答で返るPDF</button></form><div class="exp">期待: 自動切り替えしない(Chrome標準で表示)。再取得するとPOSTをやり直せないため</div></li>
</ol>

<h2>ログイン・リファラ</h2>
<ol>
<li><a href="/login">ログインする(Cookieを設定)</a> / <a href="/logout">ログアウト</a> &nbsp; 現在: <b>%(login)s</b></li>
<li><a href="/private/sample.pdf">ログインが必要なPDF(SameSite=Lax の Cookie)</a><div class="exp">期待: ログイン中はビューアで開く。未ログインならエラー表示と「Chrome標準で開く」ボタン</div></li>
<li><a href="/private-strict/sample.pdf">ログインが必要なPDF(SameSite=Strict の Cookie)</a></li>
<li><a href="/referer-only/sample.pdf">リファラ必須のPDF(このページからのリンクでのみ取得可)</a><div class="exp">期待: ビューアで開く</div></li>
</ol>

<h2>強制ダウンロード対策(フェーズ2: 第3層)</h2>
<ol>
<li><a href="/blob.html">④ blob: URL でダウンロードさせるページ</a><div class="exp">期待: 保存されたあと、第3層が製本ビューアで開く(「ファイルの URL へのアクセス」が必要)</div></li>
<li><a href="/once/new">⑤ 一度しか使えないURL(表示するPDF)</a><div class="exp">期待: 自動切り替えで使い切ってしまうため開けない。エラー画面の「このサイトは自動で切り替えない」を押してから、もう一度開くと Chrome 標準で表示される</div></li>
<li><a href="/once/new-attach">⑤' 一度しか使えないURL(保存させるPDF)</a><div class="exp">期待: 1回目は同じく開けない。「このサイトは自動で切り替えない」を押してから、もう一度開くと保存され、第3層が製本ビューアで開く</div></li>
<li><a href="/pdf/book-10.pdf">Alt キーを押しながらクリック(保存)</a><div class="exp">期待: 保存されるだけで、ビューアは開かない</div></li>
</ol>

<h2>ページ役割・製本用PDF出力(フェーズ3)</h2>
<ol>
<li><a href="/pdf/book-10.pdf">10ページのPDF</a><div class="exp">期待: 製本用PDF出力で白紙2枚が最後のページ(カバーの裏表紙)の直前に入り、12ページになる</div></li>
<li><a href="/pdf/book-8.pdf">8ページのPDF</a><div class="exp">期待: 白紙は入らない。面付けは (8,1)(2,7)(6,3)(4,5)、右綴じでは左右が入れ替わる</div></li>
<li><a href="/pdf/mixed-8.pdf">表紙・裏表紙だけ大きさの違う8ページのPDF</a><div class="exp">期待: 製本用PDF出力の画面に「ページの大きさがそろっていません」と出る</div></li>
<li><a href="/pdf/b5-12.pdf">B5 の本(12ページ)</a><div class="exp">期待: 用紙が自動で「B4 横」になる</div></li>
</ol>

<h2>コピー・ページ収集(フェーズ2)</h2>
<ol>
<li><a href="/paste.html">貼り付けの試験ページ(チャット欄の代わり)</a><div class="exp">期待: ビューアでページを右クリック →「コピー」のあと、ここに Ctrl+V で画像が貼り付けられる</div></li>
<li><a href="/pdf/book-8.pdf">8ページのPDF</a> と <a href="/pdf/sample.pdf">12ページのPDF</a><div class="exp">期待: 両方からページを収集に追加し、まとめて1つのPDFに書き出せる</div></li>
</ol>

<h2>注釈・フォーム・リンク・パスワード(フェーズ4の確認用)</h2>
<ol>
<li><a href="/pdf/form.pdf">フォームの PDF(入力欄・チェックボックス・選択欄)</a><div class="exp">期待: 入力でき、ページを移っても入力内容が残る。「保存」(またはダウンロード →「編集した内容を含めて保存…」)で、入力内容を含めて保存される</div></li>
<li><a href="/pdf/links.pdf">リンクの PDF</a><div class="exp">期待: 「Go to page 3」を押すと3ページ目へ移動する。もう1つは外部リンク(example.com)</div></li>
<li><a href="/pdf/password.pdf">パスワード付きの PDF(パスワードは seihon)</a><div class="exp">期待: パスワードを聞かれ、seihon を入れると開く</div></li>
</ol>

<h2>0.1 の確認(印刷・幅に合わせる・ページの選択と削除・保存)</h2>
<ol>
<li><a href="/pdf/sample.pdf">12ページのPDF</a><div class="exp">期待: 印刷ボタンで印刷画面のプレビューに12ページ並ぶ。サムネイルの ✕ で削除すると、印刷・保存も残したページだけになる。「元に戻す」で戻る</div></li>
<li><a href="/pdf/mixed-8.pdf">ページの大きさがそろっていない8ページのPDF</a><div class="exp">期待: 「幅に合わせる」「ページに合わせる」で、どの見開きも画面に収まる(横のスクロールバーが出ない)。右綴じで拡大しても、左のページの端まで横にスクロールできる</div></li>
<li><a href="/pdf/book-10.pdf">10ページのPDF</a><div class="exp">期待: サイドバーの「選択」でページを選び、操作バーのラベルのボタンでまとめて役割を付けられる。製本用PDF出力の「カバー・表紙・帯などのページ」で、全部のページから選べる</div></li>
<li><a href="/pdf/form.pdf">フォームの PDF</a><div class="exp">期待: 入力したあと「保存」で保存先を選ぶ画面が出る(名前は form_編集済み.pdf)。保存しないで別の PDF を開こうとすると「変更を保存しますか?」が出る。⋮ →「PDFを閉じる」でも同じ画面が出て、「保存しない」でタブが閉じる</div></li>
</ol>

<h2>0.2 の確認(最高画質・コピー・表示モード・ページに合わせる・役割・元の場所)</h2>
<ol>
<li><a href="/pdf/scan-ocr.pdf">OCR の文字が入ったスキャンの PDF(3ページ)</a><div class="exp">期待: 印刷 → 印刷画面で「PDF に保存」した PDF でも、文字を検索・選択できる(OCR の文字が残る)。右クリック →「画像として保存」で、元の JPEG(.jpg)がそのまま保存される</div></li>
<li><a href="/pdf/book-8.pdf">8ページのPDF</a><div class="exp">期待: 表示モードのボタンを押すたびに 単ページ → 製本表示 → 見開き と切り替わる。その右のボタンで左綴じ・右綴じが切り替わる。ページとページの間を見ているときに「ページに合わせる」を押すと、いちばん大きく見えている見開きが画面の真ん中にちょうど収まる</div></li>
<li><a href="/pdf/book-10.pdf">10ページのPDF</a><div class="exp">期待: 右クリック →「ページ役割」に、カバーの表紙・カバーの裏表紙・表紙・裏表紙・帯・表紙の折り返し・裏表紙の折り返し・しおり が並ぶ。製本用PDF出力の画面で、帯は何ページでも選べる。カバー以外の役割のページは「_付属.pdf」に出力される</div></li>
<li><a href="/pdf/sample.pdf">12ページのPDF</a><div class="exp">期待: タイトルの右のボタンで、このリンク・表示中のページへのリンクをコピーできる。ページ収集に入れて「PDF としてコピー」「画像としてコピー」を押すと、ファイルが保存されて、クリップボードに入る(補助プログラムが無いときは、ファイルの場所が入る)</div></li>
</ol>

<h2>0.3 の確認(スキャンの整え: 見開きの分割・余白の除去・冊子の並べ替え)</h2>
<ol>
<li><a href="/pdf/scan-spread.pdf">本を開いてスキャンした見開き(A5 の本を B4 でスキャン、4枚)</a><div class="exp">期待: 開くと数秒で、1ページずつに分かれた8ページの表示に変わる(ツールバーに「分割表示」)。まわりの余白・影・本の縁の線・左上の黒い影は除かれ、どのページも同じ大きさ。表示は「見開き」で、16|17、18|19… の組み合わせ。Ctrl+F で「OCR-P17」を探すと2ページ目だけが見つかる</div></li>
<li><a href="/pdf/scan-booklet.pdf">ばらした冊子を両面スキャンしたもの(16ページの冊子、8枚)</a><div class="exp">期待: ツールバーに「冊子を並べ替える」が出る。押して「冊子の順に並べ替える」→ 1ページ目が表紙、2ページ目以降が p.2、p.3… の順、最後が裏表紙。製本表示で表紙が単独</div></li>
<li><a href="/pdf/scan-rotated.pdf">回転(/Rotate 90)つきで保存されたスキャン(2枚)</a><div class="exp">期待: 4ページに分かれ、どのページも正しい向き</div></li>
<li><a href="/pdf/sample.pdf">ふつうの PDF(文字の PDF)</a> / <a href="/pdf/landscape-4.pdf">横長の文字の PDF</a><div class="exp">期待: 何も起きない(ツールバーに「見開きを分ける」は出ない)</div></li>
</ol>

<h2>0.4 の確認(電子書籍・コミックの表示と変換)</h2>
<ol>
<li><a href="/book/novel-vertical.epub">縦書きの小説の EPUB</a>(右クリック →「リンク先の本・コミックを製本ビューアで開く」)<div class="exp">期待: 電子書籍リーダーで、縦書き・右から左へめくる表示になる。目次・検索・文字の大きさ・背景の色が使える。「PDF に保存」で印刷画面が開き、縦書きのまま並ぶ</div></li>
<li><a href="/book/novel-horizontal.epub">横書きの EPUB</a></li>
<li><a href="/book/manga-fxl.epub">画像だけの EPUB(固定レイアウトの漫画)</a><div class="exp">期待: 製本ビューアで PDF として表示される(右綴じ・製本表示、白紙のページも入る)。ダウンロードボタンで PDF として保存できる</div></li>
<li><a href="/book/comic.cbz">コミック(CBZ)</a> / <a href="/book/comic.cbr">コミック(CBR)</a> / <a href="/book/comic-noinfo.cbz">ComicInfo の無い CBZ(WebP・GIF 入り)</a><div class="exp">期待: 画像をそのまま並べた PDF として表示される。見開きの画像は 2 ページに分かれる(右綴じは右半分が先)</div></li>
<li><a href="/book/drm.epub">DRM 付きの EPUB</a> / <a href="/book/fake.kfx">KFX</a><div class="exp">期待: 表示できない理由が出る</div></li>
<li><a href="/pdf/book-8.pdf">8ページのPDF</a><div class="exp">期待: ダウンロードボタン →「ほかの形式に変換して保存」で、画像(ZIP)・CBZ・EPUB・テキストにして保存できる</div></li>
</ol>

<h2>速度確認用</h2>
<ol>
<li><a href="/slow/sample.pdf">回線が遅い場合(約200KB/秒)</a></li>
%(extra)s
</ol>
</body></html>
"""


def _small_zip():
    """PDF ではないダウンロードの確認用(小さな ZIP)"""
    import io
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("readme.txt", "This is not a PDF.\n")
    return buf.getvalue()


class FileSource:
    """大きなファイルを、全体をメモリに読み込まずに返すための入れ物"""

    def __init__(self, path):
        self.path = path
        self.size = os.path.getsize(path)

    def __len__(self):
        return self.size

    def iter_range(self, start, end, chunk=262144):
        with open(self.path, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                block = f.read(min(chunk, remaining))
                if not block:
                    break
                remaining -= len(block)
                yield block


class Handler(BaseHTTPRequestHandler):
    server_version = "SeihonTest/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # -- 共通 --------------------------------------------------------------
    def _cookies(self):
        c = cookies.SimpleCookie()
        if "Cookie" in self.headers:
            try:
                c.load(self.headers["Cookie"])
            except cookies.CookieError:
                pass
        return {k: v.value for k, v in c.items()}

    def _send_html(self, body, status=200, extra_headers=None):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _send_bytes(self, data, content_type="application/pdf", disposition=None,
                    extra_headers=None, throttle=None, allow_range=True):
        """PDF等を返す。Range 要求(部分取得)に対応。data は bytes か FileSource。"""
        total = len(data)
        start, end = 0, total - 1
        status = 200
        rng = self.headers.get("Range")
        if allow_range and rng:
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if m:
                if m.group(1) == "":
                    length = int(m.group(2))
                    start = max(0, total - length)
                else:
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), total - 1)
                if start > end or start >= total:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % total)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
        self.send_response(status)
        if content_type:
            self.send_header("Content-Type", content_type)
        if disposition:
            self.send_header("Content-Disposition", disposition)
        if allow_range:
            self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, total))
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command == "HEAD":
            return
        throttle = throttle or BANDWIDTH_BPS
        size = 16384 if throttle else 262144
        chunks = data.iter_range(start, end, size) if isinstance(data, FileSource) else (
            data[i:min(i + size, end + 1)] for i in range(start, end + 1, size))
        try:
            for chunk in chunks:
                self.wfile.write(chunk)
                if throttle:
                    self.wfile.flush()
                    time.sleep(len(chunk) / throttle)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _sample(self, name):
        if name in SAMPLES:
            return SAMPLES[name]
        if EXTRA_DIR:
            path = os.path.realpath(os.path.join(EXTRA_DIR, name))
            if path.startswith(os.path.realpath(EXTRA_DIR) + os.sep) and os.path.isfile(path):
                return FileSource(path)
        return None

    def _not_found(self):
        self._send_html("<h1>404 Not Found</h1>", status=404)

    # -- ルーティング ------------------------------------------------------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if LATENCY_SEC:
            time.sleep(LATENCY_SEC)
        url = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(url.path)
        logged_in = self._cookies().get("seihon_session") == "ok"

        if path == "/":
            extra = ""
            if EXTRA_DIR:
                names = sorted(n for n in os.listdir(EXTRA_DIR) if n.lower().endswith(".pdf"))
                extra = "".join(
                    '<li><a href="/files/%s">%s</a>(--dir で指定したフォルダ)</li>'
                    % (urllib.parse.quote(n), html.escape(n)) for n in names)
            self._send_html(INDEX_HTML % {
                "host": html.escape(self.headers.get("Host", "")),
                "login": "ログイン中" if logged_in else "未ログイン",
                "extra": extra,
            })
            return

        m = re.match(r"^/(pdf|attachment|octet|inline-cd|slow|files)/(.+)$", path)
        if m:
            kind, name = m.group(1), m.group(2)
            data = self._sample(name)
            if data is None:
                return self._not_found()
            if kind in ("pdf", "files"):
                return self._send_bytes(data)
            if kind == "attachment":
                return self._send_bytes(data, disposition='attachment; filename="%s"' % name)
            if kind == "octet":
                return self._send_bytes(data, content_type="application/octet-stream")
            if kind == "inline-cd":
                return self._send_bytes(data, disposition='inline; filename="%s"' % name)
            if kind == "slow":
                return self._send_bytes(data, throttle=200 * 1024)

        if path == "/octet-cd/get":
            return self._send_bytes(SAMPLES["sample.pdf"], content_type="application/octet-stream",
                                    disposition='attachment; filename="report.pdf"')
        if path == "/octet-noext/file":
            return self._send_bytes(SAMPLES["book-8.pdf"], content_type="application/octet-stream")
        if path == "/octet-noext/data.zip":
            return self._send_bytes(_small_zip(), content_type="application/octet-stream")
        if path == "/html-ext.pdf":
            return self._send_html("<h1>これは HTML です</h1><p>URLは .pdf ですが中身はHTMLなので、ビューアに切り替わらないのが正しい動作です。</p>")

        if path == "/login":
            exp = "seihon_session=ok; Path=/; SameSite=Lax"
            exp2 = "seihon_strict=ok; Path=/; SameSite=Strict"
            return self._send_html(
                '<p>ログインしました(Cookie を設定)。<a href="/">戻る</a></p>',
                extra_headers=[("Set-Cookie", exp), ("Set-Cookie", exp2)])
        if path == "/logout":
            return self._send_html(
                '<p>ログアウトしました。<a href="/">戻る</a></p>',
                extra_headers=[("Set-Cookie", "seihon_session=; Path=/; Max-Age=0"),
                               ("Set-Cookie", "seihon_strict=; Path=/; Max-Age=0")])
        m = re.match(r"^/private(-strict)?/(.+)$", path)
        if m:
            key = "seihon_strict" if m.group(1) else "seihon_session"
            if self._cookies().get(key) != "ok":
                return self._send_html('<h1>401 ログインが必要です</h1><p><a href="/login">ログイン</a></p>', status=401)
            data = self._sample(m.group(2))
            return self._send_bytes(data) if data else self._not_found()
        m = re.match(r"^/referer-only/(.+)$", path)
        if m:
            ref = self.headers.get("Referer", "")
            host = self.headers.get("Host", "")
            if not ref.startswith("http://%s/" % host):
                return self._send_html("<h1>403 リファラが必要です</h1><p>Referer: %s</p>" % html.escape(ref or "(なし)"), status=403)
            data = self._sample(m.group(1))
            return self._send_bytes(data) if data else self._not_found()

        if path in ("/once/new", "/once/new-attach"):
            token = secrets.token_hex(8)
            with ONCE_LOCK:
                ONCE_TOKENS[token] = False
            self.send_response(302)
            name = "once-attach.pdf" if path.endswith("attach") else "once.pdf"
            self.send_header("Location", "/once/%s/%s" % (token, name))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        m = re.match(r"^/once/([0-9a-f]+)/(once|once-attach)\.pdf$", path)
        if m:
            with ONCE_LOCK:
                used = ONCE_TOKENS.get(m.group(1))
                if used is None or used:
                    ok = False
                else:
                    ONCE_TOKENS[m.group(1)] = True
                    ok = True
            if not ok:
                return self._send_html("<h1>410 このURLは使用済みです</h1>", status=410)
            disposition = 'attachment; filename="once-attach.pdf"' if m.group(2) == "once-attach" else None
            return self._send_bytes(SAMPLES["book-8.pdf"], disposition=disposition, allow_range=False)

        # 0.4: 電子書籍・コミックの見本(samples/books)。/book-dl/ はダウンロードさせる(Content-Disposition: attachment)
        m = re.match(r"^/(book|book-dl)/([^/]+)$", path)
        if m:
            name = m.group(2)
            fp = os.path.realpath(os.path.join(_SAMPLES_DIR, "books", name))
            data = None
            if fp.startswith(os.path.realpath(os.path.join(_SAMPLES_DIR, "books")) + os.sep) and os.path.isfile(fp):
                data = FileSource(fp)
            else:
                data = self._sample(name)
            if data is None:
                return self._not_found()
            ext = name.rsplit(".", 1)[-1].lower()
            ctype = {"epub": "application/epub+zip", "cbz": "application/vnd.comicbook+zip",
                     "cbr": "application/vnd.comicbook-rar", "mobi": "application/x-mobipocket-ebook",
                     "azw3": "application/vnd.amazon.mobi8-ebook"}.get(ext, "application/octet-stream")
            disposition = 'attachment; filename="%s"' % name if m.group(1) == "book-dl" else None
            return self._send_bytes(data, content_type=ctype, disposition=disposition)
        if path == "/blob.html":
            return self._send_html(BLOB_HTML)
        if path == "/paste.html":
            return self._send_html(PASTE_HTML)

        return self._not_found()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        if self.path.startswith("/post-pdf"):
            return self._send_bytes(SAMPLES["book-8.pdf"], allow_range=False)
        return self._not_found()


PASTE_HTML = """<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>貼り付けの試験(チャット欄の代わり)</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;max-width:900px}
#box{border:2px dashed #8ab4f8;border-radius:12px;min-height:120px;padding:12px;outline:none}
#box:focus{border-style:solid} #log{color:#5f6368;font-size:14px} img{max-width:100%;border:1px solid #ccc;margin-top:8px}</style></head>
<body><h1>貼り付けの試験</h1>
<p>チャット欄の代わりです。製本ビューアで「コピー」をしてから、下の枠をクリックして Ctrl+V(Mac は ⌘+V)で貼り付けてください。
画像として貼り付けられれば、種類と大きさが表示されます。</p>
<div id="box" contenteditable="true" aria-label="ここに貼り付け"></div>
<p id="log">まだ貼り付けられていません</p>
<div id="preview"></div>
<p><a href="/">戻る</a></p>
<script>
const box = document.getElementById('box');
box.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])];
  e.preventDefault();
  if (!files.length) { document.getElementById('log').textContent = 'ファイル・画像ではありませんでした(文字: ' + (e.clipboardData.getData('text/plain') || '').slice(0, 80) + ')'; window.__pasted = { files: [] }; return; }
  const f = files[0];
  if (files.length > 1 || !f.type.startsWith('image/')) {
    // 「PDF としてコピー」「画像としてコピー」(補助プログラムあり)で貼り付けたファイル
    document.getElementById('log').textContent = files.length + ' 個のファイルが貼り付けられました: ' + files.map(x => x.name + '(' + (x.type || '種類不明') + '、' + Math.round(x.size / 1024) + ' KB)').join('、');
    window.__pasted = { files: files.map(x => ({ name: x.name, type: x.type, size: x.size })) };
    document.getElementById('preview').textContent = '';
    return;
  }
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => {
    document.getElementById('log').textContent = '貼り付けられました: ' + f.type + '、' + img.naturalWidth + '×' + img.naturalHeight + ' ピクセル、' + Math.round(f.size / 1024) + ' KB';
    window.__pasted = { files: files.map(x => ({ type: x.type, size: x.size })), width: img.naturalWidth, height: img.naturalHeight };
  };
  img.src = url;
  const p = document.getElementById('preview'); p.textContent = ''; p.append(img);
});
</script></body></html>"""


BLOB_HTML = """<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>blob ダウンロード試験</title></head>
<body style="font-family:system-ui,sans-serif;margin:24px">
<h1>blob: URL のダウンロード試験</h1>
<p><button id="b1">ページ内のリンクで blob をダウンロード</button></p>
<p><button id="b2">文書に入れないリンクで blob をダウンロード(スクリプトによる保存)</button></p>
<p><a href="/">戻る</a></p>
<script>
async function getBlob(){ const r = await fetch('/pdf/book-10.pdf'); return await r.blob(); }
document.getElementById('b1').onclick = async () => {
  const url = URL.createObjectURL(await getBlob());
  const a = document.createElement('a'); a.href = url; a.download = 'blob-in-dom.pdf';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
};
document.getElementById('b2').onclick = async () => {
  const url = URL.createObjectURL(await getBlob());
  const a = document.createElement('a'); a.href = url; a.download = 'blob-detached.pdf'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
};
</script></body></html>"""


def main():
    global EXTRA_DIR
    ap = argparse.ArgumentParser(description="製本ビューア テストサーバー")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--dir", default=None, help="追加で配信するPDFのフォルダ(/files/ 以下)")
    ap.add_argument("--latency", type=float, default=0, help="応答を返す前に待つ時間(ミリ秒)。遅いネットワークのまね")
    ap.add_argument("--bandwidth", type=float, default=0, help="送る速さの上限(KB/秒)。遅いネットワークのまね")
    args = ap.parse_args()
    global LATENCY_SEC, BANDWIDTH_BPS
    LATENCY_SEC = max(0.0, args.latency) / 1000.0
    BANDWIDTH_BPS = args.bandwidth * 1024 if args.bandwidth > 0 else None
    if args.dir:
        EXTRA_DIR = os.path.abspath(os.path.expanduser(args.dir))
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print("テストサーバーを起動しました: http://%s:%d/  (終了は Ctrl+C)" % (args.host, args.port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n終了します")


if __name__ == "__main__":
    main()
