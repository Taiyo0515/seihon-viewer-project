// 0.4(電子書籍・コミックの表示と変換)の試験
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  BASE, DEV, EXT, EXT_ID, KIOSK_PRINT, PDFS, Results, SP, VIEWER, assert, clearDir, eq, getSettings, launch, listFiles, openViewer, pdfInfo,
  pdfText, setSettings, sleep, viewerUrl, waitForFile, waitToast, waitViewerReady,
} from './lib.mjs';

const R = new Results('Phase 8 (0.4)');
const env = await launch({ width: 1400, height: 900 });
const { ctx, sw } = env;
const dl = () => env.downloadsDir;
const errors = [];
const BOOKS = path.join(EXT, 'tools/test-server/samples/books');
const READER = `chrome-extension://${EXT_ID}/reader/reader.html`;

const watch = page => {
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error') {
      errors.push(`console: ${m.text().slice(0, 200)}`);
    }
  });
  return page;
};
const newPage = async () => watch(await ctx.newPage());
const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');
/** PDF の中の JPEG の MD5(並び順) */
const pdfJpegHashes = file => {
  const dir = fs.mkdtempSync(path.join(SP, 'img-'));
  execFileSync('pdfimages', ['-j', file, path.join(dir, 'x')]);
  const out = fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.jpg'))
    .sort()
    .map(f => md5(fs.readFileSync(path.join(dir, f))));
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
};
/** pdfimages -list の画像の一覧(page, enc, w, h) */
const pdfImageList = file =>
  execFileSync('pdfimages', ['-list', file], { encoding: 'utf8' })
    .split('\n')
    .slice(2)
    .filter(Boolean)
    .map(l => l.trim().split(/\s+/))
    .map(c => ({ page: +c[0], w: +c[3], h: +c[4], enc: c[8] }));
/** ZIP の中身(名前と MD5) */
const zipEntries = file => {
  const dir = fs.mkdtempSync(path.join(SP, 'zip-'));
  execFileSync('unzip', ['-q', '-o', file, '-d', dir]);
  const out = {};
  for (const f of listFiles(dir)) {
    out[f] = md5(fs.readFileSync(path.join(dir, f)));
  }
  const order = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
  fs.rmSync(dir, { recursive: true, force: true });
  return { files: out, order };
};
const zipText = (file, name) => execFileSync('unzip', ['-p', file, name], { encoding: 'utf8' });
const interceptDownloads = page =>
  page.evaluate(() => {
    window.__dlCalls = [];
    const orig = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = opts => {
      window.__dlCalls.push({ filename: opts.filename, saveAs: opts.saveAs });
      return orig({ ...opts, saveAs: false });
    };
  });
const viewerInfo = page =>
  page.evaluate(async () => {
    const v = window.__seihonViewer;
    const app = v.app;
    const sizes = [];
    for (let i = 1; i <= app.pagesCount; i++) {
      const p = await app.pdfDocument.getPage(i);
      const vp = p.getViewport({ scale: 1 });
      sizes.push([Math.round(vp.width), Math.round(vp.height)]);
    }
    return {
      pages: app.pagesCount,
      direction: v.book.direction,
      mode: v.book.mode,
      converted: v.current.converted || null,
      title: document.title,
      sizes,
    };
  });
const openComic = async src => {
  const page = await newPage();
  await page.goto(viewerUrl(src));
  await page.waitForFunction(() => window.__seihonViewer?.current?.converted && window.__seihonViewer.app.pdfDocument, null, { timeout: 60000 });
  await waitViewerReady(page);
  return page;
};
const openReader = async src => {
  const page = await newPage();
  await page.goto(viewerUrl(src));
  await page.waitForURL(u => u.href.startsWith(READER), { timeout: 30000 });
  await page.waitForFunction(() => window.__seihonReader?.state.book && document.getElementById('rdLoading').hidden, null, { timeout: 30000 });
  await sleep(800);
  return page;
};
const readerInfo = page =>
  page.evaluate(() => {
    const r = window.__seihonReader;
    const b = r.state.book;
    return {
      title: document.title,
      dir: b.dir || null,
      vertical: r.state.vertical,
      fixed: r.state.fixed,
      sections: b.sections.length,
      toc: [...document.querySelectorAll('#rdTocList a')].map(a => a.textContent),
      format: document.getElementById('rdFormat').textContent,
      percent: document.getElementById('rdPercent').textContent,
      chapter: document.getElementById('rdChapter').textContent,
    };
  });
const viewerError = page =>
  page.evaluate(() => ({
    shown: !document.getElementById('shError').hidden,
    title: document.getElementById('shErrorTitle').textContent,
    message: document.getElementById('shErrorMessage').textContent,
  }));
