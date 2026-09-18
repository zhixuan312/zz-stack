/**
 * @zz/contracts — the single source of truth for the types shared across zz-stack: the
 * services, their MCP adapters, the tools, and the knowledge web app.
 */

import { z } from "zod";

// The public surface is one import for every consumer, so who-is-this is re-exported here
// rather than making fifty call sites name a second entry point. Not a compatibility shim:
// this file is the package's door and identity.ts has never had one of its own.
export { actingTeam, addressResolver, mintPat, parseCaller, PAT_TOKEN,
         peerAddress } from "./identity.js";

// The per-door rename history is a static lookup, not runtime state, but it is still reached
// through this one door rather than a deep import — the same reason identity.ts is re-exported
// above instead of letting callers reach it directly.
export { TOOL_ALIAS, MANAGE_ALIAS, EVAL_ALIAS, SKILL_ALIAS,
         FIXED_DOORS, DOORS_PRINTED, isDoor, NO_TOKEN_ONBOARDING, PLUGIN_ALIAS,
         resolveTool, resolveToolKey, resolveStep } from "./alias.js";

/**
 * The frontmatter block at the head of a document: `[0]` is the whole block including both
 * fences, `[1]` the lines between them.
 *
 * ONE PATTERN, because it was spelled eight times across three packages and they did not
 * agree on how a block ENDS. This closed on `\n---`; zz-core's five copies closed on
 * `\n---[ \t]*\n?`; indexDoc's body-strip closed on `\n---\n?`, which does not tolerate a
 * trailing space on the fence; kb.ts's required a newline after it, so a document ending
 * exactly at its closing fence had a full envelope to parseEnvelope and none at all there.
 * That is the same drift this parser's own docstring records having had with the Python copy,
 * reappearing in the shape of the block rather than in the reading of it.
 *
 * No `g` flag, so it carries no lastIndex and is safe to share between match, exec and
 * replace.
 */
export const ENVELOPE_BLOCK = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/;

/** A document without its envelope. Two readers strip one — the search index, so a body can be
 * ranked and excerpted, and the browser, so a page renders the prose — and each had its own
 * regex for it. */
export function documentBody(content: string): string {
  return content.replace(ENVELOPE_BLOCK, "");
}

/** A document's frontmatter envelope, or {} when there is none.
 *
 * ONE parser, because the answer has to be the same everywhere. It was written four times
 * over: zz-core had this, kb.ts had a copy for a document's metadata and a separate regex
 * for `outcome` — one that searched the first 2000 characters of the whole FILE, so a
 * document merely discussing an outcome closed its initiative in the browser — and the
 * outcome audit carried a fourth, in Python, held to this one by a gate check comparing
 * three regexes as strings. The two had already drifted: that copy closed on `\n---\s*\n`
 * where this closes on `\n---`, so a document ending exactly at its fence had a full
 * envelope here and none at all there. The audit imports this now.
 *
 * Later keys win, and a value's trailing `# comment` is stripped. */
export function parseEnvelope(content: string): Record<string, string> {
  const m = content.match(ENVELOPE_BLOCK);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/[ \t]+#.*$/, "").trim();
  }
  return out;
}

/**
 * A refusal with the nouns that vary taken out — the CLASS of refusal, not the instance.
 *
 * A refusal message is written to teach the caller which rule was broken, and to do that it
 * quotes what the caller sent: `evidence entry "${e}" must be an initiative folder name`,
 * `confirm must repeat the email exactly ('${email}')`. Kept whole, that groups into a
 * hundred classes of one and says nothing; and it puts somebody's document title, or their
 * address, into a table that people and tooling read.
 *
 * ONE list, because there were two and they disagreed. The gateway redacted at write time
 * (privacy) and the report redacted again at read time (grouping), with the same patterns in
 * a DIFFERENT ORDER — and order decides the answer. Measured on four real refusals, three
 * came out differently: `24-08-2026-sample-intake` collapsed to `<initiative>` in one and to
 * `<date>-sample-intake` in the other, so every initiative made its own class, which is the exact
 * failure the redaction exists to prevent.
 *
 * The initiative pattern MUST run before the date pattern: an initiative folder begins with a
 * date, and `\b\d{2}-\d{2}-\d{4}\b` matches that prefix and leaves the slug behind.
 *
 * The caller decides how much to keep — the gateway stores a sentence, the report shows a
 * label — so this normalises and redacts, and truncates nothing.
 */
