/**
 * 「製本用PDF出力」のダイアログ。
 *
 * 開いて「出力」を押すだけで、初期設定どおりに出力できる。細かい指定は「詳細設定」の中にまとめる。
 * 本体の並び(白紙の位置)と面付けの並びはプレビューで確認できる。
 */

import { sanitizeFileName, saveFiles } from "../../common/files.js";
import { ACCESSORY_ROLES, ROLE_USES, ROLE_USE_LABEL, imposition, parseBlankPositions, planBook, referenceSize, resolvePaper, roleUseFromSettings, useOfRole } from "../bookbinding.js";
import { buildBookbindingFiles, pageDisplaySizes } from "../bookbinding-export.js";
import { sourceIndex, viewPageCount } from "../page-map.js";
import { ROLES, ROLE_LABEL } from "../roles.js";
import { buildRoleItemsEditor } from "./role-items-editor.js";

const $ = id => document.getElementById(id);
const THUMB_W = 46;
/**
 * 0.5: 「カバー・表紙・帯などのページ」の欄は、詳細設定の項目(表示・複数・追加した項目)に合わせて作る。
 * 決まった項目の欄の id は 0.4 までと同じにする(試験・互換のため)。
 */
const SINGLE_IDS = Object.freeze({
  cover: "shBindCover",
  back: "shBindBack",
  obiFront: "shBindObiFront",
  obiBack: "shBindObiBack",
  obi: "shBindObiSingle",
  flapFront: "shBindFlapFront",
  flapBack: "shBindFlapBack",
  bookmark: "shBindBookmark",
});
const USE_IDS = Object.freeze({
  obiFront: "shBindUseObiFront",
  obiBack: "shBindUseObiBack",
  obi: "shBindUseObi",
  flapFront: "shBindUseFlapFront",
  flapBack: "shBindUseFlapBack",
  bookmark: "shBindUseBookmark",
});
const singleId = role => SINGLE_IDS[role] || `shBindRole-${role}`;
const useId = role => USE_IDS[role] || `shBindUse-${role}`;
/** 複数のページを選ぶ欄の部品の id(帯は 0.4 までと同じ) */
const multiIds = role =>
  role === "obi"
    ? { box: "shBindObiMulti", items: "shBindObiItems", add: "shBindObiAdd", label: "shBindObiLabel" }
    : { box: `shBindMulti-${role}`, items: `shBindMultiItems-${role}`, add: `shBindMultiAdd-${role}`, label: `shBindMultiLabel-${role}` };

export class BookbindingDialog {
  /**
   * @param {object} o
   * @param {object} o.app
   * @param {object} o.roles PageRoles
   * @param {object} o.docSource
   * @param {object} o.toast
   * @param {() => object} o.getSettings
   * @param {() => string} o.getDirection 表示中の綴じ方向
   * @param {() => void} o.onOpenRoles 役割のパネルを開く
   */
  constructor(o) {
    Object.assign(this, o);
    this.dialog = $("shBindDialog");
    this.sizes = null;
    this.thumbCache = new Map();
    this.busy = false;
    /** 本の最初・最後のページ(カバーの表紙・裏表紙)に使うページ(表示上の 0始まりのページ番号)。null は自動 */
    this.coverChoice = null;
    this.backChoice = null;
    this.bind();
  }

  bind() {
    const refresh = () => this.refresh();
    for (const id of ["shBindImpose", "shBindPaper", "shBindBase", "shBindSuffix", "shBindObiSuffix"]) {
      $(id).addEventListener("input", refresh);
      $(id).addEventListener("change", refresh);
    }
    // カバー・表紙・帯などのページの欄は buildRoleGrid で作る(項目は詳細設定で変えられる)
    // 0.5: 出力ページのプレビューを出さない(初期値はオン。選んだものを覚えておく)
    $("shBindHidePreview").addEventListener("change", () => {
      this.saveSettings?.({ bindHidePreview: $("shBindHidePreview").checked });
      this.refresh();
    });
    // 0.5: 大きさの基準を「ページ指定」にする
    $("shBindSizeRefPage").addEventListener("change", () => {
      this.setRadio("shBindSizeRef", "page");
      refresh();
    });
    // 0.5: カバー・表紙・帯などの項目(追加・削除・表示・複数)
    this.roleItemsEditor = buildRoleItemsEditor($("shBindRoleItems"), {
      getItems: () => this.getSettings().bindRoleItems,
      save: items => this.saveSettings?.({ bindRoleItems: items }),
      idPrefix: "shBindRi",
      notify: message => this.toast.show(message, { duration: 3000 }),
    });
    // 役割が変わったら(この画面・サイドバー・ほかのタブ)、表示を作り直す
    this.roles.onChange(() => {
      if (this.dialog.open && this.sizes) {
        this.fillCandidates();
        this.refresh();
      }
    });
    // ページを削除・元に戻したら、ページの大きさとプレビューを調べ直す
    this.app.eventBus.on("pagesedited", ({ type }) => {
      if (type !== "copy" && type !== "cancelCopy" && type !== "cleanSavedData") {
        this.sizes = null;
        this.thumbCache.clear();
      }
    });
    for (const name of ["shBindBlankMode", "shBindDirection", "shBindDuplex", "shBindSizeRef", "shBindObiOutput"]) {
      for (const r of document.querySelectorAll(`input[name="${name}"]`)) {
        r.addEventListener("change", refresh);
      }
    }
    $("shBindBlankAfter").addEventListener("input", () => {
      document.querySelector('input[name="shBindBlankMode"][value="custom"]').checked = true;
      refresh();
    });
    $("shBindClose").addEventListener("click", () => this.close());
    $("shBindCancel").addEventListener("click", () => this.close());
    $("shBindRun").addEventListener("click", () => this.run());
    $("shBindResultClose").addEventListener("click", () => this.close());
    $("shBindOpenRoles").addEventListener("click", () => {
      this.close();
      this.onOpenRoles();
    });
    this.dialog.addEventListener("cancel", e => {
      if (this.busy) {
        e.preventDefault();
      }
    });
    this.dialog.addEventListener("close", () => this.cleanup());
  }

