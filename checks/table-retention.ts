#!/usr/bin/env node
/**
 * checks/table-retention.ts — `zz.doc_revision` declares what happens to it, the declaration is
 * true of the schema, and it is true of the tree.
 *
 *   node checks/table-retention.ts   # one arm needs Docker; exit 2 without it
 *
 * `SCHEMA.md` rule 9: a table nobody can bound says its retention, or it is a table whose growth
 * nobody decided. `checks/comment-completeness.ts:107,114` enforces that rule in general — an
 * `ephemeral` table, and any table whose own comment calls it unbounded, must carry `retention=`.
 * That check has to be green for every table, so it can only ask whether a value EXISTS, never
 * whether it is TRUE. This is the four things that are `zz.doc_revision`'s alone, and it is
 * deliberately that one population: fifteen of the fifty-eight table comments in `schema-target/`
 * carry a `retention=` today, and a class-wide reading of "is this retention true" is a different
 * job from the one rule 9's first failure needs done.
 *
 * Four arms, because a declaration can be wrong in four ways.
 *
 *   (1) DECLARED. The comment in `schema-target/` carries a `retention=` naming the two
 *   constraints that REFUSE a referenced revision's deletion (`doc_id_current_revision_fkey`,
 *   `doc_id_approved_revision_fkey`), the half no constraint refuses (`zz.doc_link`'s two
 *   cascading revision references, which delete cleanly and take a link's provenance with them),
 *   the one path that DOES remove a revision (`doc_revision_doc_id_fkey`, `ON DELETE CASCADE`, so
 *   a revision goes only with the document it belongs to), the fact that no sweep runs, and what
 *   would reopen the decision. A comment carrying four of those five is a comment a reader acts
 *   on wrongly, so each is named separately rather than matched as a whole.
 *
 *   (2) TRUE OF THE SCHEMA. On a throwaway migrated by the real runner, the catalog's comment for
 *   the table is read and held to the same five facts — a migration whose `COMMENT ON TABLE`
 *   names the wrong table leaves the target right and the database silent, and `schema-inventory`
 *   reports that as a disagreement rather than as a rule nobody wrote. Then `pg_constraint` is
 *   read, because the comment's claims are about delete behaviour and delete behaviour is a
 *   catalog fact: the two refusing constraints must be `NO ACTION` and the three cascading ones
 *   `CASCADE`. A comment naming a constraint whose behaviour is not what it says is a comment
 *   that will survive every schema diff and still be false.
 *
 *   (3) TRUE OF THE TREE. "No sweep runs" is a claim about code, and this is where it is checked:
 *   no statement under the write trees deletes a `zz.doc_revision` row, and every statement that
 *   deletes a `zz.doc` row — the one delete action a revision inherits — carries a `where`. An
 *   unbounded `delete from zz.doc` would purge every revision in the database without ever naming
 *   the table this check exists for.
 *
 *   (4) THE ARMS REJECT. The five facts are read by one function, and a reader that has stopped
 *   rejecting is a reader that passes everything. Five planted clauses — a complete one and four
 *   missing exactly one fact each — are put through that same function, and it must accept the
 *   first and reject each of the others NAMING the fact it is missing.
 *
 * DELIBERATE: the retention clause is read with `packages/tools/src/lib/schema-comment.ts`'s field
 * scan, not with a split on `;`. `question` is a sentence and a sentence may carry a semicolon, so
 * a naive split reads a later key's value as the tail of an earlier one; the scan is the one the
 * other comment check uses for that reason, and it lives in the tools package so there is one of it.
 *
 * Exit 0: every arm held. Exit 1: an arm failed, quoting what it read. Exit 2: Docker is not
 * available, so arm 2 could not run — which is not a pass, and is not a failure either.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const TABLE = "doc_revision";
const SCHEMA_FILE = "schema-target/documents.ts";

type Tools = typeof import("../packages/tools/src/lib/schema-comment.js");
const { fields }: Tools =
  await import(pathToFileURL(join(root, "packages/tools/dist/lib/schema-comment.js")).href) as Tools;

type Target = typeof import("../schema-target.ts");
const { SCHEMA_TARGET }: Target =
  await import(pathToFileURL(join(root, "schema-target.ts")).href) as Target;

/**
 * The five things a reader has to be told, each as a matcher over the retention clause and the
 * sentence said when it is not there.
 *
 * `names` is a list of exact strings the clause must contain: identifiers, not prose. Prose a
 * check could guess at is prose that gets written to satisfy the check — these are the names a
 * reader would go and look up, so requiring the literal is what makes the comment usable rather
 * than merely present.
 */
interface Fact {
  what: string;
  /** Identifiers the clause must name, verbatim. */
  names?: string[];
  /** Something the clause must say, in one of the spellings the house voice uses. */
  says?: RegExp;
  /** Said when it is missing: what the reader loses by not being told. */
  why: string;
}

