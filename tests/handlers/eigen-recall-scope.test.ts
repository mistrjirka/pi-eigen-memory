import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { addMemory } from '../../src/store/sqlite-memory-store.js';
import { setupEigenRecall, eigenQueryTerms, type RecallDiagnostic } from '../../src/handlers/eigen-recall.js';
import { memoryFingerprint, type MemoryEvidence } from '../../src/memory-evidence.js';

function fixture(config:Record<string,unknown>={},env:NodeJS.ProcessEnv={}) {
  const dir=mkdtempSync(join(tmpdir(),'eigen-scope-'));const db=new DatabaseManager(dir);
  const handlers:Record<string,Function[]>={},commands:Record<string,any>={},entries:any[]=[],diagnostics:RecallDiagnostic[]=[];
  const ctx:any={cwd:dir,ui:{notify:()=>{}},sessionManager:{getBranch:()=>entries,getSessionId:()=> 'session-one'}};
  let lookups=0;
  setupEigenRecall({on:(name:string,fn:Function)=>{(handlers[name]??=[]).push(fn);},registerCommand:(name:string,def:any)=>{commands[name]=def;}} as any,db,{eigenRecallEnabled:true,eigenRecallWarnMs:0,...config} as any,()=> 'project-a',{env,ensureMemoryReady:async()=>{lookups++;},onDiagnostic:d=>diagnostics.push(d)});
  const add=(content:string,evidence?:MemoryEvidence,project='project-a')=>addMemory(db,content,'memory',project,null,null,null,null,'2026-11-25','2026-11-25',evidence);
  const request=async(prompt:string)=>{entries.push({type:'message',id:'user-'+entries.length,message:{role:'user',content:prompt}});const r=await handlers.before_agent_start[0]({messageType:'user',prompt},ctx);if(r?.message)entries.push({type:'custom_message',...r.message});return r?.message?.content as string|undefined;};
  return {db,add,request,ctx,handlers,commands,entries,diagnostics,lookups:()=>lookups,close:()=>{db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('whole task preserves K4, short record IDs and numeric errors, ignores launch/path noise',()=>{
  const terms=eigenQueryTerms('Fresh agent (do not resume old implementers). Repo /home/example/projects/packing-demo. Read K4 F D Adam schedule mapping after HTTP 403.');
  for(const term of ['k4','f','d','adam','schedule','403'])assert.ok(terms.includes(term),term);
  for(const term of ['fresh','agent','resume','implementer','home','example','projects'])assert.ok(!terms.includes(term),term);
});
test('actual recall selects schedule evidence and abstains from generic task boilerplate',async()=>{
  const f=fixture();try{
    f.add('Fresh agent resume implementer repo /home/example/projects. Recover the old child and reboot a wedged NPU.');
    f.add('Native rebuild timeout authorization is project-specific.');
    f.add('K4 requires a reboot after a wedged NPU.');
    f.add('K4 schedule packs four lanes from Adam layout records without another tensor pass.');
    const output=await f.request('Fresh agent. Repo /home/example/projects/packing-demo. Work host-only, no NPU. Resolve K4 schedule packing from Adam layout records.');
    assert.match(output??'',/four lanes/);assert.doesNotMatch(output??'',/reboot|timeout authorization/);
    assert.equal(await f.request('Fresh agent. Repo /home/example/projects/packing-demo.'),undefined);
  }finally{f.close();}
});
test('403-only query can retrieve the exact error and excludes global/other project notes',async()=>{
  const f=fixture();try{
    f.add('HTTP 403 metadata requires scoped authorization.');
    f.add('HTTP 403 from another project is not applicable.',undefined,'project-b');
    addMemory(f.db,'HTTP 403 global note');
    const output=await f.request('403');assert.match(output??'',/scoped authorization/);assert.doesNotMatch(output??'',/another project|global note/);
  }finally{f.close();}
});
test('same note is suppressed only while present, then returns after compaction drops it',async()=>{
  const f=fixture();try{
    f.add('K4 schedule has four lanes.');
    const first=await f.request('Check K4 schedule');assert.ok(first);
    assert.equal(await f.request('Check K4 schedule again'),undefined);
    f.entries.splice(0,f.entries.length,{type:'compaction',summary:'Unrelated checkpoint.'});await f.handlers.session_compact[0]();
    assert.ok(await f.request('Check K4 schedule'));
    f.entries.splice(0,f.entries.length,{type:'compaction',summary:first});await f.handlers.session_compact[0]();
    assert.equal(await f.request('Check K4 schedule'),undefined);
  }finally{f.close();}
});
test('notes already appended to tool results are not repeated',async()=>{
  const f=fixture();try{
    f.add('K4 schedule has four lanes.');await f.request('Investigate unrelated volcano pressure');
    const error={toolName:'bash',isError:true,content:[{type:'text',text:'K4 schedule failed HTTP 403'}]};
    const result=await f.handlers.tool_result[0](error,f.ctx);assert.ok(result);
    f.entries.push({type:'message',message:{role:'toolResult',content:result.content}});
    assert.equal(await f.request('K4 schedule'),undefined);
  }finally{f.close();}
});
test('explicit supersession suppresses the old fact while branch-specific records remain scoped',async()=>{
  const f=fixture();try{
    const old='K4 schedule uses eight lanes.';f.add(old);
    f.add('K4 schedule uses four lanes.',{origin:'observation',scope:'project',supersedes:[memoryFingerprint(old)]});
    f.add('K4 schedule uses sixteen lanes on another branch.',{origin:'observation',scope:'branch',branch:'other'});
    const output=await f.request('K4 schedule');assert.match(output??'',/four lanes/);assert.doesNotMatch(output??'',/eight lanes|sixteen lanes/);
    assert.ok(f.diagnostics.at(-1)?.excluded.some(e=>e.reason==='superseded'));
  }finally{f.close();}
});
test('task-local observations do not cross session boundaries',async()=>{
  const f=fixture();try{f.add('K4 schedule temporary permission.',{origin:'delegated',scope:'task',sessionId:'another-session'});assert.equal(await f.request('K4 schedule'),undefined);}finally{f.close();}
});
for(const role of ['main','child'] as const)test(role+' opt-out prevents initialization and automatic recall',async()=>{
  const f=fixture({[role==='main'?'eigenRecallMainEnabled':'eigenRecallChildEnabled']:false},role==='child'?{PI_SUBAGENT_AGENT_ID:'child-one'}:{});
  try{f.add('K4 schedule has four lanes.');assert.equal(await f.request('K4 schedule'),undefined);assert.equal(f.lookups(),0);}finally{f.close();}
});
test('session opt-out is independent, diagnostics are read-only and report reasons',async()=>{
  const f=fixture();try{
    f.add('K4 schedule has four lanes.');await f.commands['memory-recall'].handler('off',f.ctx);assert.equal(await f.request('K4 schedule'),undefined);
    const before=f.entries.length;await f.commands['memory-recall'].handler('diagnose K4 schedule',f.ctx);
    assert.equal(f.entries.length,before);assert.ok(f.diagnostics.at(-1)?.selected.length);assert.equal(f.diagnostics.at(-1)?.chars!>0,true);
    await f.commands['memory-recall'].handler('on',f.ctx);assert.ok(await f.request('K4 schedule'));
  }finally{f.close();}
});
test('prompt and tool evidence share one character budget',async()=>{
  const f=fixture({eigenRecallBudgetChars:700});try{
    f.add('K4 schedule has four lanes.');f.add('HTTP 403 metadata access is denied.');
    const first=await f.request('K4 schedule');let total=first?.length??0;
    const second=await f.handlers.tool_result[0]({toolName:'bash',isError:true,content:[{type:'text',text:'HTTP 403 metadata access'}]},f.ctx);
    if(second)total+=second.content.at(-1).text.length-1;
    assert.ok(total<=700);assert.equal(f.diagnostics.at(-1)?.remainingChars,700-total);
  }finally{f.close();}
});

test('lazy first recall initializes before resolving its project',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'eigen-lazy-scope-'));const db=new DatabaseManager(dir);
  let boundProject:string|null=null,lookups=0;
  const handlers:Record<string,Function>={};const diagnostics:RecallDiagnostic[]=[];
  const ctx:any={cwd:dir,ui:{notify:()=>{}},sessionManager:{getBranch:()=>[],getSessionId:()=> 'lazy-session'}};
  try {
    addMemory(db,'K4 schedule has four lanes.','memory','project-a');
    setupEigenRecall({on:(name:string,fn:Function)=>{handlers[name]=fn;}} as any,db,{eigenRecallEnabled:true,eigenRecallWarnMs:0} as any,()=>boundProject,{
      ensureMemoryReady:async()=>{lookups++;boundProject='project-a';},onDiagnostic:d=>diagnostics.push(d),
    });
    assert.equal(await handlers.before_agent_start({messageType:'user',prompt:'Hello'},ctx),undefined);
    assert.equal(lookups,0,'generic prompts remain lazy');
    const output=await handlers.before_agent_start({messageType:'user',prompt:'K4 schedule'},ctx);
    assert.equal(lookups,1);assert.match(output?.message?.content??'',/four lanes/);
    assert.equal(diagnostics.at(-1)?.scope,'project-a');
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
test('recall refreshes project scope after cwd changes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'eigen-cwd-scope-'));const db=new DatabaseManager(dir);
  let boundProject='project-a';const handlers:Record<string,Function>={};const diagnostics:RecallDiagnostic[]=[];
  const ctx:any={cwd:join(dir,'project-a'),ui:{notify:()=>{}},sessionManager:{getBranch:()=>[],getSessionId:()=> 'switch-session'}};
  try {
    addMemory(db,'K4 schedule has four lanes in project-a.','memory','project-a');
    addMemory(db,'K4 schedule has eight lanes in project-b.','memory','project-b');
    setupEigenRecall({on:(name:string,fn:Function)=>{handlers[name]=fn;}} as any,db,{eigenRecallEnabled:true,eigenRecallWarnMs:0} as any,()=>boundProject,{
      ensureMemoryReady:async(c)=>{boundProject=c.cwd.endsWith('project-b')?'project-b':'project-a';},onDiagnostic:d=>diagnostics.push(d),
    });
    const first=await handlers.before_agent_start({messageType:'user',prompt:'K4 schedule'},ctx);
    assert.match(first?.message?.content??'',/four lanes/);assert.doesNotMatch(first?.message?.content??'',/eight lanes/);
    ctx.cwd=join(dir,'project-b');
    const second=await handlers.before_agent_start({messageType:'user',prompt:'K4 schedule'},ctx);
    assert.match(second?.message?.content??'',/eight lanes/);assert.doesNotMatch(second?.message?.content??'',/four lanes/);
    assert.equal(diagnostics.at(-1)?.scope,'project-b');
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
