// 0.0.4・0.1 の主な動きの回帰試験(0.2 の変更で壊れていないことの確認)
import fs from 'node:fs';
import path from 'node:path';
import {
  BASE, EXT_ID, PDFS, Results, SP, VIEWER, assert, clearDir, contextMenuAt, clickMenuItem, eq, launch, listFiles, openViewer,
  pdfInfo, pdfText, setSettings, sleep, viewerState, viewerUrl, waitForFile, waitToast, waitViewerReady,
} from './lib.mjs';

const R = new Results('Regression (0.0.4/0.1)');
const env = await launch();
const { ctx } = env;
const dl = () => env.downloadsDir;
const errors = [];
const open = async src => {
  const p = await openViewer(ctx, src);
  p.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  return p;
};

await R.run('G1', 'Web の PDF のリンクを開くと、自動で製本ビューアに切り替わる(#page=5 も効く)', async () => {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/pdf/sample.pdf#page=5`);
  await page.waitForURL(u => u.href.startsWith(VIEWER), { timeout: 15000 });
  await waitViewerReady(page);
  await sleep(500);
  const st = await viewerState(page);
  eq(st.pages, 12, 'ページ数');
  eq(st.page, 5, '5ページ目');
  await page.close();
});

await R.run('G2', '製本表示: 1ページ目は単独で右側、2・3ページ目が見開き', async () => {
  const page = await open('/pdf/book-8.pdf');
  const layout = await page.evaluate(() =>
    [...document.querySelectorAll('#viewer > .spread')].slice(0, 2).map(s => [...s.children].map(c => (c.classList.contains('sh-ph') ? 'ph' : c.dataset.pageNumber)))
  );
  eq(layout, [['ph', '1'], ['2', '3']], '並び');
  await page.close();
});

await R.run('G3', '強制ダウンロード(attachment・octet-stream)の PDF もビューアで開く', async () => {
  for (const url of ['/attachment/sample.pdf', '/octet/sample.pdf', '/octet-cd/get?id=42']) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`);
    await page.evaluate(u => (location.href = u), url);
    await page.waitForURL(u => u.href.startsWith(VIEWER), { timeout: 15000 });
    await waitViewerReady(page);
    await page.close();
  }
  return '3種類';
});

await R.run('G4', '「Chrome標準で開く」で Chrome 標準の PDF ビューアに切り替わる', async () => {
  const page = await open('/pdf/sample.pdf');
  await page.waitForFunction(() => !document.getElementById('shOpenNative').disabled);
  await Promise.all([
    page.waitForURL(u => u.href.startsWith(`${BASE}/pdf/sample.pdf`), { timeout: 15000, waitUntil: 'commit' }),
    page.click('#shOpenNative'),
  ]);
  await sleep(1500);
  const type = await page.evaluate(() => document.contentType);
  eq(type, 'application/pdf', '標準のビューア');
  await page.close();
});

await R.run('G5', 'パソコンの PDF(file://)も製本ビューアで開く', async () => {
  const page = await ctx.newPage();
  await page.goto(`file://${PDFS}/ocr-sample.pdf`);
  await page.waitForURL(u => u.href.startsWith(VIEWER), { timeout: 15000 });
  await waitViewerReady(page);
  eq((await viewerState(page)).pages, 3, 'ページ数');
  await page.close();
});

await R.run('G6', '検索(Ctrl+F)で文字が見つかる', async () => {
  const page = await open('/pdf/sample.pdf');
  await page.locator('#viewerContainer').click({ position: { x: 20, y: 200 } });
  await page.keyboard.press('Control+f');
  await page.waitForSelector('#findInput', { state: 'visible' });
  await page.fill('#findInput', 'Line 3 on page 7');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__seihonViewer.app.page === 7, null, { timeout: 10000 });
  await page.close();
});

await R.run('A1', 'ページ収集: 2つの PDF のページを集めて「PDF で保存」できる', async () => {
  clearDir(dl());
  const a = await open('/pdf/book-8.pdf');
  await a.evaluate(async () => {
    await (await import('/common/db.js')).clearCollection();
    await window.__seihonViewer.collection.addCurrentPages([2, 3]);
  });
  await waitToast(a, /収集に追加しました/);
  await a.close();
  const b = await open('/pdf/sample.pdf');
  await b.evaluate(() => window.__seihonViewer.collection.addCurrentPages([12]));
  await waitToast(b, /収集に追加しました/);
  await b.click('#shCollect');
  await b.click('#shCollectExportPdf');
  await waitToast(b, /PDF で保存しました/);
  const file = await waitForFile(dl(), f => /^book-8ほか_抜粋_.*\.pdf$/.test(f));
  eq(pdfInfo(file).pages, 3, 'ページ数');
  assert(/page 12 of 12/.test(pdfText(file, 3)), '3ページ目は sample の12ページ目');
  await b.evaluate(async () => (await import('/common/db.js')).clearCollection());
  await b.close();
});

