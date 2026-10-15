/**
 * skeleton-destinations.ts — the walking skeleton's Phase 4 steps: Activity, Knowledge, Runs, Plugins and
 * Access read through the real gateway, and a person in two teams switched through the console's own route
 * (AC-6.3, AC-6.4, AC-1.16). Not a script of its own: `scripts/skeleton.ts` calls `destinationCases` once
 * Work's steps (scripts/skeleton-work.ts) are done, so no file passes the 700-line ceiling.
 *
 * What it makes, all of it now, in the running week:
 *
 *   - the catalog's skills registered on the throwaway database by the release's own `register-skills`, as a
 *     release registers them, so a skill read through the door names a released version and makes a run;
 *   - as the status seed's member, through the gateway's door as their plugin (`x-zz-client: zz-plugin`):
 *     an initiative opened, `sdlc-method` read, a note written, a refused `initiative_status` naming no
 *     initiative, and a `knowledge_search` for two made-up words that finds nothing. The last four are one
 *     run of `sdlc-method` in that initiative; the refusal's owner is the one the gateway's classifier stamps.
 *
 * What it establishes, each from the real gateway, for the member and for the acting superadmin, who acts
 * for the member's team:
 *
 *   - Activity's summary: every week's four owners sum to its refused total, and the running week counts the
 *     calls made and the one refusal under its owner, every other owner as it was before the calls;
 *   - Activity's log narrowed to refused calls answers refused calls alone, each with its owner, and narrowed
 *     to the run's initiative too, the one refusal made;
 *   - Knowledge's summary lists the question that found nothing, asked once;
 *   - Runs lists the run: `sdlc-method` in that initiative, active, its calls, its one refusal, and output;
 *   - Plugins says `zz-core` is required with its install command, and the optional plugin that ships
 *     `sdlc-method` with its own, counting the team's calls and failures of it as the run's;
 *   - Access lists the caller's own tokens and marks the browser asking, and holds no token, token hash,
 *     session cookie or cookie hash of anybody's, nothing answered as redacted, and none of another's tokens.
 *
 * And the isolation seed's person in both of its teams, signed in afresh and acting for the second: Initiatives,
 * Knowledge's summary and Activity's summary answer the second team's rows and none of the first's; they
 * switch through `POST /api/console/settings/me/active-team`; and the same reads then answer the first team's
 * rows and none of the second's sentinels, the second team's initiative answering 404 by its link.
 *
 * DELIBERATE: the running week is the one the run reads in, so a run that crosses midnight into a Monday in the
 * reporting timezone between its two reads fails on the week; run it again.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import { lastJson } from "@zz/mcp-client";
import type pg from "pg";

import { root } from "./deployment.ts";
import type { Isolation } from "./schema/isolation-seed.ts";
import { signIn } from "./schema/status-seed.ts";

/** How long the rows of the calls made have to land. */
const SETTLE_MS = 15_000;
const OWNERS = ["guardrail", "ours", "theirs", "other"] as const;
/** The skill the run follows: a catalog skill zz-core serves, registered by `register-skills`, of an optional
 *  plugin. zz-core's own skills are served from the image's `/skills`, which a run on a laptop has none of. */
const SKILL = "sdlc-method";
const REFUSED_TOOL = "core:initiative_status";
const NOTES = "# Notes\n\nwritten for the skeleton's run\n";
/** What `redact()` answers in place of a value. COUPLED: services/gateway/src/redact.ts. */
const REDACTED = "\"redacted\":true";

type Obj = Record<string, unknown>;
type Owner = (typeof OWNERS)[number];
type Part<T> = { state: "ok"; data: T } | { state: "unavailable"; reason: string };
type Week = { window: { from: string; to: string }; complete: boolean; calls: number; refused: number; owners: Record<Owner, number> };
type LogRow = { id: string; tool: string | null; initiative: string | null; ok: boolean | null; owner: Owner | null; message: string | null };
type RunRow = { id: string; skill: string; initiative: string | null; calls: number; refusals: number; bytes: number | null; state: string };
type Skill = { name: string; calls: number; everRun: boolean };
type Plugin = { plugin: string; required: boolean; install: string; skills: Skill[]; yourTeam: { calls: number; failed: number } };

