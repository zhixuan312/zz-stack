/**
 * Reading the repository: the gate's file and text helpers, and nothing that decides anything.
 *
 * WHY THESE ARE A MODULE. Every function here answers a question about a file or a string —
 * which files git tracks, what a source says with its comments removed, where one function's
 * body ends. None of them knows what a check is, none holds state beyond one cache, and
 * `scripts/gate.mjs` was carrying all of them.
 *
 * `check` lives in `run.mjs`, not here and no longer in the entry file. This paragraph used
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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

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
const subjectSource = (dirs, exts, also = []) => () =>
  [...also, ...sourceFiles(dirs, exts)]
    .map((f) => readFileSync(join(root, f), "utf8")).join("\n");

export const zzCoreSource = subjectSource(["services/zz-core/src"], [".ts"]);
export const gatewaySource = subjectSource(["services/gateway/src"], [".ts"]);
export const contractsSource = subjectSource(["packages/contracts/src"], [".ts"]);
export const consoleSource = subjectSource(["services/gateway/src/console"], [".ts"],
  ["services/gateway/src/console.ts"]);
// THE RELEASE INCLUDES THE DEPLOYMENT DESCRIPTION IT IS BUILT ON. scripts/deployment.mjs holds
// the address, the image names and the protocol reader — facts the release both uses and is
// judged on ("does the release pin a build platform", "can it read the protocol it announces").
// When they moved out of scripts/release/config.mjs, two checks here went red and one of them
// said "release.mjs no longer defines mcpProtocol — this check cannot run" rather than passing,
// which is the only reason the move was safe to make.
export const releaseSource = subjectSource(["scripts/release"], [".mjs"],
  ["scripts/release.mjs", "scripts/deployment.mjs"]);

/** The doctor as one text — its order, its runner, its layers, and the same deployment
 *  description. Sixth of these, and the argument has not changed: a check that asks what the
 *  DOCTOR does asks it of the doctor, not of whichever module a probe happens to sit in. */
export const doctorSource = subjectSource(["scripts/doctor"], [".mjs"],
  ["scripts/doctor.mjs", "scripts/deployment.mjs"]);

/**
 * The gate's own source, which no check that scans the repository may read as evidence.
 *
 * Every check has to SPELL the pattern it hunts for — the credential path, the IPv4-mapped
 * fold, the envelope's own vocabulary — so a check that walks this repository finds its own
 * text and reports the gate for the thing the gate exists to forbid. Seven checks carried
 * `f === "scripts/gate.mjs"` for exactly that reason, one copy each, which is the
 * duplication this gate refuses everywhere else. When the checks moved into modules all
 * seven went red at once and not one of them was about a real defect.
 *
 * NOT a general exemption. It says the gate's own text is not evidence ABOUT THE PLATFORM.
 * A rule the platform breaks is still caught, because platform code is not under this path.
 */
export const gateOwnSource = (rel) =>
  rel === "scripts/gate.mjs" || rel.startsWith("scripts/gate/");

/**
 * Every check this gate registers, by name, in the order the modules declare them.
 *
 * Two checks and the report ask about the gate's own inventory — how many checks it has,
 * what they are called, and whether every module that wrote one is actually imported. All
 * three could read a single file until 2026-09-11; none of them can now, and a check that
 * kept reading `scripts/gate.mjs` would find nothing there and pass on an empty set, which
 * is the quietest way a self-referential check can stop working.
 */
