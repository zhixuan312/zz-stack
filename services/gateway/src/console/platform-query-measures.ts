/**
 * The measures of the Platform prepared query (platform-query.ts): each one's dimensions and who may ask them, what it
 * counts and the rows it drills to, read by the functions its page draws its figure with, never a second statement of
 * the same thing:
 *
 *   calls          usage-figures.ts callDays           Usage's calls by week, by tool and, the superadmin's, by team
 *   refusals       usage-figures.ts callDays           Status's and Usage's refusals, under their four owners
 *   malformed      usage-figures.ts callDays           Status's and Releases' malformed calls, the ones refused as ours
 *   releases       platform-releases.ts releaseTimes   Releases' releases by week, and its rows
 *   migrations     platform-releases.ts migrationTimes Releases' migrations applied
 *   bugs_filed     platform-bugs.ts realReports        Bugs' filed by week, by impact and the queue's counts
 *   bugs_resolved  platform-bugs.ts realReports        Bugs' resolved, dated as its cohorts date them, by filing
 *   findings       platform-evaluation.ts              Evaluation's findings by decision and by owner
 *   scores         platform-evaluation.ts              Evaluation's scores established: a plugin whose latest scoring
 *                                                      by the window's end is established and inside the window
 *   lessons        platform-knowledge.ts readLessons   Knowledge health's lessons made, imports told apart
 *   searches       platform-measures.ts searchDays     Knowledge health's and Status's searches
 *   model_calls    usage-figures.ts modelDays          Usage's model calls
 *   teams          teams.ts readBases                  Teams' tiles: every team made by the window's end, a stock
 *   people         people.ts peopleRows                People's tiles: every person added by the window's end, a stock
 *   sign_ins       people.ts signInDays                People's recorded sign-ins
 *   audit          platform-audit.ts auditDays         Audit's events, page views left out, by kind and team
 *
 * A fact is a count of one local day and one key along each dimension; `facts` answers those inside the span it is
 * given, a stock those made by its last day whatever its first. A drill answers the rows its page draws for the facts
 * a question kept, newest first, each with the instant it is ordered by and its console address.
 *
 * What a member reads is what the measure's page shows a member: no team's name, since `team` is the superadmin's
 * dimension and a member's shelves are their own, the shared one and the rest of them unnamed; a bug report's public
 * row; a finding's safe form; and nothing of Teams, People, sign-ins, Audit or the questions searches asked.
 */
import { REFUSAL_OWNERS } from "@zz/contracts";
import type pg from "pg";

import { PLATFORM_TEAM } from "../identity.js";
import { lessonImports } from "./imports.js";
import { KIND, auditDays, auditEvents } from "./platform-audit.js";
import { IMPACTS, STATES, STATUSES, adminRows, publicRow, realReports, vocabulary, type RealReport } from "./platform-bugs.js";
import { countedFindings, latestScores, pluginNames, waitingFindings, type PluginRow } from "./platform-evaluation.js";
import { KINDS, readLessons, readQuestions, readSlugs, type Question } from "./platform-knowledge.js";
import { searchDays } from "./platform-measures.js";
import { migrationTimes, releaseRows, releaseTimes } from "./platform-releases.js";
import { UNREGISTERED } from "./platform-usage.js";
import { STATES as PERSON_STATES, peopleRows, signInDays, type PersonRow } from "./people.js";
import { STATUSES as TEAM_STATUSES, readBases, readFigures, rowOf, type Base } from "./teams.js";
import { callDays, modelDays, modelsCalled, registeredTools, type CallDay } from "./usage-figures.js";
import { addDays, localDay, midnight } from "./work-query-buckets.js";

export type Who = { superadmin: boolean; activeTeam: string | null };
/** The days a read reaches, both included: `from` null for every day before `to`. */
export type Span = { from: string | null; to: string };
/** What every read of one request shares: the database, the one cutoff, and who asks. */
export type Ctx = { db: pg.Pool; asOf: string; asOfMs: number; who: Who };
type Keys = Record<string, string | null>;
/** `n` counted on one local day under one key along each dimension; `lastMs` the latest of them; `ref` what a drill
 *  reads its row from. */