const FACTS: Fact[] = [
  { what: "the constraints that refuse a referenced revision's deletion",
    names: ["doc_id_current_revision_fkey", "doc_id_approved_revision_fkey"],
    why: "a sweep judging a revision by \"past its retention and not cited by an evaluation\" is " +
      "refused at commit by both of these, and a reader who does not know they exist will plan " +
      "the sweep that the database will reject" },
  { what: "the half no constraint refuses",
    names: ["doc_link"],
    says: /cascad/i,
    why: "`zz.doc_link`'s two revision references are ON DELETE CASCADE, so a revision nothing " +
      "cites deletes cleanly — and takes a link's provenance with it. That is the half of a " +
      "sweep the schema will not stop" },
  { what: "the one path that does remove a revision",
    names: ["doc_revision_doc_id_fkey"],
    says: /cascad/i,
    why: "deleting a document removes its revisions, by cascade, in production — " +
      "`scripts/ops/purge-probes.ts` does exactly that. A declaration that does not say so " +
      "claims nothing deletes a revision, which is false" },
  { what: "that no sweep runs",
    says: /\bno\s+(?:sweep|purge)\b|\bnothing\s+(?:purges|deletes|removes)\b|\bnot\s+purged\b/i,
    why: "a retention= that describes a purge is a purge somebody will assume is running, and a " +
      "row nothing deletes is a table a reader budgets for on a false premise" },
  { what: "what would reopen the decision",
    says: /\breopen/i,
    why: "the decision is taken for today's reasons; a reader needs to know which change would " +
      "make it the wrong one, or the comment is a fact with no expiry and no trigger" },
];

/** Every way the retention clause can fail, as whole sentences naming what is wrong. `null` for a
 *  clause with no fault at all, so a caller reports acceptance and rejection the same way. */
function retentionFaults(comment: string | null | undefined): string[] {
  if (comment === null || comment === undefined || comment.trim() === "") {
    return [`${TABLE} carries no comment at all`];
  }
  const clause = fields(comment).retention;
  if (clause === undefined || clause.trim() === "") {
    return [`${TABLE} carries no retention=, and rule 9 requires one of a table nobody can bound`];
  }
  const bad: string[] = [];
  for (const fact of FACTS) {
    const missing = (fact.names ?? []).filter((name) => !clause.includes(name));
    const unsaid = fact.says !== undefined && !fact.says.test(clause);
    if (missing.length === 0 && !unsaid) continue;
    const wanted = [...missing.map((n) => `\`${n}\``),
      ...(unsaid ? [String(fact.says)] : [])].join(", ");
    bad.push(`the retention= clause does not name ${fact.what}: ${wanted} — ${fact.why}`);
  }
  return bad;
}

