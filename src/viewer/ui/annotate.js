/**
 * 注釈ツール(ペン・蛍光ペン・テキスト・消しゴム)。
 *
 * 描画そのものは PDF.js の注釈エディタ(インク・ハイライト・フリーテキスト)を使う。
 * 消しゴムは PDF.js に無いため、この拡張で実装している
 * (なぞった注釈を1つずつ削除。削除は「元に戻す」で戻せる)。
 * 色と太さの選択肢は Chrome 標準ビューアの注釈機能に合わせ、
 * 設定パネルも Chrome と同じく、注釈モードの間だけ画面右側に表示する。
 */

import { createIcon, hydrateIcons } from "../icons.js";

const EditorType = { NONE: 0, FREETEXT: 3, HIGHLIGHT: 9, INK: 15 };
const Param = {
  FREETEXT_SIZE: 11,
  FREETEXT_COLOR: 12,
  INK_COLOR: 21,
  INK_THICKNESS: 22,
  INK_OPACITY: 23,
  HIGHLIGHT_COLOR: 31,
  HIGHLIGHT_THICKNESS: 32,
};

// Chrome 標準ビューア(注釈機能)と同じ色
const PEN_COLORS = [
  ["黒", "#000000"], ["濃いグレー", "#5f6368"], ["グレー", "#9aa0a6"], ["薄いグレー", "#dadce0"], ["白", "#ffffff"],
  ["薄い赤", "#f28b82"], ["薄い黄", "#fdd663"], ["薄い緑", "#81c995"], ["薄い青", "#8ab4f8"], ["薄い茶", "#eec9ae"],
  ["赤", "#ea4335"], ["黄", "#fbbc04"], ["緑", "#34a853"], ["青", "#4285f4"], ["茶", "#e2a185"],
  ["濃い赤", "#c5221f"], ["橙", "#f29900"], ["濃い緑", "#188038"], ["濃い青", "#1967d2"], ["焦げ茶", "#885945"],
];
const HIGHLIGHTER_COLORS = [
  ["薄い赤", "#f28b82"], ["黄", "#fdd663"], ["緑", "#34a853"], ["青", "#4285f4"], ["橙", "#ffae80"],
  ["赤", "#d93025"], ["黄緑", "#ddf300"], ["明るい緑", "#25e387"], ["明るい青", "#5379ff"], ["濃い橙", "#ff630c"],
];
const TEXT_COLORS = [
  ["黒", "#000000"], ["濃いグレー", "#5f6368"], ["グレー", "#9aa0a6"], ["薄いグレー", "#dadce0"], ["白", "#ffffff"],
  ["薄い赤", "#f28b82"], ["薄い黄", "#fdd663"], ["薄い緑", "#81c995"], ["薄い水色", "#78d9ec"], ["薄い青", "#8ab4f8"],
  ["赤", "#e94235"], ["黄", "#fbbc04"], ["緑", "#34a853"], ["水色", "#24c1e0"], ["青", "#4285f4"],
  ["濃い赤", "#c5221f"], ["橙", "#d56e0c"], ["濃い緑", "#188038"], ["濃い水色", "#12a4af"], ["濃い青", "#1967d2"],
];
// 太さ(Chrome の5段階に合わせ、PDF.js の単位に換算)
const PEN_SIZES = [["極細", 1], ["細", 2], ["中", 3], ["太", 6], ["極太", 8]];
const HIGHLIGHTER_SIZES = [["極細", 8], ["細", 10], ["中", 12], ["太", 18], ["極太", 24]];
const TEXT_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64];

const DRAW_TOOLS = [
  { id: "pen", label: "ペン", icon: "ink-pen" },
  { id: "highlighter", label: "蛍光ペン", icon: "ink-highlighter" },
  { id: "eraser", label: "消しゴム", icon: "ink-eraser" },
];

export class AnnotationTools {
  constructor(app, toast) {
    this.app = app;
    this.toast = toast;
    this.uiManager = null;
    this.activeTool = null; // null | "text" | "pen" | "highlighter" | "eraser"
    this.drawTool = "pen";
    this.state = {
      pen: { color: "#000000", size: 2 },
      highlighter: { color: "#fdd663", size: 12 },
      text: { color: "#000000", size: 14 },
    };
    this.textButton = document.getElementById("shTextAnnot");
    this.drawButton = document.getElementById("shDrawAnnot");
    this.undoButton = document.getElementById("shUndo");
    this.redoButton = document.getElementById("shRedo");
    this.viewerContainer = document.getElementById("viewerContainer");
    this.panel = document.getElementById("shAnnotPanel");
    this.panelTitle = document.getElementById("shAnnotPanelTitle");
    this.panelBody = document.getElementById("shAnnotPanelBody");
    this.outer = document.getElementById("outerContainer");
    /** ペンで線を描いている途中か(描き終えたら1本ずつ確定させる) */
    this.penStroke = false;
    this.bind();
  }