const saveFromMenu = async (page, label) => {
  await page.click('#shDownload');
  await page.waitForSelector('.sh-popup:not([hidden]) .sh-menu-item');
  await page.locator('.sh-popup:not([hidden]) .sh-menu-item', { hasText: label }).first().click();
};
/** RAR の中の画像の MD5(libarchive.js の Node 版(dev/vendor)で取り出す。libarchive.wasm は dev/setup.sh が写す) */
const rarImageHashes = async file => {
  const { Archive } = await import(pathToFileURL(path.join(DEV, 'vendor/libarchivejs/libarchive-node.mjs')).href);
  const a = await Archive.open(new Blob([fs.readFileSync(file)]));
  const arr = await a.extractFiles();
  const out = [];
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v.arrayBuffer === 'function') out.push([prefix + k, v]);
      else if (v && typeof v === 'object') walk(v, `${prefix}${k}/`);
    }
  };
  walk(arr, '');
  const imgs = out.filter(([n]) => /\.jpe?g$/i.test(n)).sort((x, y) => x[0].localeCompare(y[0], 'ja', { numeric: true }));
  return Promise.all(imgs.map(async ([, f]) => md5(Buffer.from(await f.arrayBuffer()))));
};
const cbzImageHashes = file => {
  const dir = fs.mkdtempSync(path.join(SP, 'cbz-'));
  execFileSync('unzip', ['-q', '-o', file, '-d', dir]);
  const names = listFiles(dir)
    .filter(f => /\.jpe?g$/i.test(f) && !f.includes('__MACOSX'))
    .sort((x, y) => x.localeCompare(y, 'ja', { numeric: true }));
  const out = names.map(f => md5(fs.readFileSync(path.join(dir, f))));
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
};

// ---------------------------------------------------------------------------
// 見分け
// ---------------------------------------------------------------------------
await R.run('L1', 'ファイルの種類の見分け(拡張子と中身。KFX・DRM 付きの MOBI が分かる)', async () => {
  const page = await newPage();
  await page.goto(`${VIEWER}`);
  await page.waitForFunction(() => window.__seihonViewer);
  const files = ['novel-vertical.epub', 'manga-fxl.epub', 'comic.cbz', 'comic.cbr', 'fake.kfx', 'drm.epub'];
  const blobs = Object.fromEntries(files.map(f => [f, fs.readFileSync(path.join(BOOKS, f)).toString('base64')]));
  for (const f of ['demo-mobi6.mobi', 'demo-kf8.azw3', 'demo-drm.azw']) {
    blobs[f] = fs.readFileSync(path.join(PDFS, f)).toString('base64');
  }
  blobs['sample.pdf'] = fs.readFileSync(path.join(PDFS, 'ocr-sample.pdf')).toString('base64');
  const res = await page.evaluate(async blobs => {
    const m = await import('/common/ebook-formats.js');
    const out = {};
    for (const [name, b64] of Object.entries(blobs)) {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const head = bytes.slice(0, 65536);
      out[name] = [m.sniffFormat(head, name), m.sniffFormat(head, 'noname') , m.sniffFormat(head) === 'mobi' ? m.mobiHasDrm(head) : null];
    }
    return out;
  }, blobs);
  eq(res, {
    'novel-vertical.epub': ['epub', 'epub', null],
    'manga-fxl.epub': ['epub', 'epub', null],
    'comic.cbz': ['cbz', 'zip', null],
    'comic.cbr': ['cbr', 'cbr', null],
    'fake.kfx': ['kfx', 'kfx', null],
    'drm.epub': ['epub', 'epub', null],
    'demo-mobi6.mobi': ['mobi', 'mobi', false],
    'demo-kf8.azw3': ['mobi', 'mobi', false],
    'demo-drm.azw': ['mobi', 'mobi', true],
    'sample.pdf': ['pdf', 'pdf', null],
  }, '見分けの結果');
  await page.close();
});

// ---------------------------------------------------------------------------
// コミック → PDF(ビューアで表示)
// ---------------------------------------------------------------------------
await R.run('L2', 'コミック(CBZ): 画像を並べた PDF で表示(右綴じ・製本表示、見開きの画像は2ページに分けて同じ見開きに並ぶ)', async () => {
  const page = await openComic('/book/comic.cbz');
  const info = await viewerInfo(page);
  eq([info.pages, info.direction, info.mode], [12, 'rtl', 'book'], 'ページ数・綴じ方向・表示モード');
  eq([info.converted.format, info.converted.fileName, info.converted.split, info.converted.title], ['cbz', 'comic.pdf', 1, '見本のコミック'], '変換の情報');
  // 7ページ目が白紙(見開きの位置合わせ)、8・9ページ目が見開きの右半分・左半分(右綴じ)
  const half = info.sizes[7];
  eq(info.sizes[8], half, '分けた2ページの大きさ');
  eq(info.sizes[1], half, 'ふつうのページと同じ大きさ');
  await waitToast(page, /白紙のページを 1 枚/);
  await page.close();
});

