const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path=require('path'),fs=require('fs'),assert=require('assert');
// 収集編集と検査の保存を、専用プロファイルで確認する回帰試験。
(async()=>{
fs.mkdirSync(path.resolve(__dirname,'../logs'),{recursive:true});
const ext=path.resolve(__dirname,'../../src');
const ctx=await chromium.launchPersistentContext(path.join(require('os').tmpdir(),'seihon-collection-test-'+Date.now()),{headless:true,ignoreDefaultArgs:['--disable-extensions'],executablePath:process.env.CHROMIUM_EXECUTABLE || undefined,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`],viewport:{width:1100,height:700}});
try{
console.log('LAUNCHED');const page=await ctx.newPage();page.setDefaultTimeout(20000);page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text())});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/viewer/viewer.html');
await page.waitForSelector('#shCollectEdit',{state:'attached'});console.log('BOOT');
await page.evaluate(async()=>{
 const {CollectionEditor}=await import('./ui/collection-editor.js');
 const open=CollectionEditor.prototype.open;
 CollectionEditor.prototype.open=async function(){window.editor=this;return open.call(this)};
 const db=await import('../common/db.js');window.db=db;
 const {PDFDocument,degrees,rgb}=await import('../lib/pdf-lib.esm.min.js');
 const doc=await PDFDocument.create();
 let p=doc.addPage([400,600]);p.drawText('FIRST VECTOR TEXT',{x:40,y:400,size:22});p.drawRectangle({x:40,y:60,width:130,height:90,color:rgb(1,0,0)});
 p=doc.addPage([500,300]);p.drawText('SECOND PAGE',{x:60,y:200,size:20});p.setRotation(degrees(90));p.setCropBox(20,30,450,250);
 const bytes=await doc.save();window.sampleBytes=bytes;
 await db.putPdf({key:'test-doc',name:'Test.pdf',bytes,size:bytes.length,pages:2});
 window.seedIds=await db.addCollectionItems('test-doc','Test.pdf',[{pageIndex:0},{pageIndex:1}]);
});
await page.locator('#shCollect').click();await page.locator('#shCollectEdit').click();
await page.waitForFunction(()=>window.editor&&!editor.busy&&editor.canvas.width>0);
console.log('PASS preview');
let result=await page.evaluate(async()=>{
 const {editedCollectionPdf,cropFromSelection}=await import('./collection-edit.js');
 const {loadPdfFromBytes}=await import('./page-export.js');
 const checks=[];
 for(const rotation of [0,90,180,270]){
  for(const pageIndex of [0,1]){
   const item={pageIndex,edits:{rotation}};
   const full=await loadPdfFromBytes(await editedCollectionPdf(sampleBytes,item));
   const vp=(await full.getPage(1)).getViewport({scale:1});
   const box={x:.1,y:.2,w:.6,h:.5};
   item.edits.crop=cropFromSelection(vp,box);
   const edited=await loadPdfFromBytes(await editedCollectionPdf(sampleBytes,item));
   const p=await edited.getPage(1), actual=p.getViewport({scale:1});
   checks.push({rotation,pageIndex,width:actual.width,height:actual.height,expectedW:vp.width*.6,expectedH:vp.height*.5,text:(await p.getTextContent()).items.map(i=>i.str).join(' ')});
   await full.loadingTask.destroy();await edited.loadingTask.destroy();
  }
 }
 return checks;
});
for(const r of result){assert(Math.abs(r.width-r.expectedW)<.01);assert(Math.abs(r.height-r.expectedH)<.01);}
assert(result.some(r=>r.text.includes('FIRST')));console.log('PASS 8 rotation/CropBox/vector preservation cases');
await page.locator('[data-action=right]').click();await page.waitForFunction(()=>!editor.busy&&editor.item.edits?.rotation===90);
await page.locator('[data-action=crop]').click();await page.waitForFunction(()=>!editor.busy&&editor.cropping&&editor.box);
const bounds=await page.locator('.sh-edit-crop').boundingBox();
await page.mouse.move(bounds.x+bounds.width*.15,bounds.y+bounds.height*.15);
// full selection initially; dragging inside moves full rectangle, so create range via an edge handle
await page.mouse.move(bounds.x+1,bounds.y+1);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.2,bounds.y+bounds.height*.2);await page.mouse.up();
await page.locator('[data-action=apply]').click();await page.waitForFunction(()=>!editor.busy&&editor.item.edits?.crop);
console.log('PASS interactive crop and rotation');
await page.locator('[data-action=duplicate]').click();await page.waitForFunction(()=>!editor.busy&&editor.collection.count===3);
await page.locator('[data-action=reset]').click();await page.waitForFunction(()=>!editor.busy&&Object.keys(editor.item.edits).length===0);
assert(await page.evaluate(()=>editor.collection.items.some(i=>i.id!==editor.selected&&i.edits?.crop)));
console.log('PASS independent duplication/reset');
await page.evaluate(async()=>{
 const c=document.createElement('canvas');c.width=120;c.height=80;c.getContext('2d').fillRect(0,0,120,80);
 const png=await new Promise(r=>c.toBlob(r));window.imageFile=new File([png],'Added.png',{type:'image/png'});
 await editor.addImages([imageFile,imageFile]);
});
assert.equal(await page.evaluate(()=>editor.collection.items.filter(i=>i.sourceType==='image').length),2);
console.log('PASS multi-image import and placement');
const pngData=await page.evaluate(async()=>Array.from(new Uint8Array(await imageFile.arrayBuffer())));
const originalIds=await page.evaluate(()=>editor.collection.items.map(i=>i.id));
await page.locator('#shCollectionEditor input[type=file]').setInputFiles({name:'Picker.png',mimeType:'image/png',buffer:Buffer.from(pngData)});
await page.waitForFunction(()=>!editor.busy&&editor.collection.count===6);
await page.evaluate(async ids=>{await db.removeCollectionItems(editor.collection.items.filter(i=>!ids.includes(i.id)).map(i=>i.id));await editor.collection.refresh()},originalIds);
await page.evaluate(()=>{const dt=new DataTransfer();dt.items.add(imageFile);editor.dialog.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}))});
await page.waitForFunction(()=>!editor.busy&&editor.collection.count===6);
await page.evaluate(async ids=>{await db.removeCollectionItems(editor.collection.items.filter(i=>!ids.includes(i.id)).map(i=>i.id));await editor.collection.refresh()},originalIds);
await page.evaluate(()=>{const dt=new DataTransfer();dt.items.add(imageFile);editor.dialog.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}))});
await page.waitForFunction(()=>!editor.busy&&editor.collection.count===6);
await page.evaluate(async ids=>{await db.removeCollectionItems(editor.collection.items.filter(i=>!ids.includes(i.id)).map(i=>i.id));await editor.collection.refresh()},originalIds);
console.log('PASS file picker, image drop and paste');

await page.screenshot({path:path.resolve(__dirname,'../logs/editor-preview.png')});
const orderBefore=await page.evaluate(()=>editor.collection.items.map(i=>i.id));
const rows=page.locator('#shCollectionEditor ol li');
await rows.last().dragTo(rows.first());
await page.waitForFunction(first=>editor.collection.items[0].id===first,orderBefore.at(-1));
console.log('PASS drag reorder');
await page.evaluate(async ids=>{await db.reorderCollection(ids);await editor.collection.refresh()},orderBefore);

const output=await page.evaluate(async()=>{
 const pages=await editor.collection.collectPages();const bytes=await editor.collection.pageCopy.buildPdf(pages);
 const {loadPdfFromBytes}=await import('./page-export.js');const doc=await loadPdfFromBytes(bytes);
 const results=[];for(let i=1;i<=doc.numPages;i++){const p=await doc.getPage(i),v=p.getViewport({scale:1});results.push([v.width,v.height]);}
 await doc.loadingTask.destroy();const images=await editor.collection.pageCopy.buildImageFiles(pages);
 return {dims:results,images:images.map(i=>i.blob.size),bytes:Array.from(bytes)};
});
assert.equal(output.dims.length,5);assert(output.images.every(n=>n>0));fs.writeFileSync(path.resolve(__dirname,'../logs/edited-test.pdf'),Buffer.from(output.bytes));
console.log('PASS mixed PDF and image output, 5 rendered images');
await page.locator('[data-action=close]').click();await page.reload();await page.waitForSelector('#shCollectEdit',{state:'attached'});console.log('BOOT');
const persisted=await page.evaluate(async()=>{const d=await import('../common/db.js');return d.getCollection()});assert.equal(persisted.length,5);assert(persisted.some(i=>i.edits?.crop));
console.log('PASS reload persistence and old records');
const scan=await page.evaluate(async()=>{
 const {ScanArranger}=await import('./scan/scan-arranger.js');const {loadPdfFromBytes}=await import('./page-export.js');const db=await import('../common/db.js');
 const bytes=await db.getPdfBytes('test-doc');const doc=await loadPdfFromBytes(bytes);
 const make=()=>{
  const a=new ScanArranger({app:{pdfDocument:doc,eventBus:{on(){}}},toast:{},docSource:{key:async()=> 'test-scan-persistence'},getSettings:()=>({scanDebugShow:false}),getCurrent:()=>({}),getDirection:()=> 'ltr'});
  a.base={doc,key:'test-scan-persistence',pageCount:2,scans:Array(2).fill(undefined),previews:Array(2).fill(undefined),bytes};return a;
 };
 const a=make();await a.analyzePage(a.base,0);
 const b=make();b.analyzePageNow=()=>{throw new Error('re-analysis should not run')};
 await b.analyzePage(b.base,0);
 const equal=JSON.stringify(a.base.scans[0])===JSON.stringify(b.base.scans[0]);
 a.worker?.terminate();b.worker?.terminate();await doc.loadingTask.destroy();return {equal,preview:!!b.base.previews[0]};
});assert(scan.equal&&scan.preview);console.log('PASS actual scan analysis restored without re-analysis');
await page.setViewportSize({width:800,height:350});await page.locator('#shCollect').click();
const scroll=await page.locator('#shCollectPanel').evaluate(el=>{el.scrollTop=el.scrollHeight;const foot=el.querySelector('.sh-collect-foot').getBoundingClientRect();return {overflow:el.scrollHeight>el.clientHeight, bottom:foot.bottom, panelBottom:el.getBoundingClientRect().bottom}});
assert(scroll.overflow&&scroll.bottom<=scroll.panelBottom+1);console.log('PASS low-height panel bottom reachable');
assert.deepEqual(errors,[]);console.log('PASS no page errors');
await page.evaluate(async()=>{
 const db=await import('../common/db.js');
 await chrome.storage.local.set({settings:{scanArrange:'off',scanDeskew:'off'}});
 await PDFViewerApplication.open({data:await db.getPdfBytes('test-doc')});
 await PDFViewerApplication.pdfViewer.pagesPromise;
});
assert.equal(await page.evaluate(()=>PDFViewerApplication.pdfDocument.numPages),2);
console.log('PASS main viewer still opens PDF');

fs.writeFileSync(path.resolve(__dirname,'../logs/collection-editor-results.json'),JSON.stringify({checks:result,outputDims:output.dims,scan,scroll,errors},null,2));
}finally{await ctx.close()}
})().catch(e=>{console.error(e);process.exit(1)});




