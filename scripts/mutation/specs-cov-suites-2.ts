/**
 * Mutation specs for the second batch of `scripts/gate/checks/suites.ts` registrations.
 *
 * suites.ts tests nothing itself: every row here is registered by one line of the form
 * `check("<id>", runsCheck("<name>.ts"))`, or an inline `execFileSync` of a compiled engine
 * under `services/gateway/dist/`. The real subject is whatever that script reads, so each spec
 * below names the source, the manifest, the lockfile or the markdown the runner reaches, never
 * the runner. Every row carries an `assertion`, because a row that does not say which claim it
 * is about is unreadable in a report this long.
 *
 * Three payloads are assembled from pieces rather than written whole. This file lives under
 * `scripts/`, which three checks in this batch scan line by line without regard for quoting:
 * `strict-scripts-dir.ts` reports any widening to `any`, `insert-arity.ts` parses any `insert
 * into … values (…)`, and `core-names.ts` reports any pre-rename tool name in quoted or
 * backticked form. Split only where one of those three bites, never to get a spec past the
 * check it is aimed at.
 *
 * Two of this batch's ids have no subject outside a frozen file and live in
 * `unexercisable.ts`: "every check this gate registers is a file git will carry", whose
 * failure mode is a file git does not track, and "gate-launch classification reads the
 * syntax …", which drives `isGateLaunchSource` in scripts/gate/read.ts.
 */
import type { MutationSpec } from "./plant.ts";

// COUPLED: which module registers the target is what `check_sha256` is computed over, so a row
// drifts when the module its own check lives in moves.
const SUITES_DATA = "scripts/gate/checks/suites-data.ts";
const SUITES_SURFACE = "scripts/gate/checks/suites-surface.ts";
const SUITES = "scripts/gate/checks/suites.ts";
const SUITES_TOOLING = "scripts/gate/checks/suites-tooling.ts";

