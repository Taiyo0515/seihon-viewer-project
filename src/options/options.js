/**
 * 詳細設定画面。変更はその場で chrome.storage.local に保存する。
 */

import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeSiteList,
  onSettingsChanged,
  resetSettings,
  saveSettings,
} from "../common/settings.js";
import { RESERVED_SHORTCUTS, shortcutFromEvent } from "../common/shortcut.js";
import {
  clearCollection,
  clearRoles,
  collectionCount,
  deleteRoles,
  listRoles,
  onDataChanged,
  storageUsage,
} from "../common/db.js";
import { BACKUP_MAX_BYTES, applyBackup, createBackup, describeBackup, parseBackup } from "../common/backup.js";
import { saveFile, timestampForFileName } from "../common/files.js";
import { ROLES, ROLE_LABEL, applyRoleItems } from "../viewer/roles.js";
import { buildRoleItemsEditor } from "../viewer/ui/role-items-editor.js";
import { applyThemePreference } from "../viewer/theme.js";
import { HELPER_PERMISSION, helperStatus } from "../viewer/file-clipboard.js";

const RADIO_SETTINGS = [
  "launchMode",
  "initialView",
  "bindingDirection",
  "theme",
  "printQuality",
  "guardOriginalFile",
  "aiCopySingle",
  "aiCopyMulti",
  "copyImagesAs",
  "imageQuality",
  "bindBlankPosition",
  "bindDuplex",
  "bindSizeRef",
  "bindObiOutput",
  "scanArrange",
  "comicDirection",
  "scanDirection",
  "scanFirstPage",
  "scanDeskew",
];
const CHECK_SETTINGS = ["openLocalFiles", "restorePosition", "guardEnabled", "perfLog", "collectClearAfterExport", "bindImpose", "scanTrim", "comicSplitSpreads", "openLocalEbooks", "bindPreviewSequence", "bindPreviewSheets", "scanDebugShow"];
const SELECT_SETTINGS = [
  "bindPaper",
  "bindUseObiFront",
  "bindUseObiBack",
  "bindUseObi",
  "bindUseFlapFront",
  "bindUseFlapBack",
  "bindUseBookmark",
];
const TEXT_SETTINGS = ["bindNameSuffix", "bindObiSuffix"];
const NUMBER_SETTINGS = { imageDpi: [100, 1200], collectLimitMB: [50, 20000] };

const $ = id => document.getElementById(id);
let toastTimer = 0;

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 1800);
}

/** 画面に設定値を反映する */
function render(settings) {
  currentSettings = settings;
  for (const name of RADIO_SETTINGS) {
    for (const input of document.querySelectorAll(`input[name="${name}"]`)) {
      input.checked = input.value === settings[name];
    }
  }
  for (const id of CHECK_SETTINGS) {
    $(id).checked = !!settings[id];
  }
  for (const id of Object.keys(NUMBER_SETTINGS)) {
    if (document.activeElement !== $(id)) {
      $(id).value = String(settings[id]);
    }
  }
  if (!capturing) {
    $("aiCopyShortcutView").textContent = settings.aiCopyShortcut;
  }
  for (const id of SELECT_SETTINGS) {
    $(id).value = settings[id];
  }
  for (const id of TEXT_SETTINGS) {
    if (document.activeElement !== $(id)) {
      $(id).value = settings[id];
    }
  }
  $("bindNameSuffixEcho").textContent = `→ 元の名前${settings.bindNameSuffix}.pdf(面付けすると 元の名前${settings.bindNameSuffix}_面付け.pdf)`;
  $("bindObiSuffixEcho").textContent = `→ 元の名前${settings.bindObiSuffix}.pdf`;
  if (document.activeElement !== $("rotateStep")) {
    $("rotateStep").value = String(settings.rotateStep);
  }
  // 0.5: カバー・表紙・帯などの項目(ほかの画面で変えたときも作り直す)
  applyRoleItems(settings.bindRoleItems);
  const items = JSON.stringify(settings.bindRoleItems);
  if (roleItemsEditor && items !== lastRoleItems) {
    roleItemsEditor.reload();
  }
  lastRoleItems = items;
  for (const input of document.querySelectorAll('input[name="guardOriginalFile"]')) {
    input.disabled = !settings.guardEnabled;
  }
  for (const id of ["autoExcludeSites", "guardExcludeSites"]) {
    if (document.activeElement !== $(id)) {
      $(id).value = settings[id].join("\n");
    }
  }
  $("guardExcludeSites").disabled = !settings.guardEnabled;
  // 「指定する」dpi の目安(A4 の長辺 297mm = 11.69in)
  const dpiEcho = $("imageDpiEcho");
  if (dpiEcho) {
    dpiEcho.textContent = String(Math.round(((Number(settings.imageDpi) || 300) * 11.69) / 10) * 10);
  }
  // dpi の指定は「指定する」のときだけ
  const custom = settings.imageQuality === "custom";
  $("imageCustomOptions").classList.toggle("disabled", !custom);
  for (const input of $("imageCustomOptions").querySelectorAll("input")) {
    input.disabled = !custom;
  }
  applyThemePreference(settings.theme);
}

