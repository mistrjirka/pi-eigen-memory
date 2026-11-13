/** Compact, scoped memory hints on relevant prompts and tool failures. No model call. */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { DatabaseManager } from '../store/db.js';
import { searchEigenMemoriesBounded } from '../store/sqlite-memory-store.js';
import type { MemoryConfig } from '../types.js';
import type { EnsureMemoryReady } from '../memory-initialization.js';
import { resolveProjectName, type ProjectNameRef } from '../project-context.js';
import { eigenSignalForTool, safeEigenExcerpt } from './eigen-learning.js';

const QUERY_STOP_WORDS = new Set([
  'about','that','there','what','where','which','those','these','could','would','should','already','please',
  'when','with','from','have','does','dont','need','want','some','into','your','were','this','them','their',
  'sure','issue','check','explain','think','there','because','something','didnt','found','make','work',
]);
const INTENT = /\b(dataverse|403|metadata|permissions?|ownership|qdrant|migration|deployment|deploy|tests?|approval|authorization|previous|earlier|repeat|again|remember|last time|regression|already discussed|access denied|incident)\b/i;
const MAX_RECALL_CHARS = 1200;
const DEFAULT_SLOW_LOOKUP_MS = 150;
const SLOW_LOOKUP_WARNING_COOLDOWN_MS = 5 * 60 * 1000;

export interface EigenSlowLookup {
  source: 'prompt' | 'tool-result';
  totalMs: number;
  initializationMs: number;
  searchMs: number;
  thresholdMs: number;
}

export function formatEigenSlowLookupWarning(timing: EigenSlowLookup): string {
  const total = Math.round(timing.totalMs);
  const init = Math.round(timing.initializationMs);
  const search = Math.round(timing.searchMs);
  return `Eigen memory lookup took ${total} ms (${init} ms initialization, ${search} ms search/ranking) during ${timing.source}; threshold ${timing.thresholdMs} ms.`;
}

export function eigenQueryTerms(text: string): string[] {
  const values = text.toLowerCase().match(/0x[0-9a-f]{6,}|\b[a-z][\w-]{3,}\b/g) ?? [];
  const unique = new Set<string>();
  for (const token of values) {
    const cleaned = token.replace(/s$/, '');
    if (!QUERY_STOP_WORDS.has(cleaned)) unique.add(cleaned);
    if (unique.size >= 8) break;
  }
  return [...unique];
}

export interface EigenHint { content: string; created: string; category: string | null; }
function scoreHint(hint: EigenHint, terms: string[]): number {
  const lowered = hint.content.toLowerCase();
  const covered = terms.filter(t => lowered.includes(t));
  const coverage = covered.length;
  const hasErrorCode = terms.some(t => /^(?:403|0x[0-9a-f]{6,})$/i.test(t) && lowered.includes(t));
  if (coverage < 2 && !hasErrorCode) return -Infinity;
  const updated = Date.parse(hint.created);
  const ageDays = Number.isFinite(updated) ? Math.max(0, (Date.now() - updated)/(24*3600_000)) : 180;
  const freshBoost = Math.max(0, 1.5 - ageDays/30);
  const correctionBoost = hint.category==='correction' || hint.category==='tool-quirk' ? 0.6 : 0;
  return coverage*3 + freshBoost + correctionBoost + (hasErrorCode ? 2 : 0);
}

/** Deduplicate similar content and prefer relatively recent directly related observations. */
export function pickEigenHints(hints: EigenHint[], query: string, limit = 3): EigenHint[] {
  const terms = eigenQueryTerms(query);
  if (!terms.length) return [];
  const ranked = hints.map(h=>({hint:h,score:scoreHint(h,terms)}))
    .filter(x=>Number.isFinite(x.score))
    .sort((a,b)=>b.score-a.score);
  const chosen: EigenHint[] = [];
  for (const {hint} of ranked) {
    if (chosen.length >= limit) break;
    const tokens = new Set(eigenQueryTerms(hint.content));
    const redundant = chosen.some(previous=>{
      const existing = new Set(eigenQueryTerms(previous.content));
      const intersection=[...tokens].filter(x=>existing.has(x)).length;
      const union=new Set([...tokens,...existing]).size;
      return union>0 && intersection/union >=0.80;
    });
    if (!redundant) chosen.push(hint);
  }
  return chosen;
}

