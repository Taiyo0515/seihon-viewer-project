/**
 * IndexedDB(拡張機能の中だけに保存されるデータベース)の読み書き。
 *
 * 保存するもの
 *  - pdfs:       収集したページの元PDF(同じPDFは1つだけ。内容の指紋が主キー)
 *  - collection: 収集したページ(どのPDFの何ページ目か、並び順、サムネイル)
 *  - roles:      ページ役割(フェーズ3で使用。PDFの指紋ごと)
 *
 * ビューア・詳細設定画面・Service Worker のどこからでも同じデータを読み書きできる
 * (すべて拡張機能の同じオリジン)。変更は BroadcastChannel で他の画面に知らせる。
 * 外部には一切送信しない。
 */

const DB_NAME = "seihon";
const DB_VERSION = 1;
const CHANNEL_NAME = "seihon-data";

let dbPromise = null;

const STORES = ["pdfs", "collection", "roles"];

function createStores(db) {
  if (!db.objectStoreNames.contains("pdfs")) {
    db.createObjectStore("pdfs", { keyPath: "key" });
  }
  if (!db.objectStoreNames.contains("collection")) {
    const store = db.createObjectStore("collection", { keyPath: "id", autoIncrement: true });
    store.createIndex("byPdf", "pdfKey", { unique: false });
  }
  if (!db.objectStoreNames.contains("roles")) {
    db.createObjectStore("roles", { keyPath: "pdfKey" });
  }
}

function openWithVersion(version) {
  return new Promise((resolve, reject) => {
    const req = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => createStores(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn("[製本ビューア] データベースの更新待ち(他のタブを閉じてください)");
  });
}

/** データベースを開く(初回は表を作る。表が欠けていたら作り直す) */
export function openDb() {
  dbPromise ||= (async () => {
    let db = await openWithVersion(null).catch(() => openWithVersion(DB_VERSION));
    if (db.version < DB_VERSION || STORES.some(n => !db.objectStoreNames.contains(n))) {
      const next = Math.max(DB_VERSION, db.version + 1);
      db.close();
      db = await openWithVersion(next);
    }
    // 別の画面が新しい版で開き直そうとしたら、こちらは閉じて譲る
    db.onversionchange = () => {
      db.close();
      dbPromise = null;
    };
    return db;
  })().catch(e => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new DOMException("中断されました", "AbortError"));
  });
}

async function withStores(names, mode, fn) {
  const db = await openDb();
  const tx = db.transaction(names, mode);
  const stores = names.map(n => tx.objectStore(n));
  const result = await fn(...stores);
  await txDone(tx);
  return result;
}

// ---------------------------------------------------------------------------
// 変更の通知
// ---------------------------------------------------------------------------

