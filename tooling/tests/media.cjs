"use strict";
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../extension');
async function scenario({protectedFile=false,permission=true,fail=false}={}) {
  const dom=new JSDOM('<iframe src="https://extension.test/media.html?embed=1&job=test-job"></iframe>',{url:'https://chatgpt.com/c/test',runScripts:'outside-only'});
  const w=dom.window.document.querySelector('iframe').contentWindow;
  w.document.open();
  w.document.write(fs.readFileSync(path.join(root,'media.html'),'utf8'));
  w.document.close();
  const messages=[],events=[];
  dom.window.postMessage=message=>events.push(message);
  const job={title:'Test',transcript:'body',snapshotComplete:true,attachments:protectedFile?[{id:'file-1',originalFilename:'test.txt',requiresSelection:true}]:[]};
  w.URL.createObjectURL=()=> 'blob:chrome-extension://test/file';
  w.URL.revokeObjectURL=()=>{};
  w.ChatGPTExporter={
    LIMITS:{mediaConcurrency:2,maxArchiveInputBytes:1000},ERROR_CODES:{},ExportError:Error,
    reconcileSelectedFiles:()=>({matches:[],unusedFileIndexes:[]}),
    optionalOriginsFor:()=>permission?[]:['https://files.oaiusercontent.com/*'],
    applyAttachmentResults:()=> 'body',renderManifest:()=> 'manifest',
    createZipBlob:()=> new w.Blob(['zip']),artifactFilename:()=> 'Test.zip'
  };
  w.chrome={permissions:{contains:(_args,cb)=>cb(permission),request:(_args,cb)=>cb(true)},runtime:{sendMessage(message,cb){
    messages.push(message);
    if(message.type==='GET_ARCHIVE_JOB')cb({ok:true,result:job});
    else if(message.type==='DOWNLOAD_URL'&&fail)cb({ok:false,error:{message:'Interrupted'}});
    else cb({ok:true,result:{filename:'Test.zip',downloadId:1}});
  }}};
  w.eval(fs.readFileSync(path.join(root,'media.js'),'utf8'));
  await new Promise(resolve=>setImmediate(resolve));
  const downloads=messages.filter(message=>message.type==='DOWNLOAD_URL').length;
  assert.equal(downloads,!protectedFile&&permission?1:0);
  assert.equal(events.at(-1).type,'ARCHIVE_BUSY');
  assert.equal(events.at(-1).detail.busy,false,'Terminal or input-required state must unlock page');
  if(fail)assert.match(w.document.querySelector('#sp-archive-status').textContent,/Interrupted/);
  if(!permission){
    w.document.querySelector('#sp-archive-build').click();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(messages.filter(message=>message.type==='DOWNLOAD_URL').length,1);
  }
  dom.window.close();
}
(async()=>{
  await scenario();await scenario({fail:true});await scenario({permission:false});await scenario({protectedFile:true});
  console.log('PASS media: automatic ZIP, user-gesture permission fallback, protected-file wait and unlock after failure');
})().catch(error=>{console.error(error);process.exitCode=1;});
