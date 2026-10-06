/**
 * The change service: what `document_edit` computes before anything is written. It reads the
 * document's state and then the document, computes the candidate — an edit batch, one section, the
 * whole body, the editable metadata, or the metadata alone — decides its causes and its public
 * version, and hands the tool a write for `saveDocument` and the receipt that write will answer
 * with. The tool runs the guards and the write; nothing here writes a row.
 *
 * DELIBERATE: computed outside the per-document lock, and committed only onto the state it was
 * computed from. `saveDocument` compares that state under the lock and sends a moved document back
 * (`{ retry }`), and the tool then computes again from the top — the compare-and-swap the spec
 * allows in place of holding the lock across the computation. The state is read BEFORE the
 * document, so a document read here can only be newer than the state it is compared as, never
 * older: a newer one fails the compare and is computed again, and an older one would have
 * written a stale candidate over a change it never saw.
 *
 * The precedence a call is answered in — the first that applies answers — is numbered at each
 * step below as the plan numbers it, (0) and (3) to (10); (1), (2) and (11) — the path, the field
 * and tag rules every write applies, and the guards — are the tool's own.
 *
 * `document_write`'s create is computed here too (`planCreate`), on the same precedence: a request
 * key first, then the target, which for a create must be absent. Its v1 records its causes as an
 * edit's new version does — named, captured and owed by the one definition below.
 */
import { createHash, randomUUID } from "node:crypto";

import { documentBody, parseCaller, parseEnvelope } from "@zz/contracts";
import { requestHeaders } from "@zz/mcp-http";
import type pg from "pg";

import { chainFor } from "./chain.js";
import { applyEdits, type Edit, type EditRefusal, MAX_EDITS } from "./document-edits.js";
import { changedSections, locateSection, replaceSection } from "./document-parts.js";
import { frontmatterRefusal, oneLine, renderEnvelope } from "./document-rules.js";
import { contentIdentity, documentState, type saveDocument, targetExists } from "./document-save.js";
import { sourceDocument } from "./indexing.js";
import { DOC_REF, titleSlug } from "./paths.js";
import { assessAcceptance, verifyingDoc } from "./review-acceptance.js";
import { contentRevision, documentAt, loadDocument, principalId } from "./versions.js";
import { type Chain, envelopeFor, isoToday, normalizeSections } from "./write-guards.js";

/** A person the platform cannot place in a team has no store to act on. */
export const NO_TEAM = "ERROR: you are not in a team — a team's documents live in the database under " +
  "its own membership, and nothing resolves you to one.";

/** After a verifying document is written or changed: ask `evidence_relation` of the acceptance
 *  rows nobody asked about yet, so approval reads a cache instead of waiting on the service. */
export async function acceptanceLine(p: pg.Pool, team: string, chain: Chain, path: string,
                                     content: string): Promise<string> {
  const doc = verifyingDoc(chain, path);
  if (!doc) return "";
  const said = await assessAcceptance(p, team, path.split("/")[0], doc, content,
                                      parseCaller(requestHeaders()).email);
  return said ? `\n${said}` : "";
}

const INITIATIVE = "2026-10-06-doc-write-and-update-paradigm";

/** How many times a change is computed against a document that keeps moving under it. */
export const MAX_ATTEMPTS = 3;

export const RETRYABLE_UNAVAILABLE =
  "ERROR: RETRYABLE_UNAVAILABLE — the document kept changing; read it again and resend";

/** The most entries one receipt list carries, and the longest one entry may be, so the whole
 *  text stays well under 16 KiB whatever a change touched. */
const LIST_CAP = 40;
const ENTRY_CAP = 120;

/** What `document_edit` is called with — spec v6's `DocumentEditArgs`. */
interface EditArgs {
  path: string;
  edits?: Edit[];
  section?: string; section_level?: number; section_occurrence?: number;
  content?: string;
  upload?: string; file?: Record<string, unknown>;
  sources?: string[]; source_content?: string; source_title?: string;
  note?: string;
  title?: string; tags?: string[]; stakeholder?: string; fields?: Record<string, string>;
  base?: string;
  request_id?: string;
}