/** What the skeleton hands Phase 4's steps. */
interface DestinationContext {
  sql: pg.Client;
  gateway: string;
  /** The psql command that reaches the throwaway database, for the release's registrar. */
  psql: string;
  /** The status seed's member and the superadmin acting for their team. */
  member: string; acting: string;
  /** Each reader's console session secret and personal access token, by address. */
  cookies: Map<string, string>; tokens: Map<string, string>;
  isolation: Isolation;
  fail(step: string, detail: string): never;
  pass(line: string): void;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
/** Two made-up words, letters alone, that no seeded or written text holds. */
const nonsense = (): string =>
  [0, 1].map(() => randomBytes(5).toString("hex").replace(/\d/g, (d) => "ghijklmnop"[Number(d)])).join(" ");

/** Phase 4's steps, after Work's: the record made through the door, each reader's five destinations, and the
 *  switch. */
export async function destinationCases(ctx: DestinationContext): Promise<void> {
  const { sql, gateway, member, acting, fail, pass } = ctx;

  let step = "the release's register-skills on the throwaway database";
  const reg = spawnSync(process.execPath, [join(root, "packages/tools/dist/ops/register-skills.js"), "--root", root, "--psql", ctx.psql],
                        { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const registered = /(\d+) skill\(s\) registered/.exec(reg.stdout ?? "")?.[1];
  if (reg.status !== 0 || !registered) fail(step, `exited ${reg.status ?? reg.signal}: ${`${reg.stdout}${reg.stderr}`.trim().slice(-600)}`);
  pass(`${step} registers the catalog's ${registered} skills, ${SKILL} among them, as a release does`);

  /** A gateway answer as `email`'s console session: its status and its raw body. */
  const get = async (email: string, cookie: string | undefined, path: string, body?: Obj): Promise<{ status: number; text: string }> => {
    const res = await fetch(`${gateway}${path}`, {
      method: body ? "POST" : "GET", signal: AbortSignal.timeout(60_000),
      headers: { cookie: `zz_console=${cookie ?? ctx.cookies.get(email)}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, text: await res.text() };
  };
  /** The same, an object answered 200 or the step's failure. */
  const ask = async (step: string, email: string, path: string, cookie?: string): Promise<{ answer: Obj; text: string }> => {
    const { status, text } = await get(email, cookie, path);
    if (status !== 200) fail(step, `${path} answered ${status}: ${text.slice(0, 400)}`);
    const answer: unknown = JSON.parse(text);
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) fail(step, `${path} answered something other than an object: ${text.slice(0, 200)}`);
    return { answer: answer as Obj, text };
  };
  const ok = <T>(step: string, name: string, p: unknown): T => {
    const part = p as Part<T> | undefined;
    if (part?.state !== "ok") return fail(step, `${name} is ${part ? `unavailable (${(part as { reason: string }).reason})` : "missing"}, not ok`);
    return part.data;
  };
  const running = async (step: string, email: string): Promise<{ weeks: Week[]; now: Week }> => {
    const weeks = ok<Week[]>(step, "weeks", (await ask(step, email, "/api/console/activity/summary")).answer.weeks);
    const now = weeks.at(-1) ?? fail(step, "it answers no weeks");
    if (now.complete) fail(step, `its last week is ${JSON.stringify(now)}, not the running one`);
    return { weeks, now };
  };

  // The member's tool calls through the door, each row waited for before the next, so the run's counters are
  // the door's own and none is left to the repair.
  const count = async (): Promise<number> =>
    (await sql.query<{ n: number }>("select count(*)::int as n from zz.event where kind = 'tool_call'")).rows[0].n;
  let sent = 0;
  const call = async (step: string, name: string, args: Obj, refused = false): Promise<string> => {
    const base = await count();
    const res = await fetch(`${gateway}/core/mcp`, {
      method: "POST", signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${ctx.tokens.get(member)}`, "content-type": "application/json",
                 accept: "application/json, text/event-stream", "x-zz-client": "zz-plugin" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const raw = await res.text();
    sent++;
    const env = lastJson(raw);
    const reply = env?.result?.content?.map((p) => p.text ?? "").join("") ?? env?.error?.message ?? raw.slice(0, 300);
    const wasRefused = Boolean(env?.error) || Boolean((env?.result as { isError?: boolean } | undefined)?.isError) || reply.startsWith("ERROR");
    if (res.status !== 200 || wasRefused !== refused) fail(step, `${name} answered ${res.status}, ${wasRefused ? "refused" : "not refused"}: ${reply.slice(0, 400)}`);
    const until = Date.now() + SETTLE_MS;
    while (await count() < base + 1) {
      if (Date.now() > until) fail(step, `${name}'s tool call was not recorded within ${SETTLE_MS / 1000} s`);
      await new Promise((r) => setTimeout(r, 200));
    }
    return reply;
  };

  step = "Phase 4's record";
  const before = (await running(step, member)).now;
  const slug = (JSON.parse(await call(step, "initiative_open", { slug: "skeleton-runs" })) as { initiative: string }).initiative;
  await call(step, "skill_read", { name: SKILL });
  await call(step, "document_write", { path: `${slug}/notes.md`, content: NOTES });
  await call(step, "initiative_status", { initiatives: [] }, true);
  const question = nonsense();
  const found = (JSON.parse(await call(step, "knowledge_search", { query: question })) as { returned?: unknown }).returned;
  if (found !== 0) fail(step, `knowledge_search for "${question}" returned ${JSON.stringify(found)}, not 0`);
  const until = Date.now() + SETTLE_MS;
  while (!(await sql.query("select 1 from zz.event where kind = 'knowledge.search' and subject = $1", [question])).rowCount) {
    if (Date.now() > until) fail(step, `zz-core recorded no knowledge.search for "${question}" within ${SETTLE_MS / 1000} s`);
    await new Promise((r) => setTimeout(r, 200));
  }
  // A tool call's row names no actor, so the refusal is found by its initiative, which the door stamps.
  const refusal = (await sql.query<{ owner: Owner | null }>(
    `select e.refusal_owner as owner from zz.event e join zz.initiative i on i.id = e.initiative_id
      where e.kind = 'tool_call' and e.ok = false and e.tool_key = $2 and i.slug = $1 order by e.ts desc limit 1`,
    [slug, REFUSED_TOOL])).rows[0];
  const owner = refusal?.owner ?? fail(step, `the refused ${REFUSED_TOOL} has no row in ${slug} with an owner`);
  pass(`${step} is made through the gateway's door as the member's plugin: ${slug} opened, ${SKILL} read, a note written, ` +
       `${REFUSED_TOOL} refused under ${owner}, and a question that found nothing, ${sent} tool calls recorded`);

  for (const [who, email] of [["the member", member], ["the acting superadmin", acting]] as const) {
    step = `/api/console/activity/summary as ${who}`;
    const { weeks, now } = await running(step, email);
    const unsummed = weeks.filter((w) => OWNERS.reduce((n, o) => n + w.owners[o], 0) !== w.refused);
    if (unsummed.length) fail(step, `the owners do not sum to the refused total in ${unsummed.map((w) => w.window.from).join(", ")}`);
    const moved = OWNERS.filter((o) => now.owners[o] !== before.owners[o] + (o === owner ? 1 : 0));
    if (now.refused !== before.refused + 1 || now.calls !== before.calls + sent || moved.length) {
      fail(step, `the running week went from ${JSON.stringify(before)} to ${JSON.stringify(now)}, not ${sent} calls more and one ${owner} refusal`);
    }
    pass(`${step} answers 200 with every one of ${weeks.length} weeks' four owners summing to its refused total, and the running ` +
         `week's ${now.calls} calls and ${now.refused} refused (${OWNERS.map((o) => `${o} ${now.owners[o]}`).join(", ")}) counting the ` +
         `${sent} calls made and the ${owner} refusal`);

    step = `/api/console/activity?refused=true as ${who}`;
    const log = (await ask(step, email, "/api/console/activity?refused=true&limit=100")).answer as { rows: LogRow[]; total: number };
    const unrefused = log.rows.filter((r) => r.ok !== false || r.owner === null);
    if (!log.rows.length || unrefused.length) fail(step, `${log.rows.length} rows, ${unrefused.length} of them not a refused call with an owner`);
    const mine = (await ask(step, email, `/api/console/activity?refused=true&initiative=${encodeURIComponent(slug)}`)).answer as { rows: LogRow[]; total: number };
    const r = mine.rows[0];
    if (mine.total !== 1 || mine.rows.length !== 1 || r.tool !== REFUSED_TOOL || r.owner !== owner || r.initiative !== slug) {
      fail(step, `narrowed to ${slug} it answers ${mine.total}: ${JSON.stringify(mine.rows).slice(0, 400)}, not the one ${owner} refusal of ${REFUSED_TOOL}`);
    }
    pass(`${step} answers 200 with ${log.total} refused calls, each with its owner, and narrowed to ${slug} the one made, ` +
         `${REFUSED_TOOL} under ${owner}`);

    step = `/api/console/knowledge/summary as ${who}`;
    const questions = ok<{ rows: { question: string; asked: number }[]; total: number }>(step, "questions",
      (await ask(step, email, "/api/console/knowledge/summary")).answer.questions);
    const asked = questions.rows.find((q) => q.question === question);
    if (asked?.asked !== 1) fail(step, `its questions that found nothing are ${JSON.stringify(questions.rows)}, without "${question}" asked once`);
    pass(`${step} answers 200 with "${question}" among the ${questions.total} questions that found nothing, asked once`);

    step = `/api/console/runs as ${who}`;
    const recent = ok<{ rows: RunRow[]; total: number }>(step, "recent", (await ask(step, email, "/api/console/runs?limit=100")).answer.recent);
    const run = recent.rows.find((x) => x.initiative === slug) ?? fail(step, `it lists no run in ${slug} among ${recent.total}`);
    if (run.skill !== SKILL || run.state !== "active" || run.calls !== sent - 1 || run.refusals !== 1 || !(Number(run.bytes) > 0)) {
      fail(step, `its run in ${slug} is ${JSON.stringify(run)}, not an active ${SKILL} run of ${sent - 1} calls, one refused, with output`);
    }
    pass(`${step} answers 200 with the run of ${SKILL} in ${slug}: active, ${run.calls} calls, ${run.refusals} refused, ` +
         `${run.bytes} bytes of observed output`);

    step = `/api/console/plugins as ${who}`;
    const plugins = (await ask(step, email, "/api/console/plugins")).answer.plugins as Plugin[];
    const core = plugins.find((p) => p.plugin === "zz-core") ?? fail(step, `it lists no zz-core among ${plugins.length} plugins`);
    const optional = plugins.find((p) => p.skills.some((x) => x.name === SKILL)) ?? fail(step, `no plugin ships ${SKILL}`);
    const used = optional.skills.find((x) => x.name === SKILL)!;
    if (core.required !== true || core.install !== "claude plugin install zz-core@zz-stack") {
      fail(step, `zz-core is ${JSON.stringify({ required: core.required, install: core.install })}, not required with its install command`);
    }
    if (optional.required !== false || optional.install !== `claude plugin install ${optional.plugin}@zz-stack`) {
      fail(step, `${optional.plugin} is ${JSON.stringify({ required: optional.required, install: optional.install })}, not optional with its install command`);
    }
    const team = optional.yourTeam;
    if (used.calls !== run.calls || !used.everRun || team.calls !== run.calls || team.failed !== run.refusals) {
      fail(step, `the team's ${SKILL} is ${JSON.stringify(used)} and ${optional.plugin}'s ${JSON.stringify(team)}, not the run's ${run.calls} calls, ${run.refusals} failed`);
    }
    pass(`${step} answers 200 with zz-core required, "${core.install}", ${optional.plugin} optional, "${optional.install}", and ` +
         `the team's ${team.calls} calls of ${SKILL}, ${team.failed} failed, as Runs counts the run`);

    step = `/api/console/access as ${who}`;
    const { answer: access, text } = await ask(step, email, "/api/console/access");
    const { rows: pats } = await sql.query<{ id: string; email: string; token_hash: string }>(
      "select pat.id::text as id, p.email, pat.token_hash from zz.pat pat join zz.principal p on p.id = pat.principal_id");
    const { rows: sessions } = await sql.query<{ token_hash: string }>("select token_hash from zz.console_session");
    const secrets = [...ctx.tokens.values(), ...ctx.cookies.values()].flatMap((s) => [s, sha256(s)]);
    const held = [...secrets, ...pats.map((p) => p.token_hash), ...sessions.map((s) => s.token_hash)].filter((s) => s && text.includes(s));
    const others = pats.filter((p) => p.email !== email && text.includes(p.id));
    const issued = access.issued as { id: string }[], browsers = access.browsers as { current: boolean }[];
    const own = pats.filter((p) => p.email === email).map((p) => p.id);
    const blanked = text.includes(REDACTED);
    if (held.length || blanked || others.length) {
      fail(step, `it holds ${held.length} secrets or hashes, ${others.length} of another's tokens${blanked ? ", and a redacted field" : ""}`);
    }
    if (issued.map((t) => t.id).sort().join() !== own.sort().join() || browsers.filter((b) => b.current).length !== 1) {
      fail(step, `it lists ${issued.length} tokens of the caller's ${own.length}, and ${browsers.filter((b) => b.current).length} browsers asking`);
    }
    pass(`${step} answers 200 with the caller's ${issued.length} token(s) and ${browsers.length} browser(s), the one asking marked, ` +
         `and none of the ${secrets.length + pats.length + sessions.length} tokens, cookies and hashes looked for, no field ` +
         "redacted and no token of another's");
  }

  // The isolation seed's person in both teams, signed in afresh: their browser acts for the second team, their
  // active one, until they switch it.
  const s = ctx.isolation;
  const both = s.both;
  const cookie = await signIn(sql, both);
  const sentinels = Object.values(s.sentinels);
  const first = ["first team ", s.one.slug, s.one.initiative];
  const own = { one: [s.one.initiative, "first team question"], two: [s.two.initiative, s.sentinels.question] };
  const reads = ["/api/console/initiatives?limit=100", "/api/console/knowledge/summary", "/api/console/activity/summary"];
  const link = (t: Isolation["one"]): string => `/api/console/initiatives/${encodeURIComponent(t.slug)}/${encodeURIComponent(t.initiative)}`;
  /** Each read as the person, answering `team`'s own rows and none of `not`. */
  const answers = async (step: string, team: Isolation["one"], mine: string[], not: string[]): Promise<void> => {
    const me = (await ask(step, both, "/api/console/me", cookie)).answer;
    if (me.activeTeam !== team.slug) fail(step, `/api/console/me acts for ${String(me.activeTeam)}, not ${team.slug}`);
    let text = "";
    for (const path of reads) {
      const t = (await ask(step, both, path, cookie)).text;
      const theirs = not.filter((m) => t.includes(m));
      if (theirs.length) fail(step, `${path} holds ${theirs.join(", ")}, of the team it does not act for`);
      text += t;
    }
    const missing = mine.filter((m) => !text.includes(m));
    if (missing.length) fail(step, `the reads do not hold ${missing.join(", ")}, of the team it acts for`);
  };

  step = `${both} signed in`;
  await answers(step, s.two, own.two, first);
  pass(`${step} acts for the second team: Initiatives, Knowledge's and Activity's summaries answer its initiative and its question ` +
       "that found nothing, and nothing of the first team's");

  step = `${both} switches through POST /api/console/settings/me/active-team`;
  const switched = await get(both, cookie, "/api/console/settings/me/active-team", { team: s.one.slug });
  const parsed: unknown = switched.status === 200 ? JSON.parse(switched.text) : null;
  const said: Obj = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : {};
  if (said.ok !== true || said.actingFor !== s.one.slug || said.from !== s.two.slug) {
    fail(step, `answered ${switched.status} ${switched.text.slice(0, 300)}, not acting for ${s.one.slug} from the second team`);
  }
  await answers(step, s.one, own.one, sentinels);
  const gone = await get(both, cookie, link(s.two));
  const opens = await get(both, cookie, link(s.one));
  if (gone.status !== 404 || opens.status !== 200) {
    fail(step, `the second team's initiative answers ${gone.status} and the first's ${opens.status}, not 404 and 200`);
  }
  pass(`${step} answers 200 acting for ${s.one.slug}, and the next reads answer the first team's initiative and question, none of ` +
       `the second team's ${sentinels.length} sentinels, its initiative 404 and the first's 200`);
}
