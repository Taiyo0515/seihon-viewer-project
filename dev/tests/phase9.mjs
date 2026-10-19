// 0.4.2(保存のファイル名が GUID になる問題・左上の名前の変更)の試験
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BASE, DEV, EXT, PDFS, Results, assert, eq, expireActivation, launch, listFiles, openViewer, pickerFile, sleep, waitToast } from './lib.mjs';

const R = new Results('Phase 9 (0.4.2)');
// ほかの拡張機能が onDeterminingFilename を使っている状態(Chrome がファイル名を無視して GUID の名前にする)
const DUMMY = path.join(DEV, 'fixtures/dummy-dl-extension');
const env = await launch({ width: 1400, height: 900, extDir: `${EXT},${DUMMY}` });
const { ctx, sw } = env;
const dl = () => env.downloadsDir;
const errors = [];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

const watch = page => {
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error') {
      errors.push(`console: ${m.text().slice(0, 200)}`);
    }
  });
  return page;
};
const open = async src => watch(await openViewer(ctx, src.startsWith('http') ? src : `${BASE}${src}`));
const brokenFlag = () => sw.evaluate(async () => (await chrome.storage.local.get('downloadNameBrokenAt')).downloadNameBrokenAt || 0);
const clearFlag = () => sw.evaluate(() => chrome.storage.local.remove('downloadNameBrokenAt'));
const clickToastAction = (page, label) => page.locator('.sh-toast-action', { hasText: label }).first().click();
const pdfTitle = file => (execFileSync('pdfinfo', [file], { encoding: 'utf8' }).match(/^Title:\s*(.*)$/m) || [])[1]?.trim() || '';
const xmpTitle = file => {
  const meta = execFileSync('pdfinfo', ['-meta', file], { encoding: 'utf8' });
  return (meta.match(/<dc:title\b[^>]*>[\s\S]*?<rdf:li[^>]*>([^<]*)<\/rdf:li>/) || [])[1] || null;
};
const writeTmp = (name, buf) => {
  const file = path.join(PDFS, name);
  fs.writeFileSync(file, buf);
  return file;
};

