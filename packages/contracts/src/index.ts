/**
 * @zz/contracts — the types shared across zz-stack: the services, their MCP adapters, the
 * tools, and the console.
 *
 * This file is the package's one door. Everything below is re-exported through it and no
 * consumer deep-imports a sibling module.
 */

import { z } from "zod";

export { actingTeam, addressResolver, mintPat, parseCaller, PAT_TOKEN,
         peerAddress, sha256 } from "./identity.js";

// Conditional documents in the flow contract (FR-52, FR-58, Task I-26): a document may declare
// `when` over the durable branch facts an initiative has settled, and `documentApplies` is the
// one reader every gate/close/status computation calls. FlowDocWhen is imported below, into
// FlowDoc's own shape, rather than merely re-exported — see the field.
export { WHEN_FACT_NAMES, documentApplies,
         type WhenFactName, type FlowDocWhen, type Applicability } from "./flow-when.js";
import { FlowDocWhen } from "./flow-when.js";

// The one write path a platform access token goes through — pat_issue and pat_revoke call
// these, and so does provisionReplayTeam/teardownReplayTeam below. Declared here rather than
// depending on the `pg` package: `Db` is the minimal shape both services' pg.Pool satisfies.
export { issuePat, revokePat, type Db } from "./pat.js";

// Reserved teams for a replay run, reachable from zz-core's replay_start/replay_close: the
// narrow, database-only path a shared package function gives across the service boundary,
// with no internal HTTP endpoint invented for it.
export {
  provisionReplayTeam, teardownReplayTeam,
  REPLAY_TEAM_PREFIX, REPLAY_REQUIRES_UNBOUND_CREDENTIAL,
} from "./replay-team.js";

export { TOOL_ALIAS, MANAGE_ALIAS, EVAL_ALIAS, SKILL_ALIAS,
         FIXED_DOORS, DOORS_PRINTED, isDoor, NO_TOKEN_ONBOARDING, PLUGIN_ALIAS,
         resolveTool, resolveToolKey, resolveStep } from "./alias.js";

export { BANDS, NOT_MEASURABLE, band,
         HEADROOM, HEADROOM_STATES, headroomState, MARK_SCALE, type HeadroomState } from "./bands.js";

// The Evaluation Protocol contract (FR-6, spec v8): the durable measurement object a plugin
// version is scored against. PROTOCOL_ENUMS and EVAL_STATE_ENUMS are the one source every
// evaluation writer, and the gate's "every state the schema allows can actually be reached"
// check, draw their vocabulary from.
export {
  PROTOCOL_ENUMS, EVAL_STATE_ENUMS,
  EvaluationProtocol, Dimension, Measure,
  ReplayDependencyPolicy, ThreeWaySplitPolicy,
  QualificationPolicy, EstablishmentPolicy, UncertaintyPolicy,
  SearchPolicy, CandidateSelectionPolicy,
  ProofPolicy, ReleasePolicy, Guardrail, FailureMode,
} from "./eval-protocol.js";

// Types and the zod schemas that validate untrusted input against them. `semanticFields` and
// `mutationErrorCodes` are declared once in tenant-information.ts; nothing downstream restates
// SemanticPayload's field set or the error-code list.
export {
  ArtifactClassSchema, type ArtifactClass,
  KnowledgeTypeSchema, type KnowledgeType,
  KnowledgeStatusSchema, type KnowledgeStatus,
  GateStatusSchema, type GateStatus,
  EdgeKindSchema, type EdgeKind,
  ArtifactRefSchema, type ArtifactRef,
  semanticFields,
  SemanticPayloadSchema, type SemanticPayload,
  SourceCitationSchema, type SourceCitation,
  ContentRevisionSchema, type ContentRevision,
  ArtifactEventKindSchema, type ArtifactEventKind,
  ArtifactEventSchema, type ArtifactEvent,
  SourceCaptureSchema, type SourceCapture,
  MutationOpSchema, type MutationOp,
  mutationErrorCodes,
  MutationRequestSchema, type MutationRequest,
  MutationResultSchema, type MutationResult,
  MutationErrorSchema, type MutationError,
  MutationIndeterminateSchema, type MutationIndeterminate,
  MutationOutcomeSchema, type MutationOutcome,
  SearchResultSchema, type SearchResult,
  SearchResponseSchema, type SearchResponse,
} from "./tenant-information.js";

