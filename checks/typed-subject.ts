#!/usr/bin/env node
// A subject is typed, and the ledger is keyed to a principal.
//
// FR-30 (the typed subject) and AC-59.1 (the ledger). Both are contracts the database enforces and
// nothing compiles: an `eval_assessment` row names its subject as a `subject_kind` plus the ONE
// child key that kind requires, and `eval_idempotency` is keyed by `(principal_id, tool,
// idempotency_key)` rather than by the address the call was made from.
//
// Both were broken in the same way — the migration moved and every reader and writer kept spelling
// the old shape. `002_catalog_evaluation.sql:1041-1155` replaces `eval_assessment.subject_ref` with
// six typed columns and adds the kind-shape CHECK that makes a wrong combination unwritable;
// `:1157-1180` replaces `eval_idempotency.principal` with `principal_id uuid not null`, re-keys the
// primary key and adds the foreign key. A statement still writing `principal` dies with `column
// "principal" does not exist` BEFORE its own work, which is how every `/eval` mutator was dead on a
// migrated database while this suite was green.
//
// Read, not run. The migration is plain SQL, so the constraint text is read directly; in the write
// trees a statement is the text of the string or template literal that carries it, found from the
// verb that opens it — `checks/insert-arity.ts` reads statements the same way, and
// `checks/dropped-columns.ts` carries the scanner this file's `literalAround` is a narrow form of.
//
// What is asserted, and why each half needs the other:
//
//   the shape the migration leaves   the five child columns and their foreign keys, the kind-shape
//                                    CHECK covering all six kinds and no seventh, one child per
//                                    kind and none for `run_level`, the subject key, and the
//                                    value/excluded_reason exclusivity.
//   the shape the writer writes      every `insert into zz.eval_assessment` in the write trees names
//                                    `subject_kind` and all five child columns, binds them from one
//                                    typed object rather than from a literal, and takes that object
//                                    from a per-kind resolver that sets exactly the one child its
//                                    kind names. A writer that guessed a kind would be refused by
//                                    the CHECK, and the row would be lost rather than recorded.
//   the ledger key                   the migration's new key, and every statement in
//                                    `eval/idempotency.ts` that touches the ledger naming
//                                    `principal_id` and never the retired `principal` column.
//
// DELIBERATE: the six kinds are read from the CHECK rather than listed here, and the columns each
// kind requires are read out of its own branch. A list in this file would agree with a CHECK that
// had been narrowed to five. `doc_revision` is deliberately not one of the five: it is a Phase-6
// pin on a `document` subject (AC-6.7), so a `document` branch that also requires it must not be
// read as a defect, and the branch parser ignores every term that is not one of the five child
// foreign keys.
//
// DELIBERATE: the roots are relative to `process.cwd()`, not to this file's own location, so the
// check can be pointed at a scratch tree that plants a violation. Run it from the repository root
// and it reads the repository.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The trees that write to a database — the same four `checks/dropped-columns.ts` scans. */
const ROOTS = ["services", "packages", "scripts", "deploy"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** The migration that gives the table this shape. `001_init.sql` creates `subject_ref` and
 *  `principal`; this is the file that retires both, so it is the one read for the target shape. */
const MIGRATION = "services/gateway/migrations/002_catalog_evaluation.sql";

/** The five child foreign keys, in the order the table declares them. `run_level` names none of
 *  them. `doc_revision` is not here: it is not a foreign key, and Phase 6 owns it. */
const CHILD_COLUMNS = ["run_id", "doc_id", "knowledge_node_id", "bug_id", "event_id"] as const;

/** What each child column references after this phase. `run_id` is the one that moved: the table it
 *  names was `zz.run` and is `zz.skill_run` now, and a foreign key still pointing at the old name
 *  would be refused by the server. */
const CHILD_TARGET: Record<string, string> = {
  run_id: "zz.skill_run",
  doc_id: "zz.doc",
  knowledge_node_id: "zz.knowledge_node",
  bug_id: "zz.bug",
  event_id: "zz.event",
};

const fail: string[] = [];
const read = (p: string): string => readFileSync(p, "utf8");

// ---------------------------------------------------------------------------------------------
// The migration's own text.
// ---------------------------------------------------------------------------------------------

let migration: string;
try {
  migration = read(MIGRATION);
} catch {
  console.error(`FAIL: ${MIGRATION} cannot be read — the migration this check reads the target ` +
                "shape from is not at that path");
  process.exit(1);
}

/** The text of one `add constraint <name> …` clause, up to the `;` that closes it. */
function constraint(name: string): string | null {
  const at = migration.indexOf(`add constraint ${name}`);
  if (at < 0) return null;
  const end = migration.indexOf(";", at);
  return end < 0 ? migration.slice(at) : migration.slice(at, end);
}

// Every kind branch of the kind-shape CHECK, as `<kind> -> the five columns it requires set`.
//
// The body is split on the only thing that starts a branch, so a branch that stops requiring its
// child — or that starts requiring two — is a change here rather than a string that still appears
// somewhere in the file. A literal that is not one of the five child columns (today: `doc_revision`)
// is parsed and dropped, which is what keeps this check out of Phase 6's way.
function kindBranches(body: string): Map<string, Set<string>> | null {
  // The leading branch opens with `(` and the rest with `or (`; the optional `or` is what keeps
  // `run_level` — the one kind that requires no child — from being dropped off the front of the
  // split and never read. A parser that skipped it would report every other kind correctly and
  // say nothing at all about the one branch this check exists to hold.
  const parts = body.replace(/^\s*/, "").split(/(?:or\s*)?\(\s*subject_kind\s*=\s*'/).slice(1);
  if (parts.length === 0) return null;
  const out = new Map<string, Set<string>>();
  for (const part of parts) {
    const kind = /^([a-z_]+)'/.exec(part)?.[1];
    if (!kind) return null;
    // The branch's own terms: `<col> is not null` / `<col> is null`, up to the closing paren of
    // this branch (the next branch is a new split part, so only `)` can end it).
    const terms = [...part.matchAll(/([a-z_]+)\s+is\s+(not\s+)?null/gi)];
    const required = new Set<string>();
    for (const [, column, not] of terms) {
      if (!CHILD_COLUMNS.includes(column as (typeof CHILD_COLUMNS)[number])) continue;
      if (not) required.add(column);
    }
    if (!out.has(kind)) out.set(kind, required);
  }
  return out;
}

const KIND_SHAPE = constraint("eval_assessment_subject_kind_check");
if (!KIND_SHAPE) {
  fail.push(`FAIL: ${MIGRATION} declares no eval_assessment_subject_kind_check — nothing makes a ` +
            "row whose kind and child columns disagree unwritable, so every writer is trusted to " +
            "get the combination right and no reader can rely on it");
} else {
  const body = KIND_SHAPE.slice(KIND_SHAPE.indexOf("check (") + "check (".length);
  const branches = kindBranches(body);
  const literal = [...body.matchAll(/subject_kind\s*=\s*'([a-z_]+)'/g)].map((m) => m[1]);
  const distinct = new Set(literal);
  const expected = new Set(["run_level", "run", "document", "knowledge", "bug", "event"]);
  if (!branches) {
    fail.push("FAIL: the kind-shape CHECK cannot be read as one branch per kind — every assertion " +
              "below it would be vacuous, so this is reported rather than skipped");
  } else {
    // Exactly the six kinds, and no seventh. `model_call` and a bare `subject` are the two a
    // writer might reach for that the table does not have; a branch for either would make the
    // contract wider than the six the table documents.
    for (const kind of distinct) {
      if (!expected.has(kind)) {
        fail.push(`FAIL: the kind-shape CHECK names the kind "${kind}", which is not one of the six ` +
                  "the typed subject has (run_level, run, document, knowledge, bug, event)");
      }
    }
    for (const kind of expected) {
      if (!distinct.has(kind)) {
        fail.push(`FAIL: the kind-shape CHECK has no branch for "${kind}" — an insert of that kind ` +
                  "is refused by a CHECK that never considered it, which reads as a bug in the " +
                  "writer rather than as the missing branch it is");
      }
    }
    // `run_level` names no child subject: it is about the parent run's own observation snapshot,
    // which the run already carries. Every other kind names exactly the one child it is named for —
    // resolved from the table's own spelling, because that is the fact being checked: `document`
    // resolves into `doc_id` and `knowledge` into `knowledge_node_id`, and a branch that required
    // `document_id` would name a column the table does not have.
    const ONE_CHILD: Record<string, string | null> = {
      run_level: null, run: "run_id", document: "doc_id",
      knowledge: "knowledge_node_id", bug: "bug_id", event: "event_id",
    };
    for (const [kind, required] of branches) {
      if (!expected.has(kind)) continue;
      const want = new Set([ONE_CHILD[kind]].filter((c): c is string => c !== null));
      const got = new Set([...required].filter((c) => CHILD_COLUMNS.includes(c as never)));
      const missing = [...want].filter((c) => !got.has(c));
      const extra = [...got].filter((c) => !want.has(c));
      if (missing.length > 0) {
        fail.push(`FAIL: the kind-shape CHECK's "${kind}" branch does not require ${missing.join(", ")} ` +
                  "— a row that says it judges that subject and resolves none of them is a claim " +
                  "with nothing behind it");
      }
      if (extra.length > 0) {
        fail.push(`FAIL: the kind-shape CHECK's "${kind}" branch also requires ${extra.join(", ")} ` +
                  `— ${kind} names exactly one child subject, and ${[...want].join(", ") || "none"} is it`);
      }
    }
  }
}

// The five foreign keys, each on its own column and each pointing at the table its kind names.
for (const column of CHILD_COLUMNS) {
  const text = constraint(`eval_assessment_${column}_fkey`);
  const target = CHILD_TARGET[column];
  if (!text) {
    fail.push(`FAIL: ${MIGRATION} adds no eval_assessment_${column}_fkey — the column a "${column}"
                 kind resolves into would hold anything, including an id nothing answers to`
      .replace(/\s+/g, " "));
    continue;
  }
  const referenced = new RegExp(`foreign\\s+key\\s*\\(\\s*${column}\\s*\\)\\s*references\\s+([a-z_.]+)`).exec(text)?.[1];
  if (referenced !== target) {
    fail.push(`FAIL: eval_assessment_${column}_fkey references ${referenced ?? "nothing"} and not ` +
              `${target} — the typed column does not resolve to the subject its kind names`);
  }
}

for (const [pattern, want] of [
  [/alter table zz\.eval_assessment add column (\w+) (?:uuid|text|integer|bigint);/g,
   ["subject_kind", "run_id", "doc_id", "doc_revision", "knowledge_node_id", "bug_id", "event_id"]],
  [/alter table zz\.eval_assessment add column (value|excluded_reason) /g,
   ["value", "excluded_reason"]],
] as const) {
  const seen = new Set([...migration.matchAll(pattern)].map((m) => m[1]));
  for (const column of want) {
    if (!seen.has(column)) fail.push(`FAIL: ${MIGRATION} adds no eval_assessment.${column}`);
  }
}

// The retired spellings: a column the writer must not name, and the free-text ref they replace.
for (const [pattern, why] of [
  [/alter table zz\.eval_assessment drop column subject_ref;/, "subject_ref"],
  [/alter table zz\.eval_assessment drop column answer;/, "answer"],
] as const) {
  if (!pattern.test(migration)) {
    fail.push(`FAIL: ${MIGRATION} does not drop eval_assessment.${why} — the table would carry the ` +
              "free-text shape beside the typed one, and a reader could not say which is the subject");
  }
}
if (!/alter table zz\.eval_assessment alter column subject_kind set not null;/.test(migration)) {
  fail.push("FAIL: eval_assessment.subject_kind is left nullable — a row with no kind is a row no " +
            "reader can resolve, and it is exactly what the CHECK cannot refuse");
}
if (!/add constraint eval_assessment_subject_key unique nulls not distinct[\s\S]*?\(\s*eval_run_id,\s*measure_id,\s*subject_kind[\s\S]*?\)/.test(migration)) {
  fail.push("FAIL: eval_assessment has no `unique nulls not distinct` subject key — one measure " +
            "could be assessed twice against one subject in one run, and the two rows would " +
            "disagree with nothing to settle which is the reading");
}
if (!/add constraint eval_assessment_value_check check \(\(value is null\) = \(excluded_reason is not null\)\)/.test(migration)) {
  fail.push("FAIL: eval_assessment has no value/excluded_reason exclusivity check — a row carrying " +
            "both, or neither, says nothing a reducer can read");
}

// ---------------------------------------------------------------------------------------------
// The writer.
// ---------------------------------------------------------------------------------------------

interface Source { path: string; src: string }

function sources(dir: string, out: Source[] = []): Source[] {
  // A root that is not there is skipped rather than thrown on: the check is pointed at a scratch
  // tree by its cwd, and a tree carrying only the three files this reads has no `packages/`. The
  // absence is not silent — the "no insert anywhere" failure below names every root it read.
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { sources(p, out); continue; }
    if (!p.endsWith(".ts")) continue;
    out.push({ path: p, src: read(p) });
  }
  return out;
}

/** The literal around `at` — the text between the nearest backticks on either side. Narrow on
 *  purpose: the statements this check reads are template literals with no interpolation, and a
 *  full scanner would be `checks/dropped-columns.ts`'s, which already reads every statement in
 *  these trees for the names the migration retires. */
function literalAround(src: string, at: number): string {
  const open = src.lastIndexOf("`", at);
  const close = src.indexOf("`", at);
  return open < 0 || close < 0 ? "" : src.slice(open + 1, close);
}

/** Top-level commas, as `checks/insert-arity.ts` counts them: a value slot may be a call or a cast
 *  with commas of its own, and those are not separators. */
function topLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim()).filter(Boolean);
}

