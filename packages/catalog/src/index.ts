/** The catalog, read in one place.
 *
 * "Find this flow's directory" was written seven times across two files — once per thing
 * anyone wanted out of it: the manifest, a description, the commands map, the skills, the
 * entry skill's when_to_use, the platform entries, the installable list. Each spelled the
 * same walk over /catalog/<owner>/<flow>/ and each decided for itself what a missing
 * directory or an unparseable manifest meant, so they did not all decide the same way.
 *
 * The manifest shape lived in admin.ts while client-package.ts read the same file with its
 * own inline types, which is how `servers` and the commands map came to be read by one and
 * unknown to the other.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Where the shelf lives. `/catalog` in the image, which is where it ships.
 *
 * Overridable because it was not, and that made the packaging path untestable: everything
 * under buildClientPackage — what every person actually installs — reads the catalog through
 * this constant, so nothing outside a container could build a package to look at. The one
 * offline check that could exist was a regex over the source.
 *
 * Not a toggle and not a fallback: the default is the real path, and the override exists so
 * a checkout can point at its own catalog/ directory. */
export const CATALOG_DIR = process.env.ZZ_CATALOG_DIR || "/catalog";

/* The manifest's shape lives in @zz/contracts, as a schema rather than an interface.
 * It was declared here as a TypeScript interface and again in zz-core as a narrower local
 * view, so the same file was described twice by two things that could not see each other.
 * A schema also does what neither interface could: say NO to a manifest, and be published
 * so somebody writing one can read the rules before the write is refused.
 *
 * NOT re-exported from here. It was, so `CatalogManifest` arrived from two module paths —
 * gateway/server.ts took it from the contract and admin.ts and zz-core took it from this
 * façade — and both services already depend on @zz/contracts directly. A second path to one
 * definition is the thing this package was made to remove, one level up. */
import { CatalogManifest as CatalogManifestSchema, type CatalogManifest, type FlowDoc, whyNot } from "@zz/contracts";

interface CatalogEntry {
  owner: string;
  flow: string;
  dir: string;
  manifest: CatalogManifest;
}

/**
 * One flow.json, read and VALIDATED, or a sentence saying why not.
 *
 * A manifest is read in three places and each has a different reader to answer for: this
 * package walks the whole catalog and must skip a broken flow rather than take the build down;
 * manifest-audit and chain-check are given ONE file by an operator and must stop with a
 * sentence. Two of the three called `CatalogManifest.parse` directly, so a mistyped key ended
 * an operator's command in a ZodError dump — a wall of JSON whose one useful word is buried,
 * which is the thing lib/cli.ts exists to prevent.
 *
 * `as CatalogManifest` is the other half and the reason validation is not optional: it
 * asserted a shape nobody checked, so a manifest with `gate: "true"` or a misspelled
 * `documents` key produced a chain that was wrong rather than absent — and a wrong chain
 * refuses the writes the flow depends on, at the stage that depends on them, far from the typo.
 *
 * Returns rather than throws, because the three callers want different things from a failure
 * and only one of them wants to stop.
 */
export function manifestAt(file: string): { manifest: CatalogManifest; why: null }
  | { manifest: null; why: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { manifest: null, why: `could not be read as JSON — ${(err as Error).message}` };
  }
  const parsed = CatalogManifestSchema.safeParse(raw);
  if (parsed.success) {
    // THE ONE LAW THE SCHEMA CANNOT STATE, checked here because this is the only reader that
    // validates. `documents` is what makes a package a flow (see isFlow), and a document has
    // to be PRODUCED by something: `stages` is where `produces` hangs and where a stage's
    // block authority is declared, so a manifest promising documents with no stage to write
    // them describes a flow nobody can run. zod says no to a shape; this is a relation
    // between two fields, and z.object() has no spelling for one that survives `.shape`,
    // `_def.unknownKeys` and jsonSchema() — all three of which the gate reads off
    // CatalogManifest, and all three of which a `.superRefine()` would turn into undefined.
    //
    // The converse is NOT an error. `stages` and no `documents` is an ordinary non-flow
    // package: a method somebody follows that leaves no governed document behind. So is
    // declaring neither, which is what zz-access is. Refusing either here would be the old
    // rule reinstated under a new name.
    //
    // THROUGH isFlow, not through a fourth copy of its expression. The rule this initiative
    // replaced was scattered across the sites that asked it, which is why changing it meant
    // finding them all; restating it inline here — in the function that enforces the
    // obligation it creates — would rebuild that exact problem one file from the classifier.
    const m = parsed.data;
    if (isFlow(m) && !(m.stages?.length ?? 0)) {
      return {
        manifest: null,
        why: "declares documents and no `stages` — a document has to be produced by " +
             "something, and `stages` is what produces it. Add the stage that writes each " +
             "document, naming it in that document's `stage`",
      };
    }
    return { manifest: m, why: null };
  }
  // The schema is strict, so the commonest failure is one mistyped key. safeParse gives the
  // issues without throwing, so the line says which field, at which path.
  return {
    manifest: null,
    why: `is not a valid manifest — ${whyNot(parsed.error)}`,
  };
}

