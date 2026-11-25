/** Offline actual-hook evaluation. Synthetic facts only; no provider request or production write. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseManager } from '../src/store/db.js';
import { addMemory } from '../src/store/sqlite-memory-store.js';
import { setupEigenRecall, type RecallDiagnostic } from '../src/handlers/eigen-recall.js';
const directory=mkdtempSync(join(tmpdir(),'eigen-recall-eval-'));
const db=new DatabaseManager(directory);
const handlers:Record<string,Function[]>={};
const ctx:any={cwd:directory,ui:{notify:()=>{}},sessionManager:{getBranch:()=>[],getSessionId:()=> 'offline'}};
const diagnostics:RecallDiagnostic[]=[];
const cases=[
  {prompt:'Fresh agent. Repo /home/example/projects/packing. Resolve K4 schedule from Adam layout; host-only, no NPU.',need:'four lanes',reject:'reboot'},
  {prompt:'K4',need:'four lanes',reject:'reboot'},
  {prompt:'403',need:'metadata',reject:'global'},
  {prompt:'Does ordinary record access follow the metadata denial?',need:'metadata',reject:'reboot'},
  {prompt:'Fresh agent. Repo /home/example/projects/packing.',need:undefined,reject:undefined},
  {prompt:'Explain volcano ash pressure.',need:undefined,reject:undefined},
  {prompt:'Recover global credentials.',need:undefined,reject:undefined},
];
try{
  addMemory(db,'K4 schedule packs four lanes from Adam layout records.','memory','fixture');
  addMemory(db,'HTTP 403 metadata denial does not imply ordinary record access denial.','memory','fixture');
  addMemory(db,'Fresh agent resume old implementer repo /home/example/projects. Reboot a wedged NPU.','memory','fixture');
  addMemory(db,'Native rebuild timeout approval was specific to an old task.','memory','fixture');
  addMemory(db,'K4 global credentials must never be a project match.');
  setupEigenRecall({on:(name:string,fn:Function)=>{(handlers[name]??=[]).push(fn);}} as any,db,{eigenRecallEnabled:true,eigenRecallWarnMs:0} as any,()=> 'fixture',{env:{},onDiagnostic:d=>diagnostics.push(d)});
  const results=[];
  for(const entry of cases){
    const before=diagnostics.length;const started=performance.now();
    const result=await handlers.before_agent_start[0]({messageType:'user',prompt:entry.prompt},ctx);
    const text=result?.message?.content??'';const elapsedMs=performance.now()-started;
    if(entry.need)assert.ok(text.includes(entry.need));else assert.equal(text,'');
    if(entry.reject)assert.ok(!text.includes(entry.reject));
    results.push({matched:Boolean(text),chars:text.length,elapsedMs:Number(elapsedMs.toFixed(3)),selected:diagnostics.length>before?diagnostics.at(-1)?.selected.map(n=>n.id):[]});
  }
  const elapsed=results.map(r=>r.elapsedMs).sort((a,b)=>a-b);
  console.log(JSON.stringify({fixtureCases:cases.length,passed:results.length,modelRequests:0,characterCountsOnly:true,p50Ms:elapsed[Math.floor(elapsed.length/2)],maxMs:elapsed.at(-1),results},null,2));
}finally{db.close();rmSync(directory,{recursive:true,force:true});}