type Write = Parameters<typeof saveDocument>[0];
type Cause = { path: string; revision: number; linked_by: "agent" | "platform" };

/** A change computed and ready to be guarded and written. */
interface Planned {
  chain: Chain;
  /** The candidate document, its sections normalised: what the guards judge and the write files. */
  text: string;
  renamed: string[];
  /** Body and editable metadata are what they were: nothing is written, nothing is consumed. */
  noChange: boolean;
  /** The receipt's lines, without the next move — that is computed after the commit. */
  receipt: string;
  causes: Cause[];
  /** The approved snapshot this write displaces, when the document was approved before it. */
  replaced: { version: number; revision: number } | null;
  write: Write;
}

/** The refusal the edit primitive gave, in the platform's `ERROR: <CODE> — <what to send>` form. */
function batchRefusal(path: string, r: EditRefusal): string {
  const at = r.edit_index === undefined ? "" : `edit ${r.edit_index} (0-based): `;
  switch (r.code) {
    case "EDIT_COUNT":
      return `ERROR: EDIT_COUNT — send between 1 and ${MAX_EDITS} edits in one call.`;
    case "INVALID_EDIT":
      return `ERROR: INVALID_EDIT — ${at}\`find\` must be a non-empty string and \`replace\` a string ` +
        "(an empty `replace` deletes).";
    case "NO_MATCH":
      return `ERROR: NO_MATCH — ${at}\`find\` does not occur in ${path}. Matching is exact, with no ` +
        "whitespace folding: read the document and copy the text as it is.";
    case "MULTIPLE_MATCHES":
      return `ERROR: MULTIPLE_MATCHES — ${at}\`find\` occurs ${r.match_count} times, on lines ` +
        `${(r.lines ?? []).join(", ")} of the body. Send a longer \`find\` that includes enough ` +
        "surrounding text to occur exactly once.";
    case "OVERLAPPING_EDITS":
      return `ERROR: OVERLAPPING_EDITS — ${at}this edit covers text another edit in the batch also ` +
        "covers (identical edits included). Merge them into one edit, or make their `find` text disjoint.";
  }
}

/** A list for one receipt line: at most LIST_CAP entries, then how many more there are. */
function capped(items: string[]): string {
  if (!items.length) return "none";
  const shown = items.slice(0, LIST_CAP).map((x) => oneLine(x, ENTRY_CAP));
  return shown.join(", ") + (items.length > LIST_CAP ? `, … and ${items.length - LIST_CAP} more` : "");
}

/** JSON with every object's keys sorted and absent values left out — the one spelling of a
 *  request, so the same request digests the same however its client ordered it. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The tools a request key is recorded for. A key is held per path, so the tool's name in the
 *  digest is what tells a create from a change sent under one key. */
type RequestTool = "document_edit" | "document_write";

/** What a request key is held to: the tool's name, a newline, and every argument but the key. */
function requestDigest(args: EditArgs, tool: RequestTool): string {
  const rest: Record<string, unknown> = { ...args };
  delete rest.request_id;
  return createHash("sha256").update(`${tool}\n${canonical(rest)}`, "utf8").digest("hex");
}

/** The receipt a committed request returns again, its first line marked as a replay. */
export function replayText(receipt: Record<string, unknown>): string {
  const lines = String(receipt.text ?? "").split("\n");
  lines[0] = `${lines[0]} (replayed)`;
  return lines.join("\n");
}

/** (0) A committed request under this key: its receipt again, or the conflict. Null when there is
 *  none — and when the caller has no request key, or is no principal a key could be held for.
 *  Asked once the caller's identity and team resolved, before anything about the document is: a
 *  replay answers what the first call did, whatever the document says now. `saveDocument` asks
 *  again under the lock, which is what makes two identical requests commit once. */
