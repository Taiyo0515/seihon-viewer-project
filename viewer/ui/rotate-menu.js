/**
 * 0.5: 回転ボタン。
 *  - クリック: 既定の向き・角度で回転する(初期値は Chrome と同じく、左に 90°)
 *  - 右クリック: 「[左/右] に [90°/180°/270°] 回転する」を選んで回転する吹き出しを出す。
 *    一番下の「既定の設定を上書きする」をオンにして回転すると、その向き・角度をボタンの既定にする(設定に保存)。
 * Ctrl+[ ・ Ctrl+] は Chrome と同じ 90° のまま(変えない)。
 */

import { setIcon } from "../icons.js";
import { Popover } from "./popup.js";

export const ROTATE_STEPS = [-90, -180, -270, 90, 180, 270];

/** 回転の言葉(例: -90 → 「左に 90°」) */
export function rotateLabel(step) {
  return `${step < 0 ? "左" : "右"}に ${Math.abs(step)}°`;
}

export class RotateButton {
  /**
   * @param {object} o
   * @param {object} o.app PDFViewerApplication
   * @param {() => object} o.getSettings
   * @param {(patch:object) => Promise<object>} o.saveSettings
   * @param {object} o.toast
   */
  constructor({ app, getSettings, saveSettings, toast }) {
    Object.assign(this, { app, getSettings, saveSettings, toast });
    this.button = document.getElementById("shRotate");
    this.button.addEventListener("click", () => this.rotate(this.step));
    this.button.addEventListener("contextmenu", e => {
      e.preventDefault();
      if (this.app.pdfDocument) {
        this.popover.open();
      }
    });
    this.popover = new Popover({
      anchor: this.button,
      align: "start",
      className: "sh-rotate-popover",
      label: "回転の向きと角度",
      build: el => this.build(el),
    });
    this.update();
  }

  /** ボタンを押したときの回転(設定 rotateStep) */
  get step() {
    const s = this.getSettings().rotateStep;
    return ROTATE_STEPS.includes(s) ? s : -90;
  }

  rotate(step) {
    if (this.app.pdfDocument) {
      this.app.rotatePages(step);
    }
  }

  /** ボタンの見た目(向きのアイコンと説明)を設定に合わせる */
  update() {
    const step = this.step;
    const label = `${rotateLabel(step)}回転(${step < 0 ? "反時計回り" : "時計回り"})`;
    this.button.title = `${label}\n右クリックで向きと角度を選べます`;
    this.button.setAttribute("aria-label", label);
    setIcon(this.button, step < 0 ? "rotate-ccw" : "rotate-cw");
  }

  build(el) {
    const step = this.step;
    const title = document.createElement("div");
    title.className = "sh-rotate-title";
    title.textContent = "回転";

    const row = document.createElement("div");
    row.className = "sh-rotate-row";
    const dir = select("shRotateDir", "向き", [
      ["left", "左"],
      ["right", "右"],
    ]);
    dir.value = step < 0 ? "left" : "right";
    const angle = select("shRotateAngle", "角度", [
      ["90", "90°"],
      ["180", "180°"],
      ["270", "270°"],
    ]);
    angle.value = String(Math.abs(step));
    const ni = document.createElement("span");
    ni.textContent = "に";
    const suru = document.createElement("span");
    suru.textContent = "回転する";
    row.append(dir, ni, angle, suru);

    const run = document.createElement("button");
    run.type = "button";
    run.id = "shRotateRun";
    run.className = "sh-btn sh-btn-primary sh-btn-small";
    run.textContent = "回転";

    const actions = document.createElement("div");
    actions.className = "sh-rotate-actions";
    actions.append(run);

    const check = document.createElement("label");
    check.className = "sh-rotate-default";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = "shRotateDefault";
    const text = document.createElement("span");
    text.textContent = "既定の設定を上書きする";
    const note = document.createElement("span");
    note.className = "sh-rotate-note";
    note.textContent = `オンにして回転すると、回転ボタンを押したときの動きがこの向き・角度になります(いまは「${rotateLabel(step)}」)`;
    check.append(box, text);

    const chosen = () => (dir.value === "left" ? -1 : 1) * Number(angle.value);
    run.addEventListener("click", async () => {
      const next = chosen();
      this.popover.close();
      this.rotate(next);
      if (box.checked && next !== this.step) {
        await this.saveSettings({ rotateStep: next });
        this.update();
        this.toast.show(`回転ボタンの動きを「${rotateLabel(next)}」にしました(右クリックでいつでも変えられます)`, { duration: 5000 });
      }
      this.button.focus({ preventScroll: true });
    });
    for (const s of [dir, angle]) {
      s.addEventListener("keydown", e => {
        if (e.key === "Enter") {
          e.preventDefault();
          run.click();
        }
      });
    }
    el.append(title, row, actions, check, note);
    setTimeout(() => dir.focus(), 0);
  }
}

function select(id, label, options) {
  const s = document.createElement("select");
  s.id = id;
  s.className = "sh-select";
  s.setAttribute("aria-label", label);
  for (const [value, text] of options) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    s.append(o);
  }
  return s;
}
