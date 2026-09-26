"use strict";
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../extension');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function scenario(complete, failDownload=false) {
  const dom=new JSDOM('<body><button id="outside">Outside</button></body>',{url:'https://chatgpt.com/c/test',runScripts:'outside-only'});
  const w=dom.window;
  let calls=0,downloads=0,finish;
  const snapshot={title:'Test',complete,sourceUrl:w.location.href,attachments:[],completion:{reason:complete?null:'Missing turn 12'}};
  w.chrome={runtime:{getManifest:()=>({version:'1.0.0'}),getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(){}},sendMessage(message,cb){
    downloads++;
    if(failDownload){failDownload=false;cb({ok:false,error:{message:'Download interrupted'}});}
    else cb({ok:true,result:{filename:'Test.md'}});
  }}};
  w.ChatGPTExporter={createJobId:()=> 'test-job',artifactFilename:()=> 'Test.md',cancelCollection(){},collectConversation:async()=>{
    calls++;
    await new Promise(resolve=>{finish=resolve;});
    return {snapshot,markdown:'body',options:{}};
  }};
  w.eval(fs.readFileSync(path.join(root,'src/panel-shell.js'),'utf8'));
  w.eval(fs.readFileSync(path.join(root,'panel.js'),'utf8'));
  const button=w.document.getElementById('sp-chat-exporter-export');
  button.click();
  assert.equal(w.document.getElementById('sp-chat-exporter-page-lock').style.display,'block');
  assert.equal(w.document.getElementById('sp-chat-exporter-close').disabled,true);
  const progress=(percent)=>w.document.dispatchEvent(new w.CustomEvent('sp-chat-exporter-progress',{detail:{jobId:'test-job',phase:'Scan',percent}}));
  progress(null);
  assert.equal(w.document.getElementById('sp-chat-exporter-progress-percent').textContent,'');
  progress(28);progress(18);
  assert.equal(w.document.getElementById('sp-chat-exporter-progress-percent').textContent,'28%');
  finish();await tick();
  assert.equal(button.textContent,'Download');
  assert.equal(downloads,complete?1:0);
  assert.equal(w.document.getElementById('sp-chat-exporter-page-lock').style.display,'none');
  assert.equal(w.document.getElementById('sp-chat-exporter-close').disabled,false);
  button.click();await tick();
  assert.equal(calls,1,'Download must reuse the captured result');
  assert.equal(downloads,complete?2:1);
  assert.equal(w.document.getElementById('sp-chat-exporter-page-lock').style.display,'none');
  dom.window.close();
}
(async()=>{
  await scenario(true);
  await scenario(false);
  await scenario(true,true);
  console.log('PASS ChatGPT panel: automatic download, retained retry, visible incomplete result, monotonic progress and unlock after success/failure');
})().catch(error=>{console.error(error);process.exitCode=1;});
