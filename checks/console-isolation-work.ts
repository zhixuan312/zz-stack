/**
 * checks/console-isolation-work.ts — Work's rounds of the isolation harness, and the request helpers the
 * harness, these rounds and `checks/console-isolation-destinations.ts` share. Not a check of its own:
 * `checks/console-isolation.ts` imports it and calls `workRounds` once its own rounds are done, on the same
 * seeded database, zz-core and gateway, so no file passes the 700-line ceiling (AC-5.10, AC-6.6).
 *
 * What the rounds establish, over `seedWorkRecord`'s people, approvals, tokens and runs:
 *
 *   - the first team's member and a superadmin acting for the first team ask Home, Record in each period,
 *     Approvals in each tab, Initiatives and `work/query` by every measure and every dimension it allows,
 *     over a window holding the whole seed and against the previous one, each group drilled to its rows,
 *     plainly and with the second team named and the platform asked for; every answer is 200 and holds
 *     none of the second team's sentinels and no link, and the closures by initiative name the first
 *     team's delivered initiative, so the sweep read something. The measures and dimensions are read from
 *     the route's own refusals, so one added later is asked without editing this file. The calls of a
 *     plugin's skills (`skill_calls`) are not drilled: its groups are its rows, and the route refuses a
 *     drill of it before reading anything;
 *   - each Work reader reads exactly the approvals signed in their own name, by `<initiative>/<path>`, in
 *     Approvals' History and its tile, Home's paired figure, Record's foot and `work/query`'s approvals by
 *     every dimension and drilled: the first team's admin two, the second person on the same team one,
 *     the acting superadmin none and the second team's admin their one; the first team's admin and the
 *     second person each read their own token in `settings/me/tokens` and none of the other's, and the
 *     others read neither;
 *   - the first team's admin and the second person on the same team each hold, planted here, a labelled
 *     token, an application with a token minted through it, a second browser and a passkey, every label,
 *     name and user agent a fresh sentinel; each reads all of their own in Access, plainly and with the
 *     second team and the platform named, and none of the other's, by sentinel or id; revoking the
 *     other's application or signing out the other's browser answers 404, alike about one nobody has, and
 *     changes none of the other's rows, while revoking their own answers as their own act;
 *   - a close of the second team's initiative, under its own team and under the first, with a body that
 *     would close it, is 404 to the member and to the acting superadmin, alike about an initiative nobody
 *     has, and the initiative stays open with no close recorded; each of them closes an empty initiative
 *     of the first team and that answer holds none of the second team's sentinels.
 */
import { randomBytes, randomUUID } from "node:crypto";

import type { Express } from "express";
import type pg from "pg";

import type { Isolation, WorkRecord } from "../scripts/schema/isolation-seed.ts";

export type Answer = { status: number; text: string };
export interface Route { method: string; path: string }
/** One request as sent: the address with its query, and the body. */
export interface Sent { method: string; url: string; body: Record<string, unknown> | null }

/** How long a stream is read before it is let go. */
const STREAM_MS = 1500;
const WORK = "/api/console/work/query";
const DAY = 86_400_000;

export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
/** Answers' statuses as `200 ×4, 400 ×2`. */
export const tally = (statuses: (number | string)[]): string =>
  [...statuses.reduce((m, o) => m.set(o, (m.get(o) ?? 0) + 1), new Map<number | string, number>())]
    .sort(([a], [b]) => String(a).localeCompare(String(b))).map(([o, n]) => `${o} ×${n}`).join(", ");

/** The `/api/console` routes the application answers, from its router: one per method and path. */
export function routesOf(app: Express): Route[] {
  const stack = (app as unknown as { _router: { stack: { route?: { path: unknown; methods: Record<string, boolean> } }[] } })._router.stack;
  const out: Route[] = [];
  for (const layer of stack) {
    const r = layer.route;
    if (!r || typeof r.path !== "string" || !r.path.startsWith("/api/console")) continue;
    for (const [method, on] of Object.entries(r.methods)) if (on && method !== "_all") out.push({ method, path: r.path });
  }
  return out;
}