// DELIBERATE: the one wildcard in this file. `control-loop.js` is an aggregator, and a module
// added to it must reach every consumer without an edit here — this file is near the 700-line
// ceiling the gate enforces.
export * from "./control-loop.js";

/**
 * The frontmatter block at the head of a document: `[0]` is the whole block including both
 * fences, `[1]` the lines between them.
 *
 * DELIBERATE: no `g` flag, so it carries no lastIndex and is safe to share between match,
 * exec and replace. The closing fence tolerates trailing whitespace and an absent final
 * newline; every reader of an envelope uses this one pattern.
 */
export const ENVELOPE_BLOCK = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/;

/** A document without its envelope. */
export function documentBody(content: string): string {
  return content.replace(ENVELOPE_BLOCK, "");
}

/** A document's frontmatter envelope, or {} when there is none. Later keys win, and a value's
 *  trailing `# comment` is stripped. The only envelope parser; nothing re-implements it. */
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
 * A refusal with the nouns that vary taken out — the class of refusal, not the instance.
 *
 * A refusal quotes what the caller sent, so kept whole it both groups into classes of one and
 * puts a document title or an address into a table people read. This strips the varying nouns.
 *
 * COUPLED: the gateway redacts at write time and the report groups at read time. Both use this
 * one list — order decides the answer, so two lists cannot agree.
 *
 * DELIBERATE: the initiative patterns run before the date patterns. An initiative folder
 * begins with a date, and the date pattern would match that prefix and leave the slug behind.
 *
 * Normalises and redacts; truncates nothing. The caller decides how much to keep.
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
  // DELIBERATE: a number after `code`, `status` or `http` is kept. For a bare refusal the
  // status is the only information in it, and collapsing it merges a validation refusal with a
  // server fault. `http` is on the list because tool-telemetry writes a failed relay as
  // `http ${res.statusCode}`.
  [/(?<!\b(?:code|status|http)\s)\b\d+\b/g, "<n>"],
];

/** Who a refusal belongs to, from the sentence it carries. "A call came back not-ok" is four
 * different facts and a rate that counts them as one is mostly schema-validation noise.
 *
 * COUPLED: the gateway writes it onto every event; packages/tools' step-score reads it back.
 *
 *   guardrail  the platform said no, by name. Working as intended; never a defect.
 *   ours       the call was malformed — a missing argument, an invalid enum, unparseable
 *              JSON. A flow could have avoided it.
 *   theirs     the tool answered with a status, a web page, or not at all.
 *   other      not classifiable from the text, which is a real answer and not a bucket to
 *              make small.
 */
type RefusalOwner = "guardrail" | "ours" | "theirs" | "other";

/** A refusal the caller could have avoided: the shape of a call, not the health of a tool. */
const REFUSAL_OURS = /Missing required argument|Invalid arguments|Input validation error|could not be parsed as JSON|validation error|not found|No such tool available/i;
/** A refusal that belongs to the tool: it answered with a status, a web page, or not at all. */
const REFUSAL_THEIRS = /status code \d{3}|http \d{3}|Error POSTing to endpoint|Unexpected content type|<html/i;
/** The platform saying which rule was broken. */
const REFUSAL_GUARDRAIL = /^ERROR[: ]/;

export function refusalOwner(refusal: string): RefusalOwner {
  const t = refusal.replace(/\s+/g, " ").trim();
  if (!t) return "other";
  if (REFUSAL_GUARDRAIL.test(t)) return "guardrail";
  // DELIBERATE: before `ours`. A transport failure often mentions both a status and the word
  // "error"; the tool's own answer is the more specific claim.
  if (REFUSAL_THEIRS.test(t)) return "theirs";
  if (REFUSAL_OURS.test(t)) return "ours";
  return "other";
}