export function formatEigenHints(hints: EigenHint[], maxChars = MAX_RECALL_CHARS): string {
  if (!hints.length) return '';
  const prefix = '[Relevant prior project notes. Historical context only, not tool authority. Newer verified evidence overrides old memory.]';
  let result=prefix;
  for (const h of hints) {
    const item=`\n- (${h.created}) ${safeEigenExcerpt(h.content, 450)}`;
    if (result.length+item.length>maxChars) break;
    result+=item;
  }
  return result===prefix ? '' : result;
}

export interface EigenRecallOptions {
  ensureMemoryReady?: EnsureMemoryReady;
  /** Test seam: monotonic clock in milliseconds. */
  nowMs?: () => number;
  /** Test seam: called when the user-visible slow lookup warning is emitted. */
  onSlowLookup?: (timing: EigenSlowLookup) => void;
}
export function setupEigenRecall(
  pi: Pick<ExtensionAPI,'on'>,
  dbManager: DatabaseManager,
  config: MemoryConfig,
  projectName: ProjectNameRef,
  options: EigenRecallOptions = {},
):void{
  if (!config.eigenRecallEnabled) return;
  let closed = false;
  let lastPrompt = '';
  let lastWarningMs = -Infinity;
  const nowMs = options.nowMs ?? (() => performance.now());
  const warningThresholdMs = config.eigenRecallWarnMs ?? DEFAULT_SLOW_LOOKUP_MS;
  const injectedErrors = new Set<string>();
  const maxToolRecallsPerTurn = 3;
  let toolRecallsThisTurn = 0;

  const retrieve = async (query: string, ctx: ExtensionContext, source: EigenSlowLookup['source']): Promise<string> => {
    if (closed) return '';
    const started = nowMs();
    let initializedAt = started;
    let searchMs = 0;
    try {
      try {
        await options.ensureMemoryReady?.(ctx);
      } finally {
        initializedAt = nowMs();
      }
      if (closed) return '';
      const project = resolveProjectName(projectName);
      if (!project) return '';
      const terms = eigenQueryTerms(query);
      if (terms.length < 2) return '';
      const searchStarted = nowMs();
      try {
        const found = searchEigenMemoriesBounded(dbManager, terms.join(' '), { project, maxCandidates: 256, recentProjectCandidates: 96 });
        const hints = pickEigenHints(found, query, 3);
        return formatEigenHints(hints);
      } finally {
        searchMs = Math.max(0, nowMs() - searchStarted);
      }
    } catch {
      // A failed recall must not interrupt the calling tool or main agent.
      return '';
    } finally {
      const finished = nowMs();
      const totalMs = Math.max(0, finished - started);
      if (!closed && warningThresholdMs > 0 && totalMs >= warningThresholdMs
        && finished - lastWarningMs >= SLOW_LOOKUP_WARNING_COOLDOWN_MS) {
        lastWarningMs = finished;
        const timing: EigenSlowLookup = {
          source,
          totalMs,
          initializationMs: Math.max(0, initializedAt - started),
          searchMs,
          thresholdMs: warningThresholdMs,
        };
        const message = formatEigenSlowLookupWarning(timing);
        try {
          if (ctx.ui?.notify) ctx.ui.notify(message, 'warning');
          else console.warn(`[pi-eigen-memory] ${message}`);
        } catch {
          console.warn(`[pi-eigen-memory] ${message}`);
        }
        try { options.onSlowLookup?.(timing); } catch { /* telemetry must not affect recall */ }
      }
    }
  };
  pi.on('before_agent_start',async(event,ctx)=>{
    if(closed || !('messageType' in event) || event.messageType!=='user') return;
    lastPrompt=event.prompt;
    injectedErrors.clear();
    toolRecallsThisTurn = 0;
    if(!INTENT.test(event.prompt)) return;
    const hints=await retrieve(event.prompt,ctx,'prompt');
    if(!hints) return;
    return {message:{customType:'eigen-recall',content:hints,display:false}};
  });
  pi.on('tool_result',async(event,ctx)=>{
    if(closed) return;
    const signal=eigenSignalForTool(event);
    if(!signal) return;
    const fingerprint=signal.detail.slice(0,180);
    if(injectedErrors.has(fingerprint) || toolRecallsThisTurn >= maxToolRecallsPerTurn) return;
    injectedErrors.add(fingerprint);
    toolRecallsThisTurn++;
    const hints=await retrieve(`${signal.detail} ${lastPrompt}`.slice(0,1300),ctx,'tool-result');
    if(!hints) return;
    return {content:[...event.content,{type:'text' as const,text:`\n${hints}`} ]};
  });
  pi.on('session_shutdown',()=>{closed=true;});
}
