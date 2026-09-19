/**
 * The evaluation modules live on the evaluation side, only the evaluation side reaches them,
 * and nothing compiled still answers at the address they left.
 *
 * WHAT THIS OWNS, AND WHAT IT DELIBERATELY DOES NOT. `checks/eval-door.ts` opens a real
 * client against `buildEvalServer` and reads the tool list back: which tools each door SERVES,
 * that no tool is on both, that the core door serves no `plugin_*`, that the flow's skills can
 * reach what they instruct. Not one of those is asserted again here. Two checks going red for
 * one cause teaches nothing, and the second one is the one people stop reading.
 *
 * This file's subject is the MODULE GRAPH and WHERE THE FILES SIT — the half a client cannot
 * see. A door serving exactly the right ten tools, out of modules still sitting in
 * `src/tools/` beside the core door's, with `tools/artifacts.ts` importing the judge, is green
 * on every clause eval-door.ts has. It is also the state Task I-20 exists to end: the core
 * door's surface is scanned OUT OF THAT DIRECTORY by checks/core-surface-19.ts, so a
 * `plugin_*` registration left in it makes that scan describe a door that no longer exists.
 *
 * THE PLAN'S OWN DRAFT OF THIS FILE COULD NOT PASS, and was measured saying so before a line
 * of this was written. Against untouched code it printed three failures, and each was about
 * something other than what it meant:
 *
 *   - `core.split("buildCoreServer")` — there is no `buildCoreServer`. server.ts's factory is
 *     `buildServer`, so the split returned undefined, the `?? core` fallback made "the core
 *     factory" the WHOLE FILE, and the check then read the eval door's own import line and the
 *     paragraph explaining that these tools have left as proof that they had not.
 *   - `coreFactory.includes("plugin-eval")` matched the words "zz-plugin-eval" in that
 *     paragraph. A comment saying a thing is gone satisfied the clause asserting it is there.
 *   - It required both factories inside server.ts. `buildEvalServer` is in eval-door.ts and
 *     cannot move: server.ts binds :8000 at module scope, so nothing can import it — which is
 *     why eval-door.ts exists at all. So the clause "the eval factory registers plugin-judge"
 *     was red before the task and stayed red after it, under every possible implementation.
 *
 *   Run again after the move it is red on the same three lines, and its one remaining clause —
 *   the loop over `src/tools` looking for a non-eval module importing the judge — is now
 *   vacuously green, because the directory it reads holds none of these files any more. Before
 *   and after, identical output: the definition of a check that cannot see its own subject.
 *
 * SO THIS ONE RESOLVES IMPORTS RATHER THAN MATCHING WORDS, and drives the compiled graph
 * rather than reading the source one. A path written correctly and compiled to something that
 * does not resolve is the failure a source-only scan is blind to — and the reverse, a stale
 * `dist/judge.js` left behind by `tsc -b` (which deletes nothing), is how every caller of the
 * old path stays green through a move that broke it. Both were live here: the stale copies
 * existed after the first build of this task and were removed by hand.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. `unknown?.message` narrows to `{}`, which has no properties at all. */
function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}
function errCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as Record<string, unknown>).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

const fail: string[] = [];
const blind: string[] = [];

const SRC = "services/zz-core/src";
const DIST = "services/zz-core/dist";
const EVAL = "eval";                                  // the eval side, relative to SRC
/** The one file outside the eval side allowed to reach into it: the door the service mounts. */
const THE_DOOR = "eval-door.ts";

/** The three support modules this task moves, and the three registration modules they serve. */
const SUPPORT = ["judge.ts", "plugin-profile.ts"];
const REGISTRATIONS = ["plugin-eval.ts", "plugin-judge.ts", "plugin-record.ts"];
const MOVED = [...SUPPORT, ...REGISTRATIONS];

/** Read a path, or record that this scan went blind on it. A CHECK THAT THROWS HAS NO FAILURE
 *  PATH — "nothing found" and "nothing to find" are the same answer unless one of them says
 *  so, and several checks in this initiative have ended in a stack trace instead of the
 *  sentence they were written to print. */
