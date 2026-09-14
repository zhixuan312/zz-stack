/**
 * Step 1a — the one step in this release nothing computes for you.
 *
 * WHAT IT ASKS. Does each plugin's tool surface deliver the purpose its manifest states?
 * `purpose` is the sentence that decides whether a capability belongs in THIS plugin or the
 * next one (ARCHITECTURE.md §3b), and the gate already refuses a plugin that declares none.
 * What the gate cannot do is read the purpose, read the tools, and say the second delivers the
 * first — that is a judgement about meaning, and a check claiming to compute it would be
 * asserting a verdict it did not reach. So this prints both sides and stops.
 *
 * WHY IT STOPS RATHER THAN WARNS. A review step that prints and carries on is a review step
 * nobody does twice. The attestation is a flag, not a prompt, because this script runs from a
 * terminal and from CI and a `readline` would behave differently in the two. The flag says a
 * person looked; it says nothing about what they concluded, and nothing here records a verdict.
 *
 * WHY IT IS BEFORE THE BUILD. Same rule as the credential check below it: after production is
 * live is the wrong place to find out. This reads the checkout only — no host, no token, no
 * probe — so it is free to run and cannot produce an `unknown`.
 *
 * WHY THE DOOR MAP IS WRITTEN OUT. There is nothing on a manifest that says which SOURCE
 * registers the tools behind a door — the mount happens in the gateway, long after the
 * registrations — so the honest options are a table here or a guess. A door this table does not
 * know REFUSES the release rather than printing an empty tool list: an empty list beside a
 * purpose reads as "this plugin ships no tools", which is the one answer a reviewer must never
 * be handed by accident.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { die, log, root } from "../deployment.ts";

/** Door path → the source that registers what it serves. */
const DOORS: Record<string, string[]> = {
  "/core/mcp": ["services/zz-core/src/tools"],
  "/eval/mcp": ["services/zz-core/src/eval"],
  "/manage/mcp": ["services/gateway/src/admin", "services/gateway/src/access-door.ts",
                  "services/gateway/src/admin.ts", "services/gateway/src/settings.ts",
                  "services/gateway/src/settings"],
};

/** Every `.ts` under a directory, or the file itself — missing paths are skipped, because the
 *  list above spans two services and not every spelling exists in both. */
function sources(rel: string): string[] {
  const p = join(root, rel);
  if (!existsSync(p)) return [];
  if (p.endsWith(".ts")) return [p];
  return readdirSync(p, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(p, e.name));
}

/** The tool names a door registers. `registerTool(` is the literal every gate check splits
 *  tool source on, so this reads the surface the same way the rest of the repository does. */
function toolsBehind(path: string): string[] | null {
  const roots = DOORS[path];
  if (!roots) return null;
  const names = new Set<string>();
  for (const rel of roots) {
    for (const f of sources(rel)) {
      for (const m of readFileSync(f, "utf8").matchAll(/registerTool\(\s*"([a-z0-9_]+)"/g)) {
        names.add(m[1]);
      }
    }
  }
  return [...names].sort();
}

/** The three fields this review reads out of a flow.json — everything a manifest may declare
 *  beyond these is somebody else's business. */
interface FlowManifest {
  purpose?: string;
  servers?: { path: string }[];
  stages?: { name: string; produces?: string }[];
}

function manifests(): { owner: string; pkg: string; m: FlowManifest }[] {
  const out: { owner: string; pkg: string; m: FlowManifest }[] = [];
  const cat = join(root, "catalog");
  for (const owner of readdirSync(cat)) {
    for (const pkg of readdirSync(join(cat, owner))) {
      const f = join(cat, owner, pkg, "flow.json");
      if (existsSync(f)) out.push({ owner, pkg, m: JSON.parse(readFileSync(f, "utf8")) });
    }
  }
  return out.sort((a, b) => a.pkg.localeCompare(b.pkg));
}

export const ATTEST = "--fit-for-purpose-reviewed";

export function fitForPurpose(attested: boolean): void {
  const all = manifests();
  if (!all.length) die("no catalog manifests were found — there is nothing to review");
  for (const { owner, pkg, m } of all) {
    log(`\n  \x1b[1m${owner}/${pkg}\x1b[0m`);
    log(`    purpose: ${m.purpose ?? "\x1b[31mNONE DECLARED\x1b[0m"}`);
    const doors = (m.servers ?? []).map((s) => s.path);
    if (!doors.length) {
      log("    doors:   none of its own — its agent reaches the baseline zz-core door");
    }
    for (const path of doors) {
      const tools = toolsBehind(path);
      if (!tools) {
        die(`${owner}/${pkg} declares the door ${path} and scripts/release/fit-for-purpose.ts ` +
            "does not know what registers it. Add it to DOORS there — a reviewer handed an " +
            "empty tool list would read it as a plugin that ships none.");
      }
      // EVERY NAME THE DOOR CAN REGISTER, not the list one caller sees. `/manage/mcp` is built
      // per request and its tool list IS the caller's role, so a role-shaped list would ask the
      // reviewer to pick a role before they had seen the surface. The superset is the thing
      // being judged for fit: a tool that does not belong on the door does not belong on it at
      // any role.
      log(`    ${path} — ${tools.length} tool(s) across every role: ${tools.join(", ")}`);
    }
    for (const s of m.stages ?? []) {
      log(`    stage ${s.name} produces ${s.produces ?? "\x1b[31mNOTHING DECLARED\x1b[0m"}`);
    }
  }
  log("\n  \x1b[1mDoes each plugin's tool surface above deliver the purpose printed with it?\x1b[0m");
  log("  Judge three things, and nothing here computes any of them:");
  log("    1. a tool on the door that no part of the purpose asks for");
  log("    2. a sentence of the purpose no tool on the door can carry out");
  log("    3. a stage whose `produces` names a document the purpose never needed");
  if (!attested) {
    die("this release has not been reviewed for fit. Read the surfaces above, then re-run " +
        `with ${ATTEST}.\n        The flag records that somebody looked. It records no ` +
        "verdict, and nothing here will compute one for you.");
  }
  log(`  \x1b[32m${ATTEST} given — reviewed by the operator running this release.\x1b[0m`);
}
