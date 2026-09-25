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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { documentBody } from "@zz/contracts";
import { decisionRows } from "@zz/indexing";

import { names, reviewMove, stakeholderSources, unbackloggedFindings } from "./review-rounds.js";
import { assessFamily, type Assessment } from "./semantic.js";
import type { Chain } from "./write-guards.js";

const AC_STATUSES = ["established", "not_established", "blocked", "deferred"] as const;
const EVIDENCE_KIND = /^(check|run|probe|test):\S+/;
const QUOTED = /`[^`]+`|"[^"]+"|“[^”]+”/;

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

/** Every criterion the verified documents declare, in their order, first declaration winning. */
export function declaredCriteria(dir: string, verifies: string[]): Criterion[] {
  const out = new Map<string, Criterion>();
  for (const doc of verifies) {
    if (!existsSync(join(dir, doc))) continue;
    const body = documentBody(readFileSync(join(dir, doc), "utf8"));
    for (const row of decisionRows(body)) {
      if (out.has(row.key) || !/^(AC-\d|I-\d+$)/.test(row.key)) continue;
      const text = row.key.startsWith("I-") ? (taskCriterion(body, row.key) ?? row.detail) : row.detail;
      out.set(row.key, { id: row.key, text, from: doc });
    }
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
const cacheFile = (root: string, initiative: string, doc: string) =>
  join(root, initiative, "_assessments", doc.replace(/\.md$/, ".acceptance.json"));

export function readAcceptanceCache(root: string, initiative: string, doc: string): Cache {
  const f = cacheFile(root, initiative, doc);
  if (!existsSync(f)) return {};
  try { return (JSON.parse(readFileSync(f, "utf8")) as { rows?: Cache }).rows ?? {}; } catch { return {}; }
}
export function writeAcceptanceCache(root: string, initiative: string, doc: string, rows: Cache): void {
  mkdirSync(join(root, initiative, "_assessments"), { recursive: true });
  writeFileSync(cacheFile(root, initiative, doc), JSON.stringify({ document: doc, rows }, null, 2) + "\n");
}

/** Ask `evidence_relation` of every established row whose current evidence nobody asked about
 *  yet, a few at a time, and cache the answers. Returns one line for the caller, or "". */
export async function assessAcceptance(root: string, initiative: string, doc: { name: string; verifies: string[] },
                                       body: string, by: string): Promise<string> {
  const table = acceptanceTable(body);
  if (!table) return "";
  const criteria = new Map(declaredCriteria(join(root, initiative), doc.verifies).map((c) => [c.id, c]));
  const cache = readAcceptanceCache(root, initiative, doc.name);
  const due = table.filter((r) => r.status === "established" && criteria.has(r.id) && QUOTED.test(r.evidence))
    .map((r) => ({ row: r, text: criteria.get(r.id)?.text ?? "", digest: rowDigest(criteria.get(r.id)?.text ?? "", r.evidence) }))
    // An `unavailable` answer is asked again: it says the service was down, not what it thinks.
    .filter((x) => !(cache[x.row.id] ?? []).some((c) => c.digest === x.digest && c.reading !== "unavailable"));
  if (!due.length) return "";
  const answers: Assessment[] = [];
  for (let i = 0; i < due.length; i += 8) {
    answers.push(...await Promise.all(due.slice(i, i + 8).map((x) => assessFamily({
      family: "evidence_relation", subject: `${x.row.id}: ${x.text}`, context: x.row.evidence,
      initiative, about: `${doc.name}#${x.row.id}`, askedBy: by }))));
  }
  due.forEach((x, i) => {
    const a = answers[i];
    cache[x.row.id] = (cache[x.row.id] ?? []).filter((c) => c.digest !== x.digest);
    cache[x.row.id].push({ digest: x.digest, reading: a.reading, probability: a.probability,
                                     reason: a.reason, asked_at: a.asked_at });
  });
  writeAcceptanceCache(root, initiative, doc.name, cache);
  const count = (r: string) => answers.filter((a) => a.reading === r).length;
  return `evidence_relation asked of ${due.length} row(s): ${count("yes")} yes, ${count("no")} no, ` +
         `${count("unclear")} unclear, ${count("unavailable")} unavailable.`;
}

/**
 * Why approving this verifying document is refused, or null, with a note for the approval's
 * answer either way. Deterministic rules first; the semantic reading only of rows that pass them.
 */
export async function acceptanceApprovalRefusal(root: string, chain: Chain, relPath: string, content: string,
                                                by: string): Promise<{ refusal: string | null; note: string }> {
  const doc = verifyingDoc(chain, relPath);
  if (!doc) return { refusal: null, note: "" };
  const initiative = relPath.replace(/^\/+/, "").split("/")[0];
  const dir = join(root, initiative);
  const body = documentBody(content);
  const lead = `ERROR: ${relPath} is not approved — `;
  const backlog = unbackloggedFindings(root, initiative, doc.stage, doc.name, body);
  const criteria = declaredCriteria(dir, doc.verifies);
  const bad: string[] = [];
  // The sweep has to be settled. Zero rounds still approves (the move is round 1 owed), which the
  // seeds rely on; any round recorded holds the approval until nothing blocks.
  const sweep = reviewMove(root, initiative, doc.stage, doc.name);
  if (sweep && ["fix", "run_experiment", "decide"].includes(sweep.action)) {
    bad.push(`the review sweep still has an open blocking finding — next move ${sweep.action}: ${sweep.why}`);
  }
  if (backlog.length) {
    bad.push(`review findings outside their round's scope are still open and \`## Backlog\` does not name ` +
             `them: ${backlog.join(", ")}`);
  }
  const table = acceptanceTable(body);
  if (!criteria.length) {
    return { refusal: bad.length ? lead + bad.join("; ") : null,
             note: `${doc.verifies.join(" and ")} declare no acceptance criterion, so no acceptance evidence is owed.` };
  }
  if (!table) {
    return { refusal: lead + [...bad, `it has no \`## Acceptance evidence\` section, and ${doc.verifies.join(" and ")} ` +
             `declare ${criteria.length} criteria (${criteria.map((c) => c.id).join(", ")}) — one row each: ` +
             "| AC | Status | Evidence | Note |"].join("; "), note: "" };
  }
  const byId = new Map(table.map((r) => [r.id, r]));
  const declared = new Set(criteria.map((c) => c.id));
  const decisions = stakeholderSources(dir, doc.name);
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
  await assessAcceptance(root, initiative, doc, body, by);
  const cache = readAcceptanceCache(root, initiative, doc.name);
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
           note: `Acceptance evidence: ${table.length} row(s) against ${criteria.length} declared criteria` +
                 (unavailable.length
                   ? `; evidence_relation unavailable for ${unavailable.join(", ")}, so those rows rest on the deterministic rules alone.`
                   : ".") };
}