await R.run('L3', 'コミックを「PDF として保存」: JPEG は元のデータのまま(MD5 が同じ)、名前は 元の名前.pdf', async () => {
  clearDir(dl());
  const page = await openComic('/book/comic.cbz');
  await interceptDownloads(page);
  await saveFromMenu(page, 'PDF として保存');
  const file = await waitForFile(dl(), f => /\.pdf$/i.test(f));
  const calls = await page.evaluate(() => window.__pickerCalls);
  eq([calls[0].kind, calls[0].suggestedName], ['file', 'comic.pdf'], '保存先を選ぶ画面の指定');
  const want = cbzImageHashes(path.join(BOOKS, 'comic.cbz'));
  const got = pdfJpegHashes(file);
  eq([...new Set(got)].sort(), [...want].sort(), 'JPEG の中身');
  const list = pdfImageList(file);
  // 見開きの画像(2000×1420)は 8・9 ページの両方に出る(同じ画像を共有)
  eq(list.filter(i => i.w === 2000).map(i => i.page), [8, 9], '見開きの画像のページ');
  eq(list.filter(i => i.page === 7).length, 0, '7ページ目は白紙');
  // 元のファイルの保存
  await saveFromMenu(page, '元のファイルを保存');
  const orig = await waitForFile(dl(), f => /\.cbz$/i.test(f));
  eq(md5(fs.readFileSync(orig)), md5(fs.readFileSync(path.join(BOOKS, 'comic.cbz'))), '元のファイル');
  await page.close();
  return `${path.basename(file)} ${pdfInfo(file).pages}ページ`;
});

await R.run('L4', 'コミック(CBR・RAR): 画像を並べた PDF で表示、JPEG は元のまま', async () => {
  clearDir(dl());
  const page = await openComic('/book/comic.cbr');
  const info = await viewerInfo(page);
  eq([info.pages, info.direction, info.converted.format], [6, 'rtl', 'cbr'], 'ページ数・綴じ方向');
  await interceptDownloads(page);
  await saveFromMenu(page, 'PDF として保存');
  const file = await waitForFile(dl(), f => /\.pdf$/i.test(f));
  eq(pdfJpegHashes(file), await rarImageHashes(path.join(BOOKS, 'comic.cbr')), 'JPEG の中身と順番');
  await page.close();
});

await R.run('L5', 'ComicInfo の無い CBZ(JPEG・WebP・PNG・GIF): 数字の順(p1, p2, p3, p10)に並ぶ。向きは右綴じ', async () => {
  clearDir(dl());
  const page = await openComic('/book/comic-noinfo.cbz');
  const info = await viewerInfo(page);
  eq([info.pages, info.direction, info.converted.skipped.length], [4, 'rtl', 0], 'ページ数・向き・読めなかった画像');
  await interceptDownloads(page);
  await saveFromMenu(page, 'PDF として保存');
  const file = await waitForFile(dl(), f => /\.pdf$/i.test(f));
  const list = pdfImageList(file);
  eq(list.map(i => i.enc), ['jpeg', 'jpeg', 'image', 'image'], '画像の形式(JPEG / WebP→JPEG / PNG / GIF→PNG)');
  await page.close();
});

await R.run('L6', '画像だけの EPUB(固定レイアウトの漫画): PDF で表示。白紙のページも入り、目次が PDF のしおりになる', async () => {
  const page = await openComic('/book/manga-fxl.epub');
  const info = await viewerInfo(page);
  eq([info.pages, info.direction, info.converted.format], [7, 'rtl', 'epub'], 'ページ数・綴じ方向');
  const outline = await page.evaluate(async () => {
    const doc = window.__seihonViewer.app.pdfDocument;
    const items = await doc.getOutline();
    const out = [];
    for (const it of items) {
      out.push([it.title, (await doc.getPageIndex(it.dest[0])) + 1]);
    }
    const p4 = await doc.getPage(4);
    const ops = await p4.getOperatorList();
    return { out, p4ops: ops.fnArray.length };
  });
  eq(outline.out, [['表紙', 1], ['第1話', 2], ['第2話', 5]], 'しおり');
  assert(outline.p4ops <= 2, `4ページ目は白紙(命令 ${outline.p4ops} 個)`);
  await page.close();
});