const VARYING: [RegExp, string][] = [
  [/`[^`]*`/g, "`…`"],
  [/'[^']*'/g, "'…'"],
  [/"[^"]*"/g, '"…"'],
  [/\b[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>"],
  [/\b\d{2}-\d{2}-\d{4}-[a-z0-9-]+/g, "<initiative>"],
  [/\b\d{4}-\d{2}-\d{2}-[a-z0-9-]+/g, "<initiative>"],
  [/\b\d{2}-\d{2}-\d{4}\b/g, "<date>"],
  [/\b\d{4}-\d{2}-\d{2}\b/g, "<date>"],
  // …except a status code, which for a bare refusal is the only information in it. Collapsing
  // it merged "status code 422" and "status code 500" into one class, so a validation refusal
  // and a server fault counted as the same thing.
  //
  // `http` is on the list because the PLATFORM'S OWN transport refusal is written that way:
  // tool-telemetry records a failed relay as `http ${res.statusCode}`. Naming only the two
  // shapes a block happens to use meant `http 404`, `http 502` and `http 503` all became
  // `http <n>` — a caller asking for a door that is not there and an upstream dying
  // mid-response counted as one class, in the same table watch-results reads to alert when a
  // refusal class gets worse. Exactly the merge this exception was written to prevent, one
  // sentence over, on the refusals this repository writes itself.
  [/(?<!\b(?:code|status|http)\s)\b\d+\b/g, "<n>"],
];

/** WHO A REFUSAL BELONGS TO, from the sentence it carries.
 *
 * FOUR OWNERS, because "a call came back not-ok" is four different facts and reading them as
 * one made the console's lead tile wrong by a factor of four. Measured on production: of 285
 * not-ok tool calls, only 69 began with `ERROR` — the platform's own sentence saying which
 * rule was broken. 185 were ONE client sending a malformed enum argument over and over, and
 * 29 were a client calling tools by their pre-rename names. A "refusal rate" that counts all
 * of those answers the question "is the tool surface breaking" with 76% schema-validation
 * noise, and the reader cannot tell which quarter is the real answer.
 *
 * HERE, beside refusalClass, because two readers need the same verdict and there is no third
 * place both can reach: the gateway writes it onto every event as it happens, and
 * packages/tools' step-score reads it back to score a step. It lived only in the second, so
 * the instrument that WRITES the data had no idea the distinction existed.
 *
 *   guardrail  the platform said no, by name. Working as intended; never a defect.
 *   ours       the CALL was malformed — a missing argument, an invalid enum, unparseable
 *              JSON. A flow could have avoided it.
 *   theirs     the tool answered with a status, a web page, or not at all.
 *   other      not classifiable from the text, which is a real answer and not a bucket to
 *              make small.
 */
type RefusalOwner = "guardrail" | "ours" | "theirs" | "other";

/** A refusal the CALLER could have avoided: the shape of a call, not the health of a tool. */
const REFUSAL_OURS = /Missing required argument|Invalid arguments|Input validation error|could not be parsed as JSON|validation error|not found|No such tool available/i;
/** A refusal that belongs to the tool: it answered with a status, a web page, or not at all. */
const REFUSAL_THEIRS = /status code \d{3}|http \d{3}|Error POSTing to endpoint|Unexpected content type|<html/i;
/** The platform saying which rule was broken. */
const REFUSAL_GUARDRAIL = /^ERROR[: ]/;

export function refusalOwner(refusal: string): RefusalOwner {
  const t = refusal.replace(/\s+/g, " ").trim();
  if (!t) return "other";
  if (REFUSAL_GUARDRAIL.test(t)) return "guardrail";
  // BEFORE `ours`, because a transport failure often carries a message that mentions a
  // status AND the word "error"; the tool's own answer is the more specific claim.
  if (REFUSAL_THEIRS.test(t)) return "theirs";
  if (REFUSAL_OURS.test(t)) return "ours";
  return "other";
}

export function refusalClass(text: string): string {
  let one = text.replace(/\s+/g, " ").trim();
  // A function, like every other replacement in this repository: none of the VARYING
  // replacements contains a $, so this is uniform rather than a fix — and uniform is what
  // lets the gate state the rule without carrying a list of exceptions to it.
  for (const [re, to] of VARYING) one = one.replace(re, () => to);
  return one;
}

/* ── the envelope and the manifest, defined once ──────────────────────────────
 *
 * Both of these were three things at once: a TypeScript interface in @zz/catalog, a set of
 * literal regexes and const arrays in zz-core, and prose in a skill. Three copies of one
 * definition, and nothing that could hand the rules to anybody outside this repository.
 *
 * That last part is what makes a schema necessary rather than tidy. A tenant writing their
 * own flow needs something that can tell them their manifest is not legal, and rules spread
 * across validation functions cannot be quoted, published, or read before the file is
 * written — you find out by having the write refused. A schema can be shown first.
 *
 * One definition, three projections: the zod schema validates, `z.infer` types, and
 * `jsonSchema()` publishes. There is deliberately no fourth copy and no conversion library:
 * the emitter below covers exactly the constructs these two schemas use, and a construct it
 * does not know throws rather than guessing, so a schema can never silently publish as
 * something weaker than it is. */

/** `status` is exactly these. Not a vocabulary the model may extend. */
export const STATUSES = ["draft", "approved"] as const;

/** `outcome` is a CLOSED set, because the ledger is read by counting.
 *
 * `status` has been exactly `draft` or `approved` since the beginning; `outcome` was any
 * string an agent felt like writing. The two fields sit next to each other in the same
 * envelope and one of them was a free-text field feeding the team's ledger — "how many
 * initiatives were accepted this quarter" cannot be answered over a column holding
 * `accepted`, `delivered`, `shipped`, `done for now` and `mostly complete`.
 *
 * The asymmetry is deliberate and worth stating: a PERSON says whatever they say, and it is
 * the model's job to understand them. What the MODEL writes down is a closed set, because
 * everything downstream reads it as data. Openness belongs at the boundary with a human;
 * determinism belongs everywhere after it.
 *
 * `delivered` is work that finished; `accepted` is a person saying it is what they wanted;
 * `abandoned` says it stopped. Every one of them names who gave the verdict.
 *
 * `superseded` is gone, and its absence is the point. Marking a closed initiative as
 * superseded means going back to edit a finished record months later, and a record's whole
 * value is that it is not edited afterwards — an initiative is independent, stateless and
 * self-contained. Nobody ever went back to do it, either: the word existed and the act did
 * not. Succession belongs to the kind of knowledge that DOES evolve, and it already works
 * there — `knowledge_supersede` validates the replacement exists, refuses self-supersede, and
 * re-indexes. Records are near-immutable after close; distillates evolve.
 */
export const OUTCOMES = ["delivered", "accepted", "abandoned"] as const;

/** `verdict` on a decision row is a CLOSED set, for the same reason `outcome` is: the whole
 * value of zz.decision is that it can be counted, and a vocabulary a parser invents cannot be.
 *
 * It was four literals inside one regex in the indexer and a sentence in a migration comment,
 * which is two spellings of one rule and no way for a database constraint to agree with
 * either. Named here so the parser, the schema and the check all read the same list.
 *
 * The order is the ladder: `native` is the block doing it itself, `achievable` needs
 * configuration, `workaround` needs something outside the block, `not_possible` is the answer
 * a selection is allowed to give and the one a stakeholder most needs to hear early. */
const VERDICTS = ["native", "achievable", "workaround", "not_possible"] as const;

/** How a verdict is written in a fit ledger, where a person reads it: "Not possible", not
 * `not_possible`. One transformation, in one direction, spelled once. */
export const verdictFromProse = (said: string): string | null => {
  const m = new RegExp(`^(${VERDICTS.map((v) => v.replace("_", "[ _]")).join("|")})`, "i").exec(said.trim());
  return m ? m[1].toLowerCase().replace(" ", "_") : null;
};

/** The one outcome that says the work STOPPED rather than finished.
 *
 * Named, because two places need the distinction and OUTCOMES alone does not carry it.
 * closeCheck exempts a stopped initiative from "every declared gate must be approved" — it
 * has to, since an initiative that was dropped is precisely one whose gates were never
 * passed, and requiring them would leave only "approve a plan nobody agreed to" or "leave it
 * open forever". initiative_close() derives this word from `disposition: abandoned`.
 *
 * It was a bare `/^abandoned$/` in one of those places and a literal in the other. The
 * derivation is annotated `(typeof OUTCOMES)[number]` so the compiler holds it; the regex was
 * held by nothing, and renaming the word would have left every stopped initiative refused at
 * a gate it can never pass — the deadlock the exemption exists to prevent, arrived at by a
 * rename. */
export const OUTCOME_STOPPED: (typeof OUTCOMES)[number] = "abandoned";

/** The verdict fields. `document_approve()` and `initiative_close()` stamp them from the session; a hand write
 * is refused, because only the session knows who is calling and what day it is. */
export const PLATFORM_OWNED = ["status", "approved_by", "approved_at", "outcome", "closed_by"] as const;

export const Envelope = z.object({
  flow: z.string().min(1),
  type: z.string().min(1),
  status: z.enum(STATUSES),
  version: z.string().optional(),
  updated_at: z.string().optional(),
  approved_by: z.string().optional(),
  approved_at: z.string().optional(),
  outcome: z.enum(OUTCOMES).optional(),
  closed_by: z.string().optional(),
  accepted_by: z.string().optional(),
  no_signoff_reason: z.string().optional(),
  supports: z.string().optional(),
  sources: z.string().optional(),
  stakeholder: z.string().optional(),
  tags: z.string().optional(),
  date: z.string().optional(),
  added_at: z.string().optional(),
  title: z.string().optional(),
  /** Who attached a source. source_add and document_revise write it and both source_list
   * and the knowledge base read it — it was simply never declared here, so the schema this
   * platform PUBLISHES as the rules for writing a document omitted a field the platform
   * writes itself, and zz-core's reserved-name set (derived from these keys) did not defend
   * it: a flow could declare its own `contributed_by` and collide with the real one. */
  contributed_by: z.string().optional(),
  /** Why a document was revised, in one line, written by document_revise.
   *
   * No CODE reads it, and that is the design rather than an oversight: evolve-report counts
   * revisions and says in as many words to go and read them in the team's own store, because
   * the reason is theirs and a count is all that may cross the boundary. This is that reason.
   * It was written into the envelope and declared nowhere, so the published schema did not
   * mention a field the platform writes on every revision. */
  revision_note: z.string().optional(),
  /** The initiatives a journal node was learned from, written by knowledge_add.
   *
   * Declared for the reason the three fields around it are: the platform writes it and the
   * platform READS it. indexDoc puts it in zz.doc.evidence, and knowledge_search expands the
   * graph along it — "a node that cites the same initiative as a strong hit is about the same
   * work even when it shares no vocabulary". Undeclared, the published schema omitted a field
   * the platform stamps on every node, and RESERVED_ENVELOPE — derived from these keys — did
   * not defend the name: a flow could declare its own `evidence` field on a chain document
   * and it would land in the knowledge graph's edges. */
  evidence: z.string().optional(),
  /** The journal node that replaced this one, written by knowledge_supersede.
   *
   * camelCase where every other field here is snake_case, and deliberately left that way: it
   * is the name already on every journal node on disk, and the search result carries the
   * column's spelling (`superseded_by`) beside it. Renaming the field would make the nodes
   * already written unreadable to the code that reads them, which is a cost paid by teams
   * for a consistency only this file would enjoy.
   *
   * Declared because the platform writes it. It was not, so the published schema omitted a
   * field the platform stamps on every supersede, and RESERVED_ENVELOPE — derived from these
   * keys — did not defend the name. */
  supersededBy: z.string().optional(),

  /** ── set on a SKILL that is attached to a building block ────────────────────
   *
   * A usage skill is written on top of a server nobody here controls. The block changes on
   * its own schedule, and when it does every trap the skill records and every assembly order
   * it teaches may have quietly stopped being true — with nothing on our side having moved.
   *
   * `block` names that server; `verified_against` is the block version the skill's claims
   * were last checked against. They are NOT the skill's version, which stays MAJOR.MINOR and
   * means what it means everywhere else. Two fields rather than one concatenated string,
   * because a block may answer a build timestamp rather than a version when
   * asked, and there is no version number that survives being glued to that.
   *
   * Declared here so the published schema shows them and RESERVED_ENVELOPE defends the names:
   * a flow that claimed `block` for something of its own would land in the drift report. */
  block: z.string().optional(),
  verified_against: z.string().optional(),
});
export type Envelope = z.infer<typeof Envelope>;

/** One document in a flow's chain, as the manifest declares it. */
export const FlowDoc = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  gate: z.boolean().optional(),
  requires: z.string().optional(),
  closing: z.boolean().optional(),
  requiredForClose: z.boolean().optional(),
  /** The `## ` headings this document must carry. WHICH headings is the flow's business,
   * never the platform's — sdlc's eight components and sm's are different sets. */
  sections: z.array(z.string()).optional(),
  /** WHICH STAGE WRITES THIS DOCUMENT, by that stage's skill name.
   *
   * The manifest already said which documents a flow gates. It never said where in the flow
   * each one is written, so nothing could draw a flow without being told: the console hung
   * four gates off fixed positions 1, 2, 4 and 6 — ops-flow's — and printed them over every
   * initiative on the platform, including five-stage evaluations with two gates. Every other
   * approach to that is a second per-flow table somewhere, which is the same mistake with a
   * different owner and stops being true the day a flow is added.
   *
   * Optional, because a flow whose documents do not map cleanly onto stages is a real shape
   * and should not be forced to lie. Where it is absent the console says so rather than
   * guessing, which is the honest failure. */
  stage: z.string().optional(),
}).strict();
export type FlowDoc = z.infer<typeof FlowDoc>;

