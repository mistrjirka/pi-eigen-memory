/**
 * Read-only Dataverse memory quality pilot. Uses a disposable SQLite database.
 * `npx tsx evaluations/dataverse-403.ts` tests the real Hermes search engine.
 * `npx tsx evaluations/dataverse-403.ts --learn` also makes two tool-free
 * model calls to evaluate old/new memory extraction on a sanitized incident.
 */
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseManager } from '../src/store/db.js';
import { addMemory, searchMemories } from '../src/store/sqlite-memory-store.js';
import { DIRECT_REVIEW_SYSTEM_PROMPT } from '../src/constants.js';

const execFileAsync = promisify(execFile);
const project = 'SBHG-Buddy';
const priorHistory = `
[2026-09-30][USER] Diagnose permitted Dataverse ticket ownership access. Read-only, use existing app credentials. Do not retry the metadata endpoint after its 403; ordinary incident records may still work.
[2026-09-30][TOOL] GET EntityDefinitions(LogicalName='incident') => HTTP 403 / 0x80040220 (missing prvReadEntity). GET incidents?$select=incidentid,_customerid_value,_ownerid_value => HTTP 200.
[2026-09-30][ASSISTANT] Data access and metadata access require different privileges. The 403 does not prove incident records are inaccessible. _ownerid_value identifies assignment, not the employee who requested support.
`.trim();
const laterEvidence = `
[2026-11-11][USER] Check whether the previous Dataverse contact access problem is resolved, without bypassing permissions.
[2026-11-11][TOOL] GET incidents => 200. GET contacts (ordinary record access) => 200. GET contact attribute metadata => 403 / 0x80040220 (missing prvReadEntity).
[2026-11-11][ASSISTANT] Prior contact-record 403 is resolved, but entity attribute metadata remains blocked. Do not repeat the denied metadata request without an authorized permission change. Use ordinary ticket/contact records for requester investigation.
`.trim();
const baselineSystem = DIRECT_REVIEW_SYSTEM_PROMPT;
const oldUserPrompt = `--- Current Memory ---\n(empty)\n--- Current User Profile ---\n(empty)\n--- Current Project Memory ---\n(empty)\n--- Conversation to Review ---\n${priorHistory}`;
const proposedSystem = `You extract durable, actionable lessons from a coding agent's recent observations.
Distinguish access to records from access to metadata. When an older failure is resolved, mark the old statement as superseded rather than asserting both states are current. Do not infer permissions you did not verify. Avoid task progress or duplicated facts.
Return a JSON object with an operations array. Each operation has action="add", target="project" or "failure", and a content string describing one atomic fact, date, and observed evidence. If nothing merits storing, return {"operations":[]}. Save only decisions, verified recurring failures and durable tool limits. Limit to 3 operations and 700 total characters of memory content. Do not include personal identifiers.`;
const proposedUserPrompt = `Project: ${project}. Observations available BEFORE the next investigation:\n${priorHistory}`;
const representativeMemories = [
  'Dataverse EntityDefinitions and attribute metadata requests returned HTTP 403 code 0x80040220 (missing prvReadEntity). Do not retry the denied metadata endpoint without authorized privilege changes. Ordinary incident/contact data requests are separate and may be allowed. Verified 2026-11-11.',
  'Dataverse GET incidents and GET contacts returned HTTP 200 on 2026-11-11. The earlier contact-record 403 is no longer current, but attribute metadata still returns HTTP 403.',
  'SBHG-Buddy My Tickets must identify the employee who initiated the ticket. Dataverse _ownerid_value and _createdby_value do not by themselves establish that employee as the requester.',
];
const oldMemory = 'As of 2026-09-30, Dataverse requester contact record GET returned HTTP 403. My Tickets cannot use contact reads yet.';
const fillerMemories = [
  'SBHG-Buddy web ticket review uses governanceReviewer role.',
  'SBHG-Buddy uses pnpm for its backend builds.',
  'SBHG-Buddy mobile app is built using Expo.',
  'SBHG-Buddy policy versions are immutable.',
  'SBHG-Buddy documentation is authoritative for ticket ownership decisions.',
  'SBHG-Buddy Qdrant collection has stable aliases and dimensions.',
  'SBHG-Buddy applies ticket redaction before indexing.',
];
const queries = [
  { name:'exact-code', query:'Dataverse EntityDefinitions 0x80040220', category:'metadata' },
  { name:'metadata-access', query:'Can we inspect contact attribute definitions in Dataverse?', category:'metadata' },
  { name:'permission-alternative', query:'Dynamics CRM incident schema access permissions', category:'metadata' },
  { name:'workflow-task', query:'Need to inspect ticket requester relation to employee identity', category:'ownership' },
  { name:'contact-freshness', query:'Is it still forbidden to fetch contact records from Dataverse?', category:'fresh' },
  { name:'semantic-paraphrase', query:'Check relationship metadata for case customer without extra privilege', category:'metadata' },
] as const;

