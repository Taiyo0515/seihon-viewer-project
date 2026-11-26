import { createIcon } from "../icons.js";

const icons = {
  merge: "layers", split: "scan-split", extract: "file-pdf", reorder: "list-alt", delete: "delete",
  rotate: "rotate-cw", compress: "speed", watermark: "text-fields", number: "list-alt", metadata: "info",
  region: "present", collection: "collect", ocr: "text-cursor", compare: "view-spread",
  redact: "ink-highlighter", sign: "gesture", "crop-margins": "present", "insert-blank": "add",
};

export class ToolHome {
  constructor({ onError, openCollection, openViewerTool }) {
    this.onError = onError;
    this.tools = [
      { id: "region", title: "ページの一部分を選択", description: "囲んだ範囲を収集、PNG保存、画像コピー", category: "収集", run: () => openViewerTool("region") },
      { id: "collection", title: "収集したページを編集", description: "集めたページを見ながら切り取り・回転・並べ替え", category: "収集", run: openCollection },
      { id: "annotate", title: "PDFに書き込む", description: "文字を入力し、ペンや蛍光ペンで注釈を追加", category: "編集", run: () => openViewerTool("annotate") },
      { id: "forms", title: "フォームに記入", description: "入力欄やチェック欄を埋めてPDFを保存", category: "編集", run: () => openViewerTool("forms") },
    ];
  }

  initialize() {
    this.ready ||= this.load().then(() => this.catalog(document.getElementById("shHomeCatalog")));
    return this.ready;
  }

  async load() {
    const groups = await Promise.allSettled([
      import("./pdf-tools.js").then(m => [m.PDF_TOOLS, m.runPdfTool]),
      import("./conversion-tools.js").then(m => [m.CONVERSION_TOOLS, m.runConversionTool]),
      import("./review-tools.js").then(m => [m.REVIEW_TOOLS, m.runReviewTool]),
      import("./form-designer.js").then(m => [m.FORM_TOOLS, m.runFormTool]),
      import("./document-tools.js").then(m => [m.DOCUMENT_TOOLS, m.runDocumentTool]),
      import("./archive-tool.js").then(m => [m.ARCHIVE_TOOLS, m.runArchiveTool]),
      import("./extract-assets.js").then(m => [m.ASSET_TOOLS, m.runAssetTool]),
      import("./local-language.js").then(async m => [await m.availableLanguageTools(), m.runLanguageTool]),
    ]);
    for (const group of groups) {
      if (group.status === "rejected") { this.onError("一部のツールを読み込めませんでした（" + group.reason.message + "）"); continue; }
      const [items, run] = group.value;
      this.tools.push(...items.map(item => ({ ...item, run: () => run(item.id) })));
    }
    const first = ["merge", "split", "compress", "region", "collection", "pdf-docx", "pdf-xlsx", "pdf-pptx", "ocr"];
    const rank = id => first.includes(id) ? first.indexOf(id) : first.length;
    this.tools.sort((a, b) => rank(a.id) - rank(b.id));
  }

  catalog(host, dialog = null) {
    host.innerHTML = `<div class="sh-tools-head"><h2>PDFツール</h2>
      <input type="search" aria-label="ツールを検索" placeholder="ツールを検索"></div>
      <div class="sh-tools-filters" aria-label="用途で絞り込み"></div>
      <div class="sh-tools-grid"></div><p class="sh-tools-none" role="status" hidden>該当するツールがありません</p>`;
    // Keep the file action and its existing listener when the catalog is laid out.
    if (!dialog) {
      const opener = host.parentElement.querySelector(".sh-home-open");
      if (opener) host.prepend(opener);
    }
    const input = host.querySelector("input");
    const filters = host.querySelector(".sh-tools-filters");
    const grid = host.querySelector(".sh-tools-grid");
    const none = host.querySelector(".sh-tools-none");
    const groups = [...new Set(this.tools.map(t => t.category))];
    let selected = "すべて";
    const normalize = s => s.normalize("NFKC").toLowerCase();
    const draw = () => {
      const words = normalize(input.value.trim()).split(/\s+/);
      let matches = 0;
      for (const card of grid.children) {
        card.hidden = !(selected === "すべて" || selected === card.dataset.group) || !words.every(w => card.dataset.search.includes(w));
        if (!card.hidden) { matches++; }
      }
      for (const filter of filters.children) { filter.setAttribute("aria-pressed", String(filter.textContent === selected)); }
      none.hidden = matches > 0;
    };
    for (const name of ["すべて", ...groups]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = name;
      btn.onclick = () => { selected = name; draw(); };
      filters.append(btn);
    }
    for (const tool of this.tools) {
      const card = document.createElement("button");
      card.type = "button";
      card.dataset.tool = tool.id;
      card.dataset.group = tool.category;
      const direction = tool.title.replace(/\s*→\s*/g, "から");
      card.dataset.search = normalize([tool.title, direction, tool.description, tool.category, tool.id].join(" "));
      card.style.setProperty("--tool-hue", String([164, 218, 275, 32, 196, 347, 140][groups.indexOf(tool.category) % 7]));
      const icon = document.createElement("span");
      icon.className = "sh-tool-icon";
      icon.append(createIcon(icons[tool.id] || (/画像|PNG|JPG|JPEG/i.test(tool.title) ? "image" : "file-pdf")));
      const body = document.createElement("span"), title = document.createElement("strong"), description = document.createElement("small");
      title.textContent = tool.title;
      description.textContent = tool.description;
      body.append(title, description);
      card.append(icon, body);
      card.onclick = async () => {
        dialog?.close();
        try { await tool.run(); } catch (e) { this.onError(e.message || String(e)); }
      };
      grid.append(card);
    }
    input.oninput = draw;
    draw();
  }

  async open() {
    await this.initialize();
    if (document.getElementById("shToolCatalogDialog")) { return; }
    const d = document.createElement("dialog");
    d.id = "shToolCatalogDialog";
    d.className = "sh-tools-dialog";
    d.setAttribute("aria-label", "PDFツール一覧");
    const close = document.createElement("button");
    close.type = "button"; close.className = "sh-btn"; close.textContent = "閉じる"; close.onclick = () => d.close();
    const host = document.createElement("section");
    this.catalog(host, d);
    host.querySelector(".sh-tools-head").append(close);
    d.append(host);
    d.addEventListener("close", () => d.remove(), { once: true });
    document.body.append(d);
    d.showModal();
  }
}
