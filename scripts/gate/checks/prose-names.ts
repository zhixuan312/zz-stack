/**
 * Every name shipped prose spells out, against what this repository actually serves.
 *
 * COUPLED: what a skill says is skill-prose.ts and skill-tools.ts, and both stop at the skill
 * trees. This is wider — every `.md` under catalog/, marketplace/ and skills/, plus the
 * comments under scripts/gate/.
 *
 * Comments count as prose. In a gate check the comment is the only statement of what the rule
 * below it is for, so a comment naming a tool nobody registers misleads a reader exactly as a
 * skill misleads an agent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { commentsOnly, firstOf, root, sourceFiles, withoutComments } from "../read.ts";
import { check } from "../run.ts";
import { NAMING, catalogPackages, claimsOurs, claimsPreRename, everyShippedSkill, flows, platformSurface } from "../facts.ts";

/** The trees whose `.md` files are shipped to somebody. `marketplace/` is build output and is
 *  swept anyway, because it is what an installer receives; the fix for anything found there is
 *  in the source tree, never in the rendered copy. */
const PROSE = ["catalog", "marketplace", "skills"];

/** And the gate's own source, comments only — the whole of `scripts/gate/`, not just
 *  `checks/`: `facts.ts` and `read.ts` carry the derivations these rules are built out of, and
 *  their comments are where a name is explained rather than merely used. */
const GATE = "scripts/gate";

/** A call shape — backticked, backtick-then-paren, or quoted. COUPLED: the same extraction "a
 *  skill never names a platform tool that does not exist" uses, so the wide sweep and the
 *  narrow one cannot disagree about what counts as naming a tool. */
const CALL = /`([a-z][a-z0-9_]{3,40})[`(]|"([a-z][a-z0-9_]{3,40})"/g;

/** A snake_case word, bare — no backticks and no quotes required.
 *
 * DELIBERATE: no call shape required here. A tool name that is also ordinary English —
 * `approve`, `close`, `document` — would come out of every second sentence under a bare-word
 * rule, and the underscore settles that instead: a snake_case name is not a word anybody
 * writes by accident. A dead name in running comment prose is usually written bare, so
 * requiring a call shape would walk past most of them. */
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

const names = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[0]);

check("no shipped prose names a tool no door registers", () => {
  const s = platformSurface();
  // The two guards `platformSurface`'s own callers carry, because a derivation that came back
  // empty makes every check reading it pass on nothing.
  if (s.served.size < 30) return null;   // an empty platform surface is another check's finding
  if (s.closed < s.occurrences) {
    return `${s.occurrences - s.closed} of ${s.occurrences} inputSchema blocks under services/ ` +
           "could not be read, so the parameter names those registrations declare are not all " +
           "known and an argument would be reported as a tool that does not exist";
  }
  const md = sourceFiles(PROSE, [".md"]);
  const modules = sourceFiles([GATE], [".ts"]);
  // A sweep that reached nothing says so, rather than passing as coverage.
  if (md.length < 10) return `only ${md.length} .md files were found under ${PROSE.join(", ")} — this check swept almost nothing`;
  if (!modules.length) return `no module was found under ${GATE}/ — the comments this check is half about were not read`;

  const bad = [];
  for (const rel of md) {
    const txt = readFileSync(join(root, rel), "utf8");
    // A name on our surface in the current spelling, in call shape: `plugin_invented` is a
    // claim on the platform's `plugin` noun and no door registers it.
    for (const name of names(txt, CALL)) {
      if (s.served.has(name) || !claimsOurs(name, s)) continue;
      bad.push(`${rel} names \`${name}\`, which no door registers`);
    }
    // And in the verb-first spelling this platform abandoned: `claimsOurs` reads the first
    // segment, finds no tool registered under a noun by that name, and concludes the whole
    // thing is somebody else's.
    for (const name of names(txt, SNAKE)) {
      if (s.served.has(name) || !claimsPreRename(name, s)) continue;
      bad.push(`${rel} names \`${name}\`, a verb-first name from before the rename that no door registers`);
    }
  }

  let withComments = 0;
  for (const rel of modules) {
    const text = commentsOnly(readFileSync(join(root, rel), "utf8"));
    if (text.trim()) withComments++;
    // DELIBERATE: comments get the pre-rename reading only. A gate check's comments name real
    // tables, telemetry values, team slugs and SQL constraints in snake_case, and `claimsOurs`
    // reports every one of them. Nothing here has ever named a table, a column, a slug or a
    // constraint verb-first; that spelling only ever belonged to tools.
    for (const name of names(text, SNAKE)) {
      if (s.served.has(name) || !claimsPreRename(name, s)) continue;
      bad.push(`${rel} names ${name} in a comment, a tool this platform stopped registering`);
    }
  }
  if (withComments * 2 < modules.length) {
    return `${withComments} of ${modules.length} modules under ${GATE}/ yielded any comment text — the ` +
           "comment extraction is not reaching that tree, so its half of this check is blind";
  }
  return firstOf(bad, 12);
});