/** The balanced body of the bracket that opens at `from` — the inside of the parenthesis or the
 *  square bracket there, whichever it is. */
function balanced(src: string, from: number): { body: string; end: number } | null {
  const open = src[from];
  const close = open === "(" ? ")" : open === "[" ? "]" : null;
  if (close === null) return null;
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return { body: src.slice(from + 1, i), end: i };
  }
  return null;
}

const inserts: { path: string; line: number; columns: string[]; valueSlots: string[]; args: string[] }[] = [];
for (const { path, src } of ROOTS.flatMap((r) => sources(r))) {
  for (const m of src.matchAll(/insert into zz\.eval_assessment\b/g)) {
    const statement = literalAround(src, m.index);
    const cols = balanced(statement, statement.indexOf("("));
    if (!cols) continue;
    const columns = topLevel(cols.body);
    // The statement's own value list: one slot per column, and a slot may be a placeholder, a
    // function call (`now()`) or a cast.
    const values = balanced(statement, statement.indexOf("values (") + "values ".length);
    // And the arguments the caller binds to those placeholders, read from the source beside the
    // literal. `$N` in the statement is the Nth of them, positionally.
    const afterStatement = src.indexOf("values (", m.index);
    const bound = afterStatement < 0 ? null : balanced(src, afterStatement + "values ".length);
    const arrayAt = bound ? src.indexOf("[", bound.end) : -1;
    const array = arrayAt < 0 ? null : balanced(src, arrayAt);
    inserts.push({
      path,
      line: src.slice(0, m.index).split("\n").length,
      columns,
      valueSlots: values ? topLevel(values.body) : [],
      args: array ? topLevel(array.body) : [],
    });
  }
}

