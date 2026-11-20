import { baseName, sanitizeFileName, saveBlobAs } from "../../common/files.js";
import { loadPdfFromBytes } from "../page-export.js";
import { comparePage, comparisonPdf, disposeCanvas, fitSignature, redactPdf, renderReviewPage, signedPdf } from "../pdf-review.js";

export const REVIEW_TOOLS = [
  { id: "compare", title: "PDFを比較", description: "同じページ番号の見た目を比べて違いを色で表示", category: "編集" },
  { id: "redact", title: "墨消し", description: "指定範囲を黒く塗り、元の情報を取り除いて保存", category: "編集" },
  { id: "sign", title: "手書きサイン", description: "手書きしたサインをページに配置", category: "編集" },
];
const elements = (container, selector) => [...container.querySelectorAll(selector)];
function point(event, canvas) {
  const box = canvas.getBoundingClientRect();
  const clamp = value => Math.max(0, Math.min(1, value));
  return { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) };
}

function setupInk(pad, onInk) {
  const ctx = pad.getContext("2d");
  let pointer = null, bounds = null;
  const extend = p => {
    const x = p.x * pad.width, y = p.y * pad.height;
    if (!bounds) { bounds = [x, y, x, y]; }
    bounds = [Math.min(x, bounds[0]), Math.min(y, bounds[1]), Math.max(x, bounds[2]), Math.max(y, bounds[3])];
    return [x, y];
  };
  function publish() {
    if (!bounds) { onInk(null); return; }
    const left = Math.max(0, Math.floor(bounds[0] - 5));
    const top = Math.max(0, Math.floor(bounds[1] - 5));
    const ink = document.createElement("canvas");
    ink.width = Math.min(pad.width, Math.ceil(bounds[2] + 5)) - left;
    ink.height = Math.min(pad.height, Math.ceil(bounds[3] + 5)) - top;
    ink.getContext("2d").drawImage(pad, left, top, ink.width, ink.height, 0, 0, ink.width, ink.height);
    onInk(ink);
  }
  pad.onpointerdown = event => {
    if (pointer !== null || event.button !== 0 || pad.closest("dialog").dataset.busy === "true") { return; }
    event.preventDefault();
    pointer = event.pointerId;
    pad.setPointerCapture(pointer);
    const [x, y] = extend(point(event, pad));
    ctx.lineWidth = 4;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.strokeStyle = ctx.fillStyle = "#111827";
    ctx.beginPath(); ctx.arc(x, y, 2, 0, 2 * Math.PI); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x, y);
  };
  pad.onpointermove = event => {
    if (pointer !== event.pointerId) { return; }
    const [x, y] = extend(point(event, pad));
    ctx.lineTo(x, y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x, y);
  };
  pad.onpointerup = pad.onpointercancel = event => {
    if (pointer !== event.pointerId) { return; }
    pointer = null; publish();
  };
  return () => { bounds = null; pointer = null; ctx.clearRect(0, 0, pad.width, pad.height); publish(); };
}

