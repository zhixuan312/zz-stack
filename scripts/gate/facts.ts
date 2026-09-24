/**
 * What the repository says about itself: the facts many checks ask for, computed once.
 *
 * These are not checks and they decide nothing. Each answers a question about this
 * repository that more than one check needs — which fields the platform stamps, which
 * skills ship, which columns the migrations leave behind, which documents a release is
 * answerable for.
 *
 * Parsed from source, not imported, wherever the answer lives in TypeScript: this gate runs
 * before `tsc -b` has necessarily produced any JavaScript.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { manifestPaths } from "../manifests.ts";
import { contractsSource, gatewaySource, root, sourceFiles, trackedFiles, zzCoreTools } from "./read.ts";

export const MANIFESTS = manifestPaths(root);

/** A caught value is never typed as an Error — narrow the shape actually being read.
 *  `unknown?.message` narrows to `{}`, which has no properties at all. */
function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}

/**
 * The fields the platform stamps, from the contract that names them.
 */
export function ownedFields() {
  const src = contractsSource();
  const block = /export const PLATFORM_OWNED = \[([^\]]*)\]/.exec(src)?.[1] ?? "";
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

/** The platform's own skills: every directory under skills/ holding a SKILL.md, whatever flow
 *  a team runs. Both callers want all of them, so no count is stated. */
export function platformSkills() {
  const dir = join(root, "skills");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => ({ name: e.name, path: join(dir, e.name, "SKILL.md") }));
}

/**
 * The envelope's field names, from the schema that defines them.
 *
 * Parsed from source rather than imported: this gate runs before `tsc -b` has necessarily
 * produced any JavaScript.
 */
