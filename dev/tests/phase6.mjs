// 0.2(フェーズ1)の受け入れ試験: 最高画質・コピー・表示モード・ページに合わせる・役割・元の場所
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  BASE, DEV, EXT, EXT_ID, KIOSK_PRINT, PDFS, Results, SP, VIEWER, assert, clearDir, clickMenuItem, contextMenuAt, eq, imageSize,
  launch, listFiles, openViewer, pdfImages, pdfInfo, pdfText, readClipboard, setClipboardText, setSettings, getSettings,
  sleep, viewerState, viewerUrl, waitForFile, waitToast, waitViewerReady,
} from './lib.mjs';

const R = new Results('Phase 6 (0.2)');
let env = await launch();
const { ctx } = env;
const errors = [];
ctx.on('weberror', e => errors.push(String(e.error())));

async function open(src, opts) {
  const page = await openViewer(ctx, src, opts);
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  return page;
}
const dl = () => env.downloadsDir;
const V = page => page.evaluate.bind(page);

// ---------------------------------------------------------------------------
// 表示モード・綴じ方向・ページに合わせる
// ---------------------------------------------------------------------------
await R.run('V1', '表示モードのボタンは、押すたびに 単ページ → 製本表示 → 見開き → 単ページ と切り替わる', async () => {
  const page = await open('/pdf/book-8.pdf');
  const seq = [(await viewerState(page)).mode];
  for (let i = 0; i < 3; i++) {
    await page.click('#shViewMode');
    await sleep(300);
    seq.push((await viewerState(page)).mode);
  }
  eq(seq, ['book', 'spread', 'single', 'book'], '切り替わる順番');
  const popups = await page.$$eval('.sh-popup:not([hidden])', els => els.length);
  eq(popups, 0, 'メニューは出ない');
  const title = await page.getAttribute('#shViewMode', 'title');
  assert(/製本表示/.test(title) && /見開き/.test(title), `説明: ${title}`);
  const spread = await page.evaluate(() => window.__seihonViewer.app.pdfViewer.spreadMode);
  eq(spread, 2, 'PDF.js の見開きの設定');
  await page.close();
  return seq.join(' → ');
});

await R.run('V2', '綴じ方向のボタン(表示モードの右)で左綴じ・右綴じが切り替わり、設定に保存される。右綴じは ← で次のページ', async () => {
  const page = await open('/pdf/book-8.pdf');
  const order = await page.$$eval('#shCenter button', els => els.map(e => e.id));
  assert(order.indexOf('shBindDir') === order.indexOf('shViewMode') + 1, `並び: ${order.join(',')}`);
  await page.click('#shBindDir');
  await sleep(500);
  const st = await viewerState(page);
  eq(st.direction, 'rtl', '右綴じになる');
  eq((await getSettings(env.sw)).bindingDirection, 'rtl', '設定に保存');
  const icon = await page.getAttribute('#shBindDir', 'data-icon');
  eq(icon, 'bind-rtl', 'アイコン');
  await page.locator('#viewerContainer').click({ position: { x: 20, y: 300 } });
  await page.evaluate(() => (window.__seihonViewer.app.page = 2));
  await sleep(300);
  await page.keyboard.press('ArrowLeft');
  await sleep(400);
  const after = (await viewerState(page)).page;
  assert(after > 2, `← で次へ(${after})`);
  await page.click('#shBindDir');
  await sleep(400);
  eq((await viewerState(page)).direction, 'ltr', '左綴じに戻る');
  eq((await getSettings(env.sw)).bindingDirection, 'ltr', '設定も戻る');
  await page.close();
});

/** 合わせたあとのページ(見開き)の位置 */
async function fitGeometry(page) {
  return page.evaluate(() => {
    const v = window.__seihonViewer.app.pdfViewer;
    const c = v.container;
    const cr = c.getBoundingClientRect();
    const div = v.getPageView(v.currentPageNumber - 1).div;
    const t = v.spreadMode !== 0 && div.parentElement.classList.contains('spread') ? div.parentElement : div;
    const r = t.getBoundingClientRect();
    const pr = div.getBoundingClientRect();
    return {
      page: v.currentPageNumber,
      scaleValue: v.currentScaleValue,
      centerOffset: Math.round(r.top + r.height / 2 - (cr.top + c.clientHeight / 2)),
      pageTop: Math.round(pr.top - cr.top),
      pageBottom: Math.round(cr.top + c.clientHeight - pr.bottom),
      pageLeft: Math.round(pr.left - cr.left),
      pageRight: Math.round(cr.left + c.clientWidth - pr.right),
    };
  });
}

await R.run('V3', '「ページに合わせる」: ページの間を見ていても、いちばん大きく見えている見開きを真ん中にして画面に収める', async () => {
  const page = await open('/pdf/book-8.pdf');
  // 2-3 の見開きが下に多く見える位置(1ページ目の下の方と 2-3 ページ目の上の方)にする
  await page.evaluate(() => {
    const v = window.__seihonViewer.app.pdfViewer;
    const div = v.getPageView(1).div.parentElement;
    v.container.scrollTop = div.offsetTop - v.container.clientHeight * 0.35;
  });
  await sleep(500);
  await page.click('#shFit'); // 「ページに合わせる」
  await sleep(700);
  const g = await fitGeometry(page);
  eq(g.scaleValue, 'page-fit', '倍率の指定');
  assert(g.page === 2 || g.page === 3, `いちばん大きく見えていた見開き(2-3)が対象(${g.page})`);
  assert(Math.abs(g.centerOffset) <= 2, `真ん中(ずれ ${g.centerOffset}px)`);
  assert(g.pageTop >= -2 && g.pageBottom >= -2, `ページ全体が画面に入る(上 ${g.pageTop} 下 ${g.pageBottom})`);
  // 1ページ目がいちばん大きく見えているとき
  await page.evaluate(() => {
    const v = window.__seihonViewer.app.pdfViewer;
    v.currentScaleValue = '1.3';
  });
  await sleep(300);
  await page.evaluate(() => {
    const v = window.__seihonViewer.app.pdfViewer;
    const div = v.getPageView(0).div;
    v.container.scrollTop = div.offsetTop + div.offsetHeight * 0.45;
  });
  await sleep(400);
  const vis = await page.evaluate(() => window.__seihonViewer.book.mostVisiblePage());
  await page.evaluate(() => window.__seihonViewer.toolbar.setNextFit('page-fit'));
  await page.click('#shFit');
  await sleep(700);
  const g2 = await fitGeometry(page);
  eq(g2.page, vis, '大きく見えていたページ');
  assert(Math.abs(g2.centerOffset) <= 2, `真ん中(ずれ ${g2.centerOffset}px)`);
  await page.close();
  return `見開き 2-3: ずれ ${g.centerOffset}px / ${vis}ページ目: ずれ ${g2.centerOffset}px`;
});