export async function replayFor(
  p: Pick<pg.Pool, "query">, team: string, who: string, path: string, args: EditArgs,
  tool: RequestTool = "document_edit",
): Promise<string | null> {
  if (args.request_id === undefined) return null;
  const principal = await principalId(p, who);
  if (!principal) return null;
  const { rows } = await p.query<{ request_digest: string; receipt: Record<string, unknown> }>(
    `select q.request_digest, q.receipt from zz.doc_request q join zz.team t on t.id = q.team_id
      where t.slug = $1 and q.principal_id = $2::uuid and q.canonical_path = $3 and q.request_id = $4`,
    [team, principal, path, args.request_id]);
  if (!rows[0]) return null;
  return rows[0].request_digest === requestDigest(args, tool)
    ? replayText(rows[0].receipt)
    : "ERROR: REQUEST_ID_CONFLICT — this request_id was used for a different request";
}

/** The receipt a stored request replays — the text, and the facts it states. */
function receiptOf(lines: string[], facts: Record<string, unknown>): Record<string, unknown> {
  return { text: lines.join("\n"), ...facts };
}

/** The sources a change to a document owes: sources in its initiative that declare they support
 *  it — a `supports` link to it, or a `supports` declaration on their current revision naming it —
 *  that no revision of any version of it cites yet, and whose current revision was filed at or
 *  after the cause-link epoch. "Filed" is that revision's `written_at`, compared inclusively; a null
 *  one is never owed, and a store with no epoch row has no lower bound. The one definition of an
 *  owed source, in ONE statement, however many sources the initiative holds.
 *
 *  The target is named by its path, and by its row when it has one: a create has none yet, so the
 *  link and citation arms find nothing and a source filed before the target existed is owed by its
 *  declaration alone — which is how v1 links it. */
async function owedSources(
  p: Pick<pg.Pool, "query">, team: string, initiative: string, name: string, docId: string | null,
): Promise<Cause[]> {
  const { rows } = await p.query<{ path: string; revision: number }>(
    `with t as (select i.id as initiative_id, i.slug, $3::text as path, $4::uuid as id
                  from zz.initiative i join zz.team tm on tm.id = i.team_id
                 where tm.slug = $1 and i.slug = $2)
     select t.slug || '/' || s.path as path, s.current_revision as revision
       from t
       join zz.doc s on s.initiative_id = t.initiative_id and s.id is distinct from t.id
                    and s.path like 'sources/%'
       join zz.doc_revision r on r.doc_id = s.id and r.revision = s.current_revision
      where r.written_at is not null
        and ((select e.epoch from zz.cause_link_epoch e limit 1) is null
             or r.written_at >= (select e.epoch from zz.cause_link_epoch e limit 1))
        and (exists (select 1 from zz.doc_link l
                      where l.from_doc_id = s.id and l.to_doc_id = t.id and l.kind = 'supports')
             or t.path = any(string_to_array(replace(coalesce(r.fields->>'supports', ''), ' ', ''), ',')))
        and not exists (select 1 from zz.doc_link c
                         where c.from_doc_id = t.id and c.to_doc_id = s.id and c.kind = 'cites')
      order by s.path`, [team, initiative, name, docId]);
  return rows.map((r) => ({ path: r.path, revision: r.revision, linked_by: "platform" as const }));
}

/** The documents the current public version already cites, from any of its snapshots: a cause
 *  named again is not new to the version, and does not move it. */
async function citedByVersion(p: Pick<pg.Pool, "query">, docId: string, version: number): Promise<Set<string>> {
  const { rows } = await p.query<{ path: string }>(
    `select distinct i.slug || '/' || t.path as path
       from zz.doc_link l
       join zz.doc_revision r on r.doc_id = l.from_doc_id and r.revision = l.from_revision
       join zz.doc t on t.id = l.to_doc_id
       join zz.initiative i on i.id = t.initiative_id
      where l.from_doc_id = $1::uuid and l.kind = 'cites' and r.version = $2`, [docId, version]);
  return new Set(rows.map((r) => r.path));
}

/** A `sources` entry that is no path inside the initiative: INVALID_MODE, on a create as on a
 *  change. Asked before any entry is looked up, so a malformed one is never reported as missing. */
function malformedSource(sources: string[] | undefined): string | null {
  const bad = (sources ?? []).find((src) => !DOC_REF.test(src.trim()));
  return bad === undefined ? null
    : `ERROR: INVALID_MODE — source "${bad}" must be a path inside the initiative, ` +
      "e.g. `sources/2026-10-06-call-notes.md` — letters, digits, dot, dash, underscore and / only.";
}

