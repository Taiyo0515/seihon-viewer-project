/**
 * 強制ダウンロード対策 第2層: PDFへのリンクに付いた download 属性を無効にする。
 *
 * - すべてのページで動くため、処理は「クリックされた瞬間に、そのリンクだけを見る」最小限にしている。
 * - PDFと判断できるリンク(パスやファイル名が .pdf、または type="application/pdf")に限る。
 * - download 属性を一時的に外し、ページを離れないよう新しいタブで開く。
 *   開いた先は通信の書き換え(第1層)で製本ビューアに切り替わる。
 * - Alt キーを押しながらのクリックは「保存したい」操作なので触らない。
 *   (第3層が、保存されたファイルを勝手にビューアで開かないよう、Service Worker に知らせる)
 * - blob: や data: のリンクは別タブで開けないため触らない(保存されたあと第3層が扱う)。
 */
(() => {
  if (window.__seihonLinkGuard) {
    return;
  }
  window.__seihonLinkGuard = true;

  const PDF_NAME = /\.pdf$/i;

  function isPdfLink(anchor) {
    const href = anchor.href;
    if (typeof href !== "string" || !/^https?:/i.test(href)) {
      return false;
    }
    const type = anchor.getAttribute("type");
    if (type && /^application\/(x-)?pdf\b/i.test(type.trim())) {
      return true;
    }
    const dl = anchor.getAttribute("download");
    if (dl && PDF_NAME.test(dl.trim())) {
      return true;
    }
    let url;
    try {
      url = new URL(href);
    } catch {
      return false;
    }
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {}
    if (PDF_NAME.test(path.replace(/;.*$/, ""))) {
      return true;
    }
    // ?file=report.pdf のように、クエリの値が .pdf で終わる
    for (const value of url.searchParams.values()) {
      if (PDF_NAME.test(value.trim())) {
        return true;
      }
    }
    return false;
  }

  function findAnchor(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    for (const node of path) {
      if (node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) {
        return node;
      }
    }
    return null;
  }

  function notifyUserDownload(event) {
    const anchor = findAnchor(event);
    if (!anchor || typeof anchor.href !== "string" || !/^https?:/i.test(anchor.href)) {
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "user-download", url: anchor.href }).catch(() => {});
    } catch {
      // 拡張機能が更新された直後など(このページを再読み込みすれば直る)
    }
  }

  function onActivate(event) {
    if (event.altKey && event.type === "click" && event.button === 0) {
      notifyUserDownload(event); // Alt+クリック = Chrome の「リンク先を保存」
      return;
    }
    if (event.defaultPrevented || event.altKey) {
      return;
    }
    if (event.type === "auxclick" && event.button !== 1) {
      return;
    }
    if (event.type === "click" && event.button !== 0) {
      return;
    }
    const anchor = findAnchor(event);
    if (!anchor || !anchor.hasAttribute("download") || !isPdfLink(anchor)) {
      return;
    }
    const savedDownload = anchor.getAttribute("download");
    const hadTarget = anchor.hasAttribute("target");
    const savedTarget = anchor.getAttribute("target");
    anchor.removeAttribute("download");
    if (!hadTarget && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.type === "click") {
      anchor.setAttribute("target", "_blank");
      if (!anchor.rel.includes("noopener")) {
        anchor.dataset.seihonRel = anchor.getAttribute("rel") ?? "";
        anchor.rel = `${anchor.rel} noopener`.trim();
      }
    }
    // クリックの既定動作(ページ遷移)が決まった後で、ページ側から見た属性を元に戻す
    setTimeout(() => {
      anchor.setAttribute("download", savedDownload);
      if (hadTarget) {
        anchor.setAttribute("target", savedTarget);
      } else {
        anchor.removeAttribute("target");
      }
      if ("seihonRel" in anchor.dataset) {
        if (anchor.dataset.seihonRel) {
          anchor.setAttribute("rel", anchor.dataset.seihonRel);
        } else {
          anchor.removeAttribute("rel");
        }
        delete anchor.dataset.seihonRel;
      }
    }, 0);
  }

  window.addEventListener("click", onActivate, true);
  window.addEventListener("auxclick", onActivate, true);
})();
