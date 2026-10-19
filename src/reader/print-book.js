/**
 * 0.4: 電子書籍を「PDF に保存」する(Chrome の印刷画面を使う)。
 *
 * 本の各章を 1 つの文書に並べ、紙の大きさ・文字の大きさ・余白を指定して、見えない枠(iframe)で印刷画面を開く。
 * 送信先で「PDF に保存」を選ぶと、文字を検索・選択できる PDF になる(画像にはしない)。
 *  - 縦書きの本は縦書きのまま(ページは右から左へ進む)
 *  - 固定レイアウトの本は、1 ページずつ紙の大きさに縮めて並べる
 * 本の中のスクリプトは使わない(読み込むときに取り除いてある。拡張機能のページの決まり(CSP)でも止まる)。
 */

const PAPER = Object.freeze({ A6: [105, 148], B6: [128, 182], A5: [148, 210], B5: [182, 257], A4: [210, 297] });
const PX_PER_MM = 96 / 25.4;

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** 章の文書を読む(foliate-js が画像などを blob: の URL に置き換えたもの) */
async function loadSectionDocument(section) {
  const url = await section.load();
  const res = await fetch(url);
  const type = (res.headers.get("content-type") || "").toLowerCase();
  const text = await res.text();
  const parser = new DOMParser();
  let doc = parser.parseFromString(text, /xhtml|xml|svg/.test(type) || !type ? "application/xhtml+xml" : "text/html");
  if (doc.getElementsByTagName("parsererror").length) {
    doc = parser.parseFromString(text, "text/html");
  }
  return doc;
}

/** 固定レイアウトの章の大きさ(meta viewport か、SVG の viewBox) */
function fixedSize(doc) {
  const meta = doc.querySelector('meta[name="viewport"]')?.getAttribute("content") || "";
  const w = /width\s*=\s*(\d+(?:\.\d+)?)/.exec(meta);
  const h = /height\s*=\s*(\d+(?:\.\d+)?)/.exec(meta);
  if (w && h) {
    return { width: Number(w[1]), height: Number(h[1]) };
  }
  const vb = doc.querySelector("svg")?.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (vb?.length === 4 && vb[2] > 0 && vb[3] > 0) {
    return { width: vb[2], height: vb[3] };
  }
  return { width: 1000, height: 1414 };
}

function removeUnsafe(root) {
  for (const el of root.querySelectorAll("script, iframe, object, embed")) {
    el.remove();
  }
  for (const el of root.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

/**
 * 印刷する文書(HTML)を作る。
 * @returns {Promise<{html:string, pages:number}>}
 */
export async function buildPrintHtml(book, { paper = "A5", fontPt = 10, marginMm = 14, breaks = true, title = "", fixed = false, vertical = false, onStatus = null }) {
  const [W, H] = PAPER[paper] || PAPER.A5;
  const sections = book.sections.filter(s => typeof s.load === "function" && s.linear !== "no");
  const styles = [];
  const seenCss = new Set();
  const parts = [];
  let lang = "";
  let i = 0;
  for (const section of sections) {
    i++;
    onStatus?.(`本を紙に並べています(${i} / ${sections.length})…`);
    let doc;
    try {
      doc = await loadSectionDocument(section);
    } catch (e) {
      console.warn("[製本ビューア] 章を読めませんでした", e);
      continue;
    }
    lang ||= doc.documentElement.getAttribute("lang") || doc.documentElement.getAttribute("xml:lang") || "";
    for (const link of doc.querySelectorAll('link[rel~="stylesheet"]')) {
      const href = link.getAttribute("href");
      if (href && !seenCss.has(href)) {
        seenCss.add(href);
        try {
          styles.push(await (await fetch(href)).text());
        } catch {}
      }
    }
    for (const style of doc.querySelectorAll("style")) {
      const css = style.textContent || "";
      if (!seenCss.has(css)) {
        seenCss.add(css);
        styles.push(css);
      }
    }
    const body = doc.body || doc.documentElement;
    removeUnsafe(body);
    const cls = esc([doc.documentElement.getAttribute("class"), body.getAttribute("class")].filter(Boolean).join(" "));
    const secLang = esc(doc.documentElement.getAttribute("lang") || doc.documentElement.getAttribute("xml:lang") || "");
    if (fixed) {
      const { width, height } = fixedSize(doc);
      const pw = W * PX_PER_MM;
      const ph = H * PX_PER_MM;
      const scale = Math.min(pw / width, ph / height);
      const left = (pw - width * scale) / 2;
      const top = (ph - height * scale) / 2;
      parts.push(
        `<div class="sv-fxl"><div class="sv-fxl-in ${cls}" lang="${secLang}" style="width:${width}px;height:${height}px;left:${left}px;top:${top}px;transform:scale(${scale})">${body.innerHTML}</div></div>`
      );
    } else {
      parts.push(`<section class="sv-sec ${cls}" lang="${secLang}">${body.innerHTML}</section>`);
    }
  }
  if (!parts.length) {
    throw new Error("印刷できる章がありませんでした");
  }
  const innerW = W - marginMm * 2;
  const innerH = H - marginMm * 2;
  const printCss = fixed
    ? `@page { size: ${W}mm ${H}mm; margin: 0; }
       html, body { margin: 0; padding: 0; background: #fff; }
       .sv-fxl { position: relative; width: ${W}mm; height: ${H}mm; overflow: hidden; break-after: page; }
       .sv-fxl:last-child { break-after: auto; }
       .sv-fxl-in { position: absolute; transform-origin: 0 0; overflow: hidden; }`
    : `@page { size: ${W}mm ${H}mm; margin: ${marginMm}mm; }
       html { font-size: ${fontPt}pt !important; ${vertical ? "writing-mode: vertical-rl; -webkit-writing-mode: vertical-rl;" : ""} background: #fff !important; color: #000; }
       body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
       ${breaks ? ".sv-sec + .sv-sec { break-before: page; }" : ""}
       .sv-sec { ${vertical ? "writing-mode: vertical-rl;" : ""} }
       img, svg, video { max-width: ${innerW}mm !important; max-height: ${innerH}mm !important; break-inside: avoid; }
       img { height: auto; }
       pre { white-space: pre-wrap; }
       h1, h2, h3, h4 { break-after: avoid; }`;
  const html = `<!DOCTYPE html>
<html lang="${esc(lang || "ja")}">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
${styles.map(css => `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`).join("\n")}
<style>${printCss}</style>
</head>
<body>
${parts.join("\n")}
</body>
</html>`;
  return { html, pages: parts.length };
}

/** 印刷画面を開く */
export async function printBook(book, opts) {
  const { html } = await buildPrintHtml(book, opts);
  opts.onStatus?.("印刷の準備をしています(画像と文字を読み込んでいます)…");
  document.querySelector(".rd-print-frame")?.remove();
  const frame = document.createElement("iframe");
  frame.className = "rd-print-frame";
  frame.setAttribute("aria-hidden", "true");
  const loaded = new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
  frame.srcdoc = html;
  document.body.append(frame);
  await loaded;
  const doc = frame.contentDocument;
  const timeout = ms => new Promise(r => setTimeout(r, ms));
  await Promise.race([
    Promise.all([doc.fonts?.ready, ...[...doc.images].map(img => img.decode().catch(() => {}))]),
    timeout(15000),
  ]);
  opts.beforePrint?.();
  // 「PDF に保存」のファイル名の候補は、画面の題名になる
  const before = document.title;
  document.title = opts.title || before;
  try {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  } finally {
    setTimeout(() => {
      document.title = before;
    }, 1000);
  }
  return frame;
}

export { PAPER };
