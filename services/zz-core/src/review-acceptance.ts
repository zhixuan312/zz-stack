/**
 * Acceptance evidence: the table a verifying document carries, one row per acceptance criterion
 * the documents it `verifies` declare, and the rules its approval is held to.
 *
 *   ## Acceptance evidence
 *   | AC | Status | Evidence | Note |
 *   |---|---|---|---|
 *   | AC-1.1 | established | check:initiative-open — `initiative-open: ok` | |
 *
 * Declared criteria are read with the indexer's own `decisionRows`, never a second grammar: a
 * spec's `**AC-N.N**` checklist items, and a plan's `### Task I-N` headings — each task carries
 * exactly one technical acceptance criterion and no other id.
 *
 * Deterministic, at `document_approve`, refused by name:
 *   - the review sweep recorded at least one round and nothing in it blocks — unless no round
 *     ran and a stakeholder source waives the sweep, which the approval's answer then says;
 *   - every declared criterion has a row, and no row names a criterion nobody declared;
 *   - a status is established, not_established, blocked or deferred;
 *   - an established or blocked row names its evidence by kind (`check:`, `run:`, `probe:`,
 *     `test:`), and an established one quotes the decisive output;
 *   - a deferred row is named by a stakeholder source — material supporting the document that no
 *     stage produced.
 *
 * Semantic, `evidence_relation` per established row: SUBJECT the criterion (the claim), CONTEXT
 * the evidence (the passage that should support it) — the family's own instruction. A row whose
 * evidence names a check the approved plan declares for that criterion is asked only whether the
 * check ran and passed (`questionOf`). Asked when
 * the document is written or patched and cached per row digest in `_assessments/`, so approval
 * asks only what nobody asked yet. `no` refuses. `unclear` refuses once, asking for sharper
 * evidence; `unclear` again on different evidence goes to the stakeholder, whose source naming
 * the row accepts it. `unavailable` blocks nothing and is said so.
 */
import { createHash } from "node:crypto";

import { documentBody } from "@zz/contracts";
import { decisionRows } from "@zz/indexing";
import type pg from "pg";

import type { DocRow } from "./indexing.js";

import { names, reviewMove, reviewRounds, stakeholderSources, unbackloggedFindings,
         type RoundAssessments } from "./review-rounds.js";
import { loadDocument } from "./versions.js";
import { assessFamily, questionDigest, type Assessment } from "./semantic.js";
import type { Chain } from "./write-guards.js";

const AC_STATUSES = ["established", "not_established", "blocked", "deferred"] as const;
const KINDS = ["check", "run", "probe", "test"] as const;
const EVIDENCE_KIND = /^(check|run|probe|test):\S+/;
const QUOTED = /`[^`]+`|"[^"]+"|“[^”]+”/;
const TABLE_HEADER = "| AC | Status | Evidence | Note |";

/** Why an evidence cell's locator is not one, said so the author can fix it in one pass. The
 *  near miss gets its own sentence: `run: \`cmd\`` reads as a locator to a person, and with the
 *  space the backticks quote the command, so the output the rule asks for is never found. Shared
 *  with spec-gate.ts, whose kinds are its own. */
export function locatorProblem(id: string, evidence: string, kinds: readonly string[]): string | null {
  const kind = new RegExp(`^(${kinds.join("|")}):\\S+`);
  if (kind.test(evidence)) return null;
  const example = "run:npm test — `12 passed, 0 failed`";
  if (new RegExp(`^(${kinds.join("|")}):\\s`).test(evidence)) {
    return `${id}'s locator has a space after the colon — write it with none, \`${evidence.split(":")[0]}:<what ran>\`, ` +
           `then the decisive output in backticks, e.g. ${example}`;
  }
  return `${id}'s evidence names no kind-prefixed locator — open the cell with ${kinds.map((k) => `${k}:`).join(", ")} ` +
         `and what ran, no space after the colon, then the decisive output in backticks, e.g. ${example}`;
}
/** A stakeholder's waiver of the sweep: a waive word and the sweep or review on one line. Bare
 *  "waive" is not enough — a source deferring a criterion may use the word about that. */
