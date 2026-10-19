"""
スキャンの整え(0.3)の確認用 PDF を作る(開発用。配布物には作った PDF だけを入れる)。

  scan-spread.pdf   本(A5)を開いて B4 の原稿台でスキャンしたような見開き 4 枚(余白・影・本の縁・ごみ・OCR の文字つき)
  scan-booklet.pdf  ばらした中綴じの冊子(B5、16 ページ)を、外側の紙から両面スキャンしたような 8 枚(OCR の文字つき)
  scan-rotated.pdf  見開き 2 枚を、ページの回転(/Rotate 90)つきで保存したもの

使い方: python3 make_scan_samples.py <出力フォルダ>
"""
import io, os, random, sys, hashlib
from PIL import Image, ImageDraw, ImageFont, ImageFilter

DPI = 100
MM = DPI / 25.4
FONT = '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc'
FONT_B = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
random.seed(7)

LINES = [
    "次の文章を読んで、あとの問いに答えなさい。",
    "スキャンした本のページを、きれいに表示するための見本です。",
    "見開きを真ん中で分けて、余白を除いて表示します。",
    "画像は作り直さないので、画質は元のままです。",
    "原稿台に本を置いてスキャンすると、まわりに影が入ります。",
    "ノドの影や本の縁の線は、ページの中身ではありません。",
    "(1) 7 と 12 の最小公倍数を求めよ。",
    "(2) 360 の正の約数の個数を求めよ。",
    "(3) 2つの数の和が 168 になる組をすべて求めよ。",
    "ことばの意味を辞書で調べ、例文を作りなさい。",
]

def font(size, bold=False):
    return ImageFont.truetype(FONT_B if bold else FONT, size, index=0)

def draw_page(w, h, number, title=None, body=True):
    """1ページ分(白い紙)を描く。number: 印刷されたページ番号"""
    im = Image.new('L', (w, h), 255)
    d = ImageDraw.Draw(im)
    x0 = int(16 * MM); x1 = w - int(16 * MM)
    y = int(18 * MM)
    if title:
        d.text((x0, y), title, font=font(int(7 * MM), True), fill=0)
        y += int(14 * MM)
    else:
        d.text((x0, y), f"【練習 {number}】", font=font(int(4 * MM), True), fill=20)
        y += int(9 * MM)
    if body:
        for i in range(random.randint(5, 12)):
            d.text((x0 + (int(4 * MM) if i % 3 else 0), y), random.choice(LINES), font=font(int(3.6 * MM)), fill=30)
            y += int(7 * MM)
    # 下の線とページ番号
    fy = h - int(16 * MM)
    d.line([(x0, fy), (x1, fy)], fill=40, width=1)
    label = f"— {number} —"
    tw = d.textlength(label, font=font(int(3.4 * MM)))
    d.text(((w - tw) / 2, fy + int(3 * MM)), label, font=font(int(3.4 * MM)), fill=30)
    return im

def jpeg(im, q=72):
    b = io.BytesIO(); im.save(b, 'JPEG', quality=q); return b.getvalue()

