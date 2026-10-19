// 0.6(傾き補正)の試験
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BASE, EXT_ID, PDFS, Results, assert, eq, getSettings, launch, openViewer, setSettings, sleep, waitToast } from './lib.mjs';
import { findSkew } from '../../src/viewer/scan/scan-analysis.js';

const R = new Results('Phase 11 (0.6)');
const env = await launch({ width: 1400, height: 950 });
const { ctx, sw } = env;
const errors = [];
const OPTIONS = `chrome-extension://${EXT_ID}/options/options.html`;
const watch = page => {
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error') {
      errors.push(`console: ${m.text().slice(0, 200)}`);
    }
  });
  return page;
};
const open = async src => watch(await openViewer(ctx, `${BASE}${src}`));
const clearChoices = () => sw.evaluate(() => chrome.storage.local.remove('scanChoices'));
const state = page => page.evaluate(() => window.__seihonViewer.scanArranger.state);
const waitState = (page, st, timeout = 60000) => page.waitForFunction(s => window.__seihonViewer.scanArranger.state === s, st, { timeout });
const angles = page => page.evaluate(() => window.__seihonViewer.scanArranger.arranged?.pages.map(p => p.angle || 0));
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
  const head = buf.subarray(0, 64).toString('latin1');
  const m = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(head);
  if (!m) {
    throw new Error('PGM を読めませんでした');
  }
  return { width: +m[1], height: +m[2], gray: new Uint8Array(buf.subarray(m[0].length)) };
}
/** 出来上がった PDF の各ページに残っている傾き(度) */
const residual = (file, n) => {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const root = path.join(env.downloadsDir, `res-${path.basename(file)}-${i}`);
    execFileSync('pdftoppm', ['-gray', '-scale-to', '1100', '-singlefile', '-f', String(i), '-l', String(i), file, root]);
    const im = parsePgm(fs.readFileSync(`${root}.pgm`));
    im.pxPerMm = Math.max(im.width, im.height) / 297;
    out.push(findSkew(im).angle);
  }
  return out;
};
const near = (a, b, tol, msg) => assert(a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol), `${msg}: ${a} ≠ ${b}(許容 ${tol})`);

await setSettings(sw, { scanDeskew: 'auto', scanArrange: 'auto' });

await R.run('S1', '縦長のスキャン(傾いている): 開くと「傾きを直す」のボタンと知らせが出る。文字のある PDF では出ない', async () => {
  await clearChoices();
  const page = await open('/files/skew-portrait.pdf');
  await waitState(page, 'suggest', 60000);
  eq(await page.evaluate(() => window.__seihonViewer.scanArranger.kind), 'skewed', '種類');
  assert((await page.textContent('#shScanLabel')).includes('傾きを直す'), 'ボタンの文字');
  await waitToast(page, /傾いたスキャン/, 5000);
  await page.close();
  const text = await open('/files/book-8.pdf');
  await sleep(2500);
  eq(await state(text), 'none', 'ふつうの文書');
  assert(await text.evaluate(() => document.getElementById('shScan').hidden), 'ボタンは出ない');
  await text.close();
});

await R.run('S2', '「まっすぐにする」: 4ページのまま、ページごとの傾き(0.65 / -1.35 / 2.15 / 0度)を直し、直したあとの傾きが 0.25° 未満', async () => {
  await clearChoices();
  const page = await open('/files/skew-portrait.pdf');
  await waitState(page, 'suggest', 60000);
  await page.evaluate(() => window.__seihonViewer.scanArranger.arrange(window.__seihonViewer.scanArranger.defaultOptions('skewed')));
  await waitState(page, 'arranged', 60000);
  const a = await angles(page);
  near(a, [0.65, -1.35, 2.15, 0], 0.3, '検出した角度');
  eq(await page.evaluate(() => window.__seihonViewer.app.pagesCount), 4, 'ページ数');
  const file = await bytesOf(page, 'straight.pdf');
  const r = residual(file, 4);
  assert(r.every(v => Math.abs(v) < 0.25), `直したあとの傾き: ${r}`);
  const before = residual(path.join(PDFS, 'skew-portrait.pdf'), 4);
  assert(Math.abs(before[1]) > 1 || Math.abs(before[2]) > 1, `元の傾き: ${before}`);
  await page.close();
  return `${a} → ${r}(元 ${before})`;
});

