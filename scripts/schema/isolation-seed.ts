/**
 * Two teams of the same kinds of row, seeded into a throwaway database, with the second team's free text
 * made of sentinels generated afresh on every call: `checks/console-isolation.ts` signs a member of the
 * first team in and finds none of them in any answer the console gives that member.
 *
 * What it writes, for each team, the second's every listed field a sentinel and the first's plain words:
 *
 *   - the team (its slug and its name), one admin acting for it, and one access token of that admin's;
 *   - an open initiative of `sdlc-flow` holding `spec.md`, presented 20 days ago and not approved, so it
 *     waits for approval (its title and body), and a second initiative delivered two days ago;
 *   - a bug report fixed (its title, detail, surface and resolution) and one open, filed in the open
 *     initiative;
 *   - a plugin the team owns, a protocol version (its key) with one measure (its key), a scored run and a
 *     deferred finding (its `pattern`, `decision_note` and `owner_ref`);
 *   - a knowledge node (its title and body) and the `knowledge.add` event that recorded it (its `detail`);
 *   - one event of each kind `PLANTED` names, laid out as its own writer lays it out, its free text the
 *     field's: what a read that selects a subject, a refusal or a detail key would show.
 *
 * And a person in both teams, active in the second, who signs in as nobody: what a read listing the
 * first team's people must not say of the second. And a superadmin in no team. It signs the admins and
 * the superadmin in, each with a live console session.
 *
 * The planted events are dated now, inside the running week, so no complete week of a seed beside it
 * (`status-seed.ts`) moves. Of them only the search, a real-work search that found nothing, is counted
 * by a real-work figure, the searches'; the refused call is maintenance; every other kind no real-work
 * figure counts. Its reports and its delivered initiatives do move the bug and finished-work figures.
 * `seedWork` adds real-work calls of both teams, so the weekly reads have a record to begin at; a seed
 * that brings its own record (the skeleton's) leaves it out. Its people and slugs are its own, so it
 * runs beside any other seed on one database.
 *
 * `seedWorkRecord` adds, through a real zz-core, what Work's reads are asked about: a second person on
 * the first team with a labelled token of their own, beside a labelled token of the first team's admin; a
 * superadmin who is a member of the first team and acts for it; approvals made by the first team's admin
 * (two), by that second person (one) and by the second team's admin (one, in an initiative named by the
 * initiative sentinel); a run of each team in its open initiative; and an empty initiative of the first
 * team for each of its admin and that superadmin to close.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs.
 */
import { randomBytes, randomUUID } from "node:crypto";

import type pg from "pg";

import { signIn } from "./status-seed.ts";
import type { Core } from "./throwaway-core.ts";

/** Every field of the second team's that carries a sentinel. */
const FIELDS = [
  "slug", "name", "initiative", "docTitle", "docBody", "bugTitle", "bugDetail", "bugSurface", "bugResolution",
  "pattern", "decisionNote", "ownerRef", "protocolKey", "measureKey", "eventDetail", "nodeTitle", "nodeBody",
  "question", "refusal", "reportTitle", "deletedTitle", "journalDetail", "documentDetails", "filename", "tokenLabel",
] as const;
type Field = (typeof FIELDS)[number];

/** The events a team's free text is planted in, one row of each kind: the field, the row's kind, and where
 *  in the row the text sits. A member reads none of the second team's; Audit answers none of it to the
 *  superadmin either, and Knowledge health only the question. */
export const PLANTED = [
  { field: "question", kind: "knowledge.search", at: "subject" },
  { field: "refusal", kind: "tool_call", at: "refusal" },
  { field: "reportTitle", kind: "bug_report", at: "detail.title" },
  { field: "deletedTitle", kind: "bug.delete", at: "detail.title" },
  { field: "journalDetail", kind: "knowledge.create", at: "detail.detail" },
  { field: "documentDetails", kind: "document.write", at: "detail.details" },
  { field: "filename", kind: "upload.start", at: "detail.filename" },
  { field: "tokenLabel", kind: "admin.issue_pat", at: "detail.label" },
] as const satisfies readonly { field: Field; kind: string; at: string }[];

/** One team's rows, by what a request names them with. */
interface Team {
  slug: string; name: string; email: string;
  /** The open initiative's dated slug, the delivered one's, and the document's path inside the open one. */
  initiative: string; delivered: string; docPath: string;
  /** The fixed report's id and the open one's. */
  bugs: { fixed: string; open: string };
  plugin: string; finding: string; tokenId: string;
  /** The node's address on its shelf, as the knowledge routes take it. */
  node: string;
}