/** A package on the shelf: `<owner>/<name>`, whether or not it ships a manifest. Not
 * exported — every caller destructures it, and an exported name nobody imports is a door
 * onto nothing, which this repository refuses everywhere else. */
interface CatalogPackage {
  owner: string;
  name: string;
  dir: string;
}

/**
 * Every package the catalog holds, owner-then-name ordered.
 *
 * Sorted rather than left in filesystem order: the shelf and the digest keyed to it are
 * built from this, and a listing that reorders itself between two containers of the same
 * image changes a version for nobody's benefit. skill_view has the sharper version of the
 * same reason — it returns the FIRST match, so directory order decided which of two packages
 * answered, and that differed between two containers of one image.
 *
 * THE TOLERANCE IS THE POINT, and it is why this is one function rather than two walks.
 * zz-core walked the same two levels for its skill roots with a single try around the whole
 * thing, so a FILE where an owner directory was expected threw ENOTDIR and the catch — whose
 * comment says "no catalog mounted (local dev)" — swallowed it and returned whatever had
 * accumulated. A stray `.DS_Store` at the catalog root sorts FIRST, so the answer was the
 * empty list: no platform skills, no flow stage skills, no team overlays, and skill_view
 * finding nothing at all, with the only symptom being that every skill had vanished. The
 * catalog is mounted from the working tree on any host using the build override, which is
 * exactly where a stray file comes from.
 *
 * Every package, INCLUDING one with no flow.json. A skills-only package is a package kind
 * the platform supports and zz-flow-builder teaches — a team keeping its own conventions —
 * and it is served by skill_view today. catalogEntries() is the narrower question.
 */
export function catalogPackages(): readonly CatalogPackage[] {
  const out: CatalogPackage[] = [];
  let owners: string[];
  try {
    owners = readdirSync(CATALOG_DIR).sort();
  } catch { return out; }          // no catalog mounted (local dev)
  for (const owner of owners) {
    let names: string[];
    try {
      names = readdirSync(join(CATALOG_DIR, owner)).sort();
    } catch { continue; }          // a file where an owner directory was expected
    for (const name of names) out.push({ owner, name, dir: join(CATALOG_DIR, owner, name) });
  }
  return out;
}

/** Every catalog entry that has a manifest we can read, owner-then-name ordered.
 *
 * An unparseable manifest is skipped, not thrown: one broken flow must not take down the
 * package build for every person on the platform. */
export function catalogEntries(): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const { owner, name: flow, dir } of catalogPackages()) {
    const f = join(dir, "flow.json");
    if (!existsSync(f)) continue;
    const got = manifestAt(f);
    if (got.manifest) { out.push({ owner, flow, dir, manifest: got.manifest }); continue; }
    // Skipped, but never silently. This can only happen to a catalog edited on a running
    // host — the build override makes that easy, mounting the working tree over the
    // image's copy — and a typo there removes the flow from the shelf, from list_catalog
    // and from every gate it governs. Without this line the only symptom is that it is
    // gone.
    console.error(`catalog: ${owner}/${flow}/flow.json ${got.why}, skipping`);
  }
  return out;
}

/** One entry by flow name, or null.
 *
 * `includePlatform` is off by default, and that default is the guard. Filtering where a
 * thing is LOOKED UP rather than where it is LISTED is the difference between a guard and a
 * cosmetic: the platform filter first went into the listing alone, so list_catalog correctly
 * hid zz-access while install_flow, which resolves a manifest directly, installed it anyway.
 * Callers that genuinely want a platform entry — the package builder — ask for it. */
