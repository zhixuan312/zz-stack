/**
 * Defects planted for the third batch of `scripts/gate/checks/suites.ts`'s registered checks.
 *
 * SUITES.TS TESTS NOTHING ITSELF. Every row here names `suites.ts` as its `check` because that
 * is the file registering the check, but the rule being measured lives in a standalone script
 * at the repository root under `checks/`, which `runsCheck` spawns and fails on a non-zero
 * exit. So each spec's real subject is whatever THAT script reads: a source module, a lock
 * file, a manifest, a skill's frontmatter, a tsconfig.
 *
 * WHICH IS WHY EVERY ROW CARRIES AN `assertion`. This one file ends up with the great majority
 * of the gate's rows, and a table of ninety-odd lines all reading
 * `scripts/gate/checks/suites.ts` tells a reader nothing about what was actually broken. The
 * assertion is the sentence that distinguishes them.
 *
 * THE DEFECT GOES IN THE DATA, NOT IN THE JUDGE. `checks/*.ts` is not frozen the way
 * `scripts/gate/` is, so a spec could break the script rather than the thing it judges — and
 * that would measure the wrong object. Every row below plants in what the script READS. The
 * one exception is deliberate and says so: the registry check's subject IS a file under
 * `checks/`, because what that check judges is the contents of that directory.
 */
import type { MutationSpec } from "./plant.ts";

const SUITES = "scripts/gate/checks/suites.ts";