/** Sends one request as a signed-in person and reads its answer; a stream is read for `STREAM_MS`, with
 *  `during` run once it opens. */
export async function send(base: string, cookie: string, r: Sent, during?: () => Promise<void>): Promise<Answer> {
  const res = await fetch(`${base}${r.url}`, {
    method: r.method.toUpperCase(), signal: AbortSignal.timeout(60_000),
    headers: { cookie: `zz_console=${cookie}`, ...(r.body ? { "content-type": "application/json" } : {}) },
    ...(r.body ? { body: JSON.stringify(r.body) } : {}),
  });
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
    return { status: res.status, text: await res.text() };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const until = Date.now() + STREAM_MS;
  const poke = during?.();
  try {
    for (;;) {
      const left = until - Date.now();
      if (left <= 0) break;
      const got = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), left))]);
      if (!got || got.done) break;
      text += decoder.decode(got.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    await poke;
  }
  return { status: res.status, text };
}

/** Where `needle` sits in an answer: the JSON path of the first string or key holding it, or its offset. */
function where(text: string, needle: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return `character ${text.indexOf(needle)} of a body that is not JSON`; }
  const walk = (v: unknown, at: string): string | null => {
    if (typeof v === "string") return v.includes(needle) ? at || "the whole body" : null;
    if (!isObj(v)) return null;
    for (const [k, child] of Object.entries(v)) {
      const here = Array.isArray(v) ? `${at}[${k}]` : at ? `${at}.${k}` : k;
      if (k.includes(needle)) return `the key ${here}`;
      const found = walk(child, here);
      if (found) return found;
    }
    return null;
  };
  return walk(parsed, "") ?? `character ${text.indexOf(needle)}`;
}

/** The pages a link in a member's answer may open: the released Platform pages a need links to that every
 *  person reads, which name no team. A team's page is not among them: a member's approvals fold into one row
 *  that links nowhere. COUPLED: `RELEASED` in services/gateway/src/console/platform-needs.ts. */
const OPEN = new Set(["/platform/bugs", "/platform/evaluation", "/platform/usage"]);

/** Every `href` in a JSON answer: how many there are, and those that are neither null nor one of `OPEN`, by path. */
export function hrefs(text: string): { count: number; set: string[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { count: 0, set: [] }; }
  const out = { count: 0, set: [] as string[] };
  const walk = (v: unknown, at: string): void => {
    if (!isObj(v)) return;
    for (const [k, child] of Object.entries(v)) {
      const here = Array.isArray(v) ? `${at}[${k}]` : at ? `${at}.${k}` : k;
      if (k === "href") out.count++;
      if (k === "href" && child !== null && !(typeof child === "string" && OPEN.has(child))) out.set.push(`${here} = ${JSON.stringify(child)}`);
      walk(child, here);
    }
  };
  walk(parsed, "");
  return out;
}

/** The sentinels an answer holds that its request did not carry, each with where it sits. */
export function leaks(s: Isolation, r: Sent, a: Answer): { field: string; at: string }[] {
  const carried = `${r.url} ${r.body ? JSON.stringify(r.body) : ""}`;
  return Object.entries(s.sentinels)
    .filter(([, v]) => a.text.includes(v) && !carried.includes(v) && !decodeURIComponent(carried).includes(v))
    .map(([field, v]) => ({ field, at: where(a.text, v) }));
}

/** A window holding everything the seeds date, whole seconds, from 60 days back to a day ahead. */
export function wide(now = Date.now()): string {
  const at = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");
  return `from=${at(now - 60 * DAY)}&to=${at(now + DAY)}`;
}

/** The questions `work/query` is asked beside every other read's queries: closures by outcome, words by
 *  document, approvals by initiative, and the closures of one initiative drilled to its rows, the second
 *  team's delivered one, which a member must find as empty as one nobody has, and the first team's. */
