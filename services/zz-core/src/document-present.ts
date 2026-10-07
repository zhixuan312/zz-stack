/**
 * Showing a document to a person, and the record that it was shown.
 *
 * `document_present` is what `document_approve` leans on: an approval rests on a presentation of
 * exactly the snapshot it signs, and this module is what presents one. Every present that is not a
 * `version` or `section` read is a presentation IN A REVIEW CONTEXT (review-context.ts): the first
 * one in a context shows the current snapshot in full, and a later one shows only what changed since
 * the snapshot the context last covered — the change set `deltaOf` computes, its records and then
 * every added or edited section in full — unless `full` is asked or the change set would be no
 * shorter than the document. The reply names the context to pass back.
 *
 * A reader is shown PUBLIC versions: `version` is the one a change's cause opened, and several
 * stored snapshots can share it. `version: N` reads the version's last snapshot, as `loadDocument`
 * reads it, and the history lists each version once.
 *
 * DELIBERATE: an unasked present is ONE part when the text is longer than a client can carry — the
 * body of a full presentation, the change set of a delta. The old store version returned the whole
 * body unasked, which a client then truncated, silently, with the reader never learning there was
 * more. `present` decides that here rather than at the tool, so a second caller cannot forget.
 *
 * Wherever the body is shown whole or in parts — a full presentation, a `version` or `section` read
 * — every reply also names the snapshot's review metadata, which its content identity and so an
 * approval cover beside the body; a delta names a change to it as a record of its own.
 *
 * DELIBERATE: a `version` or `section` present is a read beside the review, not a step in one. It
 * covers nothing towards approval; when it shows the current snapshot it is recorded, so the bytes
 * it showed are pinned, and when it shows history it records nothing at all — a superseded snapshot
 * is already immutable, and a row for it would pin the CURRENT row, which nobody was shown.
 */
import { contentRevision, parseEnvelope } from "@zz/contracts";
import type pg from "pg";

import { deltaOf } from "./document-delta.js";
import { type PanelDocument, panelDocument } from "./document-panel.js";
import { PART_LIMIT, asksPart, partHeader, slicePart } from "./document-parts.js";
import { commitPresentation, presentedBody, type PresentAsk, resolvePresentation, snapshotRevision,
         type Viewer } from "./review-context.js";
import { changeSnapshot } from "./stale-base.js";
import { dayOf, loadDocument, loadSnapshot, publicVersions, supersededApproval } from "./versions.js";

type Loaded = Extract<Awaited<ReturnType<typeof loadDocument>>, { ok: true }>;
type Shown = { text: string; panel: PanelDocument | null };

/** Show a document to a person — in a review context, or as a `version`/`section` read — and record
 *  what they were shown. `draw` is false when the call is the model reading a part, which draws no
 *  panel. Returns the refusal when the document or the version named is not there. */
