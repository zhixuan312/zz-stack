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

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. `unknown?.message` narrows to `{}`, which has no properties at all. */
function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}

const flows = [{
  flow: "sdlc-flow", version: "0.1.0", entry: "sdlc-flow", agentName: "SDLC Agent",
  whenToUse: "x", blocks: [], servers: [],
}];
const base = "https://zz.example";
const target = "a@b.example.com";

const bad: string[] = [];

// ONE FLOW WAS THE WHOLE CORPUS, so the failure below was invisible to it. A person in two
// teams that installed one flow differently produced two entries for it, and the renderer
// turned each into a plugin: two plugins of one name, and the same skill files written twice
// into one package, where the later write wins.
//
// The caller is fixed and this holds the package's own rule: one plugin per flow, refused
// loudly rather than rendered.
try {
  buildClientPackage({
    target, base,
    flows: [flows[0], { ...flows[0], version: "0.2.0", agentName: "Another Agent" }],
  });
  bad.push("a package built two plugins for one flow instead of refusing");
} catch (e) {
  if (!/more than once/.test(errMessage(e))) {
    bad.push(`two entries for one flow were refused, but not by that rule: ${errMessage(e)}`);
  }
}

const pkg = buildClientPackage({ target, base, flows });
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
// The allowance names the BASELINE PLUGIN, not the shelf it sits on. It was the literal
// `zz@zz-platform`, so renaming the marketplace to `zz-stack` turned a correct install block
// red — the probe was asserting which marketplace exists, a fact it has no business holding,
// on its way to asserting which plugin may install itself. `zz-core@` matches only the baseline:
// The baseline has since been renamed `zz` -> `zz-core`, so the name here moved with it;
// `zz-access@zz-stack` and the rest have no `zz-core@` in them.
const live = pkg.install.filter((l) => /^\s*claude plugin install /.test(l));
const wrong = live.filter((l) => !/\bzz-core@[A-Za-z0-9._-]+\b/.test(l));
if (wrong.length) {
  bad.push(`the install block installs without being asked: ${wrong.join(" | ")}`);
}

process.stdout.write(bad.join("; "));
