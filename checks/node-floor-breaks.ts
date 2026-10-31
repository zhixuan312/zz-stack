// A break test. checks/node-floor.ts passing on this machine proves nothing, because this
// machine satisfies the floor. So it is run against floors this runtime does not meet and is
// required to go red naming both versions: one past any plausible runtime, and one a minor above
// this runtime, which a floor read as its major alone would pass.
//
// DELIBERATE: node-floor.ts reads `package.json` from its working directory, so each floor is a
// package.json in a temporary directory. The tracked package.json is never written, so an
// interrupted run leaves nothing behind in the tree.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK = fileURLToPath(new URL("./node-floor.ts", import.meta.url));
const [major, minor] = process.versions.node.split(".").map(Number);
const fail: string[] = [];
for (const floor of ["999.0.0", `${major}.${minor + 1}.0`]) {
  const dir = mkdtempSync(join(tmpdir(), "node-floor-breaks-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ engines: { node: `>=${floor}` } }));
    const r = spawnSync("node", [CHECK], { cwd: dir, encoding: "utf8" });
    if (r.status === 0) {
      fail.push(`node-floor passed against a floor of >=${floor} on Node ${process.version} — it is not reading the floor`);
      continue;
    }
    const said = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (!said.includes(floor)) fail.push(`node-floor failed against >=${floor} but never named the REQUIRED version`);
    if (!said.includes(process.version)) fail.push(`node-floor failed against >=${floor} but never named the RUNNING version`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
