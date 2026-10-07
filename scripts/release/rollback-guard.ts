/**
 * Whether the deployment may be put back on an earlier release: which migrations the release the
 * host runs applied that the earlier release's tag never had, and which of them refuse to be rolled
 * back across, with each one's reason.
 *
 * Pure in the sense that matters to its callers: it reads git, and the checkout only in the one
 * case below — no `ssh`, no `die`, no output; the version the host runs is an argument its caller
 * read — so `--rollback`, release step 6 and `checks/rollback-boundary.ts` all ask the same
 * function, and asking it moves nothing. It never throws: step 6 asks it outside its `try`, and a
 * throw there would replace the verification failures with a stack trace.
 *
 * Both sides are asked of git: the earlier release's tag, and the live release's tag. A working
 * tree is not what any deployment applied — a fold rewrites `001_init.sql` and deletes the `002`
 * it absorbed without a version bump, and master carries migrations no release has shipped — so
 * answering from it permits after a fold and refuses for a file production never ran. The one
 * exception is a live version with no tag yet, which is release step 6: the version being released
 * is tagged only at step 7, once it verifies, and step 1 pinned the checkout to it. So an untagged
 * live version is read from the working tree when the checkout's `package.json` is that version,
 * and is the guard's error otherwise.
 *
 * A release's migrations are the files in its tree and the names its `001_init.sql` records as
 * absorbed (`-- absorbs: <file>`): a deployment ran each absorbed file under its own name before
 * the fold, so a file absorbed since the earlier release is as new to that release's code as one
 * still on disk. Its text is read from the newest tag whose tree still has it; one that no tag has
 * is the guard's error, never "nothing to see". The line is read in any case and indented, and a
 * migration a release since the earlier one shipped that the live release neither carries nor
 * absorbs — a fold that forgot its line — is the guard's error too.
 *
 * Two reasons refuse:
 *
 *   - a migration that DECLARES it, with a header line `-- rollback: refused — <reason>`. What
 *     breaks an old writer — a new NOT NULL column, a new CHECK, a column whose meaning changed —
 *     is not reliably visible in DDL, so the migration that knows says so, and this reads it;
 *   - destructive DDL — a dropped column, table, type, schema, view, function or procedure, a
 *     column whose type changed (`ALTER [COLUMN] c [SET DATA] TYPE`), a relation, type or routine
 *     moved to another schema (`SET SCHEMA`), or a rename of something the earlier
 *     release's code still names: a column (`RENAME [COLUMN] a TO b`, `COLUMN` optional), a table
 *     or view (`RENAME TO`), a type or one of its values, a function or a schema. That code still
 *     SELECTs what was dropped or renamed, and every request that resolves an identity then
 *     answers 500 while `/health` stays green, because /health resolves nobody. A rename the old
 *     code cannot see does not refuse: an index, sequence, trigger or constraint (this platform's
 *     code names none of them — no `ON CONFLICT ON CONSTRAINT`, no `nextval('…')`), or a table or
 *     view one of the new migrations itself created: with a plain `CREATE` statement, outside any
 *     comment, string or function body, of a name the earlier release's tree never creates. The
 *     destructive patterns read comments too, so a comment that names such DDL refuses — the safe
 *     way to be wrong. A change that breaks the old code some other way is the declaration's to say.
 *
 * Deploying before verifying rests on being able to undo it. For a release carrying either, that
 * is false, so the callers say so and leave the new version running rather than performing a
 * rollback that makes the outage worse.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { root } from "../deployment.ts";

const MIGRATIONS = "services/gateway/migrations";
const INIT = "001_init.sql";

/** One relation name as DDL spells it: quoted or bare, schema-qualified or not. */
const REL = String.raw`(?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?`;

/** DDL that cannot be undone by putting the old image back, renames of relations aside. */
const IRREVERSIBLE = new RegExp(String.raw`\b(drop\s+(column|table|type|schema|view|materialized\s+view|function|procedure)` +
  String.raw`|alter\s+(column\s+)?\S+\s+(set\s+data\s+)?type` +
  // A relation, type or routine moved to another schema: the old code still names it where it was.
  String.raw`|alter\s+(table|view|materialized\s+view|foreign\s+table|type|domain|function|procedure)\s[^;]*?\bset\s+schema` +
  String.raw`|alter\s+(type|domain|function|procedure|schema)\s[^;]*?\brename)\b`, "i");

