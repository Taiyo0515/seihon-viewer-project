// Compile in a sandboxed extension page without chrome.* access. Its output is
// displayed in a second, script-free frame, never inserted into the viewer DOM.
let enginePromise;
function engine() {
  if (!enginePromise) {
    enginePromise = new Promise((resolve, reject) => {
      const frame = document.createElement("iframe");
      frame.src = new URL("./markup-engine.html", import.meta.url).href;
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.style.cssText = "position:fixed;left:-12000px;top:0;width:1000px;height:700px;visibility:hidden;pointer-events:none";
      frame.onload = () => resolve(frame);
      frame.onerror = () => {
        enginePromise = undefined;
        frame.remove();
        reject(new Error("プレビューの準備に失敗しました"));
      };
      document.body.append(frame);
    });
  }
  return enginePromise;
}

async function compile(source, format) {
  const frame = await engine();
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("プレビューの作成がタイムアウトしました"));
    }, 60000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    frame.contentWindow.postMessage({ source, format }, "*", [channel.port2]);
  });
}

const styles = `
:root{font:16px/1.7 system-ui,sans-serif;color:#202124;background:white;overflow-wrap:anywhere}
body{margin:0}article{max-width:70ch;margin:auto;padding:clamp(12px,3vw,36px)}
h1,h2,h3,h4,h5,h6{line-height:1.35}h2{border-bottom:1px solid #d9dce1;padding-bottom:.2em}
img,svg{max-width:100%;height:auto}pre{overflow:auto;background:#f3f4f6;padding:.8rem}
code{font-family:monospace}blockquote{border-inline-start:.25em solid #bbb;padding-inline-start:1em;margin-inline-start:0}
table{border-collapse:collapse}td,th{border:1px solid #babfc5;padding:.25em .55em}
details a{display:block;color:#245c9b}summary{cursor:pointer}figure{margin:1rem 0;overflow:auto}
body.diagram{display:grid;min-height:100vh;place-content:center}body.diagram article{padding:0;max-width:none}
body.diagram svg{display:block;width:95vw;height:95vh;max-width:none!important}
`;

function toDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function zoomable(frame) {
  const wrap = document.createElement("section");
  wrap.style.cssText = "height:100%;min-height:260px;display:flex;flex-direction:column";
  const controls = document.createElement("div");
  controls.style.cssText = "display:flex;gap:6px;align-items:center;padding:4px";
  const view = document.createElement("div");
  view.style.cssText = "flex:1;overflow:auto;touch-action:none;cursor:grab;min-height:0";
  const value = document.createElement("output");
  let zoom = 1;
  function scale(multiplier) {
    zoom = Math.min(8, Math.max(.5, zoom * multiplier));
    frame.style.width = frame.style.height = (zoom * 100) + "%";
    value.textContent = Math.round(zoom * 100) + "%";
  }
  for (const [label, factor] of [["縮小", .8], ["拡大", 1.25]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.onclick = () => scale(factor);
    controls.append(button);
  }
  controls.append(value);
  scale(1);
  frame.style.pointerEvents = "none";
  let drag;
  view.onpointerdown = e => {
    if (e.button !== 0) return;
    view.setPointerCapture(e.pointerId);
    drag = [e.clientX, e.clientY, view.scrollLeft, view.scrollTop];
  };
  view.onlostpointercapture = () => { drag = null; };
  view.onpointermove = e => {
    if (drag) view.scrollTo(drag[2] + drag[0] - e.clientX, drag[3] + drag[1] - e.clientY);
  };
  view.append(frame);
  wrap.append(controls, view);
  return wrap;
}

export async function renderMarkup(container, format, source, { resolveImage } = {}) {
  const kind = ({ md: "markdown", markdown: "markdown", mmd: "mermaid", mermaid: "mermaid",
    adoc: "adoc", asciidoc: "adoc" })[format];
  if (!kind) throw new Error("未対応の文書形式です");
  const result = await compile(source, kind);
  let html = result.html;
  if (resolveImage) {
    for (const { id, path } of result.images) {
      let image;
      try {
        image = await resolveImage(path);
        if (typeof image === "string" && image.startsWith("blob:")) image = await (await fetch(image)).blob();
      } catch { continue; }
      if (!(image instanceof Blob) || !/^image\/(png|jpeg|webp|avif|gif)$/i.test(image.type)) continue;
      const data = await toDataURL(image);
      html = html.replace('data-local-image="' + id + '"', 'src="' + data + '"');
    }
  }
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "");
  frame.title = kind === "mermaid" ? "Mermaid 図" : "文書プレビュー";
  frame.style.cssText = "display:block;border:0;width:100%;height:100%;min-height:260px;background:white";
  frame.srcdoc = '<!doctype html><html lang="ja"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; form-action \'none\'; base-uri \'none\'"><style>' +
    styles + '</style><body class="' + (kind === "mermaid" ? "diagram" : "") + '">' + html + '</body></html>';
  container.replaceChildren(kind === "mermaid" ? zoomable(frame) : frame);
}