if (inserts.length === 0) {
  fail.push("FAIL: no `insert into zz.eval_assessment` under " + ROOTS.join(", ") +
            " — either the writer moved or this check is reading the wrong trees, and neither is " +
            "a shape anybody can rely on");
}

for (const { path, line, columns, valueSlots, args } of inserts) {
  const at = `${path}:${line}`;
  const want = ["eval_run_id", "measure_id", "subject_kind", ...CHILD_COLUMNS];
  for (const column of want) {
    if (!columns.includes(column)) {
      fail.push(`FAIL: ${at} — the insert into zz.eval_assessment names no ${column}. ` +
                (column === "subject_kind"
                  ? "A row with no kind is a row no reader can resolve, and the migrated column is `not null`."
                  : `A "${column}" subject resolves into a column this statement never writes.`));
    }
  }
  // The retired spellings, on the write path rather than in the DDL.
  for (const dead of ["subject_ref", "evaluator_version_id", "evidence_ref", "answer", "policy_version", "resulting_action"]) {
    if (columns.includes(dead)) {
      fail.push(`FAIL: ${at} — the insert names eval_assessment.${dead}, which this phase drops: ` +
                "the migrated table refuses the statement, so the row is never written");
    }
  }
  // The values: one per column, and the subject's six taken from the typed object rather than
  // written as literals. A literal here is a kind decided at the insert instead of by the ref,
  // which is the guess the CHECK exists to refuse — and a refusal loses the row rather than
  // recording a wrong one.
  if (valueSlots.length !== columns.length) {
    fail.push(`FAIL: ${at} — the insert names ${columns.length} column(s) and its \`values\` list has ` +
              `${valueSlots.length} slot(s); Postgres refuses the statement, so nothing is written ` +
              "and nothing says so");
    continue;
  }
  for (const child of ["subject_kind", ...CHILD_COLUMNS]) {
    const i = columns.indexOf(child);
    if (i < 0) continue;
    // A placeholder carries its cast (`$6::uuid`); the argument is the Nth of them either way.
    const placeholder = /^\$(\d+)(?:::\w+)?$/.exec(valueSlots[i])?.[1];
    const bound = placeholder === undefined ? undefined : args[Number(placeholder) - 1];
    if (bound !== `columns.${child}`) {
      fail.push(`FAIL: ${at} — the value bound to ${child} is \`${bound ?? valueSlots[i]}\` and not ` +
                `\`columns.${child}\`: the column is not taken from the typed subject, so the kind ` +
                "no longer decides what the row names");
    }
  }
}