/** A table or view renamed, or one of its columns — `COLUMN` optional, `ONLY` and `IF EXISTS`
 *  allowed — capturing the relation. Not `RENAME CONSTRAINT`: no code here names a constraint. */
const RENAMED = new RegExp(String.raw`\balter\s+(?:table|view|materialized\s+view|foreign\s+table)\s+` +
  String.raw`(?:if\s+exists\s+)?(?:only\s+)?(${REL})\s+rename\s+(?!constraint\b)`, "gi");

/** A table or view a migration creates, capturing its name, in any spelling, comments included — what
 *  the earlier release's tree reads as created, where over-reading only takes an exemption away. */
const MENTIONS_CREATE = new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:(?:temp|temporary|unlogged)\s+)?` +
  String.raw`(?:table|view|materialized\s+view|foreign\s+table)\s+(?:if\s+not\s+exists\s+)?(${REL})`, "gi");

/** A plain `CREATE [TEMP|UNLOGGED] TABLE|VIEW|…` statement, capturing its name — never `OR REPLACE`,
 *  which redefines a view that exists, nor `IF NOT EXISTS`, a no-op on a table that does. Matched
 *  only at a statement's start, in text `code` has blanked. */
const CREATES = new RegExp(String.raw`(?:^|;)\s*create\s+(?:(?:temp|temporary|unlogged)\s+)?` +
  String.raw`(?:table|view|materialized\s+view|foreign\s+table)\s+(?!if\s+not\s+exists\b)(${REL})`, "gi");

/** Comments, string literals and dollar-quoted bodies — what the server never runs as a statement of
 *  the migration itself. */
const NOT_CODE = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|\$(\w*)\$[\s\S]*?\$\1\$/g;

/** A migration's own declaration that the release before it cannot run on what it builds — in any
 *  case and indented or not, because a declaration this misread would permit the rollback. */
const DECLARED = /^[ \t]*--[ \t]*rollback:[ \t]*refused\b[ \t]*(?:—[ \t]*)?(.*?)[ \t]*$/im;

/** The names a `001_init.sql` records as absorbed — in any case and indented or not, because a line
 *  this misread hides the absorbed migration and permits the rollback. */
export const ABSORBS = /^[ \t]*--[ \t]*absorbs:[ \t]*(\S+)[ \t]*$/gim;

/** One migration that refuses a rollback across it, and why. */
export interface Refusal { file: string; reason: string }

/** The guard's answer: the refusals (none means the rollback may go ahead), or why it could not
 *  tell. */
export type Guarded = { refusals: Refusal[] } | { error: string };

const stderrOf = (err: unknown): string =>
  String((err as { stderr?: unknown })?.stderr ?? (err as Error)?.message ?? err).trim();

/** A relation's name as Postgres resolves it: a bare part folded to lower case, a quoted one as
 *  written. */
const relName = (spelled: string): string =>
  spelled.split(".").map((p) => (p.startsWith('"') ? p.slice(1, -1) : p.toLowerCase())).join(".");

/** A migration's text with what `NOT_CODE` matches blanked. DELIBERATE: crude — a nested comment
 *  or an odd identifier can blank more than a comment — and blanking more only removes a CREATE,
 *  which takes an exemption away: the safe way to be wrong. */
const code = (text: string): string => text.replace(NOT_CODE, " ");

/** Whether `text` drops, retypes or renames what the earlier release's code still reads — a rename
 *  of a relation in `created`, one a new migration made, is not that. */
function destructive(text: string, created: Set<string>): boolean {
  return IRREVERSIBLE.test(text) || [...text.matchAll(RENAMED)].some((m) => !created.has(relName(m[1]!)));
}

/** git in `repo`, its output as text. */
const gitIn = (repo: string) => (args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Whether `repo` has the tag `tag`. */
const tagged = (repo: string, tag: string): boolean => {
  try {
    gitIn(repo)(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
};

/** The migrations a release knows, by name, each with a way to read its text: the files in its
 *  tree, and the files its `001_init.sql` absorbed. */
interface Known { files: Map<string, () => string>; absorbed: Set<string> }

/** What release `tag` knows — or, given null, this checkout's working tree. */
function knownAt(repo: string, tag: string | null): Known {
  const git = gitIn(repo);
  const files = new Map<string, () => string>();
  if (tag) {
    for (const file of filesAt(repo, tag)) files.set(file, () => git(["show", `${tag}:${MIGRATIONS}/${file}`]));
  } else {
    const dir = join(repo, MIGRATIONS);
    for (const file of existsSync(dir) ? readdirSync(dir) : []) {
      if (file.endsWith(".sql")) files.set(file, () => readFileSync(join(dir, file), "utf8"));
    }
  }
  const init = files.get(INIT);
  return { files, absorbed: new Set(init ? [...init().matchAll(ABSORBS)].map((m) => m[1]!) : []) };
}

/** The migration files release `tag`'s tree carries. */
function filesAt(repo: string, tag: string): string[] {
  // DELIBERATE: the tree and a path filter, not `<tag>:<dir>`. A tag from before the gateway had
  // migrations has none, which is a true answer (every migration is new to it), not a failure.
  return gitIn(repo)(["ls-tree", "--name-only", tag, "--", `${MIGRATIONS}/`]).split("\n")
    .map((line) => basename(line.trim())).filter((file) => file.endsWith(".sql"));
}

/** The text of a migration a fold deleted: from the newest `v*` tag whose tree still has it. */
function absorbedText(repo: string, file: string): string | null {
  const git = gitIn(repo);
  for (const tag of git(["tag", "--list", "v*", "--sort=-v:refname"]).split("\n").filter(Boolean)) {
    try {
      return git(["show", `${tag}:${MIGRATIONS}/${file}`]);
    } catch { /* not in this tag */ }
  }
  return null;
}

/**
 * Which migrations since release `version` (bare, `0.93.3`, as `ZZ_PREVIOUS_VERSION` stores it)
 * refuse a rollback to it from the live release, read from `live` — that release's tag, or null
 * for this checkout's working tree, which only `rollbackGuard`'s step-6 case and the check that
 * asks about this checkout as the release it would become may pass.
 */
export function refusalsSince(version: string, live: string | null, repo: string = root): Guarded {
  const tag = `v${version}`;
  if (!tagged(repo, tag)) {
    return { error: `no tag ${tag} — the guard cannot know what that version's code expects of this schema without its tag` };
  }
  try {
    const then = knownAt(repo, tag);
    const now = knownAt(repo, live);
    const isNew = (file: string) => !then.files.has(file) && !then.absorbed.has(file);
    // Every migration a release since `version` shipped on the way to the live one is either still a
    // file or absorbed. One that is neither went into a fold that did not record it, and asked about
    // only what it recorded the guard would permit what it forbids. DELIBERATE: by ancestry, not by
    // version order, so a release on another line is no part of it.
    const since = gitIn(repo)(["tag", "--list", "v*", "--merged", live ?? "HEAD", "--no-merged", tag]).split("\n").filter(Boolean);
    for (const shipped of since) {
      const lost = filesAt(repo, shipped).find((file) => isNew(file) && !now.files.has(file) && !now.absorbed.has(file));
      if (lost) {
        return { error: `${live ?? "this checkout"} neither carries nor absorbs ${lost}, which ${shipped} shipped — a fold ` +
                        `that did not record it with an \`-- absorbs:\` line in ${INIT}, so whether it refuses the rollback cannot be told` };
      }
    }
    const texts: [string, string][] = [];
    for (const file of [...new Set([...now.files.keys(), ...now.absorbed])].filter(isNew).sort()) {
      const text = now.files.get(file)?.() ?? absorbedText(repo, file);
      if (text === null) {
        return { error: `${live ?? "this checkout"}'s ${INIT} absorbs ${file}, which no tag carries — its text, and so ` +
                        "whether it refuses the rollback, cannot be read" };
      }
      texts.push([file, text]);
    }
    // A relation the new migrations create with a plain CREATE statement, and the earlier release's
    // tree never creates. That tree builds a fresh install's whole schema, so it creates every
    // relation the earlier code can name.
    const before = new Set([...then.files.values()].flatMap((read) => [...read().matchAll(MENTIONS_CREATE)].map((m) => relName(m[1]!))));
    const created = new Set(texts.flatMap(([, text]) => [...code(text).matchAll(CREATES)].map((m) => relName(m[1]!)))
      .filter((name) => !before.has(name)));
    const refusals: Refusal[] = [];
    for (const [file, text] of texts) {
      const declared = DECLARED.exec(text);
      if (declared) refusals.push({ file, reason: declared[1] || "the migration declares it and gives no reason" });
      if (destructive(text, created)) {
        refusals.push({ file, reason:
          `it drops, renames or retypes something ${version}'s code still reads. Putting ${version} back would leave ` +
          "its code querying what no longer exists as it expects — the deployment would answer 500 to every caller while " +
          "/health stayed green. To go back you must first write a migration that restores what it dropped, " +
          "and decide what its values should be — which is a decision, not a rollback" });
      }
    }
    return { refusals };
  } catch (err) {
    return { error: `the migrations since ${tag} could not be read: ${stderrOf(err)}` };
  }
}

