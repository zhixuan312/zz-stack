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
 * the evidence (the passage that should support it) — the family's own instruction. Asked when
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
import { assessFamily, type Assessment } from "./semantic.js";
import type { Chain } from "./write-guards.js";

const AC_STATUSES = ["established", "not_established", "blocked", "deferred"] as const;
const EVIDENCE_KIND = /^(check|run|probe|test):\S+/;
const QUOTED = /`[^`]+`|"[^"]+"|“[^”]+”/;
/** A stakeholder's waiver of the sweep: a waive word and the sweep or review on one line. Bare
 *  "waive" is not enough — a source deferring a criterion may use the word about that. */
const WAIVER = /\bwaive[sd]?\b[^\n]*\b(?:sweep|review)\b|\b(?:sweep|review)\b[^\n]*\bwaive[sd]?\b/i;

export interface Criterion { id: string; text: string; from: string }
interface AcceptanceRow { id: string; status: string; evidence: string; note: string }

/** The verifying document this path is, with what it verifies, or null. */
export function verifyingDoc(chain: Chain, relPath: string): { name: string; stage: string; verifies: string[] } | null {
  const name = relPath.replace(/^\/+/, "").split("/")[1] ?? "";
  const d = chain.documents.find((x) => x.name === name && x.verifies?.length);
  return d ? { name: d.name, stage: d.stage ?? "", verifies: d.verifies ?? [] } : null;
}

/** A plan task's technical acceptance criterion, which its heading row only titles. */
function taskCriterion(body: string, id: string): string | null {
  const at = new RegExp(`^#{2,4}\\s*Task\\s+${id}\\s*[:—–-].*$`, "m").exec(body);
  if (!at) return null;
  const rest = body.slice(at.index + at[0].length);
  const section = rest.slice(0, rest.search(/^#{1,4}\s/m) === -1 ? undefined : rest.search(/^#{1,4}\s/m));
  return /\*\*Technical acceptance criteri(?:a|on)\*\*[^:]*:\s*(.*)/.exec(section)?.[1]?.trim() ?? null;
}

/** Every criterion one document's body declares, its order preserved, first declaration winning. */
function criteriaIn(doc: string, body: string, out: Map<string, Criterion>): void {
  for (const row of decisionRows(body)) {
    if (out.has(row.key) || !/^(AC-\d|I-\d+$)/.test(row.key)) continue;
    const text = row.key.startsWith("I-") ? (taskCriterion(body, row.key) ?? row.detail) : row.detail;
    out.set(row.key, { id: row.key, text, from: doc });
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
  for (const doc of verifies) {
    const loaded = await loadDocument(team, `${initiative}/${doc}`);
    if (!loaded.ok) continue;
    criteriaIn(doc, documentBody(loaded.text), out);
  }
  return [...out.values()];
}

/** Cells of one table line, splitting on unescaped pipes only. */
const cellsOf = (line: string) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());

/** The `## Acceptance evidence` table, or null when the section is absent. */
function acceptanceTable(body: string): AcceptanceRow[] | null {
  const m = /^##[ \t]+Acceptance evidence[ \t]*$([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/m.exec(body);
  if (!m) return null;
  const rows: AcceptanceRow[] = [];
  for (const line of m[1].split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const [id = "", status = "", evidence = "", note = ""] = cellsOf(line);
    const key = id.replace(/[*`]/g, "").trim();
    if (!/^[A-Z]{1,4}-\d+(?:\.\d+)*$/.test(key)) continue;       // the header and the rule line
    rows.push({ id: key, status: status.replace(/[*`]/g, "").trim().toLowerCase(), evidence, note });
  }
  return rows;
}

/** What `evidence_relation` is asked about one row, and the digest its answer is cached under. */
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
 *  stale reading is how an approval passes on evidence nobody checked. */
export async function readAcceptanceCache(
  p: pg.Pool, team: string, initiative: string, doc: string,
): Promise<Cache> {
  const { rows } = await p.query<{ about: string; reading: Assessment["reading"]; probability: string | null;
                                   reason: string | null; asked_at: string }>(
    `select a.about, a.reading, a.probability::text as probability, a.reason, a.asked_at::text as asked_at
       from zz.assessment a
       join zz.initiative i on i.id = a.initiative_id
       join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug = $2 and a.about like $3
      order by a.asked_at, a.id`, [team, initiative, `${doc}#%`]);
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
  const table = acceptanceTable(body);
  if (!table) return "";
  const criteria = new Map((await declaredCriteriaOf(team, initiative, doc.verifies))
    .map((c) => [c.id, c]));
  const cache = await readAcceptanceCache(p, team, initiative, doc.name);
  const due = table.filter((r) => r.status === "established" && criteria.has(r.id) && QUOTED.test(r.evidence))
    .map((r) => ({ row: r, text: criteria.get(r.id)?.text ?? "", digest: rowDigest(criteria.get(r.id)?.text ?? "", r.evidence) }))
    // An `unavailable` answer is asked again: it says the service was down, not what it thinks.
    .filter((x) => !(cache[x.row.id] ?? []).some((c) => c.digest === x.digest && c.reading !== "unavailable"));
  if (!due.length) return "";
  const answers: Assessment[] = [];
  for (let i = 0; i < due.length; i += 8) {
    answers.push(...await Promise.all(due.slice(i, i + 8).map((x) => assessFamily({
      family: "evidence_relation", subject: `${x.row.id}: ${x.text}`, context: x.row.evidence,
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
  const table = acceptanceTable(body);
  if (!criteria.length) {
    return { refusal: bad.length ? lead + bad.join("; ") : null,
             note: waived + `${doc.verifies.join(" and ")} declare no acceptance criterion, so no acceptance evidence is owed.` };
  }
  if (!table) {
    return { refusal: lead + [...bad, `it has no \`## Acceptance evidence\` section, and ${doc.verifies.join(" and ")} ` +
             `declare ${criteria.length} criteria (${criteria.map((c) => c.id).join(", ")}) — one row each: ` +
             "| AC | Status | Evidence | Note |"].join("; "), note: "" };
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
      bad.push(`${r.id} is ${r.status} and its evidence names no kind-prefixed locator (check:, run:, probe:, test:)`);
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
  const text = new Map(criteria.map((c) => [c.id, c.text]));
  const unavailable: string[] = [];
  for (const r of table.filter((x) => x.status === "established")) {
    const digest = rowDigest(text.get(r.id) ?? "", r.evidence);
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
                 (unavailable.length
                   ? `; evidence_relation unavailable for ${unavailable.join(", ")}, so those rows rest on the deterministic rules alone.`
                   : ".") };
}