  get isOpen() {
    return this.dialog.open;
  }

  close() {
    if (!this.busy && this.dialog.open) {
      this.dialog.close();
    }
  }

  cleanup() {
    this.observer?.disconnect();
  }

  /** ダイアログを開く(設定の初期値から始める) */
  async open() {
    const app = this.app;
    if (!app.pdfDocument) {
      this.toast.show("PDF を開いてから使ってください");
      return;
    }
    const s = this.getSettings();
    const doc = app.pdfDocument;
    if (this.sizesDoc !== doc) {
      this.sizes = null;
      this.thumbCache.clear();
      this.sizesDoc = doc;
    }
    // ---- 初期値 ----
    $("shBindImpose").checked = s.bindImpose;
    this.setRadio("shBindBlankMode", s.bindBlankPosition);
    $("shBindBlankAfter").value = "";
    this.setRadio("shBindDirection", this.getDirection() || s.bindingDirection);
    $("shBindPaper").value = s.bindPaper;
    this.setRadio("shBindDuplex", s.bindDuplex);
    this.setRadio("shBindSizeRef", s.bindSizeRef);
    this.setRadio("shBindObiOutput", s.bindObiOutput);
    this.buildRoleGrid();
    this.buildUses(roleUseFromSettings(s));
    this.roleItemsEditor.reload();
    $("shBindHidePreview").checked = s.bindHidePreview;
    this.sizeRefPage = null;
    $("shBindBase").value = this.docSource.baseName();
    $("shBindSuffix").value = s.bindNameSuffix;
    $("shBindObiSuffix").value = s.bindObiSuffix;
    $("shBindDetails").open = s.bindBlankPosition === "custom";
    $("shBindResult").hidden = true;
    $("shBindMain").hidden = false;
    $("shBindRun").disabled = true;
    $("shBindProgress").textContent = "";
    this.coverChoice = null;
    this.backChoice = null;
    this.dialog.showModal();
    $("shBindSummary").textContent = "ページの大きさを調べています…";
    for (const sel of document.querySelectorAll(".sh-bind-roles select")) {
      sel.textContent = "";
      sel.disabled = true;
    }
    for (const items of document.querySelectorAll(".sh-bind-roles .sh-multi-items")) {
      items.textContent = "";
    }
    const rolesReady = this.roles.whenLoaded().catch(() => {});
    if (!this.sizes) {
      // 表示しているページ(削除したページを除く)の大きさ。getPage は表示上のページ番号で引く
      const sizes = await pageDisplaySizes(doc, Array.from({ length: viewPageCount(doc) }, (_, i) => i));
      if (doc !== app.pdfDocument) {
        return;
      }
      this.sizes = sizes;
    }
    // 保存済みのページ役割を読み込み終えてから、最初のページなどを決める
    await rolesReady;
    if (doc !== app.pdfDocument || !this.dialog.open) {
      return;
    }
    this.fillCandidates();
    this.refresh();
    $("shBindRun").focus();
  }

  setRadio(name, value) {
    for (const r of document.querySelectorAll(`input[name="${name}"]`)) {
      r.checked = r.value === value;
    }
  }

  radio(name) {
    return document.querySelector(`input[name="${name}"]:checked`)?.value;
  }

  /** 付属の役割のページの使い道(画面で選んだもの) */
  currentRoleUse() {
    const use = roleUseFromSettings(this.getSettings());
    for (const role of ACCESSORY_ROLES) {
      const select = $(useId(role));
      if (select?.value) {
        use[role] = select.value;
      }
    }
    return use;
  }