/**
 * Which migrations since release `version` refuse a rollback to it from `live` — the version the
 * host runs, as its `ZZ_VERSION` says, read by the caller. Asked of `v<live>`'s tree; with no such
 * tag, of this checkout's working tree when its `package.json` is `live` (release step 6), and
 * otherwise the guard's error.
 *
 * Asked of git rather than of the database: the question is what the target version's code knows
 * about, and its tag is what that code was. A version with no tag is an error, never "every
 * migration is new": an empty or a full list both claim to know what that version's code expects,
 * and without its tag nothing here does.
 */
export function rollbackGuard(version: string, live: string, repo: string = root): Guarded {
  const liveTag = `v${live}`;
  if (live && tagged(repo, liveTag)) return refusalsSince(version, liveTag, repo);
  // Not released yet — step 6 — or a clone that has not fetched the tag and cannot say.
  let checkout = "";
  try {
    checkout = String(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version ?? "");
  } catch (err) {
    return { error: `no tag ${liveTag}, and this checkout's version could not be read from package.json: ${stderrOf(err)}` };
  }
  if (!live || checkout !== live) {
    return { error: `no tag ${live ? liveTag : "for the version the host runs (none is recorded)"}, and this checkout is ` +
                    `${checkout || "(no version)"} — nothing here records the migrations the deployment applied. ` +
                    "Fetch the tags (git fetch --tags), or run from a checkout of the commit that was deployed" };
  }
  return refusalsSince(version, null, repo);
}

/**
 * What a refused rollback says, one line each: the verification failures it was asked after (step
 * 6 passes them; `--rollback` has none), then the guard's reasons or its error, then that `live`
 * is still running and the way out is forward. Empty when the guard permits the rollback.
 */
export function refusalLines(live: string, to: string, guard: Guarded, failures: string[] = []): string[] {
  if ("refusals" in guard && !guard.refusals.length) return [];
  const lines = failures.length
    ? [`${failures.length} verification failure(s):`, ...failures.map((f) => `  - ${f}`)]
    : [];
  if ("error" in guard) {
    lines.push(`rolling back to ${to} is refused: ${guard.error}.`);
  } else {
    lines.push(`rolling back to ${to} is refused — the migrations this release applied cannot be crossed backwards:`,
               ...guard.refusals.map((r) => `  - ${r.file}: ${r.reason}`));
  }
  lines.push(`${live} is STILL LIVE; fix forward. The deployment is LEFT AS IT IS, running the version ` +
             "that matches the schema: redeploy it, or a fix on top of it — the new image keeps writing what the " +
             "old one cannot.");
  return lines;
}
