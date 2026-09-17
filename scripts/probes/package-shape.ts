/**
 * Build a real client package and assert what client-package says about itself. Run by the
 * gate; a file rather than an inline string because the assertions are full of regexes and
 * escaping them twice is how a probe ends up testing nothing.
 *
 * ZZ_CATALOG_DIR picks the catalog to build against; buildClientPackage reads it.
 *
 * HALF OF THIS PROBE WAS A TAR READER. It gunzipped the archive, walked the ustar headers,
 * recomputed every checksum by hand and asserted the recorded mtime was not the build clock
 * — because `tarGz` was forty lines of octal field offsets that nothing else ran, and a bad
 * offset produced a file that built here and failed at `tar xz` on somebody's machine. The
 * tarball went with Codex and Hermes on 2026-09-12; Claude Code clones the shelf from git,
 * which has its own integrity. What is left is what was never about the archive: the rules
 * the package keeps about its own contents.
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

// One path per file. Two entries at one path resolve to whichever wins on extraction, which
// has happened here before with the router.
const dupes = paths.filter((f, i) => paths.indexOf(f) !== i);
if (dupes.length) bad.push(`the package emits the same path twice: ${[...new Set(dupes)].join(", ")}`);

if (!paths.some((f) => /(^|\/)commands\//.test(f))) bad.push("the package carries no commands");

// A promoted skill's ASSETS still travel — only its SKILL.md moves into commands/.
// zz-deck resolves its chassis relative to the plugin root, and a deck built without the
// chassis is the one failure that skill says to stop on. The guidebook travels too: it's the
// reference material a person reaches for, and gate.ts reads it directly.
//
// EVERY PATH IS PLUGIN-QUALIFIED, and that is the half this probe was missing. The deck moved
// from sdlc-flow to the baseline on 2026-09-14, and the baseline is built from a DIFFERENT
// branch of client-package.ts — `baselineFiles`, over the tree at `skills/`, not
// `residentFiles` over the catalog. An unqualified `commands/deck.md$` is satisfied by either
// branch, so it would have gone on passing had the deck shipped from the flow, from the
// baseline, or from both at once. `zz-core/` in front of it is what makes it an assertion
// about where the deck actually is.
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
// zz-authoring is a LIBRARY: loaded by the other two, never typed. It ships as a skill and
// must not become a command — the manifest is the only thing that decides which, so a stray
// entry in the commands map would silently add a command nobody meant to publish.
if (paths.some((f) => /^zz-core\/commands\/authoring\.md$/.test(f))) {
  bad.push("zz-authoring is a library and shipped as a command");
}
if (!paths.some((f) => /^zz-core\/skills\/zz-authoring\/SKILL\.md$/.test(f))) {
  bad.push("zz-authoring did not ship as a skill");
}
// The three that went the other way: machine and credential, out of the baseline into
// zz-access. Asserted on BOTH sides — present there, absent here — because a move that left a
// copy behind ships two of everything and the shelf renders both without complaint.
for (const cmd of ["doctor", "update", "migrate"]) {
  if (!paths.some((f) => f === `zz-access/commands/${cmd}.md`)) {
    bad.push(`zz-${cmd} was not promoted to zz-access/commands/${cmd}.md`);
  }
  if (paths.some((f) => f === `zz-core/commands/${cmd}.md`)) {
    bad.push(`zz-core still ships commands/${cmd}.md — the skill moved to zz-access`);
  }
}
// And their scripts, which are the whole of what those three skills do.
// SOURCE NAMES, NOT SHIPPED NAMES. buildClientPackage reads catalog/ verbatim, so the
// package it returns carries the .ts source; build-marketplace.ts substitutes the compiled
// .js only when it writes the tree. This probe inspects the package, so it asserts the
// source travelled. That the SHIPPED tree carries .js and no .ts is a different claim, and
// checks/marketplace-ships-js.ts is what makes it.
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

// THE EXECUTE BIT, which the tar reader used to cover. `zz-mcp-headers.sh` is run by the
// client to fetch the token at connect time, and a file without it is a silent auth failure
// rather than an error anyone can read. git preserves the bit; the package has to set it.
for (const f of pkg.files.filter((x) => /scripts\/zz-mcp-headers\.sh$/.test(x.path))) {
  if (f.mode !== 0o755) {
    bad.push(`${f.path} ships mode ${(f.mode ?? 0o644).toString(8)} — the client cannot run it`);
  }
}

// An install block a person PASTES must not choose for them. Every optional plugin was listed
// as a live command directly under "take what you want, and nothing else", so following the
// instructions installed all of them — including, at the time, zz-admin, which can create
// teams and must never arrive by default. The whole reason there is a plugin per flow is that
// installing one used to bring everything.
//
// The allowance names the REQUIRED PLUGINS, not the shelf they sit on — asserting which
// marketplace exists is a fact this probe has no business holding. zz-core and zz-access are
// required, and nothing else may install itself.
const live = pkg.install.filter((l) => /^\s*claude plugin install /.test(l));
const wrong = live.filter((l) => !/\b(zz-core|zz-access)@[A-Za-z0-9._-]+\b/.test(l));
if (wrong.length) {
  bad.push(`the install block installs without being asked: ${wrong.join(" | ")}`);
}

process.stdout.write(bad.join("; "));
