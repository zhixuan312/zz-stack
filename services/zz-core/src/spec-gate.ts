/**
 * The two sections a spec's approval rests on, for a flow that declares them among the spec's
 * `sections`: the route to the final shape, and the assumptions that route was tested against.
 *
 *   ## Phase outline
 *   - **Phase 1 — Skeleton:** one request travels end to end. Covers AC-1.1, AC-2.1.
 *
 *   ## Core statements
 *   | ID | Statement | If false | Status | Evidence | Note |
 *   |---|---|---|---|---|---|
 *   | CS-1 | The image carries a repo checkout. | Candidates cannot be built in-process. | fails | run:docker-inspect — `absent: .git` | resolved-by-design-change: builds move to the host |
 *
 * The plan is not written up front: it grows one phase at a time, each built before the next is
 * planned. So the spec is where the destination is settled, and it has to name every phase that
 * reaches it and the statements that, if false, would change the design. A statement is held by
 * a spike actually run while the spec was written, not by how plausible it sounds.
 *
 * Deterministic, at `document_approve`, refused by name:
 *   - `## Phase outline` names at least one phase, every acceptance criterion the spec declares
 *     appears in it, and it names none the spec does not declare;
 *   - `## Core statements` has a row per statement, each with the statement, what breaks if it is
 *     false, a status of holds, fails or partial, and evidence naming its kind (`check:`, `run:`,
 *     `test:`) and quoting the decisive output;
 *   - a `fails` or `partial` row is marked `resolved-by-design-change` in its note, or a
 *     stakeholder source names it — a failed assumption changed the design or the stakeholder
 *     decided it, before anyone plans on it.
 *
 * Semantic, `evidence_relation` per `holds` row, read exactly as review-acceptance.ts reads an
 * established criterion: SUBJECT the statement, CONTEXT its evidence, cached per row digest.
 * `no` refuses; `unclear` asks once for sharper evidence, then goes to the stakeholder;
 * `unavailable` blocks nothing and is said so.
 */
import { join } from "node:path";

import { documentBody } from "@zz/contracts";
import { decisionRows } from "@zz/indexing";

import { readAcceptanceCache, rowDigest, writeAcceptanceCache } from "./review-acceptance.js";
import { names, stakeholderSources } from "./review-rounds.js";
import { assessFamily } from "./semantic.js";
import type { Chain } from "./write-guards.js";

const PHASE_OUTLINE = "Phase outline";
const CORE_STATEMENTS = "Core statements";
const STATUSES = ["holds", "fails", "partial"] as const;
const EVIDENCE_KIND = /^(check|run|test):\S+/;
const QUOTED = /`[^`]+`|"[^"]+"|“[^”]+”/;
const RESOLVED = /\bresolved-by-design-change\b/i;
const AC_ID = /\bAC-\d+(?:\.\d+)*\b/g;

interface Statement { id: string; statement: string; ifFalse: string; status: string; evidence: string; note: string }

/** The body under one `## ` heading, or null when the heading is absent. */
function sectionOf(body: string, heading: string): string | null {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^##[ \\t]+${esc}[ \\t]*$([\\s\\S]*?)(?=^##[ \\t]|(?![\\s\\S]))`, "m").exec(body)?.[1] ?? null;
}

const cellsOf = (line: string) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());

function statementRows(section: string): Statement[] {
  const rows: Statement[] = [];
  for (const line of section.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const [id = "", statement = "", ifFalse = "", status = "", evidence = "", note = ""] = cellsOf(line);
    const key = id.replace(/[*`]/g, "").trim();
    if (!/^CS-\d+$/.test(key)) continue;                           // the header and the rule line
    rows.push({ id: key, statement, ifFalse, status: status.replace(/[*`]/g, "").trim().toLowerCase(), evidence, note });
  }
  return rows;
}

/** What the phase outline gets wrong, one entry each. */
function outlineProblems(body: string, section: string | null): string[] {
  if (section === null) {
    return [`it has no \`## ${PHASE_OUTLINE}\` — name the phases to the final shape, each with the AC ids it covers`];
  }
  const bad: string[] = [];
  if (!/\bPhase\s+\d+/i.test(section)) bad.push(`\`## ${PHASE_OUTLINE}\` names no phase — write one line per "Phase N"`);
  const declared = decisionRows(body).map((r) => r.key).filter((k) => /^AC-\d/.test(k));
  const uncovered = declared.filter((id) => !names(section, id));
  if (uncovered.length) bad.push(`no phase covers ${uncovered.join(", ")} — name each AC id in the phase that delivers it`);
  const stray = [...new Set(section.match(AC_ID) ?? [])].filter((id) => !declared.includes(id));
  if (stray.length) bad.push(`the outline names ${stray.join(", ")}, which the spec does not declare`);
  return bad;
}

