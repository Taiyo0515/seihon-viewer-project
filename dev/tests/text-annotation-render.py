"""PDF.jsと独立したPDFiumで、保存した文字注釈の外観と枠線を確認する。"""
from pathlib import Path
from pypdf import PdfReader
import pypdfium2 as pdfium
from PIL import Image, ImageChops
import numpy as np
import json
root=Path(__file__).resolve().parents[1]
out=root/'logs/text-annotation'
checks=[]
for filename in ['first-save.pdf','second-save.pdf','third-save.pdf','narrow-save.pdf']:
 r=PdfReader(out/filename);doc=pdfium.PdfDocument(out/filename)
 for i,p in enumerate(r.pages):
  a=p['/Annots'][0].get_object();ap=a['/AP']['/N'].get_object()
  assert a.get('/SeihonFreeTextVersion'), (filename,i,'appearance marker absent')
  fontlist=ap['/Resources']['/Font'].get_object()
  assert any(f.get_object().get('/ToUnicode') for f in fontlist.values()),(filename,i,'Unicode mapping absent')
  assert not b' re S' in ap.get_data(), (filename,i,'unexpected border stroke')
  scale=4/3;page=doc[i];img=page.render(scale=scale,draw_annots=True).to_pil().convert('RGB');img.save(out/f'pdfium-{filename[:-4]}-p{i+1}.png')
  x0,y0,x1,y1=map(float,a['/Rect']);h=float(p.mediabox.height)
  box=(max(0,int(x0*scale)-3),max(0,int((h-y1)*scale)-3),min(img.width,int(x1*scale)+4),min(img.height,int((h-y0)*scale)+4))
  mask=np.asarray(img.crop(box).convert('L'))<150
  assert mask.sum()>50,(filename,i,'no visible annotation glyphs')
  assert mask.any(axis=0).sum()>15,(filename,i,'annotation is too narrow')
  if filename=='first-save.pdf' and i==0:
   ref=Image.open(out/'pdfjs-reopened-p1.png').convert('RGB').crop(box)
   browser=np.asarray(ref.convert('L'))<150
   intersection=np.logical_and(mask,browser).sum();union=np.logical_or(mask,browser).sum();iou=float(intersection/union)
   ratio=float(mask.sum()/max(1,browser.sum()))
   assert iou>.35 and .65<ratio<1.5,('PDFium/PDF.js mismatch',iou,ratio)
  else:iou=None;ratio=None
  checks.append({'file':filename,'page':i+1,'inkPixels':int(mask.sum()),'iou':iou,'inkRatio':ratio})
  page.close()
 doc.close()
(out/'cross-engine-results.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2),encoding='utf-8')
print('PASS PDFium visible glyphs, embedded Unicode appearance, no border stroke, PDF.js/PDFium pixel agreement',checks)