async function save(patch, message = "保存しました") {
  await saveSettings(patch);
  toast(message);
}

let capturing = false;
let roleItemsEditor = null;
let lastRoleItems = "";
let currentSettings = null;

function bind() {
  for (const name of RADIO_SETTINGS) {
    for (const input of document.querySelectorAll(`input[name="${name}"]`)) {
      input.addEventListener("change", () => {
        if (input.checked) {
          save({ [name]: input.value });
        }
      });
    }
  }
  for (const id of CHECK_SETTINGS) {
    $(id).addEventListener("change", () => save({ [id]: $(id).checked }));
  }
  for (const [id, [min, max]] of Object.entries(NUMBER_SETTINGS)) {
    $(id).addEventListener("change", async () => {
      const value = Number($(id).value);
      if (!Number.isFinite(value) || value < min || value > max) {
        toast(`${min}〜${max} の数値を入れてください`);
        $(id).value = String((await loadSettings())[id]);
        return;
      }
      await save({ [id]: value });
      if (id === "collectLimitMB") {
        renderCollectUsage();
      }
    });
  }
  bindShortcut();
  $("rotateStep").addEventListener("change", () => save({ rotateStep: Number($("rotateStep").value) }));
  roleItemsEditor = buildRoleItemsEditor($("roleItemsEditor"), {
    getItems: () => currentSettings?.bindRoleItems || DEFAULT_SETTINGS.bindRoleItems,
    save: items => save({ bindRoleItems: items }),
    idPrefix: "optRi",
    notify: toast,
  });
  lastRoleItems = JSON.stringify(currentSettings?.bindRoleItems);
  for (const id of SELECT_SETTINGS) {
    $(id).addEventListener("change", () => save({ [id]: $(id).value }));
  }
  for (const id of TEXT_SETTINGS) {
    $(id).addEventListener("change", async () => {
      const value = $(id).value.trim();
      if (/[\\/:*?"<>|]/.test(value)) {
        toast("ファイル名に使えない文字(\\ / : * ? \" < > |)が入っています");
        $(id).value = (await loadSettings())[id];
        return;
      }
      await save({ [id]: value || DEFAULT_SETTINGS[id] });
    });
  }
  $("collectClear").addEventListener("click", async () => {
    const count = await collectionCount();
    if (!count) {
      toast("収集は空です");
      return;
    }
    if (!confirm(`収集した ${count} ページをすべて消しますか?(元に戻せません)`)) {
      return;
    }
    await clearCollection();
    toast("収集を空にしました");
    renderCollectUsage();
  });
  for (const id of ["autoExcludeSites", "guardExcludeSites"]) {
    const el = $(id);
    el.addEventListener("change", async () => {
      const list = normalizeSiteList(el.value);
      el.value = list.join("\n");
      await save({ [id]: list }, list.length ? `保存しました(${list.length}件)` : "保存しました");
    });
  }
  $("resetAll").addEventListener("click", async () => {
    if (!confirm("すべての設定を初期値に戻しますか?")) {
      return;
    }
    await resetSettings();
    render({ ...DEFAULT_SETTINGS });
    toast("初期値に戻しました");
  });
  $("rolesClearAll").addEventListener("click", async () => {
    const list = await listRoles();
    if (!list.length) {
      toast("保存しているページ役割はありません");
      return;
    }
    if (!confirm(`${list.length} 件の PDF のページ役割をすべて消しますか?(元に戻せません)`)) {
      return;
    }
    await clearRoles();
    toast("ページ役割をすべて消しました");
  });
  bindBackup();
  bindHelper();
  $("perfCopy").addEventListener("click", copyPerfLogs);
  $("perfClear").addEventListener("click", async () => {
    await chrome.storage.local.remove("perfLogs");
    renderPerfLogs([]);
    toast("記録を消しました");
  });
}

// ---- ショートカットの登録 ----------------------------------------------------
function bindShortcut() {
  const view = $("aiCopyShortcutView");
  const status = $("aiCopyShortcutStatus");
  const change = $("aiCopyShortcutChange");
  const stop = async () => {
    capturing = false;
    view.classList.remove("capturing");
    change.textContent = "変更…";
    window.removeEventListener("keydown", onKey, true);
    view.textContent = (await loadSettings()).aiCopyShortcut;
  };
  const onKey = async e => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      status.hidden = true;
      await stop();
      return;
    }
    const spec = shortcutFromEvent(e);
    if (!spec) {
      status.hidden = false;
      status.className = "status warn";
      status.textContent = "Ctrl または Alt を含む組み合わせ(例: Ctrl+Shift+C)、または F キーを押してください。Esc でやめます。";
      return;
    }
    if (RESERVED_SHORTCUTS.has(spec)) {
      status.hidden = false;
      status.className = "status warn";
      status.textContent = `${spec} は Chrome またはビューアが使っているため登録できません。別の組み合わせを押してください。`;
      return;
    }
    await save({ aiCopyShortcut: spec }, `ショートカットを ${spec} にしました`);
    status.hidden = true;
    await stop();
  };
  change.addEventListener("click", () => {
    if (capturing) {
      stop();
      return;
    }
    capturing = true;
    view.classList.add("capturing");
    view.textContent = "キーを押してください…";
    change.textContent = "やめる";
    status.hidden = true;
    window.addEventListener("keydown", onKey, true);
  });
  $("aiCopyShortcutReset").addEventListener("click", async () => {
    await save({ aiCopyShortcut: DEFAULT_SETTINGS.aiCopyShortcut }, `ショートカットを ${DEFAULT_SETTINGS.aiCopyShortcut} に戻しました`);
  });
}