/** A DOCUMENT NAME here is a CLAIM the rest of the manifest can be held to: `documents`
 * already says which stage writes each document, so a stage naming one the flow does not
 * declare is a stage nobody can verify. */
const stageBase = { name: z.string().min(1) };

/** A STAGE WHOSE RESULT IS EVIDENCE, and the document that evidence is about.
 *
 * A source is filed under `sources/`, nobody approves it, and its whole job is to explain why a
 * main document changed — an audit round is the material that makes the next version of the
 * document it read necessary. `supports` names that document, which is what lets the platform
 * refuse the next version until this round is cited, and what lets a diagram show the round
 * happened. Required here and refused everywhere else: a stage that writes a document already
 * names it, and a stage that produces nothing supports nothing. */
const SourceStage = z.object({
  ...stageBase,
  produces: z.literal("source"),
  supports: z.string().regex(/^[a-z0-9][a-z0-9-]*\.md$/, "a document name, like \"spec.md\""),
}).strict();

/** EVERY OTHER STAGE: one that writes a MAIN document the flow declares, one whose result is
 * rows in the platform's own tables (`"record"`), or one that leaves no artifact at all
 * (`"nothing"`).
 *
 * REQUIRED, and that is the whole point of the last value. An optional field answers "the
 * author forgot" and "this stage genuinely produces nothing" with the same absence, and those
 * are different facts about a flow — the first is a manifest to fix, the second is a design
 * decision somebody made. */