// The typed subject itself: where the columns come from, and what each kind sets.
const writerPaths = [...new Set(inserts.map((i) => i.path))];
for (const path of writerPaths) {
  const src = read(path);
  if (!/const NO_CHILD = \{ run_id: null, doc_id: null, knowledge_node_id: null, bug_id: null, event_id: null \};/.test(src)) {
    fail.push(`FAIL: ${path} has no NO_CHILD of the five child columns set to null, so the one kind ` +
              "that names no child has nothing to spread");
  }
  // Anchored on the closing brace: the object has to be exactly that spread. Without the brace a
  // branch that spread NO_CHILD and then set a child of its own would still read as correct.
  if (!/subject_kind: "run_level", \.\.\.NO_CHILD\s*\}/.test(src)) {
    fail.push(`FAIL: ${path} does not build the run_level subject as { subject_kind: "run_level", ` +
              "...NO_CHILD } — run_level names no child subject, and the run-level row is the one " +
              "that must carry none of them");
  }
  // One child per kind, and only the one its kind names. Read per resolver branch rather than
  // per returned object, because the branch that decides is the one that has to be exact.
  // One child per kind, and only the one its kind names. Read per resolver branch rather than
  // per returned object, because the branch that decides is the one that has to be exact.
  for (const [kind, column] of [
    ["run", "run_id"], ["bug", "bug_id"], ["event", "event_id"],
    ["document", "doc_id"], ["knowledge", "knowledge_node_id"],
  ] as const) {
    const branch = new RegExp(`subject_kind:\\s*"${kind}",\\s*\\.\\.\\.NO_CHILD,\\s*${column}:\\s*\\w+`);
    if (!branch.test(src)) {
      fail.push(`FAIL: ${path} resolves no "${kind}" subject as { subject_kind: "${kind}", ` +
                `...NO_CHILD, ${column}: … } — the kind would either name the wrong column or name ` +
                "a second one, and the table's own CHECK would refuse the row");
    }
  }
  // And the read-back: the row must resolve to the ref it was recorded under, whatever its kind.
  // A `case` over `subject_kind` that has lost a branch resolves that kind to null, which reads as
  // "assessed against nothing" rather than as the missing branch it is. `else` is reported for the
  // same reason: an unhandled kind would fall through it and be answered with a ref nobody wrote.
  const projection = /case a\.subject_kind([\s\S]*?)\bend\b/.exec(src)?.[1];
  if (!projection) {
    fail.push(`FAIL: ${path} has no \`case a.subject_kind … end\` projection — a stored row's own ` +
              "kind is not what says which subject it was about");
  } else {
    const mapped = new Set([...projection.matchAll(/when\s+'([a-z_]+)'/g)].map((m) => m[1]));
    for (const kind of ["run_level", "run", "document", "knowledge", "bug", "event"]) {
      if (!mapped.has(kind)) {
        fail.push(`FAIL: ${path}'s subject_ref projection has no \`when '${kind}'\` — a row of that ` +
                  "kind reads back as no subject at all");
      }
    }
    if (/\belse\b/.test(projection)) {
      fail.push(`FAIL: ${path}'s subject_ref projection has an \`else\` branch — a kind this phase ` +
                "adds would resolve to a ref nobody wrote, instead of to nothing");
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The ledger.
// ---------------------------------------------------------------------------------------------

for (const [pattern, why] of [
  [/alter table zz\.eval_idempotency add column principal_id uuid;/, "add principal_id"],
  [/alter table zz\.eval_idempotency alter column principal_id set not null;/, "make principal_id not null"],
  [/alter table zz\.eval_idempotency drop column principal;/, "drop the retired `principal` address"],
  [/add constraint eval_idempotency_pkey primary key \(principal_id, tool, idempotency_key\)/, "re-key the primary key to (principal_id, tool, idempotency_key)"],
  [/add constraint eval_idempotency_principal_id_fkey foreign key \(principal_id\) references zz\.principal\(id\)/, "point principal_id at zz.principal"],
] as const) {
  if (!pattern.test(migration)) {
    fail.push(`FAIL: ${MIGRATION} does not ${why} — the ledger is not keyed to the principal that ` +
              "made the call");
  }
}

const LEDGER = "services/zz-core/src/eval/idempotency.ts";
let ledger: string;
try {
  ledger = read(LEDGER);
} catch {
  fail.push(`FAIL: ${LEDGER} cannot be read — the one module that writes the ledger is not at that path`);
  ledger = "";
}

if (ledger) {
  // Every statement that touches the ledger, found from the verb that opens it.
  const statements: { at: number; text: string }[] = [];
  for (const m of ledger.matchAll(/(?:insert\s+into|from)\s+zz\.eval_idempotency/gi)) {
    statements.push({ at: m.index, text: literalAround(ledger, m.index) });
  }
  if (statements.length === 0) {
    fail.push(`FAIL: ${LEDGER} has no statement naming zz.eval_idempotency — the ledger is read " +
              "and written somewhere else, and this check is not reading it`);
  }
  for (const { at, text } of statements) {
    const line = ledger.slice(0, at).split("\n").length;
    if (!/\bprincipal_id\b/.test(text)) {
      fail.push(`FAIL: ${LEDGER}:${line} — a statement against zz.eval_idempotency names no ` +
                "`principal_id`: the migrated table has no other principal column, so the " +
                "statement is refused before the mutator it belongs to does any work");
    }
    // The retired spelling. `zz.principal` is the table this resolves THROUGH and `principal` is
    // the email parameter the callers still pass, so only the bare word inside the statement's own
    // SQL is read — `principal_id` cannot match, because `_` is a word character.
    const sql = text.replace(/--[^\n]*/g, "").replace(/zz\.principal/g, "");
    if (/\bprincipal\b/.test(sql)) {
      fail.push(`FAIL: ${LEDGER}:${line} — a statement against zz.eval_idempotency reads the column ` +
                "`principal`, which this phase drops: every mutator that reaches it dies with " +
                'column "principal" does not exist before doing its own work');
    }
  }
  // The insert resolves the principal in its own `values`, so an address no principal answers to
  // is refused by the table rather than written as a string nothing joins back.
  if (!/insert into zz\.eval_idempotency[\s\S]*?values \(\(select[\s\S]*?from zz\.principal/.test(ledger)) {
    fail.push(`FAIL: ${LEDGER} — the ledger insert does not resolve its principal_id from ` +
              "zz.principal, so a caller the platform has no principal row for cannot be refused " +
              "by name and the row cannot be keyed to a principal at all");
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("typed subject: the kind-shape CHECK covers exactly the six kinds and one child each, " +
            `the writer binds them from the typed subject (${inserts.length} insert(s) in ` +
            `${writerPaths.length} file(s)), and the ledger is keyed to a principal`);
