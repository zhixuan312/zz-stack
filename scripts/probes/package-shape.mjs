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

const flows = [{
  flow: "sdlc-flow", version: "0.1.0", entry: "sdlc-flow", agentName: "SDLC Agent",
  whenToUse: "x", blocks: [], servers: [],
}];
const base = "https://zz.example";
const target = "a@b.example.com";

const bad = [];

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
  if (!/more than once/.test(String(e.message))) {
    bad.push(`two entries for one flow were refused, but not by that rule: ${String(e.message)}`);
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
// sdlc-deck resolves its chassis relative to the plugin root, and a deck built without the
// chassis is the one failure that skill says to stop on. The guidebook travels too: it's the
// reference material a person reaches for, and gate.mjs reads it directly.
for (const [re, why] of [
  [/skills\/sdlc-deck\/deck-chassis\.html$/, "the deck chassis did not travel with the promoted skill"],
  [/skills\/sdlc-deck\/deck-guidebook\.html$/, "the deck guidebook did not travel with the promoted skill"],
  [/commands\/deck\.md$/, "sdlc-deck was not promoted to commands/deck.md"],
]) {
  if (!paths.some((f) => re.test(f))) bad.push(why);
}
// And the command must resolve the chassis from where it actually sits.
const deck = pkg.files.find((f) => /commands\/deck\.md$/.test(f.path));
if (deck && !deck.content.includes("../skills/sdlc-deck/deck-chassis.html")) {
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
// on its way to asserting which plugin may install itself. `zz@` matches only the baseline:
// `zz-access@zz-stack` and the rest have no `zz@` in them.
const live = pkg.install.filter((l) => /^\s*claude plugin install /.test(l));
const wrong = live.filter((l) => !/\bzz@[A-Za-z0-9._-]+\b/.test(l));
if (wrong.length) {
  bad.push(`the install block installs without being asked: ${wrong.join(" | ")}`);
}

process.stdout.write(bad.join("; "));
