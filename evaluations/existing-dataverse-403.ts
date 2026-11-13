/** Query the real memory index strictly read-only. No hit counter increments. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import Sqlite3 from 'better-sqlite3';
import { searchMemories } from '../src/store/sqlite-memory-store.js';
import type { DatabaseManager } from '../src/store/db.js';
const db=new Sqlite3(join(homedir(),'.pi/agent/pi-hermes-memory/sessions.db'),{readonly:true,fileMustExist:true});
const fakeManager={getDb:()=>db} as DatabaseManager;
const queries=[
  'Dataverse EntityDefinitions 0x80040220',
  'Can we inspect contact attribute definitions in Dataverse?',
  'Dynamics CRM incident schema access permissions',
  'Need to inspect ticket requester relation to employee identity',
  'Is it still forbidden to fetch contact records from Dataverse?',
  'Check relationship metadata for case customer without extra privilege',
];
try{
  for(const query of queries){
    const t=performance.now();const hits=searchMemories(fakeManager,query,{project:'SBHG-Buddy',limit:5});
    const metadata=hits.findIndex(x=>/metadata|entitydefinitions|attributes/i.test(x.content)&&/403|0x80040220/i.test(x.content));
    const fresh=hits.findIndex(x=>/contact/i.test(x.content)&&/200/.test(x.content)&&/2026-11-11|now/.test(x.content));
    const old=hits.findIndex(x=>/contact.*403|403.*contact/i.test(x.content)&&!/200/.test(x.content));
    console.log(JSON.stringify({query,hits:hits.length,metadataRank:metadata<0?null:metadata+1,freshRank:fresh<0?null:fresh+1,staleContactRank:old<0?null:old+1,latencyMs:Math.round((performance.now()-t)*100)/100,top:hits.slice(0,3).map(h=>({id:h.id,created:h.created,metadata403:/metadata|entitydefinitions|attributes/i.test(h.content)&&/403|0x80040220/i.test(h.content),contact200:/contacts?/i.test(h.content)&&/200/.test(h.content)}))}));
  }
}finally{db.close()}