// ---- 補助プログラム(ファイルをクリップボードに入れる) -------------------------
const OS_NAME = { windows: "Windows", mac: "Mac", linux: "Linux" };

async function renderHelper() {
  const el = $("helperStatus");
  const status = await helperStatus();
  $("helperEnable").hidden = status.reason !== "permission";
  $("helperDisable").hidden = status.reason === "permission";
  $("helperCheck").hidden = status.reason === "permission";
  if (status.available) {
    el.className = "status ok";
    el.textContent = `✓ 使えます(${OS_NAME[status.os] || status.os || "補助プログラム"}${status.version ? `、版 ${status.version}` : ""})。「PDF としてコピー」などで、ファイルそのものがクリップボードに入ります。`;
  } else if (status.reason === "permission") {
    el.className = "status";
    el.textContent = "使っていません(保存したファイルの場所をクリップボードに入れます)。";
  } else if (status.reason === "reload") {
    el.className = "status warn";
    el.textContent = "許可しました。このページと、開いているビューアのタブを開き直すと使えるようになります。";
  } else if (status.reason === "not-installed") {
    el.className = "status warn";
    el.textContent = "権限は許可されていますが、補助プログラムが見つかりません。下の手順 2 で入れてから「もう一度確かめる」を押してください。";
  } else {
    el.className = "status warn";
    el.textContent = `補助プログラムを使えませんでした: ${status.error || "不明なエラー"}`;
  }
}

