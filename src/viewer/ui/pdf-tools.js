/** PDFファイルを選んで実行するローカルツールの設定画面。 */
import { formatBytes, saveBlobAs } from "../../common/files.js";
import { describeToolFile, preparePdfTool } from "../pdf-tool-operations.js";

export const PDF_TOOLS = [
  { id: "merge", title: "PDFを結合", description: "複数の文書を好きな順にまとめる", category: "ページ整理" },
  { id: "split", title: "PDFを分割", description: "指定枚数や範囲ごとに分けてZIPに保存", category: "ページ整理" },
  { id: "extract", title: "ページを抽出", description: "必要なページを選んで別のPDFに保存", category: "ページ整理" },
  { id: "reorder", title: "ページを並べ替え", description: "ページ番号で順序を指定する", category: "ページ整理" },
  { id: "delete", title: "ページを削除", description: "指定ページを除いたPDFを作る", category: "ページ整理" },
  { id: "rotate", title: "ページを回転", description: "全ページまたは一部分の向きを変える", category: "ページ整理" },
  { id: "insert-blank", title: "白紙を挿入", description: "先頭やページの間に同じ大きさの白紙を追加", category: "ページ整理" },
  { id: "crop-margins", title: "余白を切り取る", description: "四辺の余白をミリ単位で切り取る", category: "編集" },
  { id: "compress", title: "PDFを圧縮", description: "保存方法や画像の解像度を変えて軽くする", category: "最適化" },
  { id: "watermark", title: "透かしを追加", description: "ページ中央に半透明の文字を重ねる", category: "編集" },
  { id: "number", title: "ページ番号を追加", description: "選んだページの下部に連番を付ける", category: "編集" },
  { id: "metadata", title: "文書情報を編集", description: "PDFのタイトル・作成者・件名を設定", category: "編集" },
];

const targetPages = { key: "pages", label: "対象ページ", placeholder: "すべて（例：1-3,5）" };
const fields = {
  merge: [],
  split: [
    { key: "splitMode", label: "分け方", choices: [["step", "一定の枚数ごと"], ["range", "範囲を指定"]] },
    { key: "step", label: "1ファイルのページ数", value: 1, min: 1 },
    { key: "pages", label: "範囲（カンマごとに別のPDF）", placeholder: "例：1-3,4-6,9" },
  ],
  extract: [{ key: "pages", label: "保存するページ", placeholder: "例：1-3,5" }],
  delete: [{ key: "pages", label: "取り除くページ", placeholder: "例：2,5-8" }],
  reorder: [{ key: "pages", label: "全ページの順序", placeholder: "例：3,1-2,4-6" }],
  rotate: [
    { key: "angle", label: "回す向き", choices: [["90", "右へ90°"], ["270", "左へ90°"], ["180", "180°"]] },
    targetPages,
  ],
  "crop-margins": [{ key: "margin", label: "各辺から切り取る幅（mm）", value: 5, min: 0.1, step: "any" }, targetPages],
  "insert-blank": [
    { key: "after", label: "何ページ目の後に入れるか（0で先頭）", value: 0, min: 0 },
    { key: "amount", label: "白紙の枚数", value: 1, min: 1, max: 1000 },
  ],
  compress: [{ key: "quality", label: "圧縮方法", choices: [
    ["lossless", "文字・リンク・画質を維持"], ["150", "画像化・標準（150dpi）"], ["100", "画像化・軽量（100dpi）"],
  ] }],
  watermark: [
    { key: "text", label: "透かしの文字", value: "見本", maxLength: 120 },
    { key: "opacity", label: "濃さ（%）", value: 25, min: 1, max: 100 }, targetPages,
  ],
  number: [
    { key: "start", label: "開始番号", value: 1, min: 0, max: 99999999 },
    { key: "align", label: "位置", choices: [["center", "下中央"], ["left", "左下"], ["right", "右下"]] }, targetPages,
  ],
  metadata: [
    { key: "title", label: "タイトル" }, { key: "author", label: "作成者" }, { key: "subject", label: "件名" },
  ],
};

