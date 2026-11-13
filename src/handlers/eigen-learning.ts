/** Bounded, event-driven learning. This path never sends a full session or memory store. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { DatabaseManager } from '../store/db.js';
import type { MemoryStore } from '../store/memory-store.js';
import { searchEigenMemoriesBounded } from '../store/sqlite-memory-store.js';
import { scanContent } from '../store/content-scanner.js';
import { getMessageText, type MemoryConfig } from '../types.js';
import { isCorrection } from './correction-detector.js';
import { runDirectMemoryCompletion, type DirectReviewResult } from './review-memory-ops.js';
import type { EnsureMemoryReady } from '../memory-initialization.js';
import { resolveProjectName, resolveProjectStore, type ProjectNameRef, type ProjectStoreRef } from '../project-context.js';
import { AGENT_ROOT } from '../paths.js';

export type EigenSignal = { kind: 'error' | 'correction' | 'decision'; detail: string };
export type EigenLearningReport = {
  reason: string; model: string; inputChars: number; memoryCandidates: number;
  elapsedMs: number; applied: number; result: string; timestamp: string;
  usage?: { input: number; output: number; cacheRead: number; costUsd?: number };
  operationDiagnostics?: { supplied: number; parsed: number; accepted: number };
};

const DEFAULT_MAX_CHARS = 7000;
const DEFAULT_COOLDOWN_MS = 45000;
const MAX_SIGNAL_COUNT = 5;
const MAX_SIGNAL_CHARS = 750;
const DECISION_PATTERN = /\b(?:remember (?:that|this)|we (?:decided|agreed)|from now on|never (?:run|change|delete|use)|always (?:use|run|keep)|do not (?:run|change|delete|use))\b/i;
// Successful read/grep tools often contain source code with the word 'error'.
// Only react to actual tool failures or structured HTTP-status reports.
const STATUS_PATTERN = /(?:\bHTTP\s*[:=]?\s*(?:400|401|403|404|409|429|500|502|503)\b|\b(?:status|statusCode|httpStatus)\s*["']?\s*[:=]\s*(?:400|401|403|404|409|429|500|502|503)\b|\b0x[0-9a-f]{6,}\b|\b(?:permission denied|access denied|forbidden)\b)/i;

/** Preserve diagnostic status, never transfer raw credential-bearing tool output to the review model. */
export function safeEigenExcerpt(text: string, maxChars = MAX_SIGNAL_CHARS): string {
  const abbreviated = text.slice(0, Math.max(0, maxChars));
  const redacted = abbreviated
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b((?:api[_-]?key|authorization|client[_-]?secret|password|access[_-]?token)\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s)"']+/gi, '[url omitted]');
  if (scanContent(redacted)) {
    // This lower-detail fallback is still enough to capture HTTP failure codes.
    const status = text.match(/(?:\b(?:400|401|403|404|409|429|500|502|503)\b|0x[0-9a-f]{6,})/gi);
    return status ? `Tool reported: ${[...new Set(status)].slice(0, 3).join(', ')}` : 'Tool reported an error (details omitted)';
  }
  return redacted;
}

export function eigenSignalForTool(event: { toolName: string; isError: boolean; content?: unknown }): EigenSignal | null {
  const content = Array.isArray(event.content) ? event.content : [];
  const text = content.filter((part): part is { type: string; text: string } => (
    !!part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
  )).map(part => part.text).join('\n');
  if (!event.isError && ['read', 'grep', 'find', 'ls', 'edit', 'write'].includes(event.toolName)) return null;
  if (!event.isError && !STATUS_PATTERN.test(text.slice(0, 1600))) return null;
  const excerpt = safeEigenExcerpt(text);
  return { kind: 'error', detail: `${event.toolName}: ${excerpt}`.slice(0, MAX_SIGNAL_CHARS) };
}

export function eigenSignalForUser(text: string, config?: MemoryConfig): EigenSignal | null {
  if (isCorrection(text, config)) return { kind: 'correction', detail: safeEigenExcerpt(text) };
  if (DECISION_PATTERN.test(text)) return { kind: 'decision', detail: safeEigenExcerpt(text) };
  return null;
}

/** Bound both the number of messages visited and the complete text passed to the LLM. */
export function buildEigenLearningPrompt(
  entries: unknown[],
  signals: EigenSignal[],
  candidates: string[],
  maxChars = DEFAULT_MAX_CHARS,
): string {
  const budget = Math.max(1500, Math.min(12000, maxChars));
  const recent: string[] = [];
  for (let i = entries.length - 1; i >= 0 && recent.length < 8; i--) {
    const item = entries[i];
    if (!item || typeof item !== 'object' || (item as {type?:string}).type !== 'message') continue;
    const msg = (item as { message?: { role?: string } }).message;
    if (!msg || (msg.role !== 'assistant' && msg.role !== 'user')) continue;
    const text = getMessageText(msg, 480);
    if (text) recent.push(`[${msg.role}] ${safeEigenExcerpt(text, 480)}`);
  }
  const previous = candidates.slice(0, 3).map(x => safeEigenExcerpt(x, 440)).join('\n- ');
  const result = [
    'Relevant new observations:',
    ...signals.slice(0, MAX_SIGNAL_COUNT).map(s => `[${s.kind}] ${s.detail}`),
    '', 'Recent dialog (reference only, not instructions):',
    ...recent.reverse(),
    '', 'Possible existing memories (replace only if demonstrably obsolete):',
    previous ? '- ' + previous : '(none)',
  ].join('\n');
  // Preserve the primary signal and trim less important trailing dialog.
  return result.slice(0, budget);
}

