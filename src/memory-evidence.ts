/** Small, optional provenance carried by Markdown and its SQLite mirror. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scanContent } from './store/content-scanner.js';

export interface MemoryEvidence {
  origin: 'direct-user' | 'delegated' | 'observation' | 'legacy';
  observedAt?: string;
  sessionId?: string;
  entryId?: string;
  agentId?: string;
  branch?: string;
  scope?: 'project' | 'branch' | 'task';
  evidence?: string;
  supersedes?: string[];
}
export function memoryFingerprint(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex').slice(0, 24);
}
export function parseMemoryEvidence(value: unknown): MemoryEvidence | undefined {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return undefined; } }
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (!['direct-user', 'delegated', 'observation', 'legacy'].includes(String(input.origin))) return undefined;
  const result: MemoryEvidence = { origin: input.origin as MemoryEvidence['origin'] };
  for (const key of ['observedAt', 'sessionId', 'entryId', 'agentId', 'branch', 'evidence'] as const) {
    if (typeof input[key] === 'string' && input[key].trim()) {
      let value = input[key].trim().slice(0, key === 'evidence' ? 500 : 160);
      if (key === 'evidence') {
        value = value.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b((?:api[_-]?key|authorization|client[_-]?secret|password|access[_-]?token)\s*[:=]\s*)\S+/gi, '$1[redacted]');
        if (scanContent(value)) value = '[Evidence details omitted by the existing content scanner]';
      }
      result[key] = value;
    }
  }
  if (['project','branch','task'].includes(String(input.scope))) result.scope = input.scope as MemoryEvidence['scope'];
  if (Array.isArray(input.supersedes)) {
    const keys = input.supersedes.filter((x): x is string => typeof x === 'string' && /^[a-f0-9]{24}$/.test(x)).slice(0, 8);
    if (keys.length) result.supersedes = [...new Set(keys)];
  }
  return result;
}
export function isDelegatedAgent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.PI_SUBAGENT_AGENT_ID || env.PI_SUBAGENT_PROFILE);
}
export function isMemoryMaintenance(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_HERMES_MEMORY_CHILD === '1';
}
/** A user-role message is not proof of human authorship. Model writes remain observations. */
export function observationEvidence(ctx?: { sessionManager?: { getSessionId?(): string; getLeafId?(): string | null } }, env: NodeJS.ProcessEnv = process.env): MemoryEvidence {
  const result: MemoryEvidence = { origin: isDelegatedAgent(env) ? 'delegated' : 'observation', observedAt: new Date().toISOString(), scope: 'project' };
  if (env.PI_SUBAGENT_AGENT_ID) result.agentId = env.PI_SUBAGENT_AGENT_ID;
  try { result.sessionId = ctx?.sessionManager?.getSessionId?.(); result.entryId = ctx?.sessionManager?.getLeafId?.() ?? undefined; } catch { /* optional source anchors */ }
  return result;
}
/** Read HEAD without a git subprocess. Worktrees keep their own HEAD. */
export function currentMemoryBranch(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  for (let depth = 0; depth < 24; depth++) {
    try {
      const dot = path.join(current, '.git');
      const git = fs.statSync(dot).isDirectory() ? dot : path.resolve(current, fs.readFileSync(dot, 'utf8').trim().replace(/^gitdir:\s*/, ''));
      const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
      return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 40);
    } catch { /* ascend until the repository root */ }
    const parent = path.dirname(current); if (parent === current) return undefined; current = parent;
  }
  return undefined;
}

export function decodeMemoryEntry(raw: string): { text: string; created: string; lastReferenced: string; project: string | null; evidence?: MemoryEvidence } {
  const match = raw.match(/^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^,>]+)(?:,\s*project64=([A-Za-z0-9_-]+))?(?:,\s*evidence64=([A-Za-z0-9_-]+))?\s*-->\s*$/s);
  if (!match) return { text: raw.trim(), created: new Date().toISOString().slice(0, 10), lastReferenced: new Date().toISOString().slice(0, 10), project: null };
  let project: string | null = null;
  let evidence: MemoryEvidence | undefined;
  try { if (match[4]) project = Buffer.from(match[4], 'base64url').toString('utf8').trim() || null; } catch { /* old metadata remains readable */ }
  try { if (match[5]) evidence = parseMemoryEvidence(Buffer.from(match[5], 'base64url').toString('utf8')); } catch { /* ignore invalid optional provenance */ }
  return { text: match[1].trim(), created: match[2].trim(), lastReferenced: match[3].trim(), project, ...(evidence ? { evidence } : {}) };
}
export function encodeMemoryEntry(text: string, created: string, lastReferenced: string, project?: string, evidence?: MemoryEvidence): string {
  const scope = project?.trim() ? ', project64=' + Buffer.from(project.trim()).toString('base64url') : '';
  const normalized = parseMemoryEvidence(evidence);
  const meta = normalized ? ', evidence64=' + Buffer.from(JSON.stringify(normalized)).toString('base64url') : '';
  return text + ' <!-- created=' + created + ', last=' + lastReferenced + scope + meta + ' -->';
}