await R.run('V4', '単ページの表示でも「ページに合わせる」でページが真ん中に収まり、もう一度押すと「幅に合わせる」', async () => {
  const page = await open('/pdf/sample.pdf');
  await page.click('#shViewMode'); // book → spread
  await page.click('#shViewMode'); // spread → single
  await sleep(300);
  eq((await viewerState(page)).mode, 'single', '単ページ');
  await page.evaluate(() => {
    const v = window.__seihonViewer.app.pdfViewer;
    const div = v.getPageView(4).div;
    v.container.scrollTop = div.offsetTop + div.offsetHeight * 0.6;
  });
  await sleep(400);
  const target = await page.evaluate(() => window.__seihonViewer.book.mostVisiblePage());
  await page.evaluate(() => window.__seihonViewer.toolbar.setNextFit('page-fit'));
  await page.click('#shFit');
  await sleep(700);
  const g = await fitGeometry(page);
  eq(g.page, target, '対象のページ');
  assert(Math.abs(g.centerOffset) <= 2, `真ん中(${g.centerOffset})`);
  assert(g.pageTop >= -2 && g.pageBottom >= -2, `収まる(${g.pageTop}/${g.pageBottom})`);
  assert(Math.abs(g.pageLeft - g.pageRight) <= 16, `左右も真ん中(${g.pageLeft}/${g.pageRight})`);
  await page.click('#shFit');
  await sleep(500);
  eq((await viewerState(page)).scaleValue, 'page-width', '2回目は幅に合わせる');
  await page.close();
  return `${target}ページ目`;
});

await R.run('V5', '大きさの違うページの PDF でも、合わせた見開きが画面に収まる(表紙だけ大きい本)', async () => {
  const page = await open('/pdf/mixed-8.pdf');
  await page.evaluate(() => window.__seihonViewer.toolbar.setNextFit('page-fit'));
  await page.click('#shFit');
  await sleep(700);
  const g = await fitGeometry(page);
  assert(g.pageTop >= -2 && g.pageBottom >= -2, `表紙が収まる(${g.pageTop}/${g.pageBottom})`);
  // 8ページ目(大きさが違う裏表紙)に移ってから合わせる
  await page.evaluate(() => {
    const v = window.__seihonViewer.app.pdfViewer;
    v.currentPageNumber = 8;
  });
  await sleep(400);
  await page.evaluate(() => window.__seihonViewer.toolbar.setNextFit('page-fit'));
  await page.click('#shFit');
  await sleep(700);
  const g8 = await fitGeometry(page);
  eq(g8.page, 8, '8ページ目');
  assert(g8.pageTop >= -2 && g8.pageBottom >= -2 && Math.abs(g8.centerOffset) <= 2, `8ページ目も収まる(${JSON.stringify(g8)})`);
  await page.close();
});

await R.run('V6', 'ツールバーのボタンが重ならない(1280px・900px の幅)', async () => {
  const out = [];
  for (const width of [1280, 900]) {
    const page = await ctx.newPage();
    await page.setViewportSize({ width, height: 800 });
    await page.goto(viewerUrl('/pdf/book-8.pdf'));
    await waitViewerReady(page);
    await sleep(400);
    const boxes = await page.evaluate(() => {
      const r = el => {
        const b = el.getBoundingClientRect();
        return { l: b.left, r: b.right, w: b.width };
      };
      const start = [...document.querySelectorAll('.sh-start > *')].filter(e => e.offsetWidth).map(r);
      const center = r(document.getElementById('shCenter'));
      const end = [...document.querySelectorAll('.sh-end > *')].filter(e => e.offsetWidth && !e.hidden).map(r);
      return { start, center, end, src: r(document.getElementById('shSource')) };
    });
    const startRight = Math.max(...boxes.start.map(b => b.r));
    const endLeft = Math.min(...boxes.end.map(b => b.l));
    assert(startRight <= boxes.center.l + 1, `${width}px: 左側が中央に重ならない(${startRight} > ${boxes.center.l})`);
    assert(endLeft >= boxes.center.r - 1, `${width}px: 右側が中央に重ならない(${endLeft} < ${boxes.center.r})`);
    out.push(`${width}px OK`);
    await page.close();
  }
  return out.join(' / ');
});

// ---------------------------------------------------------------------------
// ページ役割
// ---------------------------------------------------------------------------
const NEW_ROLE_LABELS = ['カバーの表紙', 'カバーの裏表紙', '表紙', '裏表紙', '帯', '表紙の折り返し', '裏表紙の折り返し', 'しおり'];

await R.run('R1', '右クリックの「ページ役割」に新しい名前の8つの役割が並び、サムネイルのバッジは短い名前', async () => {
  const page = await open('/pdf/book-10.pdf');
  await contextMenuAt(page, '.page[data-page-number="1"]');
  await clickMenuItem(page, 'ページ役割');
  await page.waitForSelector('.sh-context-menu .sh-menu-header');
  const labels = await page.$$eval('.sh-context-menu [role="menuitemradio"] .sh-menu-label', els => els.map(e => e.textContent));
  eq(labels, NEW_ROLE_LABELS, '役割の名前');
  await clickMenuItem(page, 'カバーの表紙');
  await sleep(500);
  await page.evaluate(() => window.__seihonViewer.pageRoles.set([5], 'bookmark'));
  await page.evaluate(() => window.__seihonViewer.app.viewsManager?.switchView(1, true));
  await page.waitForSelector('#thumbnailsView .thumbnail[page-number="5"] .sh-role-badge', { timeout: 10000 });
  const badges = await page.$$eval('#thumbnailsView .sh-role-badge', els => els.map(e => `${e.textContent}|${e.title}`));
  assert(badges.includes('カバー表|ページ役割: カバーの表紙'), `バッジ: ${badges}`);
  assert(badges.includes('しおり|ページ役割: しおり'), `バッジ: ${badges}`);
  await page.evaluate(() => window.__seihonViewer.pageRoles.clear());
  await page.close();
  return badges.join(', ');
});

/** 製本用PDF出力の画面を開く */
async function openBindDialog(page) {
  await page.click('#shBindOutput');
  await page.waitForFunction(() => document.getElementById('shBindDialog').open && !document.getElementById('shBindRun').disabled, null, { timeout: 15000 });
  await sleep(200);
}

