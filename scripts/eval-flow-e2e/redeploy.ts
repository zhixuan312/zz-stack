/**
 * The walk's rollback command: the operator deploying the prior release again. A catalog
 * plugin's current version is the one the deployment runs, so `release_record(rolled_back)`
 * confirms a restore only once zz-core reports the prior version.
 *
 *   node scripts/eval-flow-e2e/redeploy.ts <seed> <container prefix> <version>
 *
 * ZZ_URL and ZZ_TOKEN come from `zz-tool release-rollback`, which runs this with its own
 * environment.
 */
import { deployRelease } from "./stack.ts";

const [seed, prefix, version] = process.argv.slice(2);
const url = process.env.ZZ_URL;
const pat = process.env.ZZ_TOKEN;
if (!seed || !prefix || !version || !url || !pat) {
  console.error("usage: ZZ_URL=... ZZ_TOKEN=... redeploy.ts <seed> <container prefix> <version>");
  process.exit(2);
}
await deployRelease({ seed, prefix, url, pat }, version);
console.log(`zz-core ${version} deployed again`);
