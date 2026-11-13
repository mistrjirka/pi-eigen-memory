/** Synthetic SQLite FTS5 benchmark for increasing durable-memory counts.
 * Uses a temporary database, never touches the user's production memory.
 * Measures the same searchMemories() function used by Eigen recall.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseManager } from '../src/store/db.js';
import { searchMemories, searchEigenMemoriesBounded } from '../src/store/sqlite-memory-store.js';
import { pickEigenHints } from '../src/handlers/eigen-recall.js';

const sizes = [2_500, 10_000, 40_000, 100_000];
const queries = [
  { name: 'rare_exact_error', text: 'Dataverse EntityDefinitions 0x80040220' },
  { name: 'common_project', text: 'PiTTy' },
  { name: 'specific_project', text: 'PiTTy tool execution rendering' },
  { name: 'natural_language', text: 'permission to read metadata' },
  { name: 'no_match', text: 'zxqnevermatch' },
];
const dir = mkdtempSync(join(tmpdir(), 'pi-eigen-scale-'));
const dbManager = new DatabaseManager(dir);
dbManager.setQuickCheckOnOpen(false);
const db = dbManager.getDb();
const insert = db.prepare('INSERT INTO memories (project,target,content,created,last_referenced) VALUES (?, ?, ?, ?, ?)');
const date = '2026-11-13';

function entry(i: number): string {
  const label = `Reference ${i.toString().padStart(8, '0')}.`;
  if (i % 97 === 0) return `${label} Dataverse EntityDefinitions metadata HTTP 403 0x80040220 missing prvReadEntity. Normal incident record reads return 200. Permission denial affects metadata only.`;
  if (i % 4 === 0) return `${label} PiTTy tool execution rendering and RPC tool result state. OpenTUI conversation messages update UI asynchronously. Preserve existing plugin events and progress reporting.`;
  if (i % 5 === 0) return `${label} SBHG-Buddy governance permission to read metadata depends on directory role and approval stage. Avoid stale knowledge after policy version changes.`;
  if (i % 3 === 0) return `${label} Project deployment testing convention uses targeted vitest with pnpm and preserves the configured local environment. Check release requirements.`;
  return `${label} Model training context selection and memory retrieval evaluation. Cache session history, avoid duplicated old facts, keep current user decisions.`;
}

function pct(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

try {
  let previous = 0;
  for (const count of sizes) {
    const insertStart = performance.now();
    const batch = db.transaction(() => {
      for (let i = previous; i < count; i++) insert.run(i % 101 === 0 ? 'unrelated-project' : 'SBHG-Buddy', 'memory', entry(i), date, date);
    });
    batch();
    const indexedMs = Math.round(performance.now() - insertStart);
    previous = count;
    for (const query of queries) {
      const times: number[] = [];
      let results = 0;
      // Warm FTS indexes, page cache and prepared query path before measuring.
      for (let warm = 0; warm < 8; warm++) searchMemories(dbManager, query.text, {project:'SBHG-Buddy',limit:20});
      for (let i = 0; i < 60; i++) {
        const started = performance.now();
        const hit = searchMemories(dbManager, query.text, {project:'SBHG-Buddy',limit:20});
        times.push(performance.now() - started);
        results = hit.length;
      }
      times.sort((a,b) => a-b);
      console.log(JSON.stringify({memories:count,query:query.name,mode:'legacy-bm25',found:results,
        p50Ms:+pct(times,0.50).toFixed(3),p95Ms:+pct(times,0.95).toFixed(3),
        maxMs:+times[times.length - 1]!.toFixed(3),indexedMs}));
      const boundedTimes:number[]=[];
      let boundedCandidates=0,usableHints=0;
      for(let warm=0;warm<8;warm++)searchEigenMemoriesBounded(dbManager,query.text,{project:'SBHG-Buddy'});
      for(let i=0;i<60;i++){
        const started=performance.now();
        const entries=searchEigenMemoriesBounded(dbManager,query.text,{project:'SBHG-Buddy'});
        const hints=pickEigenHints(entries,query.text,3);
        boundedTimes.push(performance.now()-started);
        boundedCandidates=entries.length;usableHints=hints.length;
      }
      boundedTimes.sort((a,b)=>a-b);
      console.log(JSON.stringify({memories:count,query:query.name,mode:'bounded-eigen',
        candidates:boundedCandidates,hints:usableHints,
        p50Ms:+pct(boundedTimes,0.50).toFixed(3),p95Ms:+pct(boundedTimes,0.95).toFixed(3),
        maxMs:+boundedTimes[boundedTimes.length-1]!.toFixed(3)}));
    }
    const bytes = Number((db.pragma('page_count',{simple:true}) as number)) * Number((db.pragma('page_size',{simple:true}) as number));
    console.log(JSON.stringify({memories:count,dbMiB:+(bytes/1024/1024).toFixed(2),indexedMs}));
  }
} finally {
  dbManager.close();
  rmSync(dir,{recursive:true,force:true});
}
