const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('path'), fs = require('fs'), assert = require('assert');
(async () => {
  const ext = path.resolve(__dirname, '../../src');
  const ctx = await chromium.launchPersistentContext(path.join(require('os').tmpdir(), 'seihon-progressive-' + Date.now()), {
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`], viewport: { width: 1100, height: 740 },
  });
  let page;
  try {
    page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR', e.message); });
    page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
    await page.goto('chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/viewer/viewer.html');
    await page.waitForFunction(() => window.__seihonViewer);
    await page.bringToFront();
    await page.evaluate(async () => {
      const { saveSettings, DEFAULT_SETTINGS } = await import('../common/settings.js');
      await saveSettings({ ...DEFAULT_SETTINGS, scanArrange: 'auto', scanDebugShow: true });
      window.a = __seihonViewer.scanArranger;
      window.scanMetrics = { openings: [], samples: [], anchors: [] };
      PDFViewerApplication.eventBus.on('pagerendered', () => {
        if (a.isArranged && !scanMetrics.firstRenderedMs) scanMetrics.firstRenderedMs = performance.now() - startAt;
      });
      const sample = a.samplePages.bind(a);
      a.samplePages = function (base) { const list = sample(base); scanMetrics.samples.push(list); return list; };
      const present = a.presentArranged.bind(a);
      a.presentArranged = async function (...args) {
        const before = this.captureReadingPosition();
        const ok = await present(...args);
        scanMetrics.openings.push({ at: performance.now(), done: this.base.scans.filter(Boolean).length, pages: this.arranged?.pages.length, partial: this.arranged?.partial });
        if (args[4]?.quiet) scanMetrics.anchors.push({ before, after: this.captureReadingPosition() });
        return ok;
      };
      const source = new Uint8Array(await (await fetch('../tools/test-server/samples/scan-spread.pdf')).arrayBuffer());
      const { PDFDocument } = await import('../lib/pdf-lib.esm.min.js');
      const old = await PDFDocument.load(source), doc = await PDFDocument.create();
      for (let i = 0; i < 6; i++) { for (const p of await doc.copyPages(old, old.getPageIndices())) doc.addPage(p); }
      window.longBytes = await doc.save();
      window.startAt = performance.now();
      await PDFViewerApplication.open({ data: longBytes.slice() });
    });
    await page.waitForFunction(() => a.isArranged && a.arranged.partial, null, { timeout: 30000 });
    const first = await page.evaluate(() => ({ ms: performance.now() - startAt, scans: a.base.scans.filter(Boolean).length, samples: scanMetrics.samples, pages: a.arranged.pages.length }));
    assert(first.samples.every(s => s.length <= 3));
    assert(first.samples[0].every(n => n <= 2));
    console.log('PASS nearby-first', JSON.stringify(first));
    await page.waitForFunction(() => !a.presenting, null, { timeout: 30000 });
    const partialCollection = await page.evaluate(async () => {
      const key = await __seihonViewer.docSource.key();
      const count = PDFViewerApplication.pdfDocument.numPages;
      await __seihonViewer.collection.addCurrentPages([1]);
      return { key, count };
    });
    assert(partialCollection.key.includes('#partial:'));
    await page.evaluate(() => { PDFViewerApplication.pdfViewer.currentScaleValue = 1.3; PDFViewerApplication.pdfViewer.container.scrollTop += 180; });
    await page.waitForFunction(() => a.base.analyzed && !a.arranged.partial && !a.presenting && !a.base.refreshJob, null, { timeout: 120000 });
    const completed = await page.evaluate(() => ({ done: a.base.scans.filter(Boolean).length, pages: a.arranged.pages.length, metrics: scanMetrics, logs: a.debugLog, position: a.captureReadingPosition() }));
    assert.equal(completed.done, 24); assert.equal(completed.pages, 48);
    assert(completed.metrics.anchors.length > 0);
    for (const anchor of completed.metrics.anchors) {
      assert.equal(anchor.after.src, anchor.before.src);
      assert(Math.abs(anchor.after.y - anchor.before.y) < .015, JSON.stringify(anchor));
      assert.equal(anchor.after.scale, anchor.before.scale);
    }
    console.log('PASS progressive completion and reading anchor', completed.metrics.openings.length);
    const collectionVersions = await page.evaluate(async () => {
      const { getPdfBytes } = await import('../common/db.js');
      const { loadPdfFromBytes } = await import('./page-export.js');
      await __seihonViewer.collection.addCurrentPages([48]);
      const items = __seihonViewer.collection.items;
      const versions = [];
      for (const item of items) {
        const doc = await loadPdfFromBytes(await getPdfBytes(item.pdfKey));
        try { versions.push({ key: item.pdfKey, count: doc.numPages, index: item.pageIndex, text: (await (await doc.getPage(item.pageIndex + 1)).getTextContent()).items.map(x => x.str).join(' ') }); }
        finally { await doc.loadingTask.destroy(); }
      }
      return versions;
    });
    assert.equal(collectionVersions.length, 2);
    assert.notEqual(collectionVersions[0].key, collectionVersions[1].key);
    assert.equal(collectionVersions[0].count, partialCollection.count);
    assert.equal(collectionVersions[1].count, 48);
    assert(collectionVersions[0].text.includes('OCR-P16'));
    assert(collectionVersions[1].text.includes('OCR-P23'));
    console.log('PASS collection keeps partial and completed documents separate');
    const scheduler = await page.evaluate(async () => {
      const { ReadAhead } = await import('./scan/read-ahead.js');
      const q = new ReadAhead(); q.reset(10, 0); q.move(11, { now: 1000 }); const forward = q.order(60).slice(0, 8);
      q.move(10, { now: 1200 }); const backward = q.order(60).slice(0, 8), fast = q.ahead;
      q.move(45, { now: 1250, jump: true }); const jumped = q.order(60), slow = q.ahead;
      return { forward, backward, fast, slow, jumped, size: new Set(jumped).size };
    });
    assert.deepEqual(scheduler.forward.slice(0, 3), [11, 12, 10]);
    assert.deepEqual(scheduler.backward.slice(0, 4), [10, 9, 11, 8]);
    assert(scheduler.fast > scheduler.slow); assert.equal(scheduler.jumped[0], 45); assert.equal(scheduler.size, 60);
    console.log('PASS direction, speed and jump priority');
    await page.locator('#shPageInput').fill('35'); await page.locator('#shPageInput').press('Enter');
    await page.waitForFunction(() => PDFViewerApplication.page === 35);
    assert.equal(await page.evaluate(() => a.readAhead.speed), 0);
    console.log('PASS numbered-page jump has no correction wait');
    const text = await page.evaluate(async () => {
      const { loadPdfFromBytes, extractPagesToPdf } = await import('./page-export.js');
      const d = await loadPdfFromBytes(await extractPagesToPdf(PDFViewerApplication.pdfDocument, [{ source: 'current', pageIndex: 0 }]));
      try { return { text: (await (await d.getPage(1)).getTextContent()).items.map(x => x.str).join(' '), pages: d.numPages }; }
      finally { await d.loadingTask.destroy(); }
    });
    assert(text.text.includes('OCR-P16')); assert.equal(text.pages, 1);
    console.log('PASS corrected export keeps searchable OCR');
    await page.evaluate(async () => {
      window.bookletBytes = new Uint8Array(await (await fetch('../tools/test-server/samples/scan-booklet.pdf')).arrayBuffer());
      await PDFViewerApplication.open({ data: bookletBytes.slice() });
    });
    await page.waitForFunction(() => a.isArranged && a.base.analyzed && !a.arranged.partial && !a.presenting && !a.base.refreshJob, null, { timeout: 60000 });
    const booklet = await page.evaluate(() => ({ mode: a.arranged.options.mode, sources: a.arranged.pages.map(p => p.src), kind: a.kind }));
    assert.equal(booklet.mode, 'none'); assert.deepEqual(booklet.sources, [0,1,2,3,4,5,6,7]);
    console.log('PASS flat booklet automatic correction keeps source order', booklet.kind);
    await page.evaluate(async () => {
      await a.restore({ remember: true }); await PDFViewerApplication.pdfViewer.pagesPromise; await PDFViewerApplication.open({ data: bookletBytes.slice() });
    });
    await page.waitForFunction(() => a.base?.checked, null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => a.isArranged), false);
    console.log('PASS explicitly remembered original remains original');
    await page.evaluate(async () => {
      const { PDFDocument } = await import('../lib/pdf-lib.esm.min.js');
      const doc = await PDFDocument.load(longBytes); doc.setTitle('Dirty protection');
      await PDFViewerApplication.open({ data: await doc.save() });
    });
    await page.waitForFunction(() => a.isArranged && a.arranged.partial && !a.presenting, null, { timeout: 30000 });
    const dirtyProtection = await page.evaluate(async () => {
      const doc = PDFViewerApplication.pdfDocument;
      a.pageEditor.setTitle('Edited while analyzing');
      await a.base.finishJob;
      await new Promise(r => setTimeout(r, 3500));
      const protectedDoc = PDFViewerApplication.pdfDocument === doc && a.pageEditor.dirty;
      await __seihonViewer.pageRoles.set([1], 'cover', { quiet: true });
      a.pageEditor.setTitle(null);
      await new Promise(r => setTimeout(r, 3500));
      const roleProtected = PDFViewerApplication.pdfDocument === doc && __seihonViewer.pageRoles.get(1) === 'cover';
      await __seihonViewer.pageRoles.set([1], null, { quiet: true });
      return { protectedDoc, roleProtected };
    });
    assert(dirtyProtection.protectedDoc && dirtyProtection.roleProtected);
    await page.waitForFunction(() => !a.arranged.partial && !a.presenting && !a.base.refreshJob, null, { timeout: 60000 });
    console.log('PASS editing and assigned roles prevent refresh; removing them resumes it');
    await page.evaluate(async () => {
      const { PDFDocument } = await import('../lib/pdf-lib.esm.min.js');
      const doc = await PDFDocument.load(longBytes); doc.setTitle('Continuous scrolling');
      await PDFViewerApplication.open({ data: await doc.save() });
    });
    await page.waitForFunction(() => a.isArranged && a.arranged.partial && !a.presenting, null, { timeout: 30000 });
    const scrolling = await page.evaluate(async () => {
      PDFViewerApplication.pdfViewer.currentScaleValue = 1.3;
      await new Promise(r => requestAnimationFrame(r));
      const doc = PDFViewerApplication.pdfDocument;
      const container = PDFViewerApplication.pdfViewer.container;
      container.scrollTop = 100;
      let events = 0;
      const counted = () => { events++; };
      container.addEventListener('scroll', counted);
      for (let i = 0; i < 60; i++) {
        const delta = i % 2 ? -2 : 2;
        container.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, bubbles: true }));
        container.scrollTop += delta;
        await new Promise(r => setTimeout(r, 100));
      }
      container.removeEventListener('scroll', counted);
      return { unchanged: doc === PDFViewerApplication.pdfDocument, events, scrollHeight: container.scrollHeight, height: container.clientHeight };
    });
    assert(scrolling.events > 0, JSON.stringify(scrolling));
    assert(scrolling.unchanged, JSON.stringify(scrolling));
    await page.waitForFunction(() => !a.arranged.partial && !a.presenting && !a.base.refreshJob, null, { timeout: 60000 });
    console.log('PASS continuous scrolling defers refresh');
    await page.evaluate(async () => {
      const { saveSettings, DEFAULT_SETTINGS } = await import('../common/settings.js');
      await saveSettings({ ...DEFAULT_SETTINGS, scanArrange: 'ask' });
    });
    await page.waitForFunction(() => a.getSettings().scanArrange === 'ask');
    await page.evaluate(async () => { await PDFViewerApplication.open({ data: longBytes.slice() }); });
    await page.waitForFunction(() => a.base?.checked && a.state === 'suggest', null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => a.isArranged), false);
    console.log('PASS ask setting never automatically applies');
    await page.evaluate(async () => {
      const { saveSettings, DEFAULT_SETTINGS } = await import('../common/settings.js');
      await saveSettings({ ...DEFAULT_SETTINGS, scanArrange: 'off', scanDeskew: 'off' });
    });
    await page.waitForFunction(() => a.getSettings().scanArrange === 'off' && a.getSettings().scanDeskew === 'off');
    await page.evaluate(async () => { await PDFViewerApplication.open({ data: longBytes.slice() }); await PDFViewerApplication.pdfViewer.pagesPromise; });
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => a.base.scans.filter(Boolean).length), 0);
    assert.equal(await page.evaluate(() => a.isArranged), false);
    console.log('PASS off setting skips automatic analysis');
    const canceledOpen = await page.evaluate(async () => {
      const base = a.base;
      const options = a.correctionOptions();
      const pages = Array.from({ length: base.pageCount }, (_, src) => ({ src, half: null, rect: null, rotate: 0, masks: [] }));
      let opened = 0;
      const originalOpen = a.openDocument;
      a.openDocument = async () => { opened++; return false; };
      try {
        // 別のPDFの取得が始まったがdocumentloaded前、という競合の境界を再現する。
        a.beforeUserOpen();
        const applied = await a.presentArranged(base, options, pages, longBytes.slice(), { auto: true });
        return { applied, opened, alive: a.alive(base) };
      } finally { a.openDocument = originalOpen; }
    });
    assert.deepEqual(canceledOpen, { applied: false, opened: 0, alive: false });
    console.log('PASS obsolete correction cannot reopen during next-file loading');
    assert.deepEqual(errors, []);
    fs.mkdirSync(path.resolve(__dirname, '../logs'), { recursive: true });
    fs.writeFileSync(path.resolve(__dirname, '../logs/progressive-scan-results.json'), JSON.stringify({ first, completed, partialCollection, collectionVersions, scheduler, booklet, text, dirtyProtection, scrolling, canceledOpen, errors }, null, 2));
  } catch (e) {
    console.log("STATE", JSON.stringify(await page.evaluate(() => ({ state:a.state, partial:a.arranged?.partial, done:a.base?.scans.filter(Boolean).length, analyzed:a.base?.analyzed, opts:!!a.base?.refreshOptions, job:!!a.base?.refreshJob, timer:!!a.base?.refreshTimer, dirty:a.pageEditor.dirty, mode:a.editorMode, dialogs:document.querySelectorAll("dialog[open]").length, selection:window.getSelection()?.isCollapsed, visible:[...a.visibleSources()], logs:a.debugLog, metrics:scanMetrics }))));
    throw e;
  } finally { await ctx.close(); }
})().catch(e => { console.error(e); process.exit(1); });