export function envelopeFields() {
  const src = contractsSource();
  const block = /export const Envelope = z\.object\(\{([\s\S]*?)\n\}\);/.exec(src)?.[1] ?? "";
  return [...block.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
}

/**
 * The columns the current schema has, as `table.column`, by replaying the migrations.
 *
 * Migrations are append-only history, so their text is not the schema: a table one file
 * creates a later one drops, and reading the files as a flat list of column declarations
 * produces columns of tables that no longer exist. Replaying them in order answers "what is
 * there now".
 */
export function schemaColumns() {
  const tables = new Map<string, Set<string>>();
  const bare = (t: string): string => t.replace(/^zz\./, "");
  for (const f of sourceFiles(["services/gateway/migrations"], [".sql"])) {
    const sql = readFileSync(join(root, f), "utf8");
    for (const m of sql.matchAll(/create table (?:if not exists )?([a-z_.]+)\s*\(([\s\S]*?)\n\)/gi)) {
      // `primary key (...)`, `unique (...)` and friends match the column shape and are not
      // columns.
      //
      // Folded to lower case because the pattern above is case-insensitive: `001_init.sql` is
      // a pg_dump and writes `    CONSTRAINT x CHECK (...)` in capitals.
      const NOT_A_COLUMN = new Set(["primary", "unique", "foreign", "constraint", "check", "exclude"]);
      const cols = new Set([...m[2].matchAll(/^\s+([a-z_]+)\s+[a-z]/gim)]
        .map((c) => c[1]).filter((c) => !NOT_A_COLUMN.has(c.toLowerCase())));
      tables.set(bare(m[1]), cols);
    }
    // One statement at a time, and every clause in it: the statement is bounded at its
    // semicolon first, then every add and drop inside it is applied, so a statement adding
    // several columns at once is read whole.
    //
    // The bound is textual: a `;` inside a string literal in an ALTER TABLE would cut the
    // statement early.
    for (const stmt of sql.matchAll(/alter table\s+(?:only\s+)?([a-z_.]+)([\s\S]*?);/gi)) {
      const cols = tables.get(bare(stmt[1]));
      if (!cols) continue;
      for (const a of stmt[2].matchAll(/add column (?:if not exists )?([a-z_]+)/gi)) cols.add(a[1]);
      for (const d of stmt[2].matchAll(/drop column (?:if exists )?([a-z_]+)/gi)) cols.delete(d[1]);
    }
    for (const m of sql.matchAll(/drop table (?:if exists )?([a-z_.]+)/gi)) tables.delete(bare(m[1]));
  }
  return [...tables].flatMap(([t, cols]) => [...cols].map((c) => `${t}.${c}`));
}

/**
 * How a flow becomes a plugin and a skill becomes a command — read from the definition.
 *
 * @zz/catalog is where the rule lives. The plugin half of a command's name is derived, so it
 * is mirrored here; the command half is declared, each manifest naming it in a `commands`
 * map that `declaredCommands` below reads instead.
 *
 * The body is lifted out of the catalog package's source and evaluated — source rather than
 * dist, because the gate runs before `tsc -b` has necessarily produced anything. Extraction
 * fails loudly if the shape moves rather than falling back to a copy.
 */
export const NAMING = (() => {
  try {
    // The catalog package, which every reader of the rule imports it from.
    const src = readFileSync(join(root, "packages/catalog/src/index.ts"), "utf8");
    const grab = (name: string): string => {
      const at = src.indexOf(`function ${name}(`);
      if (at < 0) throw new Error(`@zz/catalog no longer defines ${name}()`);
      const body = src.slice(src.indexOf("{", at), src.indexOf("\n}", at) + 2);
      return body.replace(/:\s*string/g, "");          // the types, which JS has no use for
    };
    return {
      pluginName: new Function("flow", grab("pluginName").slice(1, -1)),
      error: null,
    };
  } catch (err) {
    // A sentence, not a stack trace out of module scope: three checks depend on this and each
    // reports the failure itself, naming the file that moved.
    return { pluginName: null, error: errMessage(err) };
  }
})();

/** What a package declares its skills are typed as: skill name → the command name.
 *
 * Inverted from the manifest, which is keyed the other way round so that JSON itself refuses
 * two skills claiming one command.
 *
 * A package with no manifest, or one declaring no commands, has none — an answer rather than
 * a gap. A skill nobody types is still a skill and the packager ships it as one. */
export function declaredCommands(pkg: CatalogPackage): Map<string, string> {
  const mf = join(pkg.dir, "flow.json");
  if (!existsSync(mf)) return new Map();
  const m = JSON.parse(readFileSync(mf, "utf8"));
  return new Map(Object.entries<string>(m.commands ?? {}).map(([cmd, skill]) => [skill, cmd]));
}

export const catalogRoot = join(root, "catalog");

/** One package under `catalog/<owner>/<flow>/`. */
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
 * Both sets are needed. Most checks are about a flow and want `flows`; the packaging checks
 * cover a skills-only package, which the platform supports; and one check is about the
 * absence itself — a package whose manifest is filed under the wrong name — so iterating
 * `flows` would make it look at exactly the packages that cannot fail it.
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

/** The baseline plugin, and where its skills are — which is not inside its catalog entry.
 *
 * `catalog/zz/zz-core/` carries the manifest and nothing else: the baseline's skills are the
 * tree at `skills/`, beside the catalog rather than in it, because one of them is generated
 * per person and none can be read from a catalog shared by everyone. */
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
/** Every skill name this repository ships, from wherever it ships them. Memoised. */
let _shipped: Set<string> | null = null;
export function everyShippedSkill(): Set<string> {
  if (_shipped) return _shipped;
  _shipped = new Set();
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
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
 * The platform's namespace, derived from the registration literals — which tools exist, which
 * nouns they are registered under, and which identifiers those registrations declare as
 * arguments rather than as tools.
 *
 * The noun is the derivable part: a `<noun>_<verb>` name whose noun this platform registers
 * tools under is a claim on our surface, and if we do not serve it nobody does.
 * `plugin_invented` is ours and missing; `read_api_spec`, `get_platform_overview` and
 * `create_rule_now` are another server's and are left alone, because no door here registers anything
 * under `read`, `get` or `create`.
 *
 * Its limit: a noun the platform has deleted outright is no longer derivable as ours, so a
 * skill still naming one reads as another server's tool here. That ground
 * belongs to the rename checks, which read the frozen alias maps. This one is about a name
 * nobody has ever served.
 */
let SURFACE: PlatformSurface | null = null;
export function platformSurface(): PlatformSurface {
  if (SURFACE) return SURFACE;
  const served = new Set<string>();
  // zz-core asked as a service: its registrations are spread across modules, so a list of its
  // files goes short the moment a door is added.
  for (const { name } of zzCoreTools()) served.add(name);
  // The gateway as a service, for the same reason.
  for (const m of gatewaySource().matchAll(/registerTool\(\s*\n?\s*"([a-z_0-9]+)"/g)) served.add(m[1]);
  const nouns = new Set([...served].map((t: string) => t.split("_")[0]));

  // And the verbs those same registrations use, for the shape this platform abandoned. Every
  // registered name is `<noun>_<verb>`, so the segments after the first are the verbs we
  // conjugate our own surface with — `set`, `delete`, `list`, `read`, `admin_set`. A name
  // written the other way round, `<verb>_…_<noun>` with one of our nouns in it, is a claim on
  // this surface in the spelling it used before the noun-first rename; nothing registered
  // today has that shape. That is the half of the namespace `claimsOurs` cannot see. Both sets
  // come out of the same `served`.
  const verbs = new Set<string>();
  for (const t of served) for (const seg of t.split("_").slice(1)) verbs.add(seg);

  // And what those registrations call their arguments. `source_content` is a parameter of
  // `document_revise` and is named in backticks by zz-platform — which reads as the noun
  // `source` in call shape, and would otherwise be reported as a tool the platform does not
  // serve.
  //
  // Brace-matched rather than patterned to a closing shape, which reaches only some of the
  // `inputSchema:` blocks under services/. `closed` below is counted against the occurrences
  // so a future shape change says so instead of shrinking the exclusion set.
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

  // Foreign vocabulary that collides with a noun of ours, and the only thing here that is
  // written rather than derived. `tool_order` and `tool_used` are grader kinds belonging to
  // `claude plugin eval`; they are not tools and are not this repository's to rename, so they
  // must never read as ours.
  //
  // DELIBERATE: nothing of ours goes in this set — a missing tool of ours is what the check
  // exists to find.
  const FOREIGN = new Set(["tool_order", "tool_used"]);

  SURFACE = { served, nouns, verbs, params, foreign: FOREIGN, occurrences, closed };
  return SURFACE;
}

/** Does this name claim a tool on the platform's own surface? A `<noun>_<verb>` shape whose
 *  noun we register under, that is not one of our declared arguments and not foreign
 *  vocabulary. Says nothing about whether the tool exists. */
export const claimsOurs = (name: string, s: PlatformSurface): boolean =>
  name.includes("_") && s.nouns.has(name.split("_")[0]) &&
  !s.params.has(name) && !s.foreign.has(name);

/** Does this name claim a tool on the surface this platform used to have? A `<verb>_…_<noun>`
 *  name — the verb-first spelling every registration abandoned — whose verb we conjugate with
 *  and one of whose later segments is a noun we register under. Nothing this platform serves
 *  has that shape, so a name that does is a name nobody serves.
 *
 *  Its limit is the same boundary `platformSurface` draws above. A verb we do not conjugate
 *  with (`get_my_info`, `show_document`) or a noun we do not register under in the singular
 *  (`list_skills`) does not match: those are renames, they resolve through the frozen alias
 *  maps, and a different check owns them. */
export const claimsPreRename = (name: string, s: PlatformSurface): boolean => {
  const parts = name.split("_");
  return parts.length > 1 && s.verbs.has(parts[0]) && !s.params.has(name) &&
         !s.foreign.has(name) && parts.slice(1).some((seg: string) => s.nouns.has(seg));
};

/** Documents a release is answerable for, discovered rather than listed.
 *
 * git-ignored paths are invisible to this by construction, since they are not part of
 * what anyone receives. */
export function ourDocs() {
  // The same set every other check reads, so "what is part of this repository" is asked once
  // and answered once.
  const belongs = trackedFiles();
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(rel ? join(root, rel) : root, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Skill and source trees are documented by their own content checks; a run report is
        // a historical record and not something a release re-dates. `marketplace` is the
        // rendered copy of `catalog` and `skills`: its documents are checked at their source,
        // and the paths inside them resolve against the plugin root rather than this
        // repository.
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

/** The entry points under packages/tools, and the parts they are built from.
 *
 * A tool must have a `main()` returning a status and be named in the README; a module an
 * engine imports has neither and is not held to either rule.
 *
 * An engine is what nothing imports. Asked that way round rather than by looking for `main()`,
 * because a file that lost its main() would stop being counted as an engine and the rule that
 * requires one would go quiet exactly when it should fire.
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
