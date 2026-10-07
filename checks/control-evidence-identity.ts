#!/usr/bin/env node
// A change withdraws exactly the approval of the snapshot it displaced. An id that named only the
// path withdrew every approval of it, later ones included, because the kernel's withdrawn set is
// order-independent; an id that named only the public version could not tell two approvals of one
// version apart — an approved document given a metadata-only correction is a new snapshot of the
// SAME version, approved again later, and the correction must withdraw the first approval and not
// the second. So a document or approval id names the snapshot within its public version,
// `@v<version>.<revision>`. The fix is the id the writer MINTS and the withdrawal it writes, so
// this asserts the writer's own minting function, then drives the built `noteRevision` and
// `noteDocument` over a recording stub of the control-loop store (`pg.Pool.prototype.query`,
// answered in process — no database) and asserts the `supersedes` each row is written with: a new
// version, a same-version draft, a re-approval, and a displaced snapshot the run never recorded an
// approval of. The kernel's own behaviour over that log is `scripts/control-loop-e2e.ts`.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

// The store is reached through the platform pool, which exists only with TEAM_DB_URL set; every
// statement it sends is answered below, so nothing connects to this address.
process.env.TEAM_DB_URL = "postgres://stub@127.0.0.1:1/stub";
const run = { id: "run-1", held: new Set<string>(), rows: [] as { entry_id: string; supersedes: string | null }[] };
pg.Pool.prototype.query = (async (text: string, values: unknown[] = []) => {
  if (/from zz\.control_run r/.test(text)) return { rows: [{ id: run.id, started_by: null, initiative: "i", module_digest: "d" }] };
  if (/select entry_id from zz\.control_evidence/.test(text)) return { rows: [...run.held].map((entry_id) => ({ entry_id })) };
  if (/insert into zz\.control_evidence/.test(text)) {
    const row = { entry_id: String(values[1]), supersedes: values[5] === null ? null : String(values[5]) };
    run.rows.push(row);
    run.held.add(row.entry_id);
    return { rows: [] };
  }
  throw new Error(`control-evidence-identity: the stub store was sent a statement it does not answer: ${text.slice(0, 80)}`);
}) as unknown as typeof pg.Pool.prototype.query;
const observe = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/host/observe.js")).href);

const mint = observe.evidenceEntryId;
assert.equal(typeof mint, "function", "the writer exposes one pure function that mints an entry id");

const doc = (p: string, v: number, r: number) => mint({ kind: "document", path: p, at: { version: v, revision: r } });
const approval = (p: string, v: number, r: number) => mint({ kind: "approval", path: p, at: { version: v, revision: r } });
const audit = (p: string) => mint({ kind: "audit", path: p });

assert.equal(doc("spec.md", 1, 1), "doc:spec.md@v1.1");
assert.equal(doc("spec.md", 2, 3), "doc:spec.md@v2.3");
assert.equal(approval("spec.md", 1, 1), "approval:spec.md@v1.1");
assert.equal(approval("spec.md", 2, 4), "approval:spec.md@v2.4");
assert.notEqual(approval("spec.md", 2, 3), approval("spec.md", 2, 4),
  "two approvals of one public version are two facts");
assert.equal(audit("sources/x.md"), "audit:sources/x.md");

// The log the writer produces: write, approve, a new version, approve it, a metadata-only draft of
// that approved version, approve again — driven through the built recorders, each row as written.
const I = "2026-10-07-identity";
const P = `${I}/spec.md`;
const chain = { name: "sdlc-flow", stages: [{ name: "sdlc-spec", produces: "spec.md" }] };
const at = (version: number, revision: number) => ({ version, revision });
const last = () => run.rows.at(-1);
await observe.noteDocument(chain, P, "document", at(1, 1), "a@example.test", "team");
await observe.noteDocument(chain, P, "approval", at(1, 1), "a@example.test", "team");
await observe.noteRevision(chain, P, at(2, 2), at(1, 1), "a@example.test", "team");
assert.deepEqual(last(), { entry_id: doc(P, 2, 2), supersedes: approval(P, 1, 1) },
  "a new version withdraws the approval it replaced");
await observe.noteDocument(chain, P, "approval", at(2, 2), "a@example.test", "team");
await observe.noteRevision(chain, P, at(2, 3), at(2, 2), "a@example.test", "team");
assert.deepEqual(last(), { entry_id: doc(P, 2, 3), supersedes: approval(P, 2, 2) },
  "a same-version draft withdraws the approval of the snapshot it displaced");
await observe.noteDocument(chain, P, "approval", at(2, 3), "a@example.test", "team");
assert.deepEqual(last(), { entry_id: approval(P, 2, 3), supersedes: null }, "an approval withdraws nothing");
// A displaced snapshot nobody's approval of was recorded is a withdrawal of nothing, not of a
// neighbour: the run holds approvals of v1.1, v2.2 and v2.3, and v3.4 is displaced next.
await observe.noteRevision(chain, P, at(3, 5), at(3, 4), "a@example.test", "team");
assert.deepEqual(last(), { entry_id: doc(P, 3, 5), supersedes: null },
  "a displaced snapshot whose approval the run never recorded withdraws nothing");

const ids = run.rows.map((e) => e.entry_id);
assert.equal(ids.length, 7, `every recorder call wrote one row: ${JSON.stringify(run.rows)}`);
assert.equal(new Set(ids).size, ids.length, "every fact in one run has its own id");
assert.ok(!run.rows.some((e) => e.supersedes === approval(P, 2, 3)),
  "and nothing withdraws the approval that came after it — the bug was that this one did not count");

console.log("ok control-evidence-identity");
