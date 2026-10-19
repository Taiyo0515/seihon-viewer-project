// 0.3(スキャンの整え: 見開きの分割・余白の除去・冊子の並べ替え)の試験
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  BASE, EXT, KIOSK_PRINT, PDFS, Results, SP, assert, clearDir, eq, getSettings, launch, listFiles, openViewer, pdfImages, pdfInfo,
  pdfText, readClipboard, setSettings, sleep, waitForFile, waitToast,
} from './lib.mjs';

const R = new Results('Phase 7 (0.3)');
const env = await launch({ width: 1400, height: 900 });
const { ctx, sw } = env;
const dl = () => env.downloadsDir;
const errors = [];

const open = async (src, opts) => {
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error') {
      errors.push(`console: ${m.text().slice(0, 200)}`);
    }
  });
  return openViewer(ctx, src, { ...opts, page });
};
const scanState = page =>
  page.evaluate(() => {
    const v = window.__seihonViewer;
    const a = v.scanArranger;
    return {
      state: a.state,
      kind: a.kind,
      pages: window.PDFViewerApplication.pagesCount,
      title: document.title,
      mode: v.book.mode,
      page: window.PDFViewerApplication.page,
      chip: document.getElementById('shScan').hidden ? null : document.getElementById('shScanLabel').textContent,
    };
  });
const waitScan = async (page, want, timeout = 120000) => {
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < timeout) {
    st = await scanState(page);
    if (st.state === want && (want !== 'arranged' || st.pages > 0)) {
      return st;
    }
    await sleep(200);
  }
  throw new Error(`「${want}」になりませんでした: ${JSON.stringify(st)}`);
};
/** ページごとの文字(PDF.js の getTextContent) */
const pageTexts = page =>
  page.evaluate(async () => {
    const app = window.PDFViewerApplication;
    const out = [];
    for (let i = 1; i <= app.pagesCount; i++) {
      const p = await app.pdfDocument.getPage(i);
      const tc = await p.getTextContent();
      out.push(tc.items.map(t => t.str).join(' '));
    }
    return out;
  });
/** ページの大きさ(表示の向き。pt) */
const pageSizes = page =>
  page.evaluate(async () => {
    const app = window.PDFViewerApplication;
    const out = [];
    for (let i = 1; i <= app.pagesCount; i++) {
      const p = await app.pdfDocument.getPage(i);
      const vp = p.getViewport({ scale: 1, rotation: p.rotate });
      out.push({ w: Math.round(vp.width * 10) / 10, h: Math.round(vp.height * 10) / 10, rotate: p.rotate });
    }
    return out;
  });
const clearChoices = () => sw.evaluate(() => chrome.storage.local.remove('scanChoices'));
const choices = () => sw.evaluate(async () => (await chrome.storage.local.get('scanChoices')).scanChoices || {});
/** 保存先を選ぶ画面は試験では出せないので、chrome.downloads.download の指定を記録して、そのまま保存させる */
const interceptDownloads = page =>
  page.evaluate(() => {
    window.__dlCalls = [];
    const orig = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = opts => {
      window.__dlCalls.push({ filename: opts.filename, saveAs: opts.saveAs });
      return orig({ ...opts, saveAs: false });
    };
  });
const chipMenu = async (page, label) => {
  await page.click('#shScan');
  await page.waitForSelector('.sh-popup:not([hidden]) .sh-menu-item');
  const items = await page.$$eval('.sh-popup:not([hidden]) .sh-menu-item .sh-menu-label', els => els.map(e => e.textContent));
  if (label) {
    await page.locator('.sh-popup:not([hidden]) .sh-menu-item', { hasText: label }).first().click();
  } else {
    await page.keyboard.press('Escape');
  }
  return items;
};
const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');
/** PDF の中の JPEG を取り出して、中身の MD5 の一覧にする */
const jpegHashes = file => {
  const dir = fs.mkdtempSync(path.join(SP, 'img-'));
  execFileSync('pdfimages', ['-j', file, path.join(dir, 'x')]);
  const out = fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.jpg'))
    .map(f => md5(fs.readFileSync(path.join(dir, f))))
    .sort();
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
};
const ORIGINAL = {
  spread: path.join(EXT, 'tools/test-server/samples', 'scan-spread.pdf'),
  booklet: path.join(EXT, 'tools/test-server/samples', 'scan-booklet.pdf'),
};