await R.run('S3', '画質は元のまま: 直した PDF の画像は元と同じデータ(作り直していない)で、ページの大きさも同じ', async () => {
  const file = path.join(env.downloadsDir, 'straight.pdf');
  const src = path.join(PDFS, 'skew-portrait.pdf');
  const list = f => execFileSync('pdfimages', ['-list', f]).toString().split('\n').slice(2).filter(Boolean).map(l => l.trim().split(/\s+/));
  const a = list(file);
  const b = list(src);
  eq(a.length, b.length, '画像の数');
  assert(a.every((r, i) => r[3] === b[i][3] && r[4] === b[i][4] && r[8] === b[i][8]), `画像: ${JSON.stringify(a[0])} / ${JSON.stringify(b[0])}`);
  const size = f => execFileSync('pdfinfo', ['-f', '1', '-l', '1', f]).toString().match(/Page\s+1 size:\s+(.*)/)[1];
  eq(size(file), size(src), 'ページの大きさ');
});

await R.run('S4', 'まっすぐにしたことを覚える: 開き直すと自動で直して表示。「元に戻す」で元に戻り、覚える(次は直さない)', async () => {
  await clearChoices();
  let page = await open('/files/skew-portrait.pdf');
  await waitState(page, 'suggest', 60000);
  await page.evaluate(() => window.__seihonViewer.scanArranger.arrange(window.__seihonViewer.scanArranger.defaultOptions('skewed'), { remember: true }));
  await waitState(page, 'arranged', 60000);
  await page.close();
  page = await open('/files/skew-portrait.pdf');
  await waitState(page, 'arranged', 60000);
  assert((await angles(page)).some(v => Math.abs(v) > 1), '自動で直した');
  await page.evaluate(() => window.__seihonViewer.scanArranger.restore({ remember: true }));
  await page.waitForFunction(() => window.__seihonViewer.scanArranger.state !== 'arranged' && window.__seihonViewer.scanArranger.state !== 'busy', null, { timeout: 30000 });
  await page.close();
  page = await open('/files/skew-portrait.pdf');
  await sleep(4000);
  assert((await state(page)) !== 'arranged', '元に戻したら、次は直さない');
  await page.close();
});

await R.run('S5', '見開きのスキャン(傾いている): 分けるときに傾きも直し、まっすぐなスキャンと同じ程度になる。設定「自動では直さない」なら直さない', async () => {
  await clearChoices();
  await setSettings(sw, { scanDirection: 'rtl' });
  // 基準: まっすぐなスキャンを分けたものの、ページの傾き(切り取った半分のページは、もともと 0.7° ほどの揺れで測れる)
  let page = await open('/files/kokugo2018.pdf');
  await waitState(page, 'arranged', 90000);
  const baseline = residual(await bytesOf(page, 'spread-base.pdf'), 12);
  await page.close();
  await clearChoices();
  page = await open('/files/skew-kokugo.pdf');
  await waitState(page, 'arranged', 90000);
  const a = await angles(page);
  eq(a.length, 12, 'ページ数');
  near(a.filter((_, i) => i % 2 === 0).slice(0, 3), [-1.5, 1.0, -0.7], 0.35, '最初の3枚の角度');
  const r = residual(await bytesOf(page, 'spread-straight.pdf'), 12);
  near(r, baseline, 0.5, '直したあとの傾き(まっすぐなスキャンとの差)');
  await page.close();
  await clearChoices();
  await setSettings(sw, { scanDeskew: 'off' });
  page = await open('/files/skew-kokugo.pdf');
  await waitState(page, 'arranged', 90000);
  assert((await angles(page)).every(v => v === 0), '直さない');
  const off = residual(await bytesOf(page, 'spread-off.pdf'), 12);
  assert(off.filter(v => Math.abs(v) >= 1).length >= 4, `直さないときの傾き: ${off}`);
  await page.close();
  await setSettings(sw, { scanDeskew: 'auto', scanDirection: 'binding' });
  return `直した ${r.map(v => v.toFixed(1))} / 基準 ${baseline.map(v => v.toFixed(1))} / 直さない ${off.map(v => v.toFixed(1))}`;
});

