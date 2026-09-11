/**
 * The write guards, and the chain they are decided against.
 *
 * Every function here answers the same question — may this write land? — and returns an
 * INSTRUCTIVE refusal or null. Instructive, not merely negative: the string is what a person
 * reads, and a refusal that only says no makes them guess at the rule. Each names what was
 * wrong and what to do instead.
 *
 * WHY THEY ARE A MODULE, and it is the same argument as `document-rules.ts`: all of them are
 * pure functions of a chain, a path and a document's text. No database, no filesystem, no
 * caller. They are the rules that protect the store, and until this file existed nothing could
 * call one — they sat inside a 6,000-line `server.ts` where every claim about them was a claim
 * about how the source reads.
 *
 * `Chain` travels with them because they are decided against it and server.ts must not be
 * imported back: a guard that reaches for the server is no longer a rule, it is a handler.
 */
import { ENVELOPE_BLOCK, type FlowDoc, type FlowStage, OUTCOMES, parseEnvelope, STATUSES } from "@zz/contracts";

import { renderEnvelope } from "./document-rules.js";

/** Today, ISO. One function so nothing that stamps a date can disagree with anything else.
 *
 * That claim was not true when it was written: six other places spelled
 * `new Date().toISOString().slice(0, 10)` inline — the envelope stamp, both source writers,
 * the approval stamp, the revision stamp and the ledger row. All of them call this. */
const ZZ_TZ = (process.env.ZZ_TZ ?? "").trim() || "Asia/Singapore";

export interface Chain {
  name: string | null;      // which flow's manifest this chain came from, null if none
  /** The manifest's documents IN ORDER, with their roles and gates. Kept because a Set
   * cannot answer "what does this flow produce, in what sequence" — which is what
   * initiative_status reports. It used to answer that from a hardcoded copy of one flow's
   * document list, so every flow was described in the shape of that one. */
  documents: FlowDoc[];
  /** The flow's stages, each with the building blocks it may call. Read by vocabularyCheck:
   * a stage that declares no block may not NAME one either, and the document a stage writes
   * is how the manifest connects the two. Empty for a chain derived from documents alone. */
  stages: FlowStage[];
  docs: Set<string>;
  requires: Record<string, string>;
  closingDoc: string;
  closeRequires: string[];
  roles: Record<string, string>;
}
/** `status: accepted` is a category error the model keeps making at close:
 * approval lives in `status`, acceptance lives in `outcome`. Refuse it.
 *
 * Reads through parseEnvelope like every other status reader. There used to be four
 * regexes for this one field — three taking the first match, parseEnvelope taking the
 * last — so an envelope with two status lines had two different truths, and the probe
 * that produced one saw initiative_status call it approved while write_file called it
 * draft. */
export function statusCheck(chain: Chain, relPath: string, content: string): string | null {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2 || !chain.docs.has(parts[1])) return null;
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
  if (parts.length !== 2 || !chain.docs.has(parts[1])) return null;
  const out = parseEnvelope(content).outcome;
  if (out === undefined || (OUTCOMES as readonly string[]).includes(out)) return null;
  return (
    `ERROR: outcome: ${out} is not one this platform records. It must be EXACTLY one of ` +
    OUTCOMES.map((o) => `\`${o}\``).join(", ") + " — `delivered` when the work finished, " +
    "`accepted` when a person says it is what they wanted, `abandoned` when it stopped. " +
    "All three name who gave the verdict. If this work was replaced by a later initiative, " +
    "that is a fact about knowledge, not about this record: close it `abandoned` and mint a " +
    "journal node. The team's ledger is read by counting " +
    // Counted from the vocabulary, not written down. It said "a fifth word" when there were
    // four outcomes and stayed saying it when `superseded` went, so the sentence the model
    // reads has been off by one since that release.
    `these, so a ${["first", "second", "third", "fourth", "fifth"][OUTCOMES.length] ?? "further"} ` +
    "word is a row nobody can total. Anything you want to say beyond the " +
    "word belongs in the document body."
  );
}