await clearChoices();

// ---------------------------------------------------------------------------
// 見開きの分割
// ---------------------------------------------------------------------------
let spreadPage = null;
await R.run('K1', '本を開いてスキャンした見開きを開くと、自動で1ページずつに分かれる(見開き表示で 16|17、18|19…)', async () => {
  const t0 = Date.now();
  spreadPage = await open('/pdf/scan-spread.pdf');
  const st = await waitScan(spreadPage, 'arranged');
  eq(st.pages, 8, 'ページ数');
  eq(st.title, 'scan-spread_分割.pdf', 'タブの名前');
  eq(st.mode, 'spread', '表示モード(元の見開きと同じ組み合わせ)');
  eq(st.chip, '分割表示', 'ツールバーのボタン');
  await waitToast(spreadPage, /見開きを1ページずつに分け、余白を除いて/);
  const layout = await spreadPage.evaluate(() =>
    [...document.querySelectorAll('#viewer > .spread')].slice(0, 2).map(s => [...s.children].map(c => c.dataset.pageNumber || 'ph'))
  );
  eq(layout, [['1', '2'], ['3', '4']], '見開きの組み合わせ');
  return `${((Date.now() - t0) / 1000).toFixed(1)} 秒`;
});

await R.run('K2', '余白・影・本の縁を除いて、どのページも同じ大きさ(本のページ A5 より少し小さい)', async () => {
  const sizes = await pageSizes(spreadPage);
  const first = sizes[0];
  assert(sizes.every(s => Math.abs(s.w - first.w) < 0.5 && Math.abs(s.h - first.h) < 0.5), `大きさがそろっていない: ${JSON.stringify(sizes)}`);
  // A5 = 419.5 × 595.3 pt。中身 + 6mm の余白なので、それより小さく、スキャン(B4 の半分 = 515.9 × 728.5)よりずっと小さい
  assert(first.w < 419.5 && first.w > 300, `幅 ${first.w}`);
  assert(first.h < 595.3 && first.h > 450, `高さ ${first.h}`);
  return `${first.w} × ${first.h} pt`;
});

await R.run('K3', 'OCR の文字は、そのページのものだけが残る(検索・文字のコピーで、もう片方のページの文字を拾わない)', async () => {
  const texts = await pageTexts(spreadPage);
  const expected = [16, 17, 18, 19, 20, 21, 22, 23];
  texts.forEach((t, i) => {
    const own = `OCR-P${expected[i]}`;
    assert(t.includes(own), `${i + 1}ページ目に ${own} が無い: ${t}`);
    const others = expected.filter(n => n !== expected[i]).map(n => `OCR-P${n}`);
    for (const o of others) {
      assert(!t.includes(`${o}-`), `${i + 1}ページ目に ${o} がある: ${t}`);
    }
  });
  return texts[1];
});

await R.run('K4', '「整えた PDF を保存」: 画像は元の JPEG のまま(MD5 が同じ)、OCR の文字も残る、元のファイル名_分割.pdf', async () => {
  clearDir(dl());
  await interceptDownloads(spreadPage);
  const items = await chipMenu(spreadPage, '整えた PDF を保存');
  assert(items.some(t => t.startsWith('元のスキャンに戻す')), `メニュー: ${items}`);
  await spreadPage.waitForFunction(() => window.__pickerCalls.length > 0, null, { timeout: 15000 });
  const call = await spreadPage.evaluate(() => window.__pickerCalls[0]);
  eq([call.kind, call.suggestedName], ['file', 'scan-spread_分割.pdf'], '保存先を選ぶ画面の指定');
  const file = await waitForFile(dl(), f => /^scan-spread_分割.*\.pdf$/.test(f));
  eq(pdfInfo(file).pages, 8, 'ページ数');
  const orig = jpegHashes(ORIGINAL.spread);
  const saved = jpegHashes(file);
  eq(saved.length, 8, 'ページごとの画像の数(2ページで1枚を共有)');
  eq([...new Set(saved)], [...new Set(orig)], 'JPEG の中身(元の4枚と同じ)');
  const objs = pdfImages(file);
  eq(new Set(objs.map(o => o.enc)), new Set(['jpeg']), '画像の形式');
  const text2 = pdfText(file, 2);
  assert(text2.includes('OCR-P17-L1') && !text2.includes('OCR-P16'), `2ページ目の文字: ${text2}`);
  execFileSync('qpdf', ['--check', file]);
  return `${path.basename(file)} ${Math.round(fs.statSync(file).size / 1024)} KB(元 ${Math.round(fs.statSync(ORIGINAL.spread).size / 1024)} KB)`;
});