function workProbes(s: Isolation): string[] {
  const w = wide();
  return [`measure=closures&by=outcome&${w}`, `measure=words&by=document&${w}`, `measure=approvals&by=initiative&${w}`,
    ...[s.two.delivered, s.one.delivered].map((g) => `measure=closures&by=initiative&group=${encodeURIComponent(g)}&limit=100&${w}`)];
}

/** The queries a read is asked with: `base` itself, but for `work/query`, which refuses a request naming
 *  no measure before reading anything, each of `base` joined to each of the Work probes. */
export function queriesFor(path: string, base: string[], s: Isolation): string[] {
  if (path !== WORK) return base;
  return base.flatMap((q) => workProbes(s).map((p) => (q ? `${q}&${p}` : `?${p}`)));
}

/** The query a read's failure round sends: one that reaches a read. */
export const failureQuery = (path: string, s: Isolation): string => (path === WORK ? `?${workProbes(s)[0]}` : "");

/** What the rounds are handed by the harness. */
export interface Context {
  s: Isolation; w: WorkRecord; base: string; sql: pg.Client;
  /** The same request about a team nobody has: the difference in answers, "" when alike, null when the
   *  request names nothing of the second team's. */
  oracle: (r: Sent, a: Answer, cookie: string) => Promise<string | null>;
  found: string[];
  pass: (line: string) => void;
}

/** Every measure `work/query` answers and the dimensions each allows, read from its own 400s; a refusal that
 *  does not name them is put in `found`. */
export async function dimensions(base: string, cookie: string, found: string[]): Promise<[string, string[]][]> {
  const sentence = async (q: string, re: RegExp): Promise<string[]> => {
    const a = await send(base, cookie, { method: "get", url: `${WORK}${q}`, body: null });
    const m = a.status === 400 ? re.exec((JSON.parse(a.text) as { error: string }).error) : null;
    if (m) return m[1].split(", ");
    found.push(`${WORK}${q} answered ${a.status} ${a.text.slice(0, 200)}, not the refusal naming what is allowed`);
    return [];
  };
  const measures = await sentence("", /^measure must be one of (.+)$/);
  return Promise.all(measures.map(async (m): Promise<[string, string[]]> => [m, await sentence(`?measure=${m}`, /is grouped by one of (.+)$/)]));
}

export type Query = { total: { value: number | null }; groups: { key: string; value: { value: number | null } }[];
               rows: { state: string; data?: { rows: Record<string, unknown>[] } } | null };