/** The comment `schema-target/` declares for the table, or null when it declares none. */
function declaredComment(): string | null {
  const tables = (SCHEMA_TARGET.tables ?? {}) as Record<string, { comment?: string | null }>;
  return tables[TABLE]?.comment ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1 — DECLARED.
const declared = declaredComment();
const declaredFaults = retentionFaults(declared);
if (declaredFaults.length > 0) {
  console.error(`table-retention: FAILED at "the declaration is written and complete":\n  ` +
    declaredFaults.join("\n  ") + `\n  (read from ${SCHEMA_FILE})`);
  process.exit(1);
}
console.log(`ok  the declaration is written: ${TABLE}'s retention= names all ${FACTS.length} facts`);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2 — the arms reject what they exist to catch. Runs before the tree and catalog arms so that a
// reading which has stopped rejecting is reported as that, rather than as a document that is
// suddenly fine.
//
// The fixtures are the check's OWN clause, not the declared one cut up: a self-test derived from
// the document it judges agrees with whatever that document happens to say, which is the shape of
// self-test this arm exists to replace. The declared comment is held to the same function by arm 1
// above, so the two arms together say "this clause is complete, and the document's clause is read
// by the same rule".
{
  const COMPLETE =
    "retention=no sweep purges a revision yet, and none may: " +
    "doc_id_current_revision_fkey and doc_id_approved_revision_fkey refuse the deletion of a revision " +
    "a document still points at, while the doc_link references cascade, so the half no constraint " +
    "refuses deletes cleanly and takes a link's provenance with it; a revision leaves only with its " +
    "document, by doc_revision_doc_id_fkey cascade; it reopens when a complete revision-retention " +
    "rule is written";
  const said = (clause: string): string => `question=which revision is this?; ${clause}`;
  const cases: { what: string; comment: string; names: string | null }[] = [
    { what: "a complete clause", comment: said(COMPLETE), names: null },
    { what: "one naming a single refusing constraint",
      comment: said(COMPLETE.replace(" and doc_id_approved_revision_fkey", "")),
      names: "doc_id_approved_revision_fkey" },
    { what: "one silent about the half no constraint refuses",
      comment: said(COMPLETE.replace("while the doc_link references cascade, so the half no constraint " +
        "refuses deletes cleanly and takes a link's provenance with it; ", "")),
      names: "doc_link" },
    { what: "one silent about the document cascade",
      comment: said(COMPLETE.replace("; a revision leaves only with its document, by " +
        "doc_revision_doc_id_fkey cascade", "")),
      names: "doc_revision_doc_id_fkey" },
    { what: "one describing a sweep that runs",
      comment: said(COMPLETE.replace(/no sweep purges a revision yet, and none may/,
        "a weekly sweep removes revisions past their retention")),
      names: "does not name that no sweep runs" },
    { what: "one naming no trigger",
      comment: said(COMPLETE.replace(/; it reopens when a complete revision-retention rule is written/, "")),
      names: "does not name what would reopen the decision" },
  ];
  for (const c of cases) {
    const found = retentionFaults(c.comment);
    if (c.names === null) {
      if (found.length > 0) {
        console.error(`table-retention: FAILED at "the arms reject what they exist to catch": the ` +
          `check's own complete clause was rejected: ${found.join("; ")}`);
        process.exit(1);
      }
      console.log(`  ${c.what}: accepted`);
      continue;
    }
    if (found.length === 0) {
      console.error(`table-retention: FAILED at "the arms reject what they exist to catch": the ` +
        `${c.what} was ACCEPTED, so nothing reports a retention rule that ${c.names}`);
      process.exit(1);
    }
    if (!found.join(" ").includes(c.names)) {
      console.error(`table-retention: FAILED at "the arms reject what they exist to catch": the ` +
        `${c.what} was rejected for the wrong reason — it does not mention ${c.names}:\n  ` +
        found.join("\n  "));
      process.exit(1);
    }
    console.log(`  ${c.what}: rejected — ${found[0]?.split(" — ")[0]}`);
  }
  console.log(`ok  the arms reject all ${cases.length - 1} ways the clause can be short`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3 — TRUE OF THE TREE. No statement deletes a revision; every statement that deletes a document
// is bounded. `checks/dropped-columns.ts` walks the same trees with the same reader and the same
// two exclusions, and for the same reason: an applied migration is history, and a mutation spec
// quotes a statement in order to plant a defect in it.
{
  type Scan = typeof import("../packages/tools/src/lib/sql-statements.ts");
  const { sourceFiles, statementsOf }: Scan =
    await import(pathToFileURL(join(root, "packages/tools/dist/lib/sql-statements.js")).href) as Scan;

  const KEEP = (p: string): boolean => /\.(ts|sh)$/.test(p) &&
    !/(^|\/)scripts\/mutation\/specs[^/]*\.ts$/.test(p) &&
    !p.includes("services/gateway/migrations/");

  const deletesRevision = /^\s*delete\s+from\s+(?:only\s+)?zz\.doc_revision\b/i;
  const truncatesRevision = /^\s*truncate\b[\s\S]*?\bzz\.doc_revision\b/i;
  const deletesDoc = /^\s*delete\s+from\s+(?:only\s+)?zz\.doc\b/i;

  const purge: string[] = [];
  const unbounded: string[] = [];
  const docDeletes: string[] = [];
  for (const { path, src } of ["services", "packages", "scripts", "deploy"].flatMap((r) => sourceFiles(r, KEEP))) {
    // `unquoted`: the reader hands back each literal WITH its delimiters unless asked otherwise, and
    // a statement that arrives as `` `delete from …` `` does not start with `delete`.
    for (const s of statementsOf(path, src, true)) {
      const at = `${s.path}:${s.line}`;
      if (deletesRevision.test(s.sql) || truncatesRevision.test(s.sql)) {
        purge.push(`${at} — ${s.sql.replace(/\s+/g, " ").slice(0, 160)}`);
        continue;
      }
      if (!deletesDoc.test(s.sql)) continue;
      docDeletes.push(at);
      if (!/\bwhere\b/i.test(s.sql)) {
        unbounded.push(`${at} — ${s.sql.replace(/\s+/g, " ").slice(0, 160)}`);
      }
    }
  }
  if (purge.length > 0) {
    console.error(`table-retention: FAILED at "no statement deletes a revision":\n  ` + purge.join("\n  ") +
      `\n  The declaration says no sweep runs. A statement that deletes a revision row is that ` +
      `sweep, and ${SCHEMA_FILE} has to stop saying it does not.`);
    process.exit(1);
  }
  if (unbounded.length > 0) {
    console.error(`table-retention: FAILED at "every statement that deletes a document is bounded":\n  ` +
      unbounded.join("\n  ") +
      `\n  A revision leaves the database with its document (doc_revision_doc_id_fkey, ON DELETE ` +
      `CASCADE), so an unbounded delete of zz.doc purges every revision without naming the table.`);
    process.exit(1);
  }
  // A scanner that finds nothing is a scanner that has stopped reading: the first version of this
  // arm matched each statement's opening quote, found no delete at all, and passed by absence on
  // exactly the statement it was written about. So the population is asserted to be there.
  if (docDeletes.length === 0) {
    console.error(`table-retention: FAILED at "no statement deletes a revision": the scan found no ` +
      `statement deleting a zz.doc row anywhere under services, packages, scripts or deploy, and ` +
      `scripts/ops/purge-probes.ts deletes one — the reader is not seeing the tree`);
    process.exit(1);
  }
  console.log(`ok  no statement deletes a revision, and the ${docDeletes.length} statement(s) that ` +
    `delete a document each carry a where (${docDeletes.join(", ")})`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4 — TRUE OF THE SCHEMA. Migrated from this tree, read back from the catalog.
const CONSTRAINTS: { name: string; behaviour: "a" | "c"; what: string }[] = [
  { name: "doc_id_current_revision_fkey", behaviour: "a", what: "refuses a referenced revision's deletion" },
  { name: "doc_id_approved_revision_fkey", behaviour: "a", what: "refuses a referenced revision's deletion" },
  { name: "doc_revision_doc_id_fkey", behaviour: "c", what: "removes a revision with its document" },
  { name: "doc_link_from_doc_id_from_revision_fkey", behaviour: "c", what: "removes a link with the revision it cites" },
  { name: "doc_link_to_doc_id_to_revision_fkey", behaviour: "c", what: "removes a link with the revision it supports" },
];

async function migrated(): Promise<void> {
  type Throwaway = typeof import("../scripts/schema/throwaway.ts");
  const { withThrowawayDb }: Throwaway =
    await import(pathToFileURL(join(root, "scripts/schema/throwaway.ts")).href) as Throwaway;
  type Catalog = typeof import("../scripts/schema/catalog.ts");
  const { readCatalog }: Catalog =
    await import(pathToFileURL(join(root, "scripts/schema/catalog.ts")).href) as Catalog;

  await withThrowawayDb(async (client) => {
    const catalog = await readCatalog(client);
    const comment = catalog[TABLE]?.comment ?? null;
    if (comment === null) {
      console.error(`table-retention: FAILED at "the declaration reached the database": the ` +
        `migrated catalog has no comment on zz.${TABLE} — the target declares one and no ` +
        `migration applies it`);
      process.exit(1);
    }
    const faults = retentionFaults(comment);
    if (faults.length > 0) {
      console.error(`table-retention: FAILED at "the declaration reached the database": the ` +
        `catalog's comment says:\n  ${comment}\n  and:\n  ${faults.join("\n  ")}`);
      process.exit(1);
    }

    const { rows } = await client.query<{ conname: string; confdeltype: string }>(
      `select conname, confdeltype from pg_constraint
        where connamespace = 'zz'::regnamespace and conname = any($1::text[])`,
      [CONSTRAINTS.map((c) => c.name)],
    );
    const got = new Map(rows.map((r) => [r.conname, r.confdeltype]));
    const wrong: string[] = [];
    for (const c of CONSTRAINTS) {
      const behaviour = got.get(c.name);
      if (behaviour === undefined) {
        wrong.push(`\`${c.name}\` is not in the migrated catalog at all, and the comment says it ${c.what}`);
      } else if (behaviour !== c.behaviour) {
        wrong.push(`\`${c.name}\` is ${behaviour === "c" ? "ON DELETE CASCADE" : behaviour === "a" ? "NO ACTION" : `confdeltype=${behaviour}`} ` +
          `and the comment says it ${c.what}`);
      }
    }
    if (wrong.length > 0) {
      console.error(`table-retention: FAILED at "the declaration is true of the schema":\n  ` +
        wrong.join("\n  ") +
        `\n  A comment that outlives the constraint it describes is a comment every schema diff ` +
        `agrees with, and a reader acts on it.`);
      process.exit(1);
    }
    console.log(`ok  the migrated catalog carries the same declaration, and all ${CONSTRAINTS.length} ` +
      `constraints it names delete the way it says they do`);
  });
}

try {
  await migrated();
} catch (err) {
  if (err instanceof Error && /Docker is not running/.test(err.message)) {
    console.error("table-retention: Docker is not available — the gate requires Docker to run the " +
      "catalog arm of this check. The declaration and the tree arm above did run.");
    process.exit(2);
  }
  throw err;
}

console.log(`table-retention: zz.${TABLE} declares that no sweep purges a revision, names both ` +
  `constraints that refuse one and the two cascades that would not, and the schema agrees.`);
