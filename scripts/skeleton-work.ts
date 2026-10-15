/**
 * skeleton-work.ts — the walking skeleton's Work steps: Home, Record, Approvals, Initiatives and one prepared
 * query read through the real gateway, and an initiative closed through the console's route (AC-5.2, AC-5.6).
 * Not a script of its own: `scripts/skeleton.ts` starts zz-core with `startCore` before it mounts the
 * gateway, calls `workCases` once the platform's reads are done, and stops zz-core with `stopCore` on every
 * exit path, so neither file passes the 700-line ceiling.
 *
 * zz-core is the built `services/zz-core/dist/server.js`, started on a free port against the skeleton's
 * throwaway database; the gateway's `/core/mcp` door relays to it, and the console's acts and next moves
 * reach it through `CORE_MCP_URL`. Every document and approval is made through that door, as a person's
 * plugin makes them (`x-zz-client: zz-plugin`), so the gateway's telemetry records each write and the
 * import rule reads the documents as the team's own work.
 *
 * What it makes, in the status seed's member's team, all of it now:
 *
 *   waiting     sdlc-flow, explore.md and spec.md written, spec.md presented   the team's one waiting revision
 *   signed      no flow, notes.md written, presented and approved by the member
 *   theirs      no flow, notes.md written, presented and approved by the acting superadmin
 *   abandoned   no flow, no document, closed through initiative_close as abandoned
 *   delivered   no flow, notes.md, closed through initiative_close with a reason nobody signed off
 *   closes      no flow, notes.md, closed through the console's route, finished, on notes.md
 *
 * The acting superadmin is a superadmin who is a member of that team and acts for it: Work is the active
 * team's, for the superadmin too, and the status seed's superadmin acts for none.
 *
 * What it establishes, each from the real gateway and each answer's expected values written below:
 *
 *   - the console's close answers 200 with the outcome accepted, the member as the closer and notes.md as
 *     the closing document, and initiative_status, asked as the member, reads accepted back;
 *   - for the member and the acting superadmin: Home's title, and its paired figures, the words added by
 *     week with this week's the team's whole writing and the approvals in the caller's name by week with
 *     this week's the caller's one; Record's lead, the retained words at 500 words an hour on the basis
 *     retained_stock with nothing import-made or unrecorded; Approvals' one waiting revision and the
 *     caller's history, exactly the one approval they signed; Initiatives' first page, every initiative,
 *     waiting first, each with a next move, the waiting one's as initiative_status answers it; and the
 *     closures by outcome over Record's quarter, asked of work/query, agreeing with Record's own.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import { join } from "node:path";

import { lastJson } from "@zz/mcp-client";
import type pg from "pg";

import { root } from "./deployment.ts";
import { signIn } from "./schema/status-seed.ts";

/** How long zz-core has to say it is listening. */
const CORE_START_MS = 30_000;
/** How long the telemetry of the calls made has to land. */
const SETTLE_MS = 15_000;
const ACTING = "acting-superadmin@status.example.test";

const EXPLORE = "## Background\nx\n\n## Current state\nx\n\n## Rough direction\nx\n";
/** A spec the spec gate takes: every declared section, one phase, one core statement. */
const SPEC =
  "## Context\nx\n\n## Problem\nx\n\n## Goals & Requirements\nx\n\n## Alternatives\nx\n\n" +
  "## Approach, Method & Structure\nx\n\n## Verification Plan\nx\n\n## Risks & Mitigations\nx\n\n" +
  "## Stakeholders & Work\nx\n\n" +
  "## Phase outline\n- **Phase 0 — Loop:** the control loop runs end to end.\n\n" +
  "## Core statements\n| ID | Statement | If false | Status | Evidence | Note |\n|---|---|---|---|---|---|\n" +
  "| CS-1 | The loop runs. | Nothing is checked. | fails | run:control-loop-e2e — `loop` | resolved-by-design-change: a probe has no design |\n";
const NOTES = "# Notes\n\nwritten for the skeleton\n";
/** The words of EXPLORE, SPEC and NOTES as the contracts count them, and the team's: one explore, one spec
 *  and four notes. */
