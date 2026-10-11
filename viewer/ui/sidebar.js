/**
 * サイドバー(Chrome 標準ビューアと同じく、左端のアイコンで「サムネイル」「しおり」等を切り替える)。
 * 中身(サムネイル・しおり・添付・レイヤー)の描画は PDF.js の ViewsManager が行う。
 * サムネイルの描画はサイドバーを開いたときにだけ行われる(最初のページ表示を妨げない)。
 */

const SidebarView = { NONE: 0, THUMBS: 1, OUTLINE: 2, ATTACHMENTS: 3, LAYERS: 4 };

export class SidebarTabs {
  constructor(app) {
    this.app = app;
    this.tabs = [
      { view: SidebarView.THUMBS, button: document.getElementById("shTabThumbs") },
      { view: SidebarView.OUTLINE, button: document.getElementById("shTabOutline"), loaded: "outlineloaded", countKey: "outlineCount" },
      { view: SidebarView.ATTACHMENTS, button: document.getElementById("shTabAttachments"), loaded: "attachmentsloaded", countKey: "attachmentsCount" },
      { view: SidebarView.LAYERS, button: document.getElementById("shTabLayers"), loaded: "layersloaded", countKey: "layersCount" },
    ];
    const bus = app.eventBus;
    for (const tab of this.tabs) {
      tab.button.addEventListener("click", () => {
        app.viewsManager?.switchView(tab.view, true);
      });
      if (tab.loaded) {
        bus.on(tab.loaded, evt => {
          const count = evt[tab.countKey] || 0;
          tab.button.parentElement.hidden = count === 0;
          this.updateIconsVisibility();
        });
      }
    }
    bus.on("sidebarviewchanged", ({ view }) => this.select(view));
    document.getElementById("shSidebarTabs").addEventListener("keydown", e => this.onKeyDown(e));

    // サイドバーの開閉でページ表示の幅が変わったら、「自動」「幅に合わせる」等の倍率を計算し直す
    document.getElementById("viewerContainer").addEventListener("transitionend", e => {
      if (e.target.id === "viewerContainer" && /inset|left|right/.test(e.propertyName)) {
        bus.dispatch("resize", { source: window });
      }
    });
    this.select(app.viewsManager?.visibleView ?? SidebarView.NONE);
    this.updateIconsVisibility();
  }

  reset() {
    for (const tab of this.tabs) {
      if (tab.loaded) {
        tab.button.parentElement.hidden = true;
      }
    }
    this.updateIconsVisibility();
  }

  /** タブが1つ(サムネイルだけ)のときは、Chrome と同じく左端のアイコン列を隠す */
  updateIconsVisibility() {
    const visibleTabs = this.tabs.filter(t => !t.button.parentElement.hidden);
    document.getElementById("shSidebar").classList.toggle("sh-no-tabs", visibleTabs.length <= 1);
  }

  select(view) {
    const active = view === SidebarView.NONE ? this.app.viewsManager?.active : view;
    for (const tab of this.tabs) {
      const selected = tab.view === active;
      tab.button.parentElement.classList.toggle("sh-selected", selected);
      tab.button.setAttribute("aria-selected", selected ? "true" : "false");
      tab.button.tabIndex = selected ? 0 : -1;
    }
  }

  onKeyDown(e) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") {
      return;
    }
    const visible = this.tabs.filter(t => !t.button.parentElement.hidden);
    const idx = visible.findIndex(t => t.button === document.activeElement);
    if (idx < 0) {
      return;
    }
    e.preventDefault();
    const next = visible[(idx + (e.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length];
    next.button.focus();
    next.button.click();
  }
}
