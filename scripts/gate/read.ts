/**
 * Reading the repository: the gate's file and text helpers, and nothing that decides anything.
 *
 * WHY THESE ARE A MODULE. Every function here answers a question about a file or a string —
 * which files git tracks, what a source says with its comments removed, where one function's
 * body ends. None of them knows what a check is, none holds state beyond one cache, and
 * `scripts/gate.ts` was carrying all of them.
 *
 * `check` lives in `run.ts`, not here and no longer in the entry file. This paragraph used
 * to say it deliberately stayed behind, because the check keeping STATE.md's declared total
 * honest counted `^check(` in the entry file — which was true until every check moved into
 * `gate/checks/` and the count had to be taken across the modules instead. `gateCheckNames`
 * below is that count, and it is the reason a stale sentence here would have been expensive:
 * it described the mechanism a reader was being asked to trust.
 *
 * `root` is computed here rather than passed. This directory sits under `scripts/`, so the
 * repository root is two levels up, and a helper that took it as an argument would let two
 * callers disagree about where the repository is.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// THE COMPILER'S OWN PARSER, for `isGateLaunchSource` below. It is already this repository's
// typechecker (`npm run build`, `npm run typecheck:tooling`) and already a devDependency, so
// nothing new is installed to read a syntax tree — and the alternative, another regular
// expression over source text, is the thing that function exists to stop being.
import ts from "typescript";

const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/;

const REGEX = /(?<=[=(,:[!&|?{};]\s*)\/(?![*\/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^\/\\\n])+\/[dgimsuvy]*/;


export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A JSON file's parsed contents, honestly `unknown` — every caller reads a specific file
 *  whose shape it alone knows, and asserting one shape here would be a cast wearing this
 *  function's name. Narrow with {@link asRecord} at the call site. */
export const readJson = (p: string): unknown => JSON.parse(readFileSync(join(root, p), "utf8"));

/** A JSON value narrowed to a plain object, for a caller that needs to read a named field
 *  without asserting the whole shape. `label` names the file in the error, because a JSON
 *  file that does not parse to an object is a real defect and should say which one. */
