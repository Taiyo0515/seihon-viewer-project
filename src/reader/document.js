import { getHandoff } from "../common/handoff.js";
import { documentFormat } from "../common/ebook-formats.js";
import { saveBlobAs } from "../common/files.js";
import { decodeDocument, encodeDocument, renderText, renderSvg, renderTable } from "./document-formats.mjs";
import { connectTexLive, isTexLiveLinked, compileTex, disconnectTexLive } from "../viewer/tex-live.js";
import { showCompiledPdf } from "./tex-preview.js";

const $ = id => document.getElementById(id);
const status = message => { $("status").textContent = message; };
let format, name, encoding, source, saved, editing = false, table, tex, trusted = false;
let revision = 0, running = false, queued = false, timer, lastPdf, pdfView, imageFolder;
let newline = "\n";
const narrow = matchMedia("(max-width:700px)");
function controls() {
  const split = editing && !table;
  $("workspace").classList.toggle("editing",split);
  $("source").hidden = $("divider").hidden = !split;
  $("switch").hidden = !split || !narrow.matches;
  $("switch").textContent = $("workspace").classList.contains("source-mode") ? "プレビューを表示" : "原文を表示";
  $("edit").textContent = editing ? "閲覧に戻る" : "編集";
  $("save").hidden = !editing;
  $("autoLabel").hidden = !split;
  $("refresh").hidden = !split && !tex;
  $("refresh").textContent = tex ? "コンパイラ" : "プレビュー更新";
}
function changed(value) {
  source = value;
  revision++;
  document.title = (source === saved ? "" : "＊") + name;
  if (tex) $("pdfSave").disabled = true;
  if (table) { status(source === saved ? "" : "未保存の変更あり"); return; }
  status("未反映の変更あり");
  clearTimeout(timer);
  if ($("auto").checked && (!tex || trusted)) timer = setTimeout(update, tex ? 900 : 320);
}
async function resolveImage(path) {
  if (!imageFolder || /^(?:[a-z]+:|[/\\])/i.test(path)) return null;
  const parts = decodeURIComponent(path).split("/").filter(piece => piece && piece !== ".");
  if (!parts.length || parts.includes("..")) return null;
  let dir = imageFolder;
  const file = parts.pop();
  for (const piece of parts) dir = await dir.getDirectoryHandle(piece);
  return (await dir.getFileHandle(file)).getFile();
}
async function update() {
  clearTimeout(timer);
  if (tex && !trusted) return;
  if (running) { queued = true; return; }
  running = true;
  const id = revision, value = source, host = $("preview");
  const stage = document.createElement("div");
  stage.className = "rendering";
  host.append(stage);
  let compiled, nextView;
  try {
    status(tex ? "組版中…" : "更新中…");
    if (tex) {
      compiled = await compileTex(value);
      nextView = await showCompiledPdf(stage, compiled, pdfView?.page());
    } else if (table) {
      renderTable(stage,value,{delimiter:format === "csv" ? "," : "\t",editable:editing,onChange:changed});
    } else if (format === "txt") renderText(stage,value,{aozora:$("ao").checked});
    else if (format === "svg") renderSvg(stage,value,{name});
    else {
      const {renderMarkup} = await import("./markup.mjs");
      await renderMarkup(stage,format,value,{resolveImage});
    }
    if (id !== revision) { nextView?.dispose(); return; }
    for (const child of [...host.children]) if (child !== stage) child.remove();
    stage.classList.remove("rendering");
    if (tex) {
      pdfView?.dispose();
      pdfView = nextView; lastPdf = compiled;
      $("pdfSave").hidden = false; $("pdfSave").disabled = false;
    }
    status("");
  } catch (error) {
    if (id === revision) status("更新できませんでした。 " + (error.message || error));
  } finally {
    if (stage.classList.contains("rendering")) stage.remove();
    running = false;
    if (queued) { queued = false; void update(); }
  }
}
async function save(blob, filename) {
  const result = await saveBlobAs(blob,filename);
  if (result.ok) status("保存しました");
  else if (!result.canceled) status(result.error || "保存できませんでした");
  return result.ok;
}
async function saveSource() {
  const snapshot = source;
  if (await save(new Blob([encodeDocument(snapshot,encoding)]),name)) {
    saved = snapshot; document.title = (source === saved ? "" : "＊") + name;
  }
}
const run = fn => async () => { try { await fn(); } catch (error) {status(error.message || String(error));} };
async function texControls() {
  const linked = await isTexLiveLinked();
  $("connect").hidden = $("setup").hidden = linked;
  $("unlink").hidden = !linked; $("edit").hidden = !linked;
  controls();
  $("refresh").hidden = !linked;
  if (!linked) status("TeX Liveと連携すると日本語の原稿を組版できます。");
  else if (!trusted) status("原稿の出所を確認して「コンパイラ」を押すと、この文書の組版を開始します。");
}
$("connect").onclick = run(async () => { await connectTexLive(); await texControls(); });
$("unlink").onclick = run(disconnectTexLive);
chrome.storage.onChanged.addListener((changes, area) => {
  if (!tex || area !== "local" || !changes.texLiveLinked) return;
  if (!changes.texLiveLinked.newValue) {
    trusted = false; editing = false; revision++; clearTimeout(timer);
    pdfView?.dispose(); pdfView = lastPdf = null;
    $("preview").replaceChildren(); $("pdfSave").hidden = true;
    // Keep the explicit save action available for edits made before disconnecting.
    void texControls().then(() => { $("save").hidden = source === saved; });
  } else void texControls();
});
$("edit").onclick = () => {
  editing = !editing;
  $("workspace").classList.toggle("source-mode",editing);
  controls();
  if (table) void update();
  if (editing && !table) $("source").focus();
};
$("source").oninput = event => changed(event.target.value.replaceAll("\n",newline));
$("refresh").onclick = () => {
  if (tex && !trusted && !window.confirm("このTeX原稿をPC上で組版します。作成者と内容を信頼できる原稿ですか？")) return;
  trusted = true;
  void update();
};
$("auto").onchange = run(async () => {
  clearTimeout(timer); queued = false;
  if ($("auto").checked && (!tex || trusted)) void update();
  await chrome.storage.local.set({["documentLive."+format]:$("auto").checked});
});
$("ao").onchange = update;
$("folder").onclick = run(async () => {
  try {imageFolder = await showDirectoryPicker({mode:"read"});}
  catch (error) {if (error.name === "AbortError") return; throw error;}
  revision++; await update();
});
$("switch").onclick = () => { $("workspace").classList.toggle("source-mode"); controls(); };
narrow.onchange = () => {if (format && (!tex || !$("edit").hidden)) controls();};
$("save").onclick = run(saveSource);
$("pdfSave").onclick = run(() => save(lastPdf,name.replace(/\.tex$/i,".pdf")));
const divider = $("divider");
let width = 45;
function resize(percent) {
  width = Math.max(20,Math.min(80,percent)); $("workspace").style.setProperty("--source-width",width+"%");
  divider.setAttribute("aria-valuenow",Math.round(width));
}
divider.onpointerdown = e => divider.setPointerCapture(e.pointerId);
divider.onpointermove = e => {if (divider.hasPointerCapture(e.pointerId)) resize(100*e.clientX/$("workspace").clientWidth);};
divider.onkeydown = e => { if (["ArrowLeft","ArrowRight"].includes(e.key)) {e.preventDefault();resize(width+(e.key==="ArrowLeft"?-3:3));} };
window.addEventListener("beforeunload",e => {if (source !== saved) {e.preventDefault(); e.returnValue = true;}});
document.addEventListener("keydown",e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==="s" && editing) {e.preventDefault();void run(saveSource)();}
});
async function init() {
  const item = await getHandoff(new URLSearchParams(location.search).get("h"));
  if (!item?.blob) throw new Error("ファイルをもう一度開いてください。");
  name = item.name; format = documentFormat(name);
  if (!format) throw new Error("この形式は表示できません。");
  encoding = decodeDocument(new Uint8Array(await item.blob.arrayBuffer()));
  source = saved = encoding.text;
  newline = /\r\n|\r|\n/.exec(source)?.[0] || "\n";
  $("name").textContent = document.title = name;
  $("source").value = source;
  table = ["csv","tsv"].includes(format); tex = format === "tex";
  $("auto").checked = (await chrome.storage.local.get("documentLive."+format))["documentLive."+format] ?? true;
  $("folder").hidden = !["md","markdown","adoc","asciidoc"].includes(format);
  $("aoLabel").hidden = format !== "txt";
  $("edit").hidden = false;
  controls();
  if (tex) await texControls();
  else await update();
}
void run(init)();
