/** JPEG などの画像と複数ページ TIFF を表示順に PDF ページにする。 */
async function* tiffPages(file, signal) {
  const worker = new Worker(new URL("./tiff-worker.js", import.meta.url), { type: "module" });
  const read = message => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const stop = () => done(reject, signal.reason);
    const timer = setTimeout(() => done(reject, new Error("TIFF の読み込みに時間がかかりすぎています。")), 90000);
    function done(finish, value) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      worker.onmessage = worker.onerror = null;
      finish(value);
    }
    signal?.addEventListener("abort", stop, { once: true });
    worker.onmessage = ({ data }) => data.error ? done(reject, new Error(data.error)) : done(resolve, data);
    worker.onerror = () => done(reject, new Error("TIFF の読み込みに失敗しました。"));
    worker.postMessage(message);
  });
  try {
    const { count } = await read({ file });
    for (let index = 0; index < count; index++) {
      const { width, height, pixels, orientation } = await read({ index });
      const src = new OffscreenCanvas(width, height);
      src.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), width, height), 0, 0);
      const turn = orientation >= 5 && orientation <= 8;
      const canvas = new OffscreenCanvas(turn ? height : width, turn ? width : height);
      const ctx = canvas.getContext("2d");
      const transforms = {
        2: [-1, 0, 0, 1, width, 0], 3: [-1, 0, 0, -1, width, height], 4: [1, 0, 0, -1, 0, height],
        5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, height, 0],
        7: [0, -1, -1, 0, height, width], 8: [0, -1, 1, 0, 0, width],
      };
      if (transforms[orientation]) { ctx.setTransform(...transforms[orientation]); }
      ctx.drawImage(src, 0, 0);
      src.width = src.height = 1;
      try { yield { blob: await canvas.convertToBlob({ type: "image/png" }), index, count }; }
      finally { canvas.width = canvas.height = 1; }
    }
  } finally { worker.terminate(); }
}

async function* imagePages(file, signal) {
  if (/\.tiff?$/i.test(file.name) || ["image/tiff", "image/tif"].includes(file.type)) {
    yield* tiffPages(file, signal);
    return;
  }
  // アニメーション画像を ImageBitmap にすると、既定の先頭フレームになる。
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    try {
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      yield { blob: await canvas.convertToBlob({ type: "image/png" }), index: 0, count: 1 };
    } finally { canvas.width = canvas.height = 1; }
  } finally { bitmap.close(); }
}

export async function imagesToPdf(files, size, progress, signal) {
  const { PDFDocument } = await import("../lib/pdf-lib.esm.min.js");
  const doc = await PDFDocument.create();
  for (const [i, file] of files.entries()) {
    signal?.throwIfAborted();
    try {
      for await (const { blob, index, count } of imagePages(file, signal)) {
        signal?.throwIfAborted();
        progress(i + 1, files.length, count > 1 ? `（${index + 1} / ${count} ページ）` : "");
        const image = await doc.embedPng(await blob.arrayBuffer());
        const imageScale = Math.min(0.75, 14400 / Math.max(image.width, image.height));
        const paper = size === "a4" ? [595.28, 841.89] : [image.width * imageScale, image.height * imageScale];
        const page = doc.addPage(paper), scaled = image.scaleToFit(...paper);
        page.drawImage(image, { ...scaled, x: (paper[0] - scaled.width) / 2, y: (paper[1] - scaled.height) / 2 });
        await image.embed();
      }
    } catch (e) {
      signal?.throwIfAborted();
      throw new Error(`${file.name} を読み込めませんでした。${e.message || ""}`, { cause: e });
    }
  }
  return new Blob([await doc.save()], { type: "application/pdf" });
}