/** `approved_by` and `accepted_by` name the PERSON who gave the verdict. Writing the
 * caller's own team slug there satisfies the field while recording nobody: "who approved
 * this?" — "the team it belongs to" — is the same non-answer as leaving it blank, and it
 * is the answer the model reaches for when it has no name to hand.
 *
 * Twice observed live, in consecutive smoke runs on the same flow: run one wrote
 * `approved_by: team_one` on all four gates, and run two — after acceptance was
 * given a mandatory `accepted_by` — wrote `accepted_by: team_one` into the close.
 * The rule was already stated in prose in every stage skill; a rule prose loses twice is
 * a rule that belongs in code.
 *
 * The team slug is not the only way to name nobody. The live index carries approvals by
 * "The stakeholder" — a ROLE, exactly as anonymous, and reached for by the same reflex. A
 * closed list of role words rather than an attempt to recognise a name: there is no test for
 * "is this a person", and a check that guessed would refuse real names, which is the way to
 * make a guardrail that gets worked around.
 *
 * And the point is NOT that a human must have typed it. The platform does not try to
 * establish that, and should not — an agent approving in someone's name is that person's
 * decision, carried out, because they are the one who put the agent there and they answer
 * for what it does. What the field records is who the approval BELONGS to. These few words
 * are refused because they name nobody who could be asked about it later, which is the only
 * thing a signature is for. */
const ANONYMOUS = new Set([
  "the stakeholder", "stakeholder", "the team", "team", "the user", "user", "the customer",
  "customer", "the client", "client", "the owner", "owner", "the requester", "requester",
  "me", "us", "them", "n/a", "na", "none", "unknown", "tbd", "anonymous", "agent", "the agent",
]);

export function attributionCheck(chain: Chain, relPath: string, content: string, team: string | null): string | null {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2 || !chain.docs.has(parts[1])) return null;
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

  // An approval with NOBODY at all, which this function had been letting past while
  // refusing the lesser version of the same thing.
  //
  // The loop above starts `if (!who) continue`, so it only ever judged a field that was
  // there. `approved_by: <team slug>` is refused because — in its own words two paragraphs
  // up — it "satisfies the field while recording nobody", and is "the same non-answer as
  // leaving it blank". Leaving it blank was then permitted. statusCheck validates that
  // `status` reads exactly `draft` or `approved` and looks at nothing else, so
  // `status: approved` alone was a complete, accepted gate pass.
  //
  // Not theoretical: 4 of the 93 approved documents on this deployment carry no
  // approved_at, 2 carry no approved_by, and one of each came from the most recent smoke
  // run — a live agent passing a gate today and recording neither who nor when. The skills
  // have always said all three ("an approval that exists only in the chat does not exist");
  // only closing enforced it, which is the wrong end: by then the gate is long past and the
  // record of who agreed to what is what an audit reads.
  //
  // GATED documents only. A flow can mark an ungated document `approved` as a working
  // state — ops-flow's selection.md does — and no one has to have said anything for that.
  if (parseEnvelope(content).status === "approved"
      && chain.documents.some((d) => d.name === parts[1] && d.gate)) {
    const missing = (["approved_by", "approved_at"] as const).filter((f) => !(env[f] ?? "").trim());
    if (missing.length) {
      return (
        `ERROR: ${parts[1]} is a gated document carrying status: approved without ` +
        `${missing.join(" or ")}. A gate is passed by a person, on a day, and both are stamped ` +
        `by the act — call approve("${parts[0]}/${parts[1]}") to record the verdict properly. ` +
        "Writing the attribution by hand is refused, and an approval that exists only in the " +
        "chat does not exist."
      );
    }
  }
  return null;
}

/** The `## ` headings the manifest says this document must carry.
 *
 * A stage skill lists its required components in prose — sdlc-spec names eight, and says the
 * spec is not a spec without them. Nothing read that list but a model, and the audit that was
 * supposed to catch a missing one is also a model reading the same document. Grepping this
 * repository for the component names returned nothing: no code anywhere knew the eight exist.
 *
 * A heading list is the cheapest kind of fact — present or absent, no judgement — so it is
 * checked here rather than asked of a model. WHICH headings stays in flow.json, because
 * sdlc's components and sm's are different sets and a list hard-coded here would make the
 * platform an sdlc platform.
 *
 * Headings only, and only that they exist. Whether a section says anything worth reading is
 * exactly the judgement an audit is for, and this check does not pretend to make it. */