/** The caller's causes, the one definition a create and a change share: the sources it names and
 *  the words it passes as `source_content`, filed as a new source — both the agent's. `already` is
 *  what the target's current version cites: named again, it is no new cause. `label` titles a
 *  captured source the caller gave no title. The platform's causes — owed sources — are added by
 *  each caller after these, so a named one wins. */
async function namedCauses(
  p: pg.Pool, team: string, who: string, path: string,
  a: { sources?: string[]; source_content?: string; source_title?: string },
  o: { already: Set<string>; label: string },
): Promise<{ reply: string } | { causes: Cause[]; captured?: { relPath: string; text: string } }> {
  const [initiative, name] = [path.split("/")[0], path.split("/").slice(1).join("/")];
  const causes: Cause[] = [];
  for (const src of [...new Set((a.sources ?? []).map((s) => s.trim()))]) {
    const rel = `${initiative}/${src}`;
    const at = await documentAt(p, team, rel);
    if (!at || at.current_revision === null) {
      return { reply: `ERROR: ${rel} is not a document in this team's store, so it cannot be named as ` +
        `a cause of ${path}. source_add files new material, or pass the words themselves as ` +
        "`source_content`." };
    }
    if (!o.already.has(rel)) causes.push({ path: rel, revision: at.current_revision, linked_by: "agent" });
  }
  let captured: { relPath: string; text: string } | undefined;
  if (a.source_content?.trim()) {
    const title = (a.source_title || o.label).trim();
    const day = isoToday();
    // Named exactly as source_add names one, and suffixed rather than refused when the name is
    // taken: the change it explains must not fail over its label.
    const stem = `${initiative}/sources/${day}-${titleSlug(title, "source")}`;
    let rel = `${stem}.md`;
    for (let n = 2; await documentAt(p, team, rel); n++) rel = `${stem}-${n}.md`;
    captured = { relPath: rel, text: sourceDocument({ title, by: who, day, content: a.source_content.trim(),
                                                      supports: [name] }) };
    causes.push({ path: rel, revision: 1, linked_by: "agent" });
  }
  return { causes, captured };
}

/** Which body mode a call sends, or the INVALID_MODE that says why it sends none or two. */
function modeOf(a: EditArgs): "edits" | "section" | "content" | "metadata" | { refusal: string } {
  const invalid = (why: string) => ({ refusal: `ERROR: INVALID_MODE — ${why}` });
  if (a.section === undefined && (a.section_level !== undefined || a.section_occurrence !== undefined)) {
    return invalid("`section_level` and `section_occurrence` choose among headings `section` names; send `section` with them.");
  }
  if (a.section !== undefined && a.content === undefined) {
    return invalid("`section` names the part `content` replaces; send the section's new text, heading line first, as `content`.");
  }
  if (a.edits !== undefined && a.content !== undefined) {
    return invalid("send ONE body change: `edits`, or `section` with `content`, or the whole body as `content` — not two.");
  }
  if (a.section_level !== undefined && (a.section_level < 1 || a.section_level > 4)) {
    return invalid("`section_level` is a heading level from 1 to 4.");
  }
  if (a.section_occurrence !== undefined && a.section_occurrence < 1) {
    return invalid("`section_occurrence` counts from 1.");
  }
  if (a.edits !== undefined) return "edits";
  if (a.section !== undefined) return "section";
  if (a.content !== undefined) return "content";
  if (a.title !== undefined || a.tags !== undefined || a.stakeholder !== undefined || a.fields !== undefined) {
    return "metadata";
  }
  return invalid("send a body change — `edits`, `section` with `content`, or the whole body as " +
    "`content` — or metadata — `title`, `tags`, `stakeholder`, `fields`. A note or a cause alone " +
    "changes nothing; new material on its own is source_add's.");
}

/** (8) The body `section` with `content` makes, or SECTION_MISSING / SECTION_AMBIGUOUS. The edit
 *  path's own refusals: a writer picks a heading by its selectors, never by a character offset. */