export function refusalClass(text: string): string {
  let one = text.replace(/\s+/g, " ").trim();
  // DELIBERATE: a function replacement, so a `$` in a replacement is never a capture group.
  for (const [re, to] of VARYING) one = one.replace(re, () => to);
  return one;
}

/* The envelope and the manifest, defined once
 *
 * One definition, three projections: the zod schema validates, `z.infer` types, and
 * `jsonSchema()` publishes it at /schemas/ so a tenant can be told their manifest is illegal
 * before a write is refused.
 *
 * DELIBERATE: no conversion library. The emitter below covers exactly the constructs these two
 * schemas use and throws on one it does not know, so a published schema can never be weaker
 * than the validator. */

/** `status` is exactly these. Not a vocabulary the model may extend. */
export const STATUSES = ["draft", "approved"] as const;

/** `outcome` is a closed set: the ledger is read by counting, and a free-text column cannot
 * answer "how many were accepted this quarter".
 *
 * `delivered` finished; `accepted` is a person saying it is what they wanted; `abandoned`
 * stopped. Each names who gave the verdict.
 *
 * DELIBERATE: there is no `superseded`. A closed record is not edited afterwards. Succession
 * belongs to knowledge, where `knowledge_supersede` already does it.
 */
export const OUTCOMES = ["delivered", "accepted", "abandoned"] as const;

/** `verdict` on a decision row is a closed set, so zz.decision can be counted. The parser, the
 * schema and the check all read this list.
 *
 * The order is a ladder: `native` is the block doing it itself, `achievable` needs
 * configuration, `workaround` needs something outside the block, `not_possible` is the answer
 * a selection is allowed to give. */
const VERDICTS = ["native", "achievable", "workaround", "not_possible"] as const;

/** A verdict as a person writes it in a fit ledger ("Not possible"), back to its literal. */
export const verdictFromProse = (said: string): string | null => {
  const m = new RegExp(`^(${VERDICTS.map((v) => v.replace("_", "[ _]")).join("|")})`, "i").exec(said.trim());
  return m ? m[1].toLowerCase().replace(" ", "_") : null;
};

/** The one outcome that says the work stopped rather than finished.
 *
 * COUPLED: `closeCheck` exempts a stopped initiative from "every declared gate must be
 * approved" — a dropped initiative is precisely one whose gates were never passed.
 * `initiative_close()` derives this word from `disposition: abandoned`.
 *
 * DELIBERATE: `satisfies`, never an annotation. An annotation widens the constant to all three
 * outcomes, and `initiative_close` builds `z.enum(["finished", OUTCOME_STOPPED])` from it — so
 * its disposition would infer as four words and the kernel's `deriveOutcome`, which takes the
 * two a caller may send, could not be handed it. */
export const OUTCOME_STOPPED = "abandoned" satisfies (typeof OUTCOMES)[number];

/** The verdict fields. `document_approve()` and `initiative_close()` stamp them from the
 *  session; a hand write is refused. */
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
  /** Who attached a source. Written by source_add and document_revise, read by source_list
   *  and the knowledge base. COUPLED: RESERVED_ENVELOPE derives from these keys, so declaring
   *  it here is what stops a flow claiming the name. */
  contributed_by: z.string().optional(),
  /** The flow stage a source is the output of, written by source_add when the caller names an
   *  audit stage that produces a source supporting the document. Only a source carrying it is a
   *  round of that stage; read by audit-rounds.ts, initiative_status and source_list. */
  stage: z.string().optional(),
  /** For an audit round: the version of the supported document the round read, written by
   *  source_add. A document revised past it owes the next round. */
  audits_version: z.string().optional(),
  /** Why a document was revised, in one line, written by document_revise.
   *  DELIBERATE: no code reads it. evolve-report counts revisions and sends a reader to the
   *  team's own store; only the count crosses the boundary. */
  revision_note: z.string().optional(),
  /** The initiatives a journal node was learned from, written by knowledge_add.
   *  COUPLED: indexDoc puts it in zz.doc.evidence and knowledge_search expands the graph along
   *  it, so a flow claiming this name would land in the knowledge graph's edges. */
  evidence: z.string().optional(),
  /** The journal node that replaced this one, written by knowledge_supersede.
   *  DELIBERATE: camelCase where every other field is snake_case. It is the name already on
   *  every journal node on disk; renaming it makes those nodes unreadable. The search result
   *  carries the column's spelling (`superseded_by`) beside it. */
  supersededBy: z.string().optional(),

  /** The version of its subject a knowledge node's claims were last checked against, written by
   *  knowledge_add. */
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
  /** The `## ` headings this document must carry. Which headings is the flow's business,
   * never the platform's — sdlc's eight components and sm's are different sets. */
  sections: z.array(z.string()).optional(),
  /** Which stage writes this document, by that stage's skill name. What lets the console draw
   *  a flow without a per-flow table.
   *
   *  DELIBERATE: optional. A flow whose documents do not map onto stages is a real shape, and
   *  where this is absent the console says so rather than guessing a position. */
  stage: z.string().optional(),
  /** FR-52, FR-58 (Task I-26): this document applies only on the branch its facts describe.
   *  Absent, this document behaves exactly as it always has — see `documentApplies` in
   *  ./flow-when.js, the one function that reads this field. */
  when: FlowDocWhen.optional(),
}).strict();
export type FlowDoc = z.infer<typeof FlowDoc>;

