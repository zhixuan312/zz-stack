/**
 * The write guards, and the chain they are decided against.
 *
 * Every function answers the same question — may this write land? — and returns either null
 * or a refusal string naming what was wrong and what to do instead.
 *
 * All of them are pure functions of a chain, a path and a document's text: no database, no
 * filesystem, no caller. `Chain` travels with them so server.ts is never imported back.
 */
import { ENVELOPE_BLOCK, type FlowDoc, type FlowStage, OUTCOMES, parseEnvelope, STATUSES } from "@zz/contracts";

import { renderEnvelope } from "./document-rules.js";

/** Timezone every date the platform stamps is resolved in, so nothing that stamps a date can
 * disagree with anything else. */
const ZZ_TZ = (process.env.ZZ_TZ ?? "").trim() || "Asia/Singapore";

export interface Chain {
  name: string | null;      // which flow's manifest this chain came from, null if none
  /** The manifest's documents in order, with their roles and gates. This is what
   * initiative_status reports the sequence from. */
  documents: FlowDoc[];
  /** The flow's stages. Empty for a chain derived from documents alone. */
  stages: FlowStage[];
  docs: Set<string>;
  requires: Record<string, string>;
  closingDoc: string;
  closeRequires: string[];
  roles: Record<string, string>;
}
/** `status: accepted` is a category error: approval lives in `status`, acceptance lives in
 * `outcome`. Refuse it. Read through parseEnvelope, which takes the last value of a repeated
 * key. */
export function statusCheck(chain: Chain, relPath: string, content: string): string | null {
  const parts = relPath.replace(/^\/+/, "").split("/");
  // A flow's declaration narrows this guard; its absence does not disable it. A freeform
  // initiative declares no documents and is still checked; a flow that named its documents
  // exempts the ones it did not.
  if (parts.length !== 2) return null;
  if (chain.documents.length && !chain.docs.has(parts[1])) return null;
  const st = parseEnvelope(content).status;
  if (st !== undefined && !(STATUSES as readonly string[]).includes(st)) {
    return (
      `ERROR: status: ${st} is not a valid status for ${parts[1]} — the value must be ` +
      "EXACTLY `draft` or `approved`, nothing appended. Acceptance lives in `outcome:` on " +
      `${chain.closingDoc || "this flow's closing document"}; commentary lives in the document ` +
      "body, never in frontmatter values."
    );
  }
  return null;
}

/** Refuse an `outcome` outside the closed set. The set itself, and why it is closed, live
 * with the definition in @zz/contracts. */
export function outcomeCheck(chain: Chain, relPath: string, content: string): string | null {
  const parts = relPath.replace(/^\/+/, "").split("/");
  // Narrowed by a declaration, not switched off by its absence — see statusCheck. An
  // unvalidated outcome would reach the ledger row the team's counts are totalled from.
  if (parts.length !== 2) return null;
  if (chain.documents.length && !chain.docs.has(parts[1])) return null;
  const out = parseEnvelope(content).outcome;
  if (out === undefined || (OUTCOMES as readonly string[]).includes(out)) return null;
  return (
    `ERROR: outcome: ${out} is not one this platform records. It must be EXACTLY one of ` +
    OUTCOMES.map((o) => `\`${o}\``).join(", ") + " — `delivered` when the work finished, " +
    "`accepted` when a person says it is what they wanted, `abandoned` when it stopped. " +
    "All three name who gave the verdict. If this work was replaced by a later initiative, " +
    "that is a fact about knowledge, not about this record: close it `abandoned` and mint a " +
    "journal node. The team's ledger is read by counting " +
    // Counted from the vocabulary rather than written down, so the sentence stays in step
    // with OUTCOMES.
    `these, so a ${["first", "second", "third", "fourth", "fifth"][OUTCOMES.length] ?? "further"} ` +
    "word is a row nobody can total. Anything you want to say beyond the " +
    "word belongs in the document body."
  );
}

/** `approved_by`, `accepted_by` and `closed_by` name the person who gave the verdict.
 * Refuse the caller's own team slug and the role words in ANONYMOUS — both satisfy the field
 * while recording nobody.
 *
 * DELIBERATE: a closed list of role words, not an attempt to recognise a name. There is no
 * test for "is this a person", and a check that guessed would refuse real names.
 *
 * The rule is not that a human typed it — an agent may approve in someone's name — only that
 * the field names somebody who could be asked about it later. */
const ANONYMOUS = new Set([
  "the stakeholder", "stakeholder", "the team", "team", "the user", "user", "the customer",
  "customer", "the client", "client", "the owner", "owner", "the requester", "requester",
  "me", "us", "them", "n/a", "na", "none", "unknown", "tbd", "anonymous", "agent", "the agent",
]);