function sectionBody(path: string, body: string, a: EditArgs): { body: string } | { refusal: string } {
  const section = a.section ?? "";
  const pick = { level: a.section_level, occurrence: a.section_occurrence };
  const found = locateSection(body, section, pick);
  const selectors = [a.section_level !== undefined ? ` at level ${a.section_level}` : "",
                     a.section_occurrence !== undefined ? ` (occurrence ${a.section_occurrence})` : ""].join("");
  if ("missing" in found) {
    const all = found.all.map((h) => `${"#".repeat(h.level)} ${h.title}`);
    return { refusal: `ERROR: SECTION_MISSING — no heading "${section}"${selectors} in ${path}. Its ` +
      `headings: ${capped(all)}.` };
  }
  if ("ambiguous" in found) {
    const listed = found.ambiguous.map((c) =>
      `"${"#".repeat(c.level)} ${c.title}" on line ${c.line}: section_level ${c.level}, section_occurrence ${c.occurrence}`);
    return { refusal: `ERROR: SECTION_AMBIGUOUS — ${found.ambiguous.length} headings read "${section}"` +
      `${selectors}: ${capped(listed)}. Send the \`section_level\` and \`section_occurrence\` listed ` +
      "beside the one you mean." };
  }
  // Located, so the one refusal left is a replacement that does not open with its heading line.
  const spliced = replaceSection(body, section, a.content ?? "", pick);
  return "refusal" in spliced
    ? { refusal: spliced.refusal.replace(/^ERROR: /, "ERROR: INVALID_EDIT — ") }
    : spliced;
}

/** The candidate's envelope: the document's own, with the metadata the call names, and — where the
 *  document was approved — the approval taken off, because a change is a draft until a person
 *  approves it again. `outcome` and `closed_by` stay as they are: a correction of a closed record
 *  carries what the close recorded. */
function envelopeOf(current: string, a: EditArgs, approved: boolean, gated: boolean): Record<string, string> {
  const env: Record<string, string> = { ...parseEnvelope(current) };
  const put = (k: string, v: string | undefined) => {
    if (v === undefined) return;
    if (v.trim()) env[k] = oneLine(v);
    else delete env[k];
  };
  put("title", a.title);
  put("stakeholder", a.stakeholder);
  if (a.tags !== undefined) put("tags", a.tags.map((t) => t.trim()).filter(Boolean).join(", "));
  for (const [k, v] of Object.entries(a.fields ?? {})) put(k.trim(), String(v));
  if (approved) {
    delete env.approved_by;
    delete env.approved_at;
    // COUPLED: a status exists only where the flow gates the document — stampEnvelope writes one
    // only there — so an ungated approved document returns to having none, the freeform draft.
    if (gated) env.status = "draft";
    else delete env.status;
  }
  return env;
}

