/**
 * The database the release rehearses against is the database production runs.
 *
 * Two release steps start a throwaway PostgreSQL: the SQL check in `build.ts`, which migrates
 * an empty database with the image about to ship and then PREPAREs every SQL literal in the
 * tree against the resulting schema, and the tool-chain walk in `tool-chain.ts`, which stands
 * the whole platform up and calls it.
 *
 * Both must rehearse on the image the deployment actually runs. A migration declaring
 * `-- requires-extension:` is deferred by `db.ts` where the extension is absent — correctly,
 * since attempting it throws, un-sets the pool, and leaves the platform serving with no
 * database while reporting itself healthy — so an image that cannot supply the extension
 * silently skips those migrations, `sql-check` excuses every query naming a relation they would
 * have created, and the check passes on DDL that ran nowhere but production.
 *
 * COUPLED: `deploy/docker-compose.yml` names that image, and it is read from there rather than
 * written down a second time. A tag in two files drifts silently until a release rehearses
 * against a database the deployment stopped using.
 *
 * The command comes with it. The image ships the specification's reference settings, including
 * `shared_buffers = 8GB`, and compose overrides that to a value the host can map; a plain
 * `docker run` of the image would take the 8 GB and fail to start with "could not map anonymous
 * shared memory" on any machine smaller than the reference.
 *
 * DELIBERATE: a targeted reader rather than a YAML library. `yaml` resolves in this tree only
 * as somebody else's transitive dependency and is not in `package.json`. This wants two fields
 * from one known service, and `scripts/gate/checks/deploy-compose.ts` reads the same file the
 * same way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads the `postgres` service out of the deployment's compose file: the image reference
 * exactly as compose names it, tag included, and the argv compose passes it (`[]` when compose
 * sets none).
 *
 * Throws rather than returning a default. A release that cannot tell which database the
 * deployment runs must stop — guessing a tag or falling back to the official image rehearses
 * against something that is not the deployment and reports a pass for it.
 *
 * DELIBERATE: the shape is inline rather than an exported interface. Both callers destructure
 * it, so a named type would be an export nobody imports, which this repository's gate refuses.
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