export type Fact = { day: string; keys: Keys; n: number; lastMs: number; ref?: unknown };
export type Row = Record<string, unknown> & { at: string; address: string };
type Drilled = { rows: Row[]; total: number };

/** One dimension: whether a value is in its vocabulary; the values always answered, an empty one as zero; the
 *  sentence a value outside it is refused with, which never echoes the value; the label of the group of rows with no
 *  value; and its groups' labels. */
export type Dim = {
  superadmin?: true;
  has: (c: Ctx, value: string) => boolean | Promise<boolean>;
  fixed?: (who: Who) => readonly string[];
  refuse: (who: Who) => string;
  none: string;
  label?: (key: string, who: Who) => string;
};
export type Measure = {
  dims: Record<string, Dim>;
  superadmin?: true;
  /** Counted as of the window's last day, whatever its first: no window before it and no bucket. */
  stock?: true;
  buckets: boolean;
  population: string;
  /** The sentence a drill is refused with, naming the page that lists its rows; absent where it is drilled. */
  notDrilled?: string;
  /** Drilled for the superadmin alone. */
  drillSuperadmin?: true;
  facts(c: Ctx, span: Span): Promise<Fact[]>;
  rows?(c: Ctx, kept: Fact[], want: number): Promise<Drilled>;
};

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const words = (key: string): string => key[0].toUpperCase() + key.slice(1).replaceAll("_", " ");
const closed = (name: string, values: readonly string[]) => (): string => `a filter on ${name} takes one of ${values.join(", ")}`;
const inSpan = (day: string, s: Span): boolean => (s.from === null || day >= s.from) && day <= s.to;
/** The instants a span reaches in a statement: from its first day's start, up to its last day's end or the cutoff. */
const bounds = (c: Ctx, s: Span): [string | null, string] =>
  [s.from === null ? null : new Date(midnight(s.from)).toISOString(), new Date(Math.min(midnight(addDays(s.to, 1)), c.asOfMs)).toISOString()];
const newest = (a: { ms: number; id: string }, b: { ms: number; id: string }): number => b.ms - a.ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const TOOL: Dim = {
  has: async (c, v) => (await registeredTools(c.db)).has(v), refuse: () => "tool must be a tool a door registers, as door:name",
  none: UNREGISTERED,
};
const TEAM: Dim = {
  superadmin: true, has: async (c, v) => (await readSlugs(c.db)).includes(v), refuse: () => "team must be a team's slug", none: "No team",
};
const PLUGIN: Dim = { has: async (_c, v) => (await pluginNames()).has(v), refuse: () => "plugin must be a plugin's name", none: "No plugin" };
/** A closed vocabulary, every value of it answered unless `fixed` is false. */
const vocabularyOf = (name: string, values: readonly string[], fixed = true): Dim => ({
  has: (_c, v) => values.includes(v), ...(fixed ? { fixed: () => values } : {}), refuse: closed(name, values), none: "None", label: words,
});

/** Calls of one kind as facts along the dimensions named. */
async function callFacts(c: Ctx, s: Span, keep: (d: CallDay) => boolean, keys: (d: CallDay) => Keys): Promise<Fact[]> {
  const [from, to] = bounds(c, s);
  return (await callDays(c.db, to, from)).filter(keep).map((d) => ({ day: d.day, keys: keys(d), n: d.calls, lastMs: d.last_ms }));
}

/** A member's shelves are their own, the shared one, and the rest unnamed; the superadmin's are every team's slug. */
function shelfOf(slug: string, who: Who): string | null {
  if (who.superadmin) return slug;
  if (slug === PLATFORM_TEAM) return "shared";
  return who.activeTeam !== null && who.activeTeam !== PLATFORM_TEAM && slug === who.activeTeam ? "own" : null;
}

/** Reports as facts, each one counted on the local day it was filed. */
async function reportFacts(c: Ctx, s: Span, keep: (r: RealReport) => boolean, keys: (r: RealReport) => Keys): Promise<Fact[]> {
  return (await realReports(c.asOf)).filter(keep).map((r) => ({ day: localDay(r.reportedMs), keys: keys(r), n: 1, lastMs: r.reportedMs, ref: r }))
    .filter((f) => inSpan(f.day, s));
}