/** (3)–(10): the change a call asks for, or the answer that stops it. `path` is canonical. */
export async function planEdit(
  p: pg.Pool, team: string, who: string, path: string, a: EditArgs,
): Promise<{ reply: string } | Planned> {
  const [initiative, name] = [path.split("/")[0], path.split("/").slice(1).join("/")];
  // The state first, then the document — see the module header.
  const state = await documentState(p, team, path);
  const loaded = await loadDocument(team, path);
  // (3)
  if (!loaded.ok || !state) {
    return { reply: loaded.ok || loaded.why === "missing"
      ? `ERROR: TARGET_MISSING — ${path} does not exist. document_write creates a document; ` +
        "document_list shows the paths there are."
      : loaded.refusal };
  }
  // (4)
  for (const n of ["upload", "file"] as const) {
    if (a[n] !== undefined) {
      return { reply: `ERROR: NOT_YET — \`${n}\` arrives in Phase 4 of ${INITIATIVE}; send the text as \`content\` until then` };
    }
  }
  // (5)
  const mode = modeOf(a);
  if (typeof mode !== "string") return { reply: mode.refusal };
  const fm = mode === "content" ? frontmatterRefusal(a.content ?? "", "document_edit") : null;
  if (fm) return { reply: fm };
  const malformed = malformedSource(a.sources);
  if (malformed) return { reply: malformed };
  // (6)
  if (mode === "edits" && (!Array.isArray(a.edits) || a.edits.length < 1 || a.edits.length > MAX_EDITS)) {
    return { reply: batchRefusal(path, { code: "EDIT_COUNT" }) };
  }
  // (7)
  const token = contentRevision(loaded.doc.id, Number(loaded.doc.content_generation));
  if (a.base !== undefined && a.base !== token) {
    return { reply: `ERROR: BASE_CONFLICT — ${path} is at content revision ${token} now, not the one ` +
      "`base` names; read it again and apply the change to what it says now." };
  }
  // (8)
  const body = documentBody(loaded.text);
  let next = body;
  if (mode === "edits") {
    const applied = applyEdits(body, a.edits ?? []);
    if ("code" in applied) return { reply: batchRefusal(path, applied) };
    next = applied.body;
  } else if (mode === "section") {
    const spliced = sectionBody(path, body, a);
    if ("refusal" in spliced) return { reply: spliced.refusal };
    next = spliced.body;
  } else if (mode === "content") {
    next = a.content ?? "";
  }
  const governing = await chainFor(p, team, path, loaded.text);
  const gated = governing.documents.some((d) => d.name === name && d.gate);
  const approved = loaded.doc.status === "approved";
  const env = envelopeOf(loaded.text, a, approved, gated);
  const candidate = `${renderEnvelope(env, ["flow", "type", "title", "stakeholder", "tags", "version",
                                            "status", "approved_by", "approved_at"])}\n${next}`;
  const chain = await chainFor(p, team, path, candidate);
  const fixed = normalizeSections(chain, path, candidate);
  const after = documentBody(fixed.content);
  const bodyChanged = after !== body;
  const version = loaded.rev.version;
  const status = (t: string) => parseEnvelope(t).status || (gated ? "draft" : "none");
  // (9) Body and editable metadata as they were: nothing is written and no cause is consumed. A
  // keyed one still goes to the write, which records the request and nothing else.
  if (contentIdentity(fixed.content, path) === contentIdentity(loaded.text, path)) {
    const lines = [`edited: ${path} — v${version} (no change)`, `content revision: ${token}`,
                   `status: ${status(loaded.text)}`, "changed sections: none", "causes: none"];
    return { chain, text: fixed.content, renamed: [], noChange: true, receipt: lines.join("\n"),
             causes: [], replaced: null,
             write: { team, relPath: path, initiative, text: fixed.content, by: who, mode: "rewrite",
                      flow: chain.name ?? undefined, type: chain.roles[name], act: "edit",
                      change: { nextVersion: false, expect: state,
                                request: requestOf(a, who, path, lines, { result: "no_change", version }) } } };
  }
  // The causes. Named sources and words captured as a new source are the caller's; owed sources
  // are the platform's, and a change that leaves the body alone owes none.
  const named = await namedCauses(p, team, who, path, a, {
    already: await citedByVersion(p, loaded.doc.id, version),
    label: `Input behind v${bodyChanged ? version + 1 : version}`,
  });
  if ("reply" in named) return named;
  const { causes, captured } = named;
  if (bodyChanged) {
    for (const owed of await owedSources(p, team, initiative, name, loaded.doc.id)) {
      if (!causes.some((c) => c.path === owed.path)) causes.push(owed);
    }
  }
  // (10) An approved body changes only with a cause new to its version, which opens the next one.
  if (bodyChanged && approved && !causes.length) {
    return { reply: `ERROR: CAUSE_REQUIRED — ${path} is approved, so a change to its body opens a new ` +
      "version and needs its cause: name an existing source in `sources` or pass the words as " +
      "`source_content`" };
  }
  const nextVersion = bodyChanged && causes.length > 0;
  const newVersion = nextVersion ? version + 1 : version;
  const lines = [
    `edited: ${path} — v${newVersion}${nextVersion ? " (new version)" : ""}`,
    `content revision: ${contentRevision(loaded.doc.id, state.generation + 1)}`,
    `status: ${status(fixed.content)}`,
    `changed sections: ${capped(changedSections(body, after))}`,
    `causes: ${capped(causes.map((c) => `${c.path} (${c.linked_by})`))}`,
  ];
  // DELIBERATE: a change in the same version keeps the version's note when it sends none — the
  // note says what the version is, and a typo fix does not unsay it.
  const note = a.note !== undefined ? oneLine(a.note, 200) : nextVersion ? null : loaded.rev.revision_note;
  const replaced = loaded.doc.approved_revision !== null && loaded.doc.approved_revision === loaded.doc.current_revision
    ? { version, revision: loaded.rev.revision } : null;
  return {
    chain, text: fixed.content, renamed: fixed.renamed, noChange: false, receipt: lines.join("\n"),
    causes, replaced,
    write: {
      team, relPath: path, initiative, text: fixed.content, by: who, mode: "rewrite", note,
      flow: chain.name ?? undefined, type: chain.roles[name], act: "edit",
      change: {
        nextVersion, expect: state, captured, causes,
        // The generation the caller's token named — the document's as read, which (7) found it to
        // be. Should the state compare then find the document moved, that is the generation it
        // asks about: still current means a retry, gone means BASE_CONFLICT.
        ...(a.base !== undefined ? { base: Number(loaded.doc.content_generation) } : {}),
        request: requestOf(a, who, path, lines, { result: "applied", version: newVersion, new_version: nextVersion }),
      },
    },
  };
}