type Operation = { action?: string; target?: string; content?: string };
function parseOperations(output: string): Operation[] {
  const candidate=output.match(/\{[\s\S]*"operations"\s*:\s*\[[\s\S]*\]\s*\}/)?.[0];
  if(!candidate) return [];
  try {const x=JSON.parse(candidate);return Array.isArray(x.operations)?x.operations:[]}catch{return []}
}
function scoreLearning(memories:string[]){
  const combined=memories.join(' ').toLowerCase();
  const checks={
    capturesMetadata403:/metadata|entitydefinitions|attributes/.test(combined)&&/403|0x80040220/.test(combined),
    doesNotEquateRecordAccess:/records?|contacts?|incidents?/.test(combined)&&/200|allowed|permitted|separate/.test(combined),
    capturesDoNotRetry:/do not retry|avoid|must not retry|should not retry|stop retry/.test(combined),
    claimsFutureContactRecovery:/2026-11-11|now resolved|contact.*200/.test(combined),
  };
  return checks;
}
function runRetrieval(memories:string[], noisy=false){
  const temp=mkdtempSync(join(tmpdir(),'hermes-403-eval-'));
  const db=new DatabaseManager(temp);
  try{
    for(const content of [...(noisy?[oldMemory,...fillerMemories]:[]),...memories])
      addMemory(db,content,'memory',project);
    let ok=0;
    const rows=[];
    for(const q of queries){
      const t0=performance.now();
      const hits=searchMemories(db,q.query,{project,limit:3});
      const text=hits.map(h=>h.content).join(' ');
      const hasForbidden= /metadata|entitydefinitions|attributes/i.test(text)&&/403|0x80040220/i.test(text);
      const hasOwner=/_ownerid_value|_createdby_value/i.test(text)&&/not|do not|cannot|not necessarily/i.test(text)&&/requester|initiated/i.test(text);
      const hasFresh=/2026-11-11/i.test(text)&&/contacts?/i.test(text)&&/200/i.test(text);
      const pass=q.category==='metadata'?hasForbidden:q.category==='ownership'?hasOwner:hasFresh;
      if(pass)ok++;
      rows.push({test:q.name,pass,found:hits.length,top: hits[0]?.content.slice(0,110)??'',ms:Math.round((performance.now()-t0)*10)/10});
    }
    const notProject=searchMemories(db,'Dataverse metadata',{project:'slopyard-wars',limit:3}).length===0;
    const unrelated=searchMemories(db,'Godot UI layout',{project,limit:3}).length===0;
    return {passed:ok,total:queries.length,notProject,unrelated,rows};
  }finally{db.close();rmSync(temp,{recursive:true,force:true});}
}
async function callModel(system:string,user:string){
  const tmpAgent=mkdtempSync(join(tmpdir(),'pi-eigen-model-agent-'));
  for(const name of ['auth.json','models.json']) symlinkSync(join(homedir(),'.pi','agent',name),join(tmpAgent,name));
  const cmd=['--no-extensions','--no-mcp','--no-skills','--no-tools','--no-context-files','--no-session','--mode','text','--model','opencode-go/muse-spark-1.3-contributor','--thinking','off','--system-prompt',system,'-p','--',user];
  const start=performance.now();
  try{const {stdout,stderr}=await execFileAsync('pi',cmd,{timeout:45_000,maxBuffer:1_000_000,env:{...process.env,PI_CODING_AGENT_DIR:tmpAgent}});
    return {elapsedMs:Math.round(performance.now()-start),operations:parseOperations(stdout),raw:stdout.slice(0,1700),error:stderr.slice(0,600)};
  }catch(e){return {elapsedMs:Math.round(performance.now()-start),operations:[],raw:'',error:JSON.stringify({message:String((e as any).message).slice(0,180),stderr:String((e as any).stderr??'').slice(0,240),killed:(e as any).killed,signal:(e as any).signal})} finally {rmSync(tmpAgent,{recursive:true,force:true});}
}
console.log('FIXTURE: two dated, sanitized Dataverse observations, no real credentials or remote API calls');
console.log('MODEL LEARNING: only Sep 30 observations are provided; Nov 11 evidence is held out.');
for(const [name,memories] of [['ideal',representativeMemories],['stale+ideal',representativeMemories]] as const){
  const result=runRetrieval(memories,name==='stale+ideal');
  console.log('\nRETRIEVAL '+name+' '+result.passed+'/'+result.total+' cross-project='+result.notProject+' unrelated='+result.unrelated);
  console.table(result.rows);
}
if(process.argv.includes('--learn')){
  for(const [name,sys,prompt] of [['current',baselineSystem,oldUserPrompt],['proposed',proposedSystem,proposedUserPrompt]]){
    const r=await callModel(sys,prompt);
    const memories=r.operations.filter(o=>o.action==='add'&&typeof o.content==='string').map(o=>o.content!);
    console.log('\nMODEL EXTRACTION '+name,JSON.stringify({elapsedMs:r.elapsedMs,operations:r.operations,checks:scoreLearning(memories),warning:r.error}));
    const s=runRetrieval(memories,true);
    console.log('MODEL RETRIEVAL '+name+' '+s.passed+'/'+s.total);console.table(s.rows);
    if(!memories.length)console.log('NO OPERATIONS; first output:',r.raw);
  }
}