function controlButton(text, action, ariaLabel) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sh-btn";
  button.textContent = text;
  if (ariaLabel) { button.setAttribute("aria-label", ariaLabel); }
  button.addEventListener("click", action);
  return button;
}

function friendlyError(error) {
  if (/password|encrypted/i.test(error.message)) { return "この操作には、パスワード保護を解除したPDFを選んでください"; }
  if (/Failed to parse PDF|parse PDF document|Invalid PDF|No PDF header/i.test(error.message)) { return "PDFを読み取れませんでした。ファイルを確認してください"; }
  return error.message || "ファイルを処理できませんでした";
}

export function runPdfTool(id) {
  const tool = PDF_TOOLS.find(item => item.id === id);
  if (!tool) { throw new Error("未対応のツールです"); }
  const active = document.querySelector("#shPdfToolDialog");
  if (active?.open) { return; }
  active?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "shPdfToolDialog";
  dialog.className = "sh-dialog sh-pdf-tool-dialog";
  dialog.setAttribute("aria-labelledby", "shPdfToolTitle");
  dialog.innerHTML = `
    <header><h2 id="shPdfToolTitle"></h2><button type="button" class="sh-btn" data-close>閉じる</button></header>
    <div class="sh-tool-body">
      <fieldset data-editor>
        <div class="sh-tool-input">
          <button type="button" class="sh-btn" data-choose></button><span>またはここにドロップ</span>
          <input type="file" accept=".pdf,application/pdf" hidden>
        </div>
        <ol class="sh-tool-files"></ol>
        <div class="sh-tool-fields"></div><p data-hint></p>
      </fieldset>
    </div>
    <footer><p data-status role="status"></p>
      <button type="button" class="sh-btn sh-btn-primary" data-run>作成する</button>
    </footer>`;
  const q = selector => dialog.querySelector(selector);
  const picker = q('input[type="file"]');
  const form = q("[data-editor]");
  const choose = q("[data-choose]");
  const status = q("[data-status]");
  const run = q("[data-run]");
  const list = q(".sh-tool-files");
  const hint = q("[data-hint]");
  q("h2").textContent = tool.title;
  picker.multiple = id === "merge";
  choose.textContent = picker.multiple ? "PDFを追加…" : "PDFを選ぶ…";
  const opener = document.activeElement;
  const entries = [];
  const inputs = {};
  let prepared = null;
  let busy = false;
  let saving = false;
  let currentJob = null;
  const close = () => { if (!saving) { currentJob?.abort(); dialog.close(); } };
  q("[data-close]").onclick = close;
  dialog.addEventListener("cancel", event => {
    if (saving) { event.preventDefault(); }
    else { currentJob?.abort(); }
  });
  dialog.addEventListener("close", () => {
    currentJob?.abort();
    entries.length = 0;
    prepared = null;
    dialog.remove();
    if (opener?.isConnected) { opener.focus(); }
  }, { once: true });

  function invalidate() {
    prepared = null;
    run.textContent = "作成する";
    status.textContent = "";
  }
  function refresh() {
    form.disabled = busy;
    q("[data-close]").disabled = saving;
    run.disabled = busy || entries.length < (picker.multiple ? 2 : 1) || entries.some(entry => !entry.info);
    if (id === "split") {
      inputs.step.parentElement.hidden = inputs.splitMode.value !== "step";
      inputs.pages.parentElement.hidden = inputs.splitMode.value !== "range";
    }
    hint.textContent = "";
    if (id === "compress" && inputs.quality.value !== "lossless") {
      hint.textContent = "画像化すると文字の検索・選択、リンクやフォームの操作ができなくなります。";
    }
    if (id === "crop-margins") { hint.textContent = "表示・印刷範囲を狭めます。切り取った部分のデータはPDFに残ります。"; }
    hint.hidden = !hint.textContent;
  }
  for (const f of fields[id]) {
    const label = document.createElement("label");
    label.textContent = f.label;
    const input = document.createElement(f.choices ? "select" : "input");
    input.name = f.key;
    if (f.choices) {
      for (const [value, text] of f.choices) { input.add(new Option(text, value)); }
    } else {
      input.type = f.min !== undefined ? "number" : "text";
      for (const key of ["min", "max", "step", "placeholder", "value", "maxLength"]) {
        if (f[key] !== undefined) { input[key] = f[key]; }
      }
    }
    inputs[f.key] = input;
    label.append(input);
    q(".sh-tool-fields").append(label);
  }
  q(".sh-tool-fields").addEventListener("input", () => { invalidate(); refresh(); });
  function drawList() {
    list.replaceChildren();
    entries.forEach((entry, index) => {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = entry.file.name;
      label.title = entry.file.name;
      const details = document.createElement("small");
      details.textContent = entry.error || (entry.info ? `${entry.info.count}ページ · ${formatBytes(entry.file.size)}` : "読み込み中…");
      label.append(details);
      row.append(label);
      const move = direction => {
        const next = index + direction;
        [entries[index], entries[next]] = [entries[next], entries[index]];
        invalidate();
        drawList();
        list.children[next]?.querySelector(`[data-move="${direction}"]:not(:disabled),button:not(:disabled)`)?.focus();
      };
      if (picker.multiple) {
        for (const dir of [-1, 1]) {
          const button = controlButton(dir < 0 ? "↑" : "↓", () => move(dir), `${entry.file.name}を${dir < 0 ? "前" : "後"}へ`);
          button.dataset.move = dir;
          button.disabled = index + dir < 0 || index + dir >= entries.length;
          row.append(button);
        }
      }
      row.append(controlButton("外す", () => { entries.splice(index, 1); invalidate(); drawList(); choose.focus(); }, `${entry.file.name}を外す`));
      list.append(row);
    });
    refresh();
  }
  async function addFiles(files) {
    if (busy || !files.length) { return; }
    if (!picker.multiple && files.length !== 1) { status.textContent = "PDFを1つだけ選んでください"; return; }
    invalidate();
    if (!picker.multiple) { entries.length = 0; }
    const added = Array.from(files, file => ({ file }));
    entries.push(...added);
    drawList();
    for (const entry of added) {
      if (!dialog.open || !entries.includes(entry)) { continue; }
      try { entry.info = await describeToolFile(entry.file); }
      catch (e) { entry.error = friendlyError(e); }
      if (!dialog.open || !entries.includes(entry)) { continue; }
      if (entry.info && id === "metadata") {
        for (const key of ["title", "author", "subject"]) { inputs[key].value = entry.info[key]; }
      }
      if (entry.info && id === "reorder") { inputs.pages.value = entry.info.count === 1 ? "1" : `1-${entry.info.count}`; }
      drawList();
    }
  }
  choose.onclick = () => picker.click();
  picker.onchange = () => { addFiles(Array.from(picker.files)); picker.value = ""; };
  for (const name of ["dragover", "drop"]) {
    dialog.addEventListener(name, event => {
      event.preventDefault();
      event.stopPropagation();
      if (name === "drop") { addFiles(event.dataTransfer.files); }
    });
  }
  run.onclick = async () => {
    if (busy || run.disabled) { return; }
    busy = true;
    const job = new AbortController();
    currentJob = job;
    refresh();
    try {
      if (prepared) {
        saving = true;
        refresh();
        const result = await saveBlobAs(prepared.blob, prepared.fileName);
        if (!result.ok && !result.canceled) { throw new Error(result.error || "保存できませんでした"); }
        status.textContent = result.ok ? "保存しました" : "保存をキャンセルしました";
      } else {
        status.textContent = "ファイルを準備しています…";
        const options = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value]));
        const result = await preparePdfTool(id, entries.map(item => item.file), options, message => {
          if (!job.signal.aborted) { status.textContent = message; }
        }, job.signal);
        if (job.signal.aborted || !dialog.open) { return; }
        prepared = result;
        status.textContent = result.message || `${result.fileName}（${formatBytes(result.blob.size)}）`;
        run.textContent = "保存先を選ぶ…";
      }
    } catch (e) {
      if (!job.signal.aborted) { status.textContent = friendlyError(e); }
    } finally {
      currentJob = null;
      busy = saving = false;
      if (dialog.open) { refresh(); }
    }
  };
  document.body.append(dialog);
  refresh();
  dialog.showModal();
  choose.focus();
}
