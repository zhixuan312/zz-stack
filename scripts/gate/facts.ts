/**
 * What the repository says about itself: the facts many checks ask for, computed once.
 *
 * These are not checks and they decide nothing. Each answers a question about this
 * repository that more than one check needs — which fields the platform stamps, which
 * skills ship, which columns the migrations leave behind, which documents a release is
 * answerable for — and every one of them was a top-level declaration sitting between two
 * checks in an 11,428-line file, reachable only by whatever happened to be below it.
 *
 * PARSED FROM SOURCE, not imported, wherever the answer lives in TypeScript. This gate must
 * run before `tsc -b` has necessarily produced any JavaScript, and a gate that needs the
 * build to pass cannot be the thing that tells you the build is broken.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { manifestPaths } from "../manifests.ts";
import { contractsSource, gatewaySource, root, sourceFiles, trackedFiles, zzCoreTools } from "./read.ts";

export const MANIFESTS = manifestPaths(root);

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. `unknown?.message` narrows to `{}`, which has no properties at all. */
function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}

/**
 * The five fields the platform stamps, from the contract that names them.
 *
 * Written out three times in this file — twice as a regex alternation and once as a string —
 * plus the envelope's own field list a fourth time. That is the same second-copy problem this
 * gate refuses everywhere else, and it could not see it: "the envelope vocabulary is defined
 * once" scans `.ts`, and this file is `.mjs`.
 */
export function ownedFields() {
  const src = contractsSource();
  const block = /export const PLATFORM_OWNED = \[([^\]]*)\]/.exec(src)?.[1] ?? "";
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

/** The platform's own skills: everything under skills/, whatever flow a team runs.
 *
 * ALL of them, and the count is deliberately not stated. This said "the three every agent can
 * load", which was true of zz-backbone, zz-kb-usage and casebox-stg-usage and stopped being true
 * when zz-distil and zz-evolve arrived — two the PLATFORM TEAM runs and a delivery agent
 * never loads, so the sentence was wrong about the number and about the audience at once.
 * Both callers want every skill in the directory, which is what this returns. */
export function platformSkills() {
  const dir = join(root, "skills");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => ({ name: e.name, path: join(dir, e.name, "SKILL.md") }));
}

/**
 * The envelope's field names, from the schema that defines them.
 *
 * Parsed from source rather than imported: this gate must run before `tsc -b` has necessarily produced any JavaScript, and a gate that needs the
 * build to pass cannot be what tells you the build is wrong.
 */