await R.run('K5', 'ダウンロードボタン: 「整えた PDF を保存…」「元の PDF を保存」を選べる(元の PDF は元のまま)', async () => {
  clearDir(dl());
  await spreadPage.click('#shDownload');
  await spreadPage.waitForSelector('.sh-popup:not([hidden]) .sh-menu-item');
  const items = await spreadPage.$$eval('.sh-popup:not([hidden]) .sh-menu-item .sh-menu-label', els => els.map(e => e.textContent));
  assert(items[0].startsWith('整えた PDF を保存') && items[1].startsWith('元の PDF を保存'), `メニュー: ${items}`);
  await spreadPage.locator('.sh-popup:not([hidden]) .sh-menu-item', { hasText: '元の PDF を保存' }).click();
  const file = await waitForFile(dl(), f => /^scan-spread.*\.pdf$/.test(f));
  eq(md5(fs.readFileSync(file)), md5(fs.readFileSync(ORIGINAL.spread)), '元の PDF と同じ');
  return path.basename(file);
});

await R.run('K6', '「元のスキャンに戻す」→ 4ページに戻る。次に開いたときも分けない(覚えておく)', async () => {
  await chipMenu(spreadPage, '元のスキャンに戻す');
  const st = await waitScan(spreadPage, 'suggest');
  eq(st.pages, 4, 'ページ数');
  eq(st.title, 'scan-spread.pdf', 'タブの名前');
  eq(st.chip, '見開きを分ける', 'ボタン');
  eq(st.mode, 'book', '表示モードは元に戻る');
  const c = Object.values(await choices());
  eq(c.map(x => x.mode), ['none'], '覚えた整え方');
  await spreadPage.close();
  const again = await open('/pdf/scan-spread.pdf');
  const st2 = await waitScan(again, 'suggest');
  eq(st2.pages, 4, '開き直しても分けない');
  // ボタンから分ける → 次からは自動で分ける
  await chipMenu(again, '見開きを1ページずつに分ける');
  await waitScan(again, 'arranged');
  eq((await choices()) && Object.values(await choices()).map(x => x.mode), ['spread'], '覚えた整え方');
  await again.close();
  const third = await open('/pdf/scan-spread.pdf');
  const st3 = await waitScan(third, 'arranged');
  eq(st3.pages, 8, '覚えた整え方で開く');
  spreadPage = third;
});

await R.run('K7', '綴じ方向のボタンで右綴じにすると、右のページが先に並び直す', async () => {
  await spreadPage.click('#shBindDir');
  await spreadPage.waitForFunction(() => window.__seihonViewer.scanArranger.arranged?.options.direction === 'rtl' && window.__seihonViewer.scanArranger.state === 'arranged', null, { timeout: 60000 });
  await sleep(500);
  const texts = await pageTexts(spreadPage);
  assert(texts[0].includes('OCR-P17') && texts[1].includes('OCR-P16'), `右綴じの並び: ${texts.slice(0, 2)}`);
  await spreadPage.click('#shBindDir');
  await spreadPage.waitForFunction(() => window.__seihonViewer.scanArranger.arranged?.options.direction === 'ltr' && window.__seihonViewer.scanArranger.state === 'arranged', null, { timeout: 60000 });
  return 'OK';
});

