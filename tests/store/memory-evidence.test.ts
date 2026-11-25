import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../../src/store/db.js';
import { MemoryStore } from '../../src/store/memory-store.js';
import { reconcileMarkdownMemoryScope, searchMemories } from '../../src/store/sqlite-memory-store.js';
import { decodeMemoryEntry, memoryFingerprint, observationEvidence } from '../../src/memory-evidence.js';
import { loadConfig } from '../../src/config.js';
import type { MemoryConfig } from '../../src/types.js';
const config=(memoryDir:string)=>({memoryDir,memoryMode:'policy-only',memoryCharLimit:10000,userCharLimit:10000,projectCharLimit:10000,reviewEnabled:false,autoConsolidate:false} as MemoryConfig);
test('provenance survives Markdown, reload, SQLite rebuild, and explicit replacement',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'eigen-evidence-'));const store=new MemoryStore(config(join(dir,'notes')));const db=new DatabaseManager(join(dir,'index'));
  try{
    await store.loadFromDisk();const old='K4 schedule used eight lanes.';
    const evidence={origin:'delegated' as const,sessionId:'parent-session',agentId:'worker',observedAt:'2026-11-24T12:00:00Z',scope:'branch' as const,branch:'packed',evidence:'Source inspection at commit abc.'};
    assert.equal((await store.add('memory',old,undefined,evidence)).success,true);
    const disk=readFileSync(join(dir,'notes','MEMORY.md'),'utf8');assert.match(disk,/evidence64=/);
    assert.doesNotMatch(store.getMemoryEntries().join('\n'),/evidence64/);
    const reload=new MemoryStore(config(join(dir,'notes')));await reload.loadFromDisk();
    reconcileMarkdownMemoryScope(db,reload.getRawEntriesForSync('memory'),'memory','project-a');
    const saved=searchMemories(db,'K4 schedule',{project:'project-a'})[0];assert.deepEqual(saved.evidence,evidence);
    assert.equal((await reload.replace('memory',old,'K4 schedule uses four lanes.',undefined,{origin:'observation',scope:'project',evidence:'Measured corrected result.'})).success,true);
    reconcileMarkdownMemoryScope(db,reload.getRawEntriesForSync('memory'),'memory','project-a');
    const updated=searchMemories(db,'K4 schedule',{project:'project-a'});assert.equal(updated.length,1);
    assert.ok(updated[0].evidence?.supersedes?.includes(memoryFingerprint(old)));assert.equal(updated[0].evidence?.origin,'observation');
    assert.equal(updated[0].evidence?.branch,undefined);
    assert.match(updated[0].evidence?.observedAt??'',/^\d{4}-/);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('legacy records remain readable without fabricated provenance',()=>{
  const old=decodeMemoryEntry('Earlier fact <!-- created=2020-01-01, last=2020-02-02 -->');
  assert.equal(old.text,'Earlier fact');assert.equal(old.created,'2020-01-01');assert.equal(old.evidence,undefined);
  assert.equal(observationEvidence(undefined,{}).origin,'observation');
  assert.equal(observationEvidence(undefined,{PI_SUBAGENT_AGENT_ID:'child'}).origin,'delegated');
});
test('existing SQLite schema gains optional evidence without losing rows',()=>{
  const dir=mkdtempSync(join(tmpdir(),'eigen-schema-'));let manager:DatabaseManager|undefined;
  try{
    const raw=new Database(join(dir,'sessions.db'));
    raw.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, target TEXT NOT NULL CHECK (target IN ('memory','user')), content TEXT NOT NULL, created DATE NOT NULL, last_referenced DATE NOT NULL); INSERT INTO memories VALUES (1,'memory','Old K4 schedule fact','2020-01-01','2020-01-01');");raw.close();
    manager=new DatabaseManager(dir);const columns=manager.getDb().prepare('PRAGMA table_info(memories)').all() as Array<{name:string}>;
    assert.ok(columns.some(c=>c.name==='evidence_json'));
    const results=searchMemories(manager,'K4 schedule');assert.equal(results[0].content,'Old K4 schedule fact');assert.equal(results[0].evidence,undefined);
  }finally{manager?.close();rmSync(dir,{recursive:true,force:true});}
});
test('separate controls and budgets round trip through current configuration',()=>{
  const dir=mkdtempSync(join(tmpdir(),'eigen-controls-'));try{
    const file=join(dir,'config.json');writeFileSync(file,JSON.stringify({eigenRecallEnabled:true,eigenRecallMainEnabled:false,eigenRecallChildEnabled:true,eigenLearningMainEnabled:false,eigenLearningChildEnabled:false,memorySearchEnabled:false,eigenRecallBudgetChars:900}));
    const c=loadConfig(file);assert.equal(c.eigenRecallEnabled,true);assert.equal(c.eigenRecallMainEnabled,false);assert.equal(c.eigenRecallChildEnabled,true);assert.equal(c.eigenLearningMainEnabled,false);assert.equal(c.eigenLearningChildEnabled,false);assert.equal(c.memorySearchEnabled,false);assert.equal(c.eigenRecallBudgetChars,900);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('optional provenance is bounded and cannot carry raw credentials around the content scanner',()=>{
  const raw=decodeMemoryEntry('Fact <!-- created=2020-01-01, last=2020-01-01, evidence64='+Buffer.from(JSON.stringify({origin:'observation',evidence:'HTTP 403 Authorization: Bearer example-secret password=private-secret'})).toString('base64url')+' -->');
  assert.doesNotMatch(raw.evidence?.evidence??'',/example-secret|private-secret/);
});
