// 0.5(メニューの整理・回転の選択・製本用PDF出力の画面・詳細設定の4分類・スキャンの読む向きと1ページ目・ノドの影)の試験
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  BASE, EXT_ID, PDFS, Results, assert, contextMenuAt, eq, getSettings, launch, listFiles, openViewer, pdfInfo, setSettings, sleep, waitForFile,
  waitToast,
} from './lib.mjs';

const R = new Results('Phase 10 (0.5)');
const env = await launch({ width: 1400, height: 950 });
const { ctx, sw } = env;
const dl = () => env.downloadsDir;
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
const open = async src => watch(await openViewer(ctx, src.startsWith('http') ? src : `${BASE}${src}`));
const rotation = page => page.evaluate(() => window.__seihonViewer.app.pdfViewer.pagesRotation);
const menuLabels = page => page.$$eval('.sh-popup:not([hidden]) .sh-menu-item .sh-menu-label', els => els.map(e => e.textContent));
const openBind = async page => {
  await page.click('#shBindOutput');
  await page.waitForFunction(() => !document.getElementById('shBindRun').disabled, null, { timeout: 20000 });
};
const KOKUGO = path.join(PDFS, 'kokugo2018.pdf');

// ---------------------------------------------------------------------------
// メニュー
// ---------------------------------------------------------------------------
await R.run('N1', '⋮ メニューから「ファイルを開く」「PDFを閉じる」「回転」「表示中のページをコピー」「元の場所のコピー」「ページを選ぶ」を外した。Ctrl+O は使える', async () => {
  const page = await open('/pdf/book-8.pdf');
  await page.click('#shMore');
  const items = await menuLabels(page);
  for (const gone of ['PDFを閉じる', '右に回転(時計回り)', '左に回転(反時計回り)', '表示中のページをコピー', '元のリンク・ファイルの場所をコピー…', 'ページを選ぶ(削除・カバーや帯などの指定)']) {
    assert(!items.includes(gone), `「${gone}」が残っている`);
  }
  assert(!items.some(t => t.startsWith('ファイルを開く')), '「ファイルを開く」が残っている');
  assert(items.includes('詳細設定') && items.includes('製本用PDF出力…'), `ほかの項目は残る: ${items}`);
  await page.keyboard.press('Escape');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.keyboard.press('Control+o')]);
  assert(!!chooser, 'Ctrl+O でファイルを選ぶ画面');
  await page.close();
  return `${items.length} 項目`;
});

await R.run('N2', '右クリックのメニューに「このページだけの PDF として保存」が無い。回転のショートカット(Ctrl+[ ・ Ctrl+])は使える', async () => {
  const page = await open('/pdf/book-8.pdf');
  const items = await contextMenuAt(page, '.page[data-page-number="1"]');
  assert(!items.includes('このページだけの PDF として保存'), `項目: ${items}`);
  await page.keyboard.press('Escape');
  await page.locator('#viewerContainer').click({ position: { x: 20, y: 200 } });
  await page.keyboard.press('Control+]');
  await sleep(300);
  eq(await rotation(page), 90, 'Ctrl+] で右に90°');
  await page.keyboard.press('Control+[');
  await page.keyboard.press('Control+[');
  await sleep(300);
  eq(await rotation(page), 270, 'Ctrl+[ で左に90°ずつ');
  await page.close();
});