  /**
   * 0.5: 「カバー・表紙・帯などのページ」の欄を、項目の設定(表示・複数・追加した項目)に合わせて作る。
   * 隠した項目でも、この PDF でページに付いていれば欄を出す(付いたページが分かるように)。
   */
  buildRoleGrid() {
    const grid = $("shBindRoleGrid");
    grid.textContent = "";
    const present = new Set(this.app.pdfDocument ? [...this.roles.viewMap().values()] : []);
    for (const role of ROLES) {
      if (!role.visible && !present.has(role.id)) {
        continue;
      }
      if (role.multi && role.id !== "cover" && role.id !== "back") {
        const ids = multiIds(role.id);
        const label = document.createElement("label");
        label.htmlFor = ids.add;
        label.id = ids.label;
        label.textContent = role.label;
        const mark = document.createElement("span");
        mark.className = "sh-bind-multi-mark";
        mark.textContent = "(複数可)";
        label.append(mark);
        const box = document.createElement("div");
        box.id = ids.box;
        box.className = "sh-multi";
        box.setAttribute("role", "group");
        box.setAttribute("aria-labelledby", ids.label);
        box.dataset.role = role.id;
        const items = document.createElement("span");
        items.id = ids.items;
        items.className = "sh-multi-items";
        const add = document.createElement("select");
        add.id = ids.add;
        add.className = "sh-select sh-multi-add";
        add.dataset.role = role.id;
        add.setAttribute("aria-label", `${role.label}にするページを追加`);
        add.addEventListener("change", () => {
          const value = add.value;
          add.value = "";
          if (value !== "") {
            this.addMulti(role.id, Number(value));
          }
        });
        box.append(items, add);
        grid.append(label, box);
      } else {
        const id = singleId(role.id);
        const label = document.createElement("label");
        label.htmlFor = id;
        label.textContent = role.label;
        const select = document.createElement("select");
        select.id = id;
        select.className = "sh-select";
        select.dataset.role = role.id;
        if (role.id === "cover" || role.id === "back") {
          select.addEventListener("change", () => this.onCoverBackChange(role.id));
        } else {
          select.addEventListener("change", () => this.onObiChange(role.id, select.value));
        }
        grid.append(label, select);
      }
    }
  }

  /** 0.5: 付属の役割の使い道の欄を作る(追加した項目の分も) */
  buildUses(initial) {
    const box = $("shBindUses");
    const keep = {};
    for (const select of box.querySelectorAll("select[data-role]")) {
      keep[select.dataset.role] = select.value;
    }
    box.textContent = "";
    const title = document.createElement("span");
    title.className = "sh-bind-uses-title";
    title.textContent = "役割ごとの使い道:";
    box.append(title);
    for (const role of ACCESSORY_ROLES) {
      const label = document.createElement("label");
      label.dataset.role = role;
      label.append(`${ROLE_LABEL[role] || role} `);
      const select = document.createElement("select");
      select.id = useId(role);
      select.className = "sh-select sh-select-small";
      select.dataset.role = role;
      for (const use of ROLE_USES) {
        const opt = document.createElement("option");
        opt.value = use;
        opt.textContent = ROLE_USE_LABEL[use];
        select.append(opt);
      }
      select.value = (initial ? initial[role] : keep[role]) || keep[role] || "obi";
      // 使い道が変わると最初・最後のページの候補も変わる
      select.addEventListener("change", () => {
        this.fillCandidates();
        this.refresh();
      });
      label.append(select);
      box.append(label);
    }
  }

  /** 0.5: 項目の設定(詳細設定)が変わったとき: 欄を作り直す */
  onRoleItemsChanged() {
    if (!this.dialog.open) {
      return;
    }
    this.buildRoleGrid();
    this.buildUses(null);
    this.roleItemsEditor.reload();
    if (this.sizes) {
      this.fillCandidates();
      this.refresh();
    }
  }