export function catalogEntry(flow: string, includePlatform = false): CatalogEntry | null {
  for (const e of catalogEntries()) {
    if (e.flow !== flow) continue;
    // NOT INSTALLABLE — the question this is actually asking, and it is about
    // ownership rather than shape. The field used to be `kind: "platform"` and this
    // line used to carry a comment saying "ANY kind means not a flow", which was
    // false: zz-skill-eval is shelved and has five stages, two documents and a gate.
    // Shape is `documents` and lives nowhere else. See isFlow and CatalogManifest.shelved.
    if (e.manifest.shelved && !includePlatform) return null;
    return e;
  }
  return null;
}

/** Just the manifest, for the many callers that want one field out of it. */
export function catalogManifest(flow: string, includePlatform = false): CatalogManifest | null {
  return catalogEntry(flow, includePlatform)?.manifest ?? null;
}

/** IS THIS PACKAGE A FLOW? It is, if and only if it declares at least one document.
 *
 * The one classifier, so that "what is this package" has one answer and no caller
 * reconstructs it. It replaces `stages.length > 0`, which was the rule for exactly the
 * reason this one is — the console had been guessing shape from contents, and a DECLARED
 * shape is what stops that — but which does not discriminate: `zz-access` is a surface, an
 * agent and an MCP door with no method, and it declared one stage whose name repeated its
 * own entry, so the rule called it a flow and the console gave it a stepper over a single
 * step that produced nothing.
 *
 * `documents` discriminates because a flow is a discipline over documents: gates, order,
 * a closing document, a chain that refuses a write. A package with none of those has
 * nothing for the platform to govern, whatever its stage count. `stages` keeps every job
 * it already had — `produces` hangs off it, `stage-access.ts` reads a stage's `blocks`, the
 * console's stepper walks it — it simply no longer decides what the package IS.
 *
 * A flow must still declare stages, and manifestAt refuses one that does not: documents
 * with nothing to produce them is a flow nobody can run. The converse is a legal package
 * with no stages at all, which is what `zz-access` now is.
 *
 * A TYPE PREDICATE, not a plain boolean, because a flow's `documents` is exactly what every
 * caller reaches for next. Without the narrowing each one wrote its own
 * `(m.documents?.length ?? 0) > 0` so that TypeScript would let it read the field — which is
 * how one rule came to have four spellings, in the very initiative that exists to give it
 * one. `chainForFlow` then passes `m.documents` straight to `deriveChain` with no `?? []`
 * standing in for a case the predicate has already ruled out. */
export function isFlow(manifest: CatalogManifest): manifest is CatalogManifest & { documents: FlowDoc[] } {
  return (manifest.documents?.length ?? 0) > 0;
}

/** Flows a team can install. NOT every catalog entry: platform capabilities live here too,
 * so that their description and skills have one home, but installing one would create a
 * flow_install row for something the shelf already ships to everyone — and then package it
 * a second time as a flow plugin. */
export function installableFlows(): string[] {
  return catalogEntries()
    .filter((e) => !e.manifest.shelved)
    .map((e) => `${e.owner}/${e.flow}`);
}

/** Platform packages that can GOVERN an initiative — the ones shipped to every team that
 * declare documents of their own.
 *
 * Not the same question as installableFlows(), and the difference is the point. A shelved
 * package is uninstallable because the shelf already ships it to everyone; that says nothing
 * about whether it OWNS DOCUMENTS, which is what governing means here.
 *
 * The test is `isFlow` plus ownership, and it is the same `documents` question the classifier
 * asks — deliberately, now that it is one question. It was two: this filtered on `documents`
 * while the platform classified on `stages`, so `zz-access` was a flow that could not govern
 * anything, and the comment here had to explain the gap rather than the rule. A governor with
 * no documents gates nothing, which is precisely the permanent-ungoverned failure the next
 * paragraph records — and a package with no documents is not a flow, so the two collapse.
 *
 * It exists because "which flows could govern this initiative" was answered from
 * zz.flow_install alone, and that table has no row for a platform package by construction.
 * So a team was never asked to declare which flow it was running when the answer was one of
 * these, and zz-platform — whose ONLY flows are these — was asked nothing ever: its first
 * document could omit `flow:` and the initiative was then governed by nothing, permanently,
 * with no gate on the document the flow exists to gate.
 */
export function governingPlatformFlows(): string[] {
  return catalogEntries()
    .filter((e) => e.manifest.shelved && isFlow(e.manifest))
    .map((e) => e.flow);
}


/** A skill's raw markdown, or null when the flow does not ship that skill. */
export function skillText(flow: string, skill: string): string | null {
  const e = catalogEntry(flow, true);
  if (!e) return null;
  const p = join(e.dir, "skills", skill, "SKILL.md");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
