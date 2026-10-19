// 0.6.1(横に置いてスキャンした見開き・傾き補正の見つけやすさ)の試験
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BASE, PDFS, Results, assert, eq, launch, openViewer, setSettings, sleep } from './lib.mjs';
import { findSkew, textStartScore } from '../../src/viewer/scan/scan-analysis.js';

const R = new Results('Phase 12 (0.6.1)');
const env = await launch({ width: 1400, height: 950 });
const { ctx, sw } = env;
const errors = [];
const watch = page => {
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 200)}`));
  return page;
};
const open = async src => watch(await openViewer(ctx, `${BASE}${src}`));
const clearChoices = () => sw.evaluate(() => chrome.storage.local.remove('scanChoices'));
const waitState = (page, st, timeout = 90000) => page.waitForFunction(s => window.__seihonViewer.scanArranger.state === s, st, { timeout });
const arranged = page => page.evaluate(() => window.__seihonViewer.scanArranger.arranged?.pages.map(p => ({ s: p.scan, h: p.half, rot: p.rotate, t: p.turn, a: p.angle || 0 })));
const bytesOf = async (page, name) => {
  const b64 = await page.evaluate(async () => {
    const d = await window.__seihonViewer.app.pdfDocument.getData();
    let s = '';
    for (let i = 0; i < d.length; i += 0x8000) {
      s += String.fromCharCode(...d.subarray(i, i + 0x8000));
    }
    return btoa(s);
  });
  const file = path.join(env.downloadsDir, name);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
};
function parsePgm(buf) {
  const m = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(buf.subarray(0, 64).toString('latin1'));
  return { width: +m[1], height: +m[2], gray: new Uint8Array(buf.subarray(m[0].length)), head: m[0].length };
}
/** 出来上がったページを読み込む(灰色。長辺 1100 画素) */
const render = (file, i) => {
  const root = path.join(env.downloadsDir, `r-${path.basename(file)}-${i}`);
  execFileSync('pdftoppm', ['-gray', '-scale-to', '1100', '-singlefile', '-f', String(i), '-l', String(i), file, root]);
  const im = parsePgm(fs.readFileSync(`${root}.pgm`));
  const buf = fs.readFileSync(`${root}.pgm`);
  im.gray = new Uint8Array(buf.subarray(im.head));
  return im;
};
const pageSize = (file, i) => {
  const t = execFileSync('pdfinfo', ['-f', String(i), '-l', String(i), file]).toString();
  const m = /Page\s+\d+ size:\s+([\d.]+) x ([\d.]+)/.exec(t);
  const r = /Page\s+\d+ rot:\s+(\d+)/.exec(t);
  const rot = r ? Number(r[1]) : 0;
  // 回転(/Rotate)を入れた、見える向きの大きさ
  return rot === 90 || rot === 270 ? [Number(m[2]), Number(m[1])] : [Number(m[1]), Number(m[2])];
};
/** ページの文字・図の範囲から、四辺の余白(mm) */
const margins = (im, mmPerPx) => {
  let x0 = im.width, x1 = -1, y0 = im.height, y1 = -1;
  for (let y = 0; y < im.height; y++) {
    for (let x = 0; x < im.width; x++) {
      if (im.gray[y * im.width + x] < 110) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
  }
  return { left: x0 * mmPerPx, right: (im.width - 1 - x1) * mmPerPx, top: y0 * mmPerPx, bottom: (im.height - 1 - y1) * mmPerPx };
};

await setSettings(sw, { scanDeskew: 'auto', scanArrange: 'auto', scanDirection: 'ltr' });

for (const name of ['side-a', 'side-b']) {
  await R.run(`T-${name}`, `${name}: 見開きを横に置いてスキャンした縦長のページ。開くと自動で、回して左右のページに分け、余白を除き、傾きも直す`, async () => {
    await clearChoices();
    const page = await open(`/files/${name}.pdf`);
    await waitState(page, 'arranged');
    eq(await page.evaluate(() => window.__seihonViewer.scanArranger.kind), 'turned', '種類');
    const pages = await arranged(page);
    eq(pages.map(p => [p.h, p.rot, p.t]), [['L', 90, 'cw'], ['R', 90, 'cw']], '左のページが先・時計回りに回す');
    assert(Math.max(Math.abs(pages[0].a), Math.abs(pages[1].a)) >= 0.2, `傾きも直す: ${pages[0].a}, ${pages[1].a}`);
    const file = await bytesOf(page, `${name}-out.pdf`);
    const [w1, h1] = pageSize(file, 1);
    const [w2, h2] = pageSize(file, 2);
    assert(h1 > w1 && h2 > w2, `縦長のページ: ${w1}x${h1}`);
    assert(Math.abs(w1 - w2) < 1 && Math.abs(h1 - h2) < 1, '2ページが同じ大きさ');
    const out = [];
    for (const i of [1, 2]) {
      const im = render(file, i);
      im.pxPerMm = im.height / (Math.max(...pageSize(file, i)) / 72 * 25.4);
      // 上下左右が正しい向き(文字の行の書き出しがそろう側が左)
      const st = textStartScore(im, [[0, 0, im.width, im.height]]);
      assert((i === 2 || st.score > 0.03) && st.bands >= 10, `ページ ${i} の向き: ${JSON.stringify(st)}`);
      // 文字の傾き
      const sk = findSkew(im);
      assert(Math.abs(sk.angle) < 0.6, `ページ ${i} の傾き: ${sk.angle}`);
      // 余白: 上下と外側は 2〜16mm(切り取れていて、中身も切れていない)
      const mg = margins(im, 1 / im.pxPerMm);
      const outer = i === 1 ? mg.left : mg.right;
      for (const [k, v] of [['上', mg.top], ['下', mg.bottom], ['外側', outer]]) {
        assert(v >= 1.5 && v <= 16, `ページ ${i} の${k}の余白 ${v.toFixed(1)}mm`);
      }
      out.push(`${mg.top.toFixed(0)}/${mg.bottom.toFixed(0)}/${outer.toFixed(0)}`);
    }
    await page.close();
    return `余白(上/下/外側 mm) ${out.join(' , ')}`;
  });
}

await R.run('T3', '国語の見開きを横に置いたもの(時計回り・反時計回り、縦書き・横書き): 回す向きを文字の向きから決め、12ページに分ける', async () => {
  const res = [];
  for (const [name, turn] of [['turned-cw', 'ccw'], ['turned-ccw', 'cw']]) {
    await clearChoices();
    const page = await open(`/files/${name}.pdf`);
    await waitState(page, 'arranged');
    const pages = await arranged(page);
    eq(pages.length, 12, `${name} のページ数`);
    assert(pages.every(p => p.t === turn), `${name}: ${[...new Set(pages.map(p => p.t))]} ≠ ${turn}`);
    eq(pages[0].rot, turn === 'cw' ? 90 : 270, '回す角度');
    // 国語の見開きは、元の PDF と同じに分かれる(1ページ目の大きさ)
    const file = await bytesOf(page, `${name}-out.pdf`);
    const [w, h] = pageSize(file, 1);
    assert(h > w, `縦長: ${w}x${h}`);
    await page.close();
    res.push(`${name}→${turn}`);
  }
  return res.join(', ');
});

await R.run('T4', 'ふつうの縦長のスキャン・文字の PDF は、横置きの見開きと間違えない(傾いたスキャンは「傾きを直す」のまま)', async () => {
  await clearChoices();
  let page = await open('/files/skew-portrait.pdf');
  await waitState(page, 'suggest', 60000);
  eq(await page.evaluate(() => window.__seihonViewer.scanArranger.kind), 'skewed', '傾いたスキャン');
  await page.close();
  for (const f of ['ocr-sample.pdf', 'book-8.pdf']) {
    page = await open(`/files/${f}`);
    await sleep(4000);
    assert((await page.evaluate(() => window.__seihonViewer.scanArranger.state)) === 'none', `${f}: ボタンが出た`);
    await page.close();
  }
});

await R.run('T5', '「スキャンを整える」の画面: 横置きの見開きは「ページの向き」を選べる。反対を選ぶと上下逆さまの 270°、覚える', async () => {
  await clearChoices();
  await setSettings(sw, { scanArrange: 'ask' });
  const page = await open('/files/side-a.pdf');
  await waitState(page, 'suggest', 60000);
  eq(await page.evaluate(() => window.__seihonViewer.scanArranger.kind), 'turned', '種類(聞くだけ)');
  await page.evaluate(() => window.__seihonViewer.scanArranger.openDialog());
  await page.waitForFunction(() => !document.getElementById('shScanApply').disabled && document.querySelectorAll('#shScanPreview canvas').length === 2, null, { timeout: 60000 });
  eq(await page.evaluate(() => document.querySelector('input[name="shScanMode"]:checked').value), 'spread', '初めの選び方');
  assert(await page.evaluate(() => !document.getElementById('shScanTurnRow').hidden), '向きの欄');
  assert(await page.evaluate(() => !document.querySelector('input[name="shScanMode"][value="spread"]').disabled), '分割を選べる');
  assert(await page.evaluate(() => document.querySelector('input[name="shScanMode"][value="booklet"]').disabled), '並べ替えは選べない');
  await page.check('input[name="shScanTurn"][value="ccw"]');
  await sleep(300);
  await page.click('#shScanApply');
  await waitState(page, 'arranged', 60000);
  eq((await arranged(page)).map(p => p.rot), [270, 270], '反対に回す');
  eq(await page.evaluate(() => window.__seihonViewer.scanArranger.arranged.options.turn), 'ccw', '覚える向き');
  await page.close();
  // 開き直すと、選んだ向きで表示する
  await setSettings(sw, { scanArrange: 'auto' });
  const again = await open('/files/side-a.pdf');
  await waitState(again, 'arranged', 60000);
  eq((await arranged(again)).map(p => p.rot), [270, 270], '覚えた向き');
  await again.close();
});

await R.run('T6', '保存: 回して分けた PDF の画像は元と同じデータ(作り直していない)', async () => {
  const src = path.join(PDFS, 'side-b.pdf');
  const out = path.join(env.downloadsDir, 'side-b-out.pdf');
  const list = f => execFileSync('pdfimages', ['-list', f]).toString().split('\n').slice(2).filter(Boolean).map(l => l.trim().split(/\s+/));
  const a = list(out);
  const b = list(src);
  assert(a.length >= 1 && a[0][3] === b[0][3] && a[0][4] === b[0][4] && a[0][8] === b[0][8], `${JSON.stringify(a[0])} / ${JSON.stringify(b[0])}`);
});

await R.run('T7', 'OCR の文字つきの重いスキャン(縦長)でも、傾きを見つけて知らせる(1ページが軽い文字だけの PDF は調べない)', async () => {
  // skew-portrait は文字なし。ここでは、文字の層を足したコピーで確かめる
  const src = path.join(PDFS, 'skew-portrait.pdf');
  const dst = path.join(PDFS, 'skew-portrait-ocr.pdf');
  execFileSync('python3', ['-I', '-c', `
import pikepdf
pdf = pikepdf.open(${JSON.stringify(src)})
for p in pdf.pages:
    font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    p.Resources.Font = pikepdf.Dictionary(F1=font)
    p.contents_add(pdf.make_stream(b"BT 3 Tr /F1 12 Tf 100 800 Td (OCR text layer for the scan) Tj ET"), prepend=False)
pdf.save(${JSON.stringify(dst)})
`]);
  await clearChoices();
  const page = await open('/files/skew-portrait-ocr.pdf');
  await waitState(page, 'suggest', 60000);
  eq(await page.evaluate(() => window.__seihonViewer.scanArranger.kind), 'skewed', '種類');
  await page.close();
});

await R.run('T8', 'エラーが出ていない', async () => {
  assert(!errors.length, errors.slice(0, 5).join('\n'));
});

R.summary();
await env.close?.();
process.exit(0);