  /**
   * カバー・表紙・帯などのページを選ぶ欄を作る。
   * どの欄も全部のページから選べる。役割の付いたページには、名前の後ろに役割を出す。
   */
  fillCandidates() {
    const n = this.sizes ? this.sizes.length : viewPageCount(this.app.pdfDocument);
    const view = this.roles.viewMap();
    const use = this.currentRoleUse();
    const plan = this.planWith({ coverIndex: this.coverChoice, backIndex: this.backChoice });
    const pageOption = (i, suffix = "") => {
      const opt = document.createElement("option");
      opt.value = String(i);
      const role = view.get(i);
      opt.textContent = `${i + 1}ページ目${role ? `(${ROLE_LABEL[role]})` : ""}${suffix}`;
      return opt;
    };
    // ---- カバーの表紙・カバーの裏表紙(本の最初・最後のページ): 「自動」+ 全部のページ ----
    const fillCoverBack = (select, target, choice, resolved) => {
      select.textContent = "";
      const auto = document.createElement("option");
      auto.value = "";
      const candidates = [...view.entries()].filter(([, role]) => useOfRole(role, use) === target).length;
      auto.textContent =
        resolved === null || resolved === undefined
          ? "自動(なし)"
          : candidates
            ? `自動(${resolved + 1}ページ目)`
            : `自動(${resolved + 1}ページ目・${target === "cover" ? "役割の無い最初のページ" : "役割の無い最後のページ"})`;
      select.append(auto);
      for (let i = 0; i < n; i++) {
        select.append(pageOption(i));
      }
      select.value = choice === null || choice === undefined ? "" : String(choice);
      select.disabled = n === 0;
    };
    if ($("shBindCover")) {
      fillCoverBack($("shBindCover"), "cover", this.coverChoice, plan.cover);
    }
    if ($("shBindBack")) {
      fillCoverBack($("shBindBack"), "back", this.backChoice, plan.back);
    }
    // ---- 1ページを選ぶ項目(表紙・裏表紙・折り返し・しおりなど): 「なし」+ 全部のページ ----
    for (const select of $("shBindRoleGrid").querySelectorAll("select.sh-select:not(.sh-multi-add)")) {
      const role = select.dataset.role;
      if (role === "cover" || role === "back") {
        continue;
      }
      select.textContent = "";
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "なし";
      select.append(none);
      const pages = [...view.entries()].filter(([, r]) => r === role).map(([i]) => i).sort((a, b) => a - b);
      if (pages.length > 1) {
        // 同じ役割のページが2つ以上あるとき(サイドバーで付けた場合など)は、そのまま残す選択肢を出す
        const multi = document.createElement("option");
        multi.value = "multi";
        multi.textContent = `${pages.map(i => i + 1).join("、")}ページ目(${pages.length}ページ)`;
        select.append(multi);
      }
      for (let i = 0; i < n; i++) {
        select.append(pageOption(i));
      }
      select.value = pages.length > 1 ? "multi" : pages.length === 1 ? String(pages[0]) : "";
      select.disabled = n === 0;
    }
    // ---- 複数のページを選べる項目(帯など): 付いているページの一覧 +「ページを追加」 ----
    for (const box of $("shBindRoleGrid").querySelectorAll(".sh-multi[data-role]")) {
      this.fillMulti(box.dataset.role, n, view, pageOption);
    }
  }

  /** 複数のページを選べる欄を作る */
  fillMulti(role, n, view, pageOption) {
    const ids = multiIds(role);
    const label = ROLE_LABEL[role];
    const pages = [...view.entries()].filter(([, r]) => r === role).map(([i]) => i).sort((a, b) => a - b);
    const items = $(ids.items);
    items.textContent = "";
    if (!pages.length) {
      const none = document.createElement("span");
      none.className = "sh-multi-none";
      none.textContent = "なし";
      items.append(none);
    }
    for (const i of pages) {
      const chip = document.createElement("span");
      chip.className = "sh-multi-item";
      chip.dataset.pageIndex = String(i);
      const text = document.createElement("span");
      text.textContent = `${i + 1}ページ目`;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "sh-multi-del";
      del.textContent = "×";
      del.title = `${i + 1}ページ目を「${label}」から外す`;
      del.setAttribute("aria-label", del.title);
      del.addEventListener("click", () => this.removeMulti(role, i));
      chip.append(text, del);
      items.append(chip);
    }
    const add = $(ids.add);
    add.textContent = "";
    const head = document.createElement("option");
    head.value = "";
    head.textContent = pages.length ? "+ ページを追加" : "+ ページを選ぶ";
    add.append(head);
    for (let i = 0; i < n; i++) {
      if (!pages.includes(i)) {
        add.append(pageOption(i));
      }
    }
    add.value = "";
    add.disabled = n === 0;
  }

  /** 複数のページを選べる項目にページを加える(ほかの役割が付いていれば置き換える) */
  addMulti(role, pageIndex) {
    const n = pageIndex + 1;
    if (this.coverChoice === pageIndex) {
      this.coverChoice = null;
    }
    if (this.backChoice === pageIndex) {
      this.backChoice = null;
    }
    this.roles.setMany([{ pages: [n], role }]).then(() => {
      this.toast.show(`${n}ページ目を「${ROLE_LABEL[role]}」にしました`, { duration: 2500 });
    });
  }

  /** 複数のページを選べる項目からページを外す */
  removeMulti(role, pageIndex) {
    const n = pageIndex + 1;
    this.roles.setMany([{ pages: [n], role: null }]).then(() => {
      this.toast.show(`${n}ページ目を「${ROLE_LABEL[role]}」から外しました`, { duration: 2500 });
    });
  }