// ---------------------------------------------------------------------------
// 回転ボタン
// ---------------------------------------------------------------------------
await R.run('N3', '回転ボタンの右クリック: 向きと角度を選んで回転。「既定の設定を上書きする」をオンにしたときだけ、ボタンの動きが変わる', async () => {
  await setSettings(sw, { rotateStep: -90 });
  const page = await open('/pdf/book-8.pdf');
  await page.click('#shRotate', { button: 'right' });
  await page.waitForSelector('#shRotateDir');
  eq([await page.inputValue('#shRotateDir'), await page.inputValue('#shRotateAngle')], ['left', '90'], '初めの選択(いまの既定)');
  eq(await page.$$eval('#shRotateAngle option', o => o.map(x => x.textContent)), ['90°', '180°', '270°'], '角度');
  eq(await page.$$eval('#shRotateDir option', o => o.map(x => x.textContent)), ['左', '右'], '向き');
  assert(await page.isVisible('#shRotateDefault'), '「既定の設定を上書きする」がある');
  // 上書きしないで、右に 180°
  await page.selectOption('#shRotateDir', 'right');
  await page.selectOption('#shRotateAngle', '180');
  await page.click('#shRotateRun');
  await sleep(300);
  eq(await rotation(page), 180, '右に180°');
  eq((await getSettings(sw)).rotateStep, -90, '既定は変わらない');
  await page.click('#shRotate');
  await sleep(300);
  eq(await rotation(page), 90, 'ボタンは左に90°のまま');
  // 上書きして、右に 270°
  await page.click('#shRotate', { button: 'right' });
  await page.selectOption('#shRotateDir', 'right');
  await page.selectOption('#shRotateAngle', '270');
  await page.check('#shRotateDefault');
  await page.click('#shRotateRun');
  await waitToast(page, /回転ボタンの動きを「右に 270°」にしました/);
  eq((await getSettings(sw)).rotateStep, 270, '既定を保存');
  eq(await rotation(page), 0, '90 + 270');
  await page.click('#shRotate');
  await sleep(300);
  eq(await rotation(page), 270, 'ボタンで右に270°');
  assert((await page.getAttribute('#shRotate', 'title')).startsWith('右に 270°回転'), 'ボタンの説明');
  eq(await page.getAttribute('#shRotate', 'data-icon'), 'rotate-cw', '時計回りのアイコン');
  await setSettings(sw, { rotateStep: -90 });
  await page.close();
});

// ---------------------------------------------------------------------------
// 製本用PDF出力の画面
// ---------------------------------------------------------------------------
await R.run('N4', '製本用PDF出力: プレビューは初期値で出さない。綴じ方向・用紙は詳細設定の外、面付けは詳細設定の中', async () => {
  await setSettings(sw, { bindHidePreview: true });
  const page = await open('/pdf/book-10.pdf');
  await page.evaluate(() => window.__seihonViewer.pageRoles.clear());
  await openBind(page);
  eq(await page.isChecked('#shBindHidePreview'), true, '「プレビューを表示しない」が初めからオン');
  eq(await page.isHidden('#shBindPreviewWrap'), true, 'プレビューは出ない');
  eq(await page.$$eval('#shBindPreview .sh-bind-page', e => e.length), 0, 'サムネイルを作らない');
  const where = await page.evaluate(() => ({
    direction: !!document.querySelector('input[name="shBindDirection"]').closest('details'),
    paper: !!document.getElementById('shBindPaper').closest('details'),
    impose: !!document.getElementById('shBindImpose').closest('details'),
    duplex: !!document.querySelector('input[name="shBindDuplex"]').closest('details'),
  }));
  eq(where, { direction: false, paper: false, impose: true, duplex: true }, '詳細設定の中か');
  assert(await page.isVisible('input[name="shBindDirection"][value="rtl"]'), '綴じ方向は開いてすぐ見える');
  // プレビューを出す(覚える)
  await page.uncheck('#shBindHidePreview');
  await page.waitForFunction(() => document.querySelectorAll('#shBindPreview .sh-bind-page').length === 12);
  await sleep(300);
  eq((await getSettings(sw)).bindHidePreview, false, '選んだものを覚える');
  // 面付けを外すと、用紙は選べない
  await page.click('#shBindDetails summary');
  await page.uncheck('#shBindImpose');
  eq(await page.isDisabled('#shBindPaper'), true, '面付けしないときは用紙を選べない');
  await page.check('#shBindImpose');
  await page.click('#shBindClose');
  await setSettings(sw, { bindHidePreview: true });
  await page.close();
});