await R.run('K8', '整えた PDF でも、ページ役割・収集・コピー(最高画質は元の画像の解像度)が使える', async () => {
  // ページ役割: 1ページ目をカバーの表紙にして、開き直しても残る
  await spreadPage.evaluate(() => window.__seihonViewer.pageRoles.set([1], 'cover', { quiet: true }));
  await sleep(800);
  await spreadPage.close();
  spreadPage = await open('/pdf/scan-spread.pdf');
  await waitScan(spreadPage, 'arranged');
  await sleep(800);
  const role = await spreadPage.evaluate(async () => {
    await window.__seihonViewer.pageRoles.whenLoaded();
    return window.__seihonViewer.pageRoles.get(1);
  });
  eq(role, 'cover', '開き直した後の役割');
  // コピー: 2ページ目の画像(最高画質)は、元の画像の解像度で切り取った大きさ
  const sizes = await pageSizes(spreadPage);
  await spreadPage.evaluate(() => window.__seihonViewer.pageCopy.copySinglePage(2));
  await waitToast(spreadPage, /コピーしました/);
  const clip = await readClipboard(ctx, spreadPage);
  const img = clip.find(c => c.type === 'image/png');
  const expectW = Math.round((sizes[1].w * 1433) / 1031.81);
  assert(img && Math.abs(img.width - expectW) <= 2, `画像の幅 ${img?.width}(期待 ${expectW})`);
  // 収集: 2ページ目を収集して PDF で保存 → 切り取った大きさの1ページ、OCR の文字も残る
  clearDir(dl());
  const clearCollection = () =>
    spreadPage.evaluate(async () => {
      const db = await import(chrome.runtime.getURL('common/db.js'));
      await db.clearCollection();
      await window.__seihonViewer.collection.refresh();
    });
  await clearCollection();
  await spreadPage.evaluate(() => window.__seihonViewer.collection.addCurrentPages([2]));
  await sleep(500);
  await spreadPage.evaluate(() => window.__seihonViewer.collection.exportAll('pdf'));
  const file = await waitForFile(dl(), f => /\.pdf$/.test(f));
  const info = pdfInfo(file);
  eq(info.pages, 1, '収集の PDF のページ数');
  assert(Math.abs(info.width - sizes[1].w) < 1, `収集の PDF の幅 ${info.width}`);
  assert(pdfText(file).includes('OCR-P17-L1'), '収集の PDF の文字');
  await clearCollection();
  return `役割 OK / 画像 ${img.width}×${img.height} / 収集 ${info.width}×${info.height}`;
});

await R.run('K9', 'Chrome標準で開く: 整えた PDF を新しいタブの Chrome 標準ビューアで開く(このタブはそのまま)', async () => {
  const popup = ctx.waitForEvent('page', { timeout: 15000 });
  await spreadPage.click('#shOpenNative');
  const p = await popup;
  await p.waitForLoadState('commit').catch(() => {});
  assert(p.url().startsWith('blob:chrome-extension://'), `開いたタブ: ${p.url()}`);
  await p.close();
  eq((await scanState(spreadPage)).pages, 8, 'このタブ');
  await spreadPage.close();
  spreadPage = null;
});

// ---------------------------------------------------------------------------
// 冊子の並べ替え
// ---------------------------------------------------------------------------
let bookletPage = null;
await R.run('K10', 'ばらした冊子の両面スキャン: ツールバーに「冊子を並べ替える」が出て、押すと表紙 → 裏表紙の順(製本表示)', async () => {
  bookletPage = await open('/pdf/scan-booklet.pdf');
  const st = await waitScan(bookletPage, 'suggest');
  eq(st.kind, 'sheets', '判定');
  eq(st.chip, '冊子を並べ替える', 'ボタン');
  await waitToast(bookletPage, /並べ替えられます/);
  const items = await chipMenu(bookletPage, '冊子の順に並べ替える');
  eq(items[0], '冊子の順に並べ替える', 'メニューの先頭');
  const st2 = await waitScan(bookletPage, 'arranged');
  eq(st2.pages, 16, 'ページ数');
  eq(st2.title, 'scan-booklet_並べ替え.pdf', 'タブの名前');
  eq(st2.mode, 'book', '表示モード(製本表示のまま)');
  const texts = await pageTexts(bookletPage);
  texts.forEach((t, i) => assert(t.trim() === `BOOKLET-PAGE-${i + 1}`, `${i + 1}ページ目: ${t}`));
  return texts.slice(0, 3).join(', ');
});