await R.run('M0', '試験の前提: ほかの拡張機能があると chrome.downloads.download の名前が GUID になる', async () => {
  const page = await open('/pdf/sample.pdf');
  const name = await page.evaluate(async () => {
    const url = URL.createObjectURL(new Blob(['x']));
    const id = await chrome.downloads.download({ url, filename: 'probe.txt', saveAs: false });
    for (let i = 0; i < 50; i++) {
      const [it] = await chrome.downloads.search({ id });
      if (it.state === 'complete') {
        await chrome.downloads.removeFile(id);
        await chrome.downloads.erase({ id });
        return it.filename.split('/').pop();
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  });
  assert(GUID.test(name || ''), `保存された名前: ${name}`);
  await page.close();
  return name;
});

await R.run('M1', '「このページだけの PDF として保存」: GUID の名前になったら、そのファイルを消して保存先を選ぶ画面で保存し直す', async () => {
  await clearFlag();
  const page = await open('/pdf/sample.pdf');
  await page.evaluate(() => (window.__pickerNoDownload = true));
  // ダウンロードフォルダへの保存を待つ間に、クリックの効き目が切れた状態
  await expireActivation(page);
  page.evaluate(() => window.__seihonViewer.pageCopy.savePagePdf(1));
  await waitToast(page, /保存の準備ができました\(sample_p1\.pdf\)/, 20000);
  await clickToastAction(page, '保存先を選ぶ');
  await page.waitForFunction(() => (window.__pickerWritten || []).length > 0, null, { timeout: 15000 });
  const call = await page.evaluate(() => window.__pickerCalls[0]);
  eq([call.kind, call.suggestedName, call.activation], ['file', 'sample_p1.pdf', true], '保存先を選ぶ画面の指定');
  const file = writeTmp('m1.pdf', await pickerFile(page, 'sample_p1.pdf'));
  eq(execFileSync('pdfinfo', [file], { encoding: 'utf8' }).match(/^Pages:\s*(\d+)/m)[1], '1', 'ページ数');
  await waitToast(page, /1ページを PDF で保存しました: sample_p1\.pdf/);
  await sleep(800);
  eq(listFiles(dl()).filter(f => GUID.test(f)), [], 'GUID の名前のファイルは残らない');
  const history = await page.evaluate(async () => (await chrome.downloads.search({})).filter(d => /sample_p1|[0-9a-f]{8}-/.test(d.filename)).length);
  eq(history, 0, 'ダウンロードの一覧にも残らない');
  assert((await brokenFlag()) > 0, '覚えておく');
  // 「フォルダを開く」は出さない(ダウンロードフォルダに保存していない)
  const actions = await page.$$eval('.sh-toast', els => els.filter(e => /PDF で保存しました/.test(e.textContent)).map(e => e.querySelectorAll('.sh-toast-action').length));
  eq(actions, [0], '「フォルダを開く」は出さない');
  await page.close();
});

await R.run('M2', '一度 GUID になったあとは、最初から保存先を選ぶ画面にする(やめたら「保存をやめました」)', async () => {
  const page = await open('/pdf/sample.pdf');
  await page.evaluate(() => {
    window.__pickerNoDownload = true;
    window.__pickerCancel = true;
    window.__dlCount = 0;
    const orig = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = o => {
      window.__dlCount++;
      return orig(o);
    };
  });
  // (Playwright の evaluate はクリックの直後と同じ扱いなので、すぐに保存先を選ぶ画面が出る)
  page.evaluate(() => window.__seihonViewer.pageCopy.savePagePdf(1));
  await waitToast(page, /^保存をやめました$/, 20000);
  const calls = await page.evaluate(() => window.__pickerCalls);
  eq(calls.map(c => [c.kind, c.suggestedName]), [['file', 'sample_p1.pdf']], '保存先を選ぶ画面');
  eq(await page.evaluate(() => window.__dlCount), 0, 'ダウンロードの仕組みは使わない');
  await page.close();
});

await R.run('M3', '複数のファイル(製本用PDF出力など): 保存先のフォルダを選び、同じ名前があれば「名前 (1).pdf」にする', async () => {
  const page = await open('/pdf/sample.pdf');
  await page.evaluate(() => {
    window.__pickerNoDownload = true;
    window.__pickerExisting = ['本_面付け.pdf'];
  });
  await expireActivation(page);
  const result = page.evaluate(async () => {
    const { saveFiles } = await import('/common/files.js');
    return saveFiles([
      { blob: new Blob(['%PDF-a']), fileName: '本_面付け.pdf' },
      { blob: new Blob(['%PDF-bb']), fileName: '本_付属.pdf' },
    ]);
  });
  await waitToast(page, /保存の準備ができました\(2 個のファイル\)/, 20000);
  await clickToastAction(page, '保存先を選ぶ');
  const r = await result;
  eq(r, { ok: true, saved: [{ fileName: '本_面付け (1).pdf' }, { fileName: '本_付属.pdf' }], picked: true }, '結果');
  eq(await page.evaluate(() => window.__pickerCalls.map(c => [c.kind, c.mode, c.activation])), [['dir', 'readwrite', true]], 'フォルダを選ぶ画面');
  eq(await page.evaluate(() => window.__pickerWritten), [{ name: '本_面付け (1).pdf', size: 6 }, { name: '本_付属.pdf', size: 7 }], '書き込んだファイル');
  await page.close();
});

await R.run('M4', '編集した PDF の「保存」: ほかの拡張機能があっても、名前は「元の名前_編集済み.pdf」', async () => {
  const page = await open('/pdf/sample.pdf');
  await page.evaluate(() => (window.__pickerNoDownload = true));
  await page.evaluate(() => window.__seihonViewer.pageEditor.deletePages([2]));
  await sleep(400);
  await page.click('#shSaveEdits');
  await page.waitForFunction(() => (window.__pickerWritten || []).length > 0, null, { timeout: 15000 });
  eq(await page.evaluate(() => window.__pickerCalls.map(c => c.suggestedName)), ['sample_編集済み.pdf'], '名前');
  await waitToast(page, /保存しました: sample_編集済み\.pdf/);
  eq(await page.isHidden('#shSaveEdits'), true, '保存したら「保存」ボタンは消える');
  await page.close();
});

await R.run('M5', '左上の名前をクリックして変更 → 保存すると PDF の題名(Info と XMP の両方)になり、開き直しても新しい名前', async () => {
  const page = await open('/files/xmp-title.pdf');
  await page.evaluate(() => (window.__pickerNoDownload = true));
  eq(await page.textContent('#shTitle'), '古い題名', '元の名前');
  await page.click('#shTitle');
  await page.waitForSelector('#shTitleInput');
  eq(await page.inputValue('#shTitleInput'), '古い題名', '入力欄の初めの値');
  eq(await page.evaluate(() => document.activeElement?.id), 'shTitleInput', '入力欄にフォーカス');
  await page.fill('#shTitleInput', '新しい題名 2026');
  await page.press('#shTitleInput', 'Enter');
  await page.waitForSelector('#shTitleInput', { state: 'detached' });
  eq(await page.textContent('#shTitle'), '新しい題名 2026', '表示');
  assert((await page.title()).startsWith('* 新しい題名 2026'), `タブの名前: ${await page.title()}`);
  eq(await page.isVisible('#shSaveEdits'), true, '「保存」ボタンが出る');
  eq(await page.evaluate(() => window.__seihonViewer.pageEditor.describeChanges()), '名前の変更', '変更の説明');
  await waitToast(page, /名前を「新しい題名 2026」にしました/);
  await page.click('#shSaveEdits');
  await page.waitForFunction(() => (window.__pickerWritten || []).length > 0, null, { timeout: 15000 });
  eq(await page.evaluate(() => window.__pickerCalls[0].suggestedName), 'xmp-title_編集済み.pdf', '保存の名前(ファイル名は変えない)');
  const file = writeTmp('m5-renamed.pdf', await pickerFile(page, 'xmp-title_編集済み.pdf'));
  eq(pdfTitle(file), '新しい題名 2026', 'Info の題名');
  eq(xmpTitle(file), '新しい題名 2026', 'XMP の題名');
  eq(execFileSync('pdfinfo', [file], { encoding: 'utf8' }).match(/^Pages:\s*(\d+)/m)[1], '12', 'ページ数');
  await page.waitForFunction(() => !document.title.startsWith('* '), null, { timeout: 5000 });
  eq(await page.isHidden('#shSaveEdits'), true, '保存したら「保存」ボタンは消える');
  eq(await page.textContent('#shTitle'), '新しい題名 2026', '保存後も新しい名前のまま');
  await page.close();
  const again = await open('/files/m5-renamed.pdf');
  eq(await again.textContent('#shTitle'), '新しい題名 2026', '開き直したときの名前');
  await again.close();
});

await R.run('M6', '名前の変更: Esc でやめる・空にすると元に戻る・入力中のキーはページ移動などに使わない・「元に戻す」', async () => {
  const page = await open('/pdf/sample.pdf');
  const original = await page.textContent('#shTitle');
  const pageNo = () => page.evaluate(() => window.__seihonViewer.app.pdfViewer.currentPageNumber);
  const before = await pageNo();
  await page.click('#shTitle');
  await page.waitForSelector('#shTitleInput');
  await page.keyboard.type('jjj nn');
  await page.keyboard.press('End');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#shTitleInput', { state: 'detached' });
  eq(await page.textContent('#shTitle'), original, 'Esc でやめる');
  eq(await pageNo(), before, 'ページは動かない');
  eq(await page.evaluate(() => window.__seihonViewer.pageEditor.dirty), false, '変更なし');
  // 変えて、「元に戻す」
  await page.click('#shTitle');
  await page.fill('#shTitleInput', '仮の名前');
  await page.press('#shTitleInput', 'Enter');
  await waitToast(page, /名前を「仮の名前」にしました/);
  await clickToastAction(page, '元に戻す');
  eq(await page.textContent('#shTitle'), original, '「元に戻す」で元の名前');
  eq(await page.evaluate(() => window.__seihonViewer.pageEditor.title), null, '付け直しなし');
  // 空にして決定 → 元の名前
  await page.click('#shTitle');
  await page.fill('#shTitleInput', '別の名前');
  await page.press('#shTitleInput', 'Enter');
  await page.click('#shTitle');
  await page.fill('#shTitleInput', '   ');
  await page.press('#shTitleInput', 'Enter');
  eq(await page.textContent('#shTitle'), original, '空にすると元の名前');
  eq(await page.evaluate(() => window.__seihonViewer.pageEditor.dirty), false, '変更なしに戻る');
  // ほかをクリックしても決定(入力欄が外れたとき)
  await page.click('#shTitle');
  await page.fill('#shTitleInput', 'クリックで決定');
  await page.click('#viewerContainer', { position: { x: 30, y: 300 } });
  eq(await page.textContent('#shTitle'), 'クリックで決定', 'ほかをクリックしても決定');
  await page.evaluate(() => window.__seihonViewer.pageEditor.allowLeave());
  await page.close();
});

await R.run('M7', '名前の変更とページの削除を一緒に保存できる(XMP の無い PDF)', async () => {
  const page = await open('/pdf/sample.pdf');
  await page.evaluate(() => (window.__pickerNoDownload = true));
  await page.evaluate(() => window.__seihonViewer.pageEditor.deletePages([3, 4]));
  await sleep(500);
  await page.click('#shTitle');
  await page.fill('#shTitleInput', '抜粋の本');
  await page.press('#shTitleInput', 'Enter');
  eq(await page.evaluate(() => window.__seihonViewer.pageEditor.describeChanges()), '2ページの削除と名前の変更', '変更の説明');
  await page.click('#shSaveEdits');
  await page.waitForFunction(() => (window.__pickerWritten || []).length > 0, null, { timeout: 15000 });
  const file = writeTmp('m7.pdf', await pickerFile(page, 'sample_編集済み.pdf'));
  eq(pdfTitle(file), '抜粋の本', '題名');
  eq(execFileSync('pdfinfo', [file], { encoding: 'utf8' }).match(/^Pages:\s*(\d+)/m)[1], '10', 'ページ数');
  await page.close();
});

const sum = R.summary();
if (errors.length) {
  console.log('--- ページのエラー(参考) ---');
  console.log([...new Set(errors)].slice(0, 30).join('\n'));
}
for (const f of ['m1.pdf', 'm5-renamed.pdf', 'm7.pdf']) {
  fs.rmSync(path.join(PDFS, f), { force: true });
}
await env.close();
process.exit(sum.ok === sum.total ? 0 : 1);