await R.run('N5', '製本用PDF出力: 大きさの基準に「ページ指定」。ファイル名の欄に、本体・付属の名前がそのまま出る', async () => {
  const page = await open('/pdf/mixed-8.pdf');
  await page.evaluate(() => window.__seihonViewer.pageRoles.clear());
  await openBind(page);
  await page.click('#shBindDetails summary');
  const sizes = await page.evaluate(() => window.__seihonViewer.bindDialog.sizes.map(s => [Math.round(s.width), Math.round(s.height)]));
  const pick = sizes.findIndex(s => s[0] !== sizes[1][0] || s[1] !== sizes[1][1]);
  assert(pick >= 0, `大きさの違うページ: ${JSON.stringify(sizes)}`);
  await page.selectOption('#shBindSizeRefPage', String(pick));
  eq(await page.isChecked('input[name="shBindSizeRef"][value="page"]'), true, '「ページ指定」が選ばれる');
  const ref = await page.evaluate(() => [Math.round(window.__seihonViewer.bindDialog.ref.width), Math.round(window.__seihonViewer.bindDialog.ref.height)]);
  eq(ref, sizes[pick], '基準の大きさ');
  assert((await page.textContent('#shBindWarnings')).includes(`${pick + 1}ページ目の大きさを基準に`), '注意の文');
  eq(await page.textContent('#shBindNameBook'), 'mixed-8_製本_面付け.pdf', '本体の名前');
  assert((await page.textContent('#shBindNameObi')).startsWith('mixed-8_付属.pdf'), '付属の名前');
  assert((await page.textContent('#shBindNameObi')).includes('いまは作りません'), '付属が無いときは作らないと出す');
  await page.fill('#shBindSuffix', '_本');
  eq(await page.textContent('#shBindNameBook'), 'mixed-8_本_面付け.pdf', '言葉を変えるとすぐ反映');
  await page.click('#shBindClose');
  await page.close();
  return `${pick + 1}ページ目 ${sizes[pick].join('×')}`;
});

await R.run('N6', 'カバー・表紙・帯などの項目: 追加した項目(複数可)にページを付けると付属として出力。複数・表示を切り替えられ、削除もできる', async () => {
  clearDir();
  const page = await open('/pdf/book-10.pdf');
  page.on('dialog', d => d.accept());
  await page.evaluate(() => window.__seihonViewer.pageRoles.clear());
  await openBind(page);
  await page.click('#shBindDetails summary');
  // 追加
  await page.fill('#shBindRi-new', '口絵');
  await page.click('#shBindRi-add');
  await waitToast(page, /「口絵」を追加しました/);
  await page.waitForFunction(() => [...document.querySelectorAll('#shBindRoleGrid label')].some(l => l.textContent.startsWith('口絵')));
  const items = (await getSettings(sw)).bindRoleItems;
  const custom = items.find(i => i.label === '口絵');
  eq([custom.id, custom.multi, custom.use, custom.show], ['custom1', true, 'obi', true], '保存した項目');
  // 3ページ目と4ページ目を口絵にする(複数可の欄)
  for (const v of ['2', '3']) {
    await page.selectOption('#shBindMultiAdd-custom1', v);
    await waitToast(page, new RegExp(`${Number(v) + 1}ページ目を「口絵」にしました`));
  }
  await page.waitForFunction(() => document.querySelectorAll('#shBindMultiItems-custom1 .sh-multi-item').length === 2);
  assert((await page.textContent('#shBindSummary')).includes('付属(口絵): 2ページ'), await page.textContent('#shBindSummary'));
  // 右クリックの「ページ役割」にも出る
  // 帯を「複数」から外すと、1ページを選ぶ欄になる
  await page.uncheck('#shBindRi-multi-obi');
  await page.waitForSelector('#shBindObiSingle');
  eq(await page.$('#shBindObiAdd'), null, '帯の複数の欄は無くなる');
  // 表紙を隠す
  await page.uncheck('#shBindRi-show-obiFront');
  await page.waitForFunction(() => !document.getElementById('shBindObiFront'));
  // 出力: 本体 + 付属(口絵 2ページ)
  await page.click('#shBindRun');
  await page.waitForSelector('#shBindResult:not([hidden])', { timeout: 30000 });
  const obi = await waitForFile(dl(), f => /^book-10_付属.*\.pdf$/.test(f));
  eq(pdfInfo(obi).pages, 2, '付属の PDF のページ数');
  const book = await waitForFile(dl(), f => /^book-10_製本_面付け.*\.pdf$/.test(f));
  eq(pdfInfo(book).pages, 4, '本体(口絵を除いた8ページ → 用紙2枚の表裏 = 4面)');
  await page.click('#shBindResultClose');
  // 右クリックの役割に「口絵」があり、「表紙」は無い
  const ctxItems = await contextMenuAt(page, '.page[data-page-number="1"]');
  await page.locator('.sh-context-menu .sh-menu-item', { hasText: 'ページ役割' }).first().click();
  await sleep(400);
  const roleMenu = await page.$$eval('.sh-popup:not([hidden]) .sh-menu-item .sh-menu-label, .sh-context-menu .sh-menu-item .sh-menu-label', els => els.map(e => e.textContent));
  assert(roleMenu.includes('口絵'), `役割のメニュー: ${roleMenu}`);
  assert(!roleMenu.includes('表紙'), `隠した「表紙」は出ない: ${roleMenu}`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // 削除すると、口絵のページは本文に戻る
  await openBind(page);
  await page.click('#shBindDetails summary');
  await page.click('tr[data-role-id="custom1"] .sh-ri-del');
  await waitToast(page, /「口絵」を削除しました/);
  await page.waitForFunction(() => !document.getElementById('shBindMultiAdd-custom1'));
  await page.click('#shBindClose');
  await setSettings(sw, { bindRoleItems: undefined });
  await page.evaluate(() => window.__seihonViewer.pageRoles.clear());
  await page.close();
  return ctxItems.length ? 'ok' : '';
});

// 収集のフォルダを空にする(ダウンロード先)
function clearDir() {
  for (const f of listFiles(dl())) {
    fs.rmSync(path.join(dl(), f), { force: true, recursive: true });
  }
}

await R.run('N7', 'ダークモード: 選択欄の一覧(ドロップダウン)の文字が読める色(地と文字の明るさが十分に違う)', async () => {
  await setSettings(sw, { theme: 'dark' });
  const page = await open('/pdf/book-10.pdf');
  await openBind(page);
  const c = await page.evaluate(() => {
    const o = document.querySelector('#shBindCover option');
    const cs = getComputedStyle(o);
    return [cs.backgroundColor, cs.color];
  });
  const lum = s => {
    const [r, g, b] = s.match(/\d+/g).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  assert(lum(c[0]) < 80 && lum(c[1]) > 180, `地 ${c[0]} / 文字 ${c[1]}`);
  await page.click('#shBindClose');
  const opt = watch(await ctx.newPage());
  await opt.goto(`${OPTIONS}#sec-bind`);
  await sleep(500);
  const c2 = await opt.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('#bindPaper option'));
    return [cs.backgroundColor, cs.color];
  });
  assert(lum(c2[0]) < 80 && lum(c2[1]) > 180, `詳細設定: 地 ${c2[0]} / 文字 ${c2[1]}`);
  await setSettings(sw, { theme: 'system' });
  await opt.close();
  await page.close();
  return `${c[0]} / ${c[1]}`;
});