await R.run('K11', '整え方のダイアログ: プレビュー(1 表紙 … 16 裏表紙)、紙の順・綴じ方向を変えると並びが変わる、「元のまま」で戻せる', async () => {
  await bookletPage.evaluate(() => window.__seihonViewer.scanDialog.open());
  await bookletPage.waitForSelector('#shScanDialog[open] #shScanPreview canvas');
  const caps = await bookletPage.$$eval('#shScanPreview figcaption', els => els.map(e => e.textContent));
  eq(caps.length, 16, 'プレビューのページ数');
  eq([caps[0], caps[15]], ['1 表紙', '16 裏表紙'], '最初と最後');
  const checked = await bookletPage.evaluate(() => document.querySelector('input[name="shScanMode"]:checked').value);
  eq(checked, 'booklet', '選ばれている整え方');
  const firstTitle = () => bookletPage.$eval('#shScanPreview figure', f => f.title);
  const t1 = await firstTitle();
  await bookletPage.check('input[name="shScanSheetOrder"][value="inner"]');
  await sleep(300);
  const t2 = await firstTitle();
  assert(t1 !== t2, `内側の紙からにしても変わらない: ${t1}`);
  await bookletPage.check('input[name="shScanSheetOrder"][value="outer"]');
  await bookletPage.check('input[name="shScanMode"][value="none"]');
  await sleep(200);
  eq(await bookletPage.$eval('#shScanApply', b => b.textContent), '元のまま表示', 'ボタン');
  await bookletPage.click('#shScanApply');
  const st = await waitScan(bookletPage, 'suggest');
  eq(st.pages, 8, '元のスキャン');
  return `${t1} → ${t2}`;
});

await R.run('K12', '覚えた整え方(冊子)で、次に開いたときは自動で並べ替える', async () => {
  await chipMenu(bookletPage, '冊子の順に並べ替える');
  await waitScan(bookletPage, 'arranged');
  await bookletPage.close();
  bookletPage = await open('/pdf/scan-booklet.pdf');
  const st = await waitScan(bookletPage, 'arranged');
  eq(st.pages, 16, 'ページ数');
  const texts = await pageTexts(bookletPage);
  eq(texts[0].trim(), 'BOOKLET-PAGE-1', '1ページ目');
  await bookletPage.close();
});

// ---------------------------------------------------------------------------
// そのほか
// ---------------------------------------------------------------------------
await R.run('K13', '回転(/Rotate 90)つきのスキャンも、正しい向きで分ける', async () => {
  const page = await open('/pdf/scan-rotated.pdf');
  const st = await waitScan(page, 'arranged');
  eq(st.pages, 4, 'ページ数');
  const sizes = await pageSizes(page);
  assert(sizes.every(s => s.rotate === 90 && s.w < s.h), `向き: ${JSON.stringify(sizes)}`);
  // 描いた画像で確かめる: 1ページ目の上の方に見出し(黒い文字)、ページの左右の端は白(本の縁が無い)
  const ink = await page.evaluate(async () => {
    const app = window.PDFViewerApplication;
    const p = await app.pdfDocument.getPage(1);
    const vp = p.getViewport({ scale: 0.5, rotation: p.rotate });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const g = c.getContext('2d');
    await p.render({ canvasContext: g, viewport: vp }).promise;
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const rowInk = y => {
      let n = 0;
      for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4] < 128) n++;
      }
      return n;
    };
    let top = -1;
    for (let y = 0; y < c.height; y++) {
      if (rowInk(y) > 3) {
        top = y;
        break;
      }
    }
    return { top: top / c.height, w: c.width, h: c.height };
  });
  assert(ink.top > 0 && ink.top < 0.15, `見出しの位置 ${JSON.stringify(ink)}`);
  await page.close();
  return JSON.stringify(sizes[0]);
});

await R.run('K14', '文字の PDF(縦長・横長)では何も起きない', async () => {
  for (const src of ['/pdf/sample.pdf', '/pdf/landscape-4.pdf']) {
    const page = await open(src);
    await sleep(3500);
    const st = await scanState(page);
    eq([st.state, st.chip], ['none', null], src);
    await page.close();
  }
});

await R.run('K15', '詳細設定「分けるか聞く」: 自動では分けず、ボタンで分けられる', async () => {
  await clearChoices();
  await setSettings(sw, { scanArrange: 'ask' });
  const page = await open('/pdf/scan-spread.pdf');
  const st = await waitScan(page, 'suggest');
  eq(st.pages, 4, '分けていない');
  await waitToast(page, /1ページずつに分けて/);
  await chipMenu(page, '見開きを1ページずつに分ける');
  eq((await waitScan(page, 'arranged')).pages, 8, 'ボタンで分けた');
  await page.close();
  await clearChoices();
});