await R.run('R2', '製本用PDF出力の画面: カバーの表紙〜しおりの欄があり、帯は「ページを追加」で何ページでも選べ、× で外せる', async () => {
  const page = await open('/pdf/book-10.pdf');
  await page.evaluate(() => window.__seihonViewer.pageRoles.clear());
  await openBindDialog(page);
  const labels = await page.$$eval('.sh-bind-grid > label', els => els.map(e => e.textContent.replace('(複数可)', '')));
  // 0.5: 欄は詳細設定の「カバー・表紙・帯などの項目」の並び(初期値はページ役割の並びと同じ)
  eq(labels, ['カバーの表紙', 'カバーの裏表紙', '表紙', '裏表紙', '帯', '表紙の折り返し', '裏表紙の折り返し', 'しおり'], '欄の名前');
  await page.selectOption('#shBindObiAdd', '2'); // 3ページ目
  await page.waitForFunction(() => document.querySelectorAll('#shBindObiItems .sh-multi-item').length === 1);
  await page.selectOption('#shBindObiAdd', '3'); // 4ページ目
  await page.waitForFunction(() => document.querySelectorAll('#shBindObiItems .sh-multi-item').length === 2);
  await page.selectOption('#shBindObiAdd', '6'); // 7ページ目
  await page.waitForFunction(() => document.querySelectorAll('#shBindObiItems .sh-multi-item').length === 3);
  let obi = await page.evaluate(() => window.__seihonViewer.pageRoles.pages('obi'));
  eq(obi, [3, 4, 7], '帯のページ');
  await page.click('#shBindObiItems .sh-multi-item[data-page-index="6"] .sh-multi-del');
  await page.waitForFunction(() => document.querySelectorAll('#shBindObiItems .sh-multi-item').length === 2);
  obi = await page.evaluate(() => window.__seihonViewer.pageRoles.pages('obi'));
  eq(obi, [3, 4], '外した後');
  // 単独の欄(しおり)
  await page.selectOption('#shBindBookmark', '4');
  await page.waitForFunction(() => window.__seihonViewer.pageRoles.pages('bookmark').join() === '5');
  const summary = await page.textContent('#shBindSummary');
  assert(/付属\(帯・しおり\)/.test(summary), `概要: ${summary}`);
  assert(/3、4、5ページ目/.test(summary), `付属のページ: ${summary}`);
  await page.click('#shBindCancel');
  await page.evaluate(() => window.__seihonViewer.pageRoles.clear());
  await page.close();
  return summary.replace(/\n/g, ' / ');
});

await R.run('R3', '出力: カバーの表紙・裏表紙は本体の最初・最後、表紙・帯(2枚)・しおりは「_付属.pdf」にページ順で入る', async () => {
  clearDir(dl());
  await setSettings(env.sw, { bindImpose: false });
  const page = await open('/pdf/book-10.pdf');
  await page.evaluate(async () => {
    const r = window.__seihonViewer.pageRoles;
    await r.clear();
    await r.setMany([
      { pages: [1], role: 'cover' },
      { pages: [2], role: 'obiFront' },
      { pages: [3, 4], role: 'obi' },
      { pages: [5], role: 'bookmark' },
      { pages: [10], role: 'back' },
    ]);
  });
  await openBindDialog(page);
  const files = await page.textContent('#shBindFiles');
  assert(/book-10_製本\.pdf/.test(files) && /book-10_付属\.pdf/.test(files), `保存するファイル: ${files}`);
  await page.click('#shBindRun');
  await page.waitForFunction(() => !document.getElementById('shBindResult').hidden, null, { timeout: 30000 });
  const body = await waitForFile(dl(), f => f === 'book-10_製本.pdf');
  const extra = await waitForFile(dl(), f => f === 'book-10_付属.pdf');
  const bodyPages = pdfInfo(body).pages;
  eq(bodyPages, 8, '本体のページ数(6ページ + 白紙2枚)');
  const first = pdfText(body, 1);
  const last = pdfText(body, 8);
  assert(/page 1 of 10/.test(first), `最初のページ: ${first.slice(0, 60)}`);
  assert(/page 10 of 10/.test(last), `最後のページ: ${last.slice(0, 60)}`);
  const extraPages = pdfInfo(extra).pages;
  eq(extraPages, 4, '付属のページ数');
  const order = [1, 2, 3, 4].map(i => /page (\d+) of 10/.exec(pdfText(extra, i))?.[1]);
  eq(order, ['2', '3', '4', '5'], '付属の並び(元のページの順)');
  const result = await page.textContent('#shBindResultFiles');
  assert(/付属\(4ページ\)/.test(result), `結果の表示: ${result}`);
  await page.click('#shBindResultClose');
  await page.evaluate(() => window.__seihonViewer.pageRoles.clear());
  await setSettings(env.sw, { bindImpose: true });
  await page.close();
  return `本体 ${bodyPages}ページ / 付属 ${order.join(',')}`;
});

await R.run('R4', '使い道: 「表紙」を「最初のページの候補」にすると、そのページを本の最初のページに選べる', async () => {
  const page = await open('/pdf/book-10.pdf');
  await page.evaluate(async () => {
    const r = window.__seihonViewer.pageRoles;
    await r.clear();
    await r.setMany([
      { pages: [1], role: 'cover' },
      { pages: [2], role: 'obiFront' },
    ]);
  });
  await openBindDialog(page);
  await page.evaluate(() => (document.getElementById('shBindDetails').open = true));
  const useLabels = await page.$$eval('.sh-bind-uses label:not([hidden])', els => els.map(e => e.textContent.trim().split(/\s/)[0]));
  eq(useLabels, ['表紙'], '使い道の欄は、その PDF にある付属の役割だけ');
  const options = await page.$$eval('#shBindUseObiFront option', els => els.map(e => e.textContent));
  eq(options, ['付属として出力', '最初のページの候補', '最後のページの候補', '出力しない'], '使い道の選択肢');
  await page.selectOption('#shBindUseObiFront', 'cover');
  await sleep(300);
  await page.selectOption('#shBindCover', '1'); // 2ページ目(表紙)
  await sleep(400);
  const plan = await page.evaluate(() => window.__seihonViewer.bindDialog.plan);
  eq(plan.cover, 1, '最初のページは2ページ目(表紙)');
  assert(!plan.body.includes(0), '選ばなかったカバーの表紙は本文に入らない');
  const summary = await page.textContent('#shBindSummary');
  assert(/最初のページ: 2ページ目\(表紙\)/.test(summary), `概要: ${summary}`);
  await page.click('#shBindCancel');
  await page.evaluate(() => window.__seihonViewer.pageRoles.clear());
  await page.close();
  return summary.split('\n')[0];
});

