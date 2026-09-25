#!/usr/bin/env node
// A conversation that lost a verifier_token gets a new one for the SAME allocation, and the old
// one stops working: `rotateVerifierToken` revokes the live row and mints a replacement carrying
// its candidate, case set, released subject and expiry. Found by scripts/eval-flow-e2e.ts:
// release_verify and candidate_prove each returned the plaintext once, so a PROMOTE/VERIFY or a
// proof resumed in a new conversation could not replay another run — only wait out the liveness
// bound, or abandon and spend the proof split. The walk drops the token between two
// release_verify calls and continues from a fresh conversation with `rotate_token: true`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { rotateVerifierToken } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/replay-verifier.js")).href);

const OLD = "11111111-1111-1111-1111-111111111111";
const sql: { text: string; params: unknown[] }[] = [];
const live = {
  async query(text: string, params: unknown[] = []) {
    sql.push({ text, params });
    if (/^\s*update zz\.replay_verifier_token set revoked_at/.test(text)) {
      return { rows: [{ candidate_id: "c-1", case_set_id: "cs-1", released: "sv-2", expires_at: "2099-01-01T00:00:00Z" }], rowCount: 1 };
    }
    if (/insert into zz\.replay_verifier_token/.test(text)) return { rows: [{ id: "22222222-2222-2222-2222-222222222222" }], rowCount: 1 };
    throw new Error(`unexpected query: ${text}`);
  },
};

const rotated = await rotateVerifierToken(live, OLD);
assert.ok(rotated, "a live token rotates");
assert.equal(rotated.id, "22222222-2222-2222-2222-222222222222");
assert.match(rotated.token, /^[0-9a-f]{64}$/, "the new plaintext is a fresh 32-byte secret");
const [revoke, insert] = sql;
assert.deepEqual(revoke.params, [OLD], "the revocation names exactly the old row");
assert.match(revoke.text, /revoked_at is null and expires_at > now\(\)/, "only a live token is rotated");
assert.equal(insert.params[0], createHash("sha256").update(rotated.token).digest("hex"), "only the new token's hash is stored");
assert.deepEqual(insert.params.slice(1), ["c-1", "cs-1", "sv-2", "2099-01-01T00:00:00Z"],
  "the new token is bound to the same candidate, case set, released subject and expiry");

// A token already revoked or expired is not resurrected under a new secret.
const dead = { async query() { return { rows: [], rowCount: 0 }; } };
assert.equal(await rotateVerifierToken(dead, OLD), null);

console.log("ok eval-verifier-rotate");