const WORDS = 11 + 91 + 4 * 6;
const DOCUMENTS = 6;
const PACE = 500;
/** The six initiatives by the state the list reads, and the closures by outcome. */
const BY_STATE = { waiting: 1, open: 2, accepted: 1, delivered: 1, abandoned: 1 };
const CLOSED = { accepted: 1, delivered: 1, abandoned: 1 };

type Obj = Record<string, unknown>;
type Move = { action: string; stage: string | null; document: string | null; waitingOn: string | null; why: string };
type Fig = { value: number | null; why: string | null };
type PF = { window: { from: string; to: string; complete: boolean }; figure: Fig };
type Part<T> = { state: "ok"; data: T } | { state: "unavailable"; reason: string };

/** What the skeleton hands Work's steps. */
interface WorkContext {
  sql: pg.Client;
  gateway: string;
  /** The status seed's member and their console session's secret. */
  member: string; memberCookie: string;
  fail(step: string, detail: string): never;
  pass(line: string): void;
}

let core: ChildProcess | null = null;

/** Starts zz-core on the throwaway database at `url` and answers its MCP address once it listens.
 *  COUPLED: `startCore` in scripts/schema/throwaway-core.ts starts it the same way, and the sentinel is
 *  services/zz-core/src/server.ts's `listening on :<port>`. */
export async function startCore(url: string, fail: WorkContext["fail"]): Promise<string> {
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  const proc = spawn(process.execPath, ["services/zz-core/dist/server.js", "--port", String(port)], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TEAM_DB_URL: url, TRUSTED_PEERS: "localhost", ZZ_CATALOG_DIR: join(root, "catalog"), ZZ_SKILLS_DIR: join(root, "skills") },
  });
  core = proc;
  let seen = "";
  const listening = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), CORE_START_MS);
    // Read for the life of the child, so a full pipe never stalls it.
    const keep = (b: Buffer): void => {
      seen = (seen + b.toString()).slice(-3000);
      if (seen.includes(`listening on :${port}`)) { clearTimeout(timer); resolve(true); }
    };
    proc.stdout!.on("data", keep);
    proc.stderr!.on("data", keep);
    proc.once("exit", () => { clearTimeout(timer); resolve(false); });
  });
  if (!listening) fail("zz-core starts", `no \`listening on :${port}\` within ${CORE_START_MS / 1000} s:\n${seen.trim() || "(no output)"}`);
  return `http://127.0.0.1:${port}/mcp`;
}

/** Stops zz-core by its own process id, if it runs. */
export function stopCore(): void {
  if (core?.pid !== undefined && core.exitCode === null && core.signalCode === null) {
    try { process.kill(core.pid, "SIGTERM"); } catch { /* already gone */ }
  }
}

/** Seeds a superadmin who is a member of `team` and acts for it, and a token for each Work reader. */
async function people(sql: pg.Client, member: string, team: string): Promise<{ cookie: string; tokens: Map<string, string> }> {
  await sql.query("insert into zz.principal (email, display_name, role) values ($1, 'acting-superadmin', 'superadmin')", [ACTING]);
  await sql.query(
    `insert into zz.membership (team_id, principal_id, role, added_by)
     select t.id, p.id, 'member', p.id from zz.team t, zz.principal p where t.slug = $1 and p.email = $2`, [team, ACTING]);
  await sql.query("update zz.principal set active_team_id = (select id from zz.team where slug = $2) where email = $1", [ACTING, team]);
  const tokens = new Map<string, string>();
  for (const email of [member, ACTING]) {
    const token = `zzp_${randomBytes(24).toString("hex")}`;
    await sql.query("insert into zz.pat (principal_id, token_hash) select id, $2 from zz.principal where email = $1",
                    [email, createHash("sha256").update(token, "utf8").digest("hex")]);
    tokens.set(email, token);
  }
  return { cookie: await signIn(sql, ACTING), tokens };
}

/** What Work's steps hand on: the acting superadmin's address, which no signed-out page may hold, and each
 *  reader's console session secret and personal access token, by address. */
interface WorkReaders { acting: string; cookies: Map<string, string>; tokens: Map<string, string> }

/**
 * Work's steps, after the platform's: the people and the record made, the close, then each reader's five
 * answers.
 */
