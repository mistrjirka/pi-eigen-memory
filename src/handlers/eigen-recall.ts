/** Bounded task-aware historical evidence on user requests and failures. */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { DatabaseManager } from '../store/db.js';
import { searchEigenMemoriesBounded } from '../store/sqlite-memory-store.js';
import type { MemoryConfig } from '../types.js';
import type { EnsureMemoryReady } from '../memory-initialization.js';
import { resolveProjectName, type ProjectNameRef } from '../project-context.js';
import { eigenSignalForTool, safeEigenExcerpt } from './eigen-learning.js';
import { isDelegatedAgent, isMemoryMaintenance, memoryFingerprint } from '../memory-evidence.js';
import { eigenQueryTerms, rankEigenHints, taskTerms, type EigenHint, type RankedHint } from '../recall-query.js';
export { eigenQueryTerms, pickEigenHints, type EigenHint } from '../recall-query.js';

const MAX_RECALL_CHARS=1200;
const PREFIX='[Historical project evidence. Current instructions and verified source override these notes. Recorded decisions apply within their original scope; these notes do not expand the assignment.]';
export interface EigenSlowLookup { source:'prompt'|'tool-result'; totalMs:number; initializationMs:number; searchMs:number; thresholdMs:number; }
export function formatEigenSlowLookupWarning(t:EigenSlowLookup):string {
  return `Eigen memory lookup took ${Math.round(t.totalMs)} ms (${Math.round(t.initializationMs)} ms initialization, ${Math.round(t.searchMs)} ms search/ranking) during ${t.source}; threshold ${t.thresholdMs} ms.`;
}
function noteText(hint:EigenHint,version:string):string {
  return `\n- [memory:${version}]${hint.id ? ' id='+hint.id : ''} (${hint.evidence?.observedAt ?? hint.created}; ${hint.evidence?.origin ?? 'legacy'}) ${safeEigenExcerpt(hint.content,450)}`;
}
export function formatEigenHints(hints:EigenHint[],maxChars=MAX_RECALL_CHARS):string {
  let result=PREFIX;
  for(const hint of hints.slice(0,3)) {
    const part=noteText(hint,memoryFingerprint(hint.content+JSON.stringify(hint.evidence??{})));
    if(result.length+part.length>maxChars)continue;
    result+=part;
  }
  return result===PREFIX?'':result;
}
export interface EigenRecallOptions {
  ensureMemoryReady?:EnsureMemoryReady;
  nowMs?:()=>number;
  onSlowLookup?:(timing:EigenSlowLookup)=>void;
  env?:NodeJS.ProcessEnv;
  onDiagnostic?:(diagnostic:RecallDiagnostic)=>void;
}
export interface RecallDiagnostic { status?:'no-project'|'no-terms'|'budget'|'no-match'|'selected'|'lookup-failed'; terms:string[]; scope:string|null; role:'main'|'child'; selected:Array<{id?:number;version:string;score:number;matched:string[]}>; excluded:Array<{id?:number;reason:string}>; chars:number; remainingChars:number; }
function branchText(ctx:ExtensionContext):string | undefined {
  try {
    const entries=ctx.sessionManager.getBranch() as unknown as Array<Record<string,unknown>>;
    let from=0; let summary='';
    for(let i=entries.length-1;i>=0;i--)if(entries[i].type==='compaction') {
      const entry=entries[i]; summary=typeof entry.summary==='string'?entry.summary:'';
      const kept=entries.findIndex(e=>e.id===entry.firstKeptEntryId);
      from=kept>=0?kept:i+1; break;
    }
    const texts:string[]=[summary.slice(0,64000),...(summary.match(/\[memory:[a-f0-9]{24}\]/g)??[])];
    let remaining=Math.max(0,64000-summary.length);
    for(let i=entries.length-1;i>=from;i--) {
      const entry=entries[i]; const message=entry.message as Record<string,unknown>|undefined;
      const content=entry.type==='custom_message'?entry.content:message?.content;
      const remember=(text:string)=>{
        // Keep identity markers from all roles without copying full tool outputs.
        if(text.includes('[memory:'))for(const marker of text.match(/\[memory:[a-f0-9]{24}\]/g)??[])texts.push(marker);
        if(remaining>0&&(entry.type==='custom_message'||message?.role==='user')){const excerpt=text.slice(0,Math.min(16000,remaining));texts.push(excerpt);remaining-=excerpt.length;}
      };
      if(typeof content==='string')remember(content);
      else if(Array.isArray(content))for(const part of content)if(part?.type==='text'&&typeof part.text==='string')remember(part.text);
    }
    return texts.join('\n');
  } catch { return undefined; }
}
export function setupEigenRecall(pi:Pick<ExtensionAPI,'on'>&Partial<Pick<ExtensionAPI,'registerCommand'>>,dbManager:DatabaseManager,config:MemoryConfig,projectName:ProjectNameRef,options:EigenRecallOptions={}):void {
  const env=options.env??process.env;
  const child=isDelegatedAgent(env);
  let sessionEnabled=true,closed=false,lastPrompt='',usedChars=0,toolAttempts=0,lastWarningMs=-Infinity;
  const seenFallback=new Set<string>(),errors=new Set<string>();
  const now=options.nowMs??(()=>performance.now());
  const budget=Math.max(0,Math.min(12000,config.eigenRecallBudgetChars??2400));
  const enabled=()=>!closed&&sessionEnabled&&config.eigenRecallEnabled===true&&!isMemoryMaintenance(env)&&env.PI_EIGEN_RECALL_OFF!=='1'&&(child?config.eigenRecallChildEnabled!==false:config.eigenRecallMainEnabled!==false);
  const retrieve=async(query:string,ctx:ExtensionContext,source:'prompt'|'tool-result',dryRun=false):Promise<string>=>{
    const started=now(); let initializedAt=started,searchMs=0;
    const terms=eigenQueryTerms(query);
    const diagnostic:RecallDiagnostic={terms,scope:null,role:child?'child':'main',selected:[],excluded:[],chars:0,remainingChars:Math.max(0,budget-usedChars)};
    try {
      if(!terms.length){diagnostic.status='no-terms';return '';}
      if(!dryRun&&diagnostic.remainingChars<PREFIX.length+80){diagnostic.status='budget';return '';}
      try {await options.ensureMemoryReady?.(ctx);}finally{initializedAt=now();}
      if(closed)return '';
      // Lazy initialization binds the project and refreshes it after cwd changes.
      const project=resolveProjectName(projectName);
      diagnostic.scope=project;
      if(!project){diagnostic.status='no-project';return '';}
      const searchStart=now();
      const candidates=searchEigenMemoriesBounded(dbManager,terms.slice(0,12).join(' '),{project,maxCandidates:256,recentProjectCandidates:96});
      let sessionId:string|undefined;try{sessionId=ctx.sessionManager.getSessionId();}catch{}
      const ranked=rankEigenHints(candidates,query,{cwd:ctx.cwd,sessionId});
      const context=branchText(ctx);
      const current=new Set(context?.match(/\[memory:([a-f0-9]{24})\]/g)?.map(x=>x.slice(8,-1))??[]);
      if(context===undefined)for(const key of seenFallback)current.add(key);
      const normalizedContext=(context??lastPrompt).toLowerCase().replace(/\s+/g,' ');
      let text=PREFIX;
      const selected:RankedHint[]=[];
      const available=Math.min(MAX_RECALL_CHARS,dryRun?MAX_RECALL_CHARS:budget-usedChars);
      for(const item of ranked) {
        let reason=item.excluded;
        if(!reason&&current.has(item.version))reason='already in current context';
        if(!reason&&item.hint.content.length>=40&&normalizedContext.includes(item.hint.content.toLowerCase().replace(/\s+/g,' ')))reason='already supplied';
        if(!reason&&selected.some(prior=>prior.key===item.key))reason='duplicate note';
        const part=noteText(item.hint,item.version);
        if(!reason&&(selected.length>=3||text.length+part.length>available))reason='output budget';
        if(reason){diagnostic.excluded.push({id:item.hint.id,reason});continue;}
        text+=part;selected.push(item);
      }
      searchMs=Math.max(0,now()-searchStart);
      if(!selected.length){diagnostic.status='no-match';return '';}
      diagnostic.status='selected';
      diagnostic.selected=selected.map(item=>({id:item.hint.id,version:item.version,score:item.score,matched:item.matched}));
      diagnostic.chars=text.length;
      if(!dryRun){usedChars+=text.length;for(const item of selected)seenFallback.add(item.version);diagnostic.remainingChars=Math.max(0,budget-usedChars);}
      return text;
    } catch {diagnostic.status='lookup-failed';return '';}
    finally {
      try{options.onDiagnostic?.(diagnostic);}catch{}
      if(dryRun)try{ctx.ui.notify(JSON.stringify(diagnostic,null,2),'info');}catch{}
      const finished=now(),threshold=config.eigenRecallWarnMs??150;
      if(!closed&&threshold>0&&finished-started>=threshold&&finished-lastWarningMs>=300000){
        lastWarningMs=finished;const timing={source,totalMs:finished-started,initializationMs:initializedAt-started,searchMs,thresholdMs:threshold};
        try{ctx.ui.notify(formatEigenSlowLookupWarning(timing),'warning');}catch{}
        try{options.onSlowLookup?.(timing);}catch{}
      }
    }
  };
  pi.registerCommand?.('memory-recall',{
    description:'Control automatic recall for this session: on, off, or diagnose <task>. Diagnostics do not inject notes.',
    handler:async(args,ctx)=>{
      const command=args.trim();
      if(command==='on'||command==='off'){sessionEnabled=command==='on';ctx.ui.notify('Automatic recall '+(sessionEnabled?'enabled for this session (configured role controls still apply).':'disabled for this session.'),'info');return;}
      const query=command.replace(/^diagnose\s*/,'')||lastPrompt;
      if(!query){ctx.ui.notify('Use /memory-recall diagnose <task>, on, or off.','info');return;}
      await retrieve(query,ctx,'prompt',true);
    },
  });
  pi.on('before_agent_start',async(event,ctx)=>{
    if(!('messageType'in event)||event.messageType!=='user')return;
    lastPrompt=event.prompt;usedChars=0;toolAttempts=0;errors.clear();
    if(!enabled())return;
    // Subjectful tasks qualify; generic chatter and path/launch boilerplate do not.
    const terms=taskTerms(event.prompt);
    if(!terms.some(t=>t.weight>=5)&&terms.filter(t=>t.weight>=2).length<2)return;
    const hints=await retrieve(event.prompt,ctx,'prompt');
    if(hints)return {message:{customType:'eigen-recall',content:hints,display:false}};
  });
  pi.on('tool_result',async(event,ctx)=>{
    if(!enabled()||!lastPrompt||toolAttempts>=3)return;
    const signal=eigenSignalForTool(event);if(!signal)return;
    const key=memoryFingerprint(signal.detail);if(errors.has(key))return;
    errors.add(key);toolAttempts++;
    const hints=await retrieve(lastPrompt+'\nFailure evidence: '+signal.detail,ctx,'tool-result');
    if(hints)return {content:[...event.content,{type:'text' as const,text:'\n'+hints}]};
  });
  pi.on('session_compact',()=>{seenFallback.clear();});
  pi.on('session_shutdown',()=>{closed=true;seenFallback.clear();});
}
