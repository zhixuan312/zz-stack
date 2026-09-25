/**
 * Defects planted in the document and knowledge layers: the two shelves and the handover chain
 * (`knowledge.ts`), the published schema against its validator (`documents-schema.ts`), and what
 * a caller may put in an envelope (`documents-frontmatter.ts`).
 *
 * Every row breaks a property, never a build. The subjects are mostly live TypeScript, so each
 * substitution leaves the tree compiling — a mutation that trips `tsc -b` comes back as
 * `build_failed` and measures nothing. Where a refusal is what a check reads, the defect makes
 * the refusal stop firing rather than fire harder: a guard that turns everybody away satisfies
 * any check that only reads its refusals.
 *
 * DELIBERATE: two payloads are assembled at runtime and carry `redact: true`. Two of the checks
 * below read the whole repository — one walks every tracked file for the name of a retired skill,
 * one demands that every backticked name in a migration comment exists somewhere in the tree — so
 * a literal here would make this module satisfy or violate the check its own row measures. The
 * report is written to `testing/mutation-report.json`, which is tracked and inside the same
 * corpus, so redaction keeps the artifact out of it too; the text is base64-encoded and the
 * experiment stays reproducible.
 */
import type { MutationSpec } from "./plant.ts";

/** The retired sdlc closing skill's name, never spelled in this file.
 *
 * `scripts/gate/checks/knowledge.ts` walks every tracked `.md`, `.json`, `.mjs`, `.ts` and `.js`
 * under the repository root for this string and fails on any file that carries it — this module
 * included. Building it from two halves keeps the row's payload out of that corpus. */
const RETIRED_SKILL = ["sdlc", "record"].join("-");

/** A column name that must exist nowhere in the repository for its row to land.
 *
 * "the schema's own document names things that exist" builds its corpus from every tracked file,
 * this one included, and passes a backticked name the moment the name appears anywhere. Spelled
 * in full, the planted comment would name a column this file has and the mutation would change
 * nothing. */
const ABSENT_COLUMN = `agent_${"label"}`;

