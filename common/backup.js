/**
 * 設定とページ役割の書き出し・読み込み(JSON)。
 *
 * 書き出すもの: 詳細設定のすべての項目、PDF ごとのページ役割。
 * 書き出さないもの: 収集したページと元の PDF(大きくなるため)、速度ログ。
 *
 * ファイルの形(formatVersion 1):
 * {
 *   "format": "seihon-viewer-backup", "formatVersion": 1,
 *   "appVersion": "0.0.4", "exportedAt": "2026-10-07T09:30:00.000Z",
 *   "settings": { ...詳細設定... },            // 含めなかった場合は無い
 *   "roles": [ { "pdfKey": "sha256:…:12345", "name": "本.pdf", "pages": 12,
 *                "roles": { "0": "cover", "11": "back" } } ]   // 0始まりのページ番号 → 役割
 * }
 */

import { listRoles, putRoles } from "./db.js";
import { DEFAULT_SETTINGS, SETTING_LABELS, loadSettings, normalizeSettings, saveSettings } from "./settings.js";

export const BACKUP_FORMAT = "seihon-viewer-backup";
export const BACKUP_VERSION = 1;
/** 読み込むファイルの大きさの上限(役割が数万件あっても数 MB に収まる) */
export const BACKUP_MAX_BYTES = 20 * 1024 * 1024;

const ROLE_IDS = new Set(["cover", "back", "obi", "obiFront", "obiBack"]);
const PDF_KEY = /^sha256:[0-9a-f]{64}:\d+$/;

/**
 * 書き出す内容を作る。
 * @param {{settings?:boolean, roles?:boolean}} [what]
 */
export async function createBackup({ settings = true, roles = true } = {}) {
  const out = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    appVersion: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
  };
  if (settings) {
    out.settings = await loadSettings();
  }
  if (roles) {
    out.roles = (await listRoles())
      .map(r => ({
        pdfKey: r.pdfKey,
        name: r.name || "",
        pages: r.pages || null,
        roles: r.roles || {},
        updatedAt: r.updatedAt || null,
      }))
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja"));
  }
  return out;
}

/**
 * 読み込む内容を確かめる(まだ反映しない)。
 * @param {string} text JSON の文字列
 * @returns {{ok:boolean, error?:string, settings?:object|null, settingKeys?:string[], invalidSettings?:string[],
 *            roles?:Array, skippedRoles?:number, exportedAt?:string|null, appVersion?:string|null}}
 */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ""));
  } catch {
    return { ok: false, error: "JSON として読み取れませんでした。製本ビューアで書き出したファイルを選んでください。" };
  }
  if (!data || typeof data !== "object" || data.format !== BACKUP_FORMAT) {
    return { ok: false, error: "製本ビューアの設定ファイルではありません。製本ビューアの詳細設定で書き出したファイルを選んでください。" };
  }
  if (typeof data.formatVersion !== "number" || data.formatVersion > BACKUP_VERSION) {
    return { ok: false, error: "新しい版の製本ビューアで書き出されたファイルのため、読み込めません。製本ビューアを更新してから読み込んでください。" };
  }
  const result = {
    ok: true,
    settings: null,
    settingKeys: [],
    invalidSettings: [],
    roles: [],
    skippedRoles: 0,
    exportedAt: typeof data.exportedAt === "string" ? data.exportedAt : null,
    appVersion: typeof data.appVersion === "string" ? data.appVersion : null,
  };
  if (data.settings && typeof data.settings === "object" && !Array.isArray(data.settings)) {
    // ファイルにある項目だけを読み込む(古い版のファイルに無い項目は、今の設定のまま)
    result.settingKeys = Object.keys(DEFAULT_SETTINGS).filter(k => k in data.settings);
    result.settings = normalizeSettings(data.settings);
    // 範囲外・形式違いで使えなかった値(初期値になる)
    result.invalidSettings = result.settingKeys.filter(k => !sameValue(result.settings[k], normalizeInput(k, data.settings[k])));
  }
  for (const r of Array.isArray(data.roles) ? data.roles : []) {
    if (!r || typeof r.pdfKey !== "string" || !PDF_KEY.test(r.pdfKey) || !r.roles || typeof r.roles !== "object") {
      result.skippedRoles++;
      continue;
    }
    const roles = {};
    for (const [index, role] of Object.entries(r.roles)) {
      const i = Number(index);
      if (Number.isInteger(i) && i >= 0 && i < 100000 && ROLE_IDS.has(role)) {
        roles[String(i)] = role;
      }
    }
    if (!Object.keys(roles).length) {
      result.skippedRoles++;
      continue;
    }
    result.roles.push({
      pdfKey: r.pdfKey,
      name: typeof r.name === "string" ? r.name.slice(0, 300) : "",
      pages: Number.isInteger(r.pages) && r.pages > 0 ? r.pages : null,
      roles,
    });
  }
  if (!result.settings && !result.roles.length) {
    return {
      ok: false,
      error: result.skippedRoles
        ? "読み込める設定もページ役割もありませんでした(ファイルの中身が壊れている可能性があります)。"
        : "このファイルには、設定もページ役割も入っていません。",
    };
  }
  return result;
}

/** 比べるときの形にそろえる(サイト一覧は正規化したものどうしで比べる) */
function normalizeInput(key, value) {
  if (Array.isArray(DEFAULT_SETTINGS[key])) {
    return normalizeSettings({ [key]: value })[key];
  }
  return value;
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 読み込むと今の状態から何が変わるか(確認の画面に出す)。
 * @returns {Promise<{changedSettings:string[], changedLabels:string[], newRoles:number, replacedRoles:number}>}
 */
export async function describeBackup(parsed) {
  const current = await loadSettings();
  const changedSettings = (parsed.settingKeys || []).filter(k => !sameValue(parsed.settings[k], current[k]));
  const existing = new Set((await listRoles()).map(r => r.pdfKey));
  const replacedRoles = parsed.roles.filter(r => existing.has(r.pdfKey)).length;
  return {
    changedSettings,
    changedLabels: changedSettings.map(k => SETTING_LABELS[k] || k),
    newRoles: parsed.roles.length - replacedRoles,
    replacedRoles,
  };
}

/**
 * 読み込んだ内容を反映する。
 * 設定はファイルにある項目だけを置き換え、ページ役割は同じ PDF のものだけを置き換える(ほかの PDF の役割は残す)。
 * @returns {Promise<{settings:number, roles:number, replacedRoles:number}>} settings は変わった設定の数
 */
export async function applyBackup(parsed, { settings = true, roles = true } = {}) {
  let changed = 0;
  let replaced = 0;
  if (settings && parsed.settings && parsed.settingKeys.length) {
    const current = await loadSettings();
    const patch = {};
    for (const k of parsed.settingKeys) {
      patch[k] = parsed.settings[k];
      if (!sameValue(parsed.settings[k], current[k])) {
        changed++;
      }
    }
    await saveSettings(patch);
  }
  if (roles && parsed.roles.length) {
    const existing = new Set((await listRoles()).map(r => r.pdfKey));
    for (const r of parsed.roles) {
      if (existing.has(r.pdfKey)) {
        replaced++;
      }
      await putRoles(r);
    }
  }
  return { settings: changed, roles: roles ? parsed.roles.length : 0, replacedRoles: replaced };
}