export function runReviewTool(id) {
  const tool = REVIEW_TOOLS.find(item => item.id === id);
  if (!tool) { throw new Error("未対応のツールです"); }
  if (document.getElementById("shReviewTool")?.open) { return; }
  const comparing = id === "compare", signing = id === "sign";
  const dialog = document.createElement("dialog");
  dialog.id = "shReviewTool";
  dialog.className = "sh-dialog sh-review-dialog";
  dialog.setAttribute("aria-labelledby", "shReviewTitle");
  dialog.innerHTML = `
    <header><h2 id="shReviewTitle"></h2><button class="sh-btn" data-close>閉じる</button></header>
    <div class="sh-review-layout">
      <aside>
        <div data-files></div>
        <label data-mode-label>表示<select data-mode>
          <option value="diff">差分を表示</option><option value="first">変更前</option><option value="second">変更後</option>
        </select></label>
        <p data-help></p>
        <div data-ink-box><label>ここにサインを書く</label><canvas width="640" height="200" data-ink aria-label="手書きサイン用の入力面"></canvas>
          <button class="sh-btn" data-clear>サインを書き直す</button></div>
        <button class="sh-btn" data-undo>直前の範囲を取り消す</button>
        <button class="sh-btn" data-next-diff>次の違いを探す</button>
      </aside>
      <section class="sh-review-work">
        <div class="sh-review-nav">
          <button class="sh-btn" data-step="-1" aria-label="前のページ">前へ</button>
          <input type="number" min="1" step="1" value="1" data-page aria-label="ページ番号"><span data-count> / 0</span>
          <button class="sh-btn" data-step="1" aria-label="次のページ">次へ</button>
          <label>表示倍率 <select data-zoom><option value="fit">全体</option><option value="width">幅に合わせる</option><option value="2">幅の2倍</option></select></label>
        </div>
        <div class="sh-review-stage"><div class="sh-review-paper" hidden><canvas data-page-preview></canvas>
          <canvas data-overlay aria-label="ページ上の対象範囲をドラッグで指定"></canvas></div></div>
      </section>
    </div>
    <footer><p role="status"></p><button class="sh-btn sh-btn-primary" data-run></button></footer>`;
  const q = selector => dialog.querySelector(selector);
  q("h2").textContent = tool.title;
  q("[data-mode-label]").hidden = !comparing;
  q("[data-ink-box]").hidden = !signing;
  q("[data-undo]").hidden = comparing;
  q("[data-next-diff]").hidden = !comparing;
  q("[data-help]").textContent = comparing ? "変更後に濃くなった箇所は青、薄くなった箇所は赤で表示します。小さな色の差は除きます。"
    : signing ? "サインを書いてから、ページ上で配置する範囲をドラッグしてください。手書きの画像を配置します。電子証明書による署名には対応していません。"
    : "ページ上で墨消しする範囲をドラッグしてください。保存時に全ページを画像化し、隠した内容や元の文字・フォーム・添付ファイルを取り除きます。";
  const docs = [null, null], names = ["", ""], loadIds = [0, 0], loading = [false, false];
  const regions = [];
  const status = q('[role="status"]'), nav = q("[data-page]"), paper = q(".sh-review-paper");
  const overlay = q("[data-overlay]"), run = q("[data-run]");
  const opener = document.activeElement;
  let page = 1, prepared = null, ink = null, anchor = null, draft = null, pointer = null;
  let busy = false, saving = false, drawing = false, token = 0, renderQueue = Promise.resolve(), jobPromise = null, abort = null;
  const ready = () => !!docs[0] && (!comparing || !!docs[1]) && !loading.some(Boolean);
  const count = () => comparing ? Math.max(docs[0]?.numPages || 0, docs[1]?.numPages || 0) : docs[0]?.numPages || 0;
  const live = seq => dialog.open && seq === token;
  function refresh() {
    dialog.dataset.busy = String(busy);
    elements(dialog, 'input[type="file"],[data-mode],[data-clear]').forEach(el => { el.disabled = busy; });
    q("[data-close]").disabled = saving;
    q("[data-undo]").disabled = busy || !regions.length;
    q("[data-next-diff]").disabled = busy || !ready() || count() < 2;
    nav.disabled = busy || !ready();
    nav.max = Math.max(1, count());
    nav.value = page;
    q("[data-count]").textContent = " / " + count();
    for (const button of elements(dialog, "[data-step]")) {
      const dest = page + Number(button.dataset.step);
      button.disabled = busy || !ready() || dest < 1 || dest > count();
    }
    run.disabled = busy || !ready() || (!comparing && !regions.length) || (signing && !ink);
    run.textContent = prepared ? "保存先を選ぶ…" : comparing ? "差分PDFを作成" : "PDFを作成";
  }
  function invalidate() { prepared = null; refresh(); }
  function layout() {
    if (paper.hidden) { return; }
    const stage = q(".sh-review-stage");
    const source = q("[data-page-preview]");
    const w = Math.max(1, stage.clientWidth - 16), h = Math.max(1, stage.clientHeight - 16);
    let scale = w / source.width;
    if (q("[data-zoom]").value === "fit") { scale = Math.min(scale, h / source.height); }
    if (q("[data-zoom]").value === "2") { scale *= 2; }
    paper.style.width = Math.max(1, source.width * scale) + "px";
  }
  function drawRegions() {
    const w = overlay.width, h = overlay.height, ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    for (const region of [...regions, ...(draft ? [draft] : [])]) {
      if (region.page !== page) { continue; }
      if (signing && ink) {
        const box = fitSignature(region, ink.width / ink.height, w / h);
        ctx.drawImage(ink, box.x * w, box.y * h, box.w * w, box.h * h);
        if (draft === region) {
          ctx.strokeStyle = "#418bea"; ctx.lineWidth = 2;
          ctx.strokeRect(region.x * w, region.y * h, region.w * w, region.h * h);
        }
      } else {
        ctx.fillStyle = "#000"; ctx.fillRect(region.x * w, region.y * h, region.w * w, region.h * h);
      }
    }
  }
  function drawPage() {
    const seq = ++token, n = page;
    draft = anchor = null; pointer = null;
    paper.hidden = true;
    drawing = true;
    refresh();
    if (!ready()) { drawing = false; return; }
    const pair = [...docs], mode = q("[data-mode]").value;
    status.textContent = "ページを表示しています…";
    renderQueue = renderQueue.then(async () => {
      if (!live(seq)) { return; }
      let rendered;
      try {
        if (comparing && mode === "diff") {
          rendered = await comparePage(pair[0], pair[1], n);
        } else {
          const doc = comparing && mode === "second" ? pair[1] : pair[0];
          if (n > doc.numPages) { status.textContent = "この文書に対応するページはありません"; return; }
          rendered = await renderReviewPage(doc, n, { scale: 3 });
        }
        if (!live(seq)) { return; }
        const old = q("[data-page-preview]");
        rendered.canvas.dataset.pagePreview = "";
        old.replaceWith(rendered.canvas); disposeCanvas(old);
        overlay.width = rendered.canvas.width; overlay.height = rendered.canvas.height;
        rendered.canvas = null;
        paper.hidden = false; layout(); drawRegions();
        if (comparing && mode === "diff") {
          status.textContent = rendered.added ? "追加されたページ" : rendered.removed ? "削除されたページ"
            : rendered.changed ? `違いあり（ページ面積の${(100 * rendered.ratio).toFixed(2)}%）` : "見た目の違いはありません";
        } else { status.textContent = comparing ? "" : `指定した範囲：全体で${regions.length}件`; }
      } catch (e) { if (live(seq)) { status.textContent = e.message; } }
      finally { disposeCanvas(rendered?.canvas); if (live(seq)) { drawing = false; refresh(); } }
    });
  }
  async function replaceFile(index, file) {
    if (!file || busy) { return; }
    const seq = ++loadIds[index];
    const previous = docs[index];
    docs[index] = null; loading[index] = true;
    const oldJobs = renderQueue;
    if (previous) { oldJobs.finally(() => previous.loadingTask.destroy()).catch(() => {}); }
    regions.length = 0; page = 1; invalidate(); drawPage();
    status.textContent = "PDFを読み込んでいます…";
    try {
      const doc = await loadPdfFromBytes(new Uint8Array(await file.arrayBuffer()));
      if (!dialog.open || seq !== loadIds[index]) { await doc.loadingTask.destroy(); return; }
      docs[index] = doc; names[index] = file.name;
      status.textContent = comparing && !docs[1 - index] ? "比較するもう1つのPDFを選んでください" : "";
    } catch (err) {
      if (seq === loadIds[index] && dialog.open) { status.textContent = err.name === "PasswordException" ? "保護を解除したPDFを選んでください" : "PDFを読み込めませんでした"; }
    } finally {
      if (dialog.open && seq === loadIds[index]) { loading[index] = false; drawPage(); }
    }
  }
  for (let i = 0; i < (comparing ? 2 : 1); i++) {
    const label = document.createElement("label");
    label.textContent = comparing ? ["変更前のPDF", "変更後のPDF"][i] : "対象のPDF";
    const picker = document.createElement("input");
    picker.type = "file"; picker.accept = ".pdf,application/pdf";
    picker.onchange = () => replaceFile(i, picker.files[0]);
    label.append(picker); q("[data-files]").append(label);
  }
  const resize = new ResizeObserver(layout);
  resize.observe(q(".sh-review-stage"));
  q("[data-mode]").onchange = drawPage;
  q("[data-zoom]").onchange = layout;
  nav.onchange = () => {
    const n = Number(nav.value);
    if (!Number.isInteger(n) || n < 1 || n > count()) { nav.value = page; return; }
    page = n; drawPage();
  };
  for (const button of elements(dialog, "[data-step]")) {
    button.onclick = () => { page += Number(button.dataset.step); drawPage(); };
  }
  const resetInk = setupInk(q("[data-ink]"), canvas => {
    disposeCanvas(ink); ink = canvas; invalidate(); drawRegions();
  });
  q("[data-clear]").onclick = resetInk;
  q("[data-undo]").onclick = () => {
    const removed = regions.pop();
    page = removed.page; invalidate(); drawPage();
  };
  overlay.onpointerdown = event => {
    if (busy || comparing || drawing || pointer !== null || event.button !== 0) { return; }
    if (signing && !ink) { status.textContent = "先にサインを入力してください"; return; }
    event.preventDefault();
    pointer = event.pointerId; overlay.setPointerCapture(pointer);
    anchor = point(event, overlay);
  };
  overlay.onpointermove = event => {
    if (pointer !== event.pointerId) { return; }
    const dest = point(event, overlay);
    draft = { x: Math.min(dest.x, anchor.x), y: Math.min(dest.y, anchor.y),
      w: Math.abs(dest.x - anchor.x), h: Math.abs(dest.y - anchor.y), page };
    drawRegions();
  };
  overlay.onpointerup = event => {
    if (pointer !== event.pointerId) { return; }
    overlay.onpointermove(event);
    if (draft && draft.w * overlay.clientWidth >= 3 && draft.h * overlay.clientHeight >= 3) { regions.push(draft); }
    pointer = null; draft = anchor = null;
    drawRegions(); invalidate(); status.textContent = `指定した範囲：全体で${regions.length}件`;
  };
  overlay.onpointercancel = () => { pointer = null; draft = anchor = null; drawRegions(); };
  overlay.style.touchAction = comparing ? "pan-x pan-y" : "none";
  function job(task) {
    if (busy) { return; }
    busy = true; refresh();
    const controller = abort = new AbortController();
    const progress = msg => { if (!controller.signal.aborted) { status.textContent = msg; } };
    jobPromise = (async () => {
      try { await renderQueue; controller.signal.throwIfAborted(); await task(progress, controller.signal); }
      catch (error) { if (!controller.signal.aborted) { status.textContent = error.message || "処理できませんでした"; } }
      finally { busy = saving = false; if (dialog.open) { refresh(); } }
    })();
  }
  q("[data-next-diff]").onclick = () => job(async (progress, signal) => {
    for (let offset = 1; offset < count(); offset++) {
      signal.throwIfAborted();
      const next = (page - 1 + offset) % count() + 1;
      progress(`${next}ページの違いを確認しています…`);
      const result = await comparePage(docs[0], docs[1], next);
      disposeCanvas(result.canvas);
      signal.throwIfAborted();
      if (result.changed) { page = next; q("[data-mode]").value = "diff"; drawPage(); return; }
    }
    progress("ほかのページには見た目の違いがありません");
  });
  run.onclick = () => job(async (progress, signal) => {
    if (prepared) {
      saving = true; refresh();
      const saved = await saveBlobAs(prepared.blob, prepared.name);
      progress(saved.ok ? "保存しました" : saved.canceled ? "保存をキャンセルしました" : (saved.error || "保存できませんでした"));
      return;
    }
    let bytes;
    if (comparing) { bytes = await comparisonPdf(docs[0], docs[1], progress, signal); }
    else if (signing) {
      const signature = await new Promise(resolve => ink.toBlob(resolve, "image/png"));
      bytes = await signedPdf(docs[0], regions, signature, progress, signal);
    } else { bytes = await redactPdf(docs[0], regions, progress, signal); }
    signal.throwIfAborted();
    const suffix = comparing ? "差分" : signing ? "サイン" : "墨消し済み";
    const name = `${sanitizeFileName(baseName(names[0]))}_${suffix}.pdf`;
    prepared = { blob: new Blob([bytes], { type: "application/pdf" }), name };
    progress(name + " を保存できます");
  });
  q("[data-close]").onclick = () => { if (!saving) { abort?.abort(); dialog.close(); } };
  dialog.oncancel = e => { if (saving) { e.preventDefault(); } else { abort?.abort(); } };
  dialog.onclose = () => {
    ++token; abort?.abort(); resize.disconnect();
    const done = Promise.allSettled([renderQueue, jobPromise]);
    for (const doc of docs) { if (doc) { done.then(() => doc.loadingTask.destroy()).catch(() => {}); } }
    for (const canvas of elements(dialog, "canvas")) { disposeCanvas(canvas); }
    disposeCanvas(ink); dialog.remove(); opener?.focus();
  };
  document.body.append(dialog); refresh(); dialog.showModal(); q('input[type="file"]').focus();
}
