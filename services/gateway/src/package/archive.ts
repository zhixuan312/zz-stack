/**
 * The package as a file: its digest, its tarball, and the description a person reads before
 * installing it.
 *
 * The digest is over the package's CONTENT rather than the archive, so the same flows
 * installed twice produce the same identity even though gzip does not produce the same
 * bytes. That is what lets a client tell "nothing changed" from "this is a new package".
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { MARKETPLACE, isLocalOnly, type ClientPackage, type InstalledFlow, type PackageFile } from "../client-package.js";
import type { Plugin } from "../client-package.js";
import { commandName, pluginName } from "./skills.js";

/** A short, stable digest of everything on this person's shelf — the plugin names and the
 * bytes of every file. Two people with the same shelf get the same digest; one changed
 * skill changes it. That is the whole job: give the runtime's version-keyed cache a reason
 * to notice. */
export function digestOf(plugins: Plugin[]): string {
  const h = createHash("sha256");
  for (const pl of [...plugins].sort((a, b) => a.name.localeCompare(b.name))) {
    // The description counts. It is the marketplace card and it lands in plugin.json, but
    // it reaches those through the OUTER file list rather than pl.files — so editing a
    // flow.json description moved the card and left the digest still, and the runtime's
    // version-keyed cache went on serving the old text with no way to notice.
    h.update(pl.name).update("\0").update(pl.description).update("\0")
      .update(pl.required ? "required" : "optional").update("\0");
    for (const sv of [...pl.servers].sort((a, b) => a.name.localeCompare(b.name))) {
      h.update(sv.name).update("\0").update(sv.url).update("\0");
    }
    for (const f of [...pl.files].sort((a, b) => a.path.localeCompare(b.path))) {
      h.update(f.path).update("\0").update(f.content).update("\0");
    }
  }
  return h.digest("hex").slice(0, 8);
}
/** Minimal ustar writer. A tarball keeps the install to one command and, unlike
 * a git remote, needs nothing running on our side to serve it. Deterministic:
 * same package in, byte-identical archive out. */
export function tarGz(files: PackageFile[], prefix = ""): Buffer {
  const MTIME = 1700000000; // fixed, so the archive is reproducible
  const blocks: Buffer[] = [];

  for (const f of files) {
    const name = prefix ? `${prefix}/${f.path}` : f.path;
    if (Buffer.byteLength(name) > 100) throw new Error(`path too long for tar: ${name}`);
    const body = Buffer.from(f.content, "utf8");
    const head = Buffer.alloc(512);
    const put = (s: string, off: number, len: number) => head.write(s.slice(0, len), off, "ascii");
    const oct = (n: number, off: number, len: number) =>
      put(n.toString(8).padStart(len - 1, "0") + "\0", off, len);

    put(name, 0, 100);
    oct(f.mode ?? 0o644, 100, 8);
    oct(0, 108, 8);
    oct(0, 116, 8);
    oct(body.length, 124, 12);
    oct(MTIME, 136, 12);
    head.write("        ", 148, 8, "ascii"); // checksum field is spaces while summing
    put("0", 156, 1);
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    put("zz", 265, 32);
    put("zz", 297, 32);

    let sum = 0;
    for (const b of head) sum += b;
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);

    blocks.push(head, body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }

  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}
/** The human-readable answer a person gets when they ask for their setup. */
export function describePackage(pkg: ClientPackage, target: string): string {
  const lines = [
    `# ZZ setup for ${target} — ${pkg.kind}`,
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

  if (pkg.flows.length === 0) {
    lines.push(`No flow is installed for your team yet — ask a platform admin to install one.`);
  } else if (pkg.kind === "claude-code") {
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
  } else {
    lines.push(
      `Describe the work. The \`zz-router\` skill matches it and loads the right flow`,
      `(${pkg.flows.map((f) => f.flow).join(", ")}). There are no commands on this client.`,
    );
  }

  // Which flows travel as FILES decides whether a content fix reaches this person by
  // itself. This section used to promise, to everyone, that "a fix is live on your next
  // message" — true for a pointer flow and false for a local one, whose skills are files on
  // their disk. The release notes say the opposite and say it correctly; the person reads
  // this one, at the moment they install.
  const local = pkg.flows.filter(isLocalOnly);
  // Three clients, and this was a two-way ternary: hermes fell through to the claude-code
  // branch and would have been told to run `claude plugin update`, a command that client
  // does not have. It has no plugin CLI at all — refreshing it is the fetch above.
  const updateLines = (flows: InstalledFlow[]): string[] =>
    pkg.kind === "hermes"
      ? pkg.refresh
      // pluginName(f.flow), not f.flow. A flow named ops-flow ships as the plugin `sm` —
      // `install` uses the plugin name and this used the flow name, so the update command
      // handed to a person named a plugin they never installed and the runtime would say so.
      // The same two-places-one-name failure as the /zz: commands above, in the same file.
      // MARKETPLACE, not a literal. The shelf was renamed zz-platform -> zz-stack and this
      // line kept the old name — in the one paragraph a person reads AT INSTALL, telling
      // them to update against a marketplace their client has never heard of.
      : flows.map((f) => `${pkg.kind === "codex" ? "codex plugin upgrade" : "claude plugin update"} ${pluginName(f.flow)}@${MARKETPLACE}`);
  lines.push(
    ``,
    `## When a new flow is installed for your team`,
    "```bash",
    ...pkg.refresh,
    "```",
  );
  if (local.length) {
    lines.push(
      `Your team runs ${local.map((f) => f.flow).join(", ")} on this client only, so`,
      `${local.length === 1 ? "its method travels" : "their methods travel"} as files rather than being fetched.`,
      `A fix on the platform reaches you when you update the plugin — nothing warns you`,
      `otherwise, because the old files keep working:`,
      "```bash",
      ...updateLines(local),
      "```",
    );
  }
  const pointer = pkg.flows.filter((f) => !isLocalOnly(f));
  if (pointer.length) {
    lines.push(
      `Changes to ${pointer.map((f) => f.flow).join(", ")} need none of this — ${pointer.length === 1 ? "its" : "their"}`,
      `method is fetched from the platform on every run, so a fix is live on your next message.`,
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