/** A reader's every Work read, and every drill of every `work/query` group: 200, no sentinel, no link. */
async function sweep(c: Context, who: string, cookie: string, dims: [string, string[]][]): Promise<void> {
  const { s } = c;
  const bad: string[] = [];
  const statuses: number[] = [];
  /** A read naming the second team may be refused instead, as a team the asker is not in is. */
  const ask = async (url: string, forged = false): Promise<Answer> => {
    const req: Sent = { method: "get", url, body: null };
    const a = await send(c.base, cookie, req);
    statuses.push(a.status);
    if (a.status !== 200 && !(forged && a.status === 403)) bad.push(`${url} answered ${a.status}: ${a.text.slice(0, 200)}`);
    for (const l of leaks(s, req, a)) bad.push(`the ${l.field} sentinel in ${url} at ${l.at}`);
    for (const set of hrefs(a.text).set) bad.push(`a link in ${url}: ${set}`);
    return a;
  };
  const forged = ["", `&team=${s.two.slug}&scope=platform`];
  for (const f of forged) {
    for (const path of ["/api/console/home?", "/api/console/record?period=quarter&limit=100", "/api/console/record?period=year&limit=100",
      "/api/console/record?period=all&limit=100", "/api/console/approvals?tab=waiting&limit=100",
      "/api/console/approvals?tab=history&limit=100", "/api/console/initiatives?limit=100"]) await ask(`${path}${f}`, f !== "");
  }
  let named = false;
  for (const [measure, bys] of dims) {
    for (const by of bys) {
      for (const f of forged) {
        const url = `${WORK}?measure=${measure}&by=${by}&compare=previous&${wide()}${f}`;
        const a = await ask(url, f !== "");
        if (a.status !== 200) continue;
        const q = JSON.parse(a.text) as Query;
        if (measure === "closures" && by === "initiative") named ||= q.groups.some((g) => g.key === s.one.delivered);
        // DELIBERATE: skill_calls is refused a drill, its groups being its rows.
        for (const g of measure === "skill_calls" ? [] : q.groups.filter((x) => (x.value.value ?? 0) > 0)) {
          const drilled = JSON.parse((await ask(`${url}&group=${encodeURIComponent(g.key)}&limit=100`, f !== "")).text) as Query;
          if (drilled.rows?.state !== "ok") bad.push(`${url} drilled to ${g.key} answered rows ${JSON.stringify(drilled.rows)}`);
        }
      }
    }
  }
  if (!named) bad.push(`no closures by initiative named ${s.one.delivered}, so the sweep read nothing of the first team's`);
  if (bad.length) c.found.push(...bad.map((b) => `${who}, Work: ${b}`));
  else c.pass(`${who} asked Home, Record, Approvals, Initiatives and ${dims.reduce((n, [, b]) => n + b.length, 0)} measures by ` +
    `dimension drilled to every group, skill_calls' excepted, answered ${tally(statuses)}, none holding the second team's words or a link`);
}

/** One reader's approvals in every Work read, and their tokens: exactly their own. */
async function own(c: Context, who: string, cookie: string, mine: string[], dims: string[], tokens: { mine: { id: string; label: string }[]; theirs: { id: string; label: string }[] }): Promise<void> {
  const bad: string[] = [];
  const read = async (url: string): Promise<Record<string, unknown>> => {
    const a = await send(c.base, cookie, { method: "get", url, body: null });
    if (a.status !== 200) bad.push(`${url} answered ${a.status}: ${a.text.slice(0, 200)}`);
    return a.status === 200 ? JSON.parse(a.text) as Record<string, unknown> : {};
  };
  const want = [...mine].sort().join(", ") || "none";
  const same = (what: string, got: string[]): void => {
    const g = [...got].sort().join(", ") || "none";
    if (g !== want) bad.push(`${what} answered ${g}, where their own are ${want}`);
  };
  const count = (what: string, n: unknown): void => {
    if (n !== mine.length) bad.push(`${what} counted ${JSON.stringify(n)}, where their own are ${mine.length}`);
  };
  const path = (r: Record<string, unknown>): string => `${String(r.initiative)}/${String(r.path)}`;

  const approvals = await read("/api/console/approvals?tab=history&limit=100") as {
    tiles?: { inYourName: number | null }; history?: { state: string; data?: { rows: Record<string, unknown>[]; total: number } } };
  same("History", approvals.history?.data?.rows.map(path) ?? []);
  count("History's total", approvals.history?.data?.total);
  count("Approvals' tile", approvals.tiles?.inYourName);
  const home = await read("/api/console/home") as { approvals?: { data?: { weeks: { figure: { value: number | null } }[] } } };
  count("Home's paired figure", home.approvals?.data?.weeks.reduce((n, w) => n + (w.figure.value ?? 0), 0));
  const record = await read("/api/console/record?period=all") as { foot?: { approvalsInYourName: { value: number | null } } };
  count("Record's foot", record.foot?.approvalsInYourName.value);
  for (const by of dims) {
    const url = `${WORK}?measure=approvals&by=${by}&${wide()}`;
    const q = await read(url) as Partial<Query>;
    count(`work/query's approvals by ${by}`, q.total?.value);
    const rows: string[] = [];
    for (const g of q.groups ?? []) {
      const drilled = await read(`${url}&group=${encodeURIComponent(g.key)}&limit=100`) as Partial<Query>;
      rows.push(...(drilled.rows?.data?.rows ?? []).map(path));
    }
    same(`work/query's approvals by ${by}, drilled`, rows);
  }
  const listed = await send(c.base, cookie, { method: "get", url: "/api/console/settings/me/tokens", body: null });
  const held = listed.status === 200 ? (JSON.parse(listed.text) as { id: string; label: string }[]) : [];
  if (listed.status !== 200) bad.push(`settings/me/tokens answered ${listed.status}`);
  for (const t of tokens.mine) if (!held.some((h) => h.id === t.id && h.label === t.label)) bad.push(`settings/me/tokens left out their own ${t.label}`);
  for (const t of tokens.theirs) if (listed.text.includes(t.id) || listed.text.includes(t.label)) bad.push(`settings/me/tokens held ${t.label}`);

  if (bad.length) c.found.push(...bad.map((b) => `${who}: ${b}`));
  else c.pass(`${who} reads ${mine.length} approval(s), their own alone, in History, its tile, Home's paired figure, ` +
    `Record's foot and work/query's approvals by ${dims.join(", ")} drilled to rows, and ` +
    (tokens.mine.length ? "their own token and nobody else's" : "nobody's token of the first team's"));
}