await R.run('L7', '綴じ方向を左綴じに変えると、見開きの画像の分け方も変わる(左半分が先)。PDF を開くと設定の向きに戻る', async () => {
  const before = (await getSettings(sw)).bindingDirection || 'ltr';
  try {
    await setSettings(sw, { bindingDirection: 'rtl' });
    const page = await openComic('/book/comic.cbz');
    await page.click('#shBindDir');
    await page.waitForFunction(() => window.__seihonViewer.current.converted?.direction === 'ltr', null, { timeout: 30000 });
    await waitViewerReady(page);
    const info = await viewerInfo(page);
    eq([info.direction, info.pages], ['ltr', 12], '左綴じ');
    // 8 ページ目は見開きの画像の左半分(画像を左端から描く)
    const x = await page.evaluate(async () => {
      const doc = window.__seihonViewer.app.pdfDocument;
      const p = await doc.getPage(8);
      const ops = await p.getOperatorList();
      const OPS = window.pdfjsLib.OPS;
      const i = ops.fnArray.indexOf(OPS.transform);
      return ops.argsArray[i]?.[4];
    });
    eq(Math.round(x), 0, '8ページ目は左半分');
    await page.close();
  } finally {
    await setSettings(sw, { bindingDirection: before });
  }
});

await R.run('L8', 'コミックのあとで PDF を開くと、綴じ方向は設定の向きに戻る', async () => {
  const before = (await getSettings(sw)).bindingDirection || 'ltr';
  try {
    await setSettings(sw, { bindingDirection: 'ltr' });
    const page = await openComic('/book/comic.cbr');
    eq((await viewerInfo(page)).direction, 'rtl', 'コミックは右綴じ');
    // 同じタブでファイルを選んで PDF を開く
    await page.setInputFiles('#fileInput', path.join(PDFS, 'ocr-sample.pdf'));
    await page.waitForFunction(() => !window.__seihonViewer.current.converted && window.__seihonViewer.app.pagesCount === 3, null, { timeout: 20000 });
    eq((await page.evaluate(() => window.__seihonViewer.book.direction)), 'ltr', 'PDF は設定の向き');
    await page.close();
  } finally {
    await setSettings(sw, { bindingDirection: before });
  }
});

await R.run('L9', 'ファイルを選ぶ画面: PDF と電子書籍・コミックを選べる。選んだ CBZ はコミックとして表示', async () => {
  const page = await newPage();
  await page.goto(VIEWER);
  await page.waitForFunction(() => window.__seihonViewer);
  const accept = await page.evaluate(() => document.getElementById('fileInput').accept);
  for (const ext of ['.pdf', '.epub', '.mobi', '.azw3', '.cbz', '.cbr']) {
    assert(accept.includes(ext), `accept に ${ext}: ${accept}`);
  }
  await page.setInputFiles('#fileInput', path.join(BOOKS, 'comic.cbz'));
  await page.waitForFunction(() => window.__seihonViewer.current.converted && window.__seihonViewer.app.pagesCount === 12, null, { timeout: 30000 });
  eq(await page.evaluate(() => window.__seihonViewer.current.kind), 'file', '出どころ');
  await page.close();
});

await R.run('L10', 'KFX・DRM 付きの EPUB・DRM 付きの AZW は、表示できない理由が出る', async () => {
  const out = [];
  for (const src of ['/book/fake.kfx', '/book/drm.epub', '/book/demo-drm.azw']) {
    const page = await newPage();
    await page.goto(viewerUrl(src));
    await page.waitForFunction(() => !document.getElementById('shError').hidden, null, { timeout: 20000 });
    const e = await viewerError(page);
    out.push(e.title);
    await page.close();
  }
  eq(out, ['KFX 形式の本は表示できません', 'DRM(コピー防止)がかかった本は表示できません', 'DRM(コピー防止)がかかった本は表示できません'], '理由');
});

await R.run('L11', '電子書籍でも PDF でもない ZIP は「このファイルは開けません」', async () => {
  const zip = path.join(SP, 'notbook.zip');
  execFileSync('python3', ['-c', `import zipfile;z=zipfile.ZipFile(${JSON.stringify(zip)},'w');z.writestr('a.txt','hello');z.close()`]);
  const page = await newPage();
  await page.goto(VIEWER);
  await page.waitForFunction(() => window.__seihonViewer);
  await page.setInputFiles('#fileInput', zip);
  await page.waitForFunction(() => !document.getElementById('shError').hidden, null, { timeout: 20000 });
  eq((await viewerError(page)).title, 'このファイルは開けません', '表示');
  await page.close();
});