export const COV_SUITES_2: readonly MutationSpec[] = [
  // The compiled engines under services/gateway/dist
  {
    check: SUITES,
    target: "a door that refuses ends the request",
    assertion: "a door that says NO ends the walk instead of handing the caller to the next door",
    subject: "services/gateway/src/identity.ts",
    find: "    if (got && \"refuse\" in got) return got;   // this door said no: stop, do not try another",
    replace: "    if (got && \"refuse\" in got) continue;   // this door said no: stop, do not try another",
    planted: "a door that refuses no longer ends the request — the walk carries on to the next " +
      "adapter, so a revoked PAT falls through to the forwarded-header door and comes back as " +
      "an unauthenticated header claim. The comment beside it still says the walk stops, which " +
      "is the whole reason this property is not visible by reading the code",
  },
  {
    check: SUITES,
    target: "redaction lets no secret through, on the real predicate",
    assertion: "the field-name rule catches every secret-shaped name it lists",
    subject: "services/gateway/src/redact.ts",
    find: "  \"password\",\n  \"key\",\n  \"credential\",",
    replace: "  \"password\",\n  \"credential\",",
    planted: "\"key\" is gone from the list of secret-shaped field names, so `key`, `api_key` and " +
      "`private_key` stop being redacted and every settings response that carries one prints " +
      "the live value straight to the page",
  },

  // The node floor, and the break-test that proves the floor check can fail
  {
    check: SUITES_TOOLING,
    target: "the node floor check fails, and fails informatively, when the floor is not met",
    assertion: "the floor check, when it fails, names the version the project REQUIRES",
    subject: "checks/node-floor.ts",
    find: "`Node ${process.version} does not meet this project's floor of ${declared} ` +",
    replace: "`Node ${process.version} does not meet this project's declared floor ` +",
    planted: "the node floor check still refuses an unsupported runtime but no longer prints the " +
      "version it wanted, so somebody on the wrong Node is told their runtime is too old and " +
      "nothing anywhere tells them what to install",
  },

  // The paths, the strictness and the lock that keep this tree buildable
  {
    check: SUITES_TOOLING,
    target: "every literal path a script or check names under scripts/ or checks/ is a file that exists, so an import, a spawn or a read cannot outlive its target",
    assertion: "a spawned path names a file that is really there",
    subject: "scripts/release.ts",
    find: "[join(root, \"scripts/gate.ts\")]",
    replace: "[join(root, \"scripts/run-gate.ts\")]",
    planted: "the release script spawns scripts/run-gate.ts, which does not exist — so the one " +
      "step that runs the whole gate before a release dies with 'cannot find module' at the " +
      "moment it is most relied on",
  },
  {
    check: SUITES_TOOLING,
    target: "the rest of scripts/ and testing/ carry zero strict errors, and none of them was reached by widening to any",
    assertion: "no error in scripts/ or testing/ was silenced by widening a type to any",
    subject: "scripts/deployment.ts",
    find: "export function errMessage(err: unknown): string {",
    // SEAMED: a widening to any, which the strict sweep reads out of any tracked line.
    replace: "export function errMessage(err: " + "any" + "): string {",
    planted: "the deployment helper's caught value is widened from `unknown` to `any`, so every " +
      "property read on it type-checks and the narrowing that made this function safe is gone " +
      "— strictness bought by an escape hatch rather than by the code being right",
  },
  {
    check: SUITES_TOOLING,
    target: "a lock regenerated from the converted tree comes back unchanged, byte for byte",
    assertion: "the committed plugins.lock.json is what regenerating it produces",
    subject: "plugins.lock.json",
    // DELIBERATE: the version and not a digest. A digest is recomputed from the tree, so a
    // spec naming one goes stale on the next release that touches the plugin — which is how
    // this row came to plant nothing. The version is what `plugin-versions --write` stamps from
    // the catalog, and it moves only when a release moves it: re-aim this row at the version
    // that release ships, and `mutation-specs-match-subjects.ts` fails the gate the day it
    // moves without being re-aimed.
    find: "    \"version\": \"0.88.0\",",
    replace: "    \"version\": \"0.88.1\",",
    planted: "the committed lock names a version the tree does not ship, so the lock describes " +
      "a plugin that does not exist and every consumer keyed on it is told it received " +
      "something it did not",
  },
  {
    check: SUITES_TOOLING,
    target: "a plugin's content identity moves with its content and not with its address",
    assertion: "the per-plugin digest is blind to the deployment's own server URL",
    subject: "services/gateway/src/package/describe.ts",
    find: "  feed(h, plugin, false);",
    replace: "  feed(h, plugin, true);",
    planted: "a plugin's content identity now takes in the server URL, so two deployments " +
      "running byte-identical code disagree about what the plugin IS — the content identity " +
      "and the per-person cache key have collapsed into one number that answers neither question",
  },

  // SQL and telemetry, read straight out of the source
  {
    check: SUITES_DATA,
    target: "an insert names as many values as it names columns",
    assertion: "a literal insert's column list and values list are the same length",
    subject: "packages/contracts/src/pat.ts",
    find: "values ($1,$2,$3,$4,$5,$6) returning id",
    // SEAMED: `insert-arity.ts` parses any insert/values pair it finds, this one included.
    replace: "values ($1,$2,$3,$4,$5) returning id",
    planted: "the one PAT insert names six columns and supplies five values, so Postgres refuses " +
      "the statement outright — and it is on a write path, where the refusal lands inside a " +
      "catch: the service starts, the door answers, and issuing a token silently stops working",
  },
  {
    check: SUITES_DATA,
    target: "one live token per purpose, on every writer of a platform access token",
    assertion: "a writer that inserts a labelled token revokes the live one of the same label first",
    subject: "packages/contracts/src/pat.ts",
    // The one mint path every caller goes through. Removing its revoke is the defect the check
    // exists for; `{ rowCount: 0 }` keeps the `replaced` count the return reads, so the file
    // still compiles and the plant is about the missing statement rather than a type error.
    find: "    const revoked = await client.query(\n" +
      "      \"update zz.pat set revoked_at = now() \" +\n" +
      "      \"where principal_id = $1 and label = $2 and label <> '' and revoked_at is null\",\n" +
      "      [args.principalId, label]);",
    replace: "    const revoked = { rowCount: 0 };",
    planted: "the one mint path inserts a labelled token without revoking the live one of the " +
      "same label, so the partial unique index refuses the insert — inside a catch, on a write " +
      "path — and a person reconnecting is told the platform failed rather than that their " +
      "reconnect could not be recorded",
  },
  {
    check: SUITES_DATA,
    target: "every tool call says which plugin it was made for",
    assertion: "an unresolved plugin stays null rather than defaulting to a name",
    subject: "services/gateway/src/tool-telemetry.ts",
    find: "plugin: plugin ?? undefined,",
    replace: "plugin: plugin ?? \"zz-core\",",
    planted: "a call whose plugin could not be resolved is now recorded as zz-core, so 'we do not " +
      "know which plugin this was' and 'this was the baseline' are the same row — every " +
      "attribution report reads as confident and a share of it is invented",
  },

  // The manifests and the names a client reads
  {
    check: SUITES_SURFACE,
    target: "the manifest can express what the standard requires, and not what it replaced",
    assertion: "a stage's `produces` is a document name, \"record\" or \"nothing\" — and nothing else",
    subject: "packages/contracts/src/index.ts",
    find: "    z.literal(\"record\"), z.literal(\"nothing\"),",
    replace: "    z.string().min(1), z.literal(\"record\"), z.literal(\"nothing\"),",
    planted: "a stage may declare `produces: \"garbage\"` — any non-empty string now validates, so " +
      "the three-valued rule that tells the platform whether a stage writes a document, a row " +
      "or nothing at all decides nothing, and a misspelt document name installs silently",
  },
  {
    check: SUITES_SURFACE,
    target: "the core door speaks noun-first, and no caller still says the old name",
    assertion: "no caller still names a tool by its pre-rename name",
    subject: "catalog/sdlc/sdlc-flow/skills/sdlc-review/SKILL.md",
    find: '`document_write(path: "<initiative>/review.md", content)`',
    // SEAMED: a pre-rename tool name in backticks, which `core-names.ts` reports anywhere.
    replace: '`write' + '_file(path: "<initiative>/review.md", content)`',
    // REDACTED: the payload is a pre-rename tool or skill name, and this repository sweeps
    // every tracked file for those, including `testing/mutation-report.json`, which `plant()`
    // writes the reconstructed string into. Seaming the source keeps the name out of this file
    // and the report still carries it whole, so `redact` base64-encodes it there.
    redact: true,
    planted: "the review skill tells the model to call a tool by its pre-rename spelling, which " +
      "no door registers any more. The model gets 'unknown tool' in the middle of the closing " +
      "stage and improvises " +
      "around a step the flow declared mandatory — nothing goes red, and the run reads as a " +
      "bad answer rather than a broken tool",
  },
  {
    check: SUITES_SURFACE,
    target: "the core door introduces itself to a client that reads nothing else, and the pointer survives",
    assertion: "the one orientation pointer names a skill that exists on disk",
    subject: "services/zz-core/src/tools/skills.ts",
    find: "how_this_works: 'skill_read(\"zz-platform\")",
    // SEAMED: the retired skill name, which `skill-renames.ts` sweeps every tracked file for.
    replace: "how_this_works: 'skill_read(\"zz-back" + "bone\")",
    // REDACTED, for the same reason as the row above: the payload is a pre-rename name, and
    // `plant()` writes the reconstructed string into the tracked report. `redact` base64-encodes
    // it there.
    redact: true,
    planted: "session_whoami points every flowless session at a skill that was renamed away and " +
      "no longer exists — so the single instruction a client which reads nothing else ever " +
      "receives leads nowhere, and the gates and the envelope go unread",
  },
  {
    check: SUITES_SURFACE,
    target: "sdlc closes on its review, gates it, and leaves its audits ungated",
    assertion: "the closing review document still carries its gate",
    subject: "catalog/sdlc/sdlc-flow/flow.json",
    find: "\"role\": \"verification\",\n      \"gate\": true,\n",
    replace: "\"role\": \"verification\",\n",
    planted: "review.md stops being a gated document, so the last thing sdlc produces — the " +
      "review a person is supposed to approve before anything ships — closes the initiative " +
      "with nobody having agreed to it",
  },
  {
    check: SUITES_SURFACE,
    target: "every skill ships from the plugin that owns it, and its commands follow with it",
    assertion: "every declared command resolves to a skill its own plugin really ships",
    subject: "catalog/zz/zz-core/flow.json",
    find: "    \"tldr\": \"zz-tldr\"",
    replace: "    \"tldr\": \"sdlc-tldr\"",
    planted: "zz-core maps its /tldr command at sdlc-tldr, a skill it does not ship and which no " +
      "longer exists anywhere. promoteCommands filters that out silently, so the command is " +
      "simply absent from the built package and nothing tells the person why",
  },
  {
    check: SUITES_SURFACE,
    target: "a renamed plugin still resolves, and the updater's copy of the map is the contract's",
    assertion: "the updater's inlined rename map agrees with @zz/contracts",
    subject: "catalog/zz/zz-access/skills/zz-update/update.ts",
    find: "const PLUGIN_ALIAS: Record<string, string> = { zz: \"zz-core\" };",
    replace: "const PLUGIN_ALIAS: Record<string, string> = { zz: \"zz-platform\" };",
    planted: "the updater's copy of the rename map sends anybody still on `zz` to `zz-platform`, " +
      "a plugin this shelf does not carry — so the one path out of a broken install installs a " +
      "name that does not resolve and leaves the person worse off than the failure it replaced",
  },

  // The tenant-info suites: the heavy end-to-end reads

  // The deck, which is two HTML files and a shell check
  {
    check: SUITES_SURFACE,
    target: "the deck chassis carries no slides and the guidebook carries all of them",
    assertion: "the manifest block travelled with the guidebook under the id the chassis looks up",
    subject: "skills/zz-deck/deck-guidebook.html",
    find: "<script id=\"housebook-manifest\"",
    replace: "<script id=\"housebook-manifest-data\"",
    planted: "the guidebook's manifest block no longer carries the id the chassis's " +
      "renderVersion() looks up, so a deck built from this pair renders its slides with no " +
      "version, no date and no provenance, and the dock that is supposed to show them is blank",
  },
];