  bind() {
    const bus = this.app.eventBus;
    bus.on("annotationeditoruimanager", ({ uiManager }) => {
      this.uiManager = uiManager;
      this.textButton.disabled = false;
      this.drawButton.disabled = false;
      this.activeTool = null;
      this.updateButtons();
    });
    bus.on("annotationeditormodechanged", ({ mode }) => {
      if (mode === -1) {
        this.textButton.disabled = this.drawButton.disabled = true;
      }
    });
    // 元に戻す/やり直すの可否(PDF.js 6 では "editingstateschanged"、それ以前は別名)
    const onStates = ({ details }) => {
      if ("hasSomethingToUndo" in details) {
        this.undoButton.disabled = !details.hasSomethingToUndo;
      }
      if ("hasSomethingToRedo" in details) {
        this.redoButton.disabled = !details.hasSomethingToRedo;
      }
    };
    bus.on("editingstateschanged", onStates);
    bus.on("annotationeditorstateschanged", onStates);

    this.textButton.addEventListener("click", () => {
      this.setTool(this.activeTool === "text" ? null : "text");
    });
    this.drawButton.addEventListener("click", () => {
      const drawing = this.activeTool && this.activeTool !== "text";
      this.setTool(drawing ? null : this.drawTool);
    });
    document.getElementById("shAnnotPanelClose").addEventListener("click", () => this.setTool(null));
    this.undoButton.addEventListener("click", () => this.uiManager?.undo());
    this.redoButton.addEventListener("click", () => this.uiManager?.redo());

    // ペン: 1本ずつ別の注釈にする。
    // PDF.js は続けて描いた線を1つの注釈にまとめるため、消しゴムで1本だけ消せるよう、
    // また「元に戻す」で1本ずつ戻せるよう、線を描き終えるたびに確定させる。
    this.viewerContainer.addEventListener(
      "pointerdown",
      e => {
        if (this.activeTool === "pen" && e.button === 0 && e.target.closest?.(".annotationEditorLayer")) {
          this.penStroke = true;
        }
      },
      true
    );
    const endStroke = () => {
      if (!this.penStroke) {
        return;
      }
      this.penStroke = false;
      // PDF.js 側の「描き終わり」の処理が済んでから確定させる
      setTimeout(() => this.commitDrawing(), 0);
    };
    window.addEventListener("pointerup", endStroke);
    window.addEventListener("pointercancel", endStroke);

    // 消しゴム: 注釈の上をクリック/なぞると削除する
    const onPointer = e => this.onEraserPointer(e);
    this.viewerContainer.addEventListener("pointerdown", onPointer, true);
    this.viewerContainer.addEventListener("pointermove", onPointer, true);
    this.viewerContainer.addEventListener(
      "click",
      e => {
        if (this.activeTool === "eraser") {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true
    );

    window.addEventListener("keydown", e => {
      if (e.key !== "Escape" || !this.activeTool || document.querySelector(".sh-popup:not([hidden])")) {
        return;
      }
      const active = document.activeElement;
      if (active?.isContentEditable) {
        return; // テキスト入力中の Esc は PDF.js(入力の確定)に任せる
      }
      this.setTool(null);
    });
  }

  /** 文書を閉じたとき */
  reset() {
    this.uiManager = null;
    this.setTool(null, { silent: true });
    this.textButton.disabled = this.drawButton.disabled = true;
    this.undoButton.disabled = this.redoButton.disabled = true;
  }

  switchMode(mode) {
    this.app.eventBus.dispatch("switchannotationeditormode", { source: this, mode });
  }

  setParam(type, value) {
    this.app.eventBus.dispatch("switchannotationeditorparams", { source: this, type, value });
  }

  /** 描きかけの線(描画のまとまり)を確定させる */
  commitDrawing() {
    try {
      this.uiManager?.unselectAll();
    } catch (e) {
      console.warn("[製本ビューア] 描いた線の確定に失敗", e);
    }
  }

  setTool(tool, { silent = false } = {}) {
    if (!this.uiManager && tool) {
      this.toast?.show("PDFの読み込みが終わってから使えます");
      return;
    }
    if (this.activeTool && this.activeTool !== tool) {
      // 道具を持ち替える前に、描きかけの線を確定させる(ペン → 消しゴムなど、同じ編集モードどうしでも)
      this.penStroke = false;
      this.commitDrawing();
    }
    const wasOpen = !!this.activeTool;
    this.activeTool = tool;
    document.body.classList.toggle("sh-erasing", tool === "eraser");
    if (!silent || tool) {
      switch (tool) {
        case "text":
          this.switchMode(EditorType.FREETEXT);
          this.setParam(Param.FREETEXT_COLOR, this.state.text.color);
          this.setParam(Param.FREETEXT_SIZE, this.state.text.size);
          break;
        case "pen":
          this.drawTool = "pen";
          this.switchMode(EditorType.INK);
          this.setParam(Param.INK_COLOR, this.state.pen.color);
          this.setParam(Param.INK_THICKNESS, this.state.pen.size);
          this.setParam(Param.INK_OPACITY, 1);
          break;
        case "highlighter":
          this.drawTool = "highlighter";
          this.switchMode(EditorType.HIGHLIGHT);
          this.setParam(Param.HIGHLIGHT_COLOR, this.state.highlighter.color);
          this.setParam(Param.HIGHLIGHT_THICKNESS, this.state.highlighter.size);
          break;
        case "eraser":
          this.drawTool = "eraser";
          // 注釈をクリックで拾えるよう編集モードにしておき、新しい線は下のハンドラで止める
          this.switchMode(EditorType.INK);
          break;
        default:
          if (this.uiManager) {
            this.switchMode(EditorType.NONE);
          }
      }
    }
    this.renderPanel();
    if (wasOpen !== !!tool) {
      // 右側のパネルの開閉でページ表示の幅が変わるので、PDF.js に再計算させる
      this.app.eventBus.dispatch("resize", { source: window });
    }
    this.updateButtons();
  }

  updateButtons() {
    const t = this.activeTool;
    this.textButton.classList.toggle("sh-pressed", t === "text");
    this.textButton.setAttribute("aria-pressed", t === "text" ? "true" : "false");
    const drawing = !!t && t !== "text";
    this.drawButton.classList.toggle("sh-pressed", drawing);
    this.drawButton.setAttribute("aria-pressed", drawing ? "true" : "false");
  }

  // ---- 消しゴム ----------------------------------------------------------
  onEraserPointer(e) {
    if (this.activeTool !== "eraser") {
      return;
    }
    if (e.type === "pointermove" && !(e.buttons & 1)) {
      return;
    }
    if (e.type === "pointerdown" && e.button !== 0) {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    this.eraseAt(e.clientX, e.clientY);
  }

  eraseAt(x, y) {
    const ui = this.uiManager;
    if (!ui) {
      return;
    }
    for (const el of document.elementsFromPoint(x, y)) {
      const editorEl = el.closest?.(".annotationEditorLayer > div[id]");
      if (!editorEl) {
        continue;
      }
      const editor = ui.getEditor(editorEl.id);
      if (!editor || editor.isEmpty?.()) {
        continue;
      }
      try {
        this.removeEditor(editor);
      } catch (err) {
        console.warn("[製本ビューア] 注釈の削除に失敗", err);
      }
      return;
    }
  }

  /**
   * 注釈を1つ削除する(「元に戻す」で戻せる)。
   * PDF.js の「選んで削除」を使うと、選んだときに出る小さなツールバーの準備と削除がぶつかって
   * エラーになることがあるため、選ばずに削除の操作として登録する(PDF.js の削除と同じ戻し方)。
   */
  removeEditor(editor) {
    const ui = this.uiManager;
    ui.unselectAll();
    // 消した書き込みを「元に戻す」で戻すとき、ページを削除・元に戻してページ番号が変わっていても、
    // 元のページに戻す(ページそのものを覚えておく)。そのページを削除していたら戻さない
    const viewer = this.app.pdfViewer;
    const pageView = viewer?.getPageView?.(editor.pageIndex) || null;
    const restore = () => {
      let index = editor.pageIndex;
      if (pageView && viewer?._pages) {
        index = viewer._pages.indexOf(pageView);
        if (index < 0) {
          return; // ページを削除した
        }
        editor.pageIndex = index;
      }
      const layer = ui.getLayer(index);
      if (layer) {
        layer.addOrRebuild(editor);
      } else {
        ui.addEditor(editor);
        ui.addToAnnotationStorage(editor);
      }
    };
    ui.addCommands({ cmd: () => editor.remove(), undo: restore, mustExec: true });
  }

  // ---- 右側のパネル ---------------------------------------------------------
  renderPanel() {
    const tool = this.activeTool;
    const open = !!tool;
    this.panel.hidden = !open;
    this.outer.classList.toggle("sh-annot-open", open);
    if (!open) {
      return;
    }
    this.panelBody.textContent = "";
    if (tool === "text") {
      this.panelTitle.textContent = "テキスト";
      this.buildTextPanel(this.panelBody);
    } else {
      this.panelTitle.textContent = "描画";
      this.buildDrawPanel(this.panelBody);
    }
    hydrateIcons(this.panel);
  }

  section(parent, title) {
    const sec = document.createElement("section");
    sec.className = "sh-annot-section";
    const h = document.createElement("h3");
    h.textContent = title;
    sec.append(h);
    parent.append(sec);
    return sec;
  }

  buildDrawPanel(el) {
    const tools = document.createElement("div");
    tools.className = "sh-annot-tools";
    tools.setAttribute("role", "radiogroup");
    tools.setAttribute("aria-label", "ツール");
    for (const tool of DRAW_TOOLS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sh-annot-tool";
      b.setAttribute("role", "radio");
      const selected = this.activeTool === tool.id;
      b.setAttribute("aria-checked", selected ? "true" : "false");
      b.classList.toggle("sh-selected", selected);
      b.title = tool.label;
      b.append(createIcon(selected ? `${tool.icon}-filled` : tool.icon));
      const label = document.createElement("span");
      label.textContent = tool.label;
      b.append(label);
      b.addEventListener("click", () => this.setTool(tool.id));
      tools.append(b);
    }
    el.append(tools);

    const tool = this.activeTool;
    if (tool === "eraser") {
      const note = document.createElement("p");
      note.className = "sh-annot-note";
      note.textContent = "消したい注釈(手書き・蛍光ペン・テキスト)をクリックするか、なぞってください。消した注釈は「元に戻す」で戻せます。";
      el.append(note);
      return;
    }
    const highlighter = tool === "highlighter";
    const st = highlighter ? this.state.highlighter : this.state.pen;
    this.section(el, "太さ").append(
      this.buildSizes(highlighter ? HIGHLIGHTER_SIZES : PEN_SIZES, st.size, size => {
        st.size = size;
        this.setParam(highlighter ? Param.HIGHLIGHT_THICKNESS : Param.INK_THICKNESS, size);
      })
    );
    this.section(el, "色").append(
      this.buildColors(highlighter ? HIGHLIGHTER_COLORS : PEN_COLORS, st.color, color => {
        st.color = color;
        this.setParam(highlighter ? Param.HIGHLIGHT_COLOR : Param.INK_COLOR, color);
      })
    );
    if (highlighter) {
      const note = document.createElement("p");
      note.className = "sh-annot-note";
      note.textContent = "文字の上をなぞると、その文字に沿って塗ります。";
      el.append(note);
    }
  }

  buildTextPanel(el) {
    const st = this.state.text;
    const sec = this.section(el, "文字の大きさ");
    const select = document.createElement("select");
    select.className = "sh-select";
    select.setAttribute("aria-label", "文字の大きさ");
    for (const size of TEXT_SIZES) {
      const o = document.createElement("option");
      o.value = String(size);
      o.textContent = `${size} pt`;
      o.selected = size === st.size;
      select.append(o);
    }
    select.addEventListener("change", () => {
      st.size = Number(select.value);
      this.setParam(Param.FREETEXT_SIZE, st.size);
    });
    sec.append(select);
    this.section(el, "色").append(
      this.buildColors(TEXT_COLORS, st.color, color => {
        st.color = color;
        this.setParam(Param.FREETEXT_COLOR, color);
      })
    );
    const note = document.createElement("p");
    note.className = "sh-annot-note";
    note.textContent = "ページ上をクリックすると、その位置に文字を入力できます。入力を終えるには Esc を押すか、ほかの場所をクリックします。";
    el.append(note);
  }

  buildColors(colors, current, onPick) {
    const grid = document.createElement("div");
    grid.className = "sh-swatches";
    grid.setAttribute("role", "radiogroup");
    grid.setAttribute("aria-label", "色");
    for (const [name, color] of colors) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sh-swatch";
      b.style.setProperty("--swatch", color);
      b.title = name;
      b.setAttribute("aria-label", name);
      b.setAttribute("role", "radio");
      const selected = color.toLowerCase() === String(current).toLowerCase();
      b.setAttribute("aria-checked", selected ? "true" : "false");
      b.addEventListener("click", () => {
        for (const other of grid.children) {
          other.setAttribute("aria-checked", "false");
        }
        b.setAttribute("aria-checked", "true");
        onPick(color);
      });
      grid.append(b);
    }
    return grid;
  }

  buildSizes(sizes, current, onPick) {
    const row = document.createElement("div");
    row.className = "sh-sizes";
    row.setAttribute("role", "radiogroup");
    row.setAttribute("aria-label", "太さ");
    sizes.forEach(([name, size], i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sh-size";
      b.title = name;
      b.setAttribute("aria-label", name);
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", size === current ? "true" : "false");
      const dot = document.createElement("span");
      dot.className = "sh-size-dot";
      dot.style.setProperty("--dot", `${4 + i * 3}px`);
      b.append(dot);
      b.addEventListener("click", () => {
        for (const other of row.children) {
          other.setAttribute("aria-checked", "false");
        }
        b.setAttribute("aria-checked", "true");
        onPick(size);
      });
      row.append(b);
    });
    return row;
  }
}