// ---------------------------------------------------------------------------
// 電子書籍リーダー
// ---------------------------------------------------------------------------
await R.run('L12', '縦書きの EPUB: 電子書籍リーダーで縦書き・右から左へめくる表示。目次・本の情報', async () => {
  const page = await openReader('/book/novel-vertical.epub');
  const info = await readerInfo(page);
  eq([info.dir, info.vertical, info.fixed, info.sections], ['rtl', true, false, 4], '向き・縦書き');
  eq(info.toc, ['第一章 雨の日の古本屋', '第二章 包み紙の中', '第三章 迎えに来た人'], '目次');
  assert(info.title.startsWith('雨の日の古本屋(見本)'), `題名: ${info.title}`);
  // ← で次のページ(右綴じ)
  const p0 = parseFloat(info.percent);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await sleep(800);
  const p1 = parseFloat((await readerInfo(page)).percent);
  assert(p1 > p0, `← で進む: ${p0} → ${p1}`);
  // 目次で第三章へ
  await page.click('#rdToc');
  await page.locator('#rdTocList a', { hasText: '第三章' }).click();
  await page.waitForFunction(() => document.getElementById('rdChapter').textContent.includes('第三章'), null, { timeout: 10000 });
  await page.close();
});

await R.run('L13', '本の中のスクリプトは実行されない', async () => {
  const page = await openReader('/book/novel-vertical.epub');
  await page.evaluate(async () => {
    const v = window.__seihonReader.state.view;
    await v.goTo(v.book.toc[2].href);
  });
  await sleep(1500);
  const r = await page.evaluate(() => ({
    top: window.__seihonEpubScript ?? null,
    titles: window.__seihonReader.state.view.renderer.getContents().map(c => c.doc.title),
    scripts: window.__seihonReader.state.view.renderer.getContents().map(c => c.doc.querySelectorAll('script').length),
  }));
  eq(r.top, null, 'スクリプトの印');
  assert(!r.titles.includes('SCRIPT-RAN'), `章の題名: ${r.titles}`);
  eq(r.scripts.every(n => n === 0), true, 'script 要素は取り除く');
  await page.close();
});

await R.run('L14', '検索・文字の大きさ・背景の色・単ページ/見開き(設定は覚える)', async () => {
  const page = await openReader('/book/novel-horizontal.epub');
  await page.keyboard.press('Control+f');
  await page.fill('#rdSearchInput', '算盤');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /件見つかりました/.test(document.getElementById('rdSearchStatus').textContent), null, { timeout: 15000 });
  const n = await page.$$eval('#rdSearchResults button', b => b.length);
  assert(n >= 2, `検索結果 ${n} 件`);
  await page.click('#rdFontPlus');
  await page.click('#rdFontPlus');
  await page.click('#rdTheme');
  await page.click('#rdColumns');
  await sleep(500);
  const prefs = await page.evaluate(() => window.__seihonReader.prefs);
  eq([prefs.fontScale, prefs.theme, prefs.columns], [120, 'sepia', 1], '表示の好み');
  const stored = await sw.evaluate(async () => (await chrome.storage.local.get('readerPrefs')).readerPrefs);
  eq([stored.fontScale, stored.theme, stored.columns], [120, 'sepia', 1], '保存');
  const bg = await page.evaluate(() => getComputedStyle(window.__seihonReader.state.view.renderer.getContents()[0].doc.body).backgroundColor);
  eq(bg, 'rgb(246, 239, 224)', '本の背景(セピア)');
  // 元に戻す
  await sw.evaluate(() => chrome.storage.local.remove('readerPrefs'));
  await page.close();
});

await R.run('L15', '読んだ位置を覚えて、次に開いたときそこから表示する', async () => {
  await sw.evaluate(() => chrome.storage.local.remove('readerPositions'));
  const page = await openReader('/book/novel-vertical.epub');
  await page.evaluate(async () => {
    const v = window.__seihonReader.state.view;
    await v.goTo(v.book.toc[1].href);
  });
  await sleep(1800);
  const before = (await readerInfo(page)).chapter;
  assert(before.includes('第二章'), `章: ${before}`);
  await page.reload();
  await page.waitForFunction(() => window.__seihonReader?.state.book && document.getElementById('rdLoading').hidden, null, { timeout: 30000 });
  await sleep(1000);
  const after = (await readerInfo(page)).chapter;
  assert(after.includes('第二章'), `再読み込み後の章: ${after}`);
  await page.close();
});

