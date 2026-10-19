/**
 * 0.4: 「ほかの形式に変換して保存」のダイアログ(PDF → 画像の ZIP・CBZ・EPUB・テキスト)。
 */

import { formatBytes, sanitizeFileName, saveBlobAs } from "../../common/files.js";
import { CONVERT_FORMATS, convertPdf } from "../ebook/pdf-convert.js";
import { viewPageCount } from "../page-map.js";
import { hydrateIcons } from "../icons.js";

const PREF_KEY = "seihon.convertPrefs";

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function savePrefs(p) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {}
}

export class PdfConvertDialog {
  constructor({ app, toast, docSource, getCurrent, getDirection, pageEditor }) {
    Object.assign(this, { app, toast, docSource, getCurrent, getDirection, pageEditor });
    this.dialog = null;
    this.running = false;
    this.canceled = false;
  }

  build() {
    const d = document.createElement("dialog");
    d.id = "shConvertDialog";
    d.className = "sh-dialog sh-bind-dialog sh-convert-dialog";
    d.setAttribute("aria-labelledby", "shConvertTitle");
    d.innerHTML = `
      <div class="sh-bind-head">
        <h2 id="shConvertTitle">ほかの形式に変換して保存</h2>
        <button class="sh-icon-btn" type="button" data-close title="閉じる" aria-label="閉じる" data-icon="close"></button>
      </div>
      <div class="sh-bind-main">
        <div class="sh-bind-scroll">
          <p class="sh-bind-summary" data-summary></p>
          <fieldset class="sh-scan-modes">
            <legend>変換する形式</legend>
            <label class="sh-scan-mode"><input type="radio" name="shConvFormat" value="images" />
              <span><b>画像(ZIP)</b><span class="sh-scan-note">ページごとに 1 枚の画像にして、ZIP にまとめます</span></span></label>
            <label class="sh-scan-mode"><input type="radio" name="shConvFormat" value="cbz" />
              <span><b>コミック(CBZ)</b><span class="sh-scan-note">コミックのリーダーで読める形式です。右綴じなら漫画の向き(右から左)になります</span></span></label>
            <label class="sh-scan-mode"><input type="radio" name="shConvFormat" value="epub" />
              <span><b>EPUB(固定レイアウト)</b><span class="sh-scan-note">電子書籍のリーダーで読める形式です。ページごとに 1 枚の画像で、PDF のしおりが目次になります</span></span></label>
            <label class="sh-scan-mode"><input type="radio" name="shConvFormat" value="text" />
              <span><b>テキスト(.txt)</b><span class="sh-scan-note">PDF の文字だけを取り出します(スキャンの PDF は、OCR の文字が入っているときだけ)</span></span></label>
          </fieldset>
          <div class="sh-bind-field" data-image-options>
            <div class="sh-bind-field-label">画像</div>
            <div class="sh-bind-field-control">
              <label><input type="checkbox" data-keep-original /> スキャンのページは、元の画像(JPEG)をそのまま使う(画質は元のまま)</label>
              <label>文字・図のページの解像度
                <select data-dpi>
                  <option value="150">150 dpi(小さい)</option>
                  <option value="200">200 dpi</option>
                  <option value="300">300 dpi(きれい)</option>
                  <option value="400">400 dpi</option>
                  <option value="600">600 dpi(とてもきれい・大きい)</option>
                </select></label>
              <label>描いたページの形式
                <select data-image-type>
                  <option value="png">PNG(劣化なし)</option>
                  <option value="jpeg">JPEG(小さい)</option>
                </select></label>
            </div>
          </div>
          <div class="sh-bind-field" data-direction-row>
            <div class="sh-bind-field-label">読む向き</div>
            <div class="sh-bind-field-control"><span data-direction></span></div>
          </div>
          <div class="sh-bind-field" data-text-options hidden>
            <div class="sh-bind-field-label">テキスト</div>
            <div class="sh-bind-field-control">
              <label><input type="checkbox" data-page-marks /> ページの区切りに「［12ページ］」のような見出しを入れる</label>
            </div>
          </div>
          <p class="sh-bind-help">MOBI・AZW3・KFX(Kindle の形式)には変換できません。Kindle で読むときは、EPUB を Amazon の「Send to Kindle」で送ると、Kindle で読める形に変換されます(固定レイアウトの EPUB は受け付けられないことがあります)。元の PDF のファイルは変えません。</p>
        </div>
        <div class="sh-bind-foot">
          <p class="sh-bind-progress" role="status" data-progress></p>
          <div class="sh-dialog-buttons">
            <button class="sh-btn" type="button" data-cancel>キャンセル</button>
            <button class="sh-btn sh-btn-primary" type="button" data-run>変換して保存…</button>
          </div>
        </div>
      </div>`;
    document.body.append(d);
    hydrateIcons(d);
    this.dialog = d;
    const q = s => d.querySelector(s);
    this.el = {
      summary: q("[data-summary]"),
      keep: q("[data-keep-original]"),
      dpi: q("[data-dpi]"),
      type: q("[data-image-type]"),
      marks: q("[data-page-marks]"),
      imageOptions: q("[data-image-options]"),
      textOptions: q("[data-text-options]"),
      directionRow: q("[data-direction-row]"),
      direction: q("[data-direction]"),
      progress: q("[data-progress]"),
      run: q("[data-run]"),
    };
    q("[data-close]").addEventListener("click", () => this.close());
    q("[data-cancel]").addEventListener("click", () => this.close());
    this.el.run.addEventListener("click", () => this.run());
    d.addEventListener("change", () => this.update());
    d.addEventListener("cancel", e => {
      if (this.running) {
        e.preventDefault();
        this.canceled = true;
      }
    });
  }