const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { blind.push(p); return null; } };

/** Source with its comments taken out, tracking strings so a quoted `/*` cannot open one.
 *
 * THE CHARACTER SCANNER, not the line-wise stripper core-surface-19.ts carries, and the
 * difference has already cost this repository a false green: a LINE comment ending "…/auth/*"
 * opens a block comment a line-wise stripper never closes, blanking the rest of the file —
 * and a stripper that silently empties the region it is asked about turns every assertion over
 * that region green. Stripping matters here specifically: every file this walks carries prose
 * naming these modules by path, and an import in a comment is not an import. */
const stripComments = (src: string) => {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") out += "\n"; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c; i++;
      while (i < src.length && src[i] !== c) { if (src[i] === "\\") { out += src[i]; i++; } out += src[i]; i++; }
      out += src[i] ?? ""; i++; continue;
    }
    out += c; i++;
  }
  return out;
};

/** Every .ts file under zz-core's source, as paths relative to it. */
const walk = (dir: string, base = "", out: string[] = []) => {
  let entries: string[];
  try { entries = readdirSync(join(SRC, dir)); } catch { blind.push(join(SRC, dir)); return out; }
  for (const e of entries) {
    const rel = base ? posix.join(base, e) : e;
    if (statSync(join(SRC, rel)).isDirectory()) walk(rel, rel, out);
    else if (e.endsWith(".ts")) out.push(rel);
  }
  return out;
};
const files = walk("");
// THE CONTROL ON THE WALK. Every clause below iterates it, so an empty or truncated list is a
// green run that examined nothing — which is what a renamed source directory looks like.
if (files.length < 15) {
  fail.push(`the walk of ${SRC} found ${files.length} TypeScript files, which is fewer than ` +
            "this service has ever had — every clause below iterates that list, so this run " +
            "examined almost nothing. Point the walk at where the source went.");
}

/** Who imports what, resolved. `{ from, to }` in paths relative to SRC, comments stripped and
 *  relative specifiers only — a package name is not a file in this tree. */
const edges: { from: string; to: string }[] = [];
for (const f of files) {
  const src = stripComments(read(join(SRC, f)) ?? "");
  for (const m of src.matchAll(/from\s+"(\.[^"]*)"/g)) {
    const spec = m[1].replace(/\.js$/, ".ts");
    edges.push({ from: f, to: posix.normalize(posix.join(posix.dirname(f), spec)) });
  }
}
// THE CONTROL ON THE EXTRACTION. Every clause about who reaches what reads this list, and a
// regex that matched nothing reports a graph with no edges as a graph with no violations.
if (edges.length < 10) {
  fail.push(`only ${edges.length} relative import(s) were extracted from ${files.length} ` +
            "files — the specifier scan is broken, so every clause about who imports what " +
            "passed on an empty graph");
}

const onEvalSide = (rel: string) => rel === THE_DOOR || rel.startsWith(`${EVAL}/`);

// ── 1. The six modules are on the eval side, and nowhere else ─────────────────────────────
//
// BOTH DIRECTIONS, because a copy is the failure a "does it exist there" clause waves through.
// This repository forbids parallel implementations outright, and a `src/judge.ts` left beside
// `src/eval/judge.ts` is one: both compile, both are importable, and which one a module got
// depends on the specifier it happened to be written with.
for (const m of MOVED) {
  if (!existsSync(join(SRC, EVAL, m))) {
    fail.push(`${SRC}/${EVAL}/${m} is not there — this task moves it to the evaluation side`);
  }
}
for (const f of files) {
  const base = posix.basename(f);
  if (MOVED.includes(base) && !f.startsWith(`${EVAL}/`)) {
    // TWO SENTENCES, because the two states need different fixes and a reader acts on the
    // one they are given. A copy beside the moved file is the parallel implementation; the
    // same file still where it was is simply a move that did not happen.
    fail.push(existsSync(join(SRC, EVAL, base))
      ? `${SRC}/${f} is a second ${base}, outside ${EVAL}/ — one of the two is what callers ` +
        "get and nothing in the specifier says which. Delete the one that is not on the " +
        "evaluation side."
      : `${SRC}/${f} is still where it was — this task moves it to ${EVAL}/, and until it ` +
        "goes the core door's surface is scanned out of a directory that holds it");
  }
}