await R.run('R7', '製本用PDF(面付けあり・なし)でも、スキャンの画像は元の解像度のまま、OCR の文字も残る', async () => {
  clearDir(dl());
  const page = await open('/files/ocr-sample.pdf');
  await page.evaluate(() => window.__seihonViewer.pageRoles.clear());
  await openBindDialog(page);
  await page.click('#shBindRun');
  await page.waitForFunction(() => !document.getElementById('shBindResult').hidden, null, { timeout: 30000 });
  const imposed = await waitForFile(dl(), f => f === 'ocr-sample_製本_面付け.pdf');
  assert(/quick brown fox/.test(pdfText(imposed)), '面付けした PDF にも OCR の文字');
  const imgs = pdfImages(imposed);
  assert(imgs.length >= 3 && imgs.every(i => i.width === 875 && i.height === 1240), `画像は元のまま: ${imgs.map(i => `${i.width}x${i.height}`)}`);
  await page.click('#shBindResultClose');
  await page.close();
  return `${imgs.length} 枚の画像(875×1240)`;
});

await R.run('R5', '詳細設定の「付属の役割の使い道」に6つの役割の欄があり、変えると保存される', async () => {
  const page = await ctx.newPage();
  // 0.5: 「印刷・製本出力」の「付属・ファイル名」
  await page.goto(`chrome-extension://${EXT_ID}/options/options.html#sec-bindfiles`);
  await page.waitForSelector('#bindUseBookmark');
  const labels = await page.$$eval('.use-grid label', els => els.map(e => e.textContent));
  eq(labels, ['表紙', '裏表紙', '帯', '表紙の折り返し', '裏表紙の折り返し', 'しおり'], '欄');
  await page.selectOption('#bindUseBookmark', 'none');
  await sleep(500);
  eq((await getSettings(env.sw)).bindUseBookmark, 'none', '保存');
  await page.selectOption('#bindUseBookmark', 'obi');
  await sleep(300);
  const outLabel = await page.textContent('section[aria-labelledby="sec-bindfiles"]');
  assert(/付属の出力/.test(outLabel) && !/帯の出力/.test(outLabel), '「付属の出力」');
  await page.close();
});

