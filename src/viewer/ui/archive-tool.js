/** 印刷時のページの見た目を固定した PDF/A-2b をローカルで作成する。 */
import { baseName, formatBytes, sanitizeFileName, saveBlobAs } from "../../common/files.js";
import { loadPdfFromBytes } from "../page-export.js";
import { disposeCanvas, renderReviewPage } from "../pdf-review.js";

export const ARCHIVE_TOOLS = [
  { id: "pdfa", title: "PDF/Aに変換", description: "各ページを画像化して長期保存用PDF/A-2bにまとめる", category: "形式変換" },
];

const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

export async function archivePdf(doc, dpi, progress, signal) {
  if (![150, 200, 300].includes(dpi)) { throw new Error("解像度を選んでください"); }
  const { PDFDocument, PDFName, PDFString, PDFHexString, PDFNumber } = await import("../../lib/pdf-lib.esm.min.js");
  const color = await fetch(new URL("../../vendor/compact-icc/sRGB-v2-micro.icc", import.meta.url));
  if (!color.ok) { throw new Error("同梱の色プロファイルを開けませんでした"); }
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const context = pdf.context;
  const icc = context.register(context.flateStream(new Uint8Array(await color.arrayBuffer()), { N: 3 }));
  const intent = context.register(context.obj({
    Type: "OutputIntent", S: "GTS_PDFA1", OutputConditionIdentifier: PDFString.of("sRGB IEC61966-2.1"),
    RegistryName: PDFString.of("http://www.color.org"), DestOutputProfile: icc,
  }));
  pdf.catalog.set(PDFName.of("OutputIntents"), context.obj([intent]));
  const metadata = context.stream(new TextEncoder().encode(xmp), { Type: "Metadata", Subtype: "XML" });
  pdf.catalog.set(PDFName.of("Metadata"), context.register(metadata));
  const fileId = PDFHexString.of(crypto.randomUUID().replaceAll("-", ""));
  context.trailerInfo.ID = context.obj([fileId, fileId]);
  for (let n = 1; n <= doc.numPages; n++) {
    signal?.throwIfAborted();
    progress?.(`ページを画像にしています（${n}/${doc.numPages}）`);
    const { base, canvas } = await renderReviewPage(doc, n, { scale: dpi / 72, longest: 6000 });
    try {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (!blob) { throw new Error("ページを画像にできませんでした"); }
      const image = await pdf.embedPng(await blob.arrayBuffer());
      // 大判ページもMediaBoxの座標範囲内に収め、物理寸法はUserUnitで保つ。
      const unit = Math.max(1, Math.ceil(Math.max(base.width, base.height) / 14400));
      if (unit > 75000 || Math.min(base.width, base.height) / unit < 1) {
        throw new Error(`${n}ページ目はPDF/Aで保存できる用紙寸法を超えています`);
      }
      const width = base.width / unit, height = base.height / unit;
      const sheet = pdf.addPage([width, height]);
      if (unit !== 1) { sheet.node.set(PDFName.of("UserUnit"), PDFNumber.of(unit)); }
      sheet.drawImage(image, { x: 0, y: 0, width, height });
    } finally { disposeCanvas(canvas); }
  }
  signal?.throwIfAborted();
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}

export function runArchiveTool(id) {
  if (id !== "pdfa") { throw new Error("未対応のツールです"); }
  if (document.getElementById("shArchiveTool")?.open) { return; }
  const dialog = document.createElement("dialog");
  dialog.id = "shArchiveTool";
  dialog.className = "sh-dialog sh-pdf-tool-dialog";
  dialog.setAttribute("aria-labelledby", "shArchiveTitle");
  dialog.innerHTML = `<header><h2 id="shArchiveTitle">PDF/Aに変換</h2><button class="sh-btn" data-close>閉じる</button></header>
    <div class="sh-tool-body"><fieldset><div class="sh-tool-fields">
      <label>対象のPDF<input type="file" accept=".pdf,application/pdf"></label>
      <label>ページ画像の解像度<select><option value="150">150 dpi</option><option value="200" selected>200 dpi</option><option value="300">300 dpi</option></select></label>
    </div></fieldset><p data-hint>印刷時の見た目を画像にしてPDF/A-2bに保存します。文字の検索・選択、注釈の再編集、リンク、入力フォーム、添付ファイルは使えなくなります。</p></div>
    <footer><p role="status"></p><button class="sh-btn sh-btn-primary" data-run disabled>PDF/Aを作成</button></footer>`;
  const q = selector => dialog.querySelector(selector);
  const picker = q("input"), dpi = q("select"), run = q("[data-run]"), status = q("[role=status]");
  const opener = document.activeElement;
  let prepared = null, abort = null, saving = false, busy = false;
  function reset() {
    prepared = null; status.textContent = ""; run.textContent = "PDF/Aを作成"; run.disabled = !picker.files.length;
  }
  picker.onchange = dpi.onchange = reset;
  const close = () => { if (!saving) { abort?.abort(); dialog.close(); } };
  q("[data-close]").onclick = close;
  dialog.oncancel = event => { if (saving) { event.preventDefault(); } else { abort?.abort(); } };
  dialog.onclose = () => { abort?.abort(); prepared = null; dialog.remove(); opener?.focus(); };
  run.onclick = async () => {
    if (busy || !picker.files.length) { return; }
    busy = true;
    const controller = abort = new AbortController();
    const progress = msg => { if (dialog.open && !controller.signal.aborted) { status.textContent = msg; } };
    run.disabled = q("fieldset").disabled = true;
    try {
      if (prepared) {
        saving = true; q("[data-close]").disabled = true;
        const result = await saveBlobAs(prepared.blob, prepared.name);
        progress(result.ok ? "保存しました" : result.canceled ? "保存をキャンセルしました" : result.error || "保存できませんでした");
      } else {
        const file = picker.files[0];
        progress("PDFを開いています…");
        const doc = await loadPdfFromBytes(new Uint8Array(await file.arrayBuffer()));
        try {
          const bytes = await archivePdf(doc, Number(dpi.value), progress, controller.signal);
          controller.signal.throwIfAborted();
          const name = `${sanitizeFileName(baseName(file.name))}_PDF-A-2b.pdf`;
          prepared = { blob: new Blob([bytes], { type: "application/pdf" }), name };
          run.textContent = "保存先を選ぶ…";
          progress(name + "（" + formatBytes(bytes.length) + "）");
        } finally { await doc.loadingTask.destroy(); }
      }
    } catch (e) { progress(e.name === "PasswordException" ? "保護を解除したPDFを選んでください" : e.message); }
    finally {
      run.disabled = q("fieldset").disabled = q("[data-close]").disabled = false;
      busy = saving = false;
    }
  };
  document.body.append(dialog); dialog.showModal(); picker.focus();
}
