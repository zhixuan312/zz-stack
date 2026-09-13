/**
 * What the package IS, in two answers: its digest, and the description a person reads before
 * installing it.
 *
 * The digest is over the package's CONTENT, so the same flows rendered twice produce the same
 * identity. That is what lets a client tell "nothing changed" from "this is a new shelf", and
 * it is why every plugin's version carries it.
 *
 * This file was `archive.ts` and also held `tarGz`, a hand-rolled ustar writer, because the
 * package was served as a tarball from `/pkg/`. Claude Code clones the shelf from git now and
 * the archive has no reader, so the name stopped describing the file.
 */
import { createHash } from "node:crypto";

import { MARKETPLACE, type ClientPackage } from "../client-package.js";
import type { Plugin } from "../client-package.js";
import { commandName, pluginName } from "./skills.js";

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

/** WHAT ONE PLUGIN *IS*, which is a different question from the one above.
 *
 * `digestOf` answers "what did this PERSON receive": it runs over the whole shelf, it includes
 * each server's URL, and it is the runtime's per-person cache key. Correct for that job, and
 * useless as an identity for a plugin — every plugin on a shelf carries the same value, it
 * moves when an unrelated plugin moves, and it differs between two people running identical
 * code. `claude plugin list` shows it: sdlc and zz both read 0.29.0+1e7d702a.
 *
 * This answers "what IS this plugin": one plugin, and no server URL. The URL carries the
 * deployment's own base address, so including it would make two deployments running
 * byte-identical content disagree about what that content is — the opposite of what a content
 * identity is for. Everything else is the same fields in the same order, fed by the same
 * function, so the two cannot drift apart.
 *
 * Paired with the version a plugin declares, this is what makes that version TRUE: the gate
 * compares them and refuses a release whose content moved while its number did not. The same
 * argument skill-versions.mjs makes for skills, one level up. */
export function digestOfPlugin(plugin: Plugin): string {
  const h = createHash("sha256");
  feed(h, plugin, false);
  return h.digest("hex").slice(0, 8);
}

/** The fields of one plugin, in a fixed order, into a hash.
 *
 * ONE function for both digests so that adding a field to a plugin cannot be remembered in one
 * and forgotten in the other — which is how the description came to be left out of the shelf
 * digest for a while: editing a flow.json description moved the marketplace card and left the
 * digest still, and the version-keyed cache went on serving the old text with no way to notice.
 *
 * `withUrl` is the ONLY difference between the two, and it is not a detail. See digestOfPlugin. */
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
    `where you store your keys for the building blocks and revoke a token you no`,
    `longer trust. Then \`export ZZ_TOKEN=<it>\` for the commands below.`,
    ``,
    `## 2. Install`,
    "```bash",
    ...pkg.install,
    "```",
    ``,
    `## 3. Use it`,
  ];

  // THE BASELINE'S OWN COMMANDS COME FIRST, and they are listed whether or not a flow is
  // installed — they are the three that work on an empty account. `/zz:doctor` especially:
  // the moment this setup text is wrong about anything, it is the thing that says so, and a
  // person whose install did not take is exactly the person who cannot reach a flow to ask.
  lines.push(
    `\`/zz:doctor\` checks this machine can reach the platform, and names the fix when it cannot.`,
    `\`/zz:update\` brings every ZZ plugin you have up to date, in one command.`,
    ``,
  );

  if (pkg.flows.length === 0) {
    lines.push(`No flow is installed for your team yet — ask a platform admin to install one.`);
  } else {
    // DERIVED from the same two functions that name the commands, never spelled out here.
    // This said `/zz:<flow>` — the namespace from when every flow shipped inside one `zz`
    // plugin — so the setup text a person reads told them to type a command that does not
    // exist: the real one is /sm:flow, not /zz:ops-flow. commandFile's frontmatter carries a
    // comment about this exact mistake, because it was fixed there and not here. Two places
    // deciding one name is how one of them stays wrong.
    const typed = pkg.flows.map((f) => {
      const plugin = pluginName(f.flow);
      return `\`/${plugin}:${commandName(plugin, f.entry || f.flow)}\``;
    });
    lines.push(
      `Type ${typed.join(" or ")} when you know what you want,`,
      `or just describe the work and the \`zz-router\` skill will pick the flow.`,
    );
  }

  // EVERY flow travels as FILES, so a content fix does NOT reach this person by itself.
  //
  // This section used to split them: a flow served to a browser fetched its method on every
  // run ("a fix is live on your next message"), a flow shipped to a terminal did not. With
  // the browser front end gone and Claude Code the only client, there is no served half left
  // to contrast against — every flow's skills are files on their disk, and saying so once is
  // the whole of it.
  lines.push(
    ``,
    `## When a new flow is installed for your team`,
    "```bash",
    ...pkg.refresh,
    "```",
  );
  if (pkg.flows.length) {
    lines.push(
      `Your team's ${pkg.flows.length === 1 ? "flow travels" : "flows travel"} as files, not as a`,
      `pointer, so a fix on the platform reaches you only when you update. Nothing warns you`,
      `otherwise, because the old files keep working:`,
      "```bash",
      // pluginName(f.flow), not f.flow. A flow named ops-flow ships as the plugin `sm` —
      // `install` uses the plugin name and this used the flow name, so the update command
      // handed to a person named a plugin they never installed and the runtime would say so.
      //
      // MARKETPLACE, not a literal: the shelf was renamed zz-platform -> zz-stack and this
      // line kept the old name, in the one paragraph a person reads AT INSTALL.
      ...pkg.flows.map((f) => `claude plugin update ${pluginName(f.flow)}@${MARKETPLACE}`),
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

  if (pkg.blocks.length) {
    lines.push(
      ``,
      `## Building blocks`,
      `${pkg.blocks.join(", ")} — each call carries a key, and the audit always records`,
      `YOU as the caller. It has to be YOUR key: there is no shared team key to cover you.`,
      `Sign in to the block as yourself, or store your own once with the ZZ Access agent and`,
      `it works from every client.`,
    );
  }

  if (pkg.notes.length) {
    lines.push(``, `## Notes`, ...pkg.notes.map((n) => `- ${n}`));
  }

  return lines.join("\n");
}