await R.run('R6', '0.1 から更新すると、初期値のままだった設定は新しい初期値になる(自分で選んだ値は残る)', async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/options/options.html`);
  const r = await page.evaluate(async () => {
    const m = await import('/common/settings.js');
    return {
      old: m.migrateSettings({ printQuality: 'auto', aiCopyMulti: 'pdf', bindObiSuffix: '_帯', imageQuality: undefined }, '0.1.0'),
      chosen: m.migrateSettings({ printQuality: 'high', aiCopyMulti: 'zip', bindObiSuffix: '_おまけ' }, '0.1.0'),
      newer: m.migrateSettings({ printQuality: 'auto' }, '0.2.0'),
      defaults: { printQuality: m.DEFAULT_SETTINGS.printQuality, imageQuality: m.DEFAULT_SETTINGS.imageQuality, aiCopyMulti: m.DEFAULT_SETTINGS.aiCopyMulti },
    };
  });
  eq([r.old.printQuality, r.old.aiCopyMulti, r.old.bindObiSuffix, r.old.imageQuality], ['max', 'pdf-copy', '_付属', 'max'], '初期値のままだったもの');
  eq(r.chosen, null, '自分で選んだ値は変えない');
  eq(r.newer, null, '0.2 以降からの更新では変えない');
  eq(r.defaults, { printQuality: 'max', imageQuality: 'max', aiCopyMulti: 'pdf-copy' }, '新しい初期値');
  await page.close();
});

// ---------------------------------------------------------------------------
// コピー・画像の画質
// ---------------------------------------------------------------------------
await R.run('C1', '右クリックメニューは「コピー」「画像として保存」(「AI用」は無い)。文字を選んでいるときは「選択した文字をコピー」', async () => {
  const page = await open('/pdf/book-8.pdf');
  const items = await contextMenuAt(page, '.page[data-page-number="1"]');
  // 0.5: 「このページだけの PDF として保存」は外した
  eq(items.slice(0, 3), ['コピー', '画像として保存', '収集に追加'], '上の3つ');
  assert(!items.includes('このページだけの PDF として保存'), `外した項目が無い: ${items}`);
  assert(!items.some(t => /AI/.test(t)), `AI の文字が無い: ${items}`);
  await page.keyboard.press('Escape');
  // 文字を選ぶ
  await page.evaluate(() => {
    const span = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].find(s => /quick brown/.test(s.textContent));
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  const items2 = await contextMenuAt(page, '.page[data-page-number="1"] .textLayer span:has-text("quick brown")', { x: 0.3, y: 0.5 });
  assert(items2[0] === '選択した文字をコピー', `文字のコピー: ${items2.slice(0, 3)}`);
  await page.keyboard.press('Escape');
  await page.close();
  return items.slice(0, 3).join(' / ');
});

await R.run('C2', '最高画質(初期値): 文字のページのコピーは 600dpi の画像になる', async () => {
  const s = await getSettings(env.sw);
  eq(s.imageQuality ?? 'max', 'max', '初期値');
  const page = await open('/pdf/book-8.pdf');
  await setClipboardText(ctx, 'x', page);
  await contextMenuAt(page, '.page[data-page-number="1"]');
  await clickMenuItem(page, 'コピー');
  const msg = await waitToast(page, /コピーしました|保存しました|できませんでした/);
  const clip = await readClipboard(ctx, page);
  const img = clip.find(c => c.type === 'image/png');
  assert(img, `画像が入る: ${JSON.stringify(clip)}`);
  // 420×595pt を 600dpi で: 3500×4958
  assert(Math.abs(img.width - 3500) <= 2 && Math.abs(img.height - 4958) <= 2, `大きさ ${img.width}×${img.height}`);
  await page.close();
  return `${img.width}×${img.height}(${msg.slice(0, 40)}…)`;
});

await R.run('C3', '最高画質: スキャンのページのコピーは元の画像の解像度(8598×6070)になる', async () => {
  const page = await open('/files/scan1.pdf');
  await setClipboardText(ctx, 'x', page);
  const t0 = Date.now();
  await page.evaluate(() => window.__seihonViewer.pageCopy.copySinglePage(1));
  await waitToast(page, /コピーしました|保存しました|できませんでした/);
  const ms = Date.now() - t0;
  const clip = await readClipboard(ctx, page);
  const img = clip.find(c => c.type === 'image/png');
  assert(img && img.width === 8598 && img.height === 6070, `大きさ ${JSON.stringify(clip)}`);
  await page.close();
  return `${img.width}×${img.height}、${ms} ms`;
});

/** PDF のページの画像(JPEG)のデータをそのまま取り出す */
function embeddedJpeg(file, pageIndex) {
  const out = execFileSync('python3', ['-I', '-c', `
import sys, hashlib, pikepdf
pdf = pikepdf.open(sys.argv[1])
page = pdf.pages[int(sys.argv[2])]
for name, xo in page.Resources.XObject.items():
    if xo.get('/Subtype') == '/Image':
        print(hashlib.md5(xo.read_raw_bytes()).hexdigest(), len(xo.read_raw_bytes()))
        break
`, file, String(pageIndex)], { encoding: 'utf8' }).trim().split(' ');
  return { md5: out[0], size: Number(out[1]) };
}
const md5 = file => execFileSync('md5sum', [file], { encoding: 'utf8' }).split(' ')[0];

await R.run('C4', '最高画質: スキャンのページの「画像として保存」は、元の JPEG をそのまま取り出す(作り直さない)', async () => {
  clearDir(dl());
  const page = await open('/files/scan1.pdf');
  await contextMenuAt(page, '.page[data-page-number="1"]');
  await clickMenuItem(page, '画像として保存');
  await waitToast(page, /画像を保存しました/);
  const file = await waitForFile(dl(), f => /^scan1_p1\.jpg$/.test(f));
  const orig = embeddedJpeg(`${PDFS}/scan1.pdf`, 0);
  eq(md5(file), orig.md5, '元の JPEG と同じデータ');
  const size = imageSize(file);
  eq([size.width, size.height], [8598, 6070], '大きさ');
  await page.close();
  return `${path.basename(file)} ${(orig.size / 1024).toFixed(0)} KB(元と同じ)`;
});

await R.run('C5', 'OCR の文字があるスキャンも元の JPEG で保存。画質「高画質」では長辺 2400 の PNG', async () => {
  clearDir(dl());
  const page = await open('/files/ocr-sample.pdf');
  await page.evaluate(() => window.__seihonViewer.pageCopy.savePageImage(1));
  await waitToast(page, /画像を保存しました/);
  const jpg = await waitForFile(dl(), f => f === 'ocr-sample_p1.jpg');
  eq(md5(jpg), embeddedJpeg(`${PDFS}/ocr-sample.pdf`, 0).md5, '元の JPEG');
  await setSettings(env.sw, { imageQuality: 'high' });
  await sleep(400);
  await page.evaluate(() => window.__seihonViewer.pageCopy.savePageImage(2));
  await waitToast(page, /画像を保存しました: ocr-sample_p2\.png/);
  const png = await waitForFile(dl(), f => f === 'ocr-sample_p2.png');
  const s = imageSize(png);
  eq(Math.max(s.width, s.height), 2400, '長辺');
  await setSettings(env.sw, { imageQuality: 'max' });
  await page.close();
  return `JPEG(元のまま)/ PNG ${s.width}×${s.height}`;
});

await R.run('C6', '複数ページのコピー(既定は PDF としてコピー): 補助プログラムが無ければ「製本ビューア_コピー」に保存し、場所をクリップボードへ。OCR の文字も残る', async () => {
  clearDir(dl());
  const page = await open('/files/ocr-sample.pdf');
  await page.evaluate(() => window.__seihonViewer.thumbSelection.setSelectMode?.(false));
  await setClipboardText(ctx, 'x', page);
  await page.evaluate(() => window.__seihonViewer.pageCopy.copyPages([1, 3]));
  const msg = await waitToast(page, /クリップボードにコピーしました|保存しました/);
  const file = await waitForFile(dl(), f => /^製本ビューア_コピー\/ocr-sample_抜粋_\d{8}_\d{6}\.pdf$/.test(f));
  eq(pdfInfo(file).pages, 2, 'ページ数');
  assert(/quick brown fox/.test(pdfText(file)), 'OCR の文字が残る');
  const clip = await readClipboard(ctx, page);
  const text = clip.find(c => c.type === 'text/plain')?.text;
  eq(text, file, 'ファイルの場所がクリップボードに入る');
  assert(/ファイルの場所をクリップボードにコピーしました/.test(msg) && /補助プログラム/.test(msg), `通知: ${msg}`);
  await page.close();
  return path.relative(dl(), file);
});

/** 収集に2つの PDF のページを入れる */
async function prepareCollection() {
  const a = await open('/pdf/book-8.pdf');
  await a.evaluate(async () => {
    const v = window.__seihonViewer;
    const db = await import('/common/db.js');
    await db.clearCollection();
    await v.collection.addCurrentPages([2]);
  });
  await waitToast(a, /収集に追加しました/);
  await a.close();
  const b = await open('/files/scan1.pdf');
  await b.evaluate(() => window.__seihonViewer.collection.addCurrentPages([1]));
  await waitToast(b, /収集に追加しました/);
  return b;
}

await R.run('C7', '収集の「PDF としてコピー」「画像としてコピー」: ファイルを保存して場所をクリップボードへ(画像はスキャンが JPEG、文字は PNG)。1ページなら画像そのもの', async () => {
  clearDir(dl());
  const page = await prepareCollection();
  await page.click('#shCollect');
  await page.waitForSelector('#shCollectCopyPdf:not([disabled])');
  const buttons = await page.$$eval('.sh-collect-actions button', els => els.map(e => e.textContent));
  eq(buttons, ['PDF としてコピー', '画像としてコピー', 'PDF で保存', '画像(ZIP)で保存'], 'ボタン');
  await setClipboardText(ctx, 'x', page);
  await page.click('#shCollectCopyPdf');
  await waitToast(page, /2ページの PDF/);
  const pdf = await waitForFile(dl(), f => /^製本ビューア_コピー\/book-8ほか_抜粋_.*\.pdf$/.test(f));
  eq(pdfInfo(pdf).pages, 2, 'PDF のページ数');
  eq(pdfImages(pdf).filter(i => i.width === 8598).length, 1, 'スキャンの画像は元の解像度のまま');
  let clip = await readClipboard(ctx, page);
  eq(clip.find(c => c.type === 'text/plain')?.text, pdf, 'PDF の場所');
  await page.click('#shCollectCopyImages');
  await waitToast(page, /2ページの画像/);
  await sleep(500);
  const imgs = listFiles(dl()).filter(f => /^製本ビューア_コピー\/book-8ほか_抜粋_[^/]+\/\d{3}_/.test(f)).sort();
  eq(imgs.map(f => f.split('/').pop()), ['001_book-8_p2.png', '002_scan1_p1.jpg'], '画像のファイル');
  clip = await readClipboard(ctx, page);
  eq(clip.find(c => c.type === 'text/plain')?.text, path.dirname(path.join(dl(), imgs[0])), 'フォルダの場所');
  // 1ページだけのとき
  await page.evaluate(async () => {
    const db = await import('/common/db.js');
    const items = window.__seihonViewer.collection.items;
    await db.removeCollectionItems([items[1].id]);
  });
  await page.waitForFunction(() => window.__seihonViewer.collection.count === 1);
  await page.click('#shCollectCopyImages');
  await waitToast(page, /画像\(\d+×\d+\)でコピーしました/);
  clip = await readClipboard(ctx, page);
  const img = clip.find(c => c.type === 'image/png');
  assert(img && img.width === 3500, `画像そのもの: ${JSON.stringify(clip)}`);
  await page.evaluate(async () => (await import('/common/db.js')).clearCollection());
  await page.close();
  return `${path.basename(pdf)} / ${imgs.length} 枚 / 1ページは ${img.width}×${img.height}`;
});

await R.run('C8', '収集の「画像(ZIP)で保存」: スキャンのページは元の JPEG、文字のページは PNG が入る', async () => {
  clearDir(dl());
  const page = await prepareCollection();
  await page.click('#shCollect');
  await page.click('#shCollectExportZip');
  await waitToast(page, /画像\(ZIP\)で保存しました/);
  const zip = await waitForFile(dl(), f => /^book-8ほか_抜粋_.*\.zip$/.test(f));
  const list = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', zip], { encoding: 'utf8' }).trim().split('\n');
  eq(list, ['001_book-8_p2.png', '002_scan1_p1.jpg'], 'ZIP の中身');
  await page.evaluate(async () => (await import('/common/db.js')).clearCollection());
  await page.close();
  return list.join(', ');
});

await R.run('C9', '詳細設定: 「コピー・画像」の画質は最高画質が初期値、「指定する」以外では大きさの欄が使えない。補助プログラムの状態が出る', async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/options/options.html#sec-copy`);
  await page.waitForSelector('#helperStatus');
  eq(await page.isChecked('input[name="imageQuality"][value="max"]'), true, '最高画質');
  eq(await page.isChecked('input[name="printQuality"][value="max"]'), true, '印刷も最高画質');
  eq(await page.isDisabled('#pngLongSide'), true, '長辺の欄は使えない');
  await page.check('input[name="imageQuality"][value="custom"]');
  await sleep(500);
  eq(await page.isDisabled('#pngLongSide'), false, '指定するでは使える');
  await page.check('input[name="imageQuality"][value="max"]');
  await sleep(300);
  await page.waitForFunction(() => document.getElementById('helperStatus').textContent !== '確認中…');
  const status = await page.textContent('#helperStatus');
  assert(/使っていません/.test(status), `状態: ${status}`);
  eq(await page.isVisible('#helperEnable'), true, '「使えるようにする」ボタン');
  // 0.5: 目次は分類ごと(「スキャン・ページ操作」の中に「コピー・画像」)
  const toc = await page.textContent('#cat-pages .subnav');
  assert(!/AI/.test(toc) && /コピー・画像/.test(toc), `目次: ${toc}`);
  await page.close();
  return status;
});