export function asRecord(v: unknown, label: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${label} did not parse to an object`);
  }
  return v as Record<string, unknown>;
}

/** A SUBJECT'S WHOLE SOURCE, AS ONE TEXT — the five below and nothing else read this way.
 *
 * WHY THESE EXIST. Fifty-six checks read `services/zz-core/src/server.ts` by path, so the
 * first time a function moved out of it — 308 lines of pure document rules, into a module a
 * test can finally reach — nine of them went red at once. None of those nine was about
 * server.ts; each was about a RULE that happens to live in zz-core, and a rule does not stop
 * being enforced because it moved file. The gateway repeated it exactly: seventeen red at
 * once when its credential store, access door and block proxy became modules, and not one of
 * them was a defect.
 *
 * So a check that asks "does zz-core do X" asks it of zz-core, not of one file in it — and a
 * check that genuinely means the entry file (the tool registry, the transport, the middleware
 * order) still names that file, and should.
 *
 * ONE FUNCTION, FIVE NAMES. These were five copies of the same two lines, which is the
 * duplication this gate refuses everywhere else; `also` is there because two of the five have
 * an entry file that does not sit in the directory the modules do.
 */
const subjectSource = (dirs: string[], exts: string[], also: string[] = []) => (): string =>
  [...also, ...sourceFiles(dirs, exts)]
    .map((f) => readFileSync(join(root, f), "utf8")).join("\n");

export const zzCoreSource = subjectSource(["services/zz-core/src"], [".ts"]);
export const gatewaySource = subjectSource(["services/gateway/src"], [".ts"]);
export const contractsSource = subjectSource(["packages/contracts/src"], [".ts"]);
export const catalogSource = subjectSource(["packages/catalog/src"], [".ts"]);
export const consoleSource = subjectSource(["services/gateway/src/console"], [".ts"],
  ["services/gateway/src/console.ts"]);
// THE RELEASE INCLUDES THE DEPLOYMENT DESCRIPTION IT IS BUILT ON. scripts/deployment.ts holds
// the address, the image names and the protocol reader — facts the release both uses and is
// judged on ("does the release pin a build platform", "can it read the protocol it announces").
// When they moved out of scripts/release/config.ts, two checks here went red and one of them
// said "release.ts no longer defines mcpProtocol — this check cannot run" rather than passing,
// which is the only reason the move was safe to make.
export const releaseSource = subjectSource(["scripts/release"], [".ts"],
  ["scripts/release.ts", "scripts/deployment.ts"]);

/** The doctor as one text — its order, its runner, its layers, and the same deployment
 *  description. Sixth of these, and the argument has not changed: a check that asks what the
 *  DOCTOR does asks it of the doctor, not of whichever module a probe happens to sit in. */
export const doctorSource = subjectSource(["scripts/doctor"], [".ts"],
  ["scripts/doctor.ts", "scripts/deployment.ts"]);

/**
 * The gate's own source, which no check that scans the repository may read as evidence.
 *
 * Every check has to SPELL the pattern it hunts for — the credential path, the IPv4-mapped
 * fold, the envelope's own vocabulary — so a check that walks this repository finds its own
 * text and reports the gate for the thing the gate exists to forbid. Seven checks carried
 * `f === "scripts/gate.ts"` for exactly that reason, one copy each, which is the
 * duplication this gate refuses everywhere else. When the checks moved into modules all
 * seven went red at once and not one of them was about a real defect.
 *
 * NOT a general exemption. It says the gate's own text is not evidence ABOUT THE PLATFORM.
 * A rule the platform breaks is still caught, because platform code is not under this path.
 */
export const gateOwnSource = (rel: string): boolean =>
  rel === "scripts/gate.ts" || rel.startsWith("scripts/gate/");

/** The captured text of a `check("…")` title read as SOURCE, turned into the string the check
 *  actually registers. One title in this gate is written `"the console\'s version …"` — a
 *  backslash a double-quoted literal does not need and JavaScript drops — so the name read off
 *  the file and the name `check()` was called with differed by one character. Nothing noticed
 *  while the only question asked of this list was how LONG it is; the execution report asks
 *  which names ran, and that comparison reported a check that ran as skipped. */
const asWritten = (raw: string): string =>
  raw.replace(/\\(.)/g, (_, ch: string) => ({ n: "\n", t: "\t", r: "\r" }[ch] ?? ch));

/**
 * Every check this gate registers, by name, in the order the modules declare them.
 *
 * Two checks and the report ask about the gate's own inventory — how many checks it has,
 * what they are called, and whether every module that wrote one is actually imported. All
 * three could read a single file until 2026-09-11; none of them can now, and a check that
 * kept reading `scripts/gate.ts` would find nothing there and pass on an empty set, which
 * is the quietest way a self-referential check can stop working.
 */
export const gateCheckNames = (): string[] =>
  sourceFiles(["scripts/gate/checks"], [".ts"])
    .flatMap((f) => [...readFileSync(join(root, f), "utf8").matchAll(/^check\("(.+?)",/gm)]
      .map((m) => asWritten(m[1])));

// ── classifying a check file: does it LAUNCH the gate, or only talk about launching it ──────
//
// A check that spawns `scripts/gate.ts` is a break-test: registering one makes the gate invoke
// itself, forever. Registration therefore has to tell the two kinds apart, and it used to do it
// with a regular expression over the file's text with comments stripped. That regex was wrong
// in both directions on files this repository actually contains.
//
// FALSE POSITIVE, measured: `chain-check-wiring.ts` READS `scripts/gate.ts` to ask what the gate
// is wired to, and names `execFileSync|spawnSync|execSync` inside its own pattern. Both halves
// of "a spawner, and the gate's path" were true of a file that spawns nothing, and exempting it
// would have taken a registered, working check out of the gate on a coincidence. The regex was
// then narrowed to "the path INSIDE the call", which fixed that one file and is still text.
//
// FALSE NEGATIVE, structural: the same narrowing cannot see `const launch = spawnSync` or an
// argument built one line above the call, and it cannot see that a `gate` word inside a string
// literal or a regex literal is data. Stripping comments only removes one of the three places a
// word can hide. This function reads the SYNTAX instead: a call expression whose callee actually
// resolves to a `node:child_process` launcher through the file's own imports, and whose
// statically-resolvable arguments actually name this repository's gate.
//
// IT IS PURE AND IMPORT-SAFE — one string in, one boolean out, no filesystem and no process — so
// `checks/tenant-checks-registered.ts` can import it and drive it over source fixtures.

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
 * WHAT IT DOES NOT SEE, named rather than implied: a launcher reached through `require()`, a
 * command assembled at runtime, or a spawn of something that spawns the gate. Static analysis
 * cannot prove those absent, which is why `scripts/gate.ts` ALSO carries a runtime guard that
 * refuses a nested gate before it writes anything.
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
 * "What counts as part of the repository" is a question the repository already answers, and
 * answering it any other way is how a gate fails over a file .gitignore excludes — which this
 * one has done, over a .DS_Store, in a check that was not wrong about the code and was wrong
 * about the repo. `runs/` and `docs/support/` are ignored and hold eighteen Python files from
 * the harness the smoke engine replaced; a check walking the tree finds them and has no reason
 * to think they are not ours.
 */
let TRACKED: Set<string> | null | undefined;

export function trackedFiles(): Set<string> | null {
  if (TRACKED !== undefined) return TRACKED;
  try {
    // Tracked AND untracked-but-not-ignored: everything .gitignore does not exclude. Tracked
    // alone would hide a file somebody has written and not yet added — the gate would pass,
    // they would commit, and CI would fail on the file the gate had declined to look at,
    // which is a worse loop than the one this fixes.
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
 * Checks here kept naming the three or four files somebody had in mind, and every one of
 * those lists has since been found short: the owned-fields check missed the file that emits
 * the router every client reads, the vocabulary check missed a tool that spelled the statuses
 * out, the date check looked at tool descriptions and not at skills. A list is the instances;
 * this is how a check says what it is actually about.
 */
export function sourceFiles(dirs: string[], suffixes: string[]): string[] {
  const tracked = trackedFiles();
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      // Any dot-entry, not the three that happened to hurt. `.DS_Store` already taught this
      // gate what counts as part of the repository, in a check that failed over a file
      // .gitignore excludes and git has never tracked.
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

/** The one sentence every RUN-something check gives when there is nothing to run. */
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
 * Three checks capped their output silently. A port that dragged forty ghost citations across
 * looked like one that dragged eight: the reader fixes those, re-runs, and is surprised —
 * which is the same shape as a listing that quietly omits things, the thing this repository
 * refuses everywhere else. A cap is fine; a cap that does not report itself is not.
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
 * Two things kept going wrong at each site that did this by hand. The name is written on the
 * same line as `registerTool(` for most tools and on the next line for the rest, and a regex
 * demanding the first form silently skipped the others — `knowledge_reindex` is written the
 * second way, and was invisible to both store-mutation checks for that reason. And the body was taken with
 * `indexOf("registerTool(", …)`, which returns -1 at the LAST tool, so `slice(from, -1)` gave
 * it the whole rest of the file: a mutating tool added at the end of a server would find some
 * other tool's writeGuard and pass.
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
 * A TypeScript function's BODY, lifted from source and stripped of its annotations, ready for
 * `new Function`. Null when the function is gone — which every caller reports rather than
 * quietly stopping.
 *
 * Two checks run a zz-core function on the input that broke it, because the properties they
 * hold are about what the code DOES and no arrangement of its source proves them. Source
 * rather than dist, for the reason NAMING gives: the gate runs before `tsc -b` necessarily
 * has produced anything.
 *
 * FINDING THE BODY IS THE WHOLE DIFFICULTY, and it went wrong twice in two different ways.
 * The first `{` after the name is not the body when the signature carries an inline object —
 * normalizeSections returns `{ content: string; renamed: string[] }` and envelopeFor takes
 * `opts: { flow?: string; ... }`, so a naive lifter extracted a TYPE, produced a callable
 * that parsed, and failed at run time with `renamed is not defined`. Then a fix that advanced
 * only when the next non-space character was `{` handled the return type and not the
 * parameter one, where `,\n): string {` sits in between.
 *
 * So: keep advancing while the gap between one block and the next contains ONLY what a
 * signature can contain. A gap holding `(`, `=` or a comment is a real statement, and the
 * block before it was the body.
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
 * Every tool zz-core registers, with its handler body, extracted FILE BY FILE.
 *
 * NOT `toolsIn(zzCoreSource())`, and the difference has already cost a false finding. A tool
 * body runs to the next `registerTool(`, so the LAST tool in a file has none after it and its
 * body runs to the end of whatever it was concatenated with — `source_list` was reported as
 * judging a document without resolving its path, on evidence that belonged to the module that
 * happened to sort next. Bounded per file that cannot happen, which is also what lets the
 * registrations live in more than one file.
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
 * The text between two markers, or null with a reason.
 *
 * Written as `src.slice(src.indexOf(a), src.indexOf(b))`, the end marker is searched from the
 * START OF THE FILE. When it happens to sit after the first, the slice is right — by luck.
 * Put another `// ------` band above cred-manage and the access-door check slices backwards,
 * finds no tools, and passes having examined nothing.
 *
 * Both markers must be present and in order, and a check that cannot find its region says so
 * instead of quietly checking an empty string.
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

/** Comments gone, string literals INTACT — for a rule that looks for a literal. The strings
 * still have to be matched, or a `//` inside one is read as a comment; they are simply put
 * back rather than blanked. */
export const withoutComments = (src: string): string =>
  src.replace(new RegExp(`${REGEX.source}|${COMMENTS.source}|${STRINGS.source}`, "g"),
              (m) => (/^["'`]/.test(m) || (m.startsWith("/") && !m.startsWith("//") && !m.startsWith("/*"))
                        ? m : blankRun(m)));

/** ONLY the comments, everything else blanked — the inverse of `withoutComments`, for a rule
 * about what a source SAYS rather than what it does. A comment is prose: it is read by the
 * next person exactly as a skill is, and a comment naming a tool nobody registers misleads
 * them exactly as a skill would.
 *
 * The SAME one alternation, so a `//` inside a string is still a string and a quote inside a
 * regex character class still cannot open one — and BLANKED, not deleted, so a line number
 * taken from the result is the line somebody opens.
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
 * TWO shapes, because this codebase has two and both are findable: `process.env.NAME`, and
 * `envRequired("NAME", …)` — lib/cli.ts's accessor, which exists so a missing variable
 * produces one sentence rather than eight different ones. It reads `process.env[name]`
 * internally, so a check grepping for the dotted form alone could not see ZZ_PAT,
 * ZZ_GATEWAY or LC_PASSWORD in any tool that uses it. zz-tool forwards all three; it
 * forwards them because somebody remembered, and the check that is supposed to guarantee it
 * was passing on the ones nobody had to remember.
 */
const ENV_READ = /process\.env\.([A-Z][A-Z_0-9]*)|envRequired\(\s*"([A-Z][A-Z_0-9]*)"/g;

export function envNamesIn(text: string): string[] {
  return [...text.matchAll(ENV_READ)].map((m) => m[1] ?? m[2]);
}