/** What `seedIsolation` wrote: both teams, the person in both, the superadmin, the secret each signed-in
 *  person's `zz_console` cookie carries, and the second team's sentinels by field. */
export interface Isolation {
  one: Team; two: Team; both: string; superadmin: string;
  cookies: { one: string; two: string; superadmin: string };
  sentinels: Record<Field, string>;
}

/** A fresh sentinel per field, lower-case so the slug's stays a slug, and none a substring of another. Its
 *  random half begins with a letter, since a search asks by that half alone: PostgreSQL's parser reads a
 *  digit-led half alone otherwise than inside the hyphenated sentinel (`12e4ab…` as the number `12e4` then the
 *  word `ab…`, all digits as a signed integer), so the search would miss the row that holds it. */
function sentinels(): Record<Field, string> {
  const half = (): string => randomBytes(8).toString("hex").replace(/^\d/, (d) => "abcdef"[Number(d) % 6]);
  return Object.fromEntries(FIELDS.map((f) => [f, `${f.toLowerCase()}-${half()}`])) as Record<Field, string>;
}

/** The first team's words for each field. */
function plain(): Record<Field, string> {
  return Object.fromEntries(FIELDS.map((f) => [f, `first team ${f}`])) as Record<Field, string>;
}

const DAY = 86_400_000;

