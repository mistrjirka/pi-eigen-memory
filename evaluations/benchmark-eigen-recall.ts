/** Read-only benchmark of the real eigen-recall hook against the production index.
 * No session or memory data are written. Usage hit counters are not changed.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import Sqlite3 from 'better-sqlite3';
import { setupEigenRecall } from '../src/handlers/eigen-recall.js';
import { eigenSignalForTool } from '../src/handlers/eigen-learning.js';
import type { DatabaseManager } from '../src/store/db.js';

const sqlite = new Sqlite3(join(homedir(),'.pi/agent/pi-hermes-memory/sessions.db'),{readonly:true,fileMustExist:true});
const manager={getDb:()=>sqlite} as DatabaseManager;
const hooks:Record<string,Function[]> = {};
setupEigenRecall({on:(name:string, fn:Function)=>{(hooks[name]??=[]).push(fn);return ()=>{};}} as any,
  manager,{eigenRecallEnabled:true} as any,()=> 'SBHG-Buddy', {ensureMemoryReady:async()=>{}});
const handler=hooks['tool_result']?.[0];
const before=hooks['before_agent_start']?.[0];
if(!handler||!before)throw Error('hook not registered');
const context={cwd:join(homedir(),'programovani/SBHG-Buddy')};
const percentile=(xs:number[],percent:number)=>xs.slice().sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor((xs.length-1)*percent))]??0;
async function measure(label:string, count:number, event:(i:number)=>unknown, reset=false) {
  const times:number[]=[];let injected=0;
  for(let i=0;i<count;i++){
    if(reset) await before({messageType:'user',prompt:'Check Dataverse EntityDefinitions metadata 403 error.'},context);
    const start=performance.now();
    const result=await handler(event(i),context);
    times.push(performance.now()-start);
    if(result?.content?.length>1)injected++;
  }
  console.log(JSON.stringify({label,samples:count,injected,p50_ms:+percentile(times,0.5).toFixed(3),p95_ms:+percentile(times,0.95).toFixed(3),max_ms:+Math.max(...times).toFixed(3)}));
}
try{
 const sample='Dataverse EntityDefinitions metadata status=403 code=0x80040220 missing prvReadEntity';
 await measure('success_bash_short',500,()=>({toolName:'bash',isError:false,content:[{type:'text',text:'Completed successfully in 13ms'}]}));
 await measure('success_bash_1MiB',60,()=>({toolName:'bash',isError:false,content:[{type:'text',text:'x'.repeat(1024*1024)}]}));
 await measure('success_bash_8MiB',15,()=>({toolName:'bash',isError:false,content:[{type:'text',text:'x'.repeat(8*1024*1024)}]}));
 await measure('success_read_8MiB',15,()=>({toolName:'read',isError:false,content:[{type:'text',text:'x'.repeat(8*1024*1024)}]}));
 await measure('first_relevant_error',1,()=>({toolName:'bash',isError:true,content:[{type:'text',text:sample}]}));
 await measure('repeated_same_error',100,()=>({toolName:'bash',isError:true,content:[{type:'text',text:sample}]}));
 await measure('unique_error_single_turn_capped',60,(i)=>({toolName:'bash',isError:true,content:[{type:'text',text:`${sample} unique_event_${i}` }]}));
 await measure('unique_error_first_per_turn',30,(i)=>({toolName:'bash',isError:true,content:[{type:'text',text:`${sample} new_turn_${i}` }]}),true);
 // Explicitly compare successful prompt-time injection; no LLM call occurs.
 const pTimes:number[]=[];let promptsWithHint=0;
 for(let i=0;i<40;i++){
  const start=performance.now(); const hint=await before({messageType:'user',prompt:'Why did the Dataverse EntityDefinitions metadata return 403 0x80040220?'},context);
  pTimes.push(performance.now()-start); if(hint?.message)promptsWithHint++;
 }
 console.log(JSON.stringify({label:'before_agent_start_relevant',samples:pTimes.length,withHint:promptsWithHint,p50_ms:+percentile(pTimes,0.5).toFixed(3),p95_ms:+percentile(pTimes,0.95).toFixed(3),max_ms:+Math.max(...pTimes).toFixed(3)}));
}finally{sqlite.close();}