/** What `holdings` planted for one person: the sentinels by field, and the ids a request can name. */
interface Held { email: string; sentinels: Record<"tokenLabel" | "application" | "userAgent" | "passkey", string>;
                 tokens: string[]; client: string; browser: string }

/** Plants for `email` a labelled token, an application with a token minted through it, a second browser and a
 *  passkey, each label, name and user agent a fresh sentinel, the random half led by a letter as the seed's. */
async function holdings(sql: pg.Client, email: string): Promise<Held> {
  const half = (): string => randomBytes(8).toString("hex").replace(/^\d/, (d) => "abcdef"[Number(d) % 6]);
  const x = { tokenLabel: `tokenlabel-${half()}`, application: `application-${half()}`, userAgent: `useragent-${half()}`, passkey: `passkey-${half()}` };
  const client = `isolation-client-${half()}`;
  await sql.query("insert into zz.mcp_oauth_client (client_id, redirect_uris, name) values ($1, '[]'::jsonb, $2)", [client, x.application]);
  const tokens = (await sql.query<{ id: string }>(
    `insert into zz.pat (principal_id, token_hash, label, oauth_client_id)
     select p.id, v.hash, v.label, v.client from zz.principal p,
            (values ($2, $3, null::text), ($4, $5, $6)) v(hash, label, client) where p.email = $1 returning id::text as id`,
    [email, randomBytes(32).toString("hex"), x.tokenLabel, randomBytes(32).toString("hex"), `${x.application} token`, client])).rows.map((r) => r.id);
  const { rows: [b] } = await sql.query<{ id: string }>(
    `insert into zz.console_session (principal_id, token_hash, expires_at, user_agent)
     select id, $2, now() + interval '1 hour', $3 from zz.principal where email = $1 returning id::text as id`,
    [email, randomBytes(32).toString("hex"), x.userAgent]);
  await sql.query(
    `insert into zz.passkey (id, principal_id, public_key, transports, label)
     select $2, id, '\\x00'::bytea, '{internal}', $3 from zz.principal where email = $1`, [email, `credential-${half()}`, x.passkey]);
  return { email, sentinels: x, tokens, client, browser: b.id };
}

/** Each of two people on one team in Access: all of their own, none of the other's, and the other's application
 *  and browser beyond their revokes. */