function bindHelper() {
  $("helperEnable").addEventListener("click", async () => {
    let granted = false;
    try {
      granted = await chrome.permissions.request(HELPER_PERMISSION);
    } catch (e) {
      toast(`権限を求められませんでした: ${e?.message || e}`);
    }
    if (granted) {
      toast("許可しました");
    }
    renderHelper();
  });
  $("helperCheck").addEventListener("click", async () => {
    $("helperStatus").textContent = "確認中…";
    await renderHelper();
  });
  $("helperDisable").addEventListener("click", async () => {
    try {
      await chrome.permissions.remove(HELPER_PERMISSION);
      toast("補助プログラムを使うのをやめました");
    } catch (e) {
      toast(`やめられませんでした: ${e?.message || e}`);
    }
    renderHelper();
  });
  chrome.permissions.onAdded?.addListener(() => renderHelper());
  chrome.permissions.onRemoved?.addListener(() => renderHelper());
}

// ---- 保存しているページ役割 ---------------------------------------------------
function roleSummary(roles) {
  const counts = new Map();
  for (const role of Object.values(roles || {})) {
    counts.set(role, (counts.get(role) || 0) + 1);
  }
  return ROLES.filter(r => counts.get(r.id))
    .map(r => `${r.label} ${counts.get(r.id)}`)
    .join("、");
}

async function renderRoles() {
  const summary = $("rolesSummary");
  const wrap = $("rolesTableWrap");
  const body = $("rolesBody");
  let list = [];
  try {
    list = await listRoles();
  } catch {
    summary.className = "status warn";
    summary.textContent = "確認できませんでした";
    return;
  }
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  $("backupRolesCount").textContent = String(list.length);
  $("rolesClearAll").disabled = !list.length;
  summary.className = "status";
  summary.textContent = list.length ? `${list.length} 件の PDF にページ役割を保存しています。` : "保存しているページ役割はありません。";
  wrap.hidden = !list.length;
  body.textContent = "";
  for (const rec of list) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.className = "name";
    name.textContent = rec.name || "(名前なし)";
    name.title = rec.name || "";
    const pages = document.createElement("td");
    pages.className = "num";
    pages.textContent = rec.pages ? String(rec.pages) : "-";
    const roles = document.createElement("td");
    roles.className = "roles";
    roles.textContent = roleSummary(rec.roles);
    roles.title = Object.entries(rec.roles || {})
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([i, r]) => `${Number(i) + 1}ページ目: ${ROLE_LABEL[r] || r}`)
      .join("\n");
    const when = document.createElement("td");
    when.textContent = rec.updatedAt ? new Date(rec.updatedAt).toLocaleString("ja-JP") : "-";
    const act = document.createElement("td");
    act.className = "act";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn small danger";
    del.textContent = "消す";
    del.setAttribute("aria-label", `「${rec.name || "名前なし"}」のページ役割を消す`);
    del.addEventListener("click", async () => {
      if (!confirm(`「${rec.name || "名前なし"}」のページ役割を消しますか?`)) {
        return;
      }
      await deleteRoles(rec.pdfKey);
      toast("ページ役割を消しました");
    });
    act.append(del);
    tr.append(name, pages, roles, when, act);
    body.append(tr);
  }
}

// ---- 設定の書き出し・読み込み --------------------------------------------------
let pendingBackup = null;

function showBackupStatus(message, kind = "") {
  const el = $("backupStatus");
  el.hidden = !message;
  el.className = `status${kind ? ` ${kind}` : ""}`;
  el.textContent = message || "";
}