// ---------------------------------------------------------------------------
// 元のリンク・ファイルの場所
// ---------------------------------------------------------------------------
await R.run('S1', 'Web の PDF: タイトルの右のボタン →「リンクをコピー」で URL が、2ページ目以降では「このページへのリンク」も', async () => {
  const page = await open('/pdf/sample.pdf');
  await page.evaluate(() => (window.__seihonViewer.app.page = 4));
  await sleep(300);
  await page.click('#shSource');
  await page.waitForSelector('.sh-popup:not([hidden]) .sh-menu-item');
  const items = await page.$$eval('.sh-popup:not([hidden]) .sh-menu-item .sh-menu-label', els => els.map(e => e.textContent));
  eq(items, ['リンクをコピー', 'このページ(4ページ目)へのリンクをコピー'], '項目');
  await clickMenuItem(page, 'このページ');
  await waitToast(page, /4ページ目へのリンクをコピーしました/);
  const clip = await readClipboard(ctx, page);
  eq(clip.find(c => c.type === 'text/plain')?.text, `${BASE}/pdf/sample.pdf#page=4`, 'リンク');
  await page.click('#shSource');
  await clickMenuItem(page, 'リンクをコピー');
  await waitToast(page, /リンクをコピーしました/);
  const clip2 = await readClipboard(ctx, page);
  eq(clip2.find(c => c.type === 'text/plain')?.text, `${BASE}/pdf/sample.pdf`, 'リンク');
  await page.close();
});

await R.run('S2', 'パソコンの PDF(file://): ファイルの場所・フォルダの場所・ファイル名をコピーできる', async () => {
  const dir = path.join(SP, 'local フォルダ');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '見本 #1.pdf');
  fs.copyFileSync(`${PDFS}/ocr-sample.pdf`, file);
  const url = `file://${file.split('/').map(encodeURIComponent).join('/')}`;
  const page = await open(url);
  await page.click('#shSource');
  const items = await page.$$eval('.sh-popup:not([hidden]) .sh-menu-item .sh-menu-label', els => els.map(e => e.textContent));
  eq(items.slice(0, 3), ['ファイルの場所をコピー', 'フォルダの場所をコピー', 'ファイル名をコピー'], '項目');
  const got = [];
  for (const label of ['ファイルの場所をコピー', 'フォルダの場所をコピー', 'ファイル名をコピー']) {
    if (!(await page.isVisible('.sh-popup:not([hidden])'))) {
      await page.click('#shSource');
    }
    await clickMenuItem(page, label);
    await waitToast(page, new RegExp(`${label.replace('をコピー', '')}をコピーしました`));
    got.push((await readClipboard(ctx, page)).find(c => c.type === 'text/plain')?.text);
    await sleep(200);
  }
  eq(got, [file, dir, '見本 #1.pdf'], 'コピーした文字');
  await page.close();
  return got.join(' | ');
});

