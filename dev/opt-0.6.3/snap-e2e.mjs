// 拡張機能でスキャンを整えた結果(整えた PDF の中身と、ページの計画)を保存する(段階2の前後の比較用)
//   node snap-e2e.mjs <出力フォルダ>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BASE, launch, openViewer, setSettings, sleep } from '../tests/lib.mjs';

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const env = await launch({ width: 1400, height: 950 });
const { ctx, sw } = env;
await setSettings(sw, { scanDeskew: 'auto', scanArrange: 'auto', scanDirection: 'binding', bindingDirection: 'ltr' });

const cases = [
  ['/files/kokugo2018.pdf', null],
  ['/files/skew-kokugo.pdf', null],
  ['/files/side-a.pdf', null],
  ['/files/side-b.pdf', null],
  ['/files/turned-cw.pdf', null],
  ['/files/turned-ccw.pdf', null],
  ['/files/skew-portrait.pdf', 'skewed'],
  ['/files/scan1.pdf', null],
  ['/files/scan2.pdf', null],
  ['/files/scan3.pdf', null],
  ['/pdf/scan-spread.pdf', null],
  ['/pdf/scan-booklet.pdf', 'sheets'],
  ['/pdf/scan-rotated.pdf', null],
  ['/pdf/scan-ocr.pdf', null],
];
const summary = {};
for (const [src, kind] of cases) {
  await sw.evaluate(() => chrome.storage.local.remove('scanChoices'));
  const page = await openViewer(ctx, `${BASE}${src}`);
  const name = path.basename(src, '.pdf');
  try {
    // 開いたときの自動の整え(調べ終えて、整えるか案内するか)が終わるまで待つ
    await page.waitForFunction(() => window.__seihonViewer.scanArranger.state === 'arranged', null, { timeout: 45000 }).catch(() => {});
    await page.waitForFunction(() => window.__seihonViewer.scanArranger.state !== 'busy', null, { timeout: 120000 });
    await sleep(1500);
    let st = await page.evaluate(() => window.__seihonViewer.scanArranger.state);
    if (st !== 'arranged') {
      await page.evaluate(k => {
        const a = window.__seihonViewer.scanArranger;
        return a.arrange(a.defaultOptions(k || undefined));
      }, kind);
      await page.waitForFunction(() => window.__seihonViewer.scanArranger.state === 'arranged', null, { timeout: 120000 }).catch(() => {});
      st = await page.evaluate(() => window.__seihonViewer.scanArranger.state);
    }
    const info = await page.evaluate(async () => {
      const a = window.__seihonViewer.scanArranger;
      const round = v => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);
      const pages = a.arranged?.pages.map(p => ({
        scan: p.scan, half: p.half, rotate: p.rotate, turn: p.turn || null, angle: round(p.angle || 0),
        rect: p.rect?.map(round) || null, matrix: p.matrix?.map(round) || null, masks: p.masks.map(m => m.map(round)),
      })) || null;
      let b64 = null;
      if (a.isArranged) {
        const d = await a.app.pdfDocument.getData();
        let s = '';
        for (let i = 0; i < d.length; i += 0x8000) {
          s += String.fromCharCode(...d.subarray(i, i + 0x8000));
        }
        b64 = btoa(s);
      }
      return { state: a.state, kind: a.kind, options: a.arranged?.options || null, pages, b64 };
    });
    const bytes = info.b64 ? Buffer.from(info.b64, 'base64') : null;
    if (bytes) {
      fs.writeFileSync(path.join(out, `${name}.pdf`), bytes);
    }
    delete info.b64;
    info.md5 = bytes ? crypto.createHash('md5').update(bytes).digest('hex') : null;
    fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(info, null, 1));
    summary[name] = `${info.state}/${info.kind}/${info.pages?.length ?? '-'} ${info.md5 || ''}`;
    console.log(name, summary[name]);
  } catch (e) {
    console.log(name, 'ERROR', e.message);
    summary[name] = `ERROR ${e.message}`;
  }
  await page.close();
}
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
await env.close();
process.exit(0);