function hideBackupPreview() {
  $("backupPreview").hidden = true;
  pendingBackup = null;
}

function bindBackup() {
  $("backupExport").addEventListener("click", async () => {
    const settings = $("backupIncludeSettings").checked;
    const roles = $("backupIncludeRoles").checked;
    if (!settings && !roles) {
      showBackupStatus("書き出すもの(詳細設定・ページ役割)を選んでください。", "warn");
      return;
    }
    try {
      const data = await createBackup({ settings, roles });
      const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
      const name = `製本ビューアの設定_${timestampForFileName()}.json`;
      const res = await saveFile(blob, name);
      if (res.canceled) {
        showBackupStatus("書き出しをやめました。", "warn");
        return;
      }
      if (!res.ok) {
        throw new Error(res.error || "保存できませんでした");
      }
      const parts = [settings ? "詳細設定" : null, roles ? `ページ役割 ${data.roles.length} 件` : null].filter(Boolean);
      const where = res.picked ? "選んだ場所に保存しました" : "Chrome のダウンロード先のフォルダに保存されます";
      showBackupStatus(`書き出しました: ${res.fileName || name}(${parts.join("、")})。${where}。`, "ok");
    } catch (e) {
      showBackupStatus(`書き出せませんでした: ${e?.message || e}`, "error");
    }
  });

  const input = $("backupImportFile");
  $("backupImportPick").addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) {
      return;
    }
    hideBackupPreview();
    if (file.size > BACKUP_MAX_BYTES) {
      showBackupStatus("ファイルが大きすぎます。製本ビューアで書き出した設定のファイルを選んでください。", "error");
      return;
    }
    let parsed;
    try {
      parsed = parseBackup(await file.text());
    } catch (e) {
      parsed = { ok: false, error: `読み込めませんでした: ${e?.message || e}` };
    }
    if (!parsed.ok) {
      showBackupStatus(parsed.error, "error");
      return;
    }
    showBackupStatus("");
    await showBackupPreview(file.name, parsed);
  });
  $("backupImportCancel").addEventListener("click", () => {
    hideBackupPreview();
    showBackupStatus("読み込みをやめました。");
  });
  $("backupImportApply").addEventListener("click", async () => {
    const parsed = pendingBackup;
    if (!parsed) {
      return;
    }
    const settings = $("importSettings").checked;
    const roles = $("importRoles").checked;
    if (!settings && !roles) {
      showBackupStatus("読み込むもの(詳細設定・ページ役割)を選んでください。", "warn");
      return;
    }
    try {
      const result = await applyBackup(parsed, { settings, roles });
      hideBackupPreview();
      const parts = [];
      if (settings && parsed.settings) {
        parts.push(result.settings ? `詳細設定 ${result.settings} 項目を変更` : "詳細設定は今と同じでした");
      }
      if (roles && parsed.roles.length) {
        parts.push(`ページ役割 ${result.roles} 件(うち置き換え ${result.replacedRoles} 件)`);
      }
      showBackupStatus(`読み込みました: ${parts.join("、")}。`, "ok");
      toast("読み込みました");
    } catch (e) {
      showBackupStatus(`読み込めませんでした: ${e?.message || e}`, "error");
    }
  });
}