/** What the core statements get wrong deterministically, one entry each. */
function statementProblems(rows: Statement[] | null, vouched: (id: string) => boolean): string[] {
  if (rows === null) {
    return [`it has no \`## ${CORE_STATEMENTS}\` — the assumptions the design rests on, each with a spike's evidence: ` +
            "| ID | Statement | If false | Status | Evidence | Note |"];
  }
  if (!rows.length) return [`\`## ${CORE_STATEMENTS}\` has no \`CS-N\` row`];
  const bad: string[] = [];
  for (const r of rows) {
    if (!r.statement || !r.ifFalse) {
      bad.push(`${r.id} does not say ${r.statement ? "what breaks if it is false" : "what it states"}`);
    } else if (!STATUSES.includes(r.status as never)) {
      bad.push(`${r.id}: status "${r.status}" is not one of ${STATUSES.join(", ")}`);
    } else if (!EVIDENCE_KIND.test(r.evidence)) {
      bad.push(`${r.id}'s evidence names no kind-prefixed locator (check:, run:, test:) — run a spike and name it`);
    } else if (!QUOTED.test(r.evidence)) {
      bad.push(`${r.id} quotes no output — add the spike's decisive line, in backticks`);
    } else if (r.status !== "holds" && !RESOLVED.test(r.note) && !vouched(r.id)) {
      bad.push(`${r.id} ${r.status === "fails" ? "fails" : "holds only in part"} and nothing settles it — change the ` +
               "design and mark the note `resolved-by-design-change: <what changed>`, or record the stakeholder's " +
               `decision with source_add(supports: [...]) naming ${r.id}`);
    }
  }
  return bad;
}

/**
 * Why approving this spec is refused, or null, with a note for the approval's answer either way.
 * Stands aside for a document whose flow declares neither section.
 */
export async function specApprovalRefusal(root: string, chain: Chain, relPath: string, content: string,
                                          by: string): Promise<{ refusal: string | null; note: string }> {
  const [initiative = "", name = ""] = relPath.replace(/^\/+/, "").split("/");
  const sections = chain.documents.find((d) => d.name === name)?.sections ?? [];
  const wantsOutline = sections.includes(PHASE_OUTLINE);
  const wantsStatements = sections.includes(CORE_STATEMENTS);
  if (!wantsOutline && !wantsStatements) return { refusal: null, note: "" };
  const body = documentBody(content);
  const decisions = stakeholderSources(join(root, initiative), name);
  const vouched = (id: string) => decisions.some((d) => names(d.body, id));
  const statementsSection = sectionOf(body, CORE_STATEMENTS);
  const rows = statementsSection === null ? null : statementRows(statementsSection);
  const lead = `ERROR: ${relPath} is not approved — `;
  const bad = [
    ...(wantsOutline ? outlineProblems(body, sectionOf(body, PHASE_OUTLINE)) : []),
    ...(wantsStatements ? statementProblems(rows, vouched) : []),
  ];
  if (bad.length) return { refusal: lead + bad.join("; "), note: "" };
  if (!wantsStatements || !rows) return { refusal: null, note: "" };

  // Only rows that passed every deterministic rule are read, and a row nobody asked about yet is
  // asked now. Cached apart from any acceptance table the same document might carry.
  const cacheName = name.replace(/\.md$/, ".statements.md");
  const cache = readAcceptanceCache(root, initiative, cacheName);
  const holds = rows.filter((r) => r.status === "holds").map((r) => ({ r, digest: rowDigest(r.statement, r.evidence) }));
  const due = holds.filter((x) => !(cache[x.r.id] ?? []).some((c) => c.digest === x.digest && c.reading !== "unavailable"));
  const answers = await Promise.all(due.map((x) => assessFamily({
    family: "evidence_relation", subject: `${x.r.id}: ${x.r.statement}`, context: x.r.evidence,
    initiative, about: `${name}#${x.r.id}`, askedBy: by })));
  due.forEach((x, i) => {
    const a = answers[i];
    cache[x.r.id] = [...(cache[x.r.id] ?? []).filter((c) => c.digest !== x.digest),
      { digest: x.digest, reading: a.reading, probability: a.probability, reason: a.reason, asked_at: a.asked_at }];
  });
  if (due.length) writeAcceptanceCache(root, initiative, cacheName, cache);

  const unavailable: string[] = [];
  for (const { r, digest } of holds) {
    const history = cache[r.id] ?? [];
    const now = history.find((c) => c.digest === digest);
    if (!now || now.reading === "unavailable") { unavailable.push(r.id); continue; }
    if (now.reading === "no") {
      bad.push(`${r.id}: evidence_relation reads its evidence as not supporting the statement ` +
               `(p=${now.probability?.toFixed(2)}) — run a spike that tests it, or mark it fails or partial`);
    } else if (now.reading === "unclear") {
      const earlierUnclear = history.some((c) => c.digest !== digest && c.reading === "unclear");
      if (!earlierUnclear) {
        bad.push(`${r.id}: evidence_relation is unclear (p=${now.probability?.toFixed(2)}) — sharpen the ` +
                 "evidence: quote the spike's decisive output line, not a summary of it");
      } else if (!vouched(r.id)) {
        bad.push(`${r.id}: evidence_relation is unclear a second time, on different evidence — the ` +
                 `stakeholder decides; their source_add(supports: ["${name}"]) naming ${r.id} accepts it`);
      }
    }
  }
  if (bad.length) return { refusal: lead + bad.join("; "), note: "" };
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return { refusal: null,
           note: `Core statements: ${count("holds")} hold, ${count("fails")} fail, ${count("partial")} partial` +
                 (unavailable.length
                   ? `; evidence_relation unavailable for ${unavailable.join(", ")}, so those rows rest on the deterministic rules alone.`
                   : ".") };
}