await R.run('L16', 'MOBI・AZW3(Kindle、DRM なし)を表示できる', async () => {
  const out = [];
  for (const f of ['demo-mobi6.mobi', 'demo-kf8.azw3']) {
    const page = await openReader(`/book/${f}`);
    const info = await readerInfo(page);
    assert(info.sections > 0, `${f} の章`);
    out.push(`${f}: ${info.format} ${info.sections}章`);
    // 本文のある章(表紙の画像だけの章を除く)
    const text = await page.evaluate(async () => {
      const b = window.__seihonReader.state.book;
      let max = 0;
      for (const s of b.sections.slice(0, 6)) {
        if (s.createDocument) {
          const d = await s.createDocument();
          max = Math.max(max, (d.body?.textContent || '').trim().length);
        }
      }
      return max;
    });
    assert(text > 50, `${f} の本文 ${text} 文字`);
    await page.close();
  }
  return out.join(' / ');
});

await R.run('L17', 'リーダーで選んだ PDF・コミックは、製本ビューアの画面で開く(受け渡し)', async () => {
  const page = await newPage();
  await page.goto(READER);
  await page.waitForSelector('#rdOpen');
  await page.setInputFiles('#rdFileInput', path.join(BOOKS, 'comic.cbr'));
  await page.waitForURL(u => u.href.startsWith(VIEWER) && u.href.includes('?h='), { timeout: 20000 });
  await page.waitForFunction(() => window.__seihonViewer?.current?.converted && window.__seihonViewer.app.pagesCount === 6, null, { timeout: 30000 });
  // 再読み込みしても開ける
  await page.reload();
  await page.waitForFunction(() => window.__seihonViewer?.current?.converted && window.__seihonViewer.app.pagesCount === 6, null, { timeout: 30000 });
  await page.close();
});

await R.run('L18', 'パソコン内の EPUB(file://)を開くと、電子書籍リーダーで表示する', async () => {
  const page = await newPage();
  await page.goto(`file://${BOOKS}/novel-horizontal.epub`).catch(() => {});
  // 製本ビューア → 電子書籍リーダーと切り替わる(途中のページの読み込みは中断されるので、URL を見て待つ)
  const t0 = Date.now();
  while (!page.url().startsWith(READER) && Date.now() - t0 < 20000) {
    await sleep(200);
  }
  await page.waitForFunction(() => window.__seihonReader?.state.book, null, { timeout: 20000 });
  eq((await readerInfo(page)).title, '横書きの見本 - 電子書籍リーダー', '題名');
  await page.close();
});

await R.run('L25', '「保存する前に保存場所を確認する」がオンでも、パソコン内の EPUB を開くと保存先を聞かれず(ダウンロードは取り消し)、リーダーで表示する', async () => {
  const ask = await launch({ width: 1200, height: 800, prefs: { download: { prompt_for_download: true } } });
  try {
    const page = await ask.ctx.newPage();
    await page.goto(`file://${BOOKS}/novel-vertical.epub`).catch(() => {});
    const t0 = Date.now();
    while (!page.url().startsWith(READER) && Date.now() - t0 < 20000) {
      await sleep(200);
    }
    await page.waitForFunction(() => window.__seihonReader?.state.book, null, { timeout: 20000 });
    await sleep(2000);
    const items = await ask.sw.evaluate(async () => (await chrome.downloads.search({})).map(d => ({ url: d.url, state: d.state })));
    eq(items.filter(d => /novel-vertical\.epub$/.test(d.url) && d.state !== 'interrupted'), [], '残っているダウンロード');
    eq(listFiles(ask.downloadsDir).filter(f => /\.epub/.test(f)), [], '保存されたファイル');
    eq(ask.ctx.pages().filter(p => p.url().includes('/reader/reader.html')).length, 1, 'リーダーのタブは1つ');
  } finally {
    await ask.close();
  }
});

await R.run('L26', 'タブの切り替えより先に Chrome のダウンロードが始まっても、保存先を決める前に取り消して、製本ビューアで開く', async () => {
  const ask = await launch({ width: 1200, height: 800, prefs: { download: { prompt_for_download: true } } });
  try {
    await ask.sw.evaluate(() => {
      globalThis.__seihonSkipEbookRedirect = true;
      globalThis.__dl = [];
      chrome.downloads.onChanged.addListener(d => d.state && __dl.push(d.state.current));
    });
    const page = await ask.ctx.newPage();
    await page.goto(`file://${BOOKS}/novel-horizontal.epub`).catch(() => {});
    const t0 = Date.now();
    let reader = null;
    while (!reader && Date.now() - t0 < 20000) {
      reader = ask.ctx.pages().find(p => p.url().includes('/reader/reader.html'));
      await sleep(200);
    }
    assert(reader, 'リーダーのタブが開く');
    await reader.waitForFunction(() => window.__seihonReader?.state.book, null, { timeout: 20000 });
    eq(await ask.sw.evaluate(() => __dl), ['interrupted'], 'ダウンロードは取り消し');
    eq(listFiles(ask.downloadsDir).filter(f => /\.epub/.test(f)), [], '保存されたファイル');
  } finally {
    await ask.close();
  }
});

