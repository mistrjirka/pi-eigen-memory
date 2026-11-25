import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import {
  buildEigenLearningPrompt, eigenSignalForTool, eigenSignalForUser,
  safeEigenExcerpt, setupEigenLearning,
} from '../../src/handlers/eigen-learning.js';
import type { MemoryConfig } from '../../src/types.js';

const config = {
  reviewEnabled: true,
  eigenLearningEnabled: true,
  eigenLearningMaxChars: 7000,
  eigenLearningCooldownMs: 0,
  llmModelOverride: 'opencode-go/muse-spark-1.3-contributor',
} as MemoryConfig;

describe('Eigen event-driven learner',()=>{
  it('triggers on a non-error 403 result but not a successful HTTP 200',()=>{
    assert.equal(eigenSignalForTool({toolName:'bash',isError:false,content:[{type:'text',text:'GET /incidents 200'}]}),null);
    assert.equal(eigenSignalForTool({toolName:'bash',isError:false,content:[{type:'text',text:'const error = new Error("test");'}]}),null);
    assert.equal(eigenSignalForTool({toolName:'read',isError:false,content:[{type:'text',text:'// HTTP 403 expected in fixture'}]}),null);
    const huge = 'x'.repeat(4_000_000);
    assert.equal(eigenSignalForTool({toolName:'read',isError:false,content:[{type:'text',text:huge}]}),null);
    assert.equal(eigenSignalForTool({toolName:'bash',isError:false,content:[{type:'text',text:huge+' HTTP 403'}]}),null,
      'status beyond the first 1600 characters must not trigger recall');
    const result=eigenSignalForTool({toolName:'bash',isError:false,content:[{type:'text',text:'contact-attribute-metadata status=403 code=0x80040220'}]});
    assert.match(result?.detail??'',/403.*0x80040220/);
  });
  it('does not transfer bearer tokens to the learning model',()=>{
    const result=safeEigenExcerpt('HTTP 403 Authorization: Bearer abcdefgh1234 password=hunter2');
    assert.doesNotMatch(result,/abcdefgh1234|hunter2/);
    assert.match(result,/403/);
  });
  it('captures explicit corrections without treating normal messages as decisions',()=>{
    assert.equal(eigenSignalForUser('How does Dataverse work?',config),null);
    assert.equal(eigenSignalForUser('No, use the permitted contact record endpoint instead.',config)?.kind,'correction');
    assert.equal(eigenSignalForUser('From now on use only existing requirements.',config)?.kind,'decision');
  });
  it('enforces the input budget even for huge sessions and memories',()=>{
    const branch=Array.from({length:1000},(_,i)=>({type:'message',message:{role:i%2?'assistant':'user',content:[{type:'text',text:'test '.repeat(3000)}]}}));
    const s=buildEigenLearningPrompt(branch,[{kind:'error',detail:'403 permission denied'}],['a'.repeat(10000)],3500);
    assert.ok(s.length<=3500);
    assert.match(s,/403 permission denied/);
    assert.doesNotMatch(s,/a{500}/);
  });
  it('does not run periodic jobs and submits a bounded prompt for a real error event',async()=>{
    const tmp=mkdtempSync(join(tmpdir(),'eigen-learning-test-'));
    const db=new DatabaseManager(tmp);
    const h:Record<string,Function[]>={};
    const signals:unknown[]=[];
    const savedReports:unknown[]=[];
    const ctx={
      cwd:join(tmp,'SBHG-Buddy'),
      sessionManager:{getBranch:()=>[
        {type:'message',message:{role:'user',content:[{type:'text',text:'Investigate the Dataverse metadata permissions'}]}},
        {type:'message',message:{role:'assistant',content:[{type:'text',text:'Trying a metadata probe.'}]}},
      ]},
      model:{id:'demo'},
    } as any;
    let resolveSettled!:()=>void;
    const settled=new Promise<void>(resolve=>{resolveSettled=resolve});
    try{
      setupEigenLearning({on:(k:string,fn:Function)=>{(h[k]??=[]).push(fn);return ()=>{};}} as any,
        {} as any,()=>({} as any),config,db,()=> 'SBHG-Buddy',{
          ensureMemoryReady:async()=>{},
          runReview:async(_ctx,_global,_project,options)=>{
            signals.push(options);
            return {ok:true,appliedCount:1};
          },
          writeReport:r=>{savedReports.push(r)},onSettled:resolveSettled,
      });
      assert.equal(h['turn_end'],undefined);
      for(const fn of h['agent_end'])fn({},ctx);
      assert.equal(signals.length,0);
      for(const fn of h['tool_result'])fn({toolName:'bash',isError:false,content:[{type:'text',text:'GET EntityDefinitions => HTTP 403 0x80040220 missing prvReadEntity'}]},ctx);
      for(const fn of h['agent_end'])fn({},ctx);
      await settled;
      assert.equal(signals.length,1);
      const call=signals[0] as {userPrompt:string;systemPrompt:string;config:MemoryConfig;operationLimits:{allowedTargets:string[];maxCount:number}};
      assert.ok(call.userPrompt.length<=7000);
      assert.match(call.userPrompt,/0x80040220/);
      assert.match(call.systemPrompt,/permissions scoped/i);
      assert.match(call.systemPrompt,/Temporary task constraints/i);
      assert.deepEqual(call.operationLimits.allowedTargets,['project','failure']);
      assert.equal(call.operationLimits.maxCount,1);
      assert.equal(call.config.llmModelOverride,'opencode-go/muse-spark-1.3-contributor');
      assert.equal((savedReports[0] as {applied:number}).applied,1);
    }finally{db.close();rmSync(tmp,{recursive:true,force:true});}
  });
});

describe('learning origin controls',()=>{
  it('does not reinterpret delegated task constraints as human preferences',async()=>{
    const tmp=mkdtempSync(join(tmpdir(),'eigen-delegated-'));const db=new DatabaseManager(tmp);const h:Record<string,Function[]>={};let calls=0;
    try{
      setupEigenLearning({on:(k:string,f:Function)=>{(h[k]??=[]).push(f);}} as any,{} as any,{} as any,config,db,'project-a',{env:{PI_SUBAGENT_AGENT_ID:'worker'},runReview:async()=>{calls++;return {ok:true,appliedCount:0};}});
      h.message_end[0]({message:{role:'user',content:'From now on never run native builds for this task.'}});
      h.agent_end[0]({},{});assert.equal(calls,0);
    }finally{db.close();rmSync(tmp,{recursive:true,force:true});}
  });
  it('can disable learning for one role without changing recall or manual tools',()=>{
    const tmp=mkdtempSync(join(tmpdir(),'eigen-disabled-'));const db=new DatabaseManager(tmp);let registered=0;
    try{setupEigenLearning({on:()=>{registered++;}} as any,{} as any,{} as any,{...config,eigenLearningChildEnabled:false},db,'project-a',{env:{PI_SUBAGENT_AGENT_ID:'worker'}});assert.equal(registered,0);}finally{db.close();rmSync(tmp,{recursive:true,force:true});}
  });
});