export function sectionCheck(chain: Chain, relPath: string, content: string): string | null {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return null;
  const want = chain.documents.find((d) => d.name === parts[1])?.sections;
  if (!want?.length) return null;
  // Drafts are allowed to be half-written; the check is what the document must be by the time
  // it is offered as done. A gated document says that with `status: approved`, and one without
  // a gate says it by being written at all.
  const gated = chain.documents.some((d) => d.name === parts[1] && d.gate);
  if (gated && parseEnvelope(content).status !== "approved") return null;
  const have = new Set(
    (content.match(/^##[ \t]+.*$/gm) ?? []).map((h) => h.replace(/^##[ \t]+/, "").trim())
  );
  const missing = want.filter((w) => !have.has(w));
  if (!missing.length) return null;
  // Name the near miss. Every one of the six real selection.md documents on this deployment
  // wrote `## What past work with these blocks recorded` where the skill specifies
  // `## What past work recorded` — the section was WRITTEN, and an exact-match refusal that
  // said only "missing" would read as "you forgot it" to an agent that did not. Six out of
  // six is not carelessness; it is what happens when a heading is specified in prose. The
  // refusal has to hand back the rename, or it costs a round trip to discover.
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

/** TODAY, IN THE DEPLOYMENT'S OWN TIMEZONE, not in UTC.
 *
 * This was `new Date().toISOString().slice(0, 10)`. Singapore is UTC+8, so for the first
 * eight hours of every working day the platform disagreed with everybody using it: an
 * initiative opened at 09:00 on the 6th was named `2026-09-06-...` by nobody — get_my_info
 * reported the 5th, so the agent used the 5th, and the document it wrote was stamped the 5th
 * too. A whole morning's work filed under yesterday, every day, and the only symptom was a
 * date that looked one off.
 *
 * `ZZ_TZ` is the same variable the console renders through, defaulting to the same zone. A
 * date is a local fact — it is what somebody would write at the top of a page — and the
 * timestamps beside it stay ISO with an offset, which is what makes them comparable.
 */
export function isoToday(): string {
  // en-CA formats as YYYY-MM-DD, which is the one locale that gives an ISO date directly.
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZZ_TZ }).format(new Date());
}

/** Build the frontmatter this document gets, from facts and named arguments only.
 *
 * The counterpart to frontmatterRefusal: having refused the model's YAML, something has to
 * write the real thing. Everything here is either a fact the platform holds (the flow that
 * resolved the chain, the role the manifest gives this document) or a value the caller
 * passed as an argument — which is the distinction that matters, because an argument is
 * something the agent was TOLD and a YAML line is something it composed.
 *
 * The remaining fields — status, version, updated_at, and type where a role exists — are
 * stamped by stampEnvelope on the way to disk, so they are written in exactly one place for
 * every write path rather than once per tool. */
export function envelopeFor(
  chain: Chain, relPath: string, body: string,
  opts: { flow?: string; stakeholder?: string; tags?: string[]; title?: string;
          blocks?: string[]; fields?: Record<string, unknown> },
): string {
  const parts = relPath.replace(/^\/+/, "").split("/");
  // THROUGH renderEnvelope, whose own docblock calls itself "the one place an envelope is
  // rendered, and the reason every value goes through it". It was not the one place. This
  // function built the same frontmatter by concatenating strings, and `tags` was the one
  // value it concatenated raw — title and stakeholder went through oneLine, tags did not.
  //
  // A newline in a tag therefore did not corrupt the document, it INSERTED FIELDS, which is
  // word for word the failure renderEnvelope was written for on the revise path. Verified
  // against this function: write_file with
  // `tags: ["ordinary", "harmless\nflow: some-other-flow\ntype: guide"]` produced an
  // envelope whose flow parseEnvelope reads as `some-other-flow` — it takes the LAST value
  // of a repeated key — and a fabricated `type`. `flow` is what resolves the chain, so which
  // gates, which required documents and which closing rule apply to the initiative were the
  // caller's to choose, and ownershipCheck could not see it because `flow` is not one of the
  // fields the platform owns.
  //
  // Escaping the one field that was missed would have left the second renderer standing, and
  // the next field added to it just as raw. Rendering in one place is what makes the
  // docblock's claim true.
  const env: Record<string, string> = {};
  const flow = opts.flow?.trim() || chain.name;
  if (flow) env.flow = flow;
  const role = parts.length === 2 ? chain.roles[parts[1]] : undefined;
  if (role) env.type = role;
  // The H1, when no title was given. A document names itself on its own first
  // line, and asking the caller to repeat it is asking for two answers to one question.
  //
  // ONLY the H1. This accepted `#{1,3}`, so a document that opens at `##` — as a
  // handful do — was named by its first SECTION instead: sixteen specs and
  // selections are indexed as "1. Context", "Goal", "Building block" and "Fit
  // ledger, acceptance criterion by acceptance criterion". A section heading is
  // not a document name, and the console showed it as one wherever the document
  // appeared. With no H1 there is no title, and every reader falls back to the
  // filename — which is the honest answer, and the one already in the page
  // header beside it.
  const heading = /^#(?!#)[ \t]+(.+)$/m.exec(body)?.[1]?.trim();
  const title = opts.title?.trim() || heading;
  if (title) env.title = title;
  if (opts.stakeholder?.trim()) env.stakeholder = opts.stakeholder;
  const tags = (opts.tags ?? []).map((t) => t.trim()).filter(Boolean);
  if (tags.length) env.tags = tags.join(", ");
  // THE BLOCKS THIS INITIATIVE CHOSE. An argument rather than one of the flow's own `fields`
  // because the PLATFORM reads it: a stage declaring `blocks: "selected"` resolves through
  // this line on every block call. Declaring it in the Envelope schema is what makes the
  // published schema mention a field the platform writes — and it also makes the name
  // reserved, which is why `fields` cannot carry it and this exists.
  const blocks = (opts.blocks ?? []).map((b) => b.trim()).filter(Boolean);
  if (blocks.length) env.blocks = blocks.join(", ");
  // A flow's OWN fields — sm's `building_block` and `instance`; sdlc's pointers to the
  // documents a stage answers to. Which extra facts a document carries is the flow's
  // business, exactly as its section headings are. What matters is that they arrive as an
  // argument rather than as YAML the model composed, so the same refusal covers the whole
  // frontmatter with no exception anybody has to remember.
  //
  // ONE EXCEPTION, AND IT IS READ. This said "the platform does not read these and must not
  // pretend to" and listed `server` among them, and indexDoc reads exactly that field: it
  // splits it into zz.decision.blocks, which is the column `reconcile --block` joins on to
  // answer "what has this team predicted about casebox". ops-select writes it — `server: "<tool
  // prefix>"` — and there is no other way for a stage to say which block its claims are
  // about, so the coupling is deliberate and the sentence denying it was simply false.
  //
  // Not reserved, for that reason: reserving it would refuse the write the feature depends on.
  // The NAME was checked by fieldRefusal, which every path into here calls first and which
  // says what is wrong rather than quietly leaving the field out. An empty VALUE is still
  // skipped: `building_block: ` is not a fact about the document, it is a key with nothing
  // behind it, and the caller passing one has said nothing rather than said it badly.
  for (const [k, v] of Object.entries(opts.fields ?? {})) {
    if (String(v).trim()) env[k.trim()] = String(v);
  }
  // The order this function has always written, then the flow's own fields after it.
  return `${renderEnvelope(env, ["flow", "type", "title", "stakeholder", "tags", "blocks"])}\n` +
    body.replace(/^\s+/, "");
}

/** Stamp the structural envelope fields a document cannot be read without.
 * Content and judgement stay with the flow; `flow` and `type` are facts the
 * platform already holds in the manifest.
 *
 * `type` is SET, not merely added. Adding it only when absent meant the writer's value won, and
 * one did: ops-flow declares guide.md's role as `verification` and every guide on the deployment
 * carries `type: guide`, because a template once put it there. The index stores what the file
 * says, so a search filtered by the role the manifest declares does not find the document the
 * manifest is describing.
 *
 * `flow` stays add-only, and the asymmetry is deliberate: the first document's `flow:` is the
 * INPUT that resolves the chain, so overwriting it from the chain it produced could only ever
 * turn a caller's declaration into something else. */
export function stampEnvelope(chain: Chain, relPath: string, content: string): string {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return content;      // sources/ and _knowledge/ carry their own
  // A document the manifest does NOT declare still gets the date. `learnings.md` is the
  // case: no flow declares it — the handover is the platform's step, appended below every
  // manifest — so it fell out of this function entirely and was written with no date in it
  // at all once the model stopped writing frontmatter. The INDEX was fine, because it
  // stamps now() itself; the FILE was not, and the file is what a team keeps when they walk
  // away from us.
  //
  // Only the date. `status` and `version` belong to the gate lifecycle a non-chain document
  // is not in, and `type` comes from a role the manifest never gave it — stamping those
  // would be the platform inventing facts about a document it does not govern.
  const governed = chain.docs.has(parts[1]);
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
  // where envelope questions are answered — a bespoke `^k:` test here was the last place
  // that asked it a second way.
  const present = parseEnvelope(out);
  if (governed && chain.name && present.flow === undefined) add.push(`flow: ${chain.name}`);
  if (role && present.type === undefined) add.push(`type: ${role}`);

  // `status: draft` is the platform's too, and it has to be stamped here or the field has
  // no author at all. `status` is one of the fields ownershipCheck refuses by hand, which
  // is right — it is how a gate is recorded and a model must not be able to type it. But a
  // NEW document has no previous value, so a template that opened with `status: draft` was
  // refused on its very first write, and a template that dropped the line produced a
  // document with no status for the index and initiative_status to read.
  //
  // Both readings were wrong in the same way: the field was left to whoever remembered.
  // A new chain document IS a draft — that is what "new" means here — so the platform says
  // so, and `approve()` is the only thing that moves it afterwards. Add-only: approve()'s
  // own write already carries `status: approved` and must not be stamped back down.
  if (governed && present.status === undefined) add.push("status: draft");

  // `version` too, and for the same reason as `status`: the platform is the only thing that
  // knows it. It starts at 1 and moves only through revise_document, which is an act — so a
  // template typing `version: 1` is the model asserting a fact it cannot check, and a
  // template that forgets it leaves the index and the version history reading a document
  // with no version at all.
  if (governed && present.version === undefined) add.push("version: 1");

  // updated_at is the platform's to write, not the model's — and unlike flow and type it is
  // OVERWRITTEN rather than merely added, because the failure here is not an absent field but
  // a confidently wrong one.
  //
  // Measured: on 2026-08-28 a run stamped every document in an initiative `26-08-2026` and
  // named the folder `26-08-2026-consultation-booking`, two days early, while its own title
  // carried the correct `pilot-2808`. Nothing caught it. revise_document had already decided
  // this was the platform's job and set the field itself; the shared writer never learned,
  // so the two paths disagreed on the VALUE and on the FORMAT — the same asymmetry that let
  // revise_document skip the document guards until it was found.
  //
  // ISO, because the alternative sorts wrong and reads differently in two countries. The
  // flows disagreed about this too: sm asked authors for <DD-MM-YYYY> and sdlc for
  // YYYY-MM-DD, which is three sources of truth for one mechanical fact.
  // "Is the key already there" is an envelope question, and parseEnvelope answers those —
  // asking it with a local regex is what the gate refuses, and rightly: a bespoke `^k:` test
  // reads the whole document and takes the FIRST value of a repeated key. The replace below
  // is a write, scoped to the frontmatter block, exactly as the `type:` stamp above is.
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

/** Rename a section the author clearly wrote under a different name, instead of refusing it.
 *
 * Every one of the six real selection documents on this deployment that DID the past-work
 * lookup wrote it under `## What past work with these blocks recorded`, where the flow
 * declares `## What past work recorded`. The section is there. The work was done. Refusing
 * that write sends the whole document back to be rewritten over a wording difference the
 * platform can see through — pure cost, and it lands on somebody who did the thing correctly.
 *
 * So: where a heading is a clear near miss for one the flow requires, rename it and let the
 * write through. The rename is reported back, never silent — a document is somebody's, and a
 * platform that quietly edits prose is worse than one that asks.
 *
 * sectionCheck still refuses a section that is genuinely absent, and that refusal lands on an
 * agent, which is the right place for it. This function's whole job is to make sure it never
 * lands on somebody who already wrote the section. */
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
    // CONTAINMENT, not a ratio. A ratio was the first thing here and it rejected the exact
    // heading it was written for: "What past work recorded" against "What past work with these
    // blocks recorded" shares all four of its words but scores 4/7, under any threshold high
    // enough to be safe. The question is not how similar the two strings are — it is whether
    // the author's heading says everything the required one says. When it does, they wrote the
    // section and named it more specifically, and the shortest such heading is the intended
    // one.
    let best: string | null = null;
    for (const h of headings) {
      if (want.includes(h)) continue;               // already somebody else's required heading
      const hw = words(h);
      if (![...tw].every((x) => hw.has(x))) continue;
      if (!best || h.length < best.length) best = h;
    }
    if (best) {
      // THE REPORT IS DERIVED FROM THE CHANGE, never asserted beside it.
      //
      // `headings` is read once from the original content and never re-derived, so a heading
      // this loop had already renamed stayed on the list and was offered to every later
      // target — and one author heading can contain the words of two required sections.
      // sdlc's explore.md declares `Background` and `Current state`, and `## Background and
      // current state` contains both: the first pass renamed it, the second matched the same
      // stale entry, found nothing left on disk to replace, and pushed a rename anyway.
      //
      // The document came back with `## Background`, no `## Current state`, and a reply
      // telling the author both had been renamed. A section that is missing is sectionCheck's
      // to refuse when the document is offered as done; a message saying the platform made it
      // is the one thing that must never happen, because the author acts on it and stops
      // looking.
      //
      // Comparing before and after makes the lie unreachable rather than merely fixed: there
      // is no branch in which a rename is reported and did not happen, whatever a later edit
      // does to how `best` is chosen.
      const before = out;
      out = out.replace(new RegExp(`^(##[ \\t]+)${best.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "m"),
                        (_m, prefix: string) => `${prefix}${target}`);
      if (out !== before) renamed.push(`\`## ${best}\` → \`## ${target}\``);
    }
  }
  return { content: out, renamed };
}