await R.run('S6', '国語の見開き(ほぼまっすぐ): ページごとの小さな傾きを直す。実際に約0.65°傾いている6見開き目のページを検出する', async () => {
  await clearChoices();
  const page = await open('/files/kokugo2018.pdf');
  await waitState(page, 'arranged', 90000);
  const a = await angles(page);
  eq(a.length, 12, 'ページ数');
  assert(a.every(v => Math.abs(v) < 1), `角度: ${a}`);
  assert(a.some(v => v >= 0.5 && v <= 0.9), `0.65° のページを直す: ${a}`);
  const r6 = residual(await bytesOf(page, 'kokugo-s6.pdf'), 12);
  const k = a.findIndex(v => v >= 0.5 && v <= 0.9);
  assert(Math.abs(r6[k]) < 0.35, `直したあとの傾き(ページ ${k + 1}): ${r6[k]}(直す前 約0.65°) / ${r6.map(v => v.toFixed(2))}`);
  await page.close();
});

await R.run('S7', '「スキャンを整える」の画面: 「傾きだけを直す」と角度の指定。縦長の PDF では分割・並べ替えは選べない', async () => {
  await clearChoices();
  const page = await open('/files/skew-portrait.pdf');
  await waitState(page, 'suggest', 60000);
  await page.evaluate(() => window.__seihonViewer.scanArranger.openDialog());
  await page.waitForFunction(() => !document.getElementById('shScanApply').disabled, null, { timeout: 60000 });
  eq(await page.evaluate(() => document.querySelector('input[name="shScanMode"]:checked').value), 'straighten', '初めの選び方');
  assert(await page.evaluate(() => document.querySelector('input[name="shScanMode"][value="spread"]').disabled), '分割は選べない');
  assert(await page.evaluate(() => !document.getElementById('shScanStraightenOptions').hidden), '角度の欄');
  assert((await page.textContent('#shScanSkewInfo')).includes('4ページ中'), `検出のまとめ: ${await page.textContent('#shScanSkewInfo')}`);
  const nThumbs = await page.$$eval('#shScanPreview canvas', c => c.length);
  eq(nThumbs, 4, 'プレビュー');
  await page.fill('#shScanAngle', '1');
  await page.dispatchEvent('#shScanAngle', 'change');
  await sleep(400);
  await page.click('#shScanApply');
  await waitState(page, 'arranged', 60000);
  eq(await angles(page), [1, 1, 1, 1], '指定した角度');
  eq(await page.evaluate(() => window.__seihonViewer.scanArranger.arranged.options.angle), 1, '覚える角度');
  await page.close();
});

await R.run('S8', '縦長の文字の PDF でも、メニューの「傾きだけを直す」から直せる(傾きが無ければ、その旨を知らせる)', async () => {
  await clearChoices();
  const page = await open('/files/book-8.pdf');
  await sleep(1500);
  const r = await page.evaluate(async () => {
    const a = window.__seihonViewer.scanArranger;
    const ok = await a.arrange({ mode: 'straighten' });
    return { ok, state: a.state };
  });
  eq(r.ok, false, '直すところが無い');
  await waitToast(page, /傾いているページが見つかりませんでした/, 15000);
  await page.close();
});

await R.run('S9', '詳細設定: 「傾き」(自動で直す / 直さない)を保存できる', async () => {
  const page = watch(await ctx.newPage());
  await page.goto(`${OPTIONS}#pages`);
  await sleep(400);
  await page.check('input[name="scanDeskew"][value="off"]');
  await sleep(300);
  eq((await getSettings(sw)).scanDeskew, 'off', '保存');
  await page.check('input[name="scanDeskew"][value="auto"]');
  await sleep(300);
  eq((await getSettings(sw)).scanDeskew, 'auto', '戻す');
  await page.close();
});

await R.run('S10', 'エラーが出ていない', async () => {
  assert(!errors.length, errors.slice(0, 5).join('\n'));
});

R.summary();
await env.close?.();
process.exit(0);