  /** カバーの表紙・裏表紙の欄を変えたとき: 選んだページが候補でなければ、そのページにその役割を付ける */
  onCoverBackChange(target) {
    const select = $(singleId(target));
    const value = select.value;
    const choice = value === "" ? null : Number(value);
    if (target === "cover") {
      this.coverChoice = choice;
    } else {
      this.backChoice = choice;
    }
    if (choice !== null) {
      const role = this.roles.viewMap().get(choice) || null;
      if (useOfRole(role, this.currentRoleUse()) !== target) {
        // 役割を付けると、この画面は役割の変更の知らせで作り直される
        this.roles.set([choice + 1], target);
        return;
      }
    }
    this.fillCandidates();
    this.refresh();
  }

  /** 表紙・裏表紙・折り返し・しおりの欄を変えたとき: その役割のページを選んだページだけにする */
  onObiChange(role, value) {
    if (value === "multi") {
      return;
    }
    const current = this.roles.pages(role);
    const changes = [];
    const remove = current.filter(n => String(n - 1) !== value);
    if (remove.length) {
      changes.push({ pages: remove, role: null });
    }
    if (value !== "") {
      const n = Number(value) + 1;
      if (!current.includes(n)) {
        changes.push({ pages: [n], role });
        // 最初・最後のページに選んでいたページなら、その指定は自動に戻す
        if (this.coverChoice === n - 1) {
          this.coverChoice = null;
        }
        if (this.backChoice === n - 1) {
          this.backChoice = null;
        }
      }
    }
    if (changes.length) {
      this.roles.setMany(changes).then(() => {
        const label = ROLE_LABEL[role];
        this.toast.show(value === "" ? `「${label}」のページをなしにしました` : `${Number(value) + 1}ページ目を「${label}」にしました`, { duration: 2500 });
      });
    }
  }

  /** 入力から計画を立てる(ページ番号は表示上の番号。削除したページは含めない) */
  currentPlan() {
    return this.planWith({ coverIndex: this.coverChoice, backIndex: this.backChoice, withBlank: true });
  }

  planWith({ coverIndex = null, backIndex = null, withBlank = false }) {
    const n = this.sizes ? this.sizes.length : viewPageCount(this.app.pdfDocument);
    const mode = this.radio("shBindBlankMode") || "beforeBack";
    let after = [];
    let blankError = null;
    if (withBlank && mode === "custom") {
      ({ after, error: blankError } = parseBlankPositions($("shBindBlankAfter").value));
    }
    const plan = planBook({
      numPages: n,
      roles: this.roles.viewMap(),
      coverIndex,
      backIndex,
      blank: withBlank ? { mode, after } : { mode: "beforeBack" },
      roleUse: this.currentRoleUse(),
    });
    if (blankError) {
      plan.warnings.unshift(blankError);
    }
    return plan;
  }

  fileNames() {
    const base = sanitizeFileName($("shBindBase").value || this.docSource.baseName());
    const suffix = sanitizeFileName($("shBindSuffix").value, "_製本").replace(/^_?/, "_");
    const obiSuffix = sanitizeFileName($("shBindObiSuffix").value, "_付属").replace(/^_?/, "_");
    return {
      book: `${base}${suffix}.pdf`,
      imposed: `${base}${suffix}_面付け.pdf`,
      obi: `${base}${obiSuffix}.pdf`,
    };
  }