export const gateCheckNames = () =>
  sourceFiles(["scripts/gate/checks"], [".mjs"])
    .flatMap((f) => [...readFileSync(join(root, f), "utf8").matchAll(/^check\("(.+?)",/gm)]
      .map((m) => m[1]));

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
let TRACKED = undefined;

export function trackedFiles() {
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
export function sourceFiles(dirs, suffixes) {
  const tracked = trackedFiles();
  const out = [];
  const walk = (d) => {
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
export function firstOf(findings, n = 8) {
  const all = [...new Set(findings)];
  if (all.length === 0) return null;
  return all.slice(0, n).join("; ") +
    (all.length > n ? ` — and ${all.length - n} more not listed` : "");
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
export function toolsIn(src) {
  const starts = [...src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)];
  return starts.map((m, i) => {
    const from = m.index;
    const to = i + 1 < starts.length ? starts[i + 1].index : src.length;
    return { name: m[1], from, to, body: src.slice(from, to) };
  });
}

/** The store's own one-line rule, for checks that run an envelope writer. Built here rather
 * than written into the generated source, where a regex is escaped once too often. */
export const ONE_LINE = (v) => String(v).replace(/[\r\n]+/g, " ").trim();

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
export function functionBody(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return null;
  const close = (from) => {
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
export function toolAtLine(src, lineNo) {
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
export function between(src, startMark, endMark) {
  const from = src.indexOf(startMark);
  if (from < 0) return { text: null, why: `the marker ${JSON.stringify(startMark)} is gone` };
  const to = endMark === undefined ? src.length : src.indexOf(endMark, from + startMark.length);
  if (to < 0) return { text: null, why: `${JSON.stringify(endMark)} does not follow ${JSON.stringify(startMark)}` };
  return { text: src.slice(from, to), why: null };
}

/**
 * Source with its COMMENTS blanked, and with its string literals blanked too for `codeOnly`.
 *
 * Four checks here each grew their own, and they did not agree. Two got it right the hard
 * way: one strips a `//` only when the whole line is a comment, "a mid-line strip cuts
 * http://rulemill… in half"; another checks whether the `//` sits inside a quote on that line.
 * Two got it wrong. The straight `line.replace(/\/\/.*$/, "")` cuts any URL, and a
 * comments-then-strings pass read the `//` in `"http://zz-core:8000/mcp"` as a comment, took
 * the closing quote with it, and let the string pass match from that stray quote across a
 * hundred lines — so everything after that literal was invisible to the rule, which went on
 * passing with a planted defect inside a handler it could no longer see.
 *
 * ONE ALTERNATION, scanned left to right, so whichever construct STARTS first consumes the
 * rest: a quote opened before a `//` swallows it, and a `//` outside a quote runs to the end
 * of the line. That is the whole rule, and it cannot be got half right.
 *
 * BLANKED, NOT DELETED: every newline inside a match is kept, so a line number taken from the
 * result is the line somebody opens. A stripped copy shorter than its file cites the wrong
 * line, which is the drift the citation rule here exists to stop.
 */
export const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/;

const STRINGS = /`(?:[^`\\]|\\[\s\S])*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/;

/** A REGEX LITERAL, consumed whole and BEFORE the strings.
 *
 * A character class may hold a lone quote — this file's own `/["'`]flow\.json/` holds two of
 * the three — and to a scanner that does not know it is inside a regex, that quote OPENS a
 * string. Everything up to the next matching quote is then read as one literal: measured
 * here, a `//` line nine lines below such a regex survived a strip untouched, and the rule
 * doing the stripping reported a defect against its own prose.
 *
 * Told apart from division by what precedes it. A regex can only START where a value can, so
 * the character before it is an operator, an opening bracket or a comma — never an
 * identifier, a digit or a closing paren, which is what division follows. */
export const REGEX = /(?<=[=(,:[!&|?{};]\s*)\/(?![*\/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^\/\\\n])+\/[dgimsuvy]*/;

const blankRun = (m) => "\n".repeat((m.match(/\n/g) ?? []).length);

export const scan = (src, parts) =>
  src.replace(new RegExp([REGEX, ...parts].map((r) => r.source).join("|"), "g"),
              (m) => (m.startsWith("/") && !m.startsWith("//") && !m.startsWith("/*") ? m : blankRun(m)));

/** Comments gone, string literals INTACT — for a rule that looks for a literal. The strings
 * still have to be matched, or a `//` inside one is read as a comment; they are simply put
 * back rather than blanked. */
export const withoutComments = (src) =>
  src.replace(new RegExp(`${REGEX.source}|${COMMENTS.source}|${STRINGS.source}`, "g"),
              (m) => (/^["'`]/.test(m) || (m.startsWith("/") && !m.startsWith("//") && !m.startsWith("/*"))
                        ? m : blankRun(m)));

/** Comments and string literals both gone — for a rule that reads structure. */
export const codeOnly = (src) => scan(src, [COMMENTS, STRINGS]);

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

export function envNamesIn(text) {
  return [...text.matchAll(ENV_READ)].map((m) => m[1] ?? m[2]);
}

/** Split an argument list on top-level commas — `load(), email, platform` is three, not two
 *  and a fragment. */
export const splitTopLevel = (text) => {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
