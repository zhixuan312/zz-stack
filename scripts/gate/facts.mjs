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

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { manifestPaths } from "../manifests.mjs";
import { contractsSource, gatewaySource, root, scan, sourceFiles, trackedFiles, unbuilt } from "./read.mjs";

export const MANIFESTS = manifestPaths(root);

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
  const tables = new Map();
  const bare = (t) => t.replace(/^zz\./, "");
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
    const grab = (name) => {
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
    return { pluginName: null, error: String(err.message ?? err) };
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
export function declaredCommands(pkg) {
  const mf = join(pkg.dir, "flow.json");
  if (!existsSync(mf)) return new Map();
  const m = JSON.parse(readFileSync(mf, "utf8"));
  return new Map(Object.entries(m.commands ?? {}).map(([cmd, skill]) => [skill, cmd]));
}

export const catalogRoot = join(root, "catalog");

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
export const catalogPackages = [];
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
export const skillsDirOf = (f) =>
  (f.flow === BASELINE ? join(root, "skills") : join(f.dir, "skills"));

export const skillsOf = (f) => {
  const dir = join(f.dir, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((s) => existsSync(join(dir, s, "SKILL.md")))
    .map((s) => ({ name: s, path: join(dir, s, "SKILL.md") }));
};
/** Every skill name this repository ships, from wherever it ships them. Memoised: the walk is
 *  the same on every call and several checks want the same answer. */
let _shipped = null;
export function everyShippedSkill() {
  if (_shipped) return _shipped;
  _shipped = new Set();
  for (const rel of sourceFiles(["catalog", "skills", "blocks"], ["SKILL.md"])) {
    const name = /^name:\s*(.+)$/m.exec(readFileSync(join(root, rel), "utf8"))?.[1]?.trim();
    if (name) _shipped.add(name.replace(/^["']|["']$/g, ""));
  }
  return _shipped;
}


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
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(rel ? join(root, rel) : root, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Skill and source trees are documented by their own content checks; a run report is
        // a historical record, correct for ever, and not something a release re-dates.
        // `marketplace` is the rendered copy of `catalog` and `skills`, so it is excluded for
        // the reason they are, twice over: its documents are checked at their source, and the
        // paths inside them resolve against the PLUGIN root rather than this repository —
        // `skills/sdlc-deck/deck-chassis.html` is a real file in the shipped plugin and has
        // never been one here.
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
