#!/usr/bin/env node
/**
 * checks/release-record.ts — what a release's record says, read from the changelog's own section.
 *
 *   node checks/release-record.ts
 *
 * Exit 0: every shape the changelog has reads as the release record says. Exit 1: the first that did not.
 */
import { releaseFromChangelog, NO_CHANGELOG, UNKNOWN_ACTION } from "../scripts/release-record.ts";

const LOG = [
  "# Changelog", "",
  "## [0.96.0] — 2026-10-12 · console 0.27.0", "",
  "This release mounts the assistant. It answers from the page you are on.", "",
  "### zz-stack 0.96.0", "",
  "- **The assistant is mounted.** It answers from the page you are on.", "",
  "### Upgrade notes", "",
  "- **Re-pull the plugins.** Every client takes the new skill text on its next pull.", "",
  "## [0.92.13] — 2026-10-08", "",
  "### Added", "",
  "- A team reads its own refusals by owner. The table groups them.", "",
  "### Console", "",
  "- The table keeps its sort.", "",
  "### zz-stack-dashboard 0.24.1", "",
  "- The table keeps its sort.", "",
  "## [0.60.0] — 2026-09-22", "",
  "**This deployment now runs PostgreSQL 17.** Its data moves on the next start.", "",
  "## [0.40.0] — 2026-09-16", "",
  "- **Breaking:** `zz-old` is gone. Use `zz-new`.", "",
  "### Upgrade notes", "",
  "**Migration 061 alters one constraint.** It needs no extension.", "",
  "## [0.50.0] — 2026-09-20", "",
  "### Fixed", "",
  "- **Search widens once.** A narrow question no longer returns nothing.", "",
  "### Upgrade notes — replay removal and platform tools", "",
  "- Run the reindex once. It takes a minute.", "",
  "## zz-stack-dashboard 0.22.0", "",
  "- A stray heading the parser must not take for a version.", "",
].join("\n");

const problems: string[] = [];
const expect = (what: string, ok: boolean, got: unknown) => { if (!ok) problems.push(`${what}: got ${JSON.stringify(got)}`); };

const a = releaseFromChangelog(LOG, "0.96.0");
expect("summary is the opening paragraph's first sentence", a.summary === "This release mounts the assistant.", a.summary);
expect("console from the heading", a.consoleVersion === "0.27.0", a.consoleVersion);
expect("upgrade notes kept", a.upgradeNotes !== null && a.upgradeNotes.includes("Re-pull the plugins."), a.upgradeNotes);
expect("client action from the notes' bold lead", a.clientAction === "Re-pull the plugins.", a.clientAction);
expect("section without its heading", !a.changelog.includes("## [0.96.0]") && a.changelog.includes("The assistant is mounted."), a.changelog);

const b = releaseFromChangelog(LOG, "0.92.13");
expect("console from the subsection, not the Console heading", b.consoleVersion === "0.24.1", b.consoleVersion);
expect("summary is the first bullet's first sentence when nothing else leads", b.summary === "A team reads its own refusals by owner.", b.summary);
expect("no upgrade notes is nothing to do", b.upgradeNotes === null && b.clientAction === null, b);
expect("the section ends at the next version", !b.changelog.includes("Search widens once."), b.changelog);

const c = releaseFromChangelog(LOG, "0.50.0");
expect("summary is the first bullet's bold lead", c.summary === "Search widens once.", c.summary);
expect("an upgrade-notes heading with a suffix is still upgrade notes", c.upgradeNotes !== null && c.clientAction === "Run the reindex once.", c);
expect("the stray heading is not part of a version", !c.changelog.includes("stray heading"), c.changelog);
expect("no console named", c.consoleVersion === null, c.consoleVersion);

const e = releaseFromChangelog(LOG, "0.60.0");
expect("a bold opening paragraph is a summary without its markers", e.summary === "This deployment now runs PostgreSQL 17.", e.summary);

const g = releaseFromChangelog(LOG, "0.40.0");
expect("a bold label is not a summary; the sentence after it is, without its markers", g.summary === "zz-old is gone.", g.summary);
expect("upgrade notes with no bullet still name the action", g.clientAction === "Migration 061 alters one constraint.", g.clientAction);

const d = releaseFromChangelog(LOG, "0.31.1");
expect("a tag with no section", d.summary === NO_CHANGELOG && d.changelog === NO_CHANGELOG, d);
expect("its action is unknown, never nothing to do", d.clientAction === UNKNOWN_ACTION && d.upgradeNotes === null, d);
expect("the unknown action reads as the spec says", UNKNOWN_ACTION === "Unknown — no recorded upgrade notes", UNKNOWN_ACTION);

if (problems.length) { console.error(`release-record: FAILED\n  ${problems.join("\n  ")}`); process.exitCode = 1; }
else console.log("release-record: every changelog shape reads as a release record: ok");
