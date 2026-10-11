// 製本ビューア: ファイルをクリップボードに入れる補助プログラム(Mac。Chrome のネイティブ メッセージングで呼ばれる)
//
// 製本ビューアから PDF・画像のデータを受け取って「ダウンロード」フォルダの「製本ビューア_コピー」に保存し、
// Finder の「コピー」と同じように、ファイルとしてクリップボードに入れる。
// 保存は Chrome のダウンロードを通さないので、Chrome の「保存する前に保存場所を確認する」の設定でも聞かれない。
// ネットワークは使わない。同じ名前のファイルがあっても上書きしない(「名前 (1).pdf」のようにする)。
//
// 依頼(4バイトの長さ + UTF-8 の JSON):
//   {"type":"ping"}
//   {"type":"begin","root":"製本ビューア_コピー","folder":"","files":[{"name":"a.pdf","size":123}]}
//   {"type":"chunk","index":0,"data":"<base64>"}   … ファイルの中身(順番に)
//   {"type":"finish"}                               … 保存を終えて、クリップボードに入れる
//   {"type":"copy-files","paths":["/Users/…/a.pdf"]} … 保存済みのファイルをクリップボードに入れる
//   {"type":"reveal","path":"/Users/…/a.pdf"}       … Finder でファイルを見せる

ObjC.import("Foundation");
ObjC.import("AppKit");
ObjC.import("stdlib");

const VERSION = 2;
const fm = $.NSFileManager.defaultManager;

function readExact(count) {
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  const data = $.NSMutableData.alloc.init;
  while (data.length < count) {
    const chunk = input.readDataOfLength(count - data.length);
    if (!chunk || chunk.length === 0) {
      return null;
    }
    data.appendData(chunk);
  }
  return data;
}

function readMessage() {
  const header = readExact(4);
  if (!header) {
    return null;
  }
  const h = $.NSString.alloc.initWithDataEncoding(header, $.NSISOLatin1StringEncoding).js;
  const length = (h.charCodeAt(0) | (h.charCodeAt(1) << 8) | (h.charCodeAt(2) << 16) | (h.charCodeAt(3) << 24)) >>> 0;
  if (length <= 0 || length > 64 * 1024 * 1024) {
    throw new Error("bad-length");
  }
  const body = readExact(length);
  if (!body) {
    return null;
  }
  return JSON.parse($.NSString.alloc.initWithDataEncoding(body, $.NSUTF8StringEncoding).js);
}

function writeMessage(obj) {
  const json = JSON.stringify(obj);
  const utf8 = unescape(encodeURIComponent(json));
  const n = utf8.length;
  const header = String.fromCharCode(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
  const data = $(header + utf8).dataUsingEncoding($.NSISOLatin1StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}

function exists(path) {
  return fm.fileExistsAtPath(path);
}

function downloadsDir() {
  const urls = fm.URLsForDirectoryInDomains($.NSDownloadsDirectory, $.NSUserDomainMask);
  if (urls.count > 0) {
    const p = urls.objectAtIndex(0).path.js;
    if (exists(p)) {
      return p;
    }
  }
  return $.NSHomeDirectory().js;
}

/** ファイル名・フォルダ名に使えない文字を置き換える(フォルダの外を指せないようにする) */
function safeName(name) {
  let s = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().replace(/^\.+|\.+$/g, "");
  if (s.length > 150) {
    s = s.slice(0, 150);
  }
  return s || "file";
}

function uniquePath(dir, name) {
  let path = `${dir}/${name}`;
  if (!exists(path)) {
    return path;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n++) {
    path = `${dir}/${stem} (${n})${ext}`;
    if (!exists(path)) {
      return path;
    }
  }
}

function makeDir(path) {
  return fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, true, $(), $());
}

function copyFiles(paths) {
  const urls = $.NSMutableArray.alloc.init;
  const found = [];
  for (const p of paths) {
    if (typeof p === "string" && exists(p)) {
      urls.addObject($.NSURL.fileURLWithPath(p));
      found.push(p);
    }
  }
  if (!found.length) {
    return { ok: false, error: "not-found" };
  }
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  const ok = pb.writeObjects(urls);
  return ok ? { ok: true, count: found.length, paths: found } : { ok: false, error: "pasteboard", paths: found };
}

const session = { paths: [], sizes: [] };

function begin(message) {
  const files = Array.isArray(message.files) ? message.files : [];
  if (!files.length) {
    return { ok: false, error: "no-files" };
  }
  let dir = `${downloadsDir()}/${safeName(message.root || "SeihonViewer")}`;
  makeDir(dir);
  if (message.folder) {
    dir = uniquePath(dir, safeName(message.folder));
    makeDir(dir);
  }
  session.paths = [];
  session.sizes = [];
  for (const f of files) {
    const path = uniquePath(dir, safeName(f.name));
    fm.createFileAtPathContentsAttributes(path, $.NSData.data, $());
    session.paths.push(path);
    session.sizes.push(Number(f.size) || 0);
  }
  return { ok: true, paths: session.paths, dir };
}

function chunk(message) {
  const index = message.index;
  if (!Number.isInteger(index) || index < 0 || index >= session.paths.length) {
    return { ok: false, error: "bad-index" };
  }
  const data = $.NSData.alloc.initWithBase64EncodedStringOptions($(String(message.data || "")), 0);
  if (!data || data.isNil()) {
    return { ok: false, error: "bad-data" };
  }
  const fh = $.NSFileHandle.fileHandleForWritingAtPath(session.paths[index]);
  if (!fh || fh.isNil()) {
    return { ok: false, error: "open-failed" };
  }
  fh.seekToEndOfFile;
  fh.writeData(data);
  fh.closeFile;
  return { ok: true };
}

function finish() {
  for (let i = 0; i < session.paths.length; i++) {
    const attrs = fm.attributesOfItemAtPathError(session.paths[i], $());
    const size = attrs && !attrs.isNil() ? Number(attrs.fileSize) : -1;
    if (size !== session.sizes[i]) {
      return { ok: false, error: "size-mismatch" };
    }
  }
  return copyFiles(session.paths);
}

function reveal(path) {
  if (typeof path !== "string" || !exists(path)) {
    return { ok: false, error: "not-found" };
  }
  const urls = $.NSMutableArray.alloc.init;
  urls.addObject($.NSURL.fileURLWithPath(path));
  $.NSWorkspace.sharedWorkspace.activateFileViewerSelectingURLs(urls);
  return { ok: true };
}

function main() {
  for (;;) {
    const message = readMessage();
    if (!message) {
      return;
    }
    try {
      switch (message.type) {
        case "ping":
          writeMessage({ ok: true, version: VERSION, os: "mac", dir: downloadsDir() });
          break;
        case "begin":
          writeMessage(begin(message));
          break;
        case "chunk":
          writeMessage(chunk(message));
          break;
        case "finish":
          writeMessage(finish());
          break;
        case "copy-files":
          writeMessage(copyFiles(Array.isArray(message.paths) ? message.paths : []));
          break;
        case "reveal":
          writeMessage(reveal(message.path));
          break;
        default:
          writeMessage({ ok: false, error: "unknown-type" });
      }
    } catch (e) {
      writeMessage({ ok: false, error: String(e) });
    }
  }
}

function run() {
  try {
    main();
  } catch (e) {
    try {
      writeMessage({ ok: false, error: String(e) });
    } catch (e2) {}
  }
  // osascript が戻り値を書き出さないよう、ここで終える
  $.exit(0);
}
