import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { addMemory } from '../../src/store/sqlite-memory-store.js';
import { eigenQueryTerms, pickEigenHints, setupEigenRecall } from '../../src/handlers/eigen-recall.js';

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
      assert.ok(recalled?.content?.length > tool.content.length);
      assert.match(recalled.content.at(-1).text,/Do not retry denied metadata/);
      const duplicate=await h['tool_result'][0](tool,ctx);
      assert.equal(duplicate,undefined);
      const neutral=await h['tool_result'][0]({toolName:'bash',isError:false,content:[{type:'text',text:'normal successful HTTP 200'}]},ctx);
      assert.equal(neutral,undefined);
    }finally{db.close();rmSync(tmp,{recursive:true,force:true});}
  });
  it('ignores generic no-context prompts',()=>{
    assert.deepEqual(eigenQueryTerms('Can you help?'),['help']);
  });
});
