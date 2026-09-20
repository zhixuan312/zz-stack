import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMigrationFixture } from '../testing/tenant-info/migration.ts';
const f=await createMigrationFixture();
const raw='---\r\ntype: ForeignType\r\ntitle: A\r\n---\r\nbody\r\n';
const bad='---\ntype: [broken\n---\nbody';
try {
  await f.addInput('a.md',Buffer.from(raw));
  await f.addInput('bad.md',Buffer.from(bad));
  const manifest=await f.prepare();
  await f.apply(manifest);
  const first=await f.inspect();
  await f.apply(manifest);
  const second=await f.inspect();
  assert.deepEqual(second.identities,first.identities);
  assert.equal(second.revisions,first.revisions);
  assert.equal(second.events,first.events);
  assert.ok(first.revisions>0 && first.events>0);
  assert.equal((await f.originalBytes('a.md')).toString(),raw);
  assert.equal((await f.originalBytes('bad.md')).toString(),bad);
  const row=first.manifest.find(x=>x.path==='a.md');
  assert.ok(row);
  assert.equal(row.sha256,createHash('sha256').update(raw).digest('hex'));
  assert.equal(row.original_time,null);
  assert.equal(first.manifest.find(x=>x.path==='bad.md')?.profile,'legacy-raw');
} finally { await f.close(); }
console.log('tenant-migration-losslessness: ok');