export const COV_SUITES_3: readonly MutationSpec[] = [
  {
    check: SUITES,
    target: "the record knows whether a document was fetched before its gate",
    assertion: "a patch counts as a content change, so a fetch before it vouches for nothing",
    subject: "services/zz-core/src/attest.ts",
    find: 'const CHANGED = new Set(["document_write", "document_patch", "document_revise"]);',
    replace: 'const CHANGED = new Set(["document_write", "document_revise"]);',
    planted: "filling a scaffold with document_patch stops counting as the document changing, " +
      "so a document shown once at v1, patched eight times and then approved is recorded as " +
      "having been put in front of the person who approved it — which is the one shape this " +
      "function exists to catch, because a patch does not bump the version either",
  },
  {
    check: SUITES,
    target: "the version that shipped has a changelog section of its own",
    assertion: "a tagged release has a section under its own version, not under Unreleased",
    subject: "CHANGELOG.md",
    find: "## [0.62.4]",
    replace: "## [Unreleased]",
    planted: "the version that is tagged, shipped and deployed keeps its entry under " +
      "`## [Unreleased]`, exactly as 0.25.0 did — the next release then writes its own " +
      "sections beside it and nobody reading the changelog can tell which release changed what",
  },
  {
    check: SUITES,
    target: "the tooling project runs standalone through typecheck:tooling, is deliberately " +
      "absent from tsc -b's reference graph, and inherits its strictness rather than " +
      "softening it locally",
    assertion: "the tooling project may not re-declare an inherited strictness flag",
    subject: "tsconfig.tooling.json",
    find: '    "types": ["node"]\n',
    replace: '    "types": ["node"],\n    "noUnusedLocals": false\n',
    planted: "the tooling project turns off noUnusedLocals locally instead of inheriting the " +
      "base's strictness — the error count drops, the conversion looks finished, and dead " +
      "locals and unused imports across scripts/, checks/ and testing/ stop being reported at all",
  },
  {
    check: SUITES,
    target: "every entry point a human types — an npm script, a deploy script — names the .ts " +
      "file that exists, not the .mjs file that no longer does",
    assertion: "an npm script may not name a .mjs entry point the rename deleted",
    subject: "package.json",
    find: '"rollback": "node scripts/release.ts --rollback"',
    // SEAMED. The payload is a tooling path that deliberately does not exist, which is what
    // `checks/literal-paths-resolve.ts` hunts for. Its own rule declines this one — the path is
    // not quote-delimited on both sides, and it sits inside an outer unclosed quote, either of
    // which exempts it — but a payload whose whole point is an absent path is not worth leaving
    // to a rule's two exemptions holding.
    replace: '"rollback": "node scripts/release.mj' + 's --rollback"',
    planted: "`npm run rollback` points at a .mjs file the TypeScript conversion removed, so " +
      "the one command somebody types when a release has gone wrong fails with a module-not-" +
      "found the moment they need it, and no import graph anywhere would have noticed",
  },
  {
    check: SUITES,
    target: "the five shipped skill scripts carry zero strict errors, every construct in them " +
      "is erasable, and none was reached by widening to any",
    assertion: "a shipped skill script may not reach zero errors by widening to any",
    subject: "catalog/zz/zz-access/skills/zz-doctor/doctor.ts",
    find: "const readable = (p: string): string | null => {",
    // SEAMED. The strict sweeps read every tracked file under scripts/, and a payload quoting
    // a widened type reads to them as a widened type — this file would turn that check red at
    // baseline and every row in the batch would come back against an already-red target.
    replace: "const readable = (p: string): an" + "y => {",
    planted: "zz-doctor's file reader is widened to `any`, so every value it returns stops " +
      "being checked — the token read off disk, the installed plugin's config — and the " +
      "\"zero strict errors\" this script ships with is bought by switching the checking off " +
      "rather than by making it true",
  },
  {
    check: SUITES,
    target: "the whole tooling project carries zero strict errors, measured as one project " +
      "rather than subtree by subtree",
    assertion: "a strict error anywhere in the tooling project is reported, not just per subtree",
    subject: "scripts/skill-versions.ts",
    find: 'const major = (v: string | undefined) => String(v ?? "").split(".")[0];',
    replace: "const major = (v: string | undefined) => v.split(\".\")[0];",
    planted: "the version comparison drops the guard around a version that may be absent, so a " +
      "skill with no recorded version throws instead of comparing — and the tooling project " +
      "carries a strict error again, which is the state the conversion was declared finished from",
  },
  {
    check: SUITES,
    target: "every tool the spec renamed resolves through one frozen map",
    assertion: "a deleted tool takes no alias entry",
    subject: "packages/contracts/src/alias.ts",
    find: '  issue_pat: "pat_issue",\n',
    replace: '  issue_pat: "pat_issue",\n  issue_my_access_token: "pat_issue",\n',
    planted: "a tool that was DELETED is aliased onto the tool that replaced its neighbour, so " +
      "two distinct series of calls merge under one name — every historical " +
      "`issue_my_access_token` is read back as if it had been a `pat_issue`, which is the one " +
      "thing a rename map must never do to a deletion",
  },
  {
    check: SUITES,
    target: "a query binds as many parameters as its statement names",
    assertion: "a statement that stops naming a placeholder its caller still binds is caught",
    subject: "services/zz-core/src/tools/bugs.ts",
    find: "`update zz.bug set status = $2, resolution = $3, resolved_by = $4, resolved_at = now()",
    replace: "`update zz.bug set status = $2, resolution = $3, resolved_by = current_user, resolved_at = now()",
    planted: "bug_resolve's statement stops naming `$4` while its caller still passes four " +
      "values, so postgres rejects the bind and closing a bug report throws for every " +
      "operator — the exact shape that shipped green through tsc, the gate and the dry run once " +
      "already, because nothing offline reads SQL inside a template literal",
  },
  {
    check: SUITES,
    target: "what a call cost is a column, and detail keeps no second copy",
    assertion: "an unmeasured run's byte total stays null rather than being coalesced to zero",
    subject: "services/gateway/src/runs.ts",
    find: "sum(e.response_bytes)",
    replace: "coalesce(sum(e.response_bytes), 0)",
    all: true,
    planted: "both run rollups coalesce an unmeasured byte total back to 0, so a run whose " +
      "calls were never measured is indistinguishable from a run that transferred nothing — " +
      "the confident zero migration 051 exists to remove, back in both directions",
  },
  {
    check: SUITES,
    target: "a command is what a manifest declares, not what a function derives from a skill name",
    assertion: "the literal \"flow\" fallback stays deleted, not merely unused",
    subject: "services/gateway/src/client-package.ts",
    find: "const entryCmd = entryCommand(f.flow, f.entry || f.flow);",
    replace: 'const entryCmd = f.entry ? entryCommand(f.flow, f.entry) : "flow";',
    planted: "a flow whose manifest names no entry skill falls back to the literal string " +
      "\"flow\" instead of the command the manifest declares, so the packaged client offers a " +
      "command nobody wrote down and zz-router is told the front door is called something it " +
      "is not",
  },
  {
    check: SUITES,
    target: "a revision names its cause — one route or the other, never neither and never both",
    assertion: "words passed as source_content are a cause on their own",
    subject: "services/zz-core/src/tools/initiative-acts.ts",
    find: "      if (!causes.length) {",
    replace: '      if (!causes.includes("sources")) {',
    planted: "document_revise starts demanding a source already on the record, so the other " +
      "half of the rule dies quietly: a wording fix that says in one line what was wrong is " +
      "refused, and the refusal still tells the caller to send `source_content`, which the " +
      "tool now ignores",
  },
  {
    check: SUITES,
    target: "opening is explicit and dated by the platform, and freeform gets no next move",
    assertion: "a stage that evidences itself with a source is walked like any other stage",
    subject: "services/zz-core/src/tools/initiative-status.ts",
    find: "      .filter((a) => !sourcesSupport(dir, a.document));",
    replace: "      .filter((a) => sourcesSupport(dir, a.document));",
    planted: "an audit stage counts as owed only once it has already been done, so the next " +
      "move never names it — which is the shape the walk had before it read the manifest's " +
      "stages at all: the platform answered `write plan.md` the moment the spec was approved, " +
      "and the close then refused for a round nothing had told the agent to run",
  },
  {
    check: SUITES,
    target: "opening is explicit and dated by the platform, and freeform gets no next move",
    assertion: "a freeform initiative is given no next move at all",
    subject: "services/zz-core/src/tools/initiative-status.ts",
    find: "        : null,",
    replace: '        : { action: "declare_flow", waiting_on: "the team",\n' +
      '            why: "no flow governs this initiative — pass `flow` to document_write on " +\n' +
      '                 "the first document" },',
    planted: "an initiative somebody assembled by hand is told to declare a flow, which is the " +
      "instruction FR-30 removed: a flow cannot be adopted after an initiative exists, so the " +
      "platform is naming a next stage it invented and pointing the caller at a door that no " +
      "longer opens",
  },
  {
    check: SUITES,
    target: "the evaluation modules are on the evaluation side, and attest stays on the core one",
    assertion: "only the evaluation side and its door reach into the evaluation modules",
    subject: "services/zz-core/src/tools/initiative-acts.ts",
    find: 'import { shownSinceLastChange } from "../attest.js";',
    replace: 'import { shownSinceLastChange } from "../attest.js";\n' +
      'import { SUBJECT_CAP } from "../eval/judge.js";\nvoid SUBJECT_CAP;',
    planted: "a core document tool reaches into the evaluation flow's judge, so one flow's " +
      "judging machinery is loaded into every account's core door — and the directory the core " +
      "surface is scanned out of starts importing the modules that were moved off it",
  },
  {
    check: SUITES,
    target: "the two misnamed core skills are renamed, every caller moved, and an old step " +
      "still resolves",
    assertion: "the renamed skill declares its new name in its own frontmatter",
    subject: "skills/zz-platform/SKILL.md",
    find: "name: zz-platform",
    // SEAMED, and the prose below is worded around the old name rather than quoting it: the
    // rename sweep reads every tracked file under scripts/ and cannot tell a spec quoting a
    // dead skill name from a caller still using one.
    replace: "name: zz-back" + "bone",
    // REDACTED. The payload is a pre-rename tool or skill name, and this repository sweeps
    // every tracked file for those — including `testing/mutation-report.json`, which `plant()`
    // writes the RECONSTRUCTED string into. Seaming the source is not enough: the seam keeps
    // the name out of THIS file and the report still carries it whole. `redact` base64-encodes
    // it there, so the experiment stays exactly reproducible and neither file is the finding.
    redact: true,
    planted: "the platform skill announces itself under its pre-rename name again, in the " +
      "frontmatter skill_read resolves by, so the rename is a directory that moved and a name " +
      "that did not — every caller asking for zz-platform gets a skill that says it is " +
      "something else",
  },
  {
    check: SUITES,
    target: "tenant-info's workspace and suite guards refuse what they say they refuse, and " +
      "its CLI carries no import-time side effects",
    assertion: "a workspace that reaches the checkout through a symlink is still refused",
    subject: "scripts/tenant-info/workspace.ts",
    find: "  if (isInside(real, repoRoot)) {",
    replace: "  if (isInside(raw, repoRoot)) {",
    planted: "the workspace guard tests the path as typed instead of the path it resolves to, " +
      "so a symlink pointing into this checkout walks straight past it — and tenant-info " +
      "writes its suite output on top of the repository holding 38 initiatives and 527 live " +
      "documents, which is the one thing the required workspace exists to make impossible",
  },
  {
    check: SUITES,
    target: "the PostgreSQL 17 lock, Dockerfile and config agree on the pinned major/patch, " +
      "base digest, pg_textsearch release and actual preload membership",
    assertion: "the lock's pinned patch is the patch the Dockerfile actually builds",
    subject: "deploy/postgres/versions.lock.json",
    find: '  "postgres_version": "17.11",',
    replace: '  "postgres_version": "17.12",',
    planted: "the lock claims a PostgreSQL patch the Dockerfile does not build, so the file " +
      "that is supposed to say which bytes run says one thing and the image says another — " +
      "the drift these two files are cross-checked against each other to make impossible",
  },
  {
    check: SUITES,
    target: "a mutation request hashes canonically regardless of key order, changes with its " +
      "payload or expected_etag, and a commit outcome classifies to true/false/unknown " +
      "exactly as the spec's publication/durability table says",
    assertion: "published-but-not-durable classifies as unknown, never as committed",
    subject: "services/zz-core/src/tenant-info/mutations.ts",
    find: '  if (signal.publication === "published" && signal.durable) return true;',
    replace: '  if (signal.publication === "published") return true;',
    planted: "a commit that was published but is not yet durable is reported as committed " +
      "instead of unknown, so a caller stops retrying and the record stops being re-checked " +
      "for a write that may not have survived — the one cell of the publication/durability " +
      "table where guessing loses data",
  },
  {
    check: SUITES,
    target: "an OKF round trip through the real YAML parser keeps unknown keys, never turns " +
      "verified_against into a fabricated verification event, and OKF conformance and " +
      "native-profile validation report separate verdicts",
    assertion: "verified_against is never turned into a verification event",
    subject: "services/zz-core/src/tenant-info/export.ts",
    find: "  return { ...normalized, zz_profile: profile, body: bodyText };",
    replace: '  if (typeof normalized.verified_against === "string" && normalized.verified === undefined) {\n' +
      "    normalized.verified = [{ subject_version: normalized.verified_against }];\n  }\n" +
      "  return { ...normalized, zz_profile: profile, body: bodyText };",
    planted: "a version string a foreign tool wrote is read back as a verification this " +
      "platform performed, so importing somebody else's knowledge manufactures evidence that " +
      "a claim was checked — nobody checked it, and the record now says otherwise",
  },
  {
    check: SUITES,
    target: "zz-lexical-v2 handles empty text, CRLF, a forced long-token split with no " +
      "whitespace to prefer, a full 1-MiB mixed-language body and a phrase at a passage " +
      "boundary, and the 8-MiB kernel gate refuses new input while preserving legacy larger " +
      "content",
    assertion: "passages overlap, so a phrase at a boundary is still found whole",
    subject: "packages/indexing/src/tenant-analysis.ts",
    find: "export const PASSAGE_OVERLAP_SCALARS = 512;",
    replace: "export const PASSAGE_OVERLAP_SCALARS = 0;",
    planted: "passages stop overlapping, so any phrase that straddles a passage boundary is " +
      "split across two and appears whole in neither — it is indexed and unfindable, and " +
      "which phrases those are depends on nothing but how long the document happens to be",
  },
  {
    check: SUITES,
    target: "lane budgets are fixed functions of the limit that refuse a non-integer or " +
      "out-of-range value, RRF sums each lane's max-over-corpora contribution in a fixed lane " +
      "order regardless of input order, and result-key identity is owner-qualified with " +
      "history alone carrying revision/hash",
    assertion: "a non-integer or NaN limit is refused rather than budgeted",
    subject: "services/zz-core/src/tenant-info/retrieval.ts",
    find: "  if (!Number.isInteger(L) || L < 1 || L > 50) {",
    replace: "  if (L < 1 || L > 50) {",
    planted: "a fractional or NaN limit is accepted, so every lane budget is computed from it " +
      "— a NaN limit passes both bounds and hands each lane a NaN budget, which retrieves " +
      "nothing and reports no error at all",
  },
  {
    check: SUITES,
    target: "new artifact text over 8 MiB is refused through the real adapter with " +
      "PAYLOAD_TOO_LARGE, the stored content is untouched, and an under-limit write still commits",
    assertion: "a new write is measured against the limit, not exempted as legacy",
    subject: "services/zz-core/src/tenant-info/policies.ts",
    find: '    assertWithinInputLimit(Buffer.byteLength(canonicalJson(canonical), "utf8"));',
    replace: '    assertWithinInputLimit(Buffer.byteLength(canonicalJson(canonical), "utf8"), { imported: true });',
    planted: "every new write claims the migration's legacy exemption, so the 8-MiB kernel " +
      "gate refuses nothing and PAYLOAD_TOO_LARGE is never emitted — the limit is still " +
      "written down, still exported and still tested in isolation, and no write passes through it",
  },
  {
    check: SUITES,
    target: "the acceptance decision needs all thirteen criteria, the spec's own method for " +
      "each, a matching binding, verified evidence and a gate that actually executed — and a " +
      "wholly failed report is still structurally valid",
    assertion: "a criterion must be proved by the method the approved spec names for it",
    subject: "scripts/tenant-info/verify.ts",
    find: "    if (record.method !== method) {",
    replace: "    if (record.method !== method && record.method === undefined) {",
    planted: "a criterion may claim any method it likes as long as it claims one, so a " +
      "decision the spec says a person has to make is accepted as proved by a command — the " +
      "acceptance report then reads as ready with a human judgement nobody made",
  },
  {
    /* THE ONE ROW WHOSE SUBJECT IS A FILE UNDER `checks/`, and it is not an exception to the
     * rule that the defect goes in the data. What this check judges IS the contents of that
     * directory: which files are there, and what each of them does. So a check file is the
     * data here, and this plants in the property the classifier reads rather than in the
     * classifier. */
    check: SUITES,
    target: "every check in checks/ is registered here, or named here with a reason",
    assertion: "a check that reaches a deployment is still recognised as host-dependent",
    subject: "checks/returns-sees-a-backtrack.ts",
    find: 'const psql = (sql: string) => execFileSync("ssh", ["-o", "ConnectTimeout=30", "zz-stack",',
    replace: 'const REMOTE = "ssh";\nconst psql = (sql: string) => execFileSync(REMOTE, ["-o", "ConnectTimeout=30", "zz-stack",',
    planted: "the one check that reaches the live database hoists its spawner's name into a " +
      "constant, so nothing classifies it as host-dependent any more — it reads as an " +
      "ordinary offline check that nothing runs, which is the state every unwired check in " +
      "this directory was in before the registry rule existed",
  },
];
