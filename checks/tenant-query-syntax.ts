import assert from 'node:assert/strict';
import { parseQuery, serializeResults } from '../services/zz-core/dist/tenant-info/retrieval.js';
import { SearchResponseSchema } from '../packages/contracts/dist/index.js';
const q=parseQuery('"exact phrase" alpha OR beta -gamma','natural');
assert.ok(q.phrases.includes('exact phrase'));
assert.ok(q.exclusions.includes('gamma'));
const path='services/zz-core/src/tenant-info/retrieval.ts';
assert.equal(parseQuery(path,'natural').original_text,path);
assert.deepEqual(parseQuery(path,'natural').exclusions,[]);
assert.throws(()=>parseQuery('"unterminated','natural'),
  (e: unknown)=>e instanceof Error && 'code' in e && e.code==='INVALID_INPUT');
assert.equal(parseQuery('"unterminated','websearch').mode,'websearch');
const owner='11111111-1111-4111-8111-111111111111';
const text='知识😀'.repeat(200), snippet=text.slice(0,400);
const rows=Array.from({length:50},(_,i)=>({
  ref:{owner_id:owner,artifact_id:`22222222-2222-4222-8222-${String(i).padStart(12,'0')}`,
    revision:1,content_hash:'a'.repeat(64)},record_digest:'b'.repeat(64),etag:'1:1',
  path:`fixture-${i}.md`,title:`Fixture ${i}`,artifact_class:'work_document',type:'ground',
  scope:'current',shelf:'team',gate_status:null,knowledge_status:null,profile:'native',
  source_refs:[],source_refs_truncated:false,source_refs_cursor:null,
  snippet,snippet_byte_start:0,snippet_byte_end:Buffer.byteLength(snippet),
  via:['lexical'],corpora:['team-fixture'],score:1/(61+i)}));
const wire=serializeResults(rows,{index_generation:'fixture-generation',indexed_through:{[owner]:1},
  candidate_total:50,mode_used:'natural',incomplete:false,reasons:[]});
assert.ok(Buffer.byteLength(wire,'utf8')<=24000);
const response=JSON.parse(wire);
assert.equal(SearchResponseSchema.safeParse(response).success,true);
assert.equal(response.schema_version,2);
assert.equal(response.returned,response.results.length);
assert.ok(response.results.length>0 && response.results.length<50);
assert.equal(response.incomplete,true);
assert.ok(response.reasons.includes('response_budget'));
assert.equal(response.withheld_candidates,50-response.results.length);
console.log('tenant-query-syntax: ok');
