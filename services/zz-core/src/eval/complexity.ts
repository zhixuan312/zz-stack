/**
 * Candidate complexity (Task I-18, FR-41, FR-57's own frozen formula): everything
 * `candidate_record` needs to turn a unified-diff patchset into the numbers migration 077's
 * `zz.candidate` stores — `complexity_delta`, the touched file list and each file's mapping onto
 * the base subject's own `component_manifest` (`subject.ts`'s `Component` shape, mirrored here
 * rather than imported, to keep this module import-free of the mutator that reads it).
 *
 * Pure, no I/O — `candidates.ts` is the only caller, and `checks/eval-complexity.ts` (the plan's
 * own check) imports `complexityDelta` alone, straight off `dist/`.
 *
 * `complexityDelta` is FR-57's frozen formula for the bootstrap zz-core protocol, applied
 * uniformly rather than read from a protocol column: spec v8 names it as computed by CODE from
 * the patch, not as a per-protocol policy value, so there is nothing here for a protocol to
 * override.
 */
import { createHash } from "node:crypto";

export interface ComplexityInput {
  readonly lines_added: number;
  readonly lines_removed: number;
  readonly components_added: number;
  readonly components_removed: number;
}

/** FR-57: "lines added minus lines removed... plus 20 for each added component and minus 20 for
 *  each removed one." The plan's own check pins these exact numbers. */
export function complexityDelta(input: ComplexityInput): number {
  return input.lines_added - input.lines_removed
    + 20 * input.components_added - 20 * input.components_removed;
}

// -------------------------------------------------------------------------------------------
// Unified-diff parsing — a candidate's `patchset.diff` reduced to per-file line counts and each
// file's add/remove/modify state, which `complexityDelta`'s own `components_added/removed`
// count over (DELIBERATE: at this granularity a "component" IS a touched file — FR-35's surface
// is unrestricted, "skills, prompts, flow definitions, tools, code, schema, configuration,
// tests or documentation", so a whole-file add/delete is the one signal every one of those
// shares, where the finer skill/server/flow manifest below does not apply).

// Not exported as a named alias: an exported interface's field type has to be nameable from
// outside if it is a separately exported alias, and nothing outside this file needs to name
// "added"/"removed"/"modified" on its own — inlined directly into every field that carries it.
type FileChange = "added" | "removed" | "modified";

export interface PatchFile {
  readonly path: string;
  readonly change: "added" | "removed" | "modified";
}

export interface PatchStats {
  readonly lines_added: number;
  readonly lines_removed: number;
  readonly files: readonly PatchFile[];
}

const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

/** A standard `git diff`/unified-diff body: one `diff --git` header per file, an optional `new
 *  file mode`/`deleted file mode` line naming whether the whole file appeared or vanished, an
 *  `@@ ... @@` hunk header opening the body, then `+`/`-` body lines. Tolerant of a diff with no
 *  `diff --git` headers at all (a bare hunk against one implied file) by falling back to
 *  counting lines with no file entry — `complexityDelta` still gets a lines_added/lines_removed
 *  it can use even though `files` comes back empty in that case.
 *
 *  `+`/`-` are counted only INSIDE a hunk (after its own `@@` line, reset false at every `diff
 *  --git` header) rather than by excluding the `+++`/`---` path-header lines by their own
 *  prefix: a real body line can itself start with `---` (a YAML front-matter delimiter — every
 *  `SKILL.md` in this repository has one) or `++`, and excluding by prefix alone silently drops
 *  it from the count `complexityDelta` reduces to one number. The `+++`/`---` path headers
 *  always precede the first `@@` of their own file, so gating on "inside a hunk" excludes them
 *  for free and never misreads a body line that merely looks like one. */