await R.run('K16', '詳細設定「何もしない」: ボタンも出ない。⋮ メニューの「スキャンを整える…」からは使える', async () => {
  await setSettings(sw, { scanArrange: 'off' });
  const page = await open('/pdf/scan-spread.pdf');
  await sleep(3500);
  eq((await scanState(page)).state, 'none', '何もしない');
  await page.click('#shMore');
  await page.locator('.sh-popup:not([hidden]) .sh-menu-item', { hasText: 'スキャンを整える' }).click();
  await page.waitForSelector('#shScanDialog[open] #shScanPreview canvas', { timeout: 60000 });
  const mode = await page.evaluate(() => document.querySelector('input[name="shScanMode"]:checked').value);
  eq(mode, 'spread', '選ばれている整え方');
  await page.click('#shScanApply');
  eq((await waitScan(page, 'arranged')).pages, 8, 'ダイアログから分けた');
  await page.close();
  await setSettings(sw, { scanArrange: 'auto' });
  await clearChoices();
});

await R.run('K17', '詳細設定の画面: 「スキャンの整え」の欄があり、変えると保存される。覚えている整え方を消せる', async () => {
  const page = await ctx.newPage();
  // 0.5: 「スキャン・ページ操作」の「スキャンの整え」
  await page.goto(`chrome-extension://${(await sw.evaluate(() => chrome.runtime.id))}/options/options.html#sec-scan`);
  await page.waitForSelector('#sec-scan');
  await page.check('input[name="scanArrange"][value="ask"]');
  await page.uncheck('#scanTrim');
  await sleep(400);
  const s = await getSettings(sw);
  eq([s.scanArrange, s.scanTrim], ['ask', false], '保存された設定');
  await page.check('input[name="scanArrange"][value="auto"]');
  await page.check('#scanTrim');
  await sw.evaluate(() => chrome.storage.local.set({ scanChoices: { a: { mode: 'none', t: 1 }, b: { mode: 'spread', t: 2 } } }));
  await page.waitForFunction(() => /2 件/.test(document.getElementById('scanChoicesStatus').textContent));
  page.once('dialog', d => d.accept());
  await page.click('#clearScanChoices');
  await page.waitForFunction(() => /ありません/.test(document.getElementById('scanChoicesStatus').textContent));
  await page.close();
  eq(Object.keys(await choices()).length, 0, '消えた');
});

await R.run('K18', '余白を除かない設定: ノドの線だけ除いて、ノドの位置で左右に分ける(ページはスキャンの高さのまま)', async () => {
  await setSettings(sw, { scanTrim: false });
  try {
    const page = await open('/pdf/scan-spread.pdf');
    await waitScan(page, 'arranged');
    const sizes = await pageSizes(page);
    assert(sizes.every(s => Math.abs(s.h - 728.5) < 1), `高さ ${JSON.stringify(sizes)}`);
    // 左右を合わせると、スキャンの幅からノドの線の分を除いたくらい
    const sum = sizes[0].w + sizes[1].w;
    assert(sum > 1031.8 - 20 && sum < 1031.8, `幅 ${sizes[0].w} + ${sizes[1].w}`);
    await page.close();
    return `${sizes[0].w} + ${sizes[1].w} pt`;
  } finally {
    await setSettings(sw, { scanTrim: true });
    await clearChoices();
  }
});

// ---------------------------------------------------------------------------
// 印刷(最高画質)・製本用PDF出力
// ---------------------------------------------------------------------------
await R.run('K19', '製本用PDF出力: 整えた PDF から、面付けした PDF を作れる', async () => {
  clearDir(dl());
  const page = await open('/pdf/scan-spread.pdf');
  await waitScan(page, 'arranged');
  await page.click('#shBindOutput');
  await page.waitForSelector('#shBindDialog[open]');
  await page.click('#shBindRun');
  const file = await waitForFile(dl(), f => /^scan-spread_分割_製本.*\.pdf$/.test(f), 60000);
  const info = pdfInfo(file);
  assert(info.pages >= 2, `ページ数 ${info.pages}`);
  await page.close();
  return `${path.basename(file)} ${info.pages}ページ ${info.width}×${info.height}`;
});