const ArtifactStage = z.object({
  ...stageBase,
  produces: z.union([
    z.string().regex(/^[a-z0-9][a-z0-9-]*\.md$/, "a document name, like \"spec.md\""),
    z.literal("record"), z.literal("nothing"),
  ]),
}).strict();

/** WHAT A STEP LEAVES BEHIND, which is how a flow answers the three questions about it: does it
 * produce documentation, is that documentation main or supporting, and does it need a person.
 * The first two are `produces` (and `supports` with it); the third is `gate` on the declared
 * document. See ARCHITECTURE.md, "Defining a step". */
export const FlowStage = z.union([SourceStage, ArtifactStage]);
export type FlowStage = z.infer<typeof FlowStage>;

export const CatalogManifest = z.object({
  name: z.string().optional(),
  /** THE DOCUMENTS THIS PACKAGE GOVERNS — and therefore whether it is a flow at all.
   *
   * A package is a flow if and only if this is non-empty. `@zz/catalog`'s `isFlow` is the
   * one place that asks; see `shelved` below for why the field that used to answer did not.
   * Optional, and absent is the ordinary answer: a package with an agent, a door and no
   * discipline over documents is a surface, not a flow, and zz-access is one.
   *
   * Declaring documents obliges the manifest to declare `stages` too — something has to
   * produce them — and `manifestAt` refuses one that does not. The reverse is not an
   * obligation: stages without documents is a legal non-flow package. */
  documents: z.array(FlowDoc).optional(),
  entry: z.string().optional(),
  /* NO `version`. Every plugin in this repository is released together, at the platform's own
   * number, and client-package stamps that into the plugin.json a person installs. A manifest
   * declaring its own produced two answers to "which version is installed": flow.json said
   * zz-access 2.3.0 while the shipped package said 0.43.0, and the registry recorded the
   * former — so evaluation, which compares versions, was reading a number nobody ran. */
  description: z.string().optional(),
  /** WHY THIS PACKAGE EXISTS, in the author's own words — the one sentence that says what
   * problem it is here to solve.
   *
   * Separate from `description`, which is what the package DOES, written for the marketplace
   * card a person scans while choosing. Both are prose and they are not the same prose: a
   * card that reads "measure a whole plugin" tells a reader what they get, and it does not
   * tell the next author whether their idea belongs in this package or a new one. That
   * second question is the one that decides whether a catalog stays coherent, and nothing in
   * the manifest asked it. */
  purpose: z.string().min(1).optional(),
  /** THE COMMANDS A PERSON CAN TYPE: the name they type, mapped to the skill that carries
   * the method. `{ "flow": "sdlc-flow" }` ships `/sdlc:flow`, and `{ "deck": "zz-deck" }` ships
   * `/zz-core:deck`, each carrying that skill's own text.
   *
   * DECLARED, NEVER DERIVED, and keyed by the command so JSON itself enforces that two
   * skills cannot claim one name. This replaced `standalone`, a list of skill names from
   * which the command name was computed by stripping the plugin's prefix — a derivation that
   * gave three of four front doors the same name (`flow`), because an entry skill is named
   * after its plugin and nothing survives the strip. A command is a naming choice somebody
   * makes; a skill name is an identifier `plugin-profile.ts` attributes historical runs by,
   * so the two cannot be one string.
   *
   * A skill named here is PROMOTED: it ships as the command and not also as a skill, because
   * the same method arriving twice under two names is the router problem this avoided. Codex
   * has no commands and keeps the skill. A package that declares no command for a skill
   * ships it as a skill, which is the right answer for a stage nobody types. */
  commands: z.record(z.string().min(1)).optional(),
  /** SKILLS THAT ARE NEITHER A STAGE NOR A COMMAND: the ones another skill loads.
   *
   * sdlc-flow ships `sdlc-method` and `sdlc-audit-criteria`, and zz-core ships `zz-authoring`,
   * none of which a person types and none of which is a stage — they are the shared text the stage skills
   * load. Without this field they were the residue: everything in `skills/` that `entry`,
   * `stages` and `commands` did not account for, which is indistinguishable from a skill
   * somebody forgot to declare. Naming them makes "every shipped skill is declared
   * somewhere" a question a check can ask. */
  libraries: z.array(z.string().min(1)).optional(),
  /** WHERE THIS PACKAGE'S EVAL SUITE IS AUTHORED, relative to the directory holding this
   * manifest. `"evals"` for the three packages whose content is catalog-resident.
   *
   * DECLARED BECAUSE A WALK OF THE CHECKOUT CANNOT TELL A SOURCE FROM ITS OWN BUILD OUTPUT.
   * `build-marketplace.ts` deletes and regenerates `marketplace/` from `catalog/`, so every
   * case exists twice on disk by construction — and a sweep pointed at the repository root
   * found both: measured 2026-09-13, `audit-catches-an-unverified-claim` discovered once under
   * each tree and billed for six runs of one case, every one of them failing. Any cost read off
   * that run overstates the suite and any score double-counts it. The mirror is not the defect
   * and is not deleted: `client-package.ts` ships it because `claude plugin eval` resolves an
   * installed plugin to its cache directory and looks for `evals/` below it, and a run that
   * finds none silently becomes a baseline-only one with no comparison in it. What this field
   * fixes is which of the two trees the platform's own sweep reads.
   *
   * THE BASELINE IS THE EXCEPTION AND SAYS SO OUT LOUD. `zz-core` ships no file from
   * `catalog/zz/zz-core/` at all — `baselineFiles()` walks ZZ_SKILLS_DIR and
   * `platformOwnEvals()` walks ZZ_EVALS_DIR, both of which are this repository's root — so it
   * declares `"../../../evals"` rather than naming a directory that does not exist beside it.
   * Same reason `skill-homes.ts` asserts its skills at `skills/` and absent from the catalog.
   *
   * NOT THE KEY `claude plugin eval` READS. That CLI defaults to `experimental.evals` on the
   * built `plugin.json`, and the packaged layout stays `evals/` by construction — residentFiles
   * gives the reason: "source and destination are the same word deliberately". This is the
   * platform's own declaration about its own source tree. */
  evals: z.string().min(1).optional(),
  servers: z.array(z.object({ name: z.string(), path: z.string() })).optional(),
  agentName: z.string().optional(),
  /** ZZ owns this and it sits on the shelf: every account already has it, so a team cannot
   * install it and it is hidden from the installable listing.
   *
   * OWNERSHIP, NOT SHAPE. This was `kind: "platform"`, and the name is what put zz-admin in
   * the flow menu beside ops-flow: the one field that could have said "not a flow" was already
   * spoken for, so the console guessed shape from contents instead. Shape is `documents` and
   * nothing else — a shelved package is a flow when it declares documents and is not when it
   * does not.
   *
   * It was `stages`, which was the right kind of answer — one declared field, never inferred —
   * and the wrong field. Every package that opens a skill has steps, so `stages` said yes to
   * all of them: zz-access declared a single stage repeating its own entry, produced nothing,
   * and got a stepper. A flow is a discipline over documents — gates, order, a closing
   * document — so the packages that have one are the packages that declare documents. */
  shelved: z.literal(true).optional(),
  /** The flow's stages IN ORDER, each naming a skill, and each able to declare which
   * building blocks it may call. See FlowStage.
   *
   * NOT the flow test — `documents` is. This still carries everything it always did: it is
   * what `produces` hangs off, what `stage-access.ts` reads a stage's block authority from,
   * and what the console's stepper walks. It simply does not answer "is this a flow", because
   * every package with a door has steps and the answer was therefore always yes. */
  stages: z.array(FlowStage).optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  $schema: z.string().optional(),
  // STRICT, on both this and FlowDoc. zod's default silently DROPS a key it does not know, so
  // a misspelt `standalon: ["zz-okr"]` — against the field `commands` has since replaced —
  // validated, installed, and produced no command: a flow author's instruction ignored with
  // nothing anywhere saying why, which is the shape this repository keeps finding. Strict is
  // also what retires a field: `standalone` is not listed above, so a manifest still carrying
  // it is REFUSED rather than quietly ignored. The message zod gives for that is
  // `Unrecognized key(s): 'standalone'`, which says the key is not legal and does not say what
  // to write instead — `catalog-manifest.ts` carries that sentence, beside the one it already
  // carries for `clients`, because a schema published as JSON cannot carry advice.
  // It matters most here because this schema is PUBLISHED at
  // /schemas/manifest.json as the rules for writing a flow, precisely so a tenant can be told
  // their manifest is not legal BEFORE a write is refused; a rulebook that accepts a typo is
  // not telling them. Every manifest and every declared document in the catalog already uses
  // only these keys.
}).strict();
export type CatalogManifest = z.infer<typeof CatalogManifest>;