  /** 表示を最新にする */
  refresh() {
    if (!this.sizes || !this.dialog.open) {
      return;
    }
    const plan = this.currentPlan();
    this.plan = plan;
    const impose = $("shBindImpose").checked;
    const pageItems = plan.sequence.filter(s => s.kind === "page");
    const sizeRef = this.radio("shBindSizeRef") || "mode";
    this.fillSizeRefPages();
    const refPage = Number($("shBindSizeRefPage").value);
    const ref = referenceSize(
      pageItems.map(s => this.sizes[s.pageIndex]),
      sizeRef,
      sizeRef === "page" && this.sizes[refPage] ? this.sizes[refPage] : null
    );
    this.ref = ref;
    const paperChoice = $("shBindPaper").value;
    const paper = resolvePaper(paperChoice, ref);
    this.paper = paper;
    // 「自動」の選択肢に、推定した用紙を表示する
    $("shBindPaperAuto").textContent = `自動(${resolvePaper("auto", ref).label})`;

    // ---- 概要 ----
    if (plan.error) {
      $("shBindSummary").textContent = plan.error;
      $("shBindRun").disabled = true;
      return;
    }
    const parts = [];
    const view = this.roles.viewMap();
    const roleNote = (i, auto) => (auto ? "(自動)" : view.get(i) ? `(${ROLE_LABEL[view.get(i)]})` : "");
    if (plan.cover !== null) {
      parts.push(`最初のページ: ${plan.cover + 1}ページ目${roleNote(plan.cover, plan.coverAuto)}`);
    }
    parts.push(`本文: ${plan.body.length}ページ`);
    if (plan.back !== null) {
      parts.push(`最後のページ: ${plan.back + 1}ページ目${roleNote(plan.back, plan.backAuto)}`);
    }
    const n0 = plan.N - plan.blanks;
    let summary = `${parts.join(" / ")}\n本体 ${n0}ページ + 白紙 ${plan.blanks}枚 = ${plan.N}ページ`;
    if (impose) {
      summary += `(${paper.label} に面付けして ${plan.N / 4}枚・両面)`;
    }
    const obiOutput = this.radio("shBindObiOutput");
    if (plan.obi.length) {
      const how = obiOutput === "separate" ? "別の PDF に出力" : obiOutput === "append" ? "本体の後ろに同梱" : "出力しない";
      const kinds = ACCESSORY_ROLES.filter(r => plan.obi.some(i => view.get(i) === r)).map(r => ROLE_LABEL[r]);
      summary += `\n付属(${kinds.join("・")}): ${plan.obi.length}ページ(${plan.obi.map(i => `${i + 1}`).join("、")}ページ目)→ ${how}`;
    }
    if (plan.omitted.length) {
      summary += `\n出力しないページ: ${plan.omitted.map(i => `${i + 1}`).join("、")}ページ目(付属の役割の使い道が「出力しない」)`;
    }
    $("shBindSummary").textContent = summary;

    // ---- 注意 ----
    const warnings = [...plan.warnings];
    if (ref.mixed) {
      const basis = sizeRef === "first" ? "最初のページ" : sizeRef === "page" ? `${refPage + 1}ページ目の大きさ` : "最も多い大きさ";
      warnings.push(
        `ページの大きさがそろっていません(${ref.kinds}種類)。${basis}を基準に用紙を選び、各ページを用紙の半分に収まるよう拡大縮小します(詳細設定の「大きさの基準」で変えられます)。`
      );
    }
    if (impose && Math.abs(paper.scale - 1) > 0.03) {
      warnings.push(`ページは ${Math.round(paper.scale * 100)}% の大きさで配置されます(用紙: ${paper.label})。`);
    }
    if (!this.roles.size && this.coverChoice === null && this.backChoice === null) {
      warnings.push("カバーの表紙・裏表紙を指定していないため、1ページ目を本の最初のページ、最後のページを本の最後のページにします(上の「カバーの表紙」「カバーの裏表紙」で変えられます)。");
    }
    $("shBindWarnings").hidden = !warnings.length;
    $("shBindWarnings").textContent = warnings.join("\n");
    $("shBindSizeRefHelp").textContent = ref.mixed
      ? `この PDF はページの大きさがそろっていません(${ref.kinds}種類)。どのページの大きさに合わせて用紙を選び、ほかのページを拡大縮小するかを決めます。`
      : "この PDF のページの大きさはそろっています(大きさがそろっていないときに使います)。";
    $("shBindDuplexRow").hidden = !impose;
    // 0.5: 用紙は詳細設定の外。面付けしないときは使わないので、選べなくする
    $("shBindPaper").disabled = !impose;
    $("shBindPaperHelp").textContent = impose
      ? "面付けして印刷する用紙です。自動では、元のページ2枚を並べて収まる用紙を選びます(A5 の本なら A4 横、B5 の本なら B4 横)。"
      : "面付けしないため、用紙は使いません(面付けは「詳細設定」で選べます)。";
    // 付属の欄は、付属の役割のページがあるときだけ出す(使い道の欄も、その PDF にある役割の分だけ)
    const presentObiRoles = ACCESSORY_ROLES.filter(r => this.roles.pages(r).length);
    // 自動の欄の「自動(○ページ目)」を、いまの計画に合わせる
    this.updateAutoLabels(plan);
    // 0.5: 付属の出力の欄はいつも出す(使い道の欄は、この PDF で付いている役割の分だけ)
    $("shBindObiRow").hidden = false;
    $("shBindUses").hidden = !presentObiRoles.length;
    $("shBindNameObiRow").hidden = false;
    for (const label of document.querySelectorAll(".sh-bind-uses label[data-role]")) {
      label.hidden = !presentObiRoles.includes(label.dataset.role);
    }

    // ---- 保存するファイル ----
    const names = this.fileNames();
    $("shBindNameBook").textContent = impose ? names.imposed : names.book;
    $("shBindNameObi").textContent = plan.obi.length && obiOutput === "separate" ? names.obi : `${names.obi}(いまは作りません)`;
    const files = [impose ? names.imposed : names.book];
    if (plan.obi.length && obiOutput === "separate") {
      files.push(names.obi);
    }
    $("shBindFiles").textContent = `保存するファイル: ${files.join("、")}`;
    $("shBindRun").disabled = this.busy;

    // 0.5: プレビューを出さない設定のときは、サムネイルも作らない
    const hide = $("shBindHidePreview").checked;
    $("shBindPreviewWrap").hidden = hide;
    if (hide) {
      this.observer?.disconnect();
      $("shBindPreview").textContent = "";
      $("shBindSheets").textContent = "";
      return;
    }
    this.renderPreview(plan);
    this.renderSheets(plan, impose);
  }