// ---------------------------------------------------------------------------
// 詳細設定
// ---------------------------------------------------------------------------
await R.run('N8', '詳細設定: 入口は4つの分類。分類を開くと、その分類の項目だけ。#sec-○○ で開くと、その項目のある分類が開く', async () => {
  const page = watch(await ctx.newPage());
  await page.goto(OPTIONS);
  await sleep(500);
  eq(await page.$$eval('.cat-card .cat-title', e => e.map(x => x.textContent)), ['開く・読む', 'スキャン・ページ操作', '印刷・製本出力', '詳細管理・トラブル対応'], '入口');
  eq(await page.$$eval('.cat', e => e.filter(x => !x.hidden).length), 0, '入口では分類の中身を出さない');
  await page.click('.cat-card[href="#print"]');
  await sleep(300);
  eq(await page.$$eval('.cat', e => e.filter(x => !x.hidden).map(x => x.dataset.cat)), ['print'], '印刷・製本出力だけ');
  eq(await page.$$eval('#cat-print .subnav a', e => e.map(x => x.textContent)), ['印刷の画質', '製本用PDF出力', '付属・ファイル名'], '細かい分類');
  assert(await page.isHidden('#catHome'), '入口は隠れる');
  await page.click('#cat-print .cat-back');
  await sleep(300);
  assert(await page.isVisible('#catHome'), 'トップに戻る');
  const groups = {
    read: ['sec-launch', 'sec-view', 'sec-ebook'],
    pages: ['sec-scan', 'sec-copy', 'sec-collect'],
    print: ['sec-print', 'sec-bind', 'sec-bindfiles'],
    manage: ['sec-guard', 'sec-data', 'sec-perf', 'sec-about'],
  };
  for (const [cat, secs] of Object.entries(groups)) {
    eq(await page.$$eval(`#cat-${cat} section h3`, e => e.map(x => x.id)), secs, `分類 ${cat} の項目`);
  }
  // 項目の置き場所
  const inCat = id => page.evaluate(id => document.getElementById(id)?.closest('.cat')?.dataset.cat || null, id);
  eq(
    [await inCat('printQuality') ?? (await page.evaluate(() => document.querySelector('input[name="printQuality"]').closest('.cat').dataset.cat)), await inCat('bindImpose'), await inCat('guardEnabled'), await inCat('rolesBody'), await inCat('backupExport'), await inCat('perfLog'), await inCat('resetAll'), await inCat('comicSplitSpreads'), await inCat('scanTrim'), await inCat('collectLimitMB')],
    ['print', 'print', 'manage', 'manage', 'manage', 'manage', 'manage', 'read', 'pages', 'pages'],
    '項目の分類'
  );
  await page.goto(`${OPTIONS}#sec-copy`);
  await sleep(400);
  eq(await page.$$eval('.cat', e => e.filter(x => !x.hidden).map(x => x.dataset.cat)), ['pages'], '#sec-copy でスキャン・ページ操作');
  await page.close();
});