await R.run('S3', 'ファイルを選んで開いた PDF: ファイル名だけコピーでき、場所が分からないことを知らせる', async () => {
  const page = await ctx.newPage();
  await page.goto(VIEWER);
  await page.waitForFunction(() => window.__seihonViewer);
  const buf = fs.readFileSync(`${PDFS}/ocr-sample.pdf`);
  await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], '選んだ.pdf', { type: 'application/pdf' });
    await window.__seihonViewer.app.open({ url: URL.createObjectURL(file), originalUrl: encodeURIComponent(file.name) });
  }, buf.toString('base64'));
  await waitViewerReady(page);
  await page.click('#shSource');
  const items = await page.$$eval('.sh-popup:not([hidden]) .sh-menu-item', els => els.map(e => `${e.querySelector('.sh-menu-label').textContent}${e.disabled ? '(使えない)' : ''}`));
  eq(items, ['ファイル名をコピー', '場所は分かりません(ファイルを選んで開いたため)(使えない)'], '項目');
  await clickMenuItem(page, 'ファイル名をコピー');
  await waitToast(page, /ファイル名をコピーしました/);
  eq((await readClipboard(ctx, page)).find(c => c.type === 'text/plain')?.text, '選んだ.pdf', 'ファイル名');
  await page.close();
});

await R.run('S4', '0.5: ⋮ メニューから「表示中のページをコピー」「元のリンク・ファイルの場所をコピー…」などを外した(タイトルの右のボタンは残る)', async () => {
  const page = await open('/pdf/book-8.pdf');
  await page.click('#shMore');
  const items = await page.$$eval('.sh-popup:not([hidden]) .sh-menu-item .sh-menu-label', els => els.map(e => e.textContent));
  for (const gone of ['表示中のページをコピー', '元のリンク・ファイルの場所をコピー…', 'PDFを閉じる', '右に回転(時計回り)', '左に回転(反時計回り)', 'ページを選ぶ(削除・カバーや帯などの指定)']) {
    assert(!items.includes(gone), `外した項目「${gone}」が無い: ${items}`);
  }
  assert(!items.some(t => t.startsWith('ファイルを開く')), `「ファイルを開く」が無い: ${items}`);
  assert(!items.some(t => /AI/.test(t)), 'AI の文字が無い');
  await page.keyboard.press('Escape');
  await page.click('#shSource');
  await page.waitForSelector('.sh-popup:not([hidden]) .sh-menu-item');
  const sub = await page.$$eval('.sh-popup:not([hidden]) .sh-menu-item .sh-menu-label', els => els.map(e => e.textContent));
  eq(sub[0], 'リンクをコピー', '元の場所のメニューが開く');
  await page.keyboard.press('Escape');
  await page.close();
});

await R.run('A1', '「AI用」の文字が、ビューア・詳細設定・初回案内の画面に残っていない', async () => {
  const found = [];
  for (const url of [`${VIEWER}`, `chrome-extension://${EXT_ID}/options/options.html`, `chrome-extension://${EXT_ID}/welcome/welcome.html`]) {
    const page = await ctx.newPage();
    await page.goto(url);
    await sleep(800);
    const text = await page.evaluate(() => document.documentElement.outerHTML);
    const m = text.match(/.{0,20}AI用.{0,20}/g);
    if (m) {
      found.push(`${url}: ${m.join(' / ')}`);
    }
    await page.close();
  }
  eq(found, [], '残っている場所');
});

