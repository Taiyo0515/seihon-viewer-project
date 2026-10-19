/**
 * ダウンロードされたファイルの先頭(1KB)を読み、PDF かどうかを確かめる。
 * Service Worker からはパソコン内のファイル(file://)を読めないため、この補助ページで読む。
 * 「ファイルの URL へのアクセスを許可する」がオンのときだけ読める。読んだ内容はどこにも送らない。
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "offscreen" || message.type !== "sniff-file") {
    return undefined;
  }
  const xhr = new XMLHttpRequest();
  xhr.open("GET", message.url);
  xhr.responseType = "arraybuffer";
  // 先頭だけ読む(対応していない場合はファイル全体が返る)
  xhr.setRequestHeader("Range", "bytes=0-1023");
  xhr.onload = () => {
    const bytes = new Uint8Array(xhr.response || new ArrayBuffer(0)).subarray(0, 1024);
    let head = "";
    for (const b of bytes) {
      head += String.fromCharCode(b);
    }
    // PDF の先頭には「%PDF-」がある(前に少し余計なデータが付いている PDF もある)
    sendResponse({ ok: true, isPdf: head.includes("%PDF-") });
  };
  xhr.onerror = () => sendResponse({ ok: false, isPdf: false });
  xhr.send();
  return true;
});
