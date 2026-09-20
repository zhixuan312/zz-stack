import assert from 'node:assert/strict';
import { createAdapterFixture } from '../testing/tenant-info/model.ts';
const f = await createAdapterFixture();
try {
  const original = await f.seedDocument({body:'one'});
  const missing = await f.patch({ref:original.ref,body:'two',idempotency_key:'missing-etag'});
  assert.equal(missing.committed,false);
  const request = {ref:original.ref,body:'two',expected_etag:original.etag,idempotency_key:'edit-1'};
  const first = await f.patch(request);
  assert.equal(first.committed,true);
  assert.ok(original.ref.revision !== null);
  assert.equal(first.revision,original.ref.revision + 1);
  const retry = await f.patch(request);
  assert.equal(retry.transaction_id,first.transaction_id);
  const stale = await f.patch({...request,body:'three',idempotency_key:'edit-2'});
  assert.equal(stale.code,'REVISION_CONFLICT');
  const wrongApproval = await f.approve({ref:original.ref,record_digest:original.record_digest,
    expected_etag:original.etag,idempotency_key:'approve-old'});
  assert.equal(wrongApproval.committed,false);
  assert.equal((await f.read(first.artifact_id)).body,'two');
} finally { await f.close(); }
console.log('tenant-single-writer: ok');