export async function present(
  p: pg.Pool, who: Viewer, rel: string, ask: PresentAsk = {}, draw = true,
): Promise<Shown> {
  if (ask.version !== undefined || ask.section !== undefined) return presentRead(p, who, rel, ask, draw);
  const loaded = await loadDocument(who.team, rel);
  if (!loaded.ok) return { text: loaded.refusal, panel: null };
  const current = snapshotRevision(loaded)!;
  const plan = await resolvePresentation(p, who, rel, current, ask);
  const target = plan.target === current ? loaded : await loadSnapshot(who.team, rel, plan.target);
  if (!target.ok) return { text: target.refusal, panel: null };
  const base = plan.baseline && plan.baseline !== plan.target ? await loadSnapshot(who.team, rel, plan.baseline) : null;
  const delta = base?.ok ? deltaOf(changeSnapshot(base.text), changeSnapshot(target.text)) : null;
  const unchanged = plan.baseline === plan.target;
  let kind = plan.kind;
  let why = "";
  if (kind === "delta" && !unchanged && delta?.kind !== "delta") {
    if (plan.continuing) {
      return { text: `ERROR: ${plan.context}'s presentation of ${rel} cannot be continued: its baseline ` +
                     `${plan.baseline} is not retained. Present it again without \`offset\`.`, panel: null };
    }
    kind = "full";
    why = delta ? ` (the changes since ${plan.baseline} are as long as the document)` : ` (${plan.baseline} is not retained)`;
  }
  const text = kind === "full" ? presentedBody(target.text) : unchanged ? "" : delta?.kind === "delta" ? delta.text : "";
  const paged = asksPart(ask) || text.length > PART_LIMIT;
  const part = paged ? slicePart(text, { offset: ask.offset, limit: ask.limit }) : { text, start: 0, end: text.length, total: text.length };
  if (typeof part === "string") return { text: part, panel: null };
  // The panel draws the whole current snapshot, marked against the context's baseline.
  const previous = !plan.baseline ? null
    : unchanged ? { version: target.rev.version, content_revision: plan.baseline, changes: [] }
    : base?.ok ? { version: base.rev.version, content_revision: plan.baseline, changes: delta?.kind === "delta" ? delta.records : null }
    : null;
  const panel = draw && !plan.continuing ? await panelDocument(p, who, rel, target, plan.context, previous) : null;
  const ctx = plan.context;
  const isCurrent = plan.target === current;
  const said = await commitPresentation(p, who, rel, {
    context: ctx, target: plan.target, baseline: plan.baseline, kind, start: part.start, end: part.end, total: part.total,
    version: target.rev.version, revision: target.rev.revision,
    current: isCurrent ? { revision: loaded.rev.revision, generation: Number(loaded.rev.content_generation ?? loaded.doc.content_generation) } : null,
    meta_bytes: panel ? Buffer.byteLength(JSON.stringify(panel)) : 0,
  }, (covered) => {
    const lines = [factsOf(rel, target)];
    if (kind === "full") lines.push(metadataLine(target.text));
    if (plan.note) lines.push(`${plan.note}.`);
    if (!isCurrent) {
      lines.push(`This continues ${ctx}'s presentation of ${plan.target}, which is no longer the current snapshot — ` +
                 `${rel} is at ${current} now. Present it again without \`offset\` to see what changed since.`);
    }
    if (kind === "delta" && unchanged) {
      lines.push(`Review context: ${ctx} — no change since ${plan.baseline} — covered.`);
      return `${lines.join("\n")}\n`;
    }
    const n = delta?.kind === "delta" ? delta.records.length : 0;
    lines.push(`Review context: ${ctx} — ${kind}${kind === "delta" ? ` (${n} record${n === 1 ? "" : "s"})` : why}, ` +
               `target ${plan.target}, baseline ${plan.baseline ?? "none"}, ${covered ? "covered" : "not yet covered"}.`);
    lines.push(covered
      ? `Every character of ${kind === "delta" ? "what changed" : "it"} has now been presented: ${plan.target} counts ` +
        `as presented. Pass review_context "${ctx}" to the next document_present of ${rel} to be shown only what ` +
        "changed since; `full: true` shows it whole."
      : `Presented in part. It does NOT yet count as presented: present the rest with \`offset\` and ` +
        `review_context "${ctx}". A client that shows the document panel puts all of it in front of the person ` +
        "and records that itself — if the person can see the panel, leave the rest to it.");
    if (paged) {
      const of = kind === "delta" ? `the changes from ${plan.baseline} to ${plan.target}` : "the body, frontmatter excluded";
      lines.push(partHeader(rel, part, of, text)
        .replace(/^Next: offset (\d+)\./m, (_m, at: string) => `Next: offset ${at}, with review_context "${ctx}".`));
    } else if (kind === "full") lines.push(versionsLine(target));
    return `${lines.join("\n")}\n\n${part.text}\n`;
  });
  return { text: said, panel: /^ERROR/.test(said) ? null : panel };
}

/** A `version` or `section` read: the snapshot, whole or in part, outside any review context. */
async function presentRead(p: pg.Pool, who: Viewer, rel: string, ask: PresentAsk, draw: boolean): Promise<Shown> {
  const loaded = await loadDocument(who.team, rel, ask.version);
  if (!loaded.ok) return { text: loaded.refusal, panel: null };
  const body = presentedBody(loaded.text);
  const paged = asksPart(ask) || body.length > PART_LIMIT;
  const part = paged ? slicePart(body, { section: ask.section, offset: ask.offset, limit: ask.limit })
    : { text: body, start: 0, end: body.length, total: body.length };
  if (typeof part === "string") return { text: part, panel: null };
  const current = loaded.rev.revision === loaded.doc.current_revision;
  const standing = !current
    ? `This is a snapshot of version ${loaded.rev.version}, not the current one. Presenting history does not ` +
      "vouch for the current revision: approval is refused until that revision's own bytes have been presented."
    : "A `version` or `section` present is a read outside any review context: it counts nothing towards " +
      "approval. Present the document without them to record a presentation.";
  const compose = (): string =>
    `${factsOf(rel, loaded)}\n${metadataLine(loaded.text)}\n${standing}\n` +
    (paged ? `${partHeader(rel, part, "the body, frontmatter excluded", body)}\n\n` : `${versionsLine(loaded)}\n\n`) +
    `${part.text}\n`;
  const panel = draw ? await panelDocument(p, who, rel, loaded, null, null) : null;
  if (!current) return { text: compose(), panel };
  const said = await commitPresentation(p, who, rel, {
    context: null, target: snapshotRevision(loaded), baseline: null, kind: "full",
    start: part.start, end: part.end, total: part.total, version: loaded.rev.version, revision: loaded.rev.revision,
    current: { revision: loaded.rev.revision, generation: Number(loaded.rev.content_generation ?? loaded.doc.content_generation) },
    meta_bytes: panel ? Buffer.byteLength(JSON.stringify(panel)) : 0,
  }, compose);
  return { text: said, panel: /^ERROR/.test(said) ? null : panel };
}

