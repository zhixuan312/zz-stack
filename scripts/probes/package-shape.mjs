/**
 * Build a real client package for each client and assert what client-package says about
 * itself. Run by the gate; a file rather than an inline string because the assertions are
 * full of regexes and escaping them twice is how a probe ends up testing nothing.
 *
 * ZZ_CATALOG_DIR picks the catalog to build against; buildClientPackage reads it. This said
 * argv[2], which nothing here has ever read — the gate has always passed the env var.
 */
import { gunzipSync } from "node:zlib";

import { CLIENT_KINDS, buildClientPackage } from "../../services/gateway/dist/client-package.js";
import { tarGz } from "../../services/gateway/dist/package/archive.js";

const flows = [{
  flow: "sdlc-flow", version: "0.1.0", entry: "sdlc-flow", agentName: "SDLC Agent",
  whenToUse: "x", blocks: [], servers: [], clients: ["claude-code"],
}];

const bad = [];

// ONE FLOW WAS THE WHOLE CORPUS, so the failure below was invisible to it. A person in two
// teams that installed one flow differently produced two entries for it — `distinct` keeps
// both rows whenever the version, the agent name or the client list differs — and the
// renderer turned each into a plugin: two plugins of one name, and the same skill files
// written twice into one tarball, where extraction takes whichever wins.
//
// The caller is fixed and this holds the package's own rule: one plugin per flow, refused
// loudly rather than rendered.
try {
  buildClientPackage({
    target: "a@b.example.com", kind: "claude-code", base: "https://zz.example",
    flows: [flows[0], { ...flows[0], version: "0.2.0", agentName: "Another Agent" }],
  });
  bad.push("a package built two plugins for one flow instead of refusing");
} catch (e) {
  if (!/more than once/.test(String(e.message))) {
    bad.push(`two entries for one flow were refused, but not by that rule: ${String(e.message)}`);
  }
}
// FROM THE MODULE, not retyped. Every production reader of the client list — the /pkg route,
// install_client_package, render_harness_config, ALL_CLIENTS — takes CLIENT_KINDS; this probe
// was the one place that spelled it out again, so a fourth client would have been served by
// the gateway and covered by nothing here, silently. The probe going quiet is the failure
// mode a hand-kept copy of a list has.
for (const kind of CLIENT_KINDS) {
  const pkg = buildClientPackage({ target: "a@b.example.com", kind, base: "https://zz.example", flows });
  const paths = pkg.files.map((f) => f.path);

  // The module's first stated rule: it never writes the engine-global files, because a flow
  // placed there changes every task the person ever does, and two flows collide in one file.
  for (const f of paths) {
    if (/(^|\/)(CLAUDE|AGENTS|SOUL)\.md$/.test(f)) bad.push(`${kind} writes ${f}`);
  }

  // One tar path per file. Two entries at one path resolve to whichever wins on extraction,
  // which has happened here before with the router.
  const dupes = paths.filter((f, i) => paths.indexOf(f) !== i);
  if (dupes.length) bad.push(`${kind} emits the same path twice: ${[...new Set(dupes)].join(", ")}`);

  // Commands exist on Claude Code alone; the others reach a flow through its skills.
  const cmds = paths.filter((f) => /(^|\/)commands\//.test(f));
  if (kind === "claude-code" && cmds.length === 0) bad.push("claude-code package carries no commands");
  if (kind !== "claude-code" && cmds.length) {
    bad.push(`${kind} carries commands it cannot run: ${cmds.join(", ")}`);
  }

  // A promoted skill's ASSETS still travel — only its SKILL.md moves into commands/.
  // sdlc-deck resolves its chassis relative to the plugin root, and a deck built without
  // the chassis is the one failure that skill says to stop on. The guidebook travels too:
  // it's the reference material a person reaches for, and gate.mjs now reads it directly.
  if (kind === "claude-code") {
    if (!paths.some((f) => /skills\/sdlc-deck\/deck-chassis\.html$/.test(f))) {
      bad.push("the deck chassis did not travel with the promoted skill");
    }
    if (!paths.some((f) => /skills\/sdlc-deck\/deck-guidebook\.html$/.test(f))) {
      bad.push("the deck guidebook did not travel with the promoted skill");
    }
    if (!paths.some((f) => /commands\/deck\.md$/.test(f))) {
      bad.push("sdlc-deck was not promoted to commands/deck.md");
    }
    // And the command must resolve the chassis from where it actually sits.
    const deck = pkg.files.find((f) => /commands\/deck\.md$/.test(f.path));
    if (deck && !deck.content.includes("../skills/sdlc-deck/deck-chassis.html")) {
      bad.push("commands/deck.md no longer points at the chassis's real location");
    }
  }
  // ustar caps a path at 100 bytes and tarGz THROWS past it. That throw reaches a person as
  // "package render failed" with the reason only in the server log, at the moment they are
  // installing — so it is worth failing here instead, with the path that did it. The
  // longest today is around 60 bytes; a flow with a long name and a long skill name inside
  // it is what would close that gap, and nothing else would notice until someone tried.
  const prefix = pkg.archivePrefix ? `${pkg.archivePrefix}/` : "";
  for (const f of pkg.files) {
    const full = prefix + f.path;
    const bytes = Buffer.byteLength(full);
    if (bytes > 100) bad.push(`${kind}: ${full} is ${bytes} bytes, and tar refuses over 100`);
  }

  // THE ARCHIVE ITSELF, not only the length of the paths going into it. tarGz is a
  // hand-rolled ustar writer — forty lines of octal field offsets and a checksum summed by
  // hand — and nothing ran it. A wrong offset or a bad checksum produces a file that builds
  // fine here and fails at `tar xz` on somebody's machine, at the moment they are installing,
  // which is the worst place for it and the one this probe's path check already names.
  //
  // Parsed in process rather than shelling out to tar: the gate has to run anywhere, and a
  // reader that checks the checksums is a stronger claim than one that trusts a binary.
  const archive = tarGz(pkg.files, pkg.archivePrefix);
  if (!tarGz(pkg.files, pkg.archivePrefix).equals(archive)) {
    bad.push(`${kind}: tarGz is not deterministic — the module promises byte-identical output`);
  }
  const raw = gunzipSync(archive);
  const seen = new Map();
  for (let off = 0; off + 512 <= raw.length; ) {
    const head = raw.subarray(off, off + 512);
    if (head.every((b) => b === 0)) break;                    // end-of-archive
    const str = (o, n) => head.subarray(o, o + n).toString("ascii").replace(/\0.*$/s, "").trim();
    const num = (o, n) => parseInt(str(o, n) || "0", 8);
    // The checksum, recomputed exactly as a reader does: the field itself counts as spaces.
    const stated = num(148, 8);
    const zeroed = Buffer.from(head);
    zeroed.write("        ", 148, 8, "ascii");
    let sum = 0;
    for (const b of zeroed) sum += b;
    if (sum !== stated) {
      bad.push(`${kind}: ${str(0, 100) || "(unnamed)"} has checksum ${stated}, computed ${sum}`);
      break;
    }
    if (str(257, 6) !== "ustar") bad.push(`${kind}: ${str(0, 100)} is not a ustar header`);
    const size = num(124, 12);
    seen.set(str(0, 100), { size, mode: num(100, 8), mtime: num(136, 12) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  const wantPrefix = pkg.archivePrefix ? `${pkg.archivePrefix}/` : "";
  for (const f of pkg.files) {
    const entry = seen.get(wantPrefix + f.path);
    if (!entry) { bad.push(`${kind}: ${f.path} is not in the archive`); continue; }
    if (entry.size !== Buffer.byteLength(f.content)) {
      bad.push(`${kind}: ${f.path} is ${entry.size} bytes in the archive, ${Buffer.byteLength(f.content)} in the package`);
    }
    if ((f.mode ?? 0o644) !== entry.mode) {
      bad.push(`${kind}: ${f.path} lost its mode — ${entry.mode.toString(8)}, wanted ${(f.mode ?? 0o644).toString(8)}`);
    }
  }
  // REPRODUCIBLE MEANS ACROSS BUILDS, which is why the timestamp is a constant and not the
  // clock. Building twice and comparing cannot see that: both calls land in the same second,
  // so a `Date.now()` there produces identical bytes here and a different archive tomorrow.
  // What a single run CAN see is that the recorded time is not the time of the run.
  const now = Date.now() / 1000;
  for (const [name, e] of seen) {
    if (Math.abs(now - e.mtime) < 86_400) {
      bad.push(`${kind}: ${name} is stamped with the build clock (${e.mtime}), so the archive ` +
               `differs every build — tarGz promises a fixed mtime`);
      break;
    }
  }
  if (seen.size !== pkg.files.length) {
    bad.push(`${kind}: the archive holds ${seen.size} entries for ${pkg.files.length} files`);
  }

  // An install block a person PASTES must not choose for them. Every optional plugin was
  // listed as a live command directly under "take what you want, and nothing else", so
  // following the instructions installed all of them — including, at the time, zz-admin,
  // which can create teams and must never arrive by default. The whole reason there is a plugin per flow is
  // that installing one used to bring everything.
  //
  // EVERY client's verb, not just Claude Code's. The first version of this matched
  // `claude plugin install` alone, so the identical defect in the Codex branch — the same
  // list, the same sentence above it, `codex plugin add` instead — passed untouched. A probe
  // narrower than the code it guards finds the instance you already knew about.
  const live = pkg.install.filter((l) => /^\s*(claude plugin install|codex plugin add) /.test(l));
  const wrong = live.filter((l) => !/\bzz@zz-platform\b/.test(l));
  if (wrong.length) {
    bad.push(`${kind} install block installs without being asked: ${wrong.join(" | ")}`);
  }
}
process.stdout.write(bad.join("; "));
