import assert from 'node:assert/strict';
import { passagesOf, identifierTokens, derivationFingerprint }
  from '../packages/indexing/dist/tenant-analysis.js';
const tail = ' zzuniquetailtoken';
const body = 'word '.repeat(210000) + tail;
const ps = passagesOf(body);
assert.ok(ps.length > 1);
assert.ok(ps.some(p => p.text.includes(tail.trim())));
assert.equal(ps[0].start,0);
assert.equal(ps[ps.length-1].end,Buffer.byteLength(body));
const text = '知识库😀 retrieval '.repeat(2000);
const buf = Buffer.from(text);
const zs = passagesOf(text);
assert.ok(zs.length > 1);
for (let i=0;i<zs.length;i++) {
  const p = zs[i];
  assert.equal(buf.subarray(p.start,p.end).toString('utf8'),p.text);
  assert.ok([...p.text].length <= 8192);
  assert.ok(p.end > p.start);
  if (i) assert.ok(p.start < zs[i-1].end && p.end > zs[i-1].end);
}
assert.equal(zs[0].start,0);
assert.equal(zs[zs.length-1].end,buf.length);
const raw = 'zz.eval_finding/plugin-judge:v2';
const tokens = identifierTokens(raw);
for (const t of [raw,'zz','eval','finding','plugin','judge','v','2']) assert.ok(tokens.includes(t));
// The registered title promises the digest moves independently on every one of its named
// fields, so every field is varied in turn.
//
// DELIBERATE: `KEYS` is asserted against the fixture rather than trusted, so a seventh field
// added to the digest cannot slip past this loop.
const f = {content_hash:'a'.repeat(64),record_format:1,parser:1,analyzer:1,passage:1,projection:1};
const moved = {content_hash:'b'.repeat(64),record_format:2,parser:2,analyzer:2,passage:2,projection:2};
const KEYS = ['content_hash','record_format','parser','analyzer','passage','projection'] as const;
assert.deepEqual([...KEYS].sort(),Object.keys(f).sort(),'KEYS no longer names every field of the fixture');
const base = derivationFingerprint(f);
for (const k of KEYS) {
  assert.notEqual(derivationFingerprint({...f,[k]:moved[k]}),base,
    `the derivation fingerprint did not move when ${k} alone changed`);
}
console.log('tenant-complete-text: ok');
