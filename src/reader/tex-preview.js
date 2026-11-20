// Render the selected page from a compiled PDF, preserving the page across recompiles.
export async function showCompiledPdf(container, blob, initialPage) {
  const pdfjs = await import("../pdfjs/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdfjs/build/pdf.worker.mjs");
  const task = pdfjs.getDocument({data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported:false,
    cMapUrl:chrome.runtime.getURL("pdfjs/web/cmaps/"), cMapPacked:true,
    standardFontDataUrl:chrome.runtime.getURL("pdfjs/web/standard_fonts/")});
  try {
    const pdf = await task.promise;
    const back = document.createElement("button"), next = document.createElement("button");
    const label = document.createElement("span"), area = document.createElement("div");
    back.textContent = "前のページ"; next.textContent = "次のページ";
    container.classList.add("tex-page");
    container.append(back, label, next, area);
    let pageNo = Math.min(pdf.numPages, initialPage || 1);
    async function draw(number) {
      back.disabled = next.disabled = true;
      try {
        const page = await pdf.getPage(number);
        const vp = page.getViewport({scale:1.6});
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
        await page.render({canvasContext:canvas.getContext("2d"), viewport:vp}).promise;
        area.replaceChildren(canvas);
        pageNo = number; label.textContent = "　" + pageNo + " / " + pdf.numPages + "　";
      } finally {
        back.disabled = pageNo <= 1; next.disabled = pageNo >= pdf.numPages;
      }
    }
    const turn = delta => draw(pageNo + delta).catch(error => { label.textContent = error.message; });
    back.onclick = () => turn(-1); next.onclick = () => turn(1);
    await draw(pageNo);
    return {page:() => pageNo, dispose:() => task.destroy()};
  } catch (error) { await task.destroy(); throw error; }
}