await R.run('N9', '詳細設定の新しい項目(回転ボタン・スキャンの読む向き・1ページ目・プレビュー・項目の表)を保存できる', async () => {
  const page = watch(await ctx.newPage());
  await page.goto(`${OPTIONS}#read`);
  await sleep(400);
  await page.selectOption('#rotateStep', '180');
  await sleep(300);
  eq((await getSettings(sw)).rotateStep, 180, '回転ボタン');
  await page.goto(`${OPTIONS}#pages`);
  await sleep(300);
  await page.check('input[name="scanDirection"][value="rtl"]');
  await page.check('input[name="scanFirstPage"][value="last"]');
  await page.goto(`${OPTIONS}#print`);
  await sleep(300);
  await page.uncheck('#bindHidePreview');
  await page.fill('#optRi-new', '別紙');
  await page.click('#optRi-add');
  await sleep(400);
  const s = await getSettings(sw);
  eq([s.scanDirection, s.scanFirstPage, s.bindHidePreview, s.bindRoleItems.some(i => i.label === '別紙')], ['rtl', 'last', false, true], '保存');
  assert((await page.textContent('#bindNameSuffixEcho')).includes('元の名前_製本.pdf'), 'ファイル名の例');
  await setSettings(sw, { rotateStep: -90, scanDirection: 'binding', scanFirstPage: 'first', bindHidePreview: true, bindRoleItems: undefined });
  await page.close();
});