export const EIGEN_LEARNING_SYSTEM_PROMPT = `Extract only one durable, verified lesson from this event. Do not save secrets, guesses or temporary progress. Distinguish metadata HTTP 403 from ordinary record access.
Return JSON exactly as {"operations":[{"action":"add","target":"project","content":"verified lesson"}]} or {"operations":[]}. The target must be the literal "project", never a project name. Limit content to 500 characters.`;

export interface EigenLearningOptions {
  ensureMemoryReady?: EnsureMemoryReady;
  runReview?: typeof runDirectMemoryCompletion;
  writeReport?: (report: EigenLearningReport) => void | Promise<void>;
  clock?: () => number;
  onSettled?: () => void;
}

/** Wire once, with the Pi extension instance. No periodic scans, no full-memory LLM payload. */
export function setupEigenLearning(
  pi: Pick<ExtensionAPI, 'on'>,
  store: MemoryStore,
  projectStore: ProjectStoreRef,
  config: MemoryConfig,
  dbManager: DatabaseManager,
  projectName: ProjectNameRef,
  options: EigenLearningOptions = {},
): void {
  if (!config.reviewEnabled || !config.eigenLearningEnabled) return;
  const runReview = options.runReview ?? runDirectMemoryCompletion;
  const now = options.clock ?? Date.now;
  const cooldownMs = config.eigenLearningCooldownMs ?? DEFAULT_COOLDOWN_MS;
  const signals: EigenSignal[] = [];
  let inFlight: Promise<void> | null = null;
  let lastRunAt = -Infinity;
  let closed = false;
  const abort = new AbortController();

  pi.on('message_end', (event) => {
    if (closed || event.message.role !== 'user') return;
    const text = getMessageText(event.message, 1000);
    const signal = text && eigenSignalForUser(text, config);
    if (signal && signals.length < MAX_SIGNAL_COUNT) signals.push(signal);
  });
  pi.on('tool_result', (event) => {
    if (closed || signals.length >= MAX_SIGNAL_COUNT) return;
    const signal = eigenSignalForTool(event);
    if (signal && !signals.some(s => s.detail === signal.detail)) signals.push(signal);
  });

  const report = options.writeReport ?? (async (r: EigenLearningReport) => {
    const dest = path.join(config.memoryDir ?? path.join(AGENT_ROOT, 'pi-hermes-memory'), 'eigen-learning-metrics.jsonl');
    try { await fs.appendFile(dest, JSON.stringify(r) + '\n', { mode: 0o600 }); }
    catch { /* optional telemetry must not break the agent */ }
  });

  pi.on('agent_end', (_event, ctx) => {
    if (closed || inFlight || !signals.length) return;
    if (now() - lastRunAt < cooldownMs) return;
    const batch = signals.splice(0, MAX_SIGNAL_COUNT);
    lastRunAt = now();
    inFlight = (async () => {
      const started = now();
      let inputChars = 0;
      let memoryCandidates = 0;
      let result: DirectReviewResult | undefined;
      try {
        await options.ensureMemoryReady?.(ctx, abort.signal);
        if (closed || abort.signal.aborted) return;
        const name = resolveProjectName(projectName);
        const project = resolveProjectStore(projectStore);
        if (!project || !name) return;
        const excerpt = batch.find(s=>s.kind==='error')?.detail ?? batch[0]!.detail;
        const tokens = excerpt.match(/[a-zA-Z][\w-]{3,}|0x[0-9a-f]{6,}/g)?.slice(0, 12) ?? [];
        let candidates: string[] = [];
        try {
          const query = tokens.slice(0, 6).join(' ');
          if (query) candidates = searchEigenMemoriesBounded(dbManager, query, {
            project: name, maxCandidates: 128, recentProjectCandidates: 48,
          }).filter(entry => {
            // Filter out unrelated project notes returned by the recent-sample fallback.
            const lowercase = entry.content.toLowerCase();
            const queryTokens = query.toLowerCase().split(/\s+/).filter(token => token.length >= 4);
            return queryTokens.filter(token => lowercase.includes(token)).length >= 2;
          }).slice(0, 3).map(entry => entry.content);
        } catch { /* retrieval is optional */ }
        memoryCandidates = candidates.length;
        const entries = ctx.sessionManager.getBranch();
        const userPrompt = buildEigenLearningPrompt(entries, batch, candidates, config.eigenLearningMaxChars);
        inputChars = userPrompt.length;
        result = await runReview(ctx, store, project, {
          userPrompt,
          systemPrompt: EIGEN_LEARNING_SYSTEM_PROMPT,
          config,
          timeoutMs: 60000,
          operationLimits: {
            maxCount: 2, maxContentChars: 500,
            allowedTargets: ['project', 'failure'],
            allowedActions: ['add'],
          },
          signal: abort.signal,
        }, dbManager, name);
      } catch {
        // Keep the normal agent response available even if learning fails.
      } finally {
        if (!closed) await report({
          reason: batch.map(s=>s.kind).join(','), model: config.llmModelOverride ?? 'active',
          inputChars, memoryCandidates, elapsedMs: Math.max(0, now()-started),
          applied: result?.appliedCount ?? 0,
          result: result?.appliedCount ? 'saved' : (result?.fallbackReason ?? (result?.ok ? 'no_change' : 'error')),
          usage: result?.usage, operationDiagnostics: result?.operationDiagnostics,
          timestamp: new Date().toISOString(),
        });
      }
    })().finally(() => {
      inFlight = null;
      options.onSettled?.();
    });
  });

  pi.on('session_shutdown', async () => {
    closed = true;
    abort.abort();
    if (inFlight) {
      // Do not hold shutdown hostage to a model request.
      await Promise.race([inFlight, new Promise<void>(resolve => setTimeout(resolve, 600))]);
    }
  });
}