// ── 2. Only the eval side reaches into the eval side ──────────────────────────────────────
//
// THE POINT OF THE MOVE. Those tools are one flow's instrument; a core tool that imports the
// judge puts that flow's machinery back into every account's process and back into the
// directory checks/core-surface-19.ts scans for the core door's surface. `eval-door.ts` is
// the single exception and is named rather than pattern-matched: it is the function the
// service mounts, and a door that could not import its own tools would not be a door.
for (const { from, to } of edges) {
  if (!to.startsWith(`${EVAL}/`)) continue;
  if (onEvalSide(from)) continue;
  fail.push(`${SRC}/${from} imports ${to} — the evaluation modules are reached from the ` +
            `evaluation side and from ${THE_DOOR}, and nothing else`);
}
// The control on that clause: it is satisfied by a tree where nothing imports the eval side at
// all, which is a door with nothing behind it.
if (!edges.some(({ from, to }) => from === THE_DOOR && to.startsWith(`${EVAL}/`))) {
  fail.push(`${THE_DOOR} imports nothing from ${EVAL}/ — the clause above then passes on a ` +
            "tree where the evaluation modules are reached by nobody");
}
if (!edges.some(({ from, to }) => from.startsWith(`${EVAL}/`) && to.startsWith(`${EVAL}/`))) {
  fail.push(`no module under ${EVAL}/ imports another — the support modules this task moved ` +
            "are reached by nothing, so the clause above examined a side with no graph in it");
}

// ── 3. attest.ts stays on the core side ───────────────────────────────────────────────────
//
// THE ONE DEPENDENCY THAT LOOKS LIKE IT BELONGS WITH THE JUDGE AND DOES NOT. It sits in the
// same neighbourhood, it is about evidence, and it is named like a measurement — but what it
// attests is that a document was SHOWN to a person before they approved it, which is the core
// door's gate and nothing to do with judging a plugin. Moving it would put an `/eval/mcp`
// import into `document_approve`, so the gate every account depends on would need a door only
// the evaluation flow installs.
//
// WHAT IT ATTESTS IS checks/attest-shown.ts's SUBJECT — that check drives the real function.
// This one asserts only where the file lives and who is allowed to reach it.
if (!existsSync(join(SRC, "attest.ts"))) {
  fail.push(`${SRC}/attest.ts is not there — it stays on the core side, next to the gate it ` +
            "serves, and only the evaluation modules moved");
}
const THE_IMPORTER = "tools/initiative-acts.ts";
const attestImporters = edges.filter(({ to }) => to === "attest.ts").map(({ from }) => from);
// THE NAMED IMPORTER, NOT A COUNT, and a mutation of this file is why. Unwiring
// `shownSinceLastChange` from `document_approve` was caught here only because initiative-acts
// happens to be attest's SOLE importer — a threshold of "at least one" that discriminates
// today and stops the day a second core module imports it. `checks/attest-shown.ts` does not
// close that: it drives the function directly against a temporary store and never asserts
// that the approval path calls it, so it printed "8 cases passed" against an approval that had
// stopped asking. What the contract says is that attest stays on core BECAUSE this file needs
// it, so this is what the clause asserts.
if (!attestImporters.includes(THE_IMPORTER)) {
  fail.push(`${SRC}/${THE_IMPORTER} does not import attest.ts — that import is the whole ` +
            "reason attest stays on the core side, and without it `document_approve` records " +
            "an approval without asking whether the document was ever shown. " +
            (attestImporters.length
              ? `attest.ts is imported by ${attestImporters.join(", ")}, which is not the same claim.`
              : "Nothing imports attest.ts at all."));
}
for (const f of attestImporters) {
  if (onEvalSide(f)) {
    fail.push(`${SRC}/${f} is on the evaluation side and imports attest.ts — the approval ` +
              "attestation is the core door's, and an evaluation module reaching it is the " +
              "move this task was told not to make");
  }
}

