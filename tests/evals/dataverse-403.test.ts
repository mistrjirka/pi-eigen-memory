/** The actual Hermes review-write -> Markdown -> SQLite -> search path.
 * This tests persistence and retrieval only. Model-extraction quality is evaluated
 * separately with `evaluations/dataverse-403.ts --learn`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/store/memory-store.js';
import { DatabaseManager } from '../../src/store/db.js';
import { reconcileMarkdownMemoryScope, searchMemories } from '../../src/store/sqlite-memory-store.js';
import type { MemoryConfig } from '../../src/types.js';

const project = 'SBHG-Buddy';
const deniedMetadata = 'Dataverse EntityDefinitions and contact attribute metadata require prvReadEntity; these metadata GETs returned HTTP 403 0x80040220. Do not retry metadata without authorized privilege changes.';
const recordRead = 'Dataverse ordinary GET contacts returned HTTP 200 on 2026-11-11; the 2026-09-30 contact-record 403 was resolved. This does not make metadata endpoints available.';
function config(memoryDir:string):MemoryConfig{
  return {memoryDir,memoryMode:'policy-only',memoryCharLimit:5000,userCharLimit:5000,projectCharLimit:5000,reviewEnabled:false,autoConsolidate:false} as MemoryConfig;
}
async function withFixture(fn:(arg:{global:MemoryStore;projectStore:MemoryStore;db:DatabaseManager})=>Promise<void>){
  const dir=mkdtempSync(join(tmpdir(),'hermes-403-integr-'));
  const db=new DatabaseManager(join(dir,'index'));
  const global=new MemoryStore(config(join(dir,'global')));
  const projectStore=new MemoryStore(config(join(dir,'project')));
  try{
    await global.loadFromDisk();await projectStore.loadFromDisk();
    await fn({global,projectStore,db});
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
}
function sync(db:DatabaseManager,store:MemoryStore){
  const s=reconcileMarkdownMemoryScope(db,store.getRawEntriesForSync('memory'),'memory',project);
  assert.equal(s.degraded,undefined);
}

describe('Dataverse 403 memory replay: infrastructure (not LLM intelligence)',()=>{
  it('persists mocked extraction operations and retrieves the 403 in a later session',async()=>withFixture(async ({global,projectStore,db})=>{
    // This models extractor output already accepted by the core store.
    assert.equal((await projectStore.add('memory',deniedMetadata)).success,true);
    assert.equal((await projectStore.add('memory',recordRead)).success,true);
    sync(db,projectStore);
    const result=searchMemories(db,'Dataverse EntityDefinitions 0x80040220',{project,limit:3});
    assert.ok(result.some(x=>x.content===deniedMetadata));
    const later=searchMemories(db,'contact attribute definitions Dataverse',{project,limit:3});
    assert.ok(later.some(x=>x.content===deniedMetadata));
    assert.equal(searchMemories(db,'Dataverse EntityDefinitions',{project:'other-project'}).length,0);
  }));
  it('removes an outdated contact-access fact without deleting the separately denied metadata fact',async()=>withFixture(async({global,projectStore,db})=>{
    const old='Dataverse contact records cannot be fetched as of 2026-09-30 due to HTTP 403.';
    await projectStore.add('memory',old);
    await projectStore.add('memory',deniedMetadata);
    sync(db,projectStore);
    assert.ok(searchMemories(db,'Dataverse contact records',{project}).some(x=>x.content===old));
    assert.equal((await projectStore.remove('memory',old)).success,true);
    assert.equal((await projectStore.add('memory',recordRead)).success,true);
    sync(db,projectStore);
    const entries=searchMemories(db,'Dataverse contact records',{project});
    assert.ok(!entries.some(x=>x.content===old));
    assert.ok(searchMemories(db,'Dataverse metadata 403',{project}).some(x=>x.content===deniedMetadata));
    assert.ok(searchMemories(db,'Dataverse ordinary contacts',{project}).some(x=>x.content===recordRead));
  }));
});