await R.run('K24', '右綴じで最後のページから始まるとき: 「ページの順を逆にする」で、最後の見開きが先になる(右のページが先のまま)', async () => {
  const before = (await getSettings(sw)).bindingDirection || 'ltr';
  try {
    await setSettings(sw, { bindingDirection: 'rtl' });
    await clearChoices();
    const page = await open('/pdf/scan-spread.pdf');
    await waitScan(page, 'arranged');
    const t1 = await pageTexts(page);
    const items = await chipMenu(page, 'ページの順を逆にする');
    assert(items.includes('ページの順を逆にする'), `メニュー: ${items}`);
    await page.waitForFunction(() => window.__seihonViewer.scanArranger.arranged?.options.reverse === true && window.__seihonViewer.scanArranger.state === 'arranged', null, { timeout: 60000 });
    await sleep(800);
    const t2 = await pageTexts(page);
    eq(t2.length, t1.length, 'ページ数');
    // 逆にした順: 最後の見開きが先、見開きの中は右のページが先(元の順の 7,8 → 1,2)
    const n = t1.length;
    eq([t2[0], t2[1]], [t1[n - 2], t1[n - 1]], '最初の見開き');
    eq((await page.evaluate(() => window.PDFViewerApplication.page)), 1, '1ページ目から表示');
    // 覚えておく
    eq((Object.values(await choices())[0] || {}).reverse, true, '整え方を覚える');
    await page.close();
  } finally {
    await setSettings(sw, { bindingDirection: before });
    await clearChoices();
  }
});

await R.run('K20', '最高画質の印刷(「PDF に保存」): 整えたページのまま印刷される', async () => {
  const kiosk = await launch({ width: 1300, height: 900, ...KIOSK_PRINT });
  try {
    const page = await openViewer(kiosk.ctx, '/pdf/scan-spread.pdf');
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const st = await page.evaluate(() => window.__seihonViewer.scanArranger.state);
      if (st === 'arranged') break;
      await sleep(300);
    }
    await sleep(800);
    await page.click('#shPrint');
    const file = await waitForFile(kiosk.downloadsDir, f => /\.pdf$/i.test(f), 60000);
    const info = pdfInfo(file);
    eq(info.pages, 8, '印刷した PDF のページ数');
    const text = pdfText(file, 2);
    assert(text.includes('OCR-P17') && !text.includes('OCR-P16'), `2ページ目の文字: ${text}`);
    return `${path.basename(file)} ${info.width}×${info.height}`;
  } finally {
    await kiosk.close();
  }
});

// ---------------------------------------------------------------------------
// 実物の見本(開発環境にあるときだけ。配布物には入れない)
// ---------------------------------------------------------------------------
for (const [id, name, want] of [
  ['K21', 'scan1.pdf', { kind: 'spread', pages: 18 }],
  ['K22', 'scan2.pdf', { kind: 'spread', pages: 20 }],
  ['K23', 'scan3.pdf', { kind: 'sheets', pages: 16 }],
]) {
  if (!fs.existsSync(path.join(PDFS, name))) {
    continue;
  }
  await R.run(id, `実物の見本 ${name}: ${want.kind === 'spread' ? '自動で分ける' : '冊子の順に並べ替える'}(${want.pages}ページ)`, async () => {
    const t0 = Date.now();
    const page = await open(`/pdf/${name}`);
    const opened = Date.now() - t0;
    if (want.kind === 'sheets') {
      await waitScan(page, 'suggest');
      await chipMenu(page, '冊子の順に並べ替える');
    }
    const st = await waitScan(page, 'arranged');
    const total = Date.now() - t0;
    eq([st.kind, st.pages], [want.kind, want.pages], '結果');
    const sizes = await pageSizes(page);
    const uniform = sizes.every(s => Math.abs(s.w - sizes[0].w) < 0.5 && Math.abs(s.h - sizes[0].h) < 0.5);
    assert(uniform, 'ページの大きさがそろっている');
    await page.close();
    await clearChoices();
    return `表示 ${(opened / 1000).toFixed(1)} 秒 → 整えて表示 ${(total / 1000).toFixed(1)} 秒、1ページ ${Math.round((sizes[0].w * 25.4) / 72)}×${Math.round((sizes[0].h * 25.4) / 72)} mm`;
  });
}

const relevant = errors.filter(e => !/favicon|net::ERR|Failed to load resource/i.test(e));
if (relevant.length) {
  console.log('エラー:', relevant.slice(0, 10).join('\n'));
}
R.summary();
await env.close();
process.exit(0);