const WAIVER = /\bwaive[sd]?\b[^\n]*\b(?:sweep|review)\b|\b(?:sweep|review)\b[^\n]*\bwaive[sd]?\b/i;

/** A declared criterion, with the checks the approved plan declares as its executable form: a
 *  task's own `- Check:` paths, and for a spec criterion every check of the tasks whose heading
 *  cites it (`### Task I-3: … (← AC-1.2, AC-1.3)`). */
export interface Criterion { id: string; text: string; from: string; checks: string[] }
interface AcceptanceRow { id: string; status: string; evidence: string; note: string }

/** The verifying document this path is, with what it verifies, or null. */
export function verifyingDoc(chain: Chain, relPath: string): { name: string; stage: string; verifies: string[] } | null {
  const name = relPath.replace(/^\/+/, "").split("/")[1] ?? "";
  const d = chain.documents.find((x) => x.name === name && x.verifies?.length);
  return d ? { name: d.name, stage: d.stage ?? "", verifies: d.verifies ?? [] } : null;
}

const TASK_HEADING = /^#{2,4}\s*Task\s+(I-\d+)\s*[:—–-].*$/gm;

/** One plan task's section — its heading line and everything up to the next heading. */
function taskSection(body: string, id: string): { heading: string; section: string } | null {
  const at = new RegExp(`^#{2,4}\\s*Task\\s+${id}\\s*[:—–-].*$`, "m").exec(body);
  if (!at) return null;
  const rest = body.slice(at.index + at[0].length);
  const end = rest.search(/^#{1,4}\s/m);
  return { heading: at[0], section: end === -1 ? rest : rest.slice(0, end) };
}

/** A plan task's technical acceptance criterion, which its heading row only titles: the whole
 *  statement, up to the task's next bold label. Its first line alone is often "It proves:" or
 *  "The worker runs, in this order:", and a reader handed that judges a claim with no content. */
function taskCriterion(body: string, id: string): string | null {
  const section = taskSection(body, id)?.section;
  if (!section) return null;
  const m = /\*\*Technical acceptance criteri(?:a|on)\*\*[^:\n]*:[ \t]*/.exec(section);
  if (!m) return null;
  const rest = section.slice(m.index + m[0].length);
  const end = rest.search(/^\*\*[^*\n]+\*\*/m);
  return (end === -1 ? rest : rest.slice(0, end)).trim() || null;
}

/** The `- Check: \`path\`` lines of one task's section, in order. */
function taskChecks(section: string): string[] {
  return [...section.matchAll(/^\s*-\s*Check:\s*`([^`]+)`/gm)].map((m) => m[1].trim());
}

/** The AC ids a task heading cites — `(← AC-1.2, AC-1.3)`, a range `AC-4.1–AC-4.3` read whole. */
function headingTargets(heading: string): string[] {
  const cited = /\(←([^)]*)\)\s*$/.exec(heading)?.[1] ?? "";
  const out: string[] = [];
  for (const m of cited.matchAll(/AC-(\d+)\.(\d+)(?:\s*[–-]\s*AC-\1\.(\d+))?/g)) {
    const [from, to] = [Number(m[2]), Number(m[3] ?? m[2])];
    for (let n = from; n <= to; n++) out.push(`AC-${m[1]}.${n}`);
  }
  return out;
}

/** Every criterion one document's body declares, its order preserved, first declaration winning. */
function criteriaIn(doc: string, body: string, out: Map<string, Criterion>): void {
  for (const row of decisionRows(body)) {
    if (out.has(row.key) || !/^(AC-\d|I-\d+$)/.test(row.key)) continue;
    const text = row.key.startsWith("I-") ? (taskCriterion(body, row.key) ?? row.detail) : row.detail;
    out.set(row.key, { id: row.key, text, from: doc, checks: [] });
  }
}

/** Bind each criterion to the checks the plan declares for it, read from every task in `body`. */
function bindChecks(body: string, out: Map<string, Criterion>): void {
  for (const [, id] of body.matchAll(TASK_HEADING)) {
    const task = taskSection(body, id);
    if (!task) continue;
    const checks = taskChecks(task.section);
    if (!checks.length) continue;
    for (const target of [id, ...headingTargets(task.heading)]) {
      const c = out.get(target);
      if (c) c.checks = [...new Set([...c.checks, ...checks])];
    }
  }
}

/** The criteria a verifying document's targets declare, read from their own current revisions.
 *
 *  Exported because a check has to name the same criteria the reader computes — the memo key is a
 *  digest of the criterion's text, so a check that parsed the table itself would be keying a
 *  digest of something the reader never sees. */
export async function declaredCriteriaOf(
  team: string | null, initiative: string, verifies: string[],
): Promise<Criterion[]> {
  const out = new Map<string, Criterion>();
  if (!team) return [];
  const bodies: string[] = [];
  for (const doc of verifies) {
    const loaded = await loadDocument(team, `${initiative}/${doc}`);
    if (!loaded.ok) continue;
    const body = documentBody(loaded.text);
    bodies.push(body);
    criteriaIn(doc, body, out);
  }
  // After every document is read: a spec's criteria are bound by the plan's task headings.
  for (const body of bodies) bindChecks(body, out);
  return [...out.values()];
}

/** The declared checks one evidence cell names — by full path, or by file name as a whole token,
 *  since a review may run `checks/x.py` from a different directory than the plan wrote it from. */
function checksNamed(c: Criterion, evidence: string): string[] {
  return c.checks.filter((path) => {
    if (evidence.includes(path)) return true;
    const file = path.split("/").pop() ?? path;
    return new RegExp(`(^|[\\s/:\`])${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s\`;,])`).test(evidence);
  });
}