  get format() {
    return this.dialog.querySelector('input[name="shConvFormat"]:checked')?.value || "cbz";
  }

  open() {
    if (!this.app.pdfDocument) {
      return;
    }
    if (!this.dialog) {
      this.build();
    }
    const p = loadPrefs();
    const fmt = CONVERT_FORMATS[p.format] ? p.format : "cbz";
    this.dialog.querySelector(`input[name="shConvFormat"][value="${fmt}"]`).checked = true;
    this.el.keep.checked = p.keepOriginal !== false;
    this.el.dpi.value = String(p.dpi || 300);
    this.el.type.value = p.imageType === "jpeg" ? "jpeg" : "png";
    this.el.marks.checked = p.pageMarks !== false;
    this.el.progress.textContent = "";
    const count = viewPageCount(this.app.pdfDocument);
    const edited = this.pageEditor?.dirty ? "(削除したページは含めません)" : "";
    this.el.summary.textContent = `「${this.docSource.baseName()}」の ${count} ページを、いま表示している順に変換します${edited}。`;
    this.update();
    this.dialog.showModal();
  }

  update() {
    const fmt = this.format;
    this.el.imageOptions.hidden = fmt === "text";
    this.el.textOptions.hidden = fmt !== "text";
    this.el.directionRow.hidden = fmt !== "cbz" && fmt !== "epub";
    const rtl = this.getDirection() === "rtl";
    this.el.direction.textContent = rtl
      ? "右綴じ(右から左へ読む。漫画・縦書きの本)。変えるときは、閉じてツールバーの綴じ方向のボタンで切り替えてください"
      : "左綴じ(左から右へ読む)。変えるときは、閉じてツールバーの綴じ方向のボタンで切り替えてください";
  }

  close() {
    if (this.running) {
      this.canceled = true;
      this.el.progress.textContent = "やめています…";
      return;
    }
    this.dialog.close();
  }

  async run() {
    if (this.running) {
      return;
    }
    const doc = this.app.pdfDocument;
    const format = this.format;
    const prefs = {
      format,
      keepOriginal: this.el.keep.checked,
      dpi: Number(this.el.dpi.value) || 300,
      imageType: this.el.type.value,
      pageMarks: this.el.marks.checked,
    };
    savePrefs(prefs);
    this.running = true;
    this.canceled = false;
    this.el.run.disabled = true;
    const label = CONVERT_FORMATS[format].label;
    try {
      const result = await convertPdf(doc, format, {
        baseName: sanitizeFileName(this.docSource.baseName()),
        direction: this.getDirection(),
        dpi: prefs.dpi,
        imageType: prefs.imageType,
        keepOriginal: prefs.keepOriginal,
        rotation: this.app.pdfViewer?.pagesRotation || 0,
        pageMarks: prefs.pageMarks,
        isCanceled: () => this.canceled || doc !== this.app.pdfDocument,
        onProgress: (done, total) => {
          this.el.progress.textContent = `${label}に変換しています(${done} / ${total} ページ)…`;
        },
      });
      if (result.emptyText) {
        this.el.progress.textContent = "";
        this.toast.show("この PDF には文字が入っていないため、テキストにできませんでした(スキャンの PDF は、OCR をしてから変換してください)", { kind: "error", duration: 9000 });
        return;
      }
      this.el.progress.textContent = `保存先を選んでください(${formatBytes(result.blob.size)})…`;
      const res = await saveBlobAs(result.blob, result.fileName);
      if (res.ok) {
        const orig = result.originals ? `。${result.originals} ページは元の画像をそのまま使いました` : "";
        this.toast.show(`${label}に変換して保存しました: ${result.fileName}(${result.pages} ページ${orig})`, { duration: 7000 });
        this.running = false;
        this.dialog.close();
      } else if (!res.canceled) {
        this.toast.show(`保存できませんでした(${res.error || "不明なエラー"})`, { kind: "error" });
      }
      this.el.progress.textContent = "";
    } catch (e) {
      if (e?.canceled) {
        this.el.progress.textContent = "やめました";
      } else {
        console.error("[製本ビューア] 変換できませんでした", e);
        this.el.progress.textContent = "";
        this.toast.show(`変換できませんでした(${e?.message || e})`, { kind: "error", duration: 8000 });
      }
    } finally {
      this.running = false;
      this.el.run.disabled = false;
      if (this.canceled && this.dialog.open) {
        this.dialog.close();
      }
    }
  }
}