// ---------------------------------------------------------------------------
// スキャンの整え
// ---------------------------------------------------------------------------
const haveKokugo = fs.existsSync(KOKUGO);
if (haveKokugo) {
  const arrangedOrder = page => page.evaluate(() => window.__seihonViewer.scanArranger.arranged?.pages.map(p => `${p.src + 1}${p.half || ''}`).join(' '));
  const openKokugo = async () => {
    await sw.evaluate(() => chrome.storage.local.remove('scanChoices'));
    const page = await open('/files/kokugo2018.pdf');
    await page.waitForFunction(() => window.__seihonViewer.scanArranger.state === 'arranged', null, { timeout: 60000 });
    return page;
  };

  await R.run('N10', '国語のスキャン(ノドの影が上の端だけ・太い罫線あり): 見開きと判断して、ノドで分ける', async () => {
    await setSettings(sw, { bindingDirection: 'ltr', scanDirection: 'rtl', scanFirstPage: 'first' });
    const page = await openKokugo();
    const info = await page.evaluate(() => {
      const a = window.__seihonViewer.scanArranger;
      return { kind: a.base.kind, gutters: a.base.scans.map(s => s && Math.round((s.gutter.x / s.width) * 100)) };
    });
    eq(info.kind, 'spread', '見開き');
    assert(info.gutters.every(g => g >= 49 && g <= 52), `ノドの位置(幅の%): ${info.gutters}`);
    eq(await arrangedOrder(page), '1R 1L 2R 2L 3R 3L 4R 4L 5R 5L 6R 6L', '右から左に読む順');
    eq(await page.evaluate(() => window.__seihonViewer.book.direction), 'rtl', '表示も右綴じ');
    await page.close();
    // ほかの PDF を開くと、設定の綴じ方向に戻る
    const other = await open('/pdf/book-8.pdf');
    eq(await other.evaluate(() => window.__seihonViewer.book.direction), 'ltr', 'ほかの PDF では設定の綴じ方向');
    await other.close();
    return info.gutters.join(',');
  });

  await R.run('N11', '「スキャンを整える」: 本を読む向き・PDF の1ページ目を選ぶと、その順で表示し、覚えておく', async () => {
    await setSettings(sw, { scanDirection: 'binding', scanFirstPage: 'first', bindingDirection: 'ltr' });
    const page = await openKokugo();
    eq(await arrangedOrder(page), '1L 1R 2L 2R 3L 3R 4L 4R 5L 5R 6L 6R', '初期値(綴じ方向に合わせる = 左から右)');
    await page.evaluate(() => window.__seihonViewer.scanDialog.open());
    await page.waitForFunction(() => !document.getElementById('shScanApply').disabled, null, { timeout: 30000 });
    eq(await page.isChecked('input[name="shScanFirstPage"][value="first"]'), true, '1ページ目: 最初のほう');
    await page.check('input[name="shScanDirection"][value="rtl"]');
    await page.check('input[name="shScanFirstPage"][value="last"]');
    await page.click('#shScanApply');
    await page.waitForFunction(() => window.__seihonViewer.scanArranger.arranged?.options.reverse === true, null, { timeout: 30000 });
    await page.waitForFunction(() => window.__seihonViewer.scanArranger.state === 'arranged');
    eq(await arrangedOrder(page), '6R 6L 5R 5L 4R 4L 3R 3L 2R 2L 1R 1L', '右から左・最後の見開きから');
    eq(await page.evaluate(() => window.__seihonViewer.book.direction), 'rtl', '右綴じで表示');
    eq(await page.evaluate(() => window.__seihonViewer.app.page), 1, '1ページ目から');
    const choices = await sw.evaluate(async () => Object.values((await chrome.storage.local.get('scanChoices')).scanChoices || {}));
    assert(choices.some(c => c.direction === 'rtl' && c.reverse), '覚える');
    await page.close();
  });

  await R.run('N12', '国語のスキャン: ノドの影を切り取る(左右のページの内側の端に、影の濃い帯が残らない)', async () => {
    await setSettings(sw, { scanDirection: 'rtl', scanFirstPage: 'first' });
    const page = await openKokugo();
    const b64 = await page.evaluate(async () => {
      const d = await window.__seihonViewer.app.pdfDocument.getData();
      let s = '';
      for (let i = 0; i < d.length; i += 0x8000) {
        s += String.fromCharCode(...d.subarray(i, i + 0x8000));
      }
      return btoa(s);
    });
    const file = path.join(env.downloadsDir, 'kokugo-arranged.pdf');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    const out = [];
    for (const [pageNo, side] of [[1, 'L'], [2, 'R'], [3, 'L'], [4, 'R']]) {
      // ページの内側(ノド側)の端 2mm の明るさの中央値(本文の高さ)
      const root = path.join(env.downloadsDir, `edge-${pageNo}`);
      execFileSync('pdftoppm', ['-r', '60', '-gray', '-singlefile', '-f', String(pageNo), '-l', String(pageNo), file, root]);
      const pgm = parsePgm(fs.readFileSync(`${root}.pgm`));
      const k = Math.max(2, Math.round((2 / 25.4) * 60));
      const xs = side === 'R' ? [...Array(k).keys()].map(i => pgm.width - 1 - i) : [...Array(k).keys()];
      // 1ページ目(右から左の順の1番目)は、元の見開きの右のページ = ノドは左の端
      const vals = [];
      for (let y = Math.floor(pgm.height * 0.15); y < pgm.height * 0.85; y++) {
        for (const x of xs) {
          vals.push(pgm.data[y * pgm.width + x]);
        }
      }
      vals.sort((a, b) => a - b);
      out.push(vals[vals.length >> 1]);
    }
    assert(out.every(v => v >= 215), `内側の端の明るさ: ${out}`);
    await page.close();
    await setSettings(sw, { scanDirection: 'binding' });
    return out.join(',');
  });
}

function parsePgm(buf) {
  // P5 の画像(見出し: "P5 幅 高さ 255" の後に画素)
  const head = buf.subarray(0, 64).toString('latin1');
  const m = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(head);
  if (!m) {
    throw new Error('PGM を読めませんでした');
  }
  return { width: Number(m[1]), height: Number(m[2]), data: buf.subarray(m[0].length) };
}

const sum = R.summary();
if (errors.length) {
  console.log('--- ページのエラー(参考) ---');
  console.log([...new Set(errors)].slice(0, 30).join('\n'));
}
await env.close();
process.exit(sum.ok === sum.total ? 0 : 1);