export function parseUnifiedDiff(diff: string): PatchStats {
  let lines_added = 0;
  let lines_removed = 0;
  const files: PatchFile[] = [];
  let currentPath: string | null = null;
  let currentChange: FileChange = "modified";
  let inHunk = false;

  const flush = (): void => {
    if (currentPath) files.push({ path: currentPath, change: currentChange });
  };

  for (const line of diff.split("\n")) {
    const header = DIFF_GIT_RE.exec(line);
    if (header) {
      flush();
      currentPath = header[2];
      currentChange = "modified";
      inHunk = false;
      continue;
    }
    if (line.startsWith("new file mode")) { currentChange = "added"; continue; }
    if (line.startsWith("deleted file mode")) { currentChange = "removed"; continue; }
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (!inHunk) continue; // path headers, index/mode lines — never body lines
    if (line.startsWith("+")) { lines_added += 1; continue; }
    if (line.startsWith("-")) { lines_removed += 1; continue; }
  }
  flush();
  return { lines_added, lines_removed, files };
}

/** `components_added`/`components_removed` for `complexityDelta`: how many of the patch's own
 *  files were created or deleted whole, as opposed to merely edited. */
export function componentCounts(files: readonly PatchFile[]): { added: number; removed: number } {
  return {
    added: files.filter((f) => f.change === "added").length,
    removed: files.filter((f) => f.change === "removed").length,
  };
}

// -------------------------------------------------------------------------------------------
// Touched-component mapping — `candidate_record`'s "touched components = files mapped to
// manifest components" data-mapping clause. A base subject's `component_manifest` (`subject.ts`)
// names skills/servers/flows by NAME, not by path, so a patch file is matched against it by
// looking for that name as a path segment; a file matching nothing in the manifest still gets a
// kind, inferred from its own path, so `candidate_record` never has to store `null`.

export interface ManifestComponent {
  readonly kind: string;
  readonly name: string;
}

export interface TouchedComponent {
  readonly path: string;
  readonly change: "added" | "removed" | "modified";
  readonly kind: string;
  readonly name: string;
  /** Whether this file matched a component the base subject's own manifest already names, as
   *  opposed to a kind this function only guessed at from the path. */
  readonly in_manifest: boolean;
}

/** Path-based, not content-based: this runs on the patch's file list alone, long before anything
 *  applies it to a worktree. `/skills/<name>/...` and a bare top-level `<name>/` are the two
 *  shapes `subject.ts`'s own capture (`resolveLocalDir`, the catalog skill layout) produces, so
 *  matching on either is what makes a candidate that edits an existing skill resolve to that
 *  skill's own manifest entry rather than a guessed one. */
function inferKind(path: string): string {
  if (path.includes("/skills/") || /^skills\//.test(path)) return "skill";
  if (/\.sql$/.test(path)) return "schema";
  if (/(^|\/)(tests?|checks)\//.test(path) || /\.test\.[jt]sx?$/.test(path)) return "tests";
  if (/\.md$/.test(path)) return "documentation";
  return "code";
}

export function touchedComponents(
  files: readonly PatchFile[], manifest: readonly ManifestComponent[],
): TouchedComponent[] {
  return files.map((f): TouchedComponent => {
    const match = manifest.find((c) => f.path.includes(`/${c.name}/`) || f.path.startsWith(`${c.name}/`));
    return {
      path: f.path, change: f.change,
      kind: match?.kind ?? inferKind(f.path),
      name: match?.name ?? f.path,
      in_manifest: !!match,
    };
  });
}

// -------------------------------------------------------------------------------------------
// Digests — `candidate_record`'s own "patch_digest = sha256 of the diff" and "hypothesis digest
// = sha256 of normalised hypothesis text" data-mapping clauses.

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export const patchDigest = (diff: string): string => sha256(diff);

/** Whitespace-collapsed, case-folded: two hypotheses that read the same to a person but differ
 *  in spacing or capitalisation are the same idea for the RRSI-style repeat check FR-38 names —
 *  a digest that distinguished them would let a proposer defeat the check by re-punctuating. Not
 *  exported: `hypothesisDigest` below is every caller's own way to compare two hypotheses, and
 *  the normalised text itself has no other consumer. */
function normaliseHypothesis(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export const hypothesisDigest = (text: string): string => sha256(normaliseHypothesis(text));