export function attributionCheck(chain: Chain, relPath: string, content: string, team: string | null): string | null {
  const parts = relPath.replace(/^\/+/, "").split("/");
  // Narrowed by a declaration, not switched off by its absence — see statusCheck.
  if (parts.length !== 2) return null;
  if (chain.documents.length && !chain.docs.has(parts[1])) return null;
  const env = parseEnvelope(content);
  for (const field of ["approved_by", "accepted_by", "closed_by"] as const) {
    const who = (env[field] ?? "").trim();
    if (!who) continue;
    const lower = who.toLowerCase();
    const why = team && lower === team.toLowerCase()
      ? "names your team, not a person"
      : ANONYMOUS.has(lower.replace(/[.]$/, ""))
        ? "names a role, not a person"
        : null;
    if (why) {
      return (
        `ERROR: ${field}: ${who} ${why}. ` +
        `${field === "accepted_by" ? "Acceptance" : "An approval"} is a verdict somebody gave — ` +
        "record who gave it, as they are known to you (their name, or the address they wrote " +
        "from). If you do not have a name, you do not yet have the verdict: ask for it."
      );
    }
  }

  // A gated document carrying `status: approved` with no attribution at all. The loop above
  // starts `if (!who) continue`, so it only ever judges a field that is there, and
  // statusCheck looks at nothing but the status word.
  //
  // Gated documents only: a flow can mark an ungated document `approved` as a working state,
  // with nobody having said anything.
  if (parseEnvelope(content).status === "approved"
      && chain.documents.some((d) => d.name === parts[1] && d.gate)) {
    const missing = (["approved_by", "approved_at"] as const).filter((f) => !(env[f] ?? "").trim());
    if (missing.length) {
      return (
        `ERROR: ${parts[1]} is a gated document carrying status: approved without ` +
        `${missing.join(" or ")}. A gate is passed by a person, on a day, and both are stamped ` +
        `by the act — call document_approve("${parts[0]}/${parts[1]}") to record the verdict properly. ` +
        "Writing the attribution by hand is refused, and an approval that exists only in the " +
        "chat does not exist."
      );
    }
  }
  return null;
}

/** The `## ` headings the manifest says this document must carry.
 *
 * Which headings stays in flow.json: each flow's components are its own, and a list hard-coded
 * here would make the platform an sdlc platform. Headings only, and only that they exist —
 * whether a section says anything worth reading is an audit's judgement. */