check("no shipped prose names a skill no plugin ships", () => {
  // COUPLED: "a skill_read a skill spells out names a skill that exists" and "no skill
  // references a skill that is not shipped" cover SKILL.md files. Neither reaches a reference
  // page, a command's markdown or the rendered copy an installer receives, which is what this
  // covers.
  //
  // The family is derived from the first segment of the skill names this repository ships, so
  // a kebab name under one of those prefixes is a claim that we ship it.
  const shipped = everyShippedSkill();
  if (shipped.size < 10) return `only ${shipped.size} shipped skills were found — the set this check compares against is not being read`;
  const families = new Set([...shipped].map((n) => n.split("-")[0]));
  // A plugin is not a skill and shares the families — `zz-core`, `sdlc-flow` and the rest are
  // packages, named in prose correctly. Derived from the catalog, so a new package never
  // becomes a false finding.
  const plugins = new Set(catalogPackages.map((p) => p.flow));
  const KEBAB = /`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[`(]|"([a-z][a-z0-9]*(?:-[a-z0-9]+)+)"/g;
  const md = sourceFiles(PROSE, [".md"]);
  if (md.length < 10) return `only ${md.length} .md files were found under ${PROSE.join(", ")} — this check swept almost nothing`;
  const bad = [];
  for (const rel of md) {
    for (const name of names(readFileSync(join(root, rel), "utf8"), KEBAB)) {
      if (shipped.has(name) || plugins.has(name) || !families.has(name.split("-")[0])) continue;
      bad.push(`${rel} names \`${name}\`, which no plugin ships`);
    }
  }
  // Call shape only, and here it is load-bearing: a skill name is hyphenated English, and "the
  // zz-core platform" in running prose is a sentence, not a citation. A backticked or quoted
  // name is an identifier the reader is expected to load.
  //
  // DELIBERATE: the comments under scripts/gate/ are not swept here, though the check above
  // sweeps them. They name skills this repository no longer ships, inside paragraphs explaining
  // what removing one caused.
  return firstOf(bad, 12);
});

check("no shipped prose types a slash command the plugin does not declare", () => {
  // A slash command spelled out in prose must be the plugin that declares it. Setup text a
  // person follows on their first day is the worst place for a command that does not exist.
  //
  // It sweeps source, not only markdown: `services/gateway/src/package/describe.ts` builds the
  // setup text at runtime inside a template literal.
  //
  // DELIBERATE: comments are excluded. The only hits in them quote a wrong form in order to
  // explain why it is wrong. `withoutComments` keeps strings and template literals, which is
  // where prose destined for a person lives.
  //
  // COUPLED: the prefix is derived through NAMING.pluginName, the same rule client-package.ts
  // publishes with, because the plugin a person types is not the flow's name — `sdlc-flow`
  // ships as `sdlc`.
  //
  // Only fires for one of our plugins, so an unfamiliar prefix never becomes a false finding.
  if (NAMING.error || !NAMING.pluginName) return NAMING.error ?? "NAMING has no pluginName";
  const shortOf = NAMING.pluginName;
  const declared = new Map<string, Set<string>>();
  for (const p of flows) {
    let manifest: unknown;
    try { manifest = JSON.parse(readFileSync(join(p.dir, "flow.json"), "utf8")); } catch { continue; }
    const m = manifest as { name?: string; commands?: Record<string, unknown> };
    if (typeof m.name !== "string") continue;
    declared.set(shortOf(m.name), new Set(Object.keys(m.commands ?? {})));
  }
  if (declared.size < 3) return `only ${declared.size} catalog manifests yielded a command list — this check has nothing to compare against`;

  const SLASH = /\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*):([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/g;
  const files = [...sourceFiles(PROSE, [".md"]), ...sourceFiles(["services", "scripts", "packages"], [".ts"])];
  if (files.length < 50) return `only ${files.length} files were swept — this check is not reaching the tree`;
  const bad: string[] = [];
  let cited = 0;
  for (const rel of files) {
    const raw = readFileSync(join(root, rel), "utf8");
    const text = rel.endsWith(".ts") ? withoutComments(raw) : raw;
    for (const match of text.matchAll(SLASH)) {
      const [, plugin, command] = match;
      const commands = declared.get(plugin);
      if (commands === undefined) continue;          // not one of ours
      cited++;
      if (commands.has(command)) continue;
      const owner = [...declared].find(([, set]) => set.has(command))?.[0];
      bad.push(`${rel} types \`/${plugin}:${command}\`, which ${plugin} does not declare`
               + (owner ? ` — ${owner} does` : ""));
    }
  }
  // A sweep that matches nothing is not a pass: zero citations means the pattern or the file
  // set is wrong, not that every citation is right.
  if (cited === 0) return "no slash command of ours was cited anywhere in the swept tree — the pattern is not matching";
  return firstOf(bad, 12);
});
