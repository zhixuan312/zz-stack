/**
 * checks/sql-scan.ts — what the checks that read SQL statements out of the write trees share beside the
 * statement reader itself (`packages/tools/src/lib/sql-statements.ts`): which files are read, an SQL comment
 * stripped from a statement, where an interpolated callee is declared, and the verbs that write a table.
 *
 * Not a check of its own: each scanner imports what it needs, so a policy changed here is changed for every
 * one of them.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Region = { kind: "code" | "literal" | "comment"; start: number; end: number };

/** A mutation spec quotes a statement in order to plant a defect in it. Its `find`/`replace` text is the subject of
 *  the check that owns the spec, and reading it as a call site would report the defect the spec exists to plant. */
export const isMutationSpec = (p: string): boolean => /(^|\/)scripts\/mutation\/specs[^/]*\.ts$/.test(p);

/** An applied migration is history: the file that writes a table's DDL is exactly the file that must still spell
 *  what a scanner forbids everywhere else. */
const isAppliedMigration = (p: string): boolean => p.includes("services/gateway/migrations/");

/** The files a scanner reads statements from: TypeScript and shell, neither a mutation spec nor an applied
 *  migration. */
export const readsStatements = (p: string): boolean => /\.(ts|sh)$/.test(p) && !isMutationSpec(p) && !isAppliedMigration(p);

/** A statement with the text after a `--` on each of its lines removed — an SQL comment inside a template literal is
 *  prose, and prose is not a statement. */
export const withoutSqlComments = (sql: string): string => sql.replace(/--[^\n]*/g, "");

/** The named imports of a source, by local name. */
function importsOf(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const raw of m[1]!.split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) out.set(name, m[2]!);
    }
  }
  return out;
}

/** Where an interpolated callee is declared, for `foldInterpolations`: the relative module it was imported from, or
 *  null when it was not imported from one. Built over the statement reader's own `regions`, which each scanner
 *  already loads. */
export const homeOf = (regions: (src: string) => Region[]) =>
  (callee: string, fromPath: string, fromSrc: string): { src: string; rs: Region[] } | null => {
    const spec = importsOf(fromSrc).get(callee);
    if (!spec || !spec.startsWith(".")) return null;
    const target = join(dirname(fromPath), spec.replace(/\.js$/, ".ts"));
    if (!existsSync(target)) return null;
    const home = readFileSync(target, "utf8");
    return { src: home, rs: regions(home) };
  };

/** The verb that writes `table`, or null: `update` and `delete from` rewrite or erase a row; `insert into` is
 *  reported only when its own `on conflict` clause turns it into an update; `alter table` is the row gaining a
 *  shape. A subquery's `from <table>` is not a write, so the verb has to be the table's own. */
export function writeShape(sql: string, table: string): string | null {
  const t = `${table}(?!\\w)`;
  if (new RegExp(`\\bupdate\\s+(?:only\\s+)?(?:zz\\.)?${t}`, "i").test(sql)) return "updates";
  if (new RegExp(`\\bdelete\\s+from\\s+(?:only\\s+)?(?:zz\\.)?${t}`, "i").test(sql)) return "deletes from";
  if (new RegExp(`\\balter\\s+table\\s+(?:only\\s+)?(?:zz\\.)?${t}`, "i").test(sql)) return "alters";
  if (new RegExp(`\\binsert\\s+into\\s+(?:zz\\.)?${t}[\\s\\S]*?\\bon\\s+conflict\\b[\\s\\S]*?\\bdo\\s+update\\s+set\\b`, "i").test(sql)) {
    return "inserts into, then updates on conflict";
  }
  return null;
}