async function showBackupPreview(fileName, parsed) {
  const desc = await describeBackup(parsed);
  pendingBackup = parsed;
  $("backupPreviewTitle").textContent = `「${fileName}」の内容`;
  const list = $("backupPreviewList");
  list.textContent = "";
  const add = text => {
    const li = document.createElement("li");
    li.textContent = text;
    list.append(li);
  };
  if (parsed.exportedAt) {
    const when = new Date(parsed.exportedAt);
    add(`書き出した日時: ${Number.isNaN(when.getTime()) ? parsed.exportedAt : when.toLocaleString("ja-JP")}${parsed.appVersion ? `(製本ビューア ${parsed.appVersion})` : ""}`);
  }
  if (parsed.settings) {
    const names = desc.changedLabels;
    add(
      names.length
        ? `詳細設定: ${parsed.settingKeys.length} 項目。今と違うのは ${names.length} 項目(${names.slice(0, 8).join("、")}${names.length > 8 ? " ほか" : ""})`
        : `詳細設定: ${parsed.settingKeys.length} 項目(今の設定と同じです)`
    );
    if (parsed.invalidSettings.length) {
      add(`使えない値だった ${parsed.invalidSettings.length} 項目は、初期値にします。`);
    }
  } else {
    add("詳細設定: 含まれていません");
  }
  if (parsed.roles.length) {
    add(`ページ役割: ${parsed.roles.length} 件の PDF(新しく加わる ${desc.newRoles} 件、置き換わる ${desc.replacedRoles} 件)`);
  } else {
    add("ページ役割: 含まれていません");
  }
  if (parsed.skippedRoles) {
    add(`読み取れなかったページ役割 ${parsed.skippedRoles} 件は読み込みません。`);
  }
  const settingsBox = $("importSettings");
  settingsBox.disabled = !parsed.settings;
  settingsBox.checked = !!parsed.settings;
  const rolesBox = $("importRoles");
  rolesBox.disabled = !parsed.roles.length;
  rolesBox.checked = !!parsed.roles.length;
  $("backupPreview").hidden = false;
  $("backupImportApply").focus();
}

// ---- 収集の保存容量 ----------------------------------------------------------
async function renderCollectUsage() {
  const el = $("collectUsage");
  try {
    const [usage, count, settings] = await Promise.all([storageUsage(), collectionCount(), loadSettings()]);
    const limit = settings.collectLimitMB * 1024 * 1024;
    el.className = usage.total > limit ? "status warn" : "status";
    el.textContent = `現在: ${count} ページ(元の PDF ${usage.pdfCount} 件)、${formatBytes(usage.total)} / 上限 ${formatBytes(limit)}`;
  } catch {
    el.textContent = "確認できませんでした";
  }
}