/** The queue's rows of the reports kept, newest first as the queue orders them: the superadmin's carry the internal
 *  title and the team. */
async function reportRows(c: Ctx, kept: Fact[], want: number): Promise<Drilled> {
  const reports = kept.map((f) => f.ref as RealReport).sort((a, b) => newest({ ms: a.reportedMs, id: a.id }, { ms: b.reportedMs, id: b.id }));
  const page = reports.slice(0, want);
  const rows = c.who.superadmin ? await adminRows(page) : page.map(publicRow);
  return { rows: rows.map((r) => ({ ...r, at: r.filedAt, address: "/platform/bugs" })), total: reports.length };
}

/** The questions the kept searches that found nothing asked, over each run of the kept days, merged by question and
 *  team, newest asked first. Every search a fact of one day kept is kept: so where the kept searches that found
 *  nothing were widened one way alone, the questions are narrowed to it, and otherwise they are not narrowed. */
async function questionRows(c: Ctx, kept: Fact[]): Promise<Drilled> {
  const nothing = kept.filter((f) => f.keys.found === "nothing");
  const widened = [...new Set(nothing.map((f) => f.keys.widened ?? ""))];
  const merged = new Map<string, Question>();
  for (const [first, last] of runsOf(nothing.map((f) => f.day))) {
    const toMs = Math.min(midnight(addDays(last, 1)), c.asOfMs);
    for (const q of (await readQuestions(c.db, midnight(first), toMs, null, widened.length === 1 ? widened[0] : null)).rows) {
      const at = `${q.shelf}\0${q.question}`;
      const was = merged.get(at);
      merged.set(at, was ? { ...q, asked: was.asked + q.asked, lastAskedAt: was.lastAskedAt > q.lastAskedAt ? was.lastAskedAt : q.lastAskedAt } : q);
    }
  }
  const rows = [...merged.values()].sort((a, b) => newest({ ms: Date.parse(a.lastAskedAt), id: `${a.question}\0${a.shelf}` },
    { ms: Date.parse(b.lastAskedAt), id: `${b.question}\0${b.shelf}` }));
  return { rows: rows.map((q) => ({ ...q, at: q.lastAskedAt, address: "/platform/knowledge" })), total: rows.length };
}

/** Audit's rows of the kept events, over each run of the kept days, the latest run first, narrowed by kind and team
 *  where the kept facts name one alone and then to the kept days, kinds and teams exactly; each run reaches Audit's
 *  latest 500, as the page does, and keeps Audit's order. */
async function auditRows(c: Ctx, kept: Fact[]): Promise<Drilled> {
  const one = (k: string): string | null => {
    const values = [...new Set(kept.map((f) => f.keys[k]))];
    return values.length === 1 ? values[0] : null;
  };
  const combos = new Set(kept.map((f) => `${f.day}\0${f.keys.kind}\0${f.keys.team ?? ""}`));
  const rows: Row[] = [];
  for (const [first, last] of runsOf(kept.map((f) => f.day)).reverse()) {
    const found = await auditEvents(c.db, c.asOf, {
      filter: "all", kind: one("kind"), team: one("team"), limit: 500,
      after: new Date(midnight(first)).toISOString(), before: new Date(midnight(addDays(last, 1))).toISOString(),
    });
    for (const r of found) if (combos.has(`${localDay(Date.parse(r.at))}\0${r.kind}\0${r.team ?? ""}`)) rows.push({ ...r, address: "/platform/audit" });
  }
  return { rows, total: kept.reduce((n, f) => n + f.n, 0) };
}

/** Sorted dates as runs of consecutive days, each the first and the last of it. */
function runsOf(dates: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const d of [...new Set(dates)].sort()) {
    const last = out.at(-1);
    if (last && addDays(last[1], 1) === d) last[1] = d;
    else out.push([d, d]);
  }
  return out;
}