export const COV_KNOWLEDGE: readonly MutationSpec[] = [
  // ————————————————————————————————— knowledge.ts —————————————————————————————————
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "every flow ends with the platform's handover",
    assertion: "zz-core can tell a handover document apart from an ordinary one",
    subject: "services/zz-core/src/tools/initiative-status.ts",
    // Global, because the recogniser is declared once and called once: renaming only the
    // declaration leaves the call site dangling, `tsc -b` fails, and the run reports survived
    // because the gate went red somewhere other than the target.
    all: true,
    find: "isHandover",
    replace: "looksLikeTheLastOne",
    planted: "the recogniser is renamed, so nothing in zz-core identifies a handover document " +
      "and a derived handover reads as an ordinary pending one — which is how an agent came " +
      "to be told to write a handover before the close. This clause used to look for " +
      "`action: \"handover\"`, a phrase that exists in zz-core only inside two comments both " +
      "saying the state was REMOVED, so it passed on prose describing the absence of the " +
      "thing it asserted",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "a platform-scoped node is about a registry entry",
    assertion: "the refusal clause reads code, so a comment carrying the phrase cannot satisfy it",
    subject: "services/zz-core/src/tools/knowledge.ts",
    // The decoy is the experiment. Deleting the refusal alone proves nothing — the clause would
    // go red under the old reading too. This deletes the refusal and leaves a comment carrying
    // the phrase the old clause matched, so the old reading stays green and only the new one
    // fires. `SUBJECT_KINDS` stays true of both readings because the guard above it is kept, so
    // the refusal clause is the only one that can be reporting.
    //
    // The whole block goes, including `carried` and its `return text(…)`: `noUnusedLocals` is
    // on, and parking the return behind `if (false)` leaves the refusal's own text in the code,
    // which `withoutComments` preserves by design.
    find: "        if (!hasSubjectTag) {\n          const carried = tags && tags.length ? tags.join(\", \") : \"no tags\";\n          return text(\n            \"ERROR: `scope: \\\"platform\\\"` needs a registry-entry tag — `plugin:`, `flow:`, \" +\n            \"`provider:`, `interface:` or `platform:` — because platform knowledge is by \" +\n            `definition about one of them. This node carries \\`${carried}\\`. Tag what it is ` +\n            \"about, or send `scope: \\\"team\\\"`.\"\n          );\n        }",
    replace: "        if (!hasSubjectTag) {\n          // A platform node needs a registry-entry tag \u2014 plugin:, flow:, provider:,\n          // interface: or platform: \u2014 because platform knowledge is by definition\n          // about one of them.\n        }",
    planted: "the refusal for a platform node with no registry-entry tag is unreachable, and " +
      "a comment carrying its exact wording is left in its place — which is what the clause " +
      "used to be satisfied by, on raw source, for as long as somebody had explained the rule " +
      "near the code that enforced it",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "a search counts a superseded result the same way it excludes one",
    assertion: "the count reads both signals the exclusion reads",
    subject: "services/zz-core/src/tools/knowledge-search.ts",
    find: '        return row.status === "superseded" || Boolean(row.superseded_by);',
    replace: '        return row.status === "superseded";',
    planted: "the superseded count reads `status` alone, which answers for a node and never " +
      "for a document — 210 documents on this deployment carry a superseded_by and not one " +
      "carries status: superseded, so the field reports 0 for every document search",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "every flow ends with the platform's handover",
    assertion: "the skill that performs the close names the handover that follows it",
    subject: "catalog/sdlc/sdlc-flow/skills/sdlc-flow/SKILL.md",
    find: "handover",
    replace: "learnings",
    all: true,
    // DELIBERATE: `planted` does not spell the renamed skill this produces. A skill name no
    // plugin ships, written into a tracked file and then into the report, is one of the shapes
    // the dispatcher trips on — and the sentence needs the consequence, not the string.
    planted: "the entry skill that performs sdlc-flow's close stops naming the handover " +
      "anywhere — every mention is renamed to the artifact the handover abolished, so the " +
      "skill that closes points at a document and a stage the platform does not ship, and an " +
      "agent closes, reports finished, and meets the platform's handover step with nothing " +
      "having told it that step was coming",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "the platform's own knowledge has a home, and it is reserved",
    assertion: "team_create reserves the platform's own team against a tenant claiming it",
    subject: "services/gateway/src/admin/teams.ts",
    find: "  if (slug === PLATFORM_TEAM) {",
    replace: "  if (slug === \"zz-platform\") {",
    planted: "team_create stops reserving the platform's team by the constant identity.ts " +
      "exports and reserves a hand-copied spelling of it instead, so renaming PLATFORM_TEAM " +
      "leaves the platform's own shelf claimable by a tenant with nothing saying so",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "the second distillation exists and is reachable",
    assertion: "the skill states the evidence rule a promoted finding owes",
    subject: "skills/zz-handover/SKILL.md",
    find: "evidence",
    replace: "provenance",
    all: true,
    planted: "the handover skill stops naming the evidence a promoted finding owes — its " +
      "worked knowledge_add call sends a field the tool does not take, and the rule that an " +
      "unsourced conclusion about a plugin is not a finding is gone from the only place a " +
      "reader meets it",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "the shelf is on the door everyone has, and each admin act is in its tier",
    assertion: "creating a principal is registered in the superadmin tier",
    subject: "services/gateway/src/admin.ts",
    find: "  if (sup) server.registerTool(\"person_add\", {",
    replace: "  if (lead) server.registerTool(\"person_add\", {",
    planted: "creating a principal drops from a superadmin act to a team admin's, so anybody " +
      "who administers one team is offered the tool that mints people for the whole platform",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "a knowledge node says which shelf it belongs on",
    assertion: "scope carries no default, so silence is not a sayable answer",
    subject: "services/zz-core/src/tools/knowledge.ts",
    find: "        scope: z.enum([\"team\", \"platform\"]),",
    replace: "        scope: z.enum([\"team\", \"platform\"]).default(\"team\"),",
    planted: "`scope` gains a default, so saying nothing about which shelf a node belongs on " +
      "becomes a sayable answer again and a fact meant for every team lands quietly on one " +
      "team's own shelf",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "a knowledge node is written to the shelf its scope names",
    assertion: "the platform branch resolves the platform shelf and not the team's",
    subject: "services/zz-core/src/tools/knowledge.ts",
    find: "      const root = scope === \"platform\" ? knowledgeRoot() : await userRoot();",
    replace: "      const root = scope === \"platform\" ? await userRoot() : knowledgeRoot();",
    planted: "the two shelves are swapped: every platform-scoped node is filed on the " +
      "writer's own team shelf and every team lesson on the shelf all teams read, with the " +
      "call reporting success either way",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "a platform-scoped node is about a registry entry",
    assertion: "a platform-scoped node carrying no registry-entry tag is refused",
    // The whole guard goes, rather than an inlined copy of the five kinds: taking it out is the
    // right direction for this assertion — the refusal stops firing rather than firing harder —
    // and the decoy-comment row beside this one covers the refusal clause on its own.
    subject: "services/zz-core/src/tools/knowledge.ts",
    find: "      if (scope === \"platform\") {\n" +
      "        const hasSubjectTag = (tags ?? []).some((raw) => {\n" +
      "          const m = /^([a-z]+):(.+)$/.exec(raw.trim());\n" +
      "          return m !== null && (SUBJECT_KINDS as readonly string[]).includes(m[1]);\n" +
      "        });\n" +
      "        if (!hasSubjectTag) {\n" +
      "          const carried = tags && tags.length ? tags.join(\", \") : \"no tags\";\n" +
      "          return text(\n" +
      "            \"ERROR: `scope: \\\"platform\\\"` needs a registry-entry tag — `plugin:`, `flow:`, \" +\n" +
      "            \"`provider:`, `interface:` or `platform:` — because platform knowledge is by \" +\n" +
      "            `definition about one of them. This node carries \\`${carried}\\`. Tag what it is ` +\n" +
      "            \"about, or send `scope: \\\"team\\\"`.\"\n" +
      "          );\n" +
      "        }\n" +
      "      }\n",
    replace: "",
    planted: "a node written to the shelf every team reads no longer has to say what it is " +
      "about — an opinion with no registry-entry tag on it is accepted onto the platform " +
      "shelf, where nothing can find it by subject and nobody can tell whether it was ever " +
      "a fact about a plugin at all",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "a team-scoped node cannot be written by somebody in no team",
    assertion: "the teamless refusal is scoped to a team-scoped write and leaves the platform shelf alone",
    subject: "services/zz-core/src/tools/knowledge.ts",
    find: "      if (scope === \"team\" && !team) {",
    replace: "      if (scope === \"platform\" && !team) {",
    planted: "the teamless refusal is pointed at the wrong shelf: a caller in no team is now " +
      "turned away from the platform shelf, which needs no team, and their team-scoped node " +
      "is accepted and written to a personal directory team-gated search can never reach",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "every act on the knowledge base leaves a record naming who did it",
    assertion: "knowledge_supersede leaves a record naming the caller",
    subject: "services/zz-core/src/tools/knowledge.ts",
    find: "      platformEvent({\n" +
      "        actor: who.email, kind: \"knowledge.supersede\", subject: old_id,\n" +
      "        team: root === knowledgeRoot() ? KNOWLEDGE_TEAM : team,\n" +
      "        detail: { supersededBy: new_id, file: oldFile },\n" +
      "      });\n",
    replace: "",
    planted: "retiring a knowledge node leaves no record naming who retired it, so the one " +
      "act that takes a lesson out of circulation is the one act the journal cannot attribute",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "supersession stays on one shelf and knows which",
    assertion: "a supersession spanning both shelves is refused",
    // The check strips comments and looks for `ERROR:…shelf` in the code, so the refusal itself
    // has to go. The guard is kept and its body emptied: `newNode` stays read, which is what
    // `noUnusedLocals` needs, and the span holds no comment: a span across comment lines plants
    // nothing once one is reworded, and `0 replacements` reads as "this experiment never
    // happened", not as a failure.
    subject: "services/zz-core/src/tools/knowledge.ts",
    find: "      if (oldNode.root !== newNode.root) {\n" +
      "        return text(\n" +
      "          `ERROR: \\`${old_id}\\` is on the \\`${oldNode.shelf}\\` shelf and \\`${new_id}\\` is on ` +\n" +
      "          `the \\`${newNode.shelf}\\` shelf. A node is superseded by one on the same shelf; ` +\n" +
      "          \"promoting a lesson means writing a new platform node, not superseding across shelves.\"\n" +
      "        );\n" +
      "      }",
    replace: "      if (oldNode.root !== newNode.root) { void newNode.shelf; }",
    planted: "a supersession that spans both shelves is no longer refused, so a team can mark " +
      "one of its own nodes superseded by an id that only means something on the platform's " +
      "shelf — ids restart at 0001 on each shelf, so the relabelled node is somebody else's " +
      "and nothing says it happened",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "every flow that gates a document also carries the handover",
    assertion: "the derivation tests for a gated document rather than appending to every flow",
    subject: "packages/catalog/src/index.ts",
    find: "  if (!list.some((d) => d.gate) || list.some((d) => d.name === \"handover.md\")) return list;",
    replace: "  if (list.some((d) => d.name === \"handover.md\")) return list;",
    planted: "the handover is appended to every flow rather than to the ones that gate " +
      "something, so a flow with no gate at all acquires a gated document it never declared " +
      "and its initiatives are told forever to write a document approval will refuse",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "the handover carries a gate and does not carry the close",
    assertion: "the derived handover is gated, so somebody signs it",
    subject: "packages/catalog/src/index.ts",
    find: "      gate: true,\n      requires: list.find((d) => d.closing)?.name",
    replace: "      gate: false,\n      requires: list.find((d) => d.closing)?.name",
    planted: "the derived handover stops being gated, so nobody ever signs what an " +
      "initiative hands on — it is written, it is never read by anyone who has to agree to " +
      "it, and its status stays draft for the life of the store",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "a closed initiative owes nothing, and can still be handed over",
    assertion: "initiative_status reports no state after the close",
    subject: "services/zz-core/src/tools/initiative-status.ts",
    find: "    next = { action: \"closed\", waiting_on: \"nobody\",",
    replace: "    next = { action: \"handover\", waiting_on: \"agent\",",
    planted: "a closed initiative is reported as still owing a handover, which reopens the " +
      "state the close was made terminal to remove — work that stopped halfway is described " +
      "as unfinished forever, and an initiative abandoned before its closing document is " +
      "told to write a document its own gate refuses",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "close names the handover document and not a file that was abolished",
    assertion: "the close's return text does not name the abolished document",
    subject: "services/zz-core/src/tools/initiative-close.ts",
    find: "mints it and writes handover.md — the close satisfies",
    replace: "mints it and writes learnings.md — the close satisfies",
    planted: "the close's own closing sentence sends people to `learnings.md`, the file the " +
      "handover abolished — the same rot that confused two agents in one day, back in the " +
      "one place a reader is most likely to trust",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "the retired sdlc closing skill is gone, everywhere it was not history",
    subject: "catalog/sdlc/sdlc-flow/skills/sdlc-flow/SKILL.md",
    find: "Neither `sdlc-recall` nor `zz-handover` is this flow's to reimplement.",
    replace: `Neither \`sdlc-recall\` nor \`${RETIRED_SKILL}\` is this flow's to reimplement.`,
    redact: true,
    planted: "the flow's entry skill names the retired closing skill again, so an agent " +
      "reading it is pointed at a skill the platform no longer ships and gets an error in " +
      "the middle of the stage the flow declares last",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "the spine states the handover sequence and nothing it superseded",
    assertion: "the spine names the handover document every gated flow owes",
    subject: "skills/zz-platform/SKILL.md",
    find: "it writes `handover.md` and mints what generalises.",
    replace: "it writes `learnings.md` and mints what generalises.",
    planted: "the spine every agent loads first names the abolished `learnings.md` and never " +
      "names the handover document every gated flow now owes, so the one description of the " +
      "sequence that every flow shares is describing a sequence that was removed",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "every skill that documents a knowledge_add call sends scope",
    subject: "catalog/zz/zz-plugin-eval/skills/zz-plugin-eval/SKILL.md",
    find: "❌ **Stopping because the trace block is thin.**",
    replace: "Record what the round concluded: `knowledge_add(title, type, body, evidence)`.\n\n" +
      "❌ **Stopping because the trace block is thin.**",
    planted: "the evaluation flow's entry skill shows a knowledge_add call with no `scope` in " +
      "it, which the platform now refuses — an agent that follows the worked example is " +
      "turned away at the end of an evaluation, holding the finding it was told to record",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "no skill states the abolished learnings.md completion test as current",
    subject: "catalog/zz/zz-plugin-eval/skills/zz-plugin-explain/SKILL.md",
    find: "❌ **Padding section 4.**",
    replace: "`initiative_status` returns `action: handover` until `learnings.md` exists.\n\n" +
      "❌ **Padding section 4.**",
    planted: "the stage that closes an evaluation describes the deleted substring-scan " +
      "completion test as how completion works today, so a reader waits for a state the " +
      "platform stopped answering and a file nothing writes",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "the abandon-contradiction refusal is not disabled by the derived handover",
    subject: "services/zz-core/src/tools/initiative-close.ts",
    find: "const gates = chain.documents.filter((d) => d.gate === true && d.name !== \"handover.md\");",
    replace: "const gates = chain.documents.filter((d) => d.gate === true);",
    planted: "the derived handover is counted among the gates a finished initiative must have " +
      "passed, and it cannot exist at close time — so the refusal that stops fully approved " +
      "work being recorded as abandoned can never fire for any flow that gates anything",
  },

  // ———————————————————————————— documents-schema.ts ————————————————————————————
  {
    check: "scripts/gate/checks/documents-schema.ts",
    target: "every state the schema allows can actually be reached",
    subject: "services/gateway/migrations/001_init.sql",
    // pg_dump's spelling of the same constraint: 001_init.sql is a dump of the schema.
    find: "    CONSTRAINT principal_status_check CHECK ((status = ANY (ARRAY['active'::text, 'deactivated'::text])))",
    replace: "    CONSTRAINT principal_status_check CHECK ((status = ANY (ARRAY['active'::text, 'deactivated'::text, 'suspended'::text])))",
    planted: "a principal gains a third state nothing in the platform can ever set, so any " +
      "guard written to read it looks like working access control over a branch no code path " +
      "can reach",
  },
  {
    check: "scripts/gate/checks/documents-schema.ts",
    target: "everything that reads a source reads the fields sourceDocument writes",
    subject: "services/zz-core/src/tools/artifacts.ts",
    find: "contributed_by: env.contributed_by || \"\", added_at: env.added_at || \"\" };",
    replace: "contributed_by: env.added_by || \"\", added_at: env.added_at || \"\" };",
    planted: "source_list reads a field nothing has ever written, so every source comes back " +
      "with an empty contributor — a blank where a person's name belongs, and nothing " +
      "anywhere saying why",
  },
  {
    check: "scripts/gate/checks/documents-schema.ts",
    target: "every subject kind the platform accepts is one a skill teaches",
    subject: "services/zz-core/src/tools/knowledge.ts",
    find: "export const SUBJECT_KINDS = [\"plugin\", \"flow\", \"provider\", \"interface\", \"platform\"] as const;",
    replace: "export const SUBJECT_KINDS = [\"plugin\", \"block\", \"flow\", \"provider\", " +
      "\"interface\", \"platform\"] as const;",
    planted: "the platform accepts a sixth subject kind that no skill teaches, so nobody is " +
      "told it exists — half the knowledge about a thing gets tagged one way and half the " +
      "other, and the query that makes a subject tag worth writing answers with neither half",
  },
  {
    check: "scripts/gate/checks/documents-schema.ts",
    target: "the published schema is never weaker than the validator",
    assertion: "the manifest schema is strict, so a mistyped key is refused rather than dropped",
    subject: "packages/contracts/src/index.ts",
    find: "}).strict();\nexport type CatalogManifest",
    replace: "});\nexport type CatalogManifest",
    planted: "a manifest key nobody declared is dropped in silence instead of refused, so a " +
      "flow author's mistyped instruction installs, produces nothing, and says nothing — and " +
      "the schema published as the rules for writing a flow accepts what the platform will not",
  },
  {
    check: "scripts/gate/checks/documents-schema.ts",
    target: "a section rename the platform reports is a section the document has",
    assertion: "one author heading containing two required sections is not reported as two renames",
    subject: "services/zz-core/src/write-guards.ts",
    find: "      if (out !== before) renamed.push(",
    replace: "      if (best !== before) renamed.push(",
    planted: "the rename report is asserted beside the change again rather than derived from " +
      "it, so the platform tells an author it renamed a heading it did not touch — and the " +
      "author stops looking for the section the gate is about to refuse them for",
  },
  {
    check: "scripts/gate/checks/documents-schema.ts",
    target: "a subject tag the platform teaches is a subject tag it accepts",
    assertion: "the tag rule refuses a tag that cannot be found again once stored",
    subject: "services/zz-core/src/paths.ts",
    find: "const TAG_TOKEN = /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/;",
    replace: "const TAG_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;",
    planted: "an uppercase tag is accepted at the write, stored and indexed as typed, and " +
      "then unreachable: search folds what a person typed and tags are matched by equality, " +
      "so the node is on the shelf and no query can name it",
  },
  {
    check: "scripts/gate/checks/documents-schema.ts",
    target: "every envelope field the platform reads is one the schema publishes",
    subject: "services/zz-core/src/tools/artifacts.ts",
    find: "        return env.status === \"approved\";",
    replace: "        return env.approval_status === \"approved\";",
    planted: "source_add reads an envelope field the published schema does not declare, so " +
      "the note warning that a document was approved BEFORE this material arrived never " +
      "fires — and the name it reads is one a flow may claim for itself",
  },
  {
    check: "scripts/gate/checks/documents-schema.ts",
    target: "the published schema is exactly as strict as the validator",
    assertion: "a minimum the validator enforces is published as that same minimum",
    subject: "packages/contracts/src/index.ts",
    find: "        if (c.kind === \"min\") out.minLength = c.value;",
    replace: "        if (c.kind === \"min\") out.maxLength = c.value;",
    planted: "a field the validator requires to be at least one character publishes as one " +
      "that may be at most one character, so the rulebook a tenant is handed before writing " +
      "a flow contradicts the rule their write will actually meet",
  },
  {
    check: "scripts/gate/checks/documents-schema.ts",
    target: "the schema's own document names things that exist",
    // pg_dump keeps no `--` prose, so the header of 001_init.sql carries the schema's prose, and
    // `zz.schema_migration` is the one backticked name in it — which is what this check reads.
    subject: "services/gateway/migrations/001_init.sql",
    find: "-- each file it applies in `zz.schema_migration` by name and skips what that table already lists.",
    replace: `-- each file it applies in \`${ABSENT_COLUMN}\` by name and skips what that table already lists.`,
    redact: true,
    planted: "the migrations are the schema's only design document, and one of them now names " +
      "a column this repository does not have — so the single description a reader gets of " +
      "the store is describing something that is not there",
  },
  {
    check: "scripts/gate/checks/documents-schema.ts",
    target: "a subject tag is reachable from the word it is about",
    assertion: "the query tokenizer keeps a colon out of a token, which is what keeps the expansion live",
    subject: "services/zz-core/src/tools/knowledge-search.ts",
    find: "split(/[^a-z0-9\\p{Script=Han}]+/u)",
    replace: "split(/[^a-z0-9:\\p{Script=Han}]+/u)",
    planted: "a colon stops separating words in a search query, so `error:` is one token that " +
      "matches no stored tag and the SUBJECT_KINDS expansion below it becomes dead code — " +
      "the tag lane goes quiet for any query that punctuates, and the lexical lane hides it",
  },
  {
    // The file this row's target is registered in is not the one the assignment named.
    // `documents-schema.ts` only quotes this check's title in a comment; the `check(` call itself
    // is in skill-prose.ts, and the runner matches a row to the file it iterates.
    check: "scripts/gate/checks/skill-prose.ts",
    target: "a skill citing another document's section cites one that exists",
    subject: "catalog/sdlc/sdlc-flow/skills/sdlc-execute/SKILL.md",
    find: "**Degraded behaviour:** a partial run is reported as a partial run",
    replace: "Hand the worker the inputs listed in section 3 (\"the payload\") of sdlc-method.\n\n" +
      "**Degraded behaviour:** a partial run is reported as a partial run",
    planted: "a skill sends a reader to a numbered section of another skill that says " +
      "something else — section 3 of sdlc-method is where a task LANDS, not what it carries " +
      "— so an agent that follows the citation opens the document, cannot find what it was " +
      "promised, and concludes the instruction is stale",
    caveat: "no skill in this repository cites another document's section today, so this " +
      "sweep has no subject as the tree stands and the citation had to be introduced rather " +
      "than made out of an existing one",
  },

  // ————————————————————————— documents-frontmatter.ts —————————————————————————
  {
    check: "scripts/gate/checks/documents-frontmatter.ts",
    target: "a frontmatter field that will not appear is refused, never dropped",
    assertion: "every tool taking `fields` runs the refusal over what the caller actually sent",
    subject: "services/zz-core/src/tools/artifacts.ts",
    find: "frontmatterRefusal(content, \"document_write\") ?? fieldRefusal(fields)",
    replace: "frontmatterRefusal(content, \"document_write\") ?? fieldRefusal(undefined)",
    planted: "document_write runs the frontmatter-name refusal over nothing, so it can no " +
      "longer see the names the caller sent — `buildingBlock` where the skill said " +
      "`building_block` is dropped in silence, and the call reports the document written " +
      "with the field the flow was told to carry absent from it",
    caveat: "the natural form of this defect — deleting the call — orphans the import under " +
      "`noUnusedLocals` in both of the two files that make it, so the row would come back " +
      "`build_failed` and measure nothing. Called with nothing is the same defect the check " +
      "describes (the refusal no longer sees what arrived) in the only shape that compiles",
  },
  {
    check: "scripts/gate/checks/documents-frontmatter.ts",
    target: "a frontmatter field that will not appear is refused, never dropped",
    assertion: "the frontmatter-name rule exists once, with no copy in a write path that drops instead",
    // The duplicate, not the missing call. Deleting `fieldRefusal(fields)` from a write path
    // orphans its import, and `noUnusedLocals` turns the row into a build failure that measures
    // nothing. The second half of the rule is where the plantable defect is: the name predicate
    // written twice, with the copy in the writer dropping the field instead of reporting it.
    subject: "services/zz-core/src/write-guards.ts",
    find: "  for (const [k, v] of Object.entries(opts.fields ?? {})) {\n" +
      "    if (String(v).trim()) env[k.trim()] = String(v);\n  }",
    replace: "  for (const [k, v] of Object.entries(opts.fields ?? {})) {\n" +
      "    if (!/^[a-z][a-z0-9_]*$/.test(k.trim())) continue;\n" +
      "    if (String(v).trim()) env[k.trim()] = String(v);\n  }",
    planted: "the frontmatter-name rule gets a second copy inside the writer, and that copy " +
      "DROPS the field instead of refusing it — so `buildingBlock` where the skill said " +
      "`building_block` comes back as a document written successfully with the field the " +
      "flow was told to carry simply absent from it",
  },
  {
    check: "scripts/gate/checks/documents-frontmatter.ts",
    target: "a caller's words cannot write a frontmatter field",
    assertion: "a tag cannot insert an envelope field through the renderer",
    subject: "services/zz-core/src/document-rules.ts",
    find: "keys.map((k) => `${k}: ${oneLine(env[k])}`).join(\"\\n\")",
    replace: "keys.map((k) => `${k}: ${env[k]}`).join(\"\\n\")",
    planted: "the one place an envelope is rendered stops flattening what it is given, so a " +
      "value carrying a newline does not corrupt a field — it INSERTS one: a tag can write " +
      "the `flow` that decides which gates, which required documents and which closing rule " +
      "govern the whole initiative",
  },
  {
    check: "scripts/gate/checks/documents-frontmatter.ts",
    target: "no write path lets a caller type an envelope field",
    assertion: "a patch that relabels the flow governing the initiative is refused",
    subject: "services/zz-core/src/document-rules.ts",
    find: "  if (was === now) return null;",
    replace: "  const ownedOf = (b = \"\") => b.split(\"\\n\")\n" +
      "    .filter((l) => /^(status|version|approved_by|approved_at|outcome):/.test(l)).join(\"\\n\");\n" +
      "  if (ownedOf(was) === ownedOf(now)) return null;",
    planted: "document_patch's envelope guard narrows to the five fields the platform is " +
      "recorded as owning, and `flow` is not one of them — so a patch may relabel which flow " +
      "governs an initiative, which is the third source of envelope fields this platform " +
      "spent an initiative closing",
  },
];