async function seedTeam(db: pg.ClientBase | pg.Pool, n: "one" | "two", slug: string, w: Record<Field, string>, now: number): Promise<Team> {
  const one = async (sql: string, args: unknown[]): Promise<string> => (await db.query<{ id: string }>(sql, args)).rows[0].id;
  const ago = (days: number): string => new Date(now - days * DAY).toISOString();
  const email = `${n}@isolation.example.test`;
  const admin = await one("insert into zz.principal (email, display_name, role) values ($1, $2, 'member') returning id", [email, `Isolation ${n}`]);
  const team = await one("insert into zz.team (slug, name, created_by) values ($1, $2, $3) returning id", [slug, w.name, admin]);
  await db.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'admin', $2)", [team, admin]);
  await db.query("update zz.principal set active_team_id = $1 where id = $2", [team, admin]);
  const tokenId = await one(
    // Unlabelled, as a token nobody replaces is: the one the other team's member tries to delete.
    "insert into zz.pat (principal_id, token_hash) values ($1, $2) returning id",
    [admin, randomBytes(32).toString("hex")]);

  const initiative = n === "one" ? "2026-10-01-first-team-work" : `2026-10-01-${w.initiative}`;
  const delivered = n === "one" ? "2026-09-01-first-team-delivered" : `2026-09-01-${w.initiative}-delivered`;
  const open = await one(
    "insert into zz.initiative (team_id, slug, flow, opened_by, opened_at) values ($1, $2, 'sdlc-flow', $3, $4) returning id",
    [team, initiative, admin, ago(40)]);
  await db.query(
    `insert into zz.initiative (team_id, slug, flow, opened_by, opened_at, closed_at, closed_by, outcome, accepted_by)
     values ($1, $2, 'sdlc-flow', $3::uuid, $4, $5, $3::uuid, 'delivered', $3::uuid)`, [team, delivered, admin, ago(30), ago(2)]);

  // A document and its one revision, presented and not approved: it waits.
  const docPath = "spec.md";
  await db.query("begin");
  await db.query("set constraints all deferred");
  const doc = await one(
    `insert into zz.doc (initiative_id, path, type, status, updated_at, title, body, current_revision, current_version)
     values ($1, $2, 'spec', 'draft', $3, $4, $5, 1, 1) returning id`, [open, docPath, ago(20), w.docTitle, w.docBody]);
  await db.query(
    `insert into zz.doc_revision (doc_id, revision, version, content_state, title, body, tags, content_hash, written_by,
                                  written_at, presented_at)
     values ($1, 1, 1, 'retained', $2, $3, '{}', $4, $5, $6, $6)`,
    [doc, w.docTitle, w.docBody, `hash-${doc}`, admin, ago(20)]);
  await db.query("commit");

  const report = (status: "fixed" | "open", days: number): Promise<string> => one(
    `insert into zz.bug (reported_at, title, detail, surface, platform_version, impact, status, resolution, resolved_at,
                         team_id, initiative_id, reported_by, resolved_by)
     values ($1, $2, $3, $4, '0.99.0', 'confusing', $5, case when $5 = 'open' then null else $6 end,
             case when $5 = 'open' then null else $1::timestamptz + interval '1 hour' end, $7, $8, $9,
             case when $5 = 'open' then null else $9::uuid end) returning id`,
    [ago(days), w.bugTitle, w.bugDetail, w.bugSurface, status, w.bugResolution, team, open, admin]);
  const bugs = { fixed: await report("fixed", 6), open: await report("open", 3) };

  const plugin = `isolation-${n}-plugin`;
  const pluginId = await one("insert into zz.plugin (name, origin, owner_team_id) values ($1, 'platform', $2) returning id", [plugin, team]);
  const protocol = await one(
    `insert into zz.eval_protocol_version
       (version, purpose, qualification_policy, scoring_policy, improvement_policy, content_digest, created_at,
        plugin_id, protocol_key, observable_surfaces, recorded_by)
     values (1, 'seeded', '{}', '{}', '{}', $1, $2, $3, $4, '{}', $5) returning id`,
    [`digest-isolation-${n}`, ago(10), pluginId, w.protocolKey, admin]);
  const dimension = await one(
    `insert into zz.eval_dimension (protocol_version_id, key, canonical_kind, weight, required)
     values ($1, 'effectiveness', 'effectiveness', 1, true) returning id`, [protocol]);
  const measure = await one(
    `insert into zz.eval_measure (dimension_id, key, evaluator_type, weight, required, definition, protocol_version_id, fact_key)
     values ($1, $2, 'deterministic', 1, true, '{}', $3, 'seeded_fact') returning id`, [dimension, w.measureKey, protocol]);
  const version = await one("insert into zz.plugin_version (plugin_id, version, digest) values ($1, '1.0.0', $2) returning id",
                            [pluginId, `digest-isolation-${n}-1`]);
  const snapshot = await one(
    `insert into zz.eval_observation_snapshot
       (usable_run_count, total_run_count, evidence_digest, created_at, plugin_version_id, surface_observed,
        surface_total, surface_source, platform_version, recorded_by)
     values (5, 5, $1, $2, $3, 1, 1, null, '0.99.0', $4) returning id`, [`evidence-isolation-${n}`, ago(9), version, admin]);
  const run = await one(
    `insert into zz.eval_run
       (protocol_version_id, score_status, overall_score, guardrail_status, created_at, team_id, initiative_id,
        observation_snapshot_id, score_lower, score_upper, scorer_version, started_by, scored_at)
     values ($1, 'established', 0.8, 'pass', $2, $3, $4, $5, 0.7, 0.9, '0.99.0', $6, $2) returning id`,
    [protocol, ago(9), team, open, snapshot, admin]);
  const finding = await one(
    `insert into zz.eval_finding (eval_run_id, kind, pattern, owner_kind, owner_ref, measure_id, evidence_refs, decision,
                                  decision_note, created_at)
     values ($1, 'defect', $2, 'environment', $3, $4, '[]'::jsonb, 'deferred', $5, $6) returning id`,
    [run, w.pattern, w.ownerRef, measure, w.decisionNote, ago(16)]);

  const nodeSlug = n === "one" ? "first-team-lesson" : "second-team-lesson";
  await db.query(
    `insert into zz.knowledge_node (kind, title, body, team_id, node_ordinal, slug)
     values ('decision', $1, $2, $3, 1, $4)`, [w.nodeTitle, w.nodeBody, team, nodeSlug]);
  await db.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id)
     values ($1, 'knowledge.add', '1', $2::jsonb, 'work', $3, $4)`,
    [ago(1), JSON.stringify({ title: w.eventDetail, note: w.eventDetail }), team, admin]);

  // PLANTED, each row as its writer leaves it: zz-core's search, report, deletion, journal entry, document
  // act and upload, the gateway's maintenance call and token issue. The journal and a deletion name no team.
  const at = new Date(now).toISOString();
  const plant = (kind: string, subject: string, detail: Record<string, unknown>, by: string | null, own: boolean, initiative: string | null = null) =>
    db.query(
      `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id, initiative_id)
       values ($1, $2, $3, $4::jsonb, 'work', $5, $6, $7)`,
      [at, kind, subject, JSON.stringify(detail), own ? team : null, by, initiative]);
  await plant("knowledge.search", w.question, { returned: [], ranked_total: 0, broadened: false, filters: {} }, admin, true);
  await db.query(
    `insert into zz.event (ts, kind, subject, tool_key, ok, refusal, refusal_owner, origin, detail, team_id, actor_id, duration_ms)
     values ($1, 'tool_call', 'core:document_write', 'core:document_write', false, $2, 'theirs', 'platform', $3::jsonb, $4, $5, 40)`,
    [at, `ERROR: SECTION_MISSING — ${w.refusal}`, JSON.stringify({ client: "chain-check", args: ["path", "body"] }), team, admin]);
  await plant("bug_report", bugs.open, { bug: bugs.open, title: w.reportTitle }, admin, true, open);
  await plant("bug.delete", randomUUID(), { title: w.deletedTitle }, admin, false);
  await plant("knowledge.create", "0002", { node: "0002", detail: w.journalDetail }, null, false);
  await plant("document.write", `${initiative}/${docPath}`, {
    user: email, action: "write", path: `${initiative}/${docPath}`, details_ref: `dr_${n === "one" ? "a" : "b"}${"c".repeat(25)}`,
    details: `## ${w.documentDetails}` }, admin, true, open);
  await plant("upload.start", randomUUID(), { filename: w.filename }, admin, true);
  await plant("admin.issue_pat", email, { team: slug, label: w.tokenLabel, expires_at: ago(-30) }, admin, true);

  return { slug, name: w.name, email, initiative, delivered, docPath, bugs, plugin, finding, tokenId, node: `nodes/1-${nodeSlug}.md` };
}