await R.run('L27', '補助プログラムが無いときの「PDF としてコピー」も使い捨て: 次にコピーすると前のファイルは消え、ダウンロードの一覧にも残らない', async () => {
  clearDir(dl());
  const page = await openViewer(ctx, '/pdf/book-8.pdf', { page: await newPage() });
  await page.evaluate(() => window.__seihonViewer.pageCopy.copyPages([1, 2]));
  await waitToast(page, /クリップボードにコピーしました/);
  const first = await waitForFile(dl(), f => /_抜粋_.*\.pdf$/.test(f));
  await sleep(1100);
  await page.evaluate(() => window.__seihonViewer.pageCopy.copyPages([3, 4]));
  await waitToast(page, /クリップボードにコピーしました/);
  await waitForFile(dl(), f => /_抜粋_.*\.pdf$/.test(f) && path.join(dl(), f) !== first);
  await sleep(500);
  assert(!fs.existsSync(first), '前のコピーのファイルは消える');
  const items = await sw.evaluate(async () => (await chrome.downloads.search({})).filter(d => /_抜粋_/.test(d.filename)).length);
  eq(items, 1, 'ダウンロードの一覧に残るのは最後のコピーだけ');
  await page.close();
});

await R.run('L19', '「PDF に保存」(印刷): 縦書きの本を A6 に並べた、文字の PDF ができる', async () => {
  const kiosk = await launch({ width: 1300, height: 900, ...KIOSK_PRINT });
  try {
    const page = await kiosk.ctx.newPage();
    await page.goto(viewerUrl('/book/novel-vertical.epub'));
    await page.waitForURL(u => u.href.startsWith(READER), { timeout: 30000 });
    await page.waitForFunction(() => window.__seihonReader?.state.book && document.getElementById('rdLoading').hidden, null, { timeout: 30000 });
    await page.click('#rdPrint');
    await page.selectOption('#rdPaper', 'A6');
    await page.click('#rdPrintGo');
    const file = await waitForFile(kiosk.downloadsDir, f => /\.pdf$/i.test(f), 60000);
    const info = pdfInfo(file);
    assert(info.pages >= 5, `ページ数 ${info.pages}`);
    eq([Math.round(info.width), Math.round(info.height)], [298, 420], '紙の大きさ(A6)');
    const text = pdfText(file).replace(/\s/g, '');
    assert(text.includes('古本屋') || text.includes('雨'), '本文の文字が入っている');
    assert(path.basename(file).startsWith('雨の日の古本屋'), `ファイル名: ${path.basename(file)}`);
    return `${path.basename(file)} ${info.pages}ページ`;
  } finally {
    await kiosk.close();
  }
});

// ---------------------------------------------------------------------------
// PDF → ほかの形式
// ---------------------------------------------------------------------------
const convertVia = async (page, format, opts = {}) => {
  clearDir(dl());
  await interceptDownloads(page);
  // ⋮ メニュー →「ほかの形式に変換して保存…」
  await page.click('#shMore');
  await page.waitForSelector('.sh-popup:not([hidden]) .sh-menu-item');
  await page.locator('.sh-popup:not([hidden]) .sh-menu-item', { hasText: 'ほかの形式に変換して保存' }).click();
  await page.waitForSelector('#shConvertDialog[open]');
  await page.check(`#shConvertDialog input[name="shConvFormat"][value="${format}"]`);
  if (opts.dpi) {
    await page.selectOption('#shConvertDialog [data-dpi]', String(opts.dpi));
  }
  await page.click('#shConvertDialog [data-run]');
  const file = await waitForFile(dl(), f => !/\.crdownload$/.test(f), 60000);
  await page.waitForFunction(() => !document.getElementById('shConvertDialog').open, null, { timeout: 20000 });
  return file;
};