export function envelopeFields() {
  const src = contractsSource();
  const block = /export const Envelope = z\.object\(\{([\s\S]*?)\n\}\);/.exec(src)?.[1] ?? "";
  return [...block.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
}

/**
 * The columns the CURRENT schema has, as `table.column`, by replaying the migrations.
 *
 * Migrations are append-only history, so their text is not the schema: `002_comments.sql`
 * creates a `comment` table that `012_drop_comment.sql` drops, and reading the files as a
 * flat list of column declarations produces columns of tables that no longer exist. Replaying
 * them in order is the only reading that answers "what is there now".
 */
export function schemaColumns() {
  const tables = new Map<string, Set<string>>();
  const bare = (t: string): string => t.replace(/^zz\./, "");
  for (const f of sourceFiles(["services/gateway/migrations"], [".sql"])) {
    const sql = readFileSync(join(root, f), "utf8");
    for (const m of sql.matchAll(/create table (?:if not exists )?([a-z_.]+)\s*\(([\s\S]*?)\n\)/gi)) {
      // `primary key (...)`, `unique (...)` and friends match the column shape and are not
      // columns. Named rather than guessed at, because a table constraint reading as a column
      // is how a check ends up asking who writes to `primary`.
      const NOT_A_COLUMN = new Set(["primary", "unique", "foreign", "constraint", "check", "exclude"]);
      const cols = new Set([...m[2].matchAll(/^\s+([a-z_]+)\s+[a-z]/gim)]
        .map((c) => c[1]).filter((c) => !NOT_A_COLUMN.has(c)));
      tables.set(bare(m[1]), cols);
    }
    for (const m of sql.matchAll(/alter table\s+([a-z_.]+)[\s\S]*?add column (?:if not exists )?([a-z_]+)/gi)) {
      tables.get(bare(m[1]))?.add(m[2]);
    }
    for (const m of sql.matchAll(/alter table\s+([a-z_.]+)[\s\S]*?drop column (?:if exists )?([a-z_]+)/gi)) {
      tables.get(bare(m[1]))?.delete(m[2]);
    }
    for (const m of sql.matchAll(/drop table (?:if exists )?([a-z_.]+)/gi)) tables.delete(bare(m[1]));
  }
  return [...tables].flatMap(([t, cols]) => [...cols].map((c) => `${t}.${c}`));
}

/**
 * How a flow becomes a plugin and a skill becomes a command — READ FROM THE DEFINITION.
 *
 * client-package.ts is where these live, and three checks here had each retyped them. A
 * mirror of a derivation is the worst of both: it looks like the rule, so nobody re-reads
 * the real one, and it goes wrong silently the day the real one changes.
 *
 * ONE RULE IS LEFT TO LIFT. The plugin half of a command's name is still derived, so it is
 * mirrored here; the command half is not derived at all any more — each manifest declares it
 * in a `commands` map, and `declaredCommands` below reads that declaration instead.
 *
 * The bodies are lifted out of that file's source and evaluated. Source rather than dist,
 * — the gate runs before `tsc -b` has necessarily
 * produced anything — and the extraction fails loudly if the shape moves, which is the point:
 * a mirror that cannot find its original must not quietly fall back to its own copy.
 */
export const NAMING = (() => {
  try {
    // THE GATEWAY, not one file in it. The naming rules moved into package/skills.ts when
    // client-package.ts was split, and this reported that in a sentence rather than falling
    // back to a copy — which is the behaviour its own docstring above promises.
    const src = gatewaySource();
    const grab = (name: string): string => {
      const at = src.indexOf(`function ${name}(`);
      if (at < 0) throw new Error(`the gateway no longer defines ${name}()`);
      const body = src.slice(src.indexOf("{", at), src.indexOf("\n}", at) + 2);
      return body.replace(/:\s*string/g, "");          // the types, which JS has no use for
    };
    return {
      pluginName: new Function("flow", grab("pluginName").slice(1, -1)),
      error: null,
    };
  } catch (err) {
    // A SENTENCE, not a stack trace out of module scope. Three checks depend on this and each
    // reports the failure itself — an operator running the gate is told which file moved and
    // what to do, which is this file's own standard for every other failure it produces.
    return { pluginName: null, error: errMessage(err) };
  }
})();

/** What a package DECLARES its skills are typed as: skill name → the command name.
 *
 * INVERTED from the manifest, which is keyed the other way round so that JSON itself refuses
 * two skills claiming one command. The checks all arrive holding a skill and asking what it
 * is called, so they would each invert it themselves otherwise.
 *
 * A package with no manifest, or one declaring no commands, has none — and that is an
 * answer rather than a gap. A skill nobody types is a skill, and the packager ships it as
 * one; the checks below say so instead of computing a name for it. */
export function declaredCommands(pkg: CatalogPackage): Map<string, string> {
  const mf = join(pkg.dir, "flow.json");
  if (!existsSync(mf)) return new Map();
  const m = JSON.parse(readFileSync(mf, "utf8"));
  return new Map(Object.entries<string>(m.commands ?? {}).map(([cmd, skill]) => [skill, cmd]));
}

export const catalogRoot = join(root, "catalog");

/** One package under `catalog/<owner>/<flow>/` — every check that walks the catalog wants
 *  this same shape, so it is named once here rather than re-inferred at each call site. */
export interface CatalogPackage {
  owner: string;
  flow: string;
  dir: string;
  hasManifest: boolean;
}

/**
 * The catalog, once: every package as `{ owner, flow, dir, hasManifest }`, and `flows` for
 * the ones that ship a manifest.
 *
 * Sixteen checks had each written this two-level walk out again, and they agreed only by
 * luck — the same four lines, retyped, each free to drift on what counts as a package. A
 * check's SUBJECT is as much a claim as its assertion, and two checks disagreeing about
 * which packages they cover is a disagreement nobody would ever see.
 *
 * BOTH sets are needed and the difference matters. Most checks are about a flow and want
 * `flows`. The packaging checks cover a SKILLS-ONLY package, which the platform supports and
 * zz-flow-builder teaches. And one check is about the absence itself — a package whose
 * manifest is filed under the wrong name — so iterating `flows` would make it look at
 * exactly the packages that cannot fail it.
 */
export const catalogPackages: CatalogPackage[] = [];
for (const owner of readdirSync(catalogRoot)) {
  const ownerDir = join(catalogRoot, owner);
  if (!statSync(ownerDir).isDirectory()) continue;
  for (const flow of readdirSync(ownerDir)) {
    const dir = join(ownerDir, flow);
    if (!statSync(dir).isDirectory()) continue;
    catalogPackages.push({ owner, flow, dir, hasManifest: existsSync(join(dir, "flow.json")) });
  }
}
export const flows = catalogPackages.filter((p) => p.hasManifest);

/** The baseline plugin, and WHERE ITS SKILLS ARE — which is not inside its catalog entry.
 *
 * `catalog/zz/zz-core/` carries the manifest and nothing else: the baseline's skills are the
 * tree at `skills/`, beside the catalog rather than in it, because one of them is generated per
 * person and none can be read from a catalog shared by everyone. Two checks in
 * catalog-manifest.mjs need that fact — the one that asks whether a manifest names skills it
 * ships, and the one that asks whether the lock's membership matches what is on disk — and each
 * had its own literal for it. A fact spelled twice is a fact one of the two eventually gets
 * wrong, which is this file's whole reason for existing. */
export const BASELINE = "zz-core";
export const skillsDirOf = (f: CatalogPackage): string =>
  (f.flow === BASELINE ? join(root, "skills") : join(f.dir, "skills"));

export const skillsOf = (f: CatalogPackage): { name: string; path: string }[] => {
  const dir = join(f.dir, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((s) => existsSync(join(dir, s, "SKILL.md")))
    .map((s) => ({ name: s, path: join(dir, s, "SKILL.md") }));
};
/** Every skill name this repository ships, from wherever it ships them. Memoised: the walk is
 *  the same on every call and several checks want the same answer. */
let _shipped: Set<string> | null = null;
export function everyShippedSkill(): Set<string> {
  if (_shipped) return _shipped;
  _shipped = new Set();
  for (const rel of sourceFiles(["catalog", "skills", "blocks"], ["SKILL.md"])) {
    const name = /^name:\s*(.+)$/m.exec(readFileSync(join(root, rel), "utf8"))?.[1]?.trim();
    if (name) _shipped.add(name.replace(/^["']|["']$/g, ""));
  }
  return _shipped;
}


/** What `platformSurface()` derives from the registration literals — the platform's own
 *  vocabulary, read rather than hand-kept. */
interface PlatformSurface {
  served: Set<string>;
  nouns: Set<string>;
  verbs: Set<string>;
  params: Set<string>;
  foreign: Set<string>;
  occurrences: number;
  closed: number;
}

/**
 * THE PLATFORM'S NAMESPACE, DERIVED FROM THE REGISTRATION LITERALS — which tools exist, which
 * NOUNS they are registered under, and which identifiers those registrations declare as
 * arguments rather than as tools.
 *
 * WHY THIS REPLACED TWO WRITTEN-OUT LISTS. Two checks below each carried a hand-kept roster:
 * a `MANAGE` array of thirty names feeding an `OURS` regex, and a nineteen-name array of the
 * platform tools a block's skill is allowed to name. Both were copies of what `registerTool`
 * already says, and a copy of a registration is wrong from the first rename onwards — this
 * repository has renamed its whole surface twice in a fortnight, and after the second pass not
 * one of `my_credential`, `admin_`, `set_[a-z_]*credential` or `delete_[a-z_]*credential`
 * matched a tool that existed. The lists still read as coverage and enforced nothing.
 *
 * THE NOUN IS THE DERIVABLE PART. The exact names in those lists could only ever equal the set
 * of registered names, so a check comparing a name against them could never fire — the rule has
 * to be wider than "is registered" to catch anything at all. Under the noun-first shape it is:
 * a `<noun>_<verb>` name whose NOUN is one this platform registers tools under is a claim on
 * our surface, and if we do not serve it nobody does. `plugin_invented` is ours and missing;
 * `read_api_spec`, `get_platform_overview` and `create_rule_now` are blocks' and are left
 * alone, because no door here registers anything under `read`, `get` or `create`. The stems it
 * replaces (`journal_`, `okr_`, `render_`) vanish with it, and correctly so: not one of them
 * matches a tool that still exists.
 *
 * ITS LIMIT, STATED. A noun the platform has deleted outright is no longer derivable as ours,
 * so a skill still naming `render_agent_definition` would now read as a block's tool here. That
 * ground belongs to the rename checks — "a file that resolves renamed tools never matches a
 * pre-rename name" and "the core door speaks noun-first, and no caller still says the old
 * name" — which read the frozen alias maps and know what the old names were. This one is about
 * a name nobody has ever served.
 */
let SURFACE: PlatformSurface | null = null;
export function platformSurface(): PlatformSurface {
  if (SURFACE) return SURFACE;
  const served = new Set<string>();
  // zz-core asked as a SERVICE and the gateway's doors by name: zz-core's registrations are
  // spread across modules, so a list of its files goes short the moment a door is added.
  for (const { name } of zzCoreTools()) served.add(name);
  // THE GATEWAY AS A SERVICE. Its access door moved out of server.ts into access-door.ts,
  // and a list of files goes short the moment a door is added.
  for (const m of gatewaySource().matchAll(/registerTool\(\s*\n?\s*"([a-z_0-9]+)"/g)) served.add(m[1]);
  // Served by a block only to someone who cannot reach it, so it is registered nowhere here
  // and is still a real name a skill may explain. Pre-dates this derivation and survives it.
  served.add("credential_required");
  const nouns = new Set([...served].map((t: string) => t.split("_")[0]));

  // AND THE VERBS THOSE SAME REGISTRATIONS USE, for the shape this platform ABANDONED.
  // Every registered name is `<noun>_<verb>`, so the segments after the first are the verbs
  // we conjugate our own surface with — `set`, `delete`, `list`, `read`, `admin_set`. A name
  // written the other way round, `<verb>_…_<noun>` with one of OUR nouns in it, is a claim on
  // this surface in the spelling it used before the noun-first rename, and the rename moved
  // every one of them: not a single verb-first name is registered today. That is the half of
  // the namespace `claimsOurs` cannot see, and it is where the dead names actually live — the
  // two team-wide credential tools, deleted along with the shared-credential tier, were named
  // in eight places in this repository while being registered in none, and the noun-first rule
  // reads their first segment, the verb `set`, finds no tool registered under a noun by that
  // name, and calls them somebody else's. Both sets come out of the same `served`; this is one
  // derivation with two readings of it, not two derivations.
  const verbs = new Set<string>();
  for (const t of served) for (const seg of t.split("_").slice(1)) verbs.add(seg);

  // AND WHAT THOSE REGISTRATIONS CALL THEIR ARGUMENTS. `source_content` is a parameter of
  // `document_revise`, and zz-platform names it in backticks to teach an agent to pass it —
  // which is the noun `source` in call shape, and would otherwise be reported as a tool the
  // platform does not serve. A declared parameter is the same registration literal speaking;
  // reading it is the difference between a rule and an exception.
  //
  // BRACE-MATCHED, NOT PATTERNED TO A CLOSING SHAPE. Written as `([\s\S]*?)\n\s*\},?\n\s*\},`
  // this reached 22 of the 60 `inputSchema:` blocks in services/ and quietly missed the rest —
  // the SILENT SKIP this gate has been caught by before. `closed` below is counted against the
  // occurrences so a future shape change says so instead of shrinking the exclusion set.
  const params = new Set<string>();
  let occurrences = 0, closed = 0;
  for (const rel of sourceFiles(["services"], [".ts"])) {
    const src = readFileSync(join(root, rel), "utf8");
    for (const m of src.matchAll(/inputSchema:\s*\{/g)) {
      occurrences++;
      let depth = 0, i = (m.index ?? 0) + m[0].length - 1;
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) break;
      }
      if (i >= src.length) continue;   // unbalanced: counted as not closed, reported below
      closed++;
      // `name: z.` — the one shape a zod field takes, on its own line or inline with siblings.
      for (const p of src.slice(m.index, i).matchAll(/\b([a-z][a-z0-9_]*):\s*z\./g)) params.add(p[1]);
    }
  }

  // FOREIGN VOCABULARY THAT COLLIDES WITH A NOUN OF OURS, and the only thing here that is
  // written rather than derived. `tool_order` and `tool_used` are GRADER KINDS belonging to
  // `claude plugin eval`, named beside `regex` and `file_exists` in zz-plugin-report; they are
  // not tools, have never been tools, and are not this repository's to rename — so unlike the
  // rosters this derivation replaced, these two do not rot when our surface moves. They are
  // here because `tool_grant` and `tool_revoke` make `tool` a noun we register under, and for
  // no other reason. Anything that belongs to US must never be added to this set: a missing
  // tool of ours is precisely what the check exists to find.
  const FOREIGN = new Set(["tool_order", "tool_used"]);

  SURFACE = { served, nouns, verbs, params, foreign: FOREIGN, occurrences, closed };
  return SURFACE;
}

/** Does this name claim a tool on the platform's own surface? A `<noun>_<verb>` shape whose
 *  noun we register under, that is not one of our declared arguments and not foreign
 *  vocabulary. Says nothing about whether the tool exists — that is the caller's question. */
export const claimsOurs = (name: string, s: PlatformSurface): boolean =>
  name.includes("_") && s.nouns.has(name.split("_")[0]) &&
  !s.params.has(name) && !s.foreign.has(name);

/** Does this name claim a tool on the surface this platform used to have? A `<verb>_…_<noun>`
 *  name — the VERB-FIRST spelling every registration abandoned — whose verb we conjugate with
 *  and one of whose later segments is a noun we register under. Nothing this platform serves
 *  has that shape any more, so a name that does is a name nobody serves.
 *
 *  MEASURED BEFORE IT WAS WRITTEN, over the whole md surface (61 files under catalog/,
 *  marketplace/ and skills/) and every comment under scripts/gate/: it reports four
 *  occurrences, every one of them a verb-first credential name no door has registered since
 *  the shared-credential tier was deleted, and nothing else at all. `claimsOurs` over the same
 *  comments reports six and not one of them is a tool: a dropped TABLE
 *  (`platform_credential`), two telemetry string values (`skill_view`, `skill_view_disabled`),
 *  a team slug (`team_one`), a SQL constraint (`skill_kind_check`) and a deliberately invented
 *  example (`plugin_invented`). A gate check's comments are ABOUT this repository and
 *  legitimately name tables, columns, slugs and constraints under our nouns; none of them is
 *  verb-first, because that spelling only ever belonged to tools.
 *
 *  ITS LIMIT, STATED, and it is the same boundary `platformSurface` draws above. A verb we do
 *  not conjugate with (`get_my_info`, `show_document`) or a noun we do not register under in
 *  the singular (`list_skills`) does not match, and must not: those are RENAMES, they resolve
 *  through the frozen alias maps, and "every tool the spec renamed resolves through one frozen
 *  map" is the check that owns them. This one is about a name nobody serves and nothing
 *  resolves. */
export const claimsPreRename = (name: string, s: PlatformSurface): boolean => {
  const parts = name.split("_");
  return parts.length > 1 && s.verbs.has(parts[0]) && !s.params.has(name) &&
         !s.foreign.has(name) && parts.slice(1).some((seg: string) => s.nouns.has(seg));
};

/** Documents a release is answerable for: written here, and read by someone who was not
 * in the room. Discovered rather than listed — a hardcoded set is a set that silently
 * stops covering whatever gets added tomorrow.
 *
 * git-ignored paths are invisible to this by construction, since they are not part of
 * what anyone receives. */
export function ourDocs() {
  // The same set every other check reads, so "what is part of this repository" is asked once
  // and answered once. It used to run a second git query of its own — `--others --ignored
  // --directory` — for the same question, and carry a DOC_EXCLUDE list beside it whose last
  // surviving entry named `.claude/`, a directory this repository does not have. Its own
  // comment says what that is: "an exclusion for something that does not exist reads as a
  // decision and is only debris."
  const belongs = trackedFiles();
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(rel ? join(root, rel) : root, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Skill and source trees are documented by their own content checks; a run report is
        // a historical record, correct for ever, and not something a release re-dates.
        // `marketplace` is the rendered copy of `catalog` and `skills`, so it is excluded for
        // the reason they are, twice over: its documents are checked at their source, and the
        // paths inside them resolve against the PLUGIN root rather than this repository —
        // `zz-core/skills/zz-deck/deck-chassis.html` is a real path in the shipped plugin and
        // has never been one here.
        if (["catalog", "skills", "services", "packages", "testing", "marketplace"].includes(r)) continue;
        walk(r);
      } else if (e.name.endsWith(".md") && (!belongs || belongs.has(r))) {
        out.push(r);
      }
    }
  };
  walk("");
  return out.sort();
}

/* TWO CHECKS THAT EXISTED AND NOTHING RAN.
 *
 * `check:redaction` drives the real `redact()` and `looksSecret` — eight response shapes,
 * proving no credential value, password verifier or stored token survives redaction anywhere
 * in a structure, that a field nobody has named yet is still caught, and that the marker
 * cannot be used to reconstruct what it replaced. `check:scope` drives the real
 * `resolveScope`, `teamAuthority` and `superOnly` — nineteen cases, proving scope is never
 * unscoped, platform scope never reaches a non-superadmin, and a team admin never reaches
 * another team.
 *
 * Both are about authorisation and secrets. Both were written, both pass, and neither the
 * gate nor the release ever invoked them: their npm scripts existed and nothing called those
 * either. Every reference to them in the source is a COMMENT saying they drive the real
 * predicate — which was true, and describes a thing that never happened.
 *
 * They belong here rather than beside markdown-check and identity-check by accident of where
 * they were written; what matters is that all four now run. Neither needs a database, a
 * network or an environment variable, which is why they can. */

/* THE PURE DOCUMENT RULES, EXERCISED — and the reason zz-core was split.
 *
 * Twelve predicates over a document and its envelope lived inside a 6,114-line `server.ts`
 * where nothing could import them, so nothing could call them, so every claim about them was a
 * claim about how the source reads. They are in their own module now and this runs them.
 *
 * Writing it corrected four of my own expectations, which is the return on the split arriving
 * immediately: `renderEnvelope`'s `order` argument is not a filter — a field outside it is
 * still written, at the end — and `decisionRows` reads a BLOCK FIT ledger
 * (native/achievable/workaround/not_possible), not whether an acceptance criterion is met. Both
 * are reasonable and neither is what the names suggest. */
/* THE WRITE GUARDS, EXERCISED — the refusals that protect the store.
 *
 * Same argument as the rules beside them, one layer up: these decide whether a write lands,
 * they are pure functions of a chain and a document's text, and until they were their own
 * module nothing could call one.
 *
 * Writing this pinned a rule stronger than the one I expected: `approved_by` and `approved_at`
 * are ATOMIC on a gated document. A signer with no date is refused — half a signature is the
 * shape that reads as signed and cannot be dated. */

/** THE ENTRY POINTS UNDER packages/tools, and the parts they are built from.
 *
 * Everything in `testing/` and `ops/` used to be treated as a runnable tool: it must have a
 * `main()` returning a status, and the README must name it. Both rules are right ABOUT AN
 * ENGINE, and neither is true of a module an engine imports — a part has no exit status to get
 * wrong and no operator looking for it by name.
 *
 * chain-check is the case that made this matter. It walks the document chain and, since the bug
 * tracker arrived, a tracker too; those are two subjects, the file passed 700 lines holding
 * both, and splitting it by subject produced `chain-bugs.ts` — which is not a tool anybody runs.
 *
 * AN ENGINE IS WHAT NOTHING IMPORTS. Asked that way round rather than by looking for `main()`,
 * because "has a main()" is the very property one of these rules exists to enforce: a file that
 * lost its main() would stop being counted as an engine and the rule would go quiet exactly
 * when it should fire.
 */
export function toolEntryPoints(dir: string): string[] {
  const all = sourceFiles([dir], [".ts"]);
  const imported = new Set();
  for (const rel of all) {
    const src = readFileSync(join(root, rel), "utf8");
    for (const m of src.matchAll(/^import\s[^"']*["']\.\/([\w.-]+)\.js["']/gm)) {
      imported.add(`${dir}/${m[1]}.ts`);
    }
  }
  return all.filter((f) => !imported.has(f));
}