let channel = null;
function getChannel() {
  channel ||= new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

/** 他の画面(と自分)に変更を知らせる */
export function notifyChange(kind) {
  const message = { kind, time: Date.now() };
  getChannel().postMessage(message);
  // BroadcastChannel は自分自身には届かないので、同じ画面の購読者にも直接知らせる
  for (const fn of localListeners) {
    try {
      fn(message);
    } catch (e) {
      console.error(e);
    }
  }
}

const localListeners = new Set();

/** 変更を購読する。callback({kind}) / 戻り値は購読解除の関数 */
export function onDataChanged(callback) {
  const ch = getChannel();
  const listener = e => callback(e.data || {});
  ch.addEventListener("message", listener);
  localListeners.add(callback);
  return () => {
    ch.removeEventListener("message", listener);
    localListeners.delete(callback);
  };
}

// ---------------------------------------------------------------------------
// PDF の保存(収集の元データ)
// ---------------------------------------------------------------------------

/** 保存済みの PDF の情報(データ本体は含めない) */
export async function getPdfInfo(key) {
  const rec = await withStores(["pdfs"], "readonly", s => promisify(s.get(key)));
  if (!rec) {
    return null;
  }
  const { data, ...info } = rec;
  return info;
}

/** 保存済みの PDF のデータ(Uint8Array)。無ければ null */
export async function getPdfBytes(key) {
  const rec = await withStores(["pdfs"], "readonly", s => promisify(s.get(key)));
  if (!rec?.data) {
    return null;
  }
  return new Uint8Array(await rec.data.arrayBuffer());
}

/** PDF を保存する(同じ指紋のものがあれば名前などを更新するだけ) */
export async function putPdf({ key, name, url, size, pages, bytes, decrypted = false }) {
  await withStores(["pdfs"], "readwrite", async s => {
    const old = await promisify(s.get(key));
    if (old) {
      old.name = name || old.name;
      old.url = url || old.url;
      old.usedAt = Date.now();
      s.put(old);
      return;
    }
    s.put({
      key,
      name: name || "",
      url: url || "",
      size,
      pages,
      decrypted,
      data: new Blob([bytes], { type: "application/pdf" }),
      addedAt: Date.now(),
      usedAt: Date.now(),
    });
  });
}

export async function hasPdf(key) {
  const count = await withStores(["pdfs"], "readonly", s => promisify(s.count(key)));
  return count > 0;
}

/** 保存している PDF の一覧(データ本体は含めない) */
export async function listPdfInfos() {
  const out = [];
  await withStores(["pdfs"], "readonly", s => {
    return new Promise((resolve, reject) => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        const { data, ...info } = cursor.value;
        out.push(info);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  });
  return out;
}

/** 保存容量(バイト)。PDF 本体とサムネイルの合計の目安 */
export async function storageUsage() {
  const pdfs = await listPdfInfos();
  const items = await getCollection();
  const pdfBytes = pdfs.reduce((sum, p) => sum + (p.size || 0), 0);
  const thumbBytes = items.reduce((sum, i) => sum + (i.thumb?.size || 0), 0);
  return { pdfBytes, thumbBytes, total: pdfBytes + thumbBytes, pdfCount: pdfs.length };
}

/** どの収集にも使われていない PDF を消す */
export async function removeUnusedPdfs() {
  await withStores(["pdfs", "collection"], "readwrite", async (pdfs, collection) => {
    const used = new Set((await promisify(collection.getAll())).map(i => i.pdfKey));
    const keys = await promisify(pdfs.getAllKeys());
    for (const key of keys) {
      if (!used.has(key)) {
        pdfs.delete(key);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 収集
// ---------------------------------------------------------------------------

/** 収集したページの一覧(並び順) */
export async function getCollection() {
  const items = await withStores(["collection"], "readonly", s => promisify(s.getAll()));
  items.sort((a, b) => a.order - b.order || a.id - b.id);
  return items;
}

export async function collectionCount() {
  return withStores(["collection"], "readonly", s => promisify(s.count()));
}

/**
 * 収集の末尾にページを追加する。
 * @param {string} pdfKey 元PDFの指紋(先に putPdf で保存しておく)
 * @param {Array<{pageIndex:number, label?:string}>} pages 0始まりのページ番号
 * @returns {Promise<number[]>} 追加した項目のID
 */
export async function addCollectionItems(pdfKey, name, pages) {
  const ids = await withStores(["collection"], "readwrite", async s => {
    const all = await promisify(s.getAll());
    let order = all.reduce((max, i) => Math.max(max, i.order), 0);
    const added = [];
    for (const p of pages) {
      order += 1;
      const id = await promisify(
        s.add({ pdfKey, name, pageIndex: p.pageIndex, label: p.label || "", order, addedAt: Date.now(), thumb: null })
      );
      added.push(id);
    }
    return added;
  });
  notifyChange("collection");
  return ids;
}

/** 項目のサムネイルを保存する(変更通知はしない: 一覧の描き直しを避ける) */
export async function setCollectionThumb(id, thumb) {
  await withStores(["collection"], "readwrite", async s => {
    const item = await promisify(s.get(id));
    if (item) {
      item.thumb = thumb;
      s.put(item);
    }
  });
}

/** 項目を削除する */
export async function removeCollectionItems(ids) {
  await withStores(["collection"], "readwrite", s => {
    for (const id of ids) {
      s.delete(id);
    }
  });
  await removeUnusedPdfs();
  notifyChange("collection");
}

/** 収集を空にする */
export async function clearCollection() {
  await withStores(["collection"], "readwrite", s => s.clear());
  await removeUnusedPdfs();
  notifyChange("collection");
}

/** 並び順を、渡したIDの順にする */
export async function reorderCollection(idsInOrder) {
  await withStores(["collection"], "readwrite", async s => {
    const all = await promisify(s.getAll());
    const byId = new Map(all.map(i => [i.id, i]));
    let order = 0;
    for (const id of idsInOrder) {
      const item = byId.get(id);
      if (item) {
        item.order = ++order;
        s.put(item);
        byId.delete(id);
      }
    }
    // 渡されなかった項目は末尾に
    for (const item of [...byId.values()].sort((a, b) => a.order - b.order)) {
      item.order = ++order;
      s.put(item);
    }
  });
  notifyChange("collection");
}

// ---------------------------------------------------------------------------
// ページ役割(フェーズ3)
// ---------------------------------------------------------------------------

export async function getRoles(pdfKey) {
  return (await withStores(["roles"], "readonly", s => promisify(s.get(pdfKey)))) || null;
}

export async function putRoles(record) {
  await withStores(["roles"], "readwrite", s => s.put({ ...record, updatedAt: Date.now() }));
  notifyChange("roles");
}

export async function deleteRoles(pdfKey) {
  await withStores(["roles"], "readwrite", s => s.delete(pdfKey));
  notifyChange("roles");
}

export async function listRoles() {
  return withStores(["roles"], "readonly", s => promisify(s.getAll()));
}

/** すべての PDF のページ役割を消す */
export async function clearRoles() {
  await withStores(["roles"], "readwrite", s => s.clear());
  notifyChange("roles");
}
