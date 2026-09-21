/**
 * The database the release rehearses against is the database production runs.
 *
 * Two release steps start a throwaway PostgreSQL: the SQL check in `build.ts`, which migrates
 * an empty database with the image that is about to ship and then PREPAREs every SQL literal
 * in the tree against the schema those migrations leave behind, and the tool-chain walk in
 * `tool-chain.ts`, which stands the whole platform up and calls it. Both hardcoded
 * `postgres:16-alpine`.
 *
 * THAT MADE THE STRONGEST CHECK IN THE RELEASE BLIND TO THE NEWEST MIGRATION. Migration 070
 * declares `-- requires-extension: pg_textsearch`, `postgres:16-alpine` cannot supply it, and
 * `db.ts` therefore DEFERS it — correctly, because a migration attempted where its extension
 * is absent throws, un-sets the pool, and leaves the platform serving with no database while
 * reporting itself healthy. So the rehearsal skipped 070 and 071, the search partitions and
 * the BM25 index were never created, and `sql-check` then EXCUSED every query naming a
 * relation those migrations would have made. The check reported a pass, and the DDL it was
 * supposed to prove had not run anywhere but production.
 *
 * The fix is not better arithmetic about how many migrations to expect. It is to rehearse on
 * the image the deployment actually runs, where nothing is deferred and the whole schema is
 * real. `deploy/docker-compose.yml` is where that image is named, so it is read from there
 * rather than written down a second time — a tag in two files is a tag that drifts, and the
 * drift is silent until a release rehearses against a database the deployment stopped using.
 *
 * THE COMMAND COMES WITH IT, for the same reason and one more. The image ships the
 * specification's reference settings, including `shared_buffers = 8GB`; compose overrides
 * that to a value this host can actually map. A plain `docker run` of the image would take
 * the 8 GB and fail to start with "could not map anonymous shared memory" on any machine
 * smaller than the reference — including the one releases are cut from.
 *
 * A tiny targeted reader rather than a YAML library: `yaml` resolves in this tree only as
 * somebody else's transitive dependency and is not in `package.json`, and reaching for an
 * undeclared module is how a release breaks on an unrelated upgrade. This wants two fields
 * from one known service, and `scripts/gate/checks/deploy-compose.ts` reads the same file the
 * same way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads the `postgres` service out of the deployment's compose file: the image reference
 * exactly as compose names it, tag included, and the argv compose passes it (`[]` when
 * compose sets none).
 *
 * Throws rather than returning a default. There is no sensible fallback: a release that
 * cannot tell which database the deployment runs must stop, because every quiet alternative
 * — guessing a tag, falling back to the official image — rehearses against something that is
 * not the deployment and reports a pass for it.
 *
 * The shape is written inline rather than as an exported interface. Both callers destructure
 * it, so a named type would be an export nobody imports — which this repository's gate
 * refuses, and is right to: a type exported for tidiness is a second place to change.
 */
export function postgresService(repoRoot: string): { image: string; command: string[] } {
  const path = join(repoRoot, "deploy/docker-compose.yml");
  const lines = readFileSync(path, "utf8").split("\n");

  // The service block is the run of lines from `  postgres:` to the next key at the same
  // indent. Two spaces is the service level in this file, and `volumes:` at column 0 ends the
  // service list, so a block that runs off the end of `services:` is caught by the same rule.
  const start = lines.findIndex((l) => /^ {2}postgres:\s*$/.test(l));
  if (start === -1) throw new Error(`no \`postgres\` service in ${path} — which database does this deployment run?`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i])) continue;
    if (/^ {0,2}\S/.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start + 1, end);

  const image = block.map((l) => /^ {4}image:\s*(\S+)\s*$/.exec(l)?.[1]).find((v) => v !== undefined);
  if (image === undefined) throw new Error(`the \`postgres\` service in ${path} names no image`);

  // `command:` is a JSON flow sequence and wraps across lines in this file. Joining the block
  // from the `command:` line to the closing bracket and parsing it as JSON is exact, and it
  // refuses a block-style list loudly instead of silently reading the first element.
  const cmdAt = block.findIndex((l) => /^ {4}command:/.test(l));
  let command: string[] = [];
  if (cmdAt !== -1) {
    const joined = block.slice(cmdAt).join("\n").replace(/^ {4}command:\s*/, "");
    const close = joined.indexOf("]");
    if (!joined.startsWith("[") || close === -1) {
      throw new Error(`the \`postgres\` service in ${path} writes \`command:\` in a form this reader ` +
                      "does not accept — write it as a single JSON array, which is how the rest of this file writes one");
    }
    command = JSON.parse(joined.slice(0, close + 1)) as string[];
  }

  return { image, command };
}