async function access(c: Context, people: { label: string; cookie: string; held: Held }[]): Promise<void> {
  const { s } = c;
  /** The other's rows a revoke could change: their tokens, browsers, passkeys and applications. */
  const rowsOf = async (email: string): Promise<string> => (await c.sql.query<{ h: string }>(
    `with p as (select id from zz.principal where email = $1)
     select md5(coalesce(string_agg(x, '|' order by x), '')) as h from (
       select 'pat ' || t.id || ' ' || coalesce(t.revoked_at::text, '-') from zz.pat t where t.principal_id = (select id from p)
       union all select 'session ' || s.id || ' ' || coalesce(s.revoked_at::text, '-') from zz.console_session s where s.principal_id = (select id from p)
       union all select 'passkey ' || k.id || ' ' || coalesce(k.label, '-') from zz.passkey k where k.principal_id = (select id from p)
       union all select 'client ' || o.client_id || ' ' || coalesce(o.revoked_at::text, '-') from zz.mcp_oauth_client o
        where o.client_id in (select oauth_client_id from zz.pat where principal_id = (select id from p))
     ) s(x)`, [email])).rows[0].h;
  for (const [me, other] of [[people[0], people[1]], [people[1], people[0]]]) {
    const bad: string[] = [];
    const theirs = [...Object.entries(other.held.sentinels).map(([f, v]) => [`their ${f}`, v]),
      ...other.held.tokens.map((id) => ["their token's id", id]), ["their application's client", other.held.client], ["their browser's id", other.held.browser]];
    for (const q of ["", `?team=${s.two.slug}&scope=platform`, `?team=${s.one.slug}`]) {
      const a = await send(c.base, me.cookie, { method: "get", url: `/api/console/access${q}`, body: null });
      if (a.status !== 200) { bad.push(`access${q} answered ${a.status}: ${a.text.slice(0, 200)}`); continue; }
      const missing = Object.entries(me.held.sentinels).filter(([, v]) => !a.text.includes(v)).map(([f]) => f);
      if (missing.length) bad.push(`access${q} left out their own ${missing.join(", ")}`);
      for (const [what, v] of theirs) if (a.text.includes(v)) bad.push(`access${q} held ${what}`);
    }
    const before = await rowsOf(other.held.email);
    for (const [path, real, ghost] of [["applications", other.held.client, `isolation-client-${randomBytes(8).toString("hex")}`],
                                       ["browsers", other.held.browser, randomUUID()]]) {
      const [a, g] = [await send(c.base, me.cookie, { method: "delete", url: `/api/console/settings/me/${path}/${real}`, body: null }),
                      await send(c.base, me.cookie, { method: "delete", url: `/api/console/settings/me/${path}/${ghost}`, body: null })];
      if (a.status !== 404) bad.push(`revoking their ${path} entry answered ${a.status}, not 404: ${a.text.slice(0, 200)}`);
      if (`${a.status} ${a.text}` !== `${g.status} ${g.text}`) bad.push(`revoking their ${path} entry answered ${a.text}; one nobody has, ${g.text}`);
    }
    // `logEvent` does not wait for its write: what a revoke changed is given a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (await rowsOf(other.held.email) !== before) bad.push("their revokes changed the other's tokens, browsers, passkeys or applications");
    if (bad.length) c.found.push(...bad.map((b) => `${me.label}, Access: ${b}`));
    else c.pass(`${me.label} reads their own token, application, browser and passkey in Access however asked, and none of ` +
      `${other.label}'s by sentinel or id; revoking ${other.label}'s application or browser is 404, alike about one nobody has, and changes nothing`);
  }
  // Their own revokes answer: the 404s above were about whose, not about the routes.
  for (const me of people) {
    const app = await send(c.base, me.cookie, { method: "delete", url: `/api/console/settings/me/applications/${me.held.client}`, body: null });
    const browser = await send(c.base, me.cookie, { method: "delete", url: `/api/console/settings/me/browsers/${me.held.browser}`, body: null });
    if (app.status !== 200 || browser.status !== 200) {
      c.found.push(`${me.label}, Access: their own application and browser answered ${app.status} and ${browser.status}, not 200: ${app.text} ${browser.text}`);
    } else c.pass(`${me.label}'s revoke of their own application and their own other browser each answers 200`);
  }
}