/** A document name here is a claim `documents` can be checked against. */
const stageBase = { name: z.string().min(1) };

/** A stage whose result is evidence, and the document that evidence is about. A source is
 * filed under `sources/` and nobody approves it; `supports` names the document it explains,
 * which is what lets the platform refuse that document's next version until this is cited.
 *
 * DELIBERATE: `supports` is required here and refused on every other stage — one that writes a
 * document already names it, and one that produces nothing supports nothing. */
const SourceStage = z.object({
  ...stageBase,
  produces: z.literal("source"),
  supports: z.string().regex(/^[a-z0-9][a-z0-9-]*\.md$/, "a document name, like \"spec.md\""),
}).strict();

/** Every other stage: writes a main document the flow declares, writes rows in the platform's
 * own tables (`"record"`), or leaves nothing (`"nothing"`).
 *
 * DELIBERATE: `produces` is required, which is what `"nothing"` is for. Optional would answer
 * "the author forgot" and "this stage produces nothing" with the same absence. */
const ArtifactStage = z.object({
  ...stageBase,
  produces: z.union([
    z.string().regex(/^[a-z0-9][a-z0-9-]*\.md$/, "a document name, like \"spec.md\""),
    z.literal("record"), z.literal("nothing"),
  ]),
}).strict();

/** What a step leaves behind. Whether it needs a person is `gate` on the declared document,
 *  not here. See ARCHITECTURE.md, "Defining a step". */
export const FlowStage = z.union([SourceStage, ArtifactStage]);
export type FlowStage = z.infer<typeof FlowStage>;