  /** 0.5: 大きさの基準の「ページ指定」の欄(全部のページ。大きさも出す) */
  fillSizeRefPages() {
    const select = $("shBindSizeRefPage");
    const n = this.sizes.length;
    if (select.options.length !== n) {
      const keep = select.value;
      select.textContent = "";
      for (let i = 0; i < n; i++) {
        const o = document.createElement("option");
        o.value = String(i);
        const { width, height } = this.sizes[i];
        o.textContent = `${i + 1}ページ目(${Math.round((width * 25.4) / 72)}×${Math.round((height * 25.4) / 72)} mm)`;
        select.append(o);
      }
      select.value = keep && Number(keep) < n ? keep : "0";
    }
  }

  updateAutoLabels(plan) {
    for (const [id, resolved, choice] of [
      ["shBindCover", plan.cover, this.coverChoice],
      ["shBindBack", plan.back, this.backChoice],
    ]) {
      const auto = $(id)?.querySelector('option[value=""]');
      if (auto && choice === null && resolved !== null && resolved !== undefined && !auto.textContent.includes(`${resolved + 1}ページ目`)) {
        auto.textContent = `自動(${resolved + 1}ページ目)`;
      }
    }
  }

  labelOf(item) {
    if (item.kind === "blank") {
      return { text: "白紙", sub: "" };
    }
    // 本の最初・最後のページ(カバーの表紙・裏表紙など)
    const sub = item.part === "cover" ? "最初" : item.part === "back" ? "最後" : "";
    return { text: String(item.pageIndex + 1), sub };
  }

  renderPreview(plan) {
    const box = $("shBindPreview");
    box.textContent = "";
    this.observer?.disconnect();
    this.observer = new IntersectionObserver(entries => this.onThumbVisible(entries), { root: box, rootMargin: "100px" });
    plan.sequence.forEach((item, i) => {
      const cell = document.createElement("div");
      cell.className = `sh-bind-page${item.kind === "blank" ? " sh-blank" : ""}${item.part === "cover" || item.part === "back" ? " sh-cover" : ""}`;
      const thumb = document.createElement("div");
      thumb.className = "sh-bind-thumb";
      if (item.kind === "page") {
        const size = this.sizes[item.pageIndex];
        thumb.style.aspectRatio = `${size.width} / ${size.height}`;
        thumb.dataset.pageIndex = String(item.pageIndex);
        const cached = this.thumbCache.get(item.pageIndex);
        if (cached) {
          thumb.style.backgroundImage = `url(${cached})`;
        } else {
          this.observer.observe(thumb);
        }
      } else {
        thumb.style.aspectRatio = `${this.ref.width} / ${this.ref.height}`;
        thumb.textContent = "白紙";
      }
      const { text, sub } = this.labelOf(item);
      const label = document.createElement("div");
      label.className = "sh-bind-label";
      label.textContent = item.kind === "blank" ? `(${i + 1})` : `${sub ? `${sub} ` : ""}${text}`;
      label.title = `本体の ${i + 1} ページ目`;
      cell.append(thumb, label);
      box.append(cell);
    });
  }

