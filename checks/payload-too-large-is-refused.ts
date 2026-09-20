// New artifact text over 8 MiB is refused by the kernel, with the code the contract declares.
//
// WHY THIS CHECK EXISTS AND NOT JUST THE LIMIT. Both halves of this rule shipped with no
// behaviour behind them, in opposite directions, and both were green the whole time:
//
//   `assertWithinInputLimit`/`MAX_INPUT_BYTES` (packages/indexing) were built, exported and
//   mutation-tested — and every reference to either one in the entire checkout belonged to
//   `checks/tenant-passage-analysis.ts`, the check that tests them. No commit path called
//   either.
//
//   `PAYLOAD_TOO_LARGE` has been one of the twelve declared mutation error codes since the
//   contracts task. Nothing emitted it.
//
// So the spec promised a kernel gate, a frozen check proved the gate function worked, and no
// write ever passed through it. A check that imports the thing it tests can never discover
// that nothing else imports it — which is why this one goes through the REAL registered
// adapter and the REAL kernel, and asserts on the refusal a caller would actually receive.
//
// The limit is measured on the canonical payload, so a body under the ceiling still commits:
// a guard that refuses everything would satisfy the negative case and break the product.
import assert from "node:assert/strict";

import { MAX_INPUT_BYTES } from "@zz/indexing";

import { createAdapterFixture } from "../testing/tenant-info/model.ts";

const f = await createAdapterFixture();
try {
  const seeded = await f.seedDocument({ body: "small enough\n" });

  // Comfortably over, built from one repeated ASCII scalar so byte length and character
  // length agree and the fixture's size is the size being tested.
  const oversized = "x".repeat(MAX_INPUT_BYTES + 1024);
  const refused = await f.patch({
    ref: seeded.ref, body: oversized,
    expected_etag: seeded.etag, idempotency_key: "oversized-1",
  });
  assert.equal(refused.committed, false,
    "a payload over the 8-MiB ceiling must be refused before commit, not stored");
  assert.equal(refused.code, "PAYLOAD_TOO_LARGE",
    `the contract declares PAYLOAD_TOO_LARGE for exactly this; got ${JSON.stringify(refused.code)}. ` +
    "INVALID_INPUT would tell a caller its request was malformed, which it was not");

  // The refusal is BEFORE commit, so nothing moved: same revision, same bytes.
  const after = await f.read(seeded.ref.artifact_id);
  assert.equal(after.body, "small enough\n",
    "a refused oversized write must leave the stored content exactly as it was");

  // And the guard is not a blanket refusal — an ordinary write through the same path still
  // commits, against the etag the refused attempt did not consume.
  const accepted = await f.patch({
    ref: seeded.ref, body: "still small\n",
    expected_etag: seeded.etag, idempotency_key: "small-1",
  });
  assert.equal(accepted.committed, true,
    "an under-limit write must still commit — a guard that refuses everything is not a guard");
} finally {
  await f.close();
}
console.log("payload-too-large-is-refused: ok");