await R.run('L20', 'PDF → コミック(CBZ): スキャンのページは元の JPEG のまま。ComicInfo.xml に右綴じ', async () => {
  const before = (await getSettings(sw)).bindingDirection || 'ltr';
  try {
    await setSettings(sw, { bindingDirection: 'rtl' });
    const page = await openViewer(ctx, '/pdf/scan-ocr.pdf', { page: await newPage() });
    const file = await convertVia(page, 'cbz');
    eq(path.basename(file), 'scan-ocr.cbz', 'ファイル名');
    const z = zipEntries(file);
    eq(z.order, ['001.jpg', '002.jpg', '003.jpg', 'ComicInfo.xml'], '中身');
    const want = pdfJpegHashes(path.join(EXT, 'tools/test-server/samples/scan-ocr.pdf'));
    eq(['001.jpg', '002.jpg', '003.jpg'].map(n => z.files[n]), want, 'JPEG は元のまま');
    assert(zipText(file, 'ComicInfo.xml').includes('<Manga>YesAndRightToLeft</Manga>'), 'ComicInfo の向き');
    // 作った CBZ はそのままコミックとして開ける
    const back = await newPage();
    await back.goto(VIEWER);
    await back.waitForFunction(() => window.__seihonViewer);
    await back.setInputFiles('#fileInput', file);
    await back.waitForFunction(() => window.__seihonViewer.current.converted && window.__seihonViewer.app.pagesCount === 3, null, { timeout: 30000 });
    await back.close();
    await page.close();
  } finally {
    await setSettings(sw, { bindingDirection: before });
  }
});

await R.run('L21', 'PDF → EPUB(固定レイアウト): mimetype が先頭、しおりが目次、ページごとに画像。作った EPUB は製本ビューアで開ける', async () => {
  const page = await openViewer(ctx, '/pdf/book-8.pdf', { page: await newPage() });
  const file = await convertVia(page, 'epub', { dpi: 150 });
  eq(path.basename(file), 'book-8.epub', 'ファイル名');
  const z = zipEntries(file);
  eq(z.order[0], 'mimetype', '先頭は mimetype');
  eq(zipText(file, 'mimetype'), 'application/epub+zip', 'mimetype の中身');
  const opf = zipText(file, 'OEBPS/content.opf');
  assert(opf.includes('rendition:layout">pre-paginated'), '固定レイアウト');
  eq(z.order.filter(n => n.startsWith('OEBPS/pages/')).length, 8, 'ページ数');
  const back = await newPage();
  await back.goto(VIEWER);
  await back.waitForFunction(() => window.__seihonViewer);
  await back.setInputFiles('#fileInput', file);
  await back.waitForFunction(() => window.__seihonViewer.current.converted?.format === 'epub' && window.__seihonViewer.app.pagesCount === 8, null, { timeout: 30000 });
  await back.close();
  await page.close();
});

await R.run('L22', 'PDF → 画像(ZIP)・テキスト(.txt)', async () => {
  const page = await openViewer(ctx, '/pdf/book-8.pdf', { page: await newPage() });
  const zip = await convertVia(page, 'images', { dpi: 150 });
  eq(path.basename(zip), 'book-8_画像.zip', 'ZIP の名前');
  const z = zipEntries(zip);
  eq(z.order, ['001.png', '002.png', '003.png', '004.png', '005.png', '006.png', '007.png', '008.png'], 'ZIP の中身');
  const txt = await convertVia(page, 'text');
  eq(path.basename(txt), 'book-8.txt', 'テキストの名前');
  const text = fs.readFileSync(txt, 'utf8');
  assert(text.charCodeAt(0) === 0xfeff, 'BOM 付き UTF-8');
  assert(text.includes('［7ページ］') && text.includes('Line 3 on page 7'), 'ページの見出しと本文');
  await page.close();
});

await R.run('L23', '詳細設定: 「電子書籍・コミック」の欄があり、変えると保存される', async () => {
  const page = await newPage();
  // 0.5: 「開く・読む」の「電子書籍・コミック」
  await page.goto(`chrome-extension://${EXT_ID}/options/options.html#sec-ebook`);
  await page.waitForSelector('#sec-ebook');
  const before = await getSettings(sw);
  try {
    await page.check('input[name="comicDirection"][value="ltr"]');
    await page.uncheck('#comicSplitSpreads');
    await sleep(800);
    const s = await getSettings(sw);
    eq([s.comicDirection, s.comicSplitSpreads], ['ltr', false], '保存');
  } finally {
    await setSettings(sw, { comicDirection: before.comicDirection || 'auto', comicSplitSpreads: before.comicSplitSpreads ?? true });
  }
  await page.close();
});

if (fs.existsSync(path.join(PDFS, 'big-200.cbz'))) {
  await R.run('L24', '大きなコミック(200 ページ・48 MB の CBZ)を PDF にして表示する速さ', async () => {
    const t0 = Date.now();
    const page = await openComic('/book/big-200.cbz');
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    eq((await viewerInfo(page)).pages, 200, 'ページ数');
    assert(+sec < 30, `時間 ${sec} 秒`);
    await page.close();
    return `${sec} 秒で表示`;
  });
}

const sum = R.summary();
if (errors.length) {
  console.log('--- ページのエラー(参考) ---');
  console.log([...new Set(errors)].slice(0, 30).join('\n'));
}
await env.close();
process.exit(sum.ok === sum.total ? 0 : 1);