/** Seeds both teams, the person in both and the superadmin into `db`, signs the admins and the superadmin
 *  in, and answers what it wrote; the second team's slug is its own sentinel. */
export async function seedIsolation(db: pg.ClientBase | pg.Pool, now = Date.now()): Promise<Isolation> {
  const s = sentinels();
  const superadmin = "superadmin@isolation.example.test";
  await db.query("insert into zz.principal (email, display_name, role) values ($1, 'Isolation superadmin', 'superadmin')", [superadmin]);
  const one = await seedTeam(db, "one", "team-one", plain(), now);
  const two = await seedTeam(db, "two", s.slug, s, now);
  // A member of both, active in the second: data the readers read about, never a reader.
  const both = "both@isolation.example.test";
  await db.query("insert into zz.principal (email, display_name, role) values ($1, 'Isolation both', 'member')", [both]);
  await db.query(
    `insert into zz.membership (team_id, principal_id, role, added_by)
     select t.id, p.id, 'member', a.id from zz.team t join zz.principal a on a.active_team_id = t.id and a.email = any($2::text[]),
            zz.principal p where p.email = $1`, [both, [one.email, two.email]]);
  await db.query("update zz.principal set active_team_id = (select id from zz.team where slug = $2) where email = $1", [both, two.slug]);
  const cookies = { one: await signIn(db, one.email), two: await signIn(db, two.email), superadmin: await signIn(db, superadmin) };
  return { one, two, both, superadmin, cookies, sentinels: s };
}

/** Real-work calls of both teams' admins, 20, 9 and 2 days before `now`: where the record of real work begins,
 *  so the weeks Usage, Teams and Knowledge health read exist, and each team has calls to be split by. */
export async function seedWork(db: pg.ClientBase | pg.Pool, s: Isolation, now = Date.now()): Promise<void> {
  await db.query(
    `insert into zz.event (ts, kind, subject, tool_key, ok, origin, detail, team_id, actor_id, duration_ms)
     select $1::timestamptz - d * interval '1 day', 'tool_call', 'core:knowledge_search', 'core:knowledge_search', true, 'work',
            '{}'::jsonb, p.active_team_id, p.id, 120
       from zz.principal p, unnest(array[20, 9, 2]) d where p.email = any($2::text[])`,
    [new Date(now).toISOString(), [s.one.email, s.two.email]]);
}

/** The Work readers `seedWorkRecord` adds or reads for, each with the approvals signed in their name. */
type Reader = "one" | "colleague" | "acting" | "two";

/** What `seedWorkRecord` wrote. */
export interface WorkRecord {
  /** The second person on the first team, and the superadmin acting for the first team. */
  colleague: string; acting: string;
  cookies: { colleague: string; acting: string };
  /** Each reader's approvals, as `<initiative>/<path>`. */
  approvals: Record<Reader, string[]>;
  /** The labelled token of the first team's admin and the one of the second person. */
  tokens: Record<"one" | "colleague", { id: string; label: string }>;
  /** An empty initiative of the first team for each closer: its admin and the acting superadmin. */
  closable: { one: string; acting: string };
}

