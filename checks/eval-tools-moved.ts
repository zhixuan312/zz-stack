/**
 * The evaluation modules live on the evaluation side, only the evaluation side reaches them, and
 * nothing compiled still answers at the address they left.
 *
 * COUPLED: `checks/eval-door.ts` owns what each door serves — that no tool is on both, that the
 * core door serves no `plugin_*`, that the flow's skills can reach what they instruct. None of
 * that is asserted again here.
 *
 * This file's subject is the module graph and where the files sit. A door serving exactly the
 * right tools, out of modules still sitting in `src/tools/` with `tools/artifacts.ts`
 * importing the judge, is green on every clause eval-door.ts has — and the core door's surface is
 * scanned out of that directory by checks/core-surface.ts, so a `plugin_*` registration left
 * in it makes that scan describe a door that no longer exists.
 *
 * DELIBERATE: imports are resolved rather than matched as words, and the compiled graph is driven
 * rather than the source one. A path written correctly and compiled to something that does not
 * resolve is invisible to a source-only scan; and a stale `dist/judge.js` left behind by `tsc -b`
 * (which deletes nothing) keeps every caller of the old path green through a move that broke it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

/** A caught value is never typed as an Error — narrow the shape actually being read rather than
 *  assume it. `unknown?.message` narrows to `{}`, which has no properties at all. */
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

/** The support modules on the eval side, and the registration modules they serve. */
const SUPPORT = ["judge.ts", "plugin-profile.ts"];
const REGISTRATIONS = ["plugin-eval.ts", "plugin-judge.ts", "plugin-record.ts"];
const MOVED = [...SUPPORT, ...REGISTRATIONS];

/** Read a path, or record that this scan went blind on it. A check that throws has no failure
 *  path: "nothing found" and "nothing to find" are the same answer unless one of them says so. */
const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { blind.push(p); return null; } };

/** Source with its comments taken out, tracking strings so a quoted `/*` cannot open one.
 *
 * DELIBERATE: a character scanner, not the line-wise stripper core-surface.ts carries. A line
 * comment ending "…/auth/*" opens a block comment a line-wise stripper never closes, blanking the
 * rest of the file and turning every assertion over that region green. Every file this walks
 * carries prose naming these modules by path, and an import in a comment is not an import. */
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
// The control on the walk. Every clause below iterates it, so an empty or truncated list is a
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
// The control on the extraction. Every clause about who reaches what reads this list, and a
// regex that matched nothing reports a graph with no edges as a graph with no violations.
if (edges.length < 10) {
  fail.push(`only ${edges.length} relative import(s) were extracted from ${files.length} ` +
            "files — the specifier scan is broken, so every clause about who imports what " +
            "passed on an empty graph");
}

const onEvalSide = (rel: string) => rel === THE_DOOR || rel.startsWith(`${EVAL}/`);

// 1. The moved modules are on the eval side, and nowhere else.
//
// Both directions, because a copy is the failure a "does it exist there" clause waves through: a
// `src/judge.ts` left beside `src/eval/judge.ts` means both compile, both are importable, and
// which one a module gets depends on the specifier it happened to be written with.
for (const m of MOVED) {
  if (!existsSync(join(SRC, EVAL, m))) {
    fail.push(`${SRC}/${EVAL}/${m} is not there — this task moves it to the evaluation side`);
  }
}
for (const f of files) {
  const base = posix.basename(f);
  if (MOVED.includes(base) && !f.startsWith(`${EVAL}/`)) {
    // Two sentences, because the two states need different fixes. A copy beside the moved file
    // is a parallel implementation; the same file still where it was is a move that did not
    // happen.
    fail.push(existsSync(join(SRC, EVAL, base))
      ? `${SRC}/${f} is a second ${base}, outside ${EVAL}/ — one of the two is what callers ` +
        "get and nothing in the specifier says which. Delete the one that is not on the " +
        "evaluation side."
      : `${SRC}/${f} is still where it was — this task moves it to ${EVAL}/, and until it ` +
        "goes the core door's surface is scanned out of a directory that holds it");
  }
}

// 2. Only the eval side reaches into the eval side.
//
// Those tools are one flow's instrument; a core tool that imports the judge puts that flow's
// machinery back into every account's process and back into the directory
// checks/core-surface.ts scans for the core door's surface. `eval-door.ts` is the single
// exception and is named rather than pattern-matched: it is the function the service mounts.
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

// 3. attest.ts stays on the core side.
//
// It sits in the same neighbourhood and is named like a measurement, but what it attests is that
// a document was shown to a person before they approved it — the core door's gate, and nothing to
// do with judging a plugin. Moving it would put an `/eval/mcp` import into `document_approve`, so
// the gate every account depends on would need a door only the evaluation flow installs.
//
// COUPLED: what it attests is checks/attest-shown.ts's subject. This one asserts only where the
// file lives and who is allowed to reach it.
if (!existsSync(join(SRC, "attest.ts"))) {
  fail.push(`${SRC}/attest.ts is not there — it stays on the core side, next to the gate it ` +
            "serves, and only the evaluation modules moved");
}
const THE_IMPORTER = "tools/initiative-acts.ts";
const attestImporters = edges.filter(({ to }) => to === "attest.ts").map(({ from }) => from);
// The named importer, not a count. A threshold of "at least one" discriminates only while attest
// has a sole importer, and `checks/attest-shown.ts` drives the function directly without asserting
// that the approval path calls it — so it stays green against an approval that has stopped asking.
// attest stays on core because this file needs it, so that is what the clause asserts.
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

// 4. Driven: the compiled graph resolves where the source says it does.
//
// Reading a specifier proves it is written, never that it resolves. Everything above is a scan of
// source text; this imports the built modules, which makes their own imports run. A path updated
// in one file and missed in the module it pulls in fails here and nowhere else.
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
// And nothing still answers at the old address. `tsc -b` deletes nothing, so a compiled copy of a
// moved file survives in place and every caller of the old path stays green against code no source
// produces. That is a second implementation answering to the name, not a stale artifact.
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

// A path this check reads that has moved is this scan going blind, and it is said first: every
// assertion about it passed on nothing.
for (const p of new Set(blind)) {
  fail.unshift(`${p} could not be read — this check asserts over it, so those assertions ` +
               "passed on nothing. Point it at where it went.");
}

if (fail.length) { console.error([...new Set(fail)].join("\n")); process.exit(1); }
// What was actually asserted, on the green line, so a reader can tell whether this ran against
// the tree they think it did — and what it does not speak to, so a pass is not read as the
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