// ---- 速度ログの一覧 ----------------------------------------------------------
function formatBytes(bytes) {
  if (!bytes) {
    return bytes === 0 ? "0 KB" : "-";
  }
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function renderPerfLogs(logs) {
  const body = $("perfLogBody");
  body.textContent = "";
  if (!logs.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "empty";
    td.textContent = "まだ記録はありません";
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const log of logs) {
    const tr = document.createElement("tr");
    const name = (() => {
      try {
        return decodeURIComponent((log.label || "").split(/[/?#]/).filter(Boolean).pop() || log.label || "");
      } catch {
        return log.label || "";
      }
    })();
    const cells = [
      new Date(log.date).toLocaleString("ja-JP"),
      name,
      log.pages ?? "-",
      formatBytes(log.bytes),
      log.firstPageMs != null ? `${log.firstPageMs} ms` : "-",
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = String(text);
      if (i === 1) {
        td.title = log.label || "";
        td.className = "name";
      }
      if (i >= 2) {
        td.className = "num";
      }
      tr.append(td);
    });
    tr.title = (log.marks || []).map(([n, t]) => `${n}: ${t} ms`).join("\n");
    body.append(tr);
  }
}

async function copyPerfLogs() {
  const { perfLogs = [] } = await chrome.storage.local.get("perfLogs");
  const lines = ["日時\tPDF\tページ数\tバイト数\t最初のページまで(ms)\t内訳"];
  for (const l of perfLogs) {
    lines.push(
      [l.date, l.label, l.pages, l.bytes, l.firstPageMs, (l.marks || []).map(([n, t]) => `${n}=${t}`).join(" / ")].join("\t")
    );
  }
  await navigator.clipboard.writeText(lines.join("\n"));
  toast("記録をコピーしました(表計算ソフトに貼り付けられます)");
}

// ---- 状態表示 ---------------------------------------------------------------
async function renderStatus() {
  const fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
  const el = $("fileAccessStatus");
  el.textContent = "";
  if (fileAccess) {
    el.className = "status ok";
    el.textContent = "✓ 「ファイルの URL へのアクセス」は許可されています。";
  } else {
    el.className = "status warn";
    el.append("「ファイルの URL へのアクセス」が許可されていません。パソコン内のPDFを開くには許可が必要です。 ");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn small";
    b.textContent = "拡張機能の設定を開く";
    b.addEventListener("click", () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));
    el.append(b);
  }
  $("aboutVersion").textContent = chrome.runtime.getManifest().version;
  try {
    const status = await chrome.runtime.sendMessage({ type: "get-status" });
    $("aboutStatus").textContent = status?.headerConditionSupported
      ? `正常(通信の書き換えルール ${status.ruleCount} 件が有効)`
      : "このChromeは古いため自動切り替えが使えません(Chrome 128 以降が必要です)";
  } catch {
    $("aboutStatus").textContent = "確認できませんでした";
  }
}

// ---- スキャンの整え(0.3): PDF ごとに覚えている整え方 ------------------------------
const SCAN_CHOICES_KEY = "scanChoices";

async function renderScanChoices() {
  let count = 0;
  try {
    const items = await chrome.storage.local.get(SCAN_CHOICES_KEY);
    count = Object.keys(items[SCAN_CHOICES_KEY] || {}).length;
  } catch {}
  $("scanChoicesStatus").textContent = count ? `${count} 件の PDF の整え方を覚えています。` : "覚えている整え方はありません。";
  $("clearScanChoices").disabled = !count;
}

function bindScanChoices() {
  $("clearScanChoices").addEventListener("click", async () => {
    if (!confirm("PDF ごとに覚えている整え方を消しますか?(次に開いたときは、上の設定のとおりに表示します)")) {
      return;
    }
    await chrome.storage.local.remove(SCAN_CHOICES_KEY);
    toast("覚えている整え方を消しました");
  });
}

// ---- 起動 -------------------------------------------------------------------
const settings = await loadSettings();
render(settings);
bind();
renderStatus();
renderCollectUsage();
renderRoles();
renderHelper();
renderScanChoices();
bindScanChoices();
onDataChanged(({ kind }) => {
  if (kind === "collection") {
    renderCollectUsage();
  } else if (kind === "roles") {
    renderRoles();
  }
});
const { perfLogs = [] } = await chrome.storage.local.get("perfLogs");
renderPerfLogs(perfLogs);
onSettingsChanged(next => {
  render(next);
  renderStatus();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.perfLogs) {
    renderPerfLogs(changes.perfLogs.newValue || []);
  }
  if (area === "local" && changes[SCAN_CHOICES_KEY]) {
    renderScanChoices();
  }
});

// ---- 0.5: 4つの分類を入口にした画面の切り替え ---------------------------------
// アドレスの # で表示する分類を決める(# なし = 入口、#read など = 分類、#sec-copy など = その項目のある分類を開いて、その項目へ)
const CATEGORIES = ["read", "pages", "print", "manage"];

function route() {
  const hash = decodeURIComponent(location.hash.slice(1));
  let cat = CATEGORIES.includes(hash) ? hash : null;
  let target = null;
  if (!cat && hash) {
    target = document.getElementById(hash);
    cat = target?.closest(".cat")?.dataset.cat || null;
  }
  $("catHome").hidden = !!cat;
  for (const el of document.querySelectorAll(".cat")) {
    el.hidden = el.dataset.cat !== cat;
  }
  const title = cat ? document.querySelector(`#cat-${cat} h2`)?.textContent.replace(/^\d/, "") : "";
  document.title = cat ? `製本ビューア - 詳細設定 - ${title}` : "製本ビューア - 詳細設定";
  if (target) {
    target.scrollIntoView({ block: "start" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1500);
  } else {
    window.scrollTo(0, 0);
  }
}
window.addEventListener("hashchange", route);
route();
