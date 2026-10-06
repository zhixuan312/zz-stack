#!/usr/bin/env node
/**
 * control-loop-e2e.ts — drive one governed initiative through the real doors and check that the
 * control loop records and answers the way the flow declares.
 *
 * `scripts/gate.ts` is offline and proves things about the source; it never opens a database or
 * calls a door. `checks/control-evidence-identity.ts` proves what the id-minting function returns
 * and nothing about a run. The question here is whether a log the writer actually wrote replays
 * through the store into a grant, which no offline check can answer.
 *
 * The sequence it walks is the one the fix is about: a document written, approved, changed and
 * approved again — twice. The first change opens a new version; the second changes only metadata,
 * which turns the approved snapshot into a draft of the SAME version. Each change withdraws the
 * approval of the snapshot it displaced and nothing else, so every approval after it is a fact of
 * its own and the close that waits on it is granted. Evidence ids name the snapshot,
 * `@v<version>.<revision>`, because two approvals of one public version are two facts. The
 * previous writer recorded one approval id for every approval of a document, and a revision then
 * withdrew every approval of that path — the one it replaced and the one that answered it — so a
 * re-approval counted for nothing. This walks that out through the store rather than through the
 * minting function alone: the log is in a real database, replayed into a fresh kernel by
 * `claimFor`, and the answer read back is the one `initiative_close` gives.
 *
 *   node scripts/control-loop-e2e.ts            stand a scratch deployment up, walk, tear it down
 *   node scripts/control-loop-e2e.ts --keep     leave it up afterwards, for reading
 *
 * It needs docker and runs for about a minute, so it is not a gate check.
 *
 * Loopback only, and the allowlist is fail-closed: a deployment handed in by ZZ_E2E_URL,
 * ZZ_E2E_PAT and ZZ_E2E_DB is checked before anything is written, because this writes an
 * initiative, four documents, four sources and a close into whatever it is pointed at.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { postgresService } from "./release/postgres-service.ts";

/** The tree the deployment serves. The containers mount it and run the compiled services out of
 *  it, so what is walked is this checkout rather than an image built from it at some other time. */
const live = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The superadmin the scratch deployment seeds, and the one team it makes them admin of.
 *  `.invalid` is reserved (RFC 2606) and is never a real address. */
const OPERATOR = "control-loop@zz.invalid";
const TEAM = "controlloop";

/**
 * Where this may be aimed: loopback, and nothing else.
 *
 * An allowlist, not a blocklist, so it fails closed. A blocklist has to name every deployment that
 * must not be touched and fails open for the one somebody forgot or the one that gets a new
 * address next month; anything that is not plainly a local scratch deployment is refused here, and
 * a second deployment tomorrow is refused without anybody adding it. It also means this file names
 * no production address.
 */
const LOOPBACK = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?([/?]|$)/;
const localDb = (url: string): boolean =>
  /@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url);

function refuseUnlessScratch(url: string, pat: string, db: string): string | null {
  if (!url || !pat || !db) {
    return "REFUSED — no gateway, token or database to walk against.";
  }
  if (!LOOPBACK.test(url)) {
    return "REFUSED — the gateway is not a loopback address. This walk writes an initiative, " +
           "four documents, four sources and a close; it runs against a scratch deployment on " +
           "this machine and nothing else.";
  }
  if (!localDb(db)) {
    return "REFUSED — the database does not point at a database on this machine, and this walk " +
           "writes evidence rows into whichever one it is given.";
  }
  return null;
}

function sh(cmd: string, args: string[]): string {
  return String(execFileSync(cmd, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 << 20,
  })).trim();
}

const quiet = (cmd: string, args: string[]): void => {
  try { execFileSync(cmd, args, { stdio: "ignore" }); } catch { /* already gone */ }
};

function waitFor(what: string, attempt: () => boolean, limitSeconds = 180): void {
  for (let i = 0; ; i += 1) {
    if (attempt()) return;
    if (i > limitSeconds) throw new Error(`the scratch deployment never became ready: ${what}`);
    execFileSync("sleep", ["1"]);
  }
}