export const CatalogManifest = z.object({
  name: z.string().optional(),
  /** The documents this package governs. A package is a flow if and only if this is
   *  non-empty; `@zz/catalog`'s `isFlow` is the one place that asks.
   *
   *  COUPLED: declaring documents obliges `stages` too, and `manifestAt` refuses a manifest
   *  that omits them. The reverse is legal — stages without documents is a non-flow package. */
  documents: z.array(FlowDoc).optional(),
  entry: z.string().optional(),
  /* DELIBERATE: no `version`. Every plugin ships at the platform's number, stamped into
   * plugin.json by client-package. A manifest declaring its own gives two answers to "which
   * version is installed", and evaluation compares versions. */
  description: z.string().optional(),
  /** Why this package exists — the problem it solves. DELIBERATE: separate from
   *  `description`, which is what it does, for the marketplace card. This one answers whether
   *  the next author's idea belongs in this package or a new one. */
  purpose: z.string().min(1).optional(),
  /** The commands a person can type, mapped to the skill carrying the method.
   *  `{ "flow": "sdlc-flow" }` ships `/sdlc:flow`.
   *
   *  DELIBERATE: declared, never derived, and keyed by the command so JSON itself stops two
   *  skills claiming one name. A command is a naming choice; a skill name is the identifier
   *  `plugin-profile.ts` attributes historical runs by.
   *
   *  A skill named here is promoted — it ships as the command and not also as a skill. Codex
   *  has no commands and keeps the skill. */
  commands: z.record(z.string().min(1)).optional(),
  /** Skills that are neither a stage nor a command: the shared text another skill loads.
   *  Naming them is what makes "every shipped skill is declared somewhere" checkable. */
  libraries: z.array(z.string().min(1)).optional(),
  /** Where this package's eval suite is authored, relative to this manifest. `"evals"` for the
   *  three catalog-resident packages; `zz-core` declares `"../../../evals"` because it ships no
   *  file from `catalog/zz/zz-core/` at all.
   *
   *  DELIBERATE: declared, because a walk of the checkout cannot tell a source from its own
   *  build output — `build-marketplace.ts` regenerates `marketplace/` from `catalog/`, so every
   *  case exists twice and a root sweep bills each one twice.
   *
   *  DELIBERATE: not the key `claude plugin eval` reads. That CLI defaults to
   *  `experimental.evals` on the built plugin.json; this is the platform's declaration about
   *  its own source tree. */
  evals: z.string().min(1).optional(),
  servers: z.array(z.object({ name: z.string(), path: z.string() })).optional(),
  agentName: z.string().optional(),
  /** ZZ owns this and it sits on the shelf: every account has it, so a team cannot install it
   *  and it is hidden from the installable listing.
   *
   *  DELIBERATE: this says ownership, never shape. Shape is `documents` and nothing else — a
   *  shelved package is a flow when it declares documents and is not when it does not. */
  shelved: z.literal(true).optional(),
  /** The flow's stages in order, each naming a skill. What `produces` hangs off and what the
   *  console's stepper walks.
   *
   *  DELIBERATE: not the flow test — `documents` is. Every package with a door has steps. */
  stages: z.array(FlowStage).optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  $schema: z.string().optional(),
  // DELIBERATE: strict, on both this and FlowDoc. zod's default drops an unknown key
  // silently, so a misspelt field validates, installs and does nothing. Strict is also what
  // retires a field: a manifest still carrying `standalone` is refused, not ignored.
  // COUPLED: zod's message names the key but cannot say what to write instead, so
  // `catalog-manifest.ts` carries that advice — a schema published as JSON cannot.
}).strict();
export type CatalogManifest = z.infer<typeof CatalogManifest>;

/** JSON Schema for a zod schema, covering exactly the constructs above.
 *
 * DELIBERATE: not a conversion library, and an unknown construct throws rather than degrading
 * to `{}`. A schema that publishes weaker than the validator is worse than none. */
export function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as { _def: Record<string, unknown> })._def;
  const name = def.typeName as string;
  switch (name) {
    case "ZodString": {
      // DELIBERATE: an unknown string check throws. Dropping it publishes a schema weaker
      // than the validator, which is the one thing this function exists not to do.
      const out: Record<string, unknown> = { type: "string" };
      for (const c of (def.checks ?? []) as { kind: string; value?: number; regex?: RegExp }[]) {
        if (c.kind === "min") out.minLength = c.value;
        else if (c.kind === "max") out.maxLength = c.value;
        // DELIBERATE: a regex with flags is refused, not stripped. `pattern` holds `source`
        // alone, so `/x/i` would publish case-sensitive and admit less than the validator.
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
    // A union publishes as `anyOf`, which is exactly as strict as zod's union.
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
      // A strict object publishes `additionalProperties: false`. zod's default `strip` drops
      // an unknown key silently and is honestly described by omitting the keyword.
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
 * Why a value did not satisfy a schema — one line per issue, `<path>: <message>`, joined by
 * `; `. A ZodError renders as a wall of JSON by default; this is the sentence an operator reads.
 *
 * DELIBERATE: the path is always named, `(root)` when there is none. The schemas here are
 * strict, so the commonest failure is one mistyped key, and "Required" with nothing saying of
 * what is the one answer that helps nobody.
 */
export function whyNot(
  error: { issues: readonly { path: readonly (string | number)[]; message: string }[] },
): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