class Pdf:
    def __init__(self):
        self.objs = []
    def add(self, data):
        self.objs.append(data); return len(self.objs)
    def write(self, path, page_ids, seed):
        out = io.BytesIO()
        out.write(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
        offsets = []
        for i, o in enumerate(self.objs):
            offsets.append(out.tell())
            out.write(f'{i + 1} 0 obj\n'.encode()); out.write(o); out.write(b'\nendobj\n')
        x = out.tell()
        out.write(f'xref\n0 {len(self.objs) + 1}\n0000000000 65535 f \n'.encode())
        for off in offsets:
            out.write(f'{off:010d} 00000 n \n'.encode())
        idh = hashlib.md5(seed.encode()).hexdigest()
        out.write(f'trailer\n<< /Size {len(self.objs) + 1} /Root 1 0 R /ID [<{idh}> <{idh}>] >>\nstartxref\n{x}\n%%EOF\n'.encode())
        open(path, 'wb').write(out.getvalue())

def stream(d, data):
    return d + f' /Length {len(data)} >>\nstream\n'.encode('latin1') + data + b'\nendstream'

def build(path, scans, size_pt, seed, rotate=0, ocr=None):
    """scans: [PIL 灰色画像]、size_pt: (幅, 高さ) ポイント。ocr: [[(x_pt, y_pt, text), ...], ...]"""
    pdf = Pdf()
    pdf.add(b'<< /Type /Catalog /Pages 2 0 R >>')
    pdf.add(b'')  # Pages(後で)
    font_id = pdf.add(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    page_ids = []
    W, H = size_pt
    for i, im in enumerate(scans):
        data = jpeg(im)
        img_id = pdf.add(stream(f'<< /Type /XObject /Subtype /Image /Width {im.size[0]} /Height {im.size[1]} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode'.encode(), data))
        content = f'q {W:.2f} 0 0 {H:.2f} 0 0 cm /Im0 Do Q\n'
        if ocr:
            content += 'BT 3 Tr /F1 9 Tf\n'
            for (x, y, text) in ocr[i]:
                content += f'1 0 0 1 {x:.2f} {y:.2f} Tm ({text}) Tj\n'
            content += 'ET\n'
        c_id = pdf.add(stream(b'<<', content.encode('latin1')))
        rot = f' /Rotate {rotate}' if rotate else ''
        pid = pdf.add(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W:.2f} {H:.2f}]{rot} /Resources << /XObject << /Im0 {img_id} 0 R >> /Font << /F1 {font_id} 0 R >> >> /Contents {c_id} 0 R >>'.encode())
        page_ids.append(pid)
    pdf.objs[1] = f'<< /Type /Pages /Kids [{" ".join(f"{p} 0 R" for p in page_ids)}] /Count {len(page_ids)} >>'.encode()
    pdf.write(path, page_ids, seed)

def b4():
    return int(round(364 * MM)), int(round(257 * MM))

def spread_scans():
    """A5 の本の見開き 4 枚(ページ 16-17, 18-19, 20-21, 22-23)。本の置き方を少しずつ変える"""
    SW, SH = b4()
    pw, ph = int(round(148 * MM)), int(round(210 * MM))
    scans, ocr = [], []
    placements = [(70, 60), (95, 72), (60, 88), (82, 66)]
    for k in range(4):
        left_no, right_no = 16 + 2 * k, 17 + 2 * k
        scan = Image.new('L', (SW, SH), 250)  # 原稿台のふた(わずかに灰色)
        dx, dy = placements[k]
        left = draw_page(pw, ph, left_no, body=(k != 1))
        right = draw_page(pw, ph, right_no, body=True)
        scan.paste(left, (dx, dy)); scan.paste(right, (dx + pw, dy))
        d = ImageDraw.Draw(scan)
        gx = dx + pw
        # ノドの影(中央が暗い)
        for i, v in enumerate([200, 150, 110, 150, 200]):
            d.line([(gx - 2 + i, dy), (gx - 2 + i, dy + ph)], fill=v)
        # 本の縁(外側に重なった紙の縁の線)
        for j in range(4):
            d.line([(dx - 3 - 3 * j, dy + 4 + j), (dx - 3 - 3 * j, dy + ph - 4 - j)], fill=170 + 15 * j)
            d.line([(dx + 2 * pw + 3 + 3 * j, dy + 4 + j), (dx + 2 * pw + 3 + 3 * j, dy + ph - 4 - j)], fill=170 + 15 * j)
        # 本の上下の影
        d.line([(dx, dy - 2), (dx + 2 * pw, dy - 2)], fill=190)
        d.line([(dx, dy + ph + 2), (dx + 2 * pw, dy + ph + 2)], fill=185)
        # ふたの外側の黒い影(左上の角)
        d.rectangle([0, 0, 120, 14], fill=20)
        d.rectangle([0, 0, 10, 160], fill=25)
        # ごみ
        for _ in range(12):
            x, y = random.randint(0, SW - 1), random.randint(0, SH - 1)
            r = random.choice([1, 1, 2])
            d.ellipse([x, y, x + r, y + r], fill=random.randint(30, 120))
        scan = scan.filter(ImageFilter.GaussianBlur(0.4))
        scans.append(scan)
        # OCR の文字(ページごとに、そのページの位置に)
        pt = 72 / DPI
        H_pt = SH * pt
        items = []
        for (no, ox) in ((left_no, dx), (right_no, dx + pw)):
            for line in range(3):
                x = (ox + 16 * MM) * pt
                y = H_pt - (dy + 40 * MM + line * 7 * MM) * pt
                items.append((x, y, f'OCR-P{no}-L{line + 1}'))
        ocr.append(items)
    return scans, ocr

def booklet_scans(N=16):
    """B5 の中綴じの冊子(N ページ)をばらして、外側の紙から両面スキャンしたもの"""
    SW, SH = b4()
    pw = SW // 2
    pages = {}
    for n in range(1, N + 1):
        if n == 1:
            im = draw_page(pw, SH, '', title='見本の冊子(表紙)', body=False)
        elif n == N:
            im = draw_page(pw, SH, '', title='裏表紙', body=False)
        else:
            im = draw_page(pw, SH, n - 1, body=(n != 2))
        d = ImageDraw.Draw(im)
        d.text((pw - int(30 * MM), int(6 * MM)), f'p.{n}', font=font(int(6 * MM), True), fill=0)
        pages[n] = im
    scans, ocr = [], []
    pt = 72 / DPI
    for s in range(N // 4):
        for side in ('outer', 'inner'):
            if side == 'outer':
                L, R = N - 2 * s, 2 * s + 1
            else:
                L, R = 2 * s + 2, N - 2 * s - 1
            scan = Image.new('L', (SW, SH), 255)
            scan.paste(pages[L], (0, 0)); scan.paste(pages[R], (pw, 0))
            scans.append(scan.filter(ImageFilter.GaussianBlur(0.3)))
            items = []
            for (no, ox) in ((L, 0), (R, pw)):
                items.append(((ox + 20 * MM) * pt, (SH - 30 * MM) * pt, f'BOOKLET-PAGE-{no}'))
            ocr.append(items)
    return scans, ocr

if __name__ == '__main__':
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    SW, SH = b4()
    size = (364 * 72 / 25.4, 257 * 72 / 25.4)
    scans, ocr = spread_scans()
    build(os.path.join(out, 'scan-spread.pdf'), scans, size, 'scan-spread', ocr=ocr)
    bscans, bocr = booklet_scans()
    build(os.path.join(out, 'scan-booklet.pdf'), bscans, size, 'scan-booklet', ocr=bocr)
    # 回転つき: 画像を左に 90° 回して縦長のページに置き、/Rotate 90 で横長に見せる
    rot = [im.rotate(90, expand=True) for im in scans[:2]]
    build(os.path.join(out, 'scan-rotated.pdf'), rot, (size[1], size[0]), 'scan-rotated', rotate=90)
    for n in ('scan-spread.pdf', 'scan-booklet.pdf', 'scan-rotated.pdf'):
        print(n, os.path.getsize(os.path.join(out, n)))
