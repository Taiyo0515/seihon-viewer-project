/** テキスト注釈を実入力し、保存・再表示・再保存の文字サイズと外部描画を確認する。 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');
(async()=>{
 const ext=path.resolve(__dirname,'../../src'),out=path.resolve(__dirname,'../logs/text-annotation');fs.mkdirSync(out,{recursive:true});
 const ctx=await chromium.launchPersistentContext(path.join(os.tmpdir(),'seihon-text-'+Date.now()),{headless:true,ignoreDefaultArgs:['--disable-extensions'],executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`],viewport:{width:1100,height:1050}});
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
 try{
 await page.goto('chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/viewer/viewer.html');await page.waitForFunction(()=>!!window.__seihonViewer);
 await page.evaluate(async()=>{const{saveSettings}=await import('../common/settings.js');await saveSettings({scanArrange:'off',scanDeskew:'off'});const{PDFDocument}=await import('../lib/pdf-lib.esm.min.js');const pdf=await PDFDocument.create();for(let i=0;i<3;i++){const p=pdf.addPage([595,842]);p.drawText(`ANNOTATION TEST ${i+1}`,{x:40,y:790,size:14})}await PDFViewerApplication.open({data:await pdf.save()});await PDFViewerApplication.pdfViewer.pagesPromise;window.v=__seihonViewer;v.book.setMode('single');});
 const cases=[{size:14,scale:1,text:'日本語の注釈 ABC 123\n2行目：電位と電荷'},{size:24,scale:1.5,text:'大きい文字 日本語 αβ Q=CV'},{size:8,scale:.75,text:'Small text 8pt\n小さい文字も保持'}];
 for(let i=0;i<cases.length;i++){
  const c=cases[i];await page.evaluate(({i,c})=>{v.app.page=i+1;v.app.pdfViewer.currentScale=c.scale;}, {i,c});await page.waitForTimeout(350);
  await page.locator('#shTextAnnot').click();await page.getByLabel('文字の大きさ',{exact:true}).selectOption(String(c.size));
  const pg=page.locator(`.page[data-page-number="${i+1}"]`);await pg.click({position:{x:100*c.scale,y:160*c.scale}});
  const edit=page.locator('.freeTextEditor .internal[contenteditable=true]').last();await edit.fill(c.text);await page.keyboard.press('Escape');
  await page.evaluate(()=>v.annotations.setTool(null));
 }
 const first=await page.evaluate(async()=>{const bytes=await v.pageEditor.buildEditedBytes(v.app.pdfDocument);return Array.from(bytes)});
 fs.writeFileSync(path.join(out,'first-save.pdf'),Buffer.from(first));
 async function reopen(bytes){await page.evaluate(async bytes=>{v.pageEditor.annotDirty=false;await v.app.open({data:new Uint8Array(bytes)});await v.app.pdfViewer.pagesPromise;v.book.setMode('single');v.app.pdfViewer.currentScale=1;},bytes);await page.waitForTimeout(400);}
 await reopen(first);
 async function inspect(){return page.evaluate(async()=>{const result=[];for(let n=1;n<=3;n++){const p=await v.app.pdfDocument.getPage(n);const a=(await p.getAnnotations()).filter(a=>a.subtype==='FreeText');result.push(a.map(x=>({contents:x.contentsObj?.str||x.contents,fontSize:x.defaultAppearanceData?.fontSize,rect:x.rect,hasAppearance:x.hasAppearance,appearance:x.defaultAppearanceData})));}return result;});}
 const once=await inspect();assert(once.every(x=>x.length===1),JSON.stringify(once));
 for(let i=0;i<3;i++){assert.equal(once[i][0].contents,cases[i].text);assert(Math.abs(once[i][0].fontSize-cases[i].size)<.01,JSON.stringify(once));}
 console.log('PASS Japanese/multiline/8-14-24pt text survives first save and reopen at different zooms');
 await page.evaluate(()=>{v.app.page=1;});await page.waitForTimeout(250);await page.locator('.page[data-page-number="1"]').screenshot({path:path.join(out,'pdfjs-reopened-p1.png')});
 const second=await page.evaluate(async()=>Array.from(await v.pageEditor.buildEditedBytes(v.app.pdfDocument)));
 fs.writeFileSync(path.join(out,'second-save.pdf'),Buffer.from(second));await reopen(second);assert.deepEqual(await inspect(),once);
 console.log('PASS reopened PDF re-save keeps text, size, rectangle and appearance metadata');
 await page.evaluate(()=>{v.app.page=1;}); await page.waitForTimeout(200);
 await page.locator('#shTextAnnot').click();
 await page.locator('.page[data-page-number="1"] .freeTextEditor').first().dblclick();
 const existing=page.locator('.freeTextEditor .internal[contenteditable=true]').first();
 await existing.fill('再編集した日本語 ABC 123\n2回目も14ptを保持'); await page.keyboard.press('Escape');
 await page.evaluate(()=>v.annotations.setTool(null));
 const third=await page.evaluate(async()=>Array.from(await v.pageEditor.buildEditedBytes(v.app.pdfDocument)));
 fs.writeFileSync(path.join(out,'third-save.pdf'),Buffer.from(third));await reopen(third);
 const thirdInfo=await inspect();assert.equal(thirdInfo[0][0].contents,'再編集した日本語 ABC 123\n2回目も14ptを保持');assert.equal(thirdInfo[0][0].fontSize,14);
 console.log('PASS reopened Japanese text remains editable and retains size after editing and saving again');
 const narrow=await page.evaluate(async bytes=>{
  const{PDFDocument,PDFName,PDFString}=await import('../lib/pdf-lib.esm.min.js');
  const pdf=await PDFDocument.load(new Uint8Array(bytes));const a=pdf.getPage(0).node.Annots().lookup(0);
  const rect=a.lookup(PDFName.of('Rect')).asArray().map(x=>x.asNumber());a.set(PDFName.of('Rect'),pdf.context.obj([rect[0],rect[1],rect[0]+65,rect[1]+30]));
  a.set(PDFName.of('Contents'),PDFString.of('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 narrow annotation'));a.set(PDFName.of('DA'),PDFString.of('/Helv 14 Tf 0 g'));
  const{repairFreeTextAnnotations}=await import('./free-text-appearance.js');return Array.from(await repairFreeTextAnnotations(await pdf.save(),{force:true}));
 },first);
 fs.writeFileSync(path.join(out,'narrow-save.pdf'),Buffer.from(narrow));await reopen(narrow);
 const narrowInfo=await inspect();assert.equal(narrowInfo[0][0].fontSize,14);assert(narrowInfo[0][0].rect[3]-narrowInfo[0][0].rect[1]>30);
 console.log('PASS artificially narrow saved rectangle wraps long ASCII at 14pt rather than shrinking glyphs');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({cases,once,thirdInfo,narrowInfo,errors},null,2));
 }finally{await ctx.close()}
})().catch(e=>{console.error(e);process.exit(1)});