export function sectionCheck(chain: Chain, relPath: string, content: string): string | null {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return null;
  const want = chain.documents.find((d) => d.name === parts[1])?.sections;
  if (!want?.length) return null;
  // Drafts may be half-written; the check is what the document must be by the time it is
  // offered as done. A gated document says that with `status: approved`, an ungated one by
  // being written at all.
  const gated = chain.documents.some((d) => d.name === parts[1] && d.gate);
  if (gated && parseEnvelope(content).status !== "approved") return null;
  const have = new Set(
    (content.match(/^##[ \t]+.*$/gm) ?? []).map((h) => h.replace(/^##[ \t]+/, "").trim())
  );
  const missing = want.filter((w) => !have.has(w));
  if (!missing.length) return null;
  // Name the near miss. A section written under a different wording reads as "you forgot it"
  // if the refusal says only "missing", so hand the rename back rather than cost a round trip.
  const words = (h: string) => new Set(h.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const nearest = (w: string) => {
    const want_ = words(w);
    let best: string | null = null;
    let bestScore = 0;
    for (const h of have) {
      const hw = words(h);
      const shared = [...want_].filter((x) => hw.has(x)).length;
      const score = shared / Math.max(want_.size, hw.size);
      if (score > bestScore) { bestScore = score; best = h; }
    }
    return bestScore >= 0.5 ? best : null;
  };
  const hints = missing
    .map((m) => [m, nearest(m)] as const)
    .filter((pair): pair is readonly [string, string] => pair[1] !== null)
    .map(([m, n]) => `\`## ${n}\` looks like it was meant to be \`## ${m}\``);
  return (
    `ERROR: ${parts[1]} is missing ${missing.length === 1 ? "the section" : "sections"} ` +
    missing.map((m) => `\`## ${m}\``).join(", ") + `. This flow's manifest declares the ` +
    `sections ${parts[1]} must carry. Add ${missing.length === 1 ? "it" : "them"} — a heading ` +
    "with nothing " +
    "under it is worse than none, so write the section, or take the requirement out of the " +
    "flow's manifest if it no longer holds." +
    (hints.length ? ` Rename, do not re-add: ${hints.join("; ")}.` : "")
  );
}

/** Today in ZZ_TZ, not UTC. A date is a local fact — what somebody would write at the top of
 * a page — and the timestamps beside it stay ISO with an offset, which is what makes them
 * comparable. ZZ_TZ is the same variable the console renders through. */
export function isoToday(): string {
  // en-CA formats as YYYY-MM-DD, which is the one locale that gives an ISO date directly.
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZZ_TZ }).format(new Date());
}

/** Build the frontmatter this document gets, from facts the platform holds and named
 * arguments only — never from YAML the caller composed.
 *
 * status, version, updated_at, and type where a role exists, are stamped by stampEnvelope on
 * the way to disk, so every write path writes them in one place. */
export function envelopeFor(
  chain: Chain, relPath: string, body: string,
  opts: { flow?: string; stakeholder?: string; tags?: string[]; title?: string;
          fields?: Record<string, unknown>; carry?: Record<string, string> },
): string {
  const parts = relPath.replace(/^\/+/, "").split("/");
  // COUPLED: every value leaves through renderEnvelope in document-rules.ts. Concatenating one
  // here instead lets a newline inside it insert frontmatter fields — a tag carrying
  // `\nflow: some-other-flow` rewrites which flow resolves the chain, and ownershipCheck
  // cannot see it because `flow` is not a platform-owned field.
  const env: Record<string, string> = {};
  // What the platform already wrote on this document survives the rewrite. `carry` holds the
  // platform-owned fields plus `version`, read off the previous copy; building the envelope
  // from the arguments alone removes them, and ownershipCheck refuses a write that removes a
  // platform-owned field — which would make every gated document, draft included,
  // un-overwritable.
  //
  // COUPLED: which fields may be carried is decided in document_write, beside PLATFORM_OWNED.
  // This function renders what it is given.
  for (const [k, v] of Object.entries(opts.carry ?? {})) {
    if (v.trim()) env[k] = v;
  }
  const flow = opts.flow?.trim() || chain.name;
  if (flow) env.flow = flow;
  const role = parts.length === 2 ? chain.roles[parts[1]] : undefined;
  if (role) env.type = role;
  // The H1, when no title was given, and only the H1: matching `##` too names a document
  // after its first section. With no H1 there is no title and every reader falls back to the
  // filename.
  const heading = /^#(?!#)[ \t]+(.+)$/m.exec(body)?.[1]?.trim();
  const title = opts.title?.trim() || heading;
  if (title) env.title = title;
  if (opts.stakeholder?.trim()) env.stakeholder = opts.stakeholder;
  const tags = (opts.tags ?? []).map((t) => t.trim()).filter(Boolean);
  if (tags.length) env.tags = tags.join(", ");
  // A flow's own fields, such as sdlc's pointers to the documents a stage answers to. They arrive
  // as an argument rather than as YAML the model composed, so one refusal covers the whole
  // frontmatter.
  //
  // COUPLED: field names are checked by fieldRefusal, which every path into here calls first.
  // An empty value is skipped.
  for (const [k, v] of Object.entries(opts.fields ?? {})) {
    if (String(v).trim()) env[k.trim()] = String(v);
  }
  // The fixed field order first, then the flow's own fields after it.
  return `${renderEnvelope(env, ["flow", "type", "title", "stakeholder", "tags", "blocks"])}\n` +
    body.replace(/^\s+/, "");
}

/** Stamp the structural envelope fields a document cannot be read without. Content and
 * judgement stay with the flow; `flow` and `type` are facts the manifest already holds.
 *
 * `type` is set, not merely added: the manifest's role wins over whatever the writer put
 * there, because the index stores what the file says. `flow` stays add-only — the first
 * document's `flow:` is the input that resolves the chain, so the chain must not overwrite it. */
export function stampEnvelope(chain: Chain, relPath: string, content: string): string {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return content;      // sources/ and _knowledge/ carry their own
  // A document the manifest does not declare still gets the date.
  //
  // Only the date. `status` and `version` belong to a gate lifecycle a non-chain document is
  // not in, and `type` comes from a role the manifest never gave it.
  const governed = chain.docs.has(parts[1]);
  // Gated, not merely governed. `status` records a gate verdict, so it exists only where the
  // manifest declares a gate — per flow, per document, never derived from the file's name, its
  // role or its type. The same document may be gated in one flow and not in another, and that
  // flow's manifest is right both times.
  const gated = chain.documents.some((d) => d.name === parts[1] && d.gate);
  const role = governed ? chain.roles[parts[1]] : undefined;
  let out = content;
  if (role) {
    const m = out.match(ENVELOPE_BLOCK);
    // Whether the field is already there is an envelope question, so parseEnvelope answers
    // it. The replacement stays scoped to m[0], the frontmatter block — never the whole
    // document, which would let a body line beginning `type:` take the stamp.
    if (m && parseEnvelope(out).type !== undefined) {
      out = out.replace(m[0], () => m[0].replace(/^type:.*$/m, () => `type: ${role}`));
    }
  }
  const m = out.match(ENVELOPE_BLOCK);
  const add: string[] = [];
  // "Does the envelope already carry this key" is an envelope question, and parseEnvelope is
  // where envelope questions are answered.
  const present = parseEnvelope(out);
  if (governed && chain.name && present.flow === undefined) add.push(`flow: ${chain.name}`);
  if (role && present.type === undefined) add.push(`type: ${role}`);

  // `status: draft` is the platform's to write. ownershipCheck refuses the field by hand, so
  // no caller can supply it, and a new chain document is a draft by definition —
  // document_approve() is the only thing that moves it afterwards. Add-only, so
  // document_approve()'s own write carrying `status: approved` is not stamped back down.
  if (gated && present.status === undefined) add.push("status: draft");

  // `version` too: the platform is the only thing that knows it. It starts at 1 and moves only
  // through document_revise.
  if (governed && present.version === undefined) add.push("version: 1");

  // updated_at is overwritten rather than merely added: the failure here is a confidently
  // wrong date, not an absent field. ISO, because the alternative sorts wrong and reads
  // differently in two countries.
  //
  // parseEnvelope answers "is the key already there"; a local `^k:` test would read the whole
  // document and take the first value of a repeated key. The replace below is a write, scoped
  // to the frontmatter block exactly as the `type:` stamp above is.
  const today = isoToday();
  const hasDate = present.updated_at !== undefined;
  if (!hasDate) add.push(`updated_at: ${today}`);

  if (m && hasDate) {
    out = out.replace(m[0], () => m[0].replace(/^updated_at:.*$/m, () => `updated_at: ${today}`));
  }
  if (!add.length) return out;
  const m2 = out.match(ENVELOPE_BLOCK);
  if (!m2) return `---\n${add.join("\n")}\n---\n\n${out.replace(/^\n+/, "")}`;
  // The frontmatter block is the replacement here, and it carries title and stakeholder —
  // both the model's own words. A string replacement reads $& and $' inside them.
  return out.replace(m2[0], () => `---\n${add.join("\n")}\n${m2[1]}\n---\n`);
}

/** Rename a section the author wrote under a near-miss heading, instead of refusing the write.
 *
 * Where a heading contains every word of one the flow requires, rename it and let the write
 * through; the rename is reported back, never silent. sectionCheck still refuses a section that
 * is genuinely absent. */
export function normalizeSections(chain: Chain, relPath: string, content: string): {
  content: string; renamed: string[];
} {
  const parts = relPath.replace(/^\/+/, "").split("/");
  const want = parts.length === 2
    ? chain.documents.find((d) => d.name === parts[1])?.sections : undefined;
  if (!want?.length) return { content, renamed: [] };

  const words = (h: string) => new Set(h.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const headings = [...content.matchAll(/^(##[ \t]+)(.*)$/gm)].map((m) => m[2].trim());
  const renamed: string[] = [];
  let out = content;

  for (const target of want) {
    if (headings.includes(target)) continue;
    const tw = words(target);
    // DELIBERATE: containment, not a ratio. "What past work recorded" against "What past work
    // with these blocks recorded" shares all four of its words but scores 4/7, under any
    // threshold high enough to be safe. The question is whether the author's heading says
    // everything the required one says; the shortest such heading is the intended one.
    let best: string | null = null;
    for (const h of headings) {
      if (want.includes(h)) continue;               // already somebody else's required heading
      const hw = words(h);
      if (![...tw].every((x) => hw.has(x))) continue;
      if (!best || h.length < best.length) best = h;
    }
    if (best) {
      // The report is derived from the change, never asserted beside it. `headings` is read
      // once from the original content and never re-derived, so a heading this loop already
      // renamed stays on the list and can match a later target — one author heading can
      // contain the words of two required sections. Comparing before and after leaves no
      // branch in which a rename is reported and did not happen.
      const before = out;
      out = out.replace(new RegExp(`^(##[ \\t]+)${best.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "m"),
                        (_m, prefix: string) => `${prefix}${target}`);
      if (out !== before) renamed.push(`\`## ${best}\` → \`## ${target}\``);
    }
  }
  return { content: out, renamed };
}