const NOTES = "# Notes\n\n## Alpha\n\nalpha line one\n\n## Beta\n\nbeta line one\n";

/** Seeds, beside `seedIsolation`'s rows and through the zz-core `c` runs, the people, tokens, approvals,
 *  runs and initiatives `WorkRecord` names, every one dated now. */
export async function seedWorkRecord(c: Pick<Core, "sql" | "client" | "ok">, s: Isolation): Promise<WorkRecord> {
  const db = c.sql;
  const one = async (sql: string, args: unknown[]): Promise<string> => (await db.query<{ id: string }>(sql, args)).rows[0].id;
  const colleague = "colleague@isolation.example.test";
  const acting = "acting@isolation.example.test";
  for (const [email, name, role] of [[colleague, "Isolation colleague", "member"], [acting, "Isolation acting superadmin", "superadmin"]]) {
    await db.query("insert into zz.principal (email, display_name, role) values ($1, $2, $3)", [email, name, role]);
    await db.query(
      `insert into zz.membership (team_id, principal_id, role, added_by)
       select t.id, p.id, 'member', a.id from zz.team t, zz.principal p, zz.principal a where t.slug = $1 and p.email = $2 and a.email = $3`,
      [s.one.slug, email, s.one.email]);
    await db.query("update zz.principal set active_team_id = (select id from zz.team where slug = $2) where email = $1", [email, s.one.slug]);
  }
  const token = async (email: string, label: string): Promise<{ id: string; label: string }> => {
    const principal = await one("select id from zz.principal where email = $1", [email]);
    // A label names one purpose with one live token, as every writer of a token keeps it.
    await db.query("update zz.pat set revoked_at = now() where principal_id = $1 and label = $2 and label <> '' and revoked_at is null",
      [principal, label]);
    const id = await one("insert into zz.pat (principal_id, token_hash, label) values ($1, $2, $3) returning id",
      [principal, randomBytes(32).toString("hex"), label]);
    return { id, label };
  };
  const tokens = { one: await token(s.one.email, "first person's token"), colleague: await token(colleague, "colleague's token") };

  // Each approval as zz-core makes one: a freeform initiative holding one document, presented and approved
  // by its signer.
  const signed = async (email: string, slug: string): Promise<string> => {
    const as = c.client({ email });
    const opened = await c.ok(`open ${slug}`, "initiative_open", { slug }, as);
    const path = `${(JSON.parse(opened) as { initiative: string }).initiative}/notes.md`;
    await c.ok(`write ${path}`, "document_write", { path, content: NOTES }, as);
    await c.ok(`present ${path}`, "document_present", { path }, as);
    await c.ok(`approve ${path}`, "document_approve", { path }, as);
    return path;
  };
  const approvals: Record<Reader, string[]> = {
    one: [await signed(s.one.email, "first-person-signed"), await signed(s.one.email, "first-person-signed-again")],
    colleague: [await signed(colleague, "colleague-signed")],
    acting: [],
    two: [await signed(s.two.email, `${s.sentinels.initiative}-signed`)],
  };
  const empty = async (email: string, slug: string): Promise<string> =>
    (JSON.parse(await c.ok(`open ${slug}`, "initiative_open", { slug }, c.client({ email }))) as { initiative: string }).initiative;
  const closable = { one: await empty(s.one.email, "first-person-closes"), acting: await empty(acting, "acting-superadmin-closes") };

  // A run of each team in its open initiative, a day ago, as runs-seed.ts writes runs.
  const skill = await one("insert into zz.skill (name) values ('isolation-skill') returning id", []);
  const version = await one("insert into zz.skill_version (skill_id, version, content_hash) values ($1, '1.0.0', $2) returning id",
                            [skill, randomBytes(32).toString("hex")]);
  for (const team of [s.one, s.two]) {
    await db.query(
      `insert into zz.skill_run (team_id, initiative_id, skill_version_id, session, calls, bytes_total, started_at, ended_at)
       select t.id, i.id, $3, $4, 3, 100, now() - interval '1 day', now() - interval '1 day' + interval '10 minutes'
         from zz.team t join zz.initiative i on i.team_id = t.id and i.slug = $2 where t.slug = $1`,
      [team.slug, team.initiative, version, `isolation-${randomUUID()}`]);
  }
  return {
    colleague, acting, cookies: { colleague: await signIn(db, colleague), acting: await signIn(db, acting) },
    approvals, tokens, closable,
  };
}
