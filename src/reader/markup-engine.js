"use strict";

// Only the embedding extension page can supply a source document and a reply port.
const libraries = new Map();
function load(name, file) {
  if (!libraries.has(name)) {
    libraries.set(name, new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "../vendor/markup/" + name + "/" + file;
      script.onload = resolve;
      script.onerror = () => { libraries.delete(name); reject(new Error(name + " を読み込めませんでした")); };
      document.head.append(script);
    }));
  }
  return libraries.get(name);
}

function mathRules(md) {
  md.inline.ruler.before("escape", "tex-inline", (state, silent) => {
    const start = state.pos;
    if (state.src[start] !== "$" || /\s/.test(state.src[start + 1] || " ")) return false;
    let end = start + 1;
    for (; end < state.posMax; end++) {
      if (state.src[end] === "\n") return false;
      if (state.src[end] === "\\") { end++; continue; }
      if (state.src[end] === "$") break;
    }
    if (end === state.posMax || /\s/.test(state.src[end - 1])) return false;
    if (!silent) state.push("tex-inline", "math", 0).content = state.src.slice(start + 1, end);
    state.pos = end + 1;
    return true;
  });
  md.block.ruler.before("fence", "tex-block", (state, start, limit, silent) => {
    const line = state.getLines(start, start + 1, state.blkIndent, false).trim();
    if (!line.startsWith("$$")) return false;
    let content = line.slice(2);
    let end = start;
    while (!content.trimEnd().endsWith("$$") && end + 1 < limit) {
      end++;
      content += "\n" + state.getLines(end, end + 1, state.blkIndent, false);
    }
    if (!content.trimEnd().endsWith("$$")) return false;
    if (!silent) {
      state.push("tex-block", "math", 0).content = content.trimEnd().slice(0, -2);
      state.line = end + 1;
    }
    return true;
  }, { alt: ["paragraph", "blockquote", "reference", "list"] });
  const math = (tokens, i) => katex.renderToString(tokens[i].content, {
    displayMode: tokens[i].type === "tex-block", output: "mathml", throwOnError: false, trust: false,
  });
  md.renderer.rules["tex-inline"] = math;
  md.renderer.rules["tex-block"] = math;
}

async function diagram(code) {
  await load("mermaid", "mermaid.min.js");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
    flowchart: { htmlLabels: false }, htmlLabels: false });
  const { svg } = await mermaid.render("diagram" + crypto.randomUUID().replaceAll("-", ""), code);
  return svg;
}

async function render(source, format) {
  await load("dompurify", "purify.min.js");
  const article = document.createElement("article");
  if (format === "mermaid") {
    article.innerHTML = await diagram(source);
  } else if (format === "adoc") {
    await load("asciidoctor-core", "asciidoctor.min.js");
    const html = module$build$asciidoctor_browser.default().convert(source, { safe: "secure", standalone: false, attributes: { showtitle: true } });
    article.append(DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true }));
  } else {
    await Promise.all([load("markdown-it", "markdown-it.min.js"), load("katex", "katex.min.js")]);
    const md = markdownit({ html: false });
    mathRules(md);
    article.innerHTML = md.render(source);
    for (const block of article.querySelectorAll("pre > code.language-mermaid")) {
      const figure = document.createElement("figure");
      figure.innerHTML = await diagram(block.textContent);
      block.parentNode.replaceWith(figure);
    }
  }

  // Give headings predictable unique locations, retaining AsciiDoc cross-reference IDs.
  const headings = [...article.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  if (headings.length > 1) {
    const contents = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "目次";
    contents.append(summary);
    headings.forEach((heading, i) => {
      if (!heading.id) heading.id = "section-" + (i + 1);
      const link = document.createElement("a");
      link.href = "#" + encodeURIComponent(heading.id);
      link.textContent = heading.textContent;
      contents.append(link);
    });
    article.prepend(contents);
  }

  const images = [];
  for (const img of article.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src");
    if (/^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(src)) continue;
    img.removeAttribute("src");
    if (!src || /^(?:[a-z][a-z\d+.-]*:|[\\/]|#)/i.test(src)) continue;
    const id = crypto.randomUUID();
    img.setAttribute("data-local-image", id);
    images.push({ id, path: src });
  }
  for (const link of article.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href");
    if (href.startsWith("#")) link.setAttribute("href", "about:srcdoc" + href);
    else link.removeAttribute("href");
  }
  return { html: article.outerHTML, images };
}

addEventListener("message", async event => {
  if (event.source !== parent || !event.ports[0]) return;
  const port = event.ports[0];
  try { port.postMessage(await render(event.data.source, event.data.format)); }
  catch (error) { port.postMessage({ error: String(error.message || error) }); }
  finally { port.close(); }
});