/**
 * What `evidence_relation` is asked about one row, and the digest its answer is cached under.
 *
 * DELIBERATE: a row whose evidence names a check the approved plan declares for this criterion is
 * asked only whether that check ran and passed. That the check verifies the criterion was settled
 * when the plan was approved — the plan's Checks are "the executable form of the technical AC" —
 * and asking it again, with a script name as the only context, read `check_i2_fixtures.py →
 * PASS` as not supporting the criterion it was written for (p=0.17, bug d5ab33bd). Asked the
 * narrow question, the same model read that row at 0.96 and a failing or skipped run at 0.12 and
 * 0.04: it judges a result well and a relevance it cannot see badly.
 *
 * Exported because a check has to key the memo exactly as the reader does.
 */
export function questionOf(c: Criterion, evidence: string): { subject: string; digest: string; bound: string[] } {
  // Every declared check, or the criterion itself: evidence quoting one of the three tasks that
  // deliver a criterion says nothing about the other two.
  const named = checksNamed(c, evidence);
  const bound = named.length && named.length === c.checks.length ? named : [];
  const subject = bound.length
    ? `${c.id} is verified by the ${bound.length > 1 ? "checks" : "check"} the approved plan declares for it, ` +
      `${bound.map((b) => `\`${b}\``).join(" and ")}: ${bound.length > 1 ? "those checks were" : "that check was"} run and passed.`
    : `${c.id}: ${c.text}`;
  return { subject, digest: rowDigest(subject, evidence), bound };
}

/** Cells of one table line, splitting on unescaped pipes only. */
const cellsOf = (line: string) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());

/** The `## Acceptance evidence` table's rows, or null when the section is absent. `header` is the
 *  section's first table line, kept so a table the gate cannot read is refused by what it says. */
function acceptanceTable(body: string): { rows: AcceptanceRow[]; header: string } | null {
  const m = /^##[ \t]+Acceptance evidence[ \t]*$([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/m.exec(body);
  if (!m) return null;
  const rows: AcceptanceRow[] = [];
  let header = "";
  for (const line of m[1].split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    header ||= line.trim();
    const [id = "", status = "", evidence = "", note = ""] = cellsOf(line);
    const key = id.replace(/[*`]/g, "").trim();
    if (!/^[A-Z]{1,4}-\d+(?:\.\d+)*$/.test(key)) continue;       // the header and the rule line
    rows.push({ id: key, status: status.replace(/[*`]/g, "").trim().toLowerCase(), evidence, note });
  }
  return { rows, header };
}

