const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const ext = path.resolve(__dirname, "../../src");
  const ctx = await chromium.launchPersistentContext("", {
    headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--disable-extensions-except=" + ext, "--load-extension=" + ext],
    viewport: {width: 1280, height: 800},
  });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    await page.goto("chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/viewer/viewer.html");
    await page.waitForSelector("#shEmptyOpen");
    const bytes = await page.evaluate(async () => {
      const { PDFDocument, rgb } = await import("../lib/pdf-lib.esm.min.js");
      const pdf = await PDFDocument.create();
      for (const color of [rgb(1,0,0), rgb(0,0,1)]) {
        pdf.addPage([240,300]).drawRectangle({x:0,y:0,width:240,height:300,color});
      }
      Object.defineProperty(navigator, "clipboard", {configurable:true, value:{
        async write(items) { window.capture = await items[0].getType("image/png"); }
      }});
      window.showSaveFilePicker = async () => ({
        name:"clip.png", createWritable:async () => ({write(blob){window.saved=blob;},close(){}})
      });
      return Array.from(await pdf.save());
    });
    const chooser = page.waitForEvent("filechooser");
    await page.click("#shEmptyOpen");
    await (await chooser).setFiles({name:"spread.pdf",mimeType:"application/pdf",buffer:Buffer.from(bytes)});
    await page.click("#shViewMode");
    await page.getByRole("menuitemradio", {name:"見開き", exact:true}).click();
    for (const rtl of [false,true]) {
      if (rtl) await page.click("#shBindDir");
      await page.waitForFunction(rtl => {
        const [a,b] = [1,2].map(n=>document.querySelector('#viewer .page[data-page-number="'+n+'"]')?.getBoundingClientRect());
        return a && b && a.width && b.width && Math.abs(a.y-b.y)<2 && (a.x>b.x) === rtl;
      },rtl);
      const pages = await page.locator("#viewer .page").evaluateAll(nodes => nodes.map(el=>{
        const {left,top}=el.getBoundingClientRect();
        return {x:left+el.clientLeft,y:top+el.clientTop,w:el.clientWidth,h:el.clientHeight};
      }).sort((a,b)=>a.x-b.x));
      const [left,right] = pages;
      const x1=left.x+left.w*.75, x2=right.x+right.w*.25;
      const y1=left.y+left.h*.25, y2=left.y+left.h*.45;
      await page.mouse.click(x2,y1,{button:"right"});
      await page.getByRole("menuitem",{name:"ページの一部分を選択…",exact:true}).click();
      await page.waitForSelector(".sh-region-layer");
      await page.mouse.move(x2,y2); await page.mouse.down();
      await page.mouse.move(x1,y1,{steps:5}); await page.mouse.up();
      await page.click(".sh-region-bar [data-op=copy]");
      await page.waitForFunction(()=>!!window.capture);
      if (!rtl) {
        await page.click(".sh-region-bar [data-op=save]");
        await page.waitForFunction(()=>!!window.saved);
        await page.click(".sh-region-bar [data-op=collect]");
        await page.waitForFunction(()=>__seihonViewer.collection.count===1);
        const clip = await page.evaluate(async () => {
          const copy=new Uint8Array(await capture.arrayBuffer());
          const save=new Uint8Array(await saved.arrayBuffer());
          const {getPdfBytes}=await import("../common/db.js");
          const {loadPdfFromBytes}=await import("./page-export.js");
          const doc=await loadPdfFromBytes(await getPdfBytes(__seihonViewer.collection.items[0].pdfKey));
          try {
            const sheet=await doc.getPage(1), viewport=sheet.getViewport({scale:1});
            const canvas=document.createElement("canvas");
            canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
            const g=canvas.getContext("2d");
            await sheet.render({canvasContext:g,viewport}).promise;
            const sample=x=>[...g.getImageData(canvas.width*x,canvas.height*.5,1,1).data];
            return {left:sample(.25),right:sample(.75),w:viewport.width,h:viewport.height,
              same:copy.length===save.length && copy.every((v,i)=>v===save[i])};
          } finally {await doc.loadingTask.destroy();}
        });
        assert(clip.same);
        assert.deepEqual(clip.left,[255,0,0,255]); assert.deepEqual(clip.right,[0,0,255,255]);
        assert(Math.abs(clip.w-(x2-x1)*240/left.w)<1);
        assert(Math.abs(clip.h-(y2-y1)*300/left.h)<1);
        console.log("PASS saved PNG equals clipboard; collected PDF preserves colors and physical dimensions");
      }
      const result = await page.evaluate(async ()=>{
        const bmp=await createImageBitmap(window.capture); window.capture=null;
        const c=document.createElement("canvas"); c.width=bmp.width;c.height=bmp.height;
        const g=c.getContext("2d");g.drawImage(bmp,0,0);bmp.close();
        const sample = x => [...g.getImageData(c.width*x,c.height*.5,1,1).data];
        return {left:sample(.25),right:sample(.75),w:c.width,h:c.height};
      });
      assert.deepEqual(result.left,rtl?[0,0,255,255]:[255,0,0,255]);
      assert.deepEqual(result.right,rtl?[255,0,0,255]:[0,0,255,255]);
      assert(Math.abs(result.w/result.h-(x2-x1)/(y2-y1))<.06);
      await page.keyboard.press("Escape");
      console.log("PASS",rtl?"RTL":"LTR","spread crop",result.w,result.h);
    }
    await page.click("#shViewMode");
    await page.getByRole("menuitemradio", {name:"単ページ", exact:true}).click();
    await page.setViewportSize({width:1280,height:660});
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      PDFViewerApplication.pdfViewer.currentScale = 1.15;
      PDFViewerApplication.pdfViewer.container.scrollTop = 0;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const [top,bottom] = await page.locator("#viewer .page").evaluateAll(nodes => nodes.map(el => {
      const bounds = el.getBoundingClientRect();
      return {x: bounds.left + el.clientLeft, y: bounds.top + el.clientTop, w: el.clientWidth, h: el.clientHeight};
    }));
    const x = top.x + top.w * .3, y = top.y + top.h * .8;
    await page.click("#shMore");
    await page.getByRole("menuitem",{name:"ページの一部分を選択…",exact:true}).click();
    await page.mouse.move(x,y);
    await page.mouse.down();
    // Continue dragging while scrolling, keeping the start in the first page.
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(() => PDFViewerApplication.pdfViewer.container.scrollTop >= 90);
    const scrolled = await page.locator('#viewer .page[data-page-number="2"]').boundingBox();
    await page.mouse.move(x + top.w * .4,scrolled.y + bottom.h * .2);
    await page.mouse.up();
    await page.click(".sh-region-bar [data-op=copy]");
    await page.waitForFunction(() => !!window.capture);
    const colors = await page.evaluate(async () => {
      const bitmap = await createImageBitmap(window.capture);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap,0,0);
      bitmap.close();
      return [.2,.8].map(y => [...context.getImageData(canvas.width*.5,canvas.height*y,1,1).data]);
    });
    assert.deepEqual(colors, [[255,0,0,255],[0,0,255,255]]);
    console.log("PASS vertical crop across two stacked pages");
  } finally { await ctx.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
