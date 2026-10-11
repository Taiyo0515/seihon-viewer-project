// 製本ビューア: ファイルをクリップボードに入れる補助プログラム(Mac。Chrome のネイティブ メッセージングで呼ばれる)
//
// 製本ビューアがダウンロードフォルダに保存した PDF・画像の場所を受け取り、
// Finder の「コピー」と同じように、ファイルとしてクリップボードに入れる。
// Chrome から1回だけ依頼を受け取り、クリップボードに入れて終わる。ネットワークは使わない。
//
// 依頼(4バイトの長さ + UTF-8 の JSON): {"type":"ping"} / {"type":"copy-files","paths":["/Users/…/a.pdf"]}

ObjC.import("Foundation");
ObjC.import("AppKit");
ObjC.import("stdlib");

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

/** NSData → 0〜255 の文字の並び */
function dataToBinary(data) {
  return $.NSString.alloc.initWithDataEncoding(data, $.NSISOLatin1StringEncoding).js;
}

function writeMessage(obj) {
  const json = JSON.stringify(obj);
  const utf8 = unescape(encodeURIComponent(json));
  const n = utf8.length;
  const header = String.fromCharCode(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
  const data = $(header + utf8).dataUsingEncoding($.NSISOLatin1StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}

function copyFiles(paths) {
  const fm = $.NSFileManager.defaultManager;
  const urls = $.NSMutableArray.alloc.init;
  let count = 0;
  for (const p of paths) {
    if (typeof p === "string" && fm.fileExistsAtPath(p)) {
      urls.addObject($.NSURL.fileURLWithPath(p));
      count++;
    }
  }
  if (!count) {
    return { ok: false, error: "not-found" };
  }
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  const ok = pb.writeObjects(urls);
  return ok ? { ok: true, count } : { ok: false, error: "pasteboard" };
}

function main() {
  const header = readExact(4);
  if (!header) {
    return;
  }
  const h = dataToBinary(header);
  const length = h.charCodeAt(0) | (h.charCodeAt(1) << 8) | (h.charCodeAt(2) << 16) | (h.charCodeAt(3) << 24);
  if (length <= 0 || length > 1048576) {
    writeMessage({ ok: false, error: "bad-length" });
    return;
  }
  const body = readExact(length);
  if (!body) {
    return;
  }
  let message;
  try {
    message = JSON.parse($.NSString.alloc.initWithDataEncoding(body, $.NSUTF8StringEncoding).js);
  } catch (e) {
    writeMessage({ ok: false, error: "bad-json" });
    return;
  }
  if (message.type === "ping") {
    writeMessage({ ok: true, version: 1, os: "mac" });
  } else if (message.type === "copy-files") {
    writeMessage(copyFiles(Array.isArray(message.paths) ? message.paths : []));
  } else {
    writeMessage({ ok: false, error: "unknown-type" });
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