/** The digest an `evidence_relation` answer is cached under: the subject asked and the evidence. */
export function rowDigest(criterion: string, evidence: string): string {
  return createHash("sha256").update(`${criterion}\n${evidence}`).digest("hex").slice(0, 16);
}

interface CachedReading { digest: string; reading: Assessment["reading"]; probability: number | null;
                                 reason: string | null; asked_at: string }
type Cache = Record<string, CachedReading[]>;
/** The readings already taken, keyed by criterion id — the memo that keeps this from asking the
 *  same question of the same evidence on every write.
 *
 *  COUPLED: the memo is `zz.assessment`, and there is no second copy. `assessFamily` persists
 *  every answer as it takes it, so the row IS the record; `<initiative>/_assessments/` and the
 *  `.acceptance.json` files in it were that record written twice, and a second copy is what
 *  drifts. Nothing is written back here for the same reason.
 *
 *  DELIBERATE: the memo is keyed by the DIGEST of the criterion and the evidence, and `about`
 *  carries it — `<doc>#<row id>#<digest>`. `zz.assessment` has no column for the third and the
 *  other two are already in `about` for every other family, so the key is composed there rather
 *  than a column added for one family's benefit. Without it the memo cannot tell "already asked
 *  about these bytes" from "asked about the bytes this table carried before the revision", and a
 *  stale reading is how an approval passes on evidence nobody checked.
 *
 *  And only readings taken under the question asked NOW: `question_digest` pins the instruction's
 *  exact bytes. When the question changes, a reading of the same evidence under the old question
 *  is an answer to something nobody is asking any more, and reusing it kept a `no` that the
 *  corrected question exists to fix. */
export async function readAcceptanceCache(
  p: pg.Pool, team: string, initiative: string, doc: string,
): Promise<Cache> {
  const { rows } = await p.query<{ about: string; reading: Assessment["reading"]; probability: string | null;
                                   reason: string | null; asked_at: string }>(
    `select a.about, a.reading, a.probability::text as probability, a.reason, a.asked_at::text as asked_at
       from zz.assessment a
       join zz.initiative i on i.id = a.initiative_id
       join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug = $2 and a.about like $3 and a.question_digest = $4
      order by a.asked_at, a.id`, [team, initiative, `${doc}#%`, questionDigest("evidence_relation")]);
  const out: Cache = {};
  for (const r of rows) {
    const parts = r.about.split("#");
    const id = parts[1] ?? "";
    const digest = parts[2] ?? "";
    if (!id || !digest) continue;
    (out[id] ??= []).push({ digest, reading: r.reading,
                            probability: r.probability === null ? null : Number(r.probability),
                            reason: r.reason, asked_at: r.asked_at });
  }
  return out;
}

/** Ask `evidence_relation` of every established row whose current evidence nobody asked about
 *  yet, a few at a time, and cache the answers. Returns one line for the caller, or "". */
export async function assessAcceptance(p: pg.Pool, team: string, initiative: string,
                                       doc: { name: string; verifies: string[] },
                                       body: string, by: string): Promise<string> {
  const table = acceptanceTable(body)?.rows;
  if (!table) return "";
  const criteria = new Map((await declaredCriteriaOf(team, initiative, doc.verifies))
    .map((c) => [c.id, c]));
  const cache = await readAcceptanceCache(p, team, initiative, doc.name);
  const due = table.filter((r) => r.status === "established" && criteria.has(r.id) && QUOTED.test(r.evidence))
    .map((r) => ({ row: r, ...questionOf(criteria.get(r.id)!, r.evidence) }))
    // An `unavailable` answer is asked again: it says the service was down, not what it thinks.
    .filter((x) => !(cache[x.row.id] ?? []).some((c) => c.digest === x.digest && c.reading !== "unavailable"));
  if (!due.length) return "";
  const answers: Assessment[] = [];
  for (let i = 0; i < due.length; i += 8) {
    answers.push(...await Promise.all(due.slice(i, i + 8).map((x) => assessFamily({
      family: "evidence_relation", subject: x.subject, context: x.row.evidence,
      initiative, about: `${doc.name}#${x.row.id}#${x.digest}`, askedBy: by }))));
  }
  // No write back: every one of these answers is a `zz.assessment` row already, written by
  // `assessFamily` as it took it, and the memo above reads them from there next time.
  const count = (r: string) => answers.filter((a) => a.reading === r).length;
  return `evidence_relation asked of ${due.length} row(s): ${count("yes")} yes, ${count("no")} no, ` +
         `${count("unclear")} unclear, ${count("unavailable")} unavailable.`;
}