await R.run('A2', '強制ダウンロード対策 第3層: blob: で保存させるページの PDF も、保存後にビューアで開く', async () => {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/blob.html`);
  const [viewer] = await Promise.all([ctx.waitForEvent('page', { predicate: p => p.url().startsWith(VIEWER), timeout: 20000 }), page.click('#b1')]);
  await waitViewerReady(viewer);
  eq((await viewerState(viewer)).pages, 10, 'ページ数');
  await viewer.close();
  await page.close();
});

await R.run('B1', '製本用PDF出力: 8ページは白紙なしで面付け (8,1)(2,7)(6,3)(4,5)', async () => {
  clearDir(dl());
  // 0.5: プレビューは初期値では出さない(試験では出して並びを確かめる)
  await setSettings(env.sw, { bindHidePreview: false });
  const page = await open('/pdf/book-8.pdf');
  await page.evaluate(() => window.__seihonViewer.pageRoles.clear());
  await page.click('#shBindOutput');
  await page.waitForFunction(() => !document.getElementById('shBindRun').disabled);
  const sheets = await page.$$eval('#shBindSheets .sh-bind-sheet', rows => rows.map(r => [...r.querySelectorAll('.sh-bind-mini')].map(m => m.textContent).join(',')));
  eq(sheets, ['8,1,2,7', '6,3,4,5'], '面付け');
  await page.click('#shBindRun');
  await page.waitForFunction(() => !document.getElementById('shBindResult').hidden, null, { timeout: 30000 });
  const file = await waitForFile(dl(), f => f === 'book-8_製本_面付け.pdf');
  eq(pdfInfo(file).pages, 4, '用紙2枚の両面 = 4面');
  await page.click('#shBindResultClose');
  await page.close();
});

await R.run('B2', '製本用PDF出力: 10ページは最後のページの直前に白紙2枚を入れて12ページ', async () => {
  const page = await open('/pdf/book-10.pdf');
  await page.evaluate(() => window.__seihonViewer.pageRoles.clear());
  await page.click('#shBindOutput');
  await page.waitForFunction(() => !document.getElementById('shBindRun').disabled);
  const seq = await page.evaluate(() => window.__seihonViewer.bindDialog.plan.sequence.map(s => (s.kind === 'blank' ? 'B' : s.pageIndex + 1)).join(','));
  eq(seq, '1,2,3,4,5,6,7,8,9,B,B,10', '並び');
  await page.click('#shBindCancel');
  await page.close();
});

await R.run('E1', 'サムネイルの ✕ でページを削除し、「元に戻す」で戻せる。「保存」ボタンが出る', async () => {
  const page = await open('/pdf/sample.pdf');
  await page.evaluate(() => window.__seihonViewer.app.viewsManager?.switchView(1, true));
  await page.waitForSelector('#thumbnailsView .thumbnail[page-number="3"]');
  await page.hover('#thumbnailsView .thumbnail[page-number="3"]');
  await page.click('#thumbnailsView .thumbnail[page-number="3"] .sh-thumb-del', { force: true });
  await page.waitForFunction(() => window.__seihonViewer.app.pagesCount === 11, null, { timeout: 10000 });
  await page.waitForSelector('#shSaveEdits:not([hidden])');
  await page.click('#shThumbUndo');
  await page.waitForFunction(() => window.__seihonViewer.app.pagesCount === 12, null, { timeout: 10000 });
  await page.close();
});

await R.run('E2', '編集したまま別の PDF を開こうとすると「変更を保存しますか?」が出る(キャンセルで残る)', async () => {
  const page = await open('/pdf/sample.pdf');
  await page.evaluate(() => window.__seihonViewer.pageEditor.deletePages([2]));
  await sleep(500);
  const p = page.evaluate(() => window.__seihonViewer.app.open({ url: '/pdf/book-8.pdf' }).then(() => 'done'));
  await page.waitForSelector('dialog.sh-dialog[open]');
  const title = await page.textContent('dialog.sh-dialog[open] h2');
  eq(title, '変更を保存しますか?', '確認の画面');
  await page.click('dialog.sh-dialog[open] button:has-text("キャンセル")');
  await p;
  eq((await viewerState(page)).pages, 11, '開いたままの PDF');
  await page.evaluate(() => window.__seihonViewer.pageEditor.allowLeave());
  await page.close();
});

await R.run('E3', '編集した PDF の「保存」は保存先を選ぶ形で、名前は「_編集済み」(上書きしない)', async () => {
  const page = await open('/pdf/sample.pdf');
  await page.evaluate(() => window.__seihonViewer.pageEditor.deletePages([2, 3]));
  await sleep(500);
  // 0.4.2: 保存先を選ぶ画面(偽物。lib.mjs)で保存する。ダウンロードの仕組み(chrome.downloads)は使わない
  await page.evaluate(() => {
    window.__dlCalls = [];
    const orig = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = opts => {
      window.__dlCalls.push(opts.filename);
      return orig(opts);
    };
  });
  await page.click('#shSaveEdits');
  await page.waitForFunction(() => window.__pickerCalls.length > 0, null, { timeout: 15000 });
  const call = await page.evaluate(() => window.__pickerCalls[0]);
  eq([call.kind, call.suggestedName, call.activation], ['file', 'sample_編集済み.pdf', true], '保存先を選ぶ画面の指定');
  eq(call.types?.[0]?.accept, { 'application/pdf': ['.pdf'] }, '選べる種類');
  eq(await page.evaluate(() => window.__dlCalls), [], 'ダウンロードの仕組みは使わない');
  const file = await waitForFile(dl(), f => /^sample_編集済み.*\.pdf$/.test(f));
  eq(pdfInfo(file).pages, 10, '保存した PDF のページ数');
  await page.close();
});

await R.run('E4', '「幅に合わせる」: 大きさの違うページがあっても、どの見開きも横にはみ出さない', async () => {
  const page = await open('/pdf/mixed-8.pdf');
  await page.evaluate(() => (window.__seihonViewer.app.pdfViewer.currentScaleValue = 'page-width'));
  await sleep(600);
  const over = await page.evaluate(() => {
    const c = document.getElementById('viewerContainer');
    return c.scrollWidth - c.clientWidth;
  });
  assert(over <= 1, `横にはみ出す(${over}px)`);
  await page.close();
});

await R.run('X1', '詳細設定の書き出し(JSON)に新しい設定が入り、読み込める', async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/options/options.html`);
  const r = await page.evaluate(async () => {
    const b = await import('/common/backup.js');
    const data = await b.createBackup({ settings: true, roles: true });
    const parsed = b.parseBackup(JSON.stringify(data));
    return { ok: parsed.ok, keys: Object.keys(data.settings), invalid: parsed.invalidSettings };
  });
  assert(r.ok, '読み込める');
  for (const k of ['imageQuality', 'copyImagesAs', 'bindUseBookmark', 'bindUseFlapFront', 'bindUseFlapBack']) {
    assert(r.keys.includes(k), `${k} がある`);
  }
  eq(r.invalid, [], '使えない値は無い');
  await page.close();
});

await R.run('X2', '新しい役割(しおり・折り返し)も、設定の書き出し・読み込みで引き継がれる', async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/options/options.html`);
  const r = await page.evaluate(async () => {
    const b = await import('/common/backup.js');
    const text = JSON.stringify({
      format: 'seihon-viewer-backup',
      formatVersion: 1,
      roles: [{ pdfKey: `sha256:${'a'.repeat(64)}:100`, name: 'x.pdf', pages: 5, roles: { 0: 'cover', 1: 'flapFront', 2: 'bookmark', 3: 'obi', 4: 'flapBack' } }],
    });
    const parsed = b.parseBackup(text);
    return { ok: parsed.ok, roles: parsed.roles[0]?.roles, skipped: parsed.skippedRoles };
  });
  assert(r.ok, '読み込める');
  eq(Object.values(r.roles || {}), ['cover', 'flapFront', 'bookmark', 'obi', 'flapBack'], '役割');
  await page.close();
});

await env.close();
if (errors.length) {
  console.log('ページのエラー:', errors.slice(0, 10));
}
const s = R.summary();
process.exit(s.ok === s.total ? 0 : 1);