/** The facts line every present opens with: the path, the public version, the status, the
 *  snapshot's own content revision — and, for history, the current one beside it, which is the
 *  token a change sends as `base` — and who signed it. */
function factsOf(rel: string, l: Loaded): string {
  const env = parseEnvelope(l.text);
  const facts = [`This is ${rel}`, `version ${l.rev.version}`];
  if (env.status) facts.push(`status ${env.status}`);
  const own = snapshotRevision(l);
  facts.push(l.rev.revision === l.doc.current_revision
    ? `content revision ${own}`
    : `content revision ${own ?? "none (written before snapshots carried one)"}, current version ` +
      `${l.doc.current_version} at content revision ${contentRevision(l.doc.id, Number(l.doc.content_generation))}`);
  const signed = env.approved_by ? ` Approved by ${env.approved_by}${env.approved_at ? ` on ${env.approved_at}` : ""}.` : "";
  return `${facts.join(", ")}.${signed}`;
}

/** The review metadata line: title, tags, stakeholder, then each flow field by name — the fields and
 *  the names a delta's metadata records use (`deltaOf`). */
function metadataLine(text: string): string {
  const m = changeSnapshot(text);
  const q = JSON.stringify;
  const fields = Object.keys(m.fields).sort().map((k) => `; fields.${k} ${q(m.fields[k])}`).join("");
  return `Review metadata, which an approval signs with the body: title ${q(m.title)}; tags ${q(m.tags.join(", "))}; ` +
    `stakeholder ${q(m.stakeholder)}${fields}.`;
}

/** One entry per public version, each the snapshot it is read as, with the note that says why it
 *  differs from the one before.
 *
 *  A version read as an unsigned snapshot can hold an approved one before it — a metadata-only
 *  change after the approval files a new row in the same version (a closed document's correction
 *  among them). `version: N` no longer reads that approval, so the entry names it by the token
 *  `content_revision` reads it with; without this, the approval's own reply was the one place the
 *  token was ever printed.
 *
 *  COUPLED: the console's version history (services/gateway/src/console/initiatives.ts,
 *  `superseded_approved`) names the same snapshot by the same rule. */
function versionsLine(l: Loaded): string {
  const entries = publicVersions(l.history).map((r) => ({ r, sealed: supersededApproval(l.doc.id, l.history, r) }));
  const history = entries.map(({ r, sealed }) =>
    `v${r.version} ${r.approved_by ? "approved" : "filed"}` +
    (r.approved_by ? ` by ${r.approved_by}` : "") +
    (r.approved_at ? ` on ${dayOf(r.approved_at)}` : "") +
    (sealed ? ` (${supersededSeal(sealed)})` : "") +
    (r.revision_note ? ` — ${r.revision_note}` : ""));
  return history.length
    ? `Versions filed: ${history.join("; ")}. Read one with \`version: N\`` +
      (entries.some((e) => e.sealed) ? ", and a superseded approved snapshot with its `content_revision`." : ".")
    : "Versions filed: none — no approval has landed on this document yet.";
}

/** An approved snapshot a later row of its version superseded, as the versions line says it. */
function supersededSeal(s: NonNullable<ReturnType<typeof supersededApproval>>): string {
  const by = `by ${s.approvedBy}${s.approvedAt ? ` on ${dayOf(s.approvedAt)}` : ""}`;
  return s.content_revision == null
    ? `an approved snapshot ${by} superseded inside it, with no content revision retained`
    : `approved snapshot \`${s.content_revision}\` ${by} superseded inside it`;
}
