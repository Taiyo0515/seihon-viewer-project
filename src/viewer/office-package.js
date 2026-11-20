/** Office Open XML の部品を、外部参照を読み込まずに扱う。 */
import { unzipSync } from "../lib/fflate/fflate.js";
import { createZip } from "../common/files.js";

export const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const X = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const PREFIX = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAX_BYTES = 384 * 1024 * 1024;

export function escapeXml(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]);
}

export const descendants = (node, name) => Array.from(node?.getElementsByTagNameNS("*", name) ?? []);
export const first = (node, name) => node?.getElementsByTagNameNS("*", name)[0];
export const attr = (node, name) => Array.from(node?.attributes || []).find(a => a.localName === name)?.value;
export const children = (node, name) => Array.from(node?.children || []).filter(el => el.localName === name);

function resolvePart(part, target) {
  if (!target || /^[a-z][\w+.-]*:/i.test(target) || target.startsWith("//")) { return ""; }
  const path = target.startsWith("/") ? [] : part.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") {
      if (!path.length) { return ""; }
      path.pop();
    } else if (segment && segment !== ".") {
      path.push(segment);
    }
  }
  return path.join("/");
}

export async function readOfficePackage(blob) {
  if (blob.size > MAX_BYTES) { throw new Error("Office ファイルが大きすぎます（384 MB まで）。"); }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let files;
  let total = 0;
  try {
    files = unzipSync(bytes, { filter(entry) {
      if (!/^(?:word|xl|ppt|_rels)\//.test(entry.name) || entry.name.endsWith("/")) { return false; }
      total += entry.originalSize;
      if (total > MAX_BYTES) { throw new RangeError(); }
      return true;
    } });
  } catch (e) {
    if (e instanceof RangeError) { throw new Error("展開後の文書が大きすぎます（384 MB まで）。"); }
    throw new Error("Office ファイルを開けません。パスワードを解除した DOCX・XLSX・PPTX を選んでください。");
  }
  const xml = (name, required = true) => {
    if (!Object.hasOwn(files, name)) {
      if (!required) { return null; }
      throw new Error("文書の構成を読み取れませんでした。");
    }
    const data = files[name];
    const encoding = data[0] === 0xff && data[1] === 0xfe ? "utf-16le" : data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : "utf-8";
    const source = new TextDecoder(encoding).decode(data);
    if (/<!DOCTYPE/i.test(source)) { throw new Error("文書の XML 形式に対応していません。"); }
    const result = new DOMParser().parseFromString(source, "application/xml");
    if (first(result, "parsererror")) { throw new Error("文書内の XML を読み取れませんでした。"); }
    return result;
  };
  const rels = part => {
    const i = part.lastIndexOf("/") + 1;
    const doc = xml(part.slice(0, i) + "_rels/" + part.slice(i) + ".rels", false);
    const map = new Map();
    for (const rel of descendants(doc, "Relationship")) {
      if (attr(rel, "TargetMode") !== "External") {
        map.set(attr(rel, "Id"), resolvePart(part, attr(rel, "Target")));
      }
    }
    return map;
  };
  return { files, xml, rels };
}

export function relationships(entries) {
  return `<Relationships xmlns="${REL}">${entries.map(([id, type, target]) =>
    `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
}

export async function writeOfficePackage(kind, main, parts, overrides, extraDefaults = {}) {
  const contentTypes = { rels: "application/vnd.openxmlformats-package.relationships+xml", xml: "application/xml", ...extraDefaults };
  const declaration = Object.entries(contentTypes).map(([ext, mime]) => `<Default Extension="${ext}" ContentType="${mime}"/>`).join("");
  const types = Object.entries(overrides).map(([name, mime]) => `<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.${mime}+xml"/>`).join("");
  const all = {
    ...parts,
    "_rels/.rels": relationships([["rId1", "officeDocument", main]]),
    "[Content_Types].xml": `<Types xmlns="${CT}">${declaration}${types}</Types>`,
  };
  const entries = Object.entries(all).map(([name, value]) => ({
    name, blob: value instanceof Blob ? value : typeof value === "string" ? new Blob([PREFIX, value]) : new Blob([value]),
  }));
  return new Blob([await createZip(entries)], { type: "application/vnd.openxmlformats-officedocument." + kind });
}

export function columnName(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + (n - 1) % 26) + name;
  }
  return name;
}