/** The request record a keyed change commits with: the key, what it digests to, and its receipt. */
function requestOf(a: EditArgs, who: string, path: string, lines: string[], facts: Record<string, unknown>,
                   tool: RequestTool = "document_edit") {
  return a.request_id === undefined ? undefined : {
    principalEmail: who, canonicalPath: path, requestId: a.request_id, digest: requestDigest(a, tool),
    receipt: receiptOf(lines, { path, ...facts }),
  };
}


/** What `document_write` is called with. */
interface CreateArgs {
  path: string;
  content: string;
  title?: string; tags?: string[]; stakeholder?: string; fields?: Record<string, string>;
  sources?: string[]; source_content?: string; source_title?: string;
  request_id?: string;
}

/** (3) onwards for a create: the absent target, its envelope and sections, its causes and its
 *  receipt — or the answer that stops it. `path` is canonical. The document's id is chosen here, so
 *  the receipt a keyed create records names the content revision it will have. */
export async function planCreate(
  p: pg.Pool, team: string, who: string, path: string, a: CreateArgs,
): Promise<{ reply: string } | Omit<Planned, "noChange" | "replaced">> {
  const [initiative, name] = [path.split("/")[0], path.split("/").slice(1).join("/")];
  if (await documentAt(p, team, path)) return { reply: targetExists(path) };
  const malformed = malformedSource(a.sources);
  if (malformed) return { reply: malformed };
  // The chain from the caller's bytes and, failing that, the initiative's row — a first document
  // is written before any other carries a `flow:`.
  const chain = await chainFor(p, team, path, a.content);
  const { stakeholder, tags, title, fields } = a;
  const fixed = normalizeSections(chain, path, envelopeFor(chain, path, a.content, { stakeholder, tags, title, fields }));
  const named = await namedCauses(p, team, who, path, a, { already: new Set(), label: "Input behind v1" });
  if ("reply" in named) return named;
  const { causes, captured } = named;
  for (const owed of await owedSources(p, team, initiative, name, null)) {
    if (!causes.some((c) => c.path === owed.path)) causes.push(owed);
  }
  const id = randomUUID();
  const lines = [
    `written: ${path} (${fixed.content.length} chars)`,
    // A new document's content generation is 0 until its first change.
    `content revision: ${contentRevision(id, 0)}`,
    `causes: ${capped(causes.map((c) => `${c.path} (${c.linked_by})`))}`,
  ];
  return {
    chain, text: fixed.content, renamed: fixed.renamed, receipt: lines.join("\n"), causes,
    write: {
      team, relPath: path, initiative, text: fixed.content, by: who, id, mode: "create", act: "write",
      flow: chain.name ?? undefined, type: chain.roles[name],
      change: { nextVersion: false, captured, causes,
                request: requestOf(a, who, path, lines, { result: "created", version: 1 }, "document_write") },
    },
  };
}
