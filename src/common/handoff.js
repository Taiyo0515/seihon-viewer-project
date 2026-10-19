/**
 * 0.4: 画面どうしでファイルを受け渡すための一時置き場(この拡張機能の IndexedDB。外部には送らない)。
 *
 * 使う場面
 *  - ビューアで選んだ EPUB などを、電子書籍リーダーの画面に渡す(逆に、リーダーで選んだ PDF・コミックをビューアに渡す)
 *
 * 再読み込みしても同じファイルを開けるよう、読んでもすぐには消さない。
 * 置いてから 1 日たったものは、次に置くときにまとめて消す(合計で 1 GB を超えたときは古いものから消す)。
 */

const DB_NAME = "seihon-handoff";
const STORE = "files";
const KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_TOTAL = 1024 * 1024 * 1024;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then(r => {
      result = r;
    });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqP = req =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

function newId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * ファイルを置く。
 * @param {Blob} blob
 * @param {{name?:string, url?:string, format?:string, extra?:object}} info
 * @returns {Promise<string>} 受け渡し用の ID
 */
export async function putHandoff(blob, { name = "", url = "", format = "", extra = null } = {}) {
  const db = await openDb();
  await cleanup(db, blob.size).catch(() => {});
  const id = newId();
  await tx(db, "readwrite", store =>
    reqP(store.put({ id, blob, name, url, format, extra, size: blob.size, time: Date.now() }))
  );
  return id;
}

/** 置いたファイルを読む(無ければ null) */
export async function getHandoff(id) {
  if (!/^[0-9a-f]{24}$/.test(String(id || ""))) {
    return null;
  }
  const db = await openDb();
  return (await tx(db, "readonly", store => reqP(store.get(id)))) || null;
}

/** 古いものを消す */
async function cleanup(db, incoming = 0) {
  const all = await tx(db, "readonly", store => reqP(store.getAll()));
  const now = Date.now();
  const keep = all.filter(r => now - r.time < KEEP_MS).sort((a, b) => b.time - a.time);
  const drop = new Set(all.filter(r => !keep.includes(r)).map(r => r.id));
  let total = incoming;
  for (const r of keep) {
    total += r.size || 0;
    if (total > MAX_TOTAL) {
      drop.add(r.id);
    }
  }
  if (drop.size) {
    await tx(db, "readwrite", store => {
      for (const id of drop) {
        store.delete(id);
      }
    });
  }
}