/**
 * Why approving this verifying document is refused, or null, with a note for the approval's
 * answer either way. Deterministic rules first; the semantic reading only of rows that pass them.
 */
export async function acceptanceApprovalRefusal(
  p: pg.Pool, team: string, chain: Chain, relPath: string, content: string, by: string,
  sources: readonly DocRow[], answers: RoundAssessments,
): Promise<{ refusal: string | null; note: string }> {
  const doc = verifyingDoc(chain, relPath);
  if (!doc) return { refusal: null, note: "" };
  const initiative = relPath.replace(/^\/+/, "").split("/")[0];
  const body = documentBody(content);
  const lead = `ERROR: ${relPath} is not approved — `;
  const backlog = unbackloggedFindings(doc.stage, doc.name, body, sources);
  const criteria = await declaredCriteriaOf(team, initiative, doc.verifies);
  const bad: string[] = [];
  // The sweep has to have run and be settled: round 1 at least, or a stakeholder's explicit
  // waiver, and then nothing blocking.
  const sweep = reviewMove(initiative, doc.stage, doc.name, sources, answers);
  let waived = "";
  if (!reviewRounds(sources, doc.stage, doc.name).length) {
    const waiver = stakeholderSources(sources, doc.name).find((s) => WAIVER.test(s.body));
    if (waiver) waived = `The review sweep ran no round: sources/${waiver.file} waives it. `;
    else {
      bad.push(`no round of ${doc.stage} is recorded — the sweep runs at least once: record round 1 with ` +
               `source_add(initiative: "${initiative}", title, content, supports: ["${doc.name}"], stage: "${doc.stage}"). ` +
               `Only the stakeholder can waive it, with source_add(supports: ["${doc.name}"]) whose content ` +
               "says so on one line, e.g. \"The review sweep is waived: <why>.\"");
    }
  } else if (sweep && ["fix", "run_experiment", "decide"].includes(sweep.action)) {
    bad.push(`the review sweep still has an open blocking finding — next move ${sweep.action}: ${sweep.why}`);
  }
  if (backlog.length) {
    bad.push(`review findings outside their round's scope are still open and \`## Backlog\` does not name ` +
             `them: ${backlog.join(", ")}`);
  }
  const parsed = acceptanceTable(body);
  const table = parsed?.rows;
  if (!criteria.length) {
    return { refusal: bad.length ? lead + bad.join("; ") : null,
             note: waived + `${doc.verifies.join(" and ")} declare no acceptance criterion, so no acceptance evidence is owed.` };
  }
  if (!table) {
    return { refusal: lead + [...bad, `it has no \`## Acceptance evidence\` section, and ${doc.verifies.join(" and ")} ` +
             `declare ${criteria.length} criteria (${criteria.map((c) => c.id).join(", ")}) — one row each: ` +
             TABLE_HEADER].join("; "), note: "" };
  }
  // A table none of whose rows the gate can read is one sentence, not "no row for" every
  // criterion: a review written as `| Item | Locator | Decisive line |` holds every row a person
  // would look for, and was refused 37 times over without being told why (bug a568b3d8).
  if (!table.length) {
    return { refusal: lead + [...bad, `its \`## Acceptance evidence\` table has no row the gate can read — it ` +
             `starts \`${parsed.header || "(no table)"}\`, and the gate reads \`${TABLE_HEADER}\`: the criterion's id ` +
             `alone in the first column, then one of ${AC_STATUSES.join(", ")}, then the evidence — one row each for ` +
             `${criteria.map((c) => c.id).join(", ")}`].join("; "), note: "" };
  }
  const byId = new Map(table.map((r) => [r.id, r]));
  const declared = new Set(criteria.map((c) => c.id));
  const decisions = stakeholderSources(sources, doc.name);
  const vouched = (id: string) => decisions.some((d) => names(d.body, id));
  const missing = criteria.filter((c) => !byId.has(c.id)).map((c) => c.id);
  if (missing.length) bad.push(`no row for ${missing.join(", ")}`);
  const stray = table.filter((r) => !declared.has(r.id)).map((r) => r.id);
  if (stray.length) bad.push(`rows for ${stray.join(", ")}, which neither ${doc.verifies.join(" nor ")} declares`);
  for (const r of table.filter((x) => declared.has(x.id))) {
    if (!AC_STATUSES.includes(r.status as never)) {
      bad.push(`${r.id}: status "${r.status}" is not one of ${AC_STATUSES.join(", ")}`);
    } else if ((r.status === "established" || r.status === "blocked") && !EVIDENCE_KIND.test(r.evidence)) {
      bad.push(locatorProblem(r.id, r.evidence, KINDS)!);
    } else if (r.status === "established" && !QUOTED.test(r.evidence)) {
      bad.push(`${r.id} is established and quotes no output — add the decisive line, in backticks`);
    } else if (r.status === "deferred" && !vouched(r.id)) {
      bad.push(`${r.id} is deferred and no stakeholder source names it — record their decision with ` +
               `source_add(supports: ["${doc.name}"]) naming ${r.id}`);
    }
  }
  if (bad.length) return { refusal: lead + bad.join("; "), note: "" };

  // Only rows that passed every deterministic rule are read; a row nobody asked about yet is asked now.
  await assessAcceptance(p, team, initiative, doc, body, by);
  const cache = await readAcceptanceCache(p, team, initiative, doc.name);
  const byCriterion = new Map(criteria.map((c) => [c.id, c]));
  const unavailable: string[] = [];
  const onPlan: string[] = [];
  for (const r of table.filter((x) => x.status === "established")) {
    const { digest, bound } = questionOf(byCriterion.get(r.id)!, r.evidence);
    if (bound.length) onPlan.push(r.id);
    const history = cache[r.id] ?? [];
    const now = history.find((c) => c.digest === digest);
    if (!now || now.reading === "unavailable") { unavailable.push(r.id); continue; }
    if (now.reading === "no") {
      bad.push(`${r.id}: evidence_relation reads its evidence as not supporting the criterion ` +
               `(p=${now.probability?.toFixed(2)}) — establish it by running, or mark it not_established`);
    } else if (now.reading === "unclear") {
      const earlierUnclear = history.some((c) => c.digest !== digest && c.reading === "unclear");
      if (!earlierUnclear) {
        bad.push(`${r.id}: evidence_relation is unclear (p=${now.probability?.toFixed(2)}) — sharpen the ` +
                 "evidence: quote the decisive output line, not a summary of it");
      } else if (!vouched(r.id)) {
        bad.push(`${r.id}: evidence_relation is unclear a second time, on different evidence — the ` +
                 `stakeholder decides; their source_add(supports: ["${doc.name}"]) naming ${r.id} accepts it`);
      }
    }
  }
  if (bad.length) return { refusal: lead + bad.join("; "), note: "" };
  return { refusal: null,
           note: waived + `Acceptance evidence: ${table.length} row(s) against ${criteria.length} declared criteria` +
                 (onPlan.length ? `; ${onPlan.length} rest on the check the approved plan declares for them, read only for whether it passed` : "") +
                 (unavailable.length
                   ? `; evidence_relation unavailable for ${unavailable.join(", ")}, so those rows rest on the deterministic rules alone.`
                   : ".") };
}
