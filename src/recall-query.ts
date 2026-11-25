/** Deterministic task terms and conservative recall ranking. No model call. */
import { currentMemoryBranch, memoryFingerprint, type MemoryEvidence } from './memory-evidence.js';

const STOP = new Set(('a an and are as at be been being but by can could did do does doing for from had has have how i if in into is it its may me more most my no not of on only or our please shall should so some than that the their them then there these they this those to too up use used using was we were what when where which while who why will with without would you your about already again before after ask asked answer agent agents implementer implementers assistant root parent child fresh resume resumed previous earlier latest old new task tasks work working repo repository home user current requested request return result report need needs want make think find check inspect read reading source file files next known exact existing relevant context evidence paths path execute execution independently lightweight direct host side production frozen scope goal constraints note notes stop start').split(/\s+/));
const GENERIC = new Set(['project','code','change','test','tests','build','error','tool','memory','decision','permission','output','input','run','runs','time','status','command']);
export interface RecallTerm { text: string; weight: number; }
function normalize(value: string): string {
  const text = value.toLowerCase();
  return text.length > 5 && text.endsWith('s') && !text.endsWith('ss') ? text.slice(0,-1) : text;
}
function withoutPaths(text: string): string {
  return text.replace(/(?:~?\/|[A-Za-z]:\\)[^\s<>"')]+/g, (value) => {
    const last = value.split(/[\\/]/).at(-1) ?? '';
    return /\.[a-z0-9]{1,7}$/i.test(last) ? last.replace(/[._-]/g,' ') : ' ';
  }).replace(/https?:\S+/gi,' ');
}
export function taskTerms(text: string): RecallTerm[] {
  const words = withoutPaths(text.slice(0, 16000)).match(/0x[0-9a-f]{6,}|\b\d{3,5}\b|[\p{L}][\p{L}\p{N}_-]*/giu) ?? [];
  const terms = new Map<string, RecallTerm>();
  for (const word of words) {
    const key = normalize(word);
    if (STOP.has(key) || (key.length < 2 && !/^[A-HJ-Z]$/.test(word))) continue;
    const identifier = /^0x[0-9a-f]+$/i.test(word) || /^\d{3,5}$/.test(word) || /[a-z].*\d|\d.*[a-z]/i.test(word);
    const weight = identifier ? 5 : key.length === 1 ? 3 : /[a-z][A-Z]|[_-]/.test(word) ? 3 : GENERIC.has(key) ? 0.5 : 2;
    if (!terms.has(key)) terms.set(key, { text: key, weight });
  }
  return [...terms.values()].sort((a,b)=>b.weight-a.weight).slice(0, 24);
}
export function eigenQueryTerms(text: string): string[] { return taskTerms(text).map(t=>t.text); }
export interface EigenHint { id?: number; content: string; created: string; category: string | null; project?: string | null; evidence?: MemoryEvidence; }
export interface RankedHint { hint: EigenHint; key: string; version: string; score: number; matched: string[]; excluded?: string; }
export interface RecallScope { cwd?: string; branch?: string; sessionId?: string; }
function noteTokens(text: string): Set<string> {
  return new Set((text.match(/0x[0-9a-f]{6,}|\b\d{3,5}\b|[\p{L}][\p{L}\p{N}_-]*/giu) ?? []).map(normalize));
}
export function rankEigenHints(hints: EigenHint[], query: string, scope: RecallScope = {}): RankedHint[] {
  const terms = taskTerms(query);
  const currentBranch = scope.branch ?? (scope.cwd ? currentMemoryBranch(scope.cwd) : undefined);
  const superseded = new Set(hints.filter(h=>h.evidence?.scope!=='branch'||h.evidence.branch===currentBranch).filter(h=>h.evidence?.scope!=='task'||h.evidence.sessionId===scope.sessionId).flatMap(h=>h.evidence?.supersedes ?? []));
  const hostOnly = /host[- ]only|only\b[^\n.]{0,80}\bhost[- ]side|no\s+(?:npu|gpu|native\s+build)|without\s+(?:npu|gpu)/i.test(query);
  return hints.map(hint=>{
    const key = memoryFingerprint(hint.content);
    const version = memoryFingerprint(hint.content + JSON.stringify(hint.evidence ?? {}));
    const tokens = noteTokens(hint.content);
    const covered = terms.filter(t=>tokens.has(t.text));
    const matched = covered.map(t=>t.text);
    const strong = covered.filter(t=>t.weight >= 2);
    let excluded: string | undefined;
    if (!terms.length) excluded = 'no task terms';
    else if (superseded.has(key)) excluded = 'superseded';
    else if (hint.evidence?.scope === 'task' && (!scope.sessionId || hint.evidence.sessionId !== scope.sessionId)) excluded = 'different task';
    else if (hint.evidence?.scope === 'branch' && (!currentBranch || hint.evidence.branch !== currentBranch)) excluded = 'different branch';
    else if (hostOnly && /\b(?:reboot|flashing|flash|wedged|ssh|recovery|native\s+(?:rebuild|build)|timeout\s+authorization)\b/i.test(hint.content)) excluded = 'outside host-only task';
    else if (!strong.some(t=>t.weight >= 5) && strong.length < 2) excluded = 'insufficient subject match';
    const observed = Date.parse(hint.evidence?.observedAt ?? hint.created);
    const age = Number.isFinite(observed) ? Math.max(0, (Date.now()-observed)/86400000) : 365;
    const score = covered.reduce((sum,t)=>sum+t.weight,0) + Math.max(0,0.5-age/180) + (hint.category==='correction' ? 0.2 : 0);
    return {hint,key,version,score,matched,...(excluded?{excluded}:{})};
  }).sort((a,b)=>b.score-a.score);
}
export function pickEigenHints(hints: EigenHint[], query: string, limit = 3): EigenHint[] {
  const result: EigenHint[] = [];
  for (const item of rankEigenHints(hints,query)) {
    if (item.excluded) continue;
    const tokens=noteTokens(item.hint.content);
    if (result.some(previous=>{
      const other=noteTokens(previous.content); const intersection=[...tokens].filter(t=>other.has(t)).length;
      return intersection/Math.max(1,new Set([...tokens,...other]).size)>=0.85;
    })) continue;
    result.push(item.hint); if(result.length>=limit)break;
  }
  return result;
}
