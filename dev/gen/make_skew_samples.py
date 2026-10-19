"""
傾き補正(0.6)の確認用 PDF を作る(開発用)。使い方: python3 make_skew_samples.py <出力フォルダ> <縦長の1ページの画像> <見開きのスキャンの PDF>

  skew-portrait.pdf  縦長のスキャン 4 ページ(画像の傾き: 元のまま・さらに時計回り 2.0°・反時計回り 1.5°・まっすぐ)
  skew-kokugo.pdf    見開きのスキャン 6 ページを、1.5 / -1.0 / 0.7 / 2.0 / -1.8 / 0 度回したもの
"""
import io, os, subprocess, sys, tempfile
import img2pdf
from PIL import Image

out, page_png, spread_pdf = sys.argv[1:4]
os.makedirs(out, exist_ok=True)

def jpeg(im):
    b = io.BytesIO()
    im.convert('RGB').save(b, 'JPEG', quality=88)
    return b.getvalue()

def rot(im, deg):
    # PIL は反時計回りが正。ここでは時計回りを正にする
    return im.rotate(-deg, resample=Image.BICUBIC, fillcolor=(255, 255, 255))

base = Image.open(page_png).convert('RGB')
base = base.resize((1500, round(base.height * 1500 / base.width)), Image.LANCZOS)
straight = rot(base, 0.65)
pages = [base, rot(base, 2.0), rot(base, -1.5), straight]
layout = img2pdf.get_fixed_dpi_layout_fun((150, 150))
with open(os.path.join(out, 'skew-portrait.pdf'), 'wb') as f:
    f.write(img2pdf.convert([jpeg(p) for p in pages], layout_fun=layout))

tmp = tempfile.mkdtemp(prefix='skew-', dir='/tmp')
subprocess.run(['pdfimages', '-j', spread_pdf, os.path.join(tmp, 'k')], check=True)
files = sorted(f for f in os.listdir(tmp) if f.endswith('.jpg'))
angles = [1.5, -1.0, 0.7, 2.0, -1.8, 0.0]
imgs = []
for f, a in zip(files, angles):
    im = Image.open(os.path.join(tmp, f)).convert('RGB')
    imgs.append(jpeg(rot(im, a) if a else im))
with open(os.path.join(out, 'skew-kokugo.pdf'), 'wb') as f:
    f.write(img2pdf.convert(imgs, layout_fun=layout))
print('ok', len(pages), len(imgs))

# 見開きを横に置いてスキャンしたもの(国語の見開き 6 枚を 90° 回して縦長のページにする)
#   turned-cw.pdf  : 時計回りに回して置いた(元に戻すには反時計回り)  turned-ccw.pdf: 反時計回りに回して置いた
for name, deg in (('turned-cw', -90), ('turned-ccw', 90)):
    imgs = []
    for f in files:
        im = Image.open(os.path.join(tmp, f)).convert('RGB')
        imgs.append(jpeg(im.rotate(deg, expand=True)))
    with open(os.path.join(out, name + '.pdf'), 'wb') as fh:
        fh.write(img2pdf.convert(imgs, layout_fun=layout))
print('turned ok')
