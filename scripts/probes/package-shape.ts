/**
 * Build a real client package and assert what client-package says about itself. Run by the
 * gate; a file rather than an inline string because the assertions are full of regexes and
 * escaping them twice is how a probe ends up testing nothing.
 *
 * ZZ_CATALOG_DIR picks the catalog to build against; buildClientPackage reads it.
 */
import { buildClientPackage } from "../../services/gateway/dist/client-package.js";

const base = "https://zz.example";
const target = "a@b.example.com";

const bad: string[] = [];

const pkg = buildClientPackage({ target, base });
const paths = pkg.files.map((f) => f.path);

// The module's first stated rule: it never writes the engine-global files, because a flow
// placed there changes every task the person ever does, and two flows collide in one file.
for (const f of paths) {
  if (/(^|\/)(CLAUDE|AGENTS|SOUL)\.md$/.test(f)) bad.push(`the package writes ${f}`);
}

// One path per file: two entries at one path resolve to whichever wins on extraction.
const dupes = paths.filter((f, i) => paths.indexOf(f) !== i);
if (dupes.length) bad.push(`the package emits the same path twice: ${[...new Set(dupes)].join(", ")}`);

if (!paths.some((f) => /(^|\/)commands\//.test(f))) bad.push("the package carries no commands");

// A promoted skill's assets still travel — only its SKILL.md moves into commands/. zz-deck
// resolves its chassis relative to the plugin root, and a deck built without the chassis is
// the one failure that skill says to stop on.
//
// Every path is plugin-qualified, because the baseline and the catalog are built from
// different branches of client-package.ts and an unqualified path is satisfied by either.
const deckPromotions: [RegExp, string][] = [
  [/^zz-core\/skills\/zz-deck\/deck-chassis\.html$/, "the deck chassis did not travel with the promoted skill"],
  [/^zz-core\/skills\/zz-deck\/deck-guidebook\.html$/, "the deck guidebook did not travel with the promoted skill"],
  [/^zz-core\/commands\/deck\.md$/, "zz-deck was not promoted to zz-core/commands/deck.md"],
  [/^zz-core\/commands\/tldr\.md$/, "zz-tldr was not promoted to zz-core/commands/tldr.md"],
  [/^zz-core\/commands\/breakout\.md$/, "zz-breakout was not promoted to zz-core/commands/breakout.md"],
];
for (const [re, why] of deckPromotions) {
  if (!paths.some((f) => re.test(f))) bad.push(why);
}
// zz-authoring is a library: loaded by the other two, never typed. The manifest is the only
// thing deciding skill or command, so a stray entry in the commands map publishes one.
if (paths.some((f) => /^zz-core\/commands\/authoring\.md$/.test(f))) {
  bad.push("zz-authoring is a library and shipped as a command");
}
if (!paths.some((f) => /^zz-core\/skills\/zz-authoring\/SKILL\.md$/.test(f))) {
  bad.push("zz-authoring did not ship as a skill");
}
// The three machine-and-credential skills live in zz-access. Asserted on both sides — present
// there, absent from zz-core — because a move that left a copy behind ships two of everything
// and the shelf renders both without complaint.
for (const cmd of ["doctor", "update", "migrate"]) {
  if (!paths.some((f) => f === `zz-access/commands/${cmd}.md`)) {
    bad.push(`zz-${cmd} was not promoted to zz-access/commands/${cmd}.md`);
  }
  if (paths.some((f) => f === `zz-core/commands/${cmd}.md`)) {
    bad.push(`zz-core still ships commands/${cmd}.md — the skill moved to zz-access`);
  }
}
// And their scripts, which are the whole of what those three skills do. Source names, not
// shipped names: buildClientPackage reads catalog/ verbatim, and build-marketplace.ts
// substitutes the compiled .js only when it writes the tree.
// COUPLED: checks/marketplace-ships-js.ts asserts the shipped tree carries .js and no .ts.
for (const asset of ["zz-doctor/doctor.ts", "zz-update/update.ts", "zz-migrate/migrate.ts"]) {
  if (!paths.some((f) => f === `zz-access/skills/${asset}`)) {
    bad.push(`zz-access/skills/${asset} did not travel with the promoted skill`);
  }
}
// And the command must resolve the chassis from where it actually sits.
const deck = pkg.files.find((f) => /^zz-core\/commands\/deck\.md$/.test(f.path));
if (deck && !deck.content.includes("../skills/zz-deck/deck-chassis.html")) {
  bad.push("commands/deck.md no longer points at the chassis's real location");
}

// The execute bit: `zz-mcp-headers.sh` is run by the client to fetch the token at connect
// time, and a file without it is a silent auth failure rather than a readable error.
for (const f of pkg.files.filter((x) => /scripts\/zz-mcp-headers\.sh$/.test(x.path))) {
  if (f.mode !== 0o755) {
    bad.push(`${f.path} ships mode ${(f.mode ?? 0o644).toString(8)} — the client cannot run it`);
  }
}

// An install block a person pastes must not choose for them: zz-core and zz-access are
// required, and nothing else may install itself. The allowance names the required plugins and
// not the shelf they sit on, which is not this probe's fact to hold.
const live = pkg.install.filter((l) => /^\s*claude plugin install /.test(l));
const wrong = live.filter((l) => !/\b(zz-core|zz-access)@[A-Za-z0-9._-]+\b/.test(l));
if (wrong.length) {
  bad.push(`the install block installs without being asked: ${wrong.join(" | ")}`);
}

process.stdout.write(bad.join("; "));
