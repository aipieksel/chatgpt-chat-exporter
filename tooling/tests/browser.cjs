"use strict";
const {chromium}=require('playwright');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../extension');
(async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    for(const loading of [false,true]) {
      const page=await browser.newPage({viewport:{width:1100,height:850}});
      await page.setContent('<main id="main" style="height:500px;overflow:auto"><div data-turn-id-container="client-created-root"></div></main>');
      await page.evaluate((loading)=>{
        const root=document.querySelector('main');
        for(let n=1;n<=14;n++) {
          const slot=document.createElement('div');
          slot.dataset.turnIdContainer=n===12?'85a7eadf-5267-428e-b295-f7a9d5397e39':'turn-'+n;
          slot.dataset.isIntersecting='true';
          if(n!==12)slot.innerHTML=`<section data-turn-id="turn-${n}" data-testid="conversation-turn-${n}" style="height:160px"><div data-message-author-role="${n%2?'user':'assistant'}"><p>Original body ${n}</p><time datetime="2026-09-10T18:12:34Z">18:12</time></div></section>`;
          else if(loading)slot.innerHTML='<div role="progressbar">Loading response</div>';
          root.append(slot);
        }
      },loading);
      for(const name of ['contracts','filename','markdown','attachments','turn-normalizer','chatgpt-adapter'])await page.addScriptTag({path:path.join(root,'src',name+'.js')});
      const result=await page.evaluate(async()=>{
        ChatGPTExporter.LIMITS={...ChatGPTExporter.LIMITS,settleMs:40,historySettleMs:40};
        const progress=[];
        document.addEventListener('sp-chat-exporter-progress',e=>progress.push(e.detail));
        const result=await ChatGPTExporter.collectConversation({jobId:'fixture-job',includeTimestamps:true});
        return {...result,progress};
      });
      assert.equal(result.snapshot.complete,!loading);
      if(!loading) {
        const turn=result.snapshot.turns.find(t=>t.turnNumber===12);
        assert.equal(turn.turnId,'85a7eadf-5267-428e-b295-f7a9d5397e39');
        assert.equal(turn.role,'unknown');
        assert.match(result.markdown,/## Unknown author - Turn 12/);
        assert.match(turn.markdown,/renders no message content/);
        assert.equal(result.snapshot.turns.length,14);
      } else assert.deepEqual(result.snapshot.completion.gaps,[12]);
      for(let n=1;n<=14;n++)if(n!==12)assert.match(result.snapshot.turns.find(t=>t.turnNumber===n).markdown,new RegExp('Original body '+n));
      const history=result.progress.filter(e=>['Finding the latest turn','Loading earlier turns'].includes(e.phase));
      assert.ok(history.length);assert.ok(history.every(e=>e.percent===null));
      const percentages=result.progress.filter(e=>typeof e.percent==='number').map(e=>e.percent);
      assert.ok(percentages.every((p,i)=>i===0||p>=percentages[i-1]));
      await page.close();
      console.log(`PASS ChatGPT rendered-slot ${loading?'unresolved loading remains incomplete':'stable empty turn preserved'}; full neighboring content, timestamps and progress`);
    }
    const cold=await browser.newPage({viewport:{width:1100,height:850}});
    await cold.setContent('<main id="main" style="height:500px;overflow:auto"></main>');
    await cold.evaluate(()=>{
      const root=document.querySelector('main');
      let start=28,armed=true,reflows=0;
      const render=()=>{
        root.innerHTML='<div data-turn-id-container="client-created-root" data-is-intersecting="true"></div>';
        for(let actual=start+1;actual<=38;actual++){
          const slot=document.createElement('div');slot.dataset.turnIdContainer='real-'+actual;slot.dataset.isIntersecting='true';
          slot.innerHTML=`<section data-turn-id="real-${actual}" data-testid="conversation-turn-${actual-start}" style="height:200px"><div data-message-author-role="${actual%2?'user':'assistant'}"><p>Original message ${actual}</p></div>${actual===start+1?'<button>Show more</button>':''}</section>`;
          root.append(slot);
        }
        const estimate=document.createElement('div');estimate.id='virtual-height-estimate';root.append(estimate);
      };
      render();
      root.addEventListener('scroll',()=>{
        const sentinel=root.firstElementChild;
        if(root.scrollTop>1000){armed=true;sentinel.dataset.isIntersecting='false';}
        if(root.scrollTop===0){
          sentinel.dataset.isIntersecting='true';
          if(armed){
            armed=false;
            if(start>0)start=Math.max(0,start-10);
            render();
            document.getElementById('virtual-height-estimate').style.height=(++reflows*3)+'px';
          }
        }
      });
    });
    for(const name of ['contracts','filename','markdown','attachments','turn-normalizer','chatgpt-adapter'])await cold.addScriptTag({path:path.join(root,'src',name+'.js')});
    const result=await cold.evaluate(async()=>{
      ChatGPTExporter.LIMITS={...ChatGPTExporter.LIMITS,settleMs:40,historySettleMs:40,maxLoadCycles:100};
      return await ChatGPTExporter.collectConversation({jobId:'cold-load-fixture'});
    });
    assert.equal(result.snapshot.complete,true);
    assert.deepEqual(result.snapshot.turns.map(t=>t.turnId),Array.from({length:38},(_,i)=>'real-'+(i+1)));
    assert.equal(result.snapshot.turns[0].markdown,'Original message 1');
    await cold.close();
    console.log('PASS cold history: three overscan-gated prepends and changing virtual height; all 38 actual identities retained within 100 cycles');
    const dates=await browser.newPage({timezoneId:'Africa/Johannesburg'});
    await dates.clock.install({time:new Date('2026-09-10T22:20:00Z')});
    await dates.setContent('<main><div data-turn-id-container="dated"><div role="separator" aria-label="Yesterday 8:42 PM"></div><section data-turn-id="dated" data-testid="conversation-turn-1"><div data-message-author-role="user">Original dated message</div></section><section data-turn-id="reply" data-testid="conversation-turn-2"><div data-message-author-role="assistant">No separate timestamp</div></section></div></main>');
    for(const name of ['contracts','filename','markdown','attachments','turn-normalizer'])await dates.addScriptTag({path:path.join(root,'src',name+'.js')});
    const timestamp=await dates.evaluate(()=>{
      const section=document.querySelector('section');
      const actual=ChatGPTExporter.normalizeTurnSection(section).timestamp;
      const reply=ChatGPTExporter.normalizeTurnSection(section.nextElementSibling).timestamp;
      section.previousElementSibling.ariaLabel='Wednesday 2:16 PM';
      const weekday=ChatGPTExporter.normalizeTurnSection(section).timestamp;
      section.parentElement.dataset.turnIdContainer='another-message';
      return {actual,reply,weekday,mismatch:ChatGPTExporter.normalizeTurnSection(section).timestamp};
    });
    assert.equal(timestamp.actual.value,'2026-09-10T18:42:00.000Z');
    assert.equal(timestamp.reply,null);
    assert.equal(timestamp.weekday.value,null);
    assert.equal(timestamp.weekday.label,'Wednesday 2:16 PM');
    assert.equal(timestamp.mismatch,null);
    await dates.close();
    console.log('PASS adjacent timestamps: local midnight rollover, exact message association, weekday label without a guessed date, no inherited reply timestamp');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