/** A deployment this walk can drive: where the gateway answers, the token it answers to, and the
 *  database behind it — which is read directly, because half of what is asserted here is what the
 *  log actually holds rather than what a tool said about it. */
interface Deployment {
  readonly prefix: string | null;   // null for one handed in rather than stood up here
  readonly url: string;
  readonly pat: string;
  readonly db: string;
}

interface CallResult { readonly text: string }

async function call(url: string, pat: string, tool: string, args: Record<string, unknown>): Promise<CallResult> {
  const res = await fetch(`${url}/core/mcp`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${pat}`,
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

/** A reply's first line — where a change's receipt says which version it landed in. */
const firstLine = (text: string): string => text.split("\n")[0] ?? "";

/** One expectation, stated before it is checked, so a reader of the output knows what was
 *  being asked rather than only what came back. */
function expect(label: string, holds: boolean, saw: string | undefined): boolean {
  console.log(`  ${holds ? "PASS" : "FAIL"}  ${label}`);
  // `saw` is often `JSON.stringify` of a row that was not found, which is undefined — a failure
  // must still print, never end the walk.
  if (!holds) console.log(`        saw: ${String(saw).slice(0, 400)}`);
  return holds;
}

/** Whether the gateway reached zz-core: the gateway answers while zz-core is still booting, with
 *  a JSON-RPC error, so only a real tool answer says the deployment is up. */
async function answers(url: string, pat: string): Promise<boolean> {
  try {
    const said = await call(url, pat, "session_whoami", {});
    return !said.text.startsWith("ERROR") && said.text.includes("today");
  } catch { return false; }
}

async function waitForAsync(what: string, attempt: () => Promise<boolean>, limitSeconds = 180): Promise<void> {
  for (let i = 0; ; i += 1) {
    if (await attempt()) return;
    if (i > limitSeconds) throw new Error(`the scratch deployment never became ready: ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const PAT_OF = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * Stand a scratch deployment up: postgres, the gateway and zz-core, on a network of their own,
 * from this working tree, with a first token minted the way a fresh install mints one.
 *
 * The shape is `scripts/eval-flow-e2e/stack.ts`'s and the release rehearsal's: the deployment's own
 * postgres image and command (read from `deploy/docker-compose.yml`, never written down a second
 * time), a network rather than links so `cred-proxy` resolves the way the deployment's compose
 * network resolves it — zz-core's default trusted peer is that name — the superadmin seeded from
 * the gateway's environment, and a PAT row inserted beside it.
 *
 * The gateway comes up first and alone: it is what applies `services/gateway/migrations/`, and
 * zz-core's boot reindexes against a schema that has to be there. Nothing here touches another
 * container — every name carries this process's own prefix, and `down` removes exactly what `up`
 * created.
 */
async function up(): Promise<Deployment> {
  const prefix = `zz-control-${process.pid}`;
  const net = `${prefix}-net`, pgName = `${prefix}-pg`, core = `${prefix}-core`, gw = `${prefix}-gw`;
  sh("docker", ["network", "create", net]);

  const pgsvc = postgresService(live);
  sh("docker", ["run", "-d", "--name", pgName, "--network", net, "--network-alias", "postgres",
    "-e", "POSTGRES_USER=zz", "-e", "POSTGRES_PASSWORD=controlloop", "-e", "POSTGRES_DB=zz",
    "-p", "127.0.0.1:0:5432", pgsvc.image, ...pgsvc.command]);
  waitFor("postgres", () => {
    try { sh("docker", ["exec", pgName, "pg_isready", "-U", "zz", "-d", "zz"]); return true; }
    catch { return false; }
  });
  const pgPort = (sh("docker", ["port", pgName, "5432/tcp"]).split("\n")[0] ?? "").split(":").pop() ?? "";
  if (!pgPort) throw new Error("postgres started but docker published no port for it");

  // Fixed rather than `127.0.0.1:0`, which docker re-picks on every restart: the gateway's own
  // origin is written into its environment, and it has to be the address this walk calls.
  const gwPort = sh("node", ["-e",
    "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"]);

  const inDb = "postgresql://zz:controlloop@postgres:5432/zz";
  const mounts = ["-v", `${live}:${live}`, "-v", `${live}/skills:/skills:ro`,
    "-v", `${live}/catalog:/catalog:ro`, "-w", live,
    "--add-host", "host.docker.internal:host-gateway",
    "-e", `ZZ_CATALOG_DIR=${live}/catalog`, "-e", `ZZ_SKILLS_DIR=${live}/skills`,
    "-e", `TEAM_DB_URL=${inDb}`];

  const q = (sql: string): string =>
    sh("docker", ["exec", pgName, "psql", "-U", "zz", "-d", "zz", "-tAc", sql]);

  sh("docker", ["run", "-d", "--name", gw, "--network", net, "--network-alias", "cred-proxy", ...mounts,
    "-e", `SUPERADMIN_EMAIL=${OPERATOR}`, "-e", `BOOTSTRAP_TEAM=${TEAM}`,
    "-e", `GATEWAY_PUBLIC_URL=http://127.0.0.1:${gwPort}`, "-p", `127.0.0.1:${gwPort}:8000`,
    "node:24", "node", "services/gateway/dist/server.js"]);
  waitFor("the gateway's own boot", () => {
    try {
      return q(`select count(*) from zz.membership m join zz.principal p on p.id = m.principal_id ` +
               `where p.email = '${OPERATOR}'`) === "2";
    } catch { return false; }
  });

  sh("docker", ["run", "-d", "--name", core, "--network", net, "--network-alias", "zz-core", ...mounts,
    "node:24", "node", "services/zz-core/dist/server.js"]);

  // COUPLED: the row `deploy/issue-first-pat.sh` writes, as `stack.ts` does. The label names one
  // purpose, so the token a previous run left under it is revoked before this one is written; both
  // statements go in one request wrapped in a transaction, so the revoke cannot outlive a failed
  // insert.
  const pat = `zzp_${randomBytes(24).toString("hex")}`;
  q(`begin;
     update zz.pat set revoked_at = now()
       where principal_id = (select id from zz.principal where email = '${OPERATOR}')
         and label = 'control-loop-e2e' and revoked_at is null;
     insert into zz.pat (principal_id, token_hash, label)
       select id, '${PAT_OF(pat)}', 'control-loop-e2e' from zz.principal where email = '${OPERATOR}';
     commit;`);

  const url = `http://127.0.0.1:${gwPort}`;
  await waitForAsync("zz-core behind the gateway", () => answers(url, pat));
  return { prefix, url, pat, db: `postgresql://zz:controlloop@127.0.0.1:${pgPort}/zz` };
}

function down(deployment: Deployment): void {
  if (!deployment.prefix) return;   // handed in: not this walk's to remove
  // `-v` for the same reason `scripts/schema/throwaway.ts` needs it: the postgres image declares
  // its data directory as a VOLUME, so `rm -f` alone leaves an anonymous volume behind on every
  // walk. The gateway and core containers have none, and `-v` on them removes nothing.
  for (const c of ["gw", "core", "pg"]) quiet("docker", ["rm", "-f", "-v", `${deployment.prefix}-${c}`]);
  quiet("docker", ["network", "rm", `${deployment.prefix}-net`]);
}

/** One evidence row as the database holds it. Read directly rather than asked of a tool: what is
 *  asserted here is the log itself — which ids exist, what each points at, and what it withdrew. */
interface Row {
  readonly seq: string;
  readonly entry_id: string;
  readonly step_id: string;
  readonly kind: string;
  readonly about: string;
  readonly supersedes: string | null;
}

/** One statement against the deployment's own database. Opened per call: this is a walk of a
 *  dozen reads, and a pool held open across it would be one more thing to close on the failure
 *  path. */
async function rowsOf<T>(dsn: string, text: string, values: readonly unknown[] = []): Promise<T[]> {
  const pool = new pg.Pool({ connectionString: dsn, connectionTimeoutMillis: 10_000 });
  try { return (await pool.query(text, [...values])).rows as T[]; } finally { await pool.end(); }
}

const evidence = (dsn: string, runId: string): Promise<Row[]> =>
  rowsOf<Row>(dsn,
    // `ce.seq`, qualified: a bare `seq` names the text output column and sorts "10" before "2".
    `select seq::text, entry_id, step_id, kind, about, supersedes
       from zz.control_evidence ce where run_id = $1 order by ce.seq`, [runId]);

const digestOf = async (dsn: string, runId: string): Promise<string> =>
  (await rowsOf<{ module_digest: string }>(dsn,
    `select module_digest from zz.control_run where id = $1`, [runId]))[0]?.module_digest ?? "";

const setDigest = (dsn: string, runId: string, digest: string): Promise<unknown> =>
  rowsOf(dsn, `update zz.control_run set module_digest = $2 where id = $1`, [runId, digest]);

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const given: Deployment = {
    prefix: null,
    url: (process.env.ZZ_E2E_URL ?? "").replace(/\/+$/, ""),
    pat: process.env.ZZ_E2E_PAT ?? "",
    db: process.env.ZZ_E2E_DB ?? "",
  };
  const handed = Boolean(given.url || given.pat || given.db);
  let deployment: Deployment | null = null;
  let ok = true;

  try {
    if (handed) {
      const refusal = refuseUnlessScratch(given.url, given.pat, given.db);
      if (refusal) { console.error(`  ${refusal}`); process.exit(2); }
      deployment = given;
    } else {
      deployment = await up();
    }
    const refusal = refuseUnlessScratch(deployment.url, deployment.pat, deployment.db);
    if (refusal) { console.error(`  ${refusal}`); process.exit(2); }
    console.log(`  deployment: gateway ${deployment.url}, database ${deployment.db.replace(/:[^:@/]+@/, ":***@")}`);

    const { url, pat, db } = deployment;
    const callDoor = (tool: string, args: Record<string, unknown>) => call(url, pat, tool, args);

    const opened = await callDoor("initiative_open", { slug: `control-loop-e2e-${Date.now().toString(36)}`, flow: "sdlc-flow" });
    const openedJson = JSON.parse(opened.text) as { initiative: string; control_run: string | null };
    const name = openedJson.initiative;
    const runId = openedJson.control_run ?? "";
    ok = expect("initiative_open reports the flow governs it and opens a run",
      opened.text.includes('"governed_by": "sdlc-flow"') && Boolean(runId), opened.text) && ok;

    const doc = (p: string, content: string) => callDoor("document_write", { path: `${name}/${p}`, content });
    // An approval is refused until the current content was presented.
    const sign = async (p: string) => {
      await callDoor("document_present", { path: `${name}/${p}` });
      return callDoor("document_approve", { path: `${name}/${p}` });
    };

    await doc("explore.md", "## Background\nx\n\n## Current state\nx\n\n## Rough direction\nx\n");

    // The body is written twice: the same sections, with one line changed, because a change to an
    // approved body takes its cause and the record has to say what moved.
    const specBody = (line: string) =>
      `## Context\n${line}\n\n## Problem\nx\n\n## Goals & Requirements\nx\n\n## Alternatives\nx\n\n` +
      "## Approach, Method & Structure\nx\n\n## Verification Plan\nx\n\n## Risks & Mitigations\nx\n\n" +
      "## Stakeholders & Work\nx\n\n" +
      "## Phase outline\n- **Phase 0 — Loop:** the control loop runs end to end.\n\n" +
      "## Core statements\n| ID | Statement | If false | Status | Evidence | Note |\n|---|---|---|---|---|---|\n" +
      "| CS-1 | The loop runs. | Nothing is checked. | fails | run:control-loop-e2e — `loop` | resolved-by-design-change: a probe has no design |\n";
    await doc("spec.md", specBody("x"));
    await sign("spec.md");
    const spec = `${name}/spec.md`;

    // THE SEQUENCE THIS WALK IS FOR. A change withdraws the approval of the snapshot it displaced;
    // the approval that answers it is a different fact with an id of its own, and nothing
    // withdraws that one. Walked twice, once for each way an approved document becomes a draft.
    //
    // First, a body change with its cause: it opens the next public version.
    const revised = await callDoor("document_edit", {
      path: spec,
      content: specBody("the approval of the version this replaces no longer stands"),
      source_content: "the loop's own probe: an approval must count again after a new version",
      source_title: "why spec.md moved to v2",
    });
    ok = expect("an approved document's body change opens v2",
      firstLine(revised.text) === `edited: ${spec} — v2 (new version)`, revised.text) && ok;
    const reapproved = await sign("spec.md");
    ok = expect("and approved again — the log takes a second approval of the same document",
      reapproved.text.includes("approved") && !reapproved.text.includes("ERROR"), reapproved.text) && ok;

    // Second, metadata alone: no body change, no cause, the SAME public version — and still a new
    // snapshot, because the approved one is not rewritten under its signature. It is a draft again.
    const retitled = await callDoor("document_edit", { path: spec, title: "Control loop probe" });
    ok = expect("a metadata-only change of an approved document stays v2, as a draft",
      firstLine(retitled.text) === `edited: ${spec} — v2` && /^status: draft$/m.test(retitled.text),
      retitled.text) && ok;
    const thirdApproval = await sign("spec.md");
    ok = expect("and approved again — a second approval of the same public version",
      thirdApproval.text.includes("approved") && !thirdApproval.text.includes("ERROR"), thirdApproval.text) && ok;

    await doc("plan.md", "## Full-suite gate\nx\n");
    await sign("plan.md");
    // The same fact arriving again. A second approval with no revision between the two is one
    // fact, not two, and the writer refuses the repeat itself rather than letting the run's own
    // unique key refuse it — a writer that reached the key would turn an approval that already
    // stands into a failed tool call.
    const again = await sign("plan.md");
    ok = expect("approving an already-approved document is answered, not refused",
      again.text.includes("approved") && !again.text.includes("ERROR"), again.text) && ok;
    await doc("review.md", "## Verdict\nx\n");
    // review.md approves only once its sweep has run a round. A review round is not audit evidence,
    // so the two audit rows asserted below stay two.
    await callDoor("source_add", { initiative: name, title: "review round", supports: ["review.md"], stage: "sdlc-review",
      content: "no blocking findings\n\n```json\n" +
        JSON.stringify({ round: 1, scope: { base: "HEAD~1", head: "HEAD" }, findings: [], resolved: [] }) + "\n```\n" });
    await sign("review.md");

    // The run records the digest of the rules it was judged against, and a replay CHECKS it rather
    // than adopting whatever is registered now. Moving that digest under the run is the one way to
    // reach the refusal a real deployment sees when a module's body changes between two days of one
    // initiative — and it has to be seen here rather than described, because "replayed against
    // today's rules" is a green verdict nobody could tell from a correct one.
    const digest = await digestOf(db, runId);
    await setDigest(db, runId, "0".repeat(64));
    const moved = await callDoor("initiative_close", { initiative: name, disposition: "finished" });
    ok = expect("a run whose module has moved cannot be replayed, and is refused for that",
      moved.text.includes("cannot be replayed") && moved.text.includes("judged against"),
      moved.text) && ok;
    ok = expect("and the refusal is about the rules, not about what the run is missing",
      !moved.text.includes("needs 1 audit"), moved.text) && ok;
    await setDigest(db, runId, digest);

    // Every document the flow declares is written and approved and the audits never ran — and the
    // spec's approval is the THIRD one, after two changes each withdrew the one before it. So the
    // refusal below names the audits and no approval: that is the fix, read off the loop's own
    // answer rather than off the log it was computed from.
    const early = await callDoor("initiative_close", { initiative: name, disposition: "finished" });
    ok = expect("a close is REFUSED when the documents are complete but the audits never ran",
      early.text.includes("cannot claim close:initiative") && early.text.includes("needs 1 audit"),
      early.text) && ok;
    ok = expect("the re-approval after each change counts — no approval is still outstanding",
      !/needs \d+ approval/.test(early.text), early.text) && ok;

    await callDoor("source_add", { initiative: name, title: "spec audit", content: "no blocking findings", supports: ["spec.md"], stage: "sdlc-spec-audit" });
    await callDoor("source_add", { initiative: name, title: "plan audit", content: "no blocking findings", supports: ["plan.md"], stage: "sdlc-plan-audit" });

    const rows = await evidence(db, runId);
    const ids = rows.map((r) => r.entry_id);
    // The snapshots this walk made, `@v<version>.<revision>`. An approval seals the row it names in
    // place, so only the two changes file a new row: v1 is row 1, the new version row 2, and the
    // metadata-only draft row 3 of the same version.
    const [v1, v2, v2Draft] = ["v1.1", "v2.2", "v2.3"];
    ok = expect("every fact in the run has its own id",
      new Set(ids).size === ids.length, JSON.stringify(ids)) && ok;
    ok = expect("the document is recorded once per snapshot, the first included",
      [v1, v2, v2Draft].every((at) => ids.includes(`doc:${spec}@${at}`)), JSON.stringify(ids)) && ok;
    ok = expect("and so is each approval of it",
      [v1, v2, v2Draft].every((at) => ids.includes(`approval:${spec}@${at}`)), JSON.stringify(ids)) && ok;
    const newVersion = rows.find((r) => r.entry_id === `doc:${spec}@${v2}`);
    ok = expect("the new version withdraws exactly the approval of the snapshot it displaced",
      newVersion?.supersedes === `approval:${spec}@${v1}`, JSON.stringify(newVersion)) && ok;
    const sameVersion = rows.find((r) => r.entry_id === `doc:${spec}@${v2Draft}`);
    ok = expect("the metadata-only draft withdraws exactly the approval of the snapshot it displaced",
      sameVersion?.supersedes === `approval:${spec}@${v2}`, JSON.stringify(sameVersion)) && ok;
    ok = expect("and those are the only two withdrawals in the run",
      rows.filter((r) => r.supersedes).length === 2, JSON.stringify(rows.filter((r) => r.supersedes))) && ok;
    ok = expect("and nothing withdraws the approval that came after them",
      !rows.some((r) => r.supersedes === `approval:${spec}@${v2Draft}`),
      JSON.stringify(rows.filter((r) => r.supersedes))) && ok;
    ok = expect("a fact the run already holds is recorded once, not twice",
      ids.filter((id) => id === `approval:${name}/plan.md@v1.1`).length === 1,
      JSON.stringify(ids)) && ok;
    // The back-reference, checked as a shape rather than assumed from a passing grant. A grant can
    // be reached by a graph that is wrong in a way that happens not to matter yet.
    const approvals = rows.filter((r) => r.kind === "approval");
    const audits = rows.filter((r) => r.kind === "audit");
    ok = expect("every approval points at the ID of a document entry, not at a filename",
      approvals.length === 5 && approvals.every((a) => a.about.startsWith(`doc:${name}/`)),
      JSON.stringify(approvals)) && ok;
    ok = expect("and each names the snapshot it approved — the one after each change, for the later two",
      [v1, v2, v2Draft].every((at) =>
        approvals.find((a) => a.entry_id === `approval:${spec}@${at}`)?.about === `doc:${spec}@${at}`),
      JSON.stringify(approvals)) && ok;
    ok = expect("source_add records the audit evidence, against the document it supports",
      audits.length === 2 && audits.every((a) => a.about.startsWith(`doc:${name}/`)),
      JSON.stringify(audits)) && ok;

    const late = await callDoor("initiative_close", { initiative: name, disposition: "finished" });
    ok = expect("the close is GRANTED once the declared procedure is complete",
      late.text.includes("closed as") && !late.text.includes("cannot claim"), late.text) && ok;

    if (deployment.prefix && keep) console.log(`  kept: containers ${deployment.prefix}-*`);
  } catch (err) {
    console.error(`  FAILED — ${err instanceof Error ? err.message : String(err)}`);
    ok = false;
  } finally {
    if (deployment && !(keep && deployment.prefix)) down(deployment);
  }
  console.log(ok ? "\n  control-loop-e2e: ok" : "\n  control-loop-e2e: FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(`  FAILED — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
