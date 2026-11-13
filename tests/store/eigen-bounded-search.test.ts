import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { addMemory, searchEigenMemoriesBounded, searchMemories } from '../../src/store/sqlite-memory-store.js';

function fixture(fn: (db: DatabaseManager) => void): void {
  const folder = mkdtempSync(join(tmpdir(), 'pi-eigen-bounded-test-'));
  const db = new DatabaseManager(folder);
  db.setQuickCheckOnOpen(false);
  try { fn(db); } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
}

describe('Eigen bounded memory recall', () => {
  it('finds an old rare, actionable 403 lesson beyond the latest project sample', () => fixture((db) => {
    const expected = addMemory(db, 'Dataverse EntityDefinitions metadata 403 0x80040220 missing prvReadEntity, ordinary incident GET returns HTTP 200.', 'memory', 'SBHG-Buddy');
    for (let i = 0; i < 200; i++) addMemory(db, `recent unrelated note ${i} about policy versioning and tests`, 'memory', 'SBHG-Buddy');
    const hits = searchEigenMemoriesBounded(db, 'Dataverse EntityDefinitions 0x80040220', { project: 'SBHG-Buddy', maxCandidates: 16, recentProjectCandidates: 8 });
    assert.ok(hits.some(entry => entry.id === expected.id));
    assert.ok(hits.length <= 24);
  }));

  it('does not let thousands of other-project FTS matches hide recent scoped facts', () => fixture((db) => {
    const expected = addMemory(db, 'PiTTy tool results update conversation state and rendering.', 'memory', 'PiTTy');
    const sql = db.getDb().prepare(`INSERT INTO memories (project,target,content,created,last_referenced)
      VALUES ('unrelated-project','memory', ?, '2026-11-13', '2026-11-13')`);
    db.getDb().transaction(() => { for (let i = 0; i < 900; i++) sql.run(`Other project PiTTy tool results ${i} unrelated`); })();
    const hits = searchEigenMemoriesBounded(db, 'PiTTy tool results', { project: 'PiTTy', maxCandidates: 16, recentProjectCandidates: 8 });
    assert.ok(hits.some(entry => entry.id === expected.id));
    assert.ok(hits.every(entry => entry.project === 'PiTTy'));
    assert.ok(hits.length <= 24);
  }));

  it('returns at most a bounded shortlist and truncates giant stored memory contents', () => fixture((db) => {
    const sql = db.getDb().prepare(`INSERT INTO memories (project,target,content,created,last_referenced)
      VALUES ('SBHG-Buddy','memory', ?, '2026-11-13', '2026-11-13')`);
    db.getDb().transaction(() => {
      for (let i = 0; i < 700; i++) sql.run(`PiTTy tool execution rendering ${i} note ${'x'.repeat(i === 699 ? 25_000 : 200)}`);
    })();
    const hits = searchEigenMemoriesBounded(db, 'PiTTy tool execution rendering', { project: 'SBHG-Buddy', maxCandidates: 32, recentProjectCandidates: 8 });
    assert.ok(hits.length <= 40);
    assert.ok(hits.length >= 30);
    assert.ok(hits.every(h => h.content.length <= 1600));
    // The explicit memory-search API remains complete and BM25-ranked.
    assert.equal(searchMemories(db, 'PiTTy tool execution rendering', { project: 'SBHG-Buddy', limit: 20 }).length, 20);
  }));

  it('preserves broad-language fallback but does not scan an unbounded result list', () => fixture((db) => {
    addMemory(db, 'Dataverse contact records returned 200 but attribute metadata returned 403 0x80040220', 'memory', 'SBHG-Buddy');
    const hits = searchEigenMemoriesBounded(db, 'Dataverse attributes permission metadata', { project: 'SBHG-Buddy', maxCandidates: 16, recentProjectCandidates: 0 });
    assert.equal(hits.length, 1);
    assert.match(hits[0].content, /metadata returned 403/);
  }));
});