// ---------------------------------------------------------------------------
// 印刷(最高画質は Chrome の印刷機能。試験では「PDF に保存」に自動で回す)
// ---------------------------------------------------------------------------
await env.close();
env = await launch(KIOSK_PRINT);
{
  const kctx = env.ctx;
  const countPdf = () => listFiles(dl()).filter(f => f.endsWith('.pdf')).length;
  const waitPrinted = async before => {
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      if (countPdf() > before) {
        await sleep(800);
        const files = listFiles(dl())
          .filter(f => f.endsWith('.pdf'))
          .map(f => ({ f, t: fs.statSync(path.join(dl(), f)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        return path.join(dl(), files[0].f);
      }
    }
    throw new Error('印刷されませんでした');
  };
  const openK = async src => {
    const p = await openViewer(kctx, src);
    p.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    return p;
  };

  await R.run('P1', '最高画質の印刷: 印刷ボタンで元の PDF のまま印刷(「PDF に保存」で画像は元の解像度、OCR の文字も残る)', async () => {
    const page = await openK('/files/ocr-sample.pdf');
    const before = countPdf();
    await page.click('#shPrint');
    const file = await waitPrinted(before);
    eq(pdfInfo(file).pages, 3, 'ページ数');
    assert(/quick brown fox/.test(pdfText(file)), 'OCR の文字');
    const imgs = pdfImages(file);
    eq(imgs.map(i => `${i.width}x${i.height}`), ['875x1240', '875x1240', '875x1240'], '画像は元の解像度');
    eq(path.basename(file), 'ocr-sample.pdf', '名前の候補はファイル名');
    eq(await page.$$eval('.sh-print-frame', els => els.length), 1, '見えない枠で印刷');
    await page.close();
    return path.basename(file);
  });

  await R.run('P2', '最高画質の印刷: ページを削除した後は、残したページだけ(Ctrl+P でも最高画質)', async () => {
    const page = await openK('/pdf/sample.pdf');
    await page.evaluate(() => window.__seihonViewer.pageEditor.deletePages([2, 3]));
    await sleep(800);
    await page.locator('#viewerContainer').click({ position: { x: 30, y: 200 } });
    const before = countPdf();
    await page.keyboard.press('Control+p');
    const file = await waitPrinted(before);
    eq(pdfInfo(file).pages, 10, 'ページ数(12 − 2)');
    const t = pdfText(file, 2);
    assert(/page 4 of 12/.test(t), `2ページ目は元の4ページ目: ${t.slice(0, 50)}`);
    eq(pdfImages(file).length, 0, '文字は画像にならない');
    await page.evaluate(() => window.__seihonViewer.pageEditor.allowLeave());
    await page.close();
    return path.basename(file);
  });

  await R.run('P3', '印刷の画質「高画質」: ページを画像にして印刷する(0.1 までと同じ)', async () => {
    await setSettings(env.sw, { printQuality: 'high' });
    const page = await openK('/pdf/book-8.pdf');
    const before = countPdf();
    await page.click('#shPrint');
    const file = await waitPrinted(before);
    eq(pdfInfo(file).pages, 8, 'ページ数');
    const imgs = pdfImages(file);
    assert(imgs.length >= 8, `画像で印刷(${imgs.length} 枚)`);
    eq(await page.$$eval('.sh-print-frame', els => els.length), 0, '見えない枠は使わない');
    await setSettings(env.sw, { printQuality: 'max' });
    await page.close();
    return `${imgs[0].width}×${imgs[0].height}`;
  });
}

// ---------------------------------------------------------------------------
// 補助プログラム(Linux 用を、試験用の xclip で確かめる)
// ---------------------------------------------------------------------------
await env.close();
{
  const extDir = `${SP}/ext-nm`;
  fs.rmSync(extDir, { recursive: true, force: true });
  execFileSync('cp', ['-a', EXT, extDir]);
  const mf = JSON.parse(fs.readFileSync(`${extDir}/manifest.json`, 'utf8'));
  mf.permissions.push('nativeMessaging');
  delete mf.optional_permissions;
  fs.writeFileSync(`${extDir}/manifest.json`, JSON.stringify(mf, null, 2));
  const userDir = fs.mkdtempSync(`${SP}/profile-`);
  fs.mkdirSync(`${userDir}/NativeMessagingHosts`, { recursive: true });
  fs.writeFileSync(
    `${userDir}/NativeMessagingHosts/com.seihon_viewer.clipboard.json`,
    JSON.stringify({
      name: 'com.seihon_viewer.clipboard',
      description: 'test',
      path: `${extDir}/helper/linux/seihon-clipboard.py`,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXT_ID}/`],
    })
  );
  const log = `${SP}/fake-xclip.log`;
  process.env.PATH = `${DEV}/fakebin:${process.env.PATH}`;
  process.env.SEIHON_FAKE_XCLIP_LOG = log;
  // 補助プログラムは「ダウンロード」フォルダ(~/Downloads)に保存する。試験では専用のホームフォルダにする
  const helperHome = `${SP}/helper-home`;
  fs.rmSync(helperHome, { recursive: true, force: true });
  fs.mkdirSync(`${helperHome}/Downloads`, { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = helperHome;
  // 0.4.1: 補助プログラムは見えない一時フォルダ(TMPDIR/seihon-viewer-copy-<uid>)に置く。試験では専用のフォルダにする
  const tempRoot = "/tmp/sv-helper-tmp"; // 短い場所(Chrome は TMPDIR の中にソケットを作るため、長い場所だと起動しない)
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  const realTmp = process.env.TMPDIR;
  process.env.TMPDIR = tempRoot;
  const tempCopyDir = `${tempRoot}/seihon-viewer-copy-${process.getuid()}`;
  // Chrome の「保存する前に保存場所を確認する」がオンでも、補助プログラムの保存は聞かれない
  env = await launch({ extDir, userDir, prefs: { download: { prompt_for_download: true } } });
  process.env.HOME = realHome;
  if (realTmp === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = realTmp;
  }
  const copyDir = `${helperHome}/Downloads/製本ビューア_コピー`;

  await R.run('H1', '補助プログラムがあるとき: 「PDF としてコピー」でファイルがクリップボードに入る(xclip に file:// の一覧が渡る)', async () => {
    fs.rmSync(log, { force: true });
    clearDir(copyDir);
    const page = await openViewer(env.ctx, '/pdf/book-8.pdf');
    const st = await page.evaluate(async () => (await import('./file-clipboard.js')).helperStatus());
    eq(st, { available: true, os: 'linux', version: 3 }, '状態');
    await page.evaluate(() => window.__seihonViewer.pageCopy.copyPages([1, 2]));
    const msg = await waitToast(page, /クリップボードにコピーしました/);
    // 0.4.1: 見えない一時フォルダに置く(ダウンロードフォルダには何も残らない)
    const file = await waitForFile(tempCopyDir, f => /\/book-8_抜粋_\d{8}_\d{6}\.pdf$/.test(f));
    eq(pdfInfo(file).pages, 2, 'ページ数');
    eq(listFiles(copyDir).length, 0, 'ダウンロードフォルダには保存しない');
    // 使い捨て: もう一度コピーすると、前のファイルは消える(名前は秒までの日時なので、1秒あける)
    await sleep(1100);
    await page.evaluate(() => window.__seihonViewer.pageCopy.copyPages([3, 4]));
    await waitToast(page, /クリップボードにコピーしました/);
    await waitForFile(tempCopyDir, f => /_抜粋_.*\.pdf$/.test(f) && f !== path.relative(tempCopyDir, file));
    assert(!fs.existsSync(file), '前のコピーのファイルは消える');
    const downloads = await env.sw.evaluate(async () => (await chrome.downloads.search({})).length);
    eq(downloads, 0, 'Chrome のダウンロードは使わない(保存場所を聞かれない)');
    const text = fs.readFileSync(log, 'utf8');
    assert(/-selection clipboard -t text\/uri-list/.test(text), `xclip の指定: ${text}`);
    const uri = `file://${file.split('/').map(encodeURIComponent).join('/')}`;
    assert(text.includes(uri), `ファイルの URI: ${text}`);
    assert(/フォルダやチャット欄などに貼り付けられます/.test(msg), msg);
    await page.close();
    return msg.slice(0, 40);
  });

  await R.run('H2', '補助プログラムがあるとき: 複数ページの「画像としてコピー」は、全部の画像ファイルがクリップボードに入る', async () => {
    fs.rmSync(log, { force: true });
    clearDir(copyDir);
    const page = await openViewer(env.ctx, '/pdf/book-8.pdf');
    await page.evaluate(() => window.__seihonViewer.pageCopy.copyImages(window.__seihonViewer.pageCopy.currentPages([1, 2, 3])));
    await waitToast(page, /3ページの画像をクリップボードにコピーしました/);
    const text = fs.readFileSync(log, 'utf8');
    const uris = text.split('\n').filter(l => l.startsWith('file://'));
    eq(uris.length, 3, 'URI の数');
    assert(uris.every(u => /\.png\r?$/.test(u)), `PNG: ${uris}`);
    const files = listFiles(tempCopyDir);
    eq(files.length, 3, '保存した画像の数');
    assert(files.every(f => /^copy-[^/]+\/book-8_抜粋_\d{8}_\d{6}\/00\d_book-8_p\d\.png$/.test(f)), `フォルダと名前: ${files}`);
    await page.close();
  });

  await R.run('H3', '詳細設定: 補助プログラムが使えるときは「使えます」と出る', async () => {
    const page = await env.ctx.newPage();
    await page.goto(`chrome-extension://${EXT_ID}/options/options.html#sec-copy`);
    await page.waitForFunction(() => /使えます/.test(document.getElementById('helperStatus').textContent), null, { timeout: 10000 });
    const t = await page.textContent('#helperStatus');
    await page.close();
    return t;
  });
}

await env.close();
if (errors.length) {
  console.log('ページのエラー:', errors.slice(0, 10));
}
const s = R.summary();
process.exit(s.ok === s.total ? 0 : 1);
