/**
 * What the package is, in two answers: its digest, and the description a person reads before
 * installing it.
 *
 * The digest is over the package's content, so the same flows rendered twice produce the same
 * identity. That is what lets a client tell "nothing changed" from "this is a new shelf", and
 * why every plugin's version carries it.
 */
import { createHash } from "node:crypto";

import { pluginName } from "@zz/catalog";

import { MARKETPLACE, type ClientPackage } from "../client-package.js";
import type { Plugin } from "../client-package.js";
import { entryCommand } from "./skills.js";

/** A short, stable digest of everything on this person's shelf — the plugin names and the
 * bytes of every file. Two people with the same shelf get the same digest; one changed
 * skill changes it. That is the whole job: give the runtime's version-keyed cache a reason
 * to notice. */
export function digestOf(plugins: Plugin[]): string {
  const h = createHash("sha256");
  for (const pl of [...plugins].sort((a, b) => a.name.localeCompare(b.name))) {
    feed(h, pl, true);
  }
  return h.digest("hex").slice(0, 8);
}

/** What one plugin is, which is a different question from the one above.
 *
 * `digestOf` answers what this person received: it runs over the whole shelf, includes each
 * server's URL, and is the runtime's per-person cache key. As an identity for a plugin it is
 * useless — every plugin on a shelf carries the same value, it moves when an unrelated plugin
 * moves, and it differs between two people running identical code.
 *
 * This answers what the plugin is: one plugin, and no server URL. The URL carries the
 * deployment's own base address, so including it would make two deployments running
 * byte-identical content disagree about what that content is. Everything else is the same
 * fields in the same order, fed by the same function.
 *
 * COUPLED: paired with the version a plugin declares, this is what makes that version true —
 * the gate compares them and refuses a release whose content moved while its number did not. */
export function digestOfPlugin(plugin: Plugin): string {
  const h = createHash("sha256");
  feed(h, plugin, false);
  return h.digest("hex").slice(0, 8);
}

/** The fields of one plugin, in a fixed order, into a hash.
 *
 * One function for both digests, so a field added to a plugin cannot be remembered in one and
 * forgotten in the other: a field left out of the shelf digest lets a content change move the
 * marketplace card while the version-keyed cache goes on serving the old text.
 *
 * `withUrl` is the only difference between the two. See digestOfPlugin. */
function feed(h: ReturnType<typeof createHash>, pl: Plugin, withUrl: boolean): void {
  h.update(pl.name).update("\0").update(pl.description).update("\0")
    .update(pl.required ? "required" : "optional").update("\0");
  for (const sv of [...pl.servers].sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(sv.name).update("\0");
    if (withUrl) h.update(sv.url).update("\0");
  }
  for (const f of [...pl.files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(f.path).update("\0").update(f.content).update("\0");
  }
}
/** The human-readable answer a person gets when they ask for their setup. */
export function describePackage(pkg: ClientPackage, target: string): string {
  const lines = [
    `# ZZ setup for ${target}`,
    ``,
    `## 1. Get a token (once)`,
    `Ask the **ZZ Access** agent for a token. It is shown ONCE. That agent is also`,
    `where you revoke a token you no longer trust. Then \`export ZZ_TOKEN=<it>\` for`,
    `the commands below.`,
    ``,
    `## 2. Install`,
    "```bash",
    ...pkg.install,
    "```",
    ``,
    `## 3. Use it`,
  ];

  // The baseline's own commands come first, listed whether or not a flow is installed: they
  // work on an empty account, because zz-core and zz-access are both required.
  //
  // COUPLED: both commands are zz-access's, not zz-core's. zz-core owns the record — documents,
  // knowledge, gates; zz-access owns your access to it, which is what a client's setup and its
  // currency are. `checks/skill-homes.ts` holds the same line for the skills themselves.
  lines.push(
    `\`/zz-access:doctor\` checks this machine can reach the platform, and names the fix when it cannot.`,
    `\`/zz-access:update\` brings every ZZ plugin you have up to date, in one command.`,
    ``,
  );

  if (pkg.flows.length === 0) {
    lines.push(`The shelf has no flow yet.`);
  } else {
    // Read from the manifest, the same declaration the packager emits from, never spelled out
    // here: two places deciding one command name is how one of them stays wrong.
    //
    // A flow that declares no command for its entry is left out rather than given an invented
    // name: it has no front door to type, and the router sentence below is how it is reached.
    const typed = pkg.flows.flatMap((f) => {
      const cmd = entryCommand(f.flow, f.entry || f.flow);
      return cmd ? [`\`/${pluginName(f.flow)}:${cmd}\``] : [];
    });
    lines.push(
      `Install the flows you want from the shelf — none is required.`,
      ...(typed.length ? [`Once installed, type ${typed.join(" or ")} when you know what you want,`] : []),
      `${typed.length ? "or just describe" : "Describe"} the work and the \`zz-router\` skill will pick the flow.`,
    );
  }

  // Every flow travels as files, so a content fix does not reach this person by itself: every
  // flow's skills are files on their own disk.
  lines.push(
    ``,
    `## When the shelf changes`,
    "```bash",
    ...pkg.refresh,
    "```",
  );
  if (pkg.flows.length) {
    lines.push(
      `A flow travels as files, not as a pointer, so a fix on the platform reaches you only`,
      `when you update. Nothing warns you`,
      `otherwise, because the old files keep working:`,
      "```bash",
      // The platform does not know which plugins this person installed, so it names the
      // pattern rather than a list. `MARKETPLACE`, not a literal, so a rename of the shelf
      // reaches this text.
      `claude plugin update <plugin>@${MARKETPLACE} # for each plugin you installed`,
      "```",
    );
  }
  lines.push(``);
  lines.push(
    `## Removing it`,
    "```bash",
    ...pkg.remove,
    "```",
    ``,
    `## What this does NOT touch`,
    `Your \`CLAUDE.md\`, \`AGENTS.md\` and \`SOUL.md\` are left alone. Those change how`,
    `your engine behaves for *everything*, and a flow has no business there. Outside`,
    `the flow you keep exactly the assistant you had.`,
  );


  if (pkg.notes.length) {
    lines.push(``, `## Notes`, ...pkg.notes.map((n) => `- ${n}`));
  }

  return lines.join("\n");
}