// ── 4. Driven: the compiled graph resolves where the source says it does ──────────────────
//
// READING A SPECIFIER PROVES IT IS WRITTEN, NEVER THAT IT RESOLVES. Everything above is a scan
// of source text; this imports the built modules, which makes their own imports run. A path
// updated in one file and missed in the module it pulls in fails here and nowhere else above.
const imported: string[] = [];
for (const m of MOVED) {
  const at = `../${DIST}/${EVAL}/${m.replace(/\.ts$/, ".js")}`;
  try { await import(new URL(at, import.meta.url).href); imported.push(m); } catch (err) {
    fail.push(`${DIST}/${EVAL}/${m.replace(/\.ts$/, ".js")} could not be imported, so the ` +
              `compiled module graph does not resolve where the source says it does: ` +
              `${errMessage(err)}`);
  }
}
if (!imported.length) {
  blind.push(`${DIST}/${EVAL} — not one module could be imported, so nothing below about the ` +
             "old addresses was compared against a working new one");
}
// AND NOTHING STILL ANSWERS AT THE OLD ADDRESS. `tsc -b` deletes nothing, so the compiled
// copies of these files survived the move in place; every caller of an old path — two of them
// registered in this gate — stayed green against a `dist/judge.js` that no source produces any
// more. That is not a stale artifact, it is a second implementation answering to the name.
const ABANDONED = [...SUPPORT.map((m) => m), ...REGISTRATIONS.map((m) => `tools/${m}`)]
  .map((m) => m.replace(/\.ts$/, ".js"));
for (const old of ABANDONED) {
  const at = `../${DIST}/${old}`;
  let resolved = true;
  try { await import(new URL(at, import.meta.url).href); } catch (err) {
    if (errCode(err) === "ERR_MODULE_NOT_FOUND") resolved = false;
    else {
      fail.push(`${DIST}/${old} is still there and throws on import (${errMessage(err)}) ` +
                "— it is a compiled copy of a module that moved; delete it");
      continue;
    }
  }
  if (resolved) {
    fail.push(`${DIST}/${old} still imports cleanly — a compiled copy of a module this task ` +
              "moved is answering at the address it left, and every caller still pointed there " +
              "passes against code no source in this tree produces");
  }
}

// A path this check reads that has moved is this scan going blind, and it is said FIRST: every
// assertion about it passed on nothing.
for (const p of new Set(blind)) {
  fail.unshift(`${p} could not be read — this check asserts over it, so those assertions ` +
               "passed on nothing. Point it at where it went.");
}

if (fail.length) { console.error([...new Set(fail)].join("\n")); process.exit(1); }
// WHAT WAS ACTUALLY ASSERTED, ON THE GREEN LINE, so a reader can tell whether this ran against
// the tree they think it did — and what it does NOT speak to, so a pass is not read as the
// all-clear on the surface those modules serve.
console.log(
  `eval tools moved: ok — ${MOVED.length} modules under ${SRC}/${EVAL}/ and no second copy ` +
  `elsewhere; of ${edges.length} relative imports across ${files.length} files, every one ` +
  `reaching into ${EVAL}/ comes from ${EVAL}/ or ${THE_DOOR}; attest.ts stays at ${SRC}/ and ` +
  `is imported by ${attestImporters.join(", ") || "nothing"}, none of it on the evaluation ` +
  `side; all ${imported.length} compiled modules import from ${DIST}/${EVAL}/ and none of the ` +
  `${ABANDONED.length} old addresses resolves.\n` +
  `           NOT COVERED: what either door SERVES. That is checks/eval-door.ts, which opens ` +
  `a real client against both; and what attest.ts attests is checks/attest-shown.ts, which ` +
  `drives the function. This check passing says where the code lives, not what it does.`);
