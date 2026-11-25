import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { addMemory } from '../../src/store/sqlite-memory-store.js';
import { eigenQueryTerms, pickEigenHints, setupEigenRecall, formatEigenSlowLookupWarning } from '../../src/handlers/eigen-recall.js';

describe('Eigen just-in-time recall',()=>{
  it('does not rank an old permission claim ahead of more recent equivalent evidence',()=>{
    const hints=[
      {content:'Dataverse contact records returned 403 and were inaccessible',created:'2026-09-30',category:null},
      {content:'Dataverse contact records now return 200, but metadata remains 403',created:'2026-11-11',category:null},
    ];
    const result=pickEigenHints(hints,'Dataverse contact records permission',2);
    assert.equal(result[0]?.created,'2026-11-11');
  });
  it('generates scoped messages before a relevant task and appends prior lessons to a failed tool result',async()=>{
    const tmp=mkdtempSync(join(tmpdir(),'eigen-recall-test-'));
    const db=new DatabaseManager(tmp);
    const h:Record<string,Function[]>={};
    const ctx={cwd:join(tmp,'SBHG-Buddy')} as any;
    const previous='Dataverse EntityDefinitions metadata GET returned HTTP 403 0x80040220 missing prvReadEntity. Do not retry denied metadata without permission changes. Ordinary records can still return 200.';
    try{
      addMemory(db,previous,'memory','SBHG-Buddy');
      addMemory(db,'Slopyard-Wars Godot game movement foot collision','memory','slopyard-wars');
      setupEigenRecall({on:(k:string,fn:Function)=>{(h[k]??=[]).push(fn);return ()=>{};}} as any,db,{eigenRecallEnabled:true} as any,()=> 'SBHG-Buddy',{ensureMemoryReady:async()=>{}});
      const before=await h['before_agent_start'][0]({messageType:'user',prompt:'Why did Dataverse metadata EntityDefinitions return 403?',systemPrompt:'ok'},ctx);
      assert.match(before?.message?.content??'',/0x80040220/);
      assert.doesNotMatch(before?.message?.content??'',/Slopyard/);
      const tool={toolName:'bash',isError:true,content:[{type:'text',text:'Dataverse metadata returned 403, code 0x80040220'}]};
      const recalled=await h['tool_result'][0](tool,ctx);
      assert.equal(recalled, undefined, 'the prompt already supplied this note');
      await h['session_compact'][0]();
      const afterCompaction=await h['tool_result'][0]({...tool,content:[{type:'text',text:'Dataverse EntityDefinitions metadata returned 403 after compact'}]},ctx);
      assert.match(afterCompaction.content.at(-1).text,/Do not retry denied metadata/);
      const duplicate=await h['tool_result'][0](tool,ctx);
      assert.equal(duplicate,undefined);
      const neutral=await h['tool_result'][0]({toolName:'bash',isError:false,content:[{type:'text',text:'normal successful HTTP 200'}]},ctx);
      assert.equal(neutral,undefined);
    }finally{db.close();rmSync(tmp,{recursive:true,force:true});}
  });
  it('warns at 150 ms and includes initialization versus lookup time without exposing query data', async () => {
    const tmp=mkdtempSync(join(tmpdir(),'eigen-slow-recall-'));
    const db=new DatabaseManager(tmp);
    const handlers: Record<string, Function[]> = {};
    let now=0;
    const notifications: Array<{message:string;level:string}> = [];
    const timings: Array<{source:string;totalMs:number;initializationMs:number;searchMs:number}> = [];
    const ctx={cwd:join(tmp,'SBHG-Buddy'),ui:{notify:(message:string,level:string)=>notifications.push({message,level})}} as any;
    try {
      addMemory(db,'Dataverse EntityDefinitions metadata HTTP 403 0x80040220 requires prvReadEntity; incident GET 200 works','memory','SBHG-Buddy');
      setupEigenRecall({on:(name:string,fn:Function)=>{(handlers[name]??=[]).push(fn);return ()=>{};}} as any,
        db,{eigenRecallEnabled:true,eigenRecallWarnMs:150} as any,()=> 'SBHG-Buddy',{
          nowMs:()=>now,
          ensureMemoryReady:async()=>{now+=180;},
          onSlowLookup:(timing)=>timings.push(timing),
        });
      const request={messageType:'user',prompt:'Why did Dataverse EntityDefinitions metadata return 403?',systemPrompt:''};
      const result=await handlers['before_agent_start'][0](request,ctx);
      assert.match(result.message.content,/prvReadEntity/);
      assert.equal(notifications.length,1);
      assert.equal(notifications[0].level,'warning');
      assert.match(notifications[0].message,/180 ms.*180 ms initialization.*0 ms search\/ranking/);
      assert.doesNotMatch(notifications[0].message,/EntityDefinitions|prvReadEntity/);
      assert.equal(timings[0].source,'prompt');
      assert.equal(timings[0].totalMs,180);
      // Repeated slow events do not flood the user with warnings.
      await handlers['before_agent_start'][0](request,ctx);
      assert.equal(notifications.length,1);
      now+=5*60*1000;
      const event={toolName:'bash',isError:true,content:[{type:'text',text:'HTTP 403 0x80040220 Dataverse EntityDefinitions metadata'}]};
      await handlers['tool_result'][0](event,ctx);
      assert.equal(notifications.length,2);
      assert.equal(timings[1].source,'tool-result');
    } finally { db.close();rmSync(tmp,{recursive:true,force:true}); }
  });
  it('suppresses warnings when configured threshold is zero', async () => {
    const tmp=mkdtempSync(join(tmpdir(),'eigen-no-warn-'));
    const db=new DatabaseManager(tmp);
    const handlers: Record<string, Function[]> = {};
    let now=0;let notified=0;
    try {
      setupEigenRecall({on:(name:string,fn:Function)=>{(handlers[name]??=[]).push(fn);return ()=>{};}} as any,
        db,{eigenRecallEnabled:true,eigenRecallWarnMs:0} as any,()=> 'SBHG-Buddy',{
          nowMs:()=>now,ensureMemoryReady:async()=>{now+=2000;},
        });
      await handlers['before_agent_start'][0]({messageType:'user',prompt:'Why did Dataverse EntityDefinitions metadata return 403?'},
        {ui:{notify:()=>{notified++;}}});
      assert.equal(notified,0);
    } finally {db.close();rmSync(tmp,{recursive:true,force:true});}
  });
  it('formats latency breakdown without disclosing memory text',()=>{
    const message=formatEigenSlowLookupWarning({source:'tool-result',totalMs:158.7,initializationMs:151.3,searchMs:7.1,thresholdMs:150});
    assert.match(message,/159 ms.*151 ms initialization, 7 ms search\/ranking.*threshold 150 ms/);
  });
  it('limits distinct error searches to three per user turn, then resets',async()=>{
    const tmp=mkdtempSync(join(tmpdir(),'eigen-recall-rate-'));
    const db=new DatabaseManager(tmp);
    const h:Record<string,Function[]>={};
    const ctx={cwd:join(tmp,'SBHG-Buddy')} as any;
    let lookups=0;
    try{
      addMemory(db,'Dataverse EntityDefinitions metadata HTTP 403 0x80040220 missing prvReadEntity, incident records still return 200','memory','SBHG-Buddy');
      setupEigenRecall({on:(k:string,fn:Function)=>{(h[k]??=[]).push(fn);return ()=>{};}} as any,
        db,{eigenRecallEnabled:true,eigenRecallWarnMs:0} as any,()=> 'SBHG-Buddy',{ensureMemoryReady:async()=>{lookups++;}});
      const before={messageType:'user',prompt:'Investigate Dataverse EntityDefinitions metadata 403'};
      await h['before_agent_start'][0](before,ctx);
      const error=(id:number)=>({toolName:'bash',isError:true,content:[{type:'text',text:`Dataverse EntityDefinitions metadata returned HTTP 403 0x80040220 error-${id}`}]});
      for(let i=0;i<3;i++){
        const result=await h['tool_result'][0](error(i),ctx);
        assert.equal(result,undefined,'already supplied note is not repeated');
      }
      assert.equal(lookups,4);
      assert.equal(await h['tool_result'][0](error(3),ctx),undefined);
      assert.equal(lookups,4);
      await h['before_agent_start'][0](before,ctx);
      await h['tool_result'][0](error(3),ctx);
      assert.equal(lookups,6);
    }finally{db.close();rmSync(tmp,{recursive:true,force:true});}
  });
  it('ignores generic no-context prompts',()=>{
    assert.deepEqual(eigenQueryTerms('Can you help?'),['help']);
  });
});