/** Closes aimed at the second team's initiative, which close nothing, and one close of the first team's
 *  by each closer, whose answer holds nothing of the second team's. */
async function closes(c: Context, who: string, cookie: string, mine: string): Promise<void> {
  const { s } = c;
  const bad: string[] = [];
  const body = { disposition: "abandoned" };
  for (const team of [s.two.slug, s.one.slug]) {
    const req: Sent = { method: "post", url: `/api/console/initiatives/${encodeURIComponent(team)}/${encodeURIComponent(s.two.initiative)}/close`, body };
    const a = await send(c.base, cookie, req);
    if (a.status !== 404) bad.push(`${req.url} answered ${a.status}, not 404: ${a.text.slice(0, 200)}`);
    for (const l of leaks(s, req, a)) bad.push(`the ${l.field} sentinel in ${req.url} at ${l.at}`);
    const differs = await c.oracle(req, a, cookie);
    if (differs) bad.push(differs);
  }
  const { rows: [left] } = await c.sql.query<{ closed: boolean; acts: number }>(
    `select i.closed_at is not null as closed,
            (select count(*)::int from zz.event e where e.initiative_id = i.id and e.kind like '%close%') as acts
       from zz.initiative i where i.slug = $1`, [s.two.initiative]);
  if (left.closed || left.acts) bad.push(`${s.two.initiative} reads closed ${left.closed} with ${left.acts} close act(s)`);
  const req: Sent = { method: "post", url: `/api/console/initiatives/${s.one.slug}/${mine}/close`, body };
  const a = await send(c.base, cookie, req);
  if (a.status !== 200) bad.push(`${req.url} answered ${a.status}, not their own close: ${a.text.slice(0, 200)}`);
  for (const l of leaks(s, req, a)) bad.push(`the ${l.field} sentinel in ${req.url} at ${l.at}`);
  if (bad.length) c.found.push(...bad.map((b) => `${who}, the close: ${b}`));
  else c.pass(`${who}'s close of the second team's initiative is 404 under either team, alike about one nobody has, and ` +
    `closes nothing; their own close answers ${a.status} holding nothing of the second team's`);
}

/** Work's rounds, after the harness's own. */
export async function workRounds(c: Context): Promise<void> {
  const { s, w } = c;
  const readers = {
    one: { label: "the first team's member", cookie: s.cookies.one },
    acting: { label: "the superadmin acting for the first team", cookie: w.cookies.acting },
    colleague: { label: "a second person on the first team", cookie: w.cookies.colleague },
    two: { label: "the second team's member", cookie: s.cookies.two },
  };
  const dims = await dimensions(c.base, s.cookies.one, c.found);
  for (const r of [readers.one, readers.acting]) await sweep(c, r.label, r.cookie, dims);
  const approvalDims = dims.find(([m]) => m === "approvals")?.[1] ?? [];
  if (!approvalDims.length) c.found.push(`${WORK} answers no approvals measure to be asked about`);
  for (const [key, r] of Object.entries(readers) as [keyof typeof readers, (typeof readers)["one"]][]) {
    const mine = key === "one" || key === "colleague" ? [w.tokens[key]] : [];
    const theirs = (["one", "colleague"] as const).filter((k) => k !== key).map((k) => w.tokens[k]);
    await own(c, r.label, r.cookie, w.approvals[key], approvalDims, { mine, theirs });
  }
  await access(c, [{ ...readers.one, held: await holdings(c.sql, s.one.email) },
                   { ...readers.colleague, held: await holdings(c.sql, w.colleague) }]);
  await closes(c, readers.one.label, readers.one.cookie, w.closable.one);
  await closes(c, readers.acting.label, readers.acting.cookie, w.closable.acting);
}