  async onThumbVisible(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }
      this.observer.unobserve(entry.target);
      const i = Number(entry.target.dataset.pageIndex);
      try {
        const url = await this.thumbnail(i);
        entry.target.style.backgroundImage = `url(${url})`;
      } catch {}
    }
  }

  async thumbnail(pageIndex) {
    if (this.thumbCache.has(pageIndex)) {
      return this.thumbCache.get(pageIndex);
    }
    const page = await this.app.pdfDocument.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: (THUMB_W * ratio) / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport, background: "#ffffff" }).promise;
    const url = canvas.toDataURL("image/jpeg", 0.8);
    canvas.width = canvas.height = 0;
    this.thumbCache.set(pageIndex, url);
    return url;
  }

  renderSheets(plan, impose) {
    const wrap = $("shBindSheetsWrap");
    wrap.hidden = !impose;
    if (!impose) {
      return;
    }
    const box = $("shBindSheets");
    box.textContent = "";
    const direction = this.radio("shBindDirection") || "ltr";
    const name = pos => {
      const item = plan.sequence[pos - 1];
      return item.kind === "blank" ? "白紙" : String(item.pageIndex + 1);
    };
    for (const sheet of imposition(plan.N, direction)) {
      const row = document.createElement("div");
      row.className = "sh-bind-sheet";
      const title = document.createElement("span");
      title.className = "sh-bind-sheet-no";
      title.textContent = `${sheet.sheet}枚目`;
      row.append(title);
      for (const [side, pair] of [
        ["表", sheet.front],
        ["裏", sheet.back],
      ]) {
        const s = document.createElement("span");
        s.className = "sh-bind-side";
        const label = document.createElement("span");
        label.className = "sh-bind-side-label";
        label.textContent = side;
        const pages = document.createElement("span");
        pages.className = "sh-bind-pair";
        for (const pos of pair) {
          const p = document.createElement("span");
          const nm = name(pos);
          p.className = `sh-bind-mini${nm === "白紙" ? " sh-blank" : ""}`;
          p.textContent = nm;
          p.title = `本体の ${pos} ページ目`;
          pages.append(p);
        }
        s.append(label, pages);
        row.append(s);
      }
      box.append(row);
    }
  }

  /** 出力 */
  async run() {
    if (this.busy || !this.plan || this.plan.error) {
      return;
    }
    const app = this.app;
    const doc = app.pdfDocument;
    const plan = this.plan;
    const impose = $("shBindImpose").checked;
    const duplex = this.radio("shBindDuplex") || "short";
    const obiOutput = this.radio("shBindObiOutput") || "separate";
    const direction = this.radio("shBindDirection") || "ltr";
    const names = this.fileNames();
    this.busy = true;
    $("shBindRun").disabled = true;
    $("shBindCancel").disabled = true;
    const progress = msg => ($("shBindProgress").textContent = msg);
    // 計画は表示上のページ番号で立てているので、抜き出し用に元の PDF のページ番号に直す
    const toSource = i => sourceIndex(doc, i + 1);
    const sourcePlan = {
      ...plan,
      sequence: plan.sequence.map(item => (item.kind === "page" ? { ...item, pageIndex: toSource(item.pageIndex) } : item)),
      obi: plan.obi.map(toSource),
    };
    try {
      const files = await buildBookbindingFiles({
        doc,
        plan: sourcePlan,
        refSize: this.ref,
        impose,
        direction,
        paper: this.paper,
        duplex,
        obiOutput,
        fileNames: names,
        progress,
        // パスワードを入力して開いた PDF は、書き込みを反映した写しにもパスワードが必要になるため反映しない
        includeEdits: !this.docSource.passwordDocs.has(doc),
      });
      progress("保存しています…");
      const res = await saveFiles(files.map(f => ({ blob: new Blob([f.bytes], { type: "application/pdf" }), fileName: f.fileName })));
      if (!res.ok) {
        progress("");
        if (res.canceled) {
          this.toast.show(res.saved.length ? "残りのファイルの保存をやめました" : "保存をやめました");
          return;
        }
        throw new Error(res.error || "保存できませんでした");
      }
      const saved = files.map((f, i) => ({ ...f, fileName: res.saved[i]?.fileName || f.fileName, id: res.saved[i]?.id }));
      this.showResult(saved, { impose, duplex, plan });
    } catch (e) {
      console.error(e);
      progress("");
      this.toast.show(`製本用PDFを作成できませんでした: ${e.message || e}`, { kind: "error", duration: 10000 });
    } finally {
      this.busy = false;
      $("shBindRun").disabled = false;
      $("shBindCancel").disabled = false;
    }
  }

  showResult(saved, { impose, duplex, plan }) {
    $("shBindMain").hidden = true;
    $("shBindResult").hidden = false;
    const list = $("shBindResultFiles");
    list.textContent = "";
    for (const f of saved) {
      const li = document.createElement("li");
      const what =
        f.kind === "imposed"
          ? `面付け済み(${this.paper.label}、${plan.N / 4}枚の両面 = ${f.pages}面)`
          : f.kind === "book"
            ? `読む順の本体(${plan.N}ページ、白紙 ${plan.blanks}枚を含む)`
            : `付属(${f.pages}ページ)`;
      li.textContent = `${f.fileName} — ${what}`;
      if (f.id !== undefined) {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "sh-btn sh-btn-small sh-btn-text";
        open.textContent = "フォルダを開く";
        open.addEventListener("click", () => chrome.downloads.show(f.id));
        li.append(" ", open);
      }
      list.append(li);
    }
    const guide = $("shBindGuide");
    guide.textContent = "";
    const add = (text, cls) => {
      const p = document.createElement("li");
      p.textContent = text;
      if (cls) {
        p.className = cls;
      }
      guide.append(p);
    };
    if (impose) {
      $("shBindGuideTitle").textContent = "プリンターでは、この設定で両面印刷してください";
      add(`用紙: ${this.paper.label}`);
      add(`両面印刷: ${duplex === "long" ? "長辺とじ(長辺で綴じる)" : "短辺とじ(短辺で綴じる)"}`);
      add("倍率: 実際のサイズ(100%)/「用紙に合わせる」は使わない");
      add("ページの順番: 1枚目から順に(並べ替えない)");
      add("印刷した紙を順に重ね、まとめて真ん中で二つ折りにして、折り目をホチキスで留めると本になります。", "sh-note");
    } else {
      $("shBindGuideTitle").textContent = "印刷のしかた";
      add("プリンターの「小冊子印刷」の機能で印刷すると、中綴じの本になります(並べ替えはプリンターに任せます)。");
      add(`ページ数は ${plan.N}(4の倍数)にそろえてあります。`);
    }
    $("shBindResultClose").focus();
  }
}
