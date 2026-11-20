const host = "com.seihon_viewer.tex";
const permission = { permissions: ["nativeMessaging"] };
const linkedKey = "texLiveLinked";
const setupHint = "Windowsで helper/tex-windows/install.bat を実行し、TeX Liveと接続してください。";
const sample = String.raw`\documentclass[uplatex]{jsarticle}
\begin{document}
日本語の組版テスト。\begin{equation}\int_0^1 x\,dx=\frac{1}{2}\end{equation}
\end{document}`;

export async function isTexLiveLinked() {
  const state = await chrome.storage.local.get([linkedKey, "clipboardHelperEnabled"]);
  const granted = await chrome.permissions.contains(permission);
  // Before TeX support this permission exclusively represented clipboard opt-in.
  // Record its old meaning before the user can request it for TeX.
  if (state.clipboardHelperEnabled === undefined) {
    await chrome.storage.local.set({ clipboardHelperEnabled: granted });
  }
  return !!state[linkedKey] && granted;
}

export async function connectTexLive() {
  if (!await chrome.permissions.request(permission)) throw new Error("TeX Liveとの通信が許可されませんでした。");
  await requestPdf(sample);
  await chrome.storage.local.set({ [linkedKey]: true });
}

export async function disconnectTexLive() {
  await chrome.storage.local.remove(linkedKey);
  if (!(await chrome.storage.local.get("clipboardHelperEnabled")).clipboardHelperEnabled) {
    await chrome.permissions.remove(permission);
  }
}

export async function compileTex(source) {
  if (!await isTexLiveLinked()) throw new Error(setupHint);
  return requestPdf(source);
}

function requestPdf(source) {
  if (typeof chrome.runtime.connectNative !== "function") {
    throw new Error("権限を許可した後、拡張機能の設定画面を開き直してTeX Liveと再接続してください。");
  }
  if (new TextEncoder().encode(source).length > 4 * 1024 * 1024) throw new Error("原稿の上限は4 MBです。");
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(host);
    const parts = [];
    let bytes = 0;
    const timeout = setTimeout(() => finish(new Error("組版がタイムアウトしました。")), 110000);
    function finish(error, result) {
      clearTimeout(timeout);
      port.disconnect();
      if (error) reject(error);
      else resolve(result);
    }
    port.onDisconnect.addListener(() => {
      clearTimeout(timeout);
      const message = chrome.runtime.lastError?.message;
      reject(new Error(message ? setupHint + " " + message : "連携アプリとの接続が終了しました。"));
    });
    port.onMessage.addListener(message => {
      try {
        if (message.type === "error") throw new Error(message.message);
        if (message.type === "chunk") {
          const data = Uint8Array.from(atob(message.data), c => c.charCodeAt(0));
          bytes += data.length;
          if (bytes > 64 * 1024 * 1024) throw new Error("PDFが64 MBを超えています。");
          parts.push(data);
        } else if (message.type === "done" && message.bytes === bytes && bytes > 0) {
          finish(null, new Blob(parts, { type: "application/pdf" }));
        } else {
          throw new Error("連携アプリからのPDFを受信できませんでした。");
        }
      } catch (error) { finish(error); }
    });
    port.postMessage({ type: "compile", source });
  });
}