/** JSON Schema for a zod schema, covering exactly the constructs above.
 *
 * Deliberately not a conversion library. The subset is small and closed, and an unknown
 * construct THROWS rather than degrading to `{}` — a schema that silently publishes as
 * weaker than it is would be worse than none, because the whole point is that somebody
 * outside this repository can trust it before they write a file. */
export function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as { _def: Record<string, unknown> })._def;
  const name = def.typeName as string;
  switch (name) {
    case "ZodString": {
      // A CONSTRAINT DROPPED IS A SCHEMA WEAKER THAN THE VALIDATOR, which is the one thing
      // this function's docblock says it exists not to do — and it was doing it. Every
      // `z.string().min(1)` in the two published schemas published as an unconstrained
      // string: Envelope's `flow` and `type`, and a manifest's `documents[].name`. Somebody
      // reading /schemas/manifest.json saw that `""` was a legal document name and found out
      // otherwise by having the write refused, which is exactly the round trip publishing a
      // rulebook is meant to remove.
      //
      // An unknown check THROWS, for the same reason an unknown construct does. `.url()`,
      // `.email()` and `.regex()` all have JSON Schema spellings and none of them is
      // guessable from here — adding one is a decision, not a fallthrough.
      const out: Record<string, unknown> = { type: "string" };
      for (const c of (def.checks ?? []) as { kind: string; value?: number; regex?: RegExp }[]) {
        if (c.kind === "min") out.minLength = c.value;
        else if (c.kind === "max") out.maxLength = c.value;
        // `pattern` is JSON Schema's spelling, and only `source` can cross: a RegExp's flags
        // have nowhere to go, so `/x/i` would publish as case-SENSITIVE and admit less than
        // the validator does. Flags are refused rather than dropped — an unrepresentable
        // constraint is what this function exists to catch, not an exception to it.
        else if (c.kind === "regex") {
          const re = c.regex as RegExp;
          if (re.flags) {
            throw new Error(`jsonSchema: the regex ${re} carries flags (${re.flags}), which ` +
              "`pattern` cannot hold — publishing `source` alone would accept what the " +
              "validator refuses. Drop the flags, or add a deliberate translation here.");
          }
          out.pattern = re.source;
        }
        else {
          throw new Error(
            `jsonSchema: no rule for the string check '${c.kind}'. Add one deliberately — ` +
            "dropping it here would publish a schema weaker than the one being validated against.",
          );
        }
      }
      return out;
    }
    case "ZodBoolean": return { type: "boolean" };
    case "ZodUnknown": return {};
    case "ZodLiteral": return { const: def.value };
    case "ZodEnum": return { type: "string", enum: [...(def.values as string[])] };
    case "ZodOptional": return jsonSchema(def.innerType as z.ZodTypeAny);
    // A UNION publishes as `anyOf`, which is exactly as strict: a value is legal under the
    // published schema if it is legal under one of the members, which is what zod's union
    // does. Added for a stage's `blocks`, where a named list and the word "selected" are two
    // genuinely different shapes of the same answer — not a convenience, and not something
    // that could be flattened without publishing a rule the validator does not hold.
    case "ZodUnion":
      return { anyOf: (def.options as z.ZodTypeAny[]).map((o) => jsonSchema(o)) };
    case "ZodArray": return { type: "array", items: jsonSchema(def.type as z.ZodTypeAny) };
    case "ZodRecord":
      return { type: "object", additionalProperties: jsonSchema(def.valueType as z.ZodTypeAny) };
    case "ZodObject": {
      const shape = (def.shape as () => Record<string, z.ZodTypeAny>)();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = jsonSchema(value);
        if (!value.isOptional()) required.push(key);
      }
      // A STRICT object publishes as one. zod records this on `unknownKeys`, and ignoring it
      // would emit a schema that accepts what the validator refuses — the exact "weaker than
      // it is" this function throws to avoid two cases down. `strip` (zod's default) drops an
      // unknown key silently and is honestly described by omitting additionalProperties.
      const closed = def.unknownKeys === "strict" ? { additionalProperties: false } : {};
      return required.length
        ? { type: "object", properties, required, ...closed }
        : { type: "object", properties, ...closed };
    }
    default:
      throw new Error(
        `jsonSchema: no rule for ${name}. Add one deliberately — emitting {} here would ` +
        "publish a schema weaker than the one being validated against.",
      );
  }
}
/**
 * Why a value did not satisfy a schema — the sentence an operator reads.
 *
 * @zz/catalog states the reason in its own comment: "the schema is strict, so the commonest
 * failure is one mistyped key. safeParse gives the issues without throwing, so the line says
 * which field, at which path." A ZodError's default rendering is a wall of JSON; this is the
 * line instead, and the gate holds the gateway's two loaders to producing it.
 *
 * Three copies of it, byte-identical, in two packages — the block registry, the credential
 * store, and a flow manifest. All three are configuration somebody WROTE, and the sentence
 * is the whole of what they get back: a copy that stopped naming the path would leave one
 * operator reading "Required" with nothing saying of what.
 */
export function whyNot(
  error: { issues: readonly { path: readonly (string | number)[]; message: string }[] },
): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