export async function workCases(ctx: WorkContext): Promise<WorkReaders> {
  const { sql, gateway, member, fail, pass } = ctx;
  const team = (await sql.query<{ slug: string }>(
    "select t.slug from zz.principal p join zz.team t on t.id = p.active_team_id where p.email = $1", [member])).rows[0]?.slug
    ?? fail("Work's team", `${member} acts for no team`);
  const { cookie, tokens } = await people(sql, member, team);
  const cookies = new Map([[member, ctx.memberCookie], [ACTING, cookie]]);

  /** A tool call through the gateway's door as `email`'s plugin: the reply, a refusal failing `step`. */
  let sent = 0;
  const call = async (step: string, email: string, name: string, args: Obj): Promise<string> => {
    const res = await fetch(`${gateway}/core/mcp`, {
      method: "POST", signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${tokens.get(email)}`, "content-type": "application/json",
                 accept: "application/json, text/event-stream", "x-zz-client": "zz-plugin" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const raw = await res.text();
    sent++;
    const env = lastJson(raw);
    const reply = env?.result?.content?.map((p) => p.text ?? "").join("") ?? env?.error?.message ?? raw.slice(0, 300);
    if (res.status !== 200 || reply.startsWith("ERROR")) fail(step, `${name} as ${email} answered ${res.status}: ${reply.slice(0, 400)}`);
    return reply;
  };
  const open = async (email: string, key: string, flow?: string): Promise<string> =>
    (JSON.parse(await call(`open ${key}`, email, "initiative_open", flow ? { slug: key, flow } : { slug: key })) as { initiative: string }).initiative;
  const notes = (email: string, slug: string): Promise<string> =>
    call(`write ${slug}/notes.md`, email, "document_write", { path: `${slug}/notes.md`, content: NOTES });
  const sign = async (email: string, slug: string): Promise<void> => {
    await notes(email, slug);
    await call(`present ${slug}/notes.md`, email, "document_present", { path: `${slug}/notes.md` });
    await call(`approve ${slug}/notes.md`, email, "document_approve", { path: `${slug}/notes.md` });
  };
  const count = async (): Promise<number> =>
    (await sql.query<{ n: number }>("select count(*)::int as n from zz.event where kind = 'tool_call'")).rows[0].n;

  const base = await count();
  const waiting = await open(member, "skeleton-waiting", "sdlc-flow");
  await call("write the explore", member, "document_write", { path: `${waiting}/explore.md`, content: EXPLORE });
  await call("write the spec", member, "document_write", { path: `${waiting}/spec.md`, content: SPEC });
  await call("present the spec", member, "document_present", { path: `${waiting}/spec.md` });
  const signed = await open(member, "skeleton-signed");
  await sign(member, signed);
  const theirs = await open(ACTING, "skeleton-theirs");
  await sign(ACTING, theirs);
  const abandoned = await open(member, "skeleton-abandoned");
  await call("abandon", member, "initiative_close", { initiative: abandoned, disposition: "abandoned" });
  const delivered = await open(member, "skeleton-delivered");
  await notes(member, delivered);
  await call("deliver", member, "initiative_close", { initiative: delivered, disposition: "finished", document: "notes.md",
                                                     no_signoff_reason: "the person who asked for it moved on before signing off" });
  const closes = await open(member, "skeleton-closes");
  await notes(member, closes);
  // The import rule reads the door's telemetry, which lands after each answer: every call's row, first.
  const until = Date.now() + SETTLE_MS;
  while (await count() < base + sent) {
    if (Date.now() > until) fail("the door records Work's calls", `${(await count()) - base} tool calls recorded of ${sent}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  pass(`Work's record is made through the gateway's door in ${team}: six initiatives, ${DOCUMENTS} documents, one waiting ` +
       `spec, an approval by the member and one by the acting superadmin, an abandoned and a delivered close, ${sent} tool calls recorded`);

  /** A gateway answer as `email`'s console session, an object or the step's failure. */
  const ask = async (step: string, email: string, path: string, body?: Obj): Promise<Obj> => {
    const res = await fetch(`${gateway}${path}`, {
      method: body ? "POST" : "GET", signal: AbortSignal.timeout(60_000),
      headers: { cookie: `zz_console=${cookies.get(email)}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (res.status !== 200) fail(step, `answered ${res.status}: ${text.slice(0, 400)}`);
    const answer: unknown = JSON.parse(text);
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) fail(step, `answered something other than an object: ${text.slice(0, 200)}`);
    return answer as Obj;
  };
  const ok = <T>(step: string, name: string, p: unknown): T => {
    const part = p as Part<T> | undefined;
    if (part?.state !== "ok") return fail(step, `${name} is ${part ? `unavailable (${(part as { reason: string }).reason})` : "missing"}, not ok`);
    return part.data;
  };

  // The close, as the member presses it: the body the console sends, and the outcome zz-core derives.
  let step = `POST /api/console/initiatives/${team}/${closes}/close as the member`;
  const closed = await ask(step, member, `/api/console/initiatives/${team}/${closes}/close`, { disposition: "finished", document: "notes.md" });
  if (closed.outcome !== "accepted" || closed.closedBy !== member || closed.document !== "notes.md") {
    fail(step, `answered ${JSON.stringify(closed)}, not accepted, closed by ${member}, on notes.md`);
  }
  const status = JSON.parse(await call("initiative_status of the close", member, "initiative_status", { initiative: closes })) as { outcome?: string | null };
  if (status.outcome !== "accepted") fail(step, `initiative_status reads the outcome ${JSON.stringify(status.outcome)}, not accepted`);
  pass(`${step} answers 200 accepted, closed by the member, on notes.md, and initiative_status reads accepted back`);

  // The waiting initiative's next move as zz-core answers it, in the console's keys.
  const raw = JSON.parse(await call("initiative_status of the waiting initiative", member, "initiative_status", { initiative: waiting })) as
    { next_move?: { action: string; stage?: string; document?: string; waiting_on?: string; why: string } | null };
  const m = raw.next_move ?? fail("initiative_status of the waiting initiative", "names no next move");
  const move: Move = { action: m.action, stage: m.stage ?? null, document: m.document ?? null, waitingOn: m.waiting_on ?? null, why: m.why };
  const mine = { [member]: `${signed}/notes.md`, [ACTING]: `${theirs}/notes.md` };

  for (const [who, email] of [["the member", member], ["the acting superadmin", ACTING]] as const) {
    step = `/api/console/home as ${who}`;
    const home = await ask(step, email, "/api/console/home");
    const title = home.title as { sentence?: unknown; rule?: unknown } | undefined;
    const sentence = typeof title?.sentence === "string" && title.sentence ? title.sentence : fail(step, `its title is ${JSON.stringify(title)}`);
    const words = ok<{ weeks: PF[] }>(step, "words", home.words).weeks;
    const approved = ok<{ weeks: PF[] }>(step, "approvals", home.approvals).weeks;
    const week = (w: PF[]): string => w.map((p) => p.figure.value ?? `none (${p.figure.why})`).join(", ");
    if (words.at(-1)?.window.complete !== false || words.at(-1)?.figure.value !== WORDS) {
      fail(step, `the words added by week are ${week(words)}, this week's not ${WORDS}`);
    }
    if (approved.at(-1)?.window.complete !== false || approved.at(-1)?.figure.value !== 1) {
      fail(step, `the approvals in the caller's name by week are ${week(approved)}, this week's not 1`);
    }
    pass(`${step} answers 200 titled "${sentence}" (rule ${String(title?.rule)}), its paired figures by week the words added ` +
         `${week(words)} and the approvals in the caller's name ${week(approved)}, this week's last`);

    step = `/api/console/record?period=quarter as ${who}`;
    const record = await ask(step, email, "/api/console/record?period=quarter");
    const lead = record.lead as { estimate: { basis: string; words: number | null; assumedWordsPerHour: number; hours: number | null;
      coverage: { documents: number; importMade: number; unrecorded: number } }; asOf: string };
    const e = lead?.estimate;
    if (e?.basis !== "retained_stock" || e.words !== WORDS || e.assumedWordsPerHour !== PACE || e.hours !== WORDS / PACE ||
        e.coverage.documents !== DOCUMENTS || e.coverage.importMade || e.coverage.unrecorded) {
      fail(step, `its lead is ${JSON.stringify(lead)}, not ${WORDS} retained words at ${PACE} an hour over ${DOCUMENTS} documents, none import-made or unrecorded`);
    }
    const work = ok<{ closedByOutcome: Record<keyof typeof CLOSED, Fig> }>(step, "work", record.work);
    const period = (record.meta as { period: { from: string; to: string } }).period;
    pass(`${step} answers 200 with its lead ${e.words} retained words at ${e.assumedWordsPerHour} words an hour, ${e.hours} hours, ` +
         `basis retained_stock as of ${lead.asOf}, over ${DOCUMENTS} documents none of them import-made or unrecorded`);

    step = `/api/console/approvals as ${who}`;
    const approvals = await ask(step, email, "/api/console/approvals");
    const queue = ok<{ rows: { initiative: string; path: string }[]; total: number; queue: string }>(step, "waiting", approvals.waiting);
    const history = ok<{ rows: { initiative: string; path: string }[]; total: number }>(step, "history", approvals.history);
    const tiles = approvals.tiles as { waiting: number; inYourName: number };
    const queued = queue.rows.map((r) => `${r.initiative}/${r.path}`), theirOwn = history.rows.map((r) => `${r.initiative}/${r.path}`);
    if (tiles.waiting !== 1 || queue.total !== 1 || queued.join() !== `${waiting}/spec.md` || queue.queue !== "team") {
      fail(step, `it waits on ${tiles.waiting} (${queued.join(", ")}, the ${queue.queue} queue), not ${waiting}/spec.md alone`);
    }
    if (tiles.inYourName !== 1 || history.total !== 1 || theirOwn.join() !== mine[email]) {
      fail(step, `its history is ${tiles.inYourName} approvals (${theirOwn.join(", ")}), not the caller's own ${mine[email]}`);
    }
    pass(`${step} answers 200 with 1 waiting, ${queued[0]} in the team's queue, and the caller's history ${theirOwn[0]} alone`);

    step = `/api/console/initiatives as ${who}`;
    const list = await ask(step, email, "/api/console/initiatives");
    const rows = list.rows as { slug: string; state: keyof typeof BY_STATE; nextMove: Move | null }[];
    const states: Record<string, number> = {};
    for (const r of rows) states[r.state] = (states[r.state] ?? 0) + 1;
    if (list.total !== 6 || rows.length !== 6 || JSON.stringify(states, Object.keys(BY_STATE)) !== JSON.stringify(BY_STATE)) {
      fail(step, `its first page holds ${rows.length} of ${String(list.total)} by state ${JSON.stringify(states)}, not ${JSON.stringify(BY_STATE)}`);
    }
    if (list.nextMoveState !== "ok" || rows.some((r) => r.nextMove === null)) {
      fail(step, `next moves are ${String(list.nextMoveState)}, ${rows.filter((r) => r.nextMove === null).map((r) => r.slug).join(", ")} with none`);
    }
    if (rows[0].slug !== waiting || JSON.stringify(rows[0].nextMove) !== JSON.stringify(move)) {
      fail(step, `its first row is ${rows[0].slug} moving ${JSON.stringify(rows[0].nextMove)}, not ${waiting} moving ${JSON.stringify(move)} as initiative_status answers`);
    }
    pass(`${step} answers 200 with a first page of all 6, waiting first: ${waiting} next ${move.action}` +
         `${move.document ? ` ${move.document}` : ""}, as initiative_status answers it, and every row a next move`);

    step = `/api/console/work/query?measure=closures&by=outcome over Record's quarter as ${who}`;
    const query = await ask(step, email, `/api/console/work/query?measure=closures&by=outcome&from=${encodeURIComponent(period.from)}` +
      `&to=${encodeURIComponent(period.to)}`);
    const groups = query.groups as { key: string; value: Fig }[];
    const said = (Object.keys(CLOSED) as (keyof typeof CLOSED)[]).map((k) => {
      const asked = groups.find((g) => g.key === k)?.value.value ?? 0, recorded = work.closedByOutcome[k].value;
      if (asked !== CLOSED[k] || recorded !== CLOSED[k]) fail(step, `${k} is ${asked} here and ${String(recorded)} in Record, not ${CLOSED[k]}`);
      return `${k} ${asked}`;
    });
    const total = (query.total as Fig).value;
    if (total !== 3) fail(step, `its total is ${String(total)}, not 3`);
    pass(`${step} answers 200 with ${said.join(", ")} from ${period.from} to ${period.to}, as Record's quarter counts them`);
  }
  return { acting: ACTING, cookies, tokens };
}