export const MEASURES: Record<string, Measure> = {
  calls: {
    dims: { tool: TOOL, refused: vocabularyOf("refused", ["refused", "answered"]), team: TEAM },
    buckets: true, population: "real-work tool calls",
    facts: (c, s) => callFacts(c, s, () => true, (d) => ({ tool: d.tool, refused: d.owner === null ? "answered" : "refused", team: d.slug })),
    // Usage's tools called most: each registered tool, every other counted as one, by its calls in the kept facts.
    async rows(_c, kept) {
      const by = new Map<string | null, { calls: number; ms: number }>();
      for (const f of kept) {
        const was = by.get(f.keys.tool) ?? { calls: 0, ms: 0 };
        by.set(f.keys.tool, { calls: was.calls + f.n, ms: Math.max(was.ms, f.lastMs) });
      }
      const rows = [...by].map(([tool, t]) => ({ tool: tool ?? TOOL.none, calls: t.calls, ms: t.ms }))
        .sort((a, b) => newest({ ms: a.ms, id: a.tool }, { ms: b.ms, id: b.tool }));
      return { rows: rows.map((t) => ({ tool: t.tool, calls: t.calls, at: iso(t.ms), address: "/platform/usage" })), total: rows.length };
    },
  },
  refusals: {
    dims: { owner: vocabularyOf("owner", REFUSAL_OWNERS), tool: TOOL, team: TEAM },
    buckets: true, population: "real-work tool calls refused, under the four owners",
    notDrilled: "refusals are not drilled: Usage and Status count them and list none",
    facts: (c, s) => callFacts(c, s, (d) => d.owner !== null, (d) => ({ owner: d.owner, tool: d.tool, team: d.slug })),
  },
  malformed: {
    dims: { tool: TOOL },
    buckets: true, population: "real-work tool calls refused for their shape",
    notDrilled: "malformed calls are not drilled: Status and Releases count them and list none",
    facts: (c, s) => callFacts(c, s, (d) => d.owner === "ours", (d) => ({ tool: d.tool })),
  },
  releases: {
    dims: {}, buckets: true, population: "recorded releases",
    async facts(c, s) {
      // Every release recorded, as Releases counts them: the record is written once a tag exists, never ahead of it.
      return (await releaseTimes(c.db))
        .map((r) => ({ day: localDay(r.ms), keys: {}, n: 1, lastMs: r.ms, ref: r.version })).filter((f) => inSpan(f.day, s));
    },
    async rows(c, kept, want) {
      const versions = kept.sort((a, b) => newest({ ms: a.lastMs, id: String(a.ref) }, { ms: b.lastMs, id: String(b.ref) })).map((f) => String(f.ref));
      const rows = await releaseRows(c.db, versions.slice(0, want), c.asOfMs);
      return { rows: rows.map((r) => ({ ...r, at: r.releasedAt, address: "/platform/releases" })), total: versions.length };
    },
  },
  migrations: {
    dims: {}, buckets: true, population: "migrations applied",
    notDrilled: "migrations are not drilled: Releases counts them and lists none",
    async facts(c, s) {
      // Every migration applied, as Releases counts them: the database's clock stamps them, not the read's cutoff.
      return (await migrationTimes(c.db))
        .map((ms) => ({ day: localDay(ms), keys: {}, n: 1, lastMs: ms })).filter((f) => inSpan(f.day, s));
    },
  },
  bugs_filed: {
    dims: {
      impact: vocabularyOf("impact", IMPACTS), state: vocabularyOf("state", STATES),
      surface: { has: async (_c, v) => (await vocabulary()).has(v), refuse: () => "surface must be a tool, a door or console", none: "No surface named" },
    },
    buckets: true, population: "real bug reports, by the day each was filed",
    facts: (c, s) => reportFacts(c, s, () => true, (r) => ({ impact: r.impact, surface: r.surface, state: r.status === "open" ? "open" : "resolved" })),
    rows: reportRows,
  },
  bugs_resolved: {
    dims: { outcome: vocabularyOf("outcome", STATUSES.filter((x) => x !== "open")), impact: vocabularyOf("impact", IMPACTS) },
    buckets: true, population: "real bug reports resolved, by the day each was filed",
    facts: (c, s) => reportFacts(c, s, (r) => r.status !== "open", (r) => ({ outcome: r.status, impact: r.impact })),
    rows: reportRows,
  },
  findings: {
    dims: {
      decision: vocabularyOf("decision", ["applied", "rejected", "deferred"]),
      owner: vocabularyOf("owner", ["plugin", "dependency", "platform", "environment", "user_input", "unknown"], false),
      plugin: PLUGIN,
    },
    buckets: true, population: "evaluation findings, each counted once, strengths left out",
    async facts(c, s) {
      return (await countedFindings(c.asOf)).filter((f) => inSpan(f.day, s))
        .map((f) => ({ day: f.day, keys: { decision: f.decision, owner: f.owner, plugin: f.plugin }, n: 1, lastMs: f.createdMs, ref: f.id }));
    },
    // Evaluation's waiting summaries: of the findings kept, those waiting for a decision.
    async rows(c, kept) {
      const ids = new Set(kept.map((f) => String(f.ref)));
      const rows = (await waitingFindings(c.asOf, c.who.superadmin)).filter((f) => ids.has(f.id))
        .sort((a, b) => newest({ ms: Date.parse(a.waitingSince), id: a.id }, { ms: Date.parse(b.waitingSince), id: b.id }));
      return { rows: rows.map((f) => ({ ...f, at: f.waitingSince, address: "/platform/evaluation" })), total: rows.length };
    },
  },
  scores: {
    dims: { plugin: PLUGIN },
    buckets: true, population: "plugins whose latest scoring by the window's end is established and inside it",
    async facts(c, s) {
      const endMs = Math.min(midnight(addDays(s.to, 1)) - 1, c.asOfMs);
      return (await latestScores(new Date(endMs).toISOString(), c.who.superadmin)).filter((p) => p.standing === "established")
        .map((p) => ({ day: localDay(Date.parse(p.scoredAt)), keys: { plugin: p.plugin }, n: 1, lastMs: Date.parse(p.scoredAt), ref: p }))
        .filter((f) => inSpan(f.day, s));
    },
    async rows(_c, kept) {
      const rows = kept.map((f) => f.ref as PluginRow).sort((a, b) => newest({ ms: Date.parse(a.scoredAt), id: a.plugin }, { ms: Date.parse(b.scoredAt), id: b.plugin }));
      return { rows: rows.map((p) => ({ ...p, at: p.scoredAt, address: "/platform/evaluation" })), total: rows.length };
    },
  },
  lessons: {
    dims: {
      shelf: {
        has: async (c, v) => (c.who.superadmin ? (await readSlugs(c.db)).includes(v) : v === "own" || v === "shared"),
        fixed: (who) => (who.superadmin ? [] : who.activeTeam !== null && who.activeTeam !== PLATFORM_TEAM ? ["own", "shared"] : ["shared"]),
        refuse: (who) => (who.superadmin ? "shelf must be a team's slug" : "a filter on shelf takes one of own, shared"),
        none: "Other teams' shelves",
        label: (key, who) => (who.superadmin ? key : key === "own" ? "Your team's shelf" : "The shared shelf"),
      },
      kind: vocabularyOf("kind", KINDS),
      imported: vocabularyOf("imported", ["imported", "not_imported"]),
    },
    buckets: true, population: "lessons made on every shelf, imports told apart",
    notDrilled: "lessons are not drilled: Knowledge health counts them and lists none",
    async facts(c, s) {
      const [{ lessons }, imports] = await Promise.all([readLessons(c.db, c.asOf), lessonImports(c.asOf)]);
      const imported = new Set(imports.lessons.map((l) => l.id));
      return lessons.filter((l) => inSpan(l.day, s)).map((l) => ({
        day: l.day, n: 1, lastMs: l.createdMs,
        keys: { shelf: shelfOf(l.shelf, c.who), kind: l.kind, imported: imported.has(l.id) ? "imported" : "not_imported" },
      }));
    },
  },
  searches: {
    dims: { found: vocabularyOf("found", ["found", "nothing"]), widened: { ...vocabularyOf("widened", ["widened", "not_widened"]), none: "Widening not recorded" } },
    buckets: true, population: "real-work searches that recorded their results", drillSuperadmin: true,
    async facts(c, s) {
      const [from, to] = bounds(c, s);
      return (await searchDays(c.db, to, from)).map((d) => ({
        day: d.day, n: d.searches, lastMs: d.last_ms,
        keys: { found: d.found ? "found" : "nothing", widened: d.widened === null ? null : d.widened ? "widened" : "not_widened" },
      }));
    },
    rows: (c, kept) => questionRows(c, kept),
  },
  model_calls: {
    dims: { model: { has: async (c, v) => (await modelsCalled(c.db)).has(v), refuse: () => "model must be a model the platform has called", none: "No model" } },
    buckets: true, population: "the platform's own model calls",
    notDrilled: "model calls are not drilled: Usage counts them and lists none",
    async facts(c, s) {
      const [from, to] = bounds(c, s);
      return (await modelDays(c.db, to, from)).map((d) => ({ day: d.day, keys: { model: d.model }, n: d.calls, lastMs: d.last_ms }));
    },
  },
  teams: {
    dims: { status: vocabularyOf("status", TEAM_STATUSES) },
    superadmin: true, stock: true, buckets: false, population: "every team made by the window's end",
    async facts(c, s) {
      return (await readBases(c.db, c.asOf)).filter((b) => b.created <= s.to)
        .map((b) => ({ day: b.created, keys: { status: b.status }, n: 1, lastMs: midnight(b.created), ref: b }));
    },
    async rows(c, kept) {
      const f = await readFigures(c.db, c.asOfMs);
      const bases = kept.map((k) => k.ref as Base).sort((a, b) => newest({ ms: midnight(a.created), id: a.slug }, { ms: midnight(b.created), id: b.slug }));
      return { rows: bases.map((b) => ({ ...rowOf(b, f), at: iso(midnight(b.created)), address: `/platform/teams/${b.slug}` })), total: bases.length };
    },
  },
  people: {
    dims: { role: vocabularyOf("role", ["superadmin", "member"]), state: vocabularyOf("state", PERSON_STATES) },
    superadmin: true, stock: true, buckets: false, population: "every person added by the window's end",
    async facts(c, s) {
      return (await peopleRows(c.db, c.asOf, null, null, null, 0)).filter((p) => p.created <= s.to)
        .map((p) => ({ day: p.created, keys: { role: p.role, state: p.state }, n: 1, lastMs: midnight(p.created), ref: p }));
    },
    async rows(_c, kept) {
      const people = kept.map((k) => k.ref as PersonRow).sort((a, b) => newest({ ms: midnight(a.created), id: a.email }, { ms: midnight(b.created), id: b.email }));
      return { rows: people.map((p) => ({ ...p, at: iso(midnight(p.created)), address: "/platform/people" })), total: people.length };
    },
  },
  sign_ins: {
    dims: { role: vocabularyOf("role", ["superadmin", "member"]) },
    superadmin: true, buckets: true, population: "recorded console sign-ins",
    async facts(c, s) {
      return (await signInDays(c.db, c.asOf)).filter((d) => inSpan(d.day, s))
        .map((d) => ({ day: d.day, keys: { role: d.role }, n: d.n, lastMs: d.last_ms, ref: d.email }));
    },
    // People's rows of the people who signed in, the latest kept sign-in first.
    async rows(c, kept) {
      const latest = new Map<string, number>();
      for (const f of kept) latest.set(String(f.ref), Math.max(latest.get(String(f.ref)) ?? 0, f.lastMs));
      const people = (await peopleRows(c.db, c.asOf, null, null, null, 0)).filter((p) => latest.has(p.email))
        .sort((a, b) => newest({ ms: latest.get(a.email)!, id: a.email }, { ms: latest.get(b.email)!, id: b.email }));
      return { rows: people.map((p) => ({ ...p, at: iso(latest.get(p.email)!), address: "/platform/people" })), total: people.length };
    },
  },
  audit: {
    dims: {
      kind: { has: (_c, v) => KIND.test(v), refuse: () => "kind must be an event kind", none: "No kind" },
      team: TEAM,
    },
    superadmin: true, buckets: true, population: "recorded events, page views left out",
    async facts(c, s) {
      return (await auditDays(c.db, c.asOf)).filter((d) => inSpan(d.day, s))
        .map((d) => ({ day: d.day, keys: { kind: d.kind, team: d.team }, n: d.n, lastMs: d.last_ms }));
    },
    rows: auditRows,
  },
};
