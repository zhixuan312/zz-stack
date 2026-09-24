/**
 * Reading the repository: the gate's file and text helpers, and nothing that decides anything.
 *
 * Every function answers a question about a file or a string. None of them knows what a check is,
 * and none holds state beyond one cache.
 *
 * `gateCheckNames` below reads the gate's checks across the modules in `scripts/gate/checks/`.
 * `root` is computed here rather than passed, so two callers cannot disagree about where the
 * repository is.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The compiler's own parser, for `isGateLaunchSource` below. It is already this repository's
// typechecker and already a devDependency, so nothing new is installed to read a syntax tree.
import ts from "typescript";

const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/;

const REGEX = /(?<=[=(,:[!&|?{};]\s*)\/(?![*\/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^\/\\\n])+\/[dgimsuvy]*/;


export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A JSON file's parsed contents, honestly `unknown` — every caller reads a specific file whose
 *  shape it alone knows. Narrow with {@link asRecord} at the call site. */
export const readJson = (p: string): unknown => JSON.parse(readFileSync(join(root, p), "utf8"));

/** A JSON value narrowed to a plain object, for a caller that needs one named field without
 *  asserting the whole shape. `label` names the file in the error. */
export function asRecord(v: unknown, label: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${label} did not parse to an object`);
  }
  return v as Record<string, unknown>;
}

/** A subject's whole source, as one text — the subjects below and nothing else read this way.
 *
 * A check that asks "does zz-core do X" asks it of zz-core, not of one file in it, so a rule moving
 * between modules does not turn it red. A check that genuinely means the entry file still names it.
 * `also` is for the subjects whose entry file does not sit in the directory the modules do. */
const subjectSource = (dirs: string[], exts: string[], also: string[] = []) => (): string =>
  [...also, ...sourceFiles(dirs, exts)]
    .map((f) => readFileSync(join(root, f), "utf8")).join("\n");

export const zzCoreSource = subjectSource(["services/zz-core/src"], [".ts"]);
export const gatewaySource = subjectSource(["services/gateway/src"], [".ts"]);
export const contractsSource = subjectSource(["packages/contracts/src"], [".ts"]);
export const catalogSource = subjectSource(["packages/catalog/src"], [".ts"]);
export const consoleSource = subjectSource(["services/gateway/src/console"], [".ts"],
  ["services/gateway/src/console.ts"]);
// The release includes the deployment description it is built on: scripts/deployment.ts holds
// the address, the image names and the protocol reader, which the release both uses and is
// judged on.
export const releaseSource = subjectSource(["scripts/release"], [".ts"],
  ["scripts/release.ts", "scripts/deployment.ts"]);

/** The doctor as one text — its order, its runner, its layers, and the same deployment
 *  description. A check that asks what the doctor does asks it of the doctor, not of whichever
 *  module a probe happens to sit in. */
export const doctorSource = subjectSource(["scripts/doctor"], [".ts"],
  ["scripts/doctor.ts", "scripts/deployment.ts"]);

/**
 * The gate's own source, which no check that scans the repository may read as evidence: every check
 * spells the pattern it hunts for, so a check walking this repository finds its own text and
 * reports the gate for the thing the gate exists to forbid.
 *
 * Not a general exemption — platform code is not under this path.
 */
export const gateOwnSource = (rel: string): boolean =>
  rel === "scripts/gate.ts" || rel.startsWith("scripts/gate/");

/** The captured text of a `check("…")` title read as source, turned into the string the check
 *  actually registers. A title carrying a backslash a double-quoted literal does not need reads
 *  off the file one character different from the name `check()` was called with, and the
 *  execution report compares those names. */
const asWritten = (raw: string): string =>
  raw.replace(/\\(.)/g, (_, ch: string) => ({ n: "\n", t: "\t", r: "\r" }[ch] ?? ch));

/**
 * Every check this gate registers, by name, in the order the modules declare them. Read across
 * `scripts/gate/checks/`, because two checks and the report ask about the gate's own inventory and
 * a self-referential check pointed at a file that registers nothing passes on an empty set.
 */
export const gateCheckNames = (): string[] =>
  sourceFiles(["scripts/gate/checks"], [".ts"])
    .flatMap((f) => [...readFileSync(join(root, f), "utf8").matchAll(/^check\("(.+?)",/gm)]
      .map((m) => asWritten(m[1])));

// Classifying a check file: does it launch the gate, or only talk about launching it? A check that
// spawns `scripts/gate.ts` is a break-test, and registering one makes the gate invoke itself
// forever.
//
// DELIBERATE: this reads the syntax, not the text. No text rule sees `const launch = spawnSync`, an
// argument built one line above the call, or that a `gate` word inside a string or regex literal is
// data — and a file naming `execFileSync` and the gate's path inside its own pattern spawns nothing.
//
// Pure and import-safe, so `checks/tenant-checks-registered.ts` drives it over source fixtures.

const CHILD_PROCESS_SPECIFIERS = new Set(["child_process", "node:child_process"]);
const LAUNCHERS = new Set(["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]);

/** `npm run gate` and `node scripts/gate.ts` are the two spellings this repository's break-tests
 *  actually use, in either the argv-array form or one whole command line in a single string. */
function literalsNameTheGate(literals: readonly string[]): boolean {
  const flat = literals.map((l) => l.trim());
  const isGatePath = (word: string): boolean => /(^|\/)scripts\/gate\.ts$/.test(word);
  const isNpm = (word: string): boolean => /(^|\/)npm(\.cmd)?$/.test(word);
  for (const text of flat) {
    if (isGatePath(text)) return true;
    const words = text.split(/\s+/);
    if (words.length < 2) continue;                       // a bare argv entry, judged below
    if (words.some(isGatePath)) return true;
    if (words.some((w, i) => w === "run" && words[i + 1] === "gate" && isNpm(words[i - 1] ?? ""))) return true;
  }
  // The argv-array form: the program in one argument, `run` and `gate` in the next. `gate` is
  // compared whole — `checks/gate-catches-unregistered.ts` is an argument this must not match.
  if (!flat.some(isNpm)) return false;
  return flat.some((w, i) => w === "run" && flat[i + 1] === "gate");
}

/**
 * Whether `sourceText` — one TypeScript/JavaScript module's source — actually launches this
 * repository's gate as a child process.
 *
 * A word in a comment, a string or a regex literal is data and never counts; a call is counted
 * only when its callee resolves through this module's own imports to a `node:child_process`
 * launcher (named, aliased, namespace or default) and its arguments, resolved through
 * single-assignment `const` string/array bindings in the same file, name `npm run gate` or
 * `scripts/gate.ts`.
 *
 * What it does not see: a launcher reached through `require()`, a command assembled at runtime,
 * or a spawn of something that spawns the gate. COUPLED: `scripts/gate.ts` carries the runtime
 * guard that refuses a nested gate before it writes anything.
 */
export function isGateLaunchSource(sourceText: string): boolean {
  const source = ts.createSourceFile("gate-launch-probe.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  // Pass one: what the file's own imports call the launchers, and which `const` names hold
  // statically-known strings.
  const launcherLocals = new Map<string, string>();   // local name → child_process export
  const namespaceLocals = new Set<string>();          // `import * as cp` / default import of the module
  const constStrings = new Map<string, string[]>();

  const stringOf = (node: ts.Node): string | null =>
    ts.isStringLiteralLike(node) ? node.text
      : ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;

  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && CHILD_PROCESS_SPECIFIERS.has(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) namespaceLocals.add(clause.name.text);          // default import of a CJS module
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaceLocals.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const exported = (element.propertyName ?? element.name).text;
          if (LAUNCHERS.has(exported)) launcherLocals.set(element.name.text, exported);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const single = stringOf(node.initializer);
      if (single !== null) constStrings.set(node.name.text, [single]);
      else if (ts.isArrayLiteralExpression(node.initializer)) {
        const parts = node.initializer.elements.map(stringOf).filter((s): s is string => s !== null);
        if (parts.length > 0) constStrings.set(node.name.text, parts);
      }
      // `const launch = spawnSync` — an alias made by assignment rather than by import.
      else if (ts.isIdentifier(node.initializer) && launcherLocals.has(node.initializer.text)) {
        launcherLocals.set(node.name.text, launcherLocals.get(node.initializer.text)!);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  // Pass two: every call whose callee is one of those launchers, read for what it actually runs.
  let launches = false;
  const literalsUnder = (node: ts.Node, out: string[]): string[] => {
    const single = stringOf(node);
    if (single !== null) out.push(single);
    else if (ts.isIdentifier(node)) out.push(...(constStrings.get(node.text) ?? []));
    else ts.forEachChild(node, (child) => { literalsUnder(child, out); });
    return out;
  };
  const isLauncherCallee = (callee: ts.Expression): boolean => {
    if (ts.isIdentifier(callee)) return launcherLocals.has(callee.text);
    return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
      && namespaceLocals.has(callee.expression.text) && LAUNCHERS.has(callee.name.text);
  };
  const inspect = (node: ts.Node): void => {
    if (!launches && ts.isCallExpression(node) && isLauncherCallee(node.expression)) {
      const literals: string[] = [];
      for (const argument of node.arguments) literalsUnder(argument, literals);
      if (literalsNameTheGate(literals)) launches = true;
    }
    if (!launches) ts.forEachChild(node, inspect);
  };
  inspect(source);
  return launches;
}

/**
 * What git tracks, or null outside a checkout.
 *
 * "What counts as part of the repository" is a question the repository already answers, and walking
 * the tree instead finds what .gitignore excludes, such as `runs/` and `docs/support/`.
 */
let TRACKED: Set<string> | null | undefined;

export function trackedFiles(): Set<string> | null {
  if (TRACKED !== undefined) return TRACKED;
  try {
    // Tracked and untracked-but-not-ignored: everything .gitignore does not exclude. Tracked
    // alone hides a file somebody has written and not yet added, so the gate passes, they commit,
    // and CI fails on the file the gate declined to look at.
    TRACKED = new Set(execFileSync(
      "git", ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean));
    if (TRACKED.size === 0) TRACKED = null;
  } catch {
    TRACKED = null;   // a tarball, or no git: fall back to the tree itself
  }
  return TRACKED;
}

/**
 * Every file under `dirs` whose name ends in one of `suffixes`, repo-relative.
 *
 * A check that names the three or four files somebody had in mind states the instances; this is
 * how a check says what it is actually about.
 */
export function sourceFiles(dirs: string[], suffixes: string[]): string[] {
  const tracked = trackedFiles();
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      // DELIBERATE: every dot-entry is skipped, not only the ones that have caused trouble.
      if (["node_modules", "dist"].includes(e.name) || e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (suffixes.some((x) => e.name.endsWith(x))) {
        const rel = full.slice(root.length + 1);
        if (!tracked || tracked.has(rel)) out.push(rel);
      }
    }
  };
  for (const d of dirs) walk(join(root, d));
  return out.sort();
}

/** The one sentence every run-something check gives when there is nothing to run. */
export function unbuilt() {
  for (const d of ["packages/contracts/dist", "packages/tools/dist", "services/gateway/dist"]) {
    if (!existsSync(join(root, d))) {
      return `${d} does not exist — this check runs the compiled code rather than reading it, ` +
             "and `tsc -b` above says why there is none";
    }
  }
  return null;
}

/**
 * The first `n` findings, and how many were not shown.
 *
 * A cap is fine; a cap that does not report itself makes forty findings look like eight.
 */
export function firstOf(findings: string[], n = 8): string | null {
  const all = [...new Set(findings)];
  if (all.length === 0) return null;
  return all.slice(0, n).join("; ") +
    (all.length > n ? ` — and ${all.length - n} more not listed` : "");
}

/** One `registerTool(...)` call, its name and the span of source its handler runs across. */
interface ToolMatch {
  name: string;
  from: number;
  to: number;
  body: string;
}

/**
 * Every tool a source registers, with its handler body, in order.
 *
 * The name is written on the same line as `registerTool(` for most tools and on the next line
 * for the rest, and both forms are matched. A body runs to the next `registerTool(`, or to the
 * end of the source for the last tool in it.
 */
export function toolsIn(src: string): ToolMatch[] {
  const starts = [...src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)];
  return starts.map((m, i) => {
    const from = m.index;
    const to = i + 1 < starts.length ? starts[i + 1].index : src.length;
    return { name: m[1], from, to, body: src.slice(from, to) };
  });
}

/** The store's own one-line rule, for checks that run an envelope writer. Built here rather
 * than written into the generated source, where a regex is escaped once too often. */
export const ONE_LINE = (v: unknown): string => String(v).replace(/[\r\n]+/g, " ").trim();

/**
 * A TypeScript function's body, lifted from source and stripped of its annotations, ready for
 * `new Function`. Null when the function is gone, which every caller reports. Source rather than
 * dist, because the gate runs before `tsc -b` has necessarily produced anything.
 *
 * The first `{` after the name is not the body when the signature carries an inline object, so this
 * keeps advancing while the gap between one block and the next contains only what a signature can
 * contain. A gap holding `(`, `=` or a comment is a real statement, and the block before it was the
 * body.
 */
export function functionBody(src: string, name: string): string | null {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return null;
  const close = (from: number): number => {
    let depth = 0;
    for (let i = from; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return i;
    }
    return -1;
  };
  let open = src.indexOf("{", at);
  if (open < 0) return null;
  // NOT A TOOL: `close` here is the local brace-matcher declared just above — it finds the
  // closing brace of a block and has nothing to do with the tool that ends an initiative.
  let end = close(open);
  for (;;) {
    if (end < 0) return null;
    const next = src.indexOf("{", end + 1);
    if (next < 0 || !/^[\s,):|<>\[\]A-Za-z0-9_.?]*$/.test(src.slice(end + 1, next))) break;
    open = next;
    end = close(open);   // NOT A TOOL: the local brace-matcher, as above
  }
  return src.slice(open + 1, end)
    .replace(/:\s*Record<string, string>/g, "")
    .replace(/:\s*string\[\]/g, "")
    .replace(/:\s*string \| null/g, "")
    .replace(/:\s*string/g, "");
}

/**
 * Every tool zz-core registers, with its handler body, extracted file by file.
 *
 * DELIBERATE: not `toolsIn(zzCoreSource())`. A tool body runs to the next `registerTool(`, so the
 * last tool in a concatenation takes the next module's text as its body and is judged on evidence
 * that is not its own.
 */
export function zzCoreTools() {
  return sourceFiles(["services/zz-core/src"], [".ts"])
    .flatMap((f) => toolsIn(readFileSync(join(root, f), "utf8")).map((t) => ({ ...t, file: f })));
}

/** The tool whose handler contains this line, or null. */
export function toolAtLine(src: string, lineNo: number): string | null {
  const offset = src.split("\n").slice(0, lineNo).join("\n").length;
  return toolsIn(src).find((t) => offset >= t.from && offset < t.to)?.name ?? null;
}

/**
 * The text between two markers, or null with a reason. The end marker is searched from after the
 * start marker: searched from the start of the file it can land before it, and the slice then runs
 * backwards to an empty string a caller passes on having examined nothing. Both markers must be
 * present and in order, and a check that cannot find its region says so.
 */
export function between(src: string, startMark: string, endMark?: string): { text: string | null; why: string | null } {
  const from = src.indexOf(startMark);
  if (from < 0) return { text: null, why: `the marker ${JSON.stringify(startMark)} is gone` };
  const to = endMark === undefined ? src.length : src.indexOf(endMark, from + startMark.length);
  if (to < 0) return { text: null, why: `${JSON.stringify(endMark)} does not follow ${JSON.stringify(startMark)}` };
  return { text: src.slice(from, to), why: null };
}


const STRINGS = /`(?:[^`\\]|\\[\s\S])*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/;


const blankRun = (m: string): string => "\n".repeat((m.match(/\n/g) ?? []).length);

export const scan = (src: string, parts: RegExp[]): string =>
  src.replace(new RegExp([REGEX, ...parts].map((r) => r.source).join("|"), "g"),
              (m) => (m.startsWith("/") && !m.startsWith("//") && !m.startsWith("/*") ? m : blankRun(m)));

/** Comments gone, string literals intact — for a rule that looks for a literal. The strings are
 * still matched, or a `//` inside one is read as a comment; they are put back rather than
 * blanked. */
export const withoutComments = (src: string): string =>
  src.replace(new RegExp(`${REGEX.source}|${COMMENTS.source}|${STRINGS.source}`, "g"),
              (m) => (/^["'`]/.test(m) || (m.startsWith("/") && !m.startsWith("//") && !m.startsWith("/*"))
                        ? m : blankRun(m)));

/** Only the comments, everything else blanked — the inverse of `withoutComments`, for a rule
 * about what a source says rather than what it does.
 *
 * The same one alternation, so a `//` inside a string is still a string and a quote inside a
 * regex character class cannot open one. Blanked, not deleted, so a line number taken from the
 * result is the line somebody opens.
 */
export const commentsOnly = (src: string): string => {
  const re = new RegExp(`${REGEX.source}|${COMMENTS.source}|${STRINGS.source}`, "g");
  let out = "", last = 0;
  for (const m of src.matchAll(re)) {
    out += blankRun(src.slice(last, m.index));
    out += m[0].startsWith("//") || m[0].startsWith("/*") ? m[0] : blankRun(m[0]);
    last = m.index + m[0].length;
  }
  return out + blankRun(src.slice(last));
};

/** Comments and string literals both gone — for a rule that reads structure. */
export const codeOnly = (src: string): string => scan(src, [COMMENTS, STRINGS]);

/**
 * Every environment variable a source reads, by name.
 *
 * Two shapes, because this codebase has both: `process.env.NAME`, and `envRequired("NAME", …)` —
 * lib/cli.ts's accessor, which reads `process.env[name]` internally and is therefore invisible
 * to a check grepping for the dotted form alone.
 */
const ENV_READ = /process\.env\.([A-Z][A-Z_0-9]*)|envRequired\(\s*"([A-Z][A-Z_0-9]*)"/g;

export function envNamesIn(text: string): string[] {
  return [...text.matchAll(ENV_READ)].map((m) => m[1] ?? m[2]);
}
