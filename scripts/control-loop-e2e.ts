#!/usr/bin/env node
/**
 * control-loop-e2e.ts — drive a real initiative through the real doors and check that the
 * control loop refuses and grants the way the flow declares.
 *
 * `scripts/gate.ts` is offline and proves things about the source; it never opens a database or
 * calls a door. The question here is whether a run recorded through the platform reaches a
 * grant, which no offline check can answer.
 *
 *   ZZ_E2E_URL=http://127.0.0.1:18000/core/mcp ZZ_E2E_PAT=zzp_… \
 *   ZZ_E2E_DB=postgresql://… node scripts/control-loop-e2e.ts
 *
 * It refuses to run against anything but loopback. This writes an initiative, four documents,
 * two sources and a close into whatever store it is pointed at.
 */
import pg from "pg";

const URL_ = process.env.ZZ_E2E_URL ?? "";
const PAT = process.env.ZZ_E2E_PAT ?? "";
const DB = process.env.ZZ_E2E_DB ?? "";

/**
 * Where this may be aimed: loopback, and nothing else.
 *
 * An allowlist, not a blocklist, so it fails closed. A blocklist has to name every store that
 * must not be touched and fails open for the one somebody forgot or the one that gets a new
 * address next month; anything that is not plainly a local scratch container is refused here,
 * and a second deployment tomorrow is refused without anybody adding it. It also means this
 * file names no production address.
 */
const LOOPBACK = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?([/?]|$)/;
const localDb = (url: string): boolean =>
  /@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url);

function refuseUnlessScratch(): string | null {
  if (!URL_ || !PAT || !DB) {
    return "REFUSED — set ZZ_E2E_URL, ZZ_E2E_PAT and ZZ_E2E_DB. There is no default, " +
           "deliberately: a default is how a test finds a store nobody meant to give it.";
  }
  if (!LOOPBACK.test(URL_)) {
    return "REFUSED — ZZ_E2E_URL is not a loopback address. This test writes an initiative, " +
           "four documents, two sources and a close; it runs against a scratch container on " +
           "this machine and nothing else.";
  }
  if (!localDb(DB)) {
    return "REFUSED — ZZ_E2E_DB does not point at a database on this machine, and this test " +
           "writes evidence rows into whichever one it is given.";
  }
  return null;
}

interface CallResult { readonly text: string }

async function call(tool: string, args: Record<string, unknown>): Promise<CallResult> {
  const res = await fetch(URL_, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PAT}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const body = await res.text();
  // The door answers as an SSE frame; the payload is the one `data:` line.
  const line = body.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? body;
  try {
    const parsed = JSON.parse(line) as
      { result?: { content?: { text?: string }[] }; error?: unknown };
    return { text: parsed.result?.content?.[0]?.text ?? JSON.stringify(parsed.error ?? parsed) };
  } catch { return { text: line }; }
}

/** One expectation, stated before it is checked, so a reader of the output knows what was
 *  being asked rather than only what came back. */
function expect(label: string, holds: boolean, saw: string): boolean {
  console.log(`  ${holds ? "PASS" : "FAIL"}  ${label}`);
  if (!holds) console.log(`        saw: ${saw.slice(0, 220)}`);
  return holds;
}

async function main(): Promise<void> {
  const refusal = refuseUnlessScratch();
  if (refusal) { console.error(`  ${refusal}`); process.exit(2); }

  const pool = new pg.Pool({ connectionString: DB, connectionTimeoutMillis: 10_000 });
  const slug = `control-loop-e2e-${Date.now().toString(36)}`;
  let ok = true;

  const opened = await call("initiative_open", { slug, flow: "sdlc-flow" });
  const name = (JSON.parse(opened.text) as { initiative: string }).initiative;
  ok = expect("initiative_open reports the flow governs it and opens a run",
    opened.text.includes('"governed_by": "sdlc-flow"') && opened.text.includes('"control_run"'),
    opened.text) && ok;

  const doc = async (p: string, content: string) => call("document_write", { path: `${name}/${p}`, content });
  const sign = async (p: string) => call("document_approve", { path: `${name}/${p}` });

  await doc("explore.md", "## Background\nx\n\n## Current state\nx\n\n## Rough direction\nx\n");
  await doc("spec.md", "## Context\nx\n\n## Problem\nx\n\n## Goals & Requirements\nx\n\n## Alternatives\nx\n\n## Approach, Method & Structure\nx\n\n## Verification Plan\nx\n\n## Risks & Mitigations\nx\n\n## Stakeholders & Work\nx\n");
  await sign("spec.md");
  await doc("plan.md", "## Full-suite gate\nx\n");
  await sign("plan.md");
  await doc("review.md", "## Verdict\nx\n");
  await sign("review.md");

  // Every document the flow declares is written and approved, so `documentGuards` is fully
  // satisfied — and two audit rounds never happened.
  const early = await call("initiative_close", { initiative: name, disposition: "finished" });
  ok = expect("a close is REFUSED when the documents are complete but the audits never ran",
    early.text.includes("cannot claim close:initiative") && early.text.includes("needs 1 audit"),
    early.text) && ok;

  await call("source_add", { initiative: name, title: "spec audit", content: "no blocking findings", supports: ["spec.md"] });
  await call("source_add", { initiative: name, title: "plan audit", content: "no blocking findings", supports: ["plan.md"] });

  const { rows } = await pool.query(
    `select e.step_id, e.kind, e.about from zz.control_evidence e
       join zz.control_run r on r.id = e.run_id
      where r.initiative = $1 order by e.seq`, [name]);
  const audits = rows.filter((r: { kind: string }) => r.kind === "audit");
  ok = expect("source_add records the audit evidence, against the document it supports",
    audits.length === 2 && audits.every((a: { about: string }) => a.about.startsWith(`doc:${name}/`)),
    JSON.stringify(audits)) && ok;
  // The back-reference, checked as a shape rather than assumed from a passing grant. A grant
  // can be reached by a graph that is wrong in a way that happens not to matter yet.
  const approvals = rows.filter((r: { kind: string }) => r.kind === "approval");
  ok = expect("every approval points at the ID of a document entry, not at a filename",
    approvals.length === 3 && approvals.every((a: { about: string }) => a.about.startsWith(`doc:${name}/`)),
    JSON.stringify(approvals)) && ok;

  const late = await call("initiative_close", { initiative: name, disposition: "finished" });
  ok = expect("the close is GRANTED once the declared procedure is complete",
    late.text.includes("closed as") && !late.text.includes("cannot claim"), late.text) && ok;

  await pool.end();
  console.log(ok ? "\n  control-loop-e2e: ok" : "\n  control-loop-e2e: FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(`  FAILED — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
