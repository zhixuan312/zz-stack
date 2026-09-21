/**
 * Every name shipped prose spells out, against what this repository actually serves.
 *
 * Not what a SKILL says — that is skill-prose.ts and skill-tools.ts, and both stop at the
 * skill trees. This is wider on purpose, because the third stale self-description this
 * initiative found was not in a skill at all. A pair of team-wide credential tools, deleted
 * outright along with the shared-credential tier, were registered nowhere and still named in
 * eight places: a gateway source comment, five comments inside this gate's own checks, and a
 * security check's own CASE NAME — so a check READ as covering a tool that does not exist, and
 * nothing noticed, because nothing was looking anywhere but at skills.
 *
 * COMMENTS COUNT AS PROSE. A comment naming a tool nobody registers misleads the next person
 * exactly as a skill misleads the next agent — worse, in a gate check, where the comment is
 * the only statement of what the rule below it is for. Five of the eight occurrences were
 * comments in this directory — three in security-secrets.ts, two in skill-tools.ts.
 *
 * WHY IT IS A MODULE OF ITS OWN. Its subject is not a skill: it sweeps every `.md` under
 * catalog/, marketplace/ and skills/, and the comments under scripts/gate/.
 * skill-prose.ts was 664 lines when this was written, against a 700-line ceiling this
 * repository measures and enforces, so there was no room to put it there and no reason to —
 * "what a skill's text may say" and "what any shipped prose may name" are two subjects.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { commentsOnly, firstOf, root, sourceFiles, withoutComments } from "../read.ts";
import { check } from "../run.ts";
import { NAMING, catalogPackages, claimsOurs, claimsPreRename, everyShippedSkill, flows, platformSurface } from "../facts.ts";

/** The trees whose `.md` files are shipped to somebody. `marketplace/` is build output and is
 *  swept anyway: it is what an installer actually receives, and a name that reaches it without
 *  being in `catalog/` or `skills/` is a renderer putting words in the platform's mouth. The
 *  fix for anything found there is in the source tree, never in the rendered copy. */
const PROSE = ["catalog", "marketplace", "skills"];

/** And the gate's own source, comments only. WHY THE WHOLE OF `scripts/gate/` and not just its
 *  `checks/` directory: `facts.ts` and `read.ts` carry the derivations these rules are built
 *  out of, and their comments are where a name is EXPLAINED rather than merely used — the
 *  longest prose about the platform's namespace in this repository is a docstring in facts.ts.
 *  A dead name is most misleading exactly there. Measured: widening from `checks/` to the whole
 *  directory adds no finding of its own. */
const GATE = "scripts/gate";

/** A CALL SHAPE — backticked, backtick-then-paren, or quoted. The same extraction "a skill
 *  never names a platform tool that does not exist" uses, deliberately, so the wider sweep and
 *  the narrow one cannot disagree about what counts as naming a tool. */
const CALL = /`([a-z][a-z0-9_]{3,40})[`(]|"([a-z][a-z0-9_]{3,40})"/g;

/** A SNAKE_CASE WORD, bare — no backticks and no quotes required.
 *
 * THE SPEC FOR THIS CHECK SAYS "only a call shape counts", and its reason is `approve`, `close`
 * and `document`: tool names that are also ordinary English, which a bare-word rule would
 * report out of every second sentence. An underscore settles that without the call shape
 * having to — a snake_case tool name is not a word anybody writes by accident, and both
 * predicates below already require one. What the call shape WOULD cost is the occurrences
 * that actually exist: of the five dead-name occurrences in this directory, four are written
 * bare in running comment prose and only one is backticked, so a call-shape rule reaches
 * skill-tools.ts and walks straight past security-secrets.ts entirely.
 *
 * Measured across all 61 `.md` files under the trees above and every comment under
 * scripts/gate/: bare snake words add no finding of their own beyond the dead names
 * this task removes. */
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

const names = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[0]);

check("no shipped prose names a tool no door registers", () => {
  const s = platformSurface();
  // The two guards `platformSurface`'s own callers carry, because a derivation that came back
  // empty makes every check reading it pass on nothing.
  if (s.served.size < 30) return null;   // the shape of those files changed; other checks say so
  if (s.closed < s.occurrences) {
    return `${s.occurrences - s.closed} of ${s.occurrences} inputSchema blocks under services/ ` +
           "could not be read, so the parameter names those registrations declare are not all " +
           "known and an argument would be reported as a tool that does not exist";
  }
  const md = sourceFiles(PROSE, [".md"]);
  const modules = sourceFiles([GATE], [".ts"]);
  // A SWEEP THAT REACHED NOTHING SAYS SO. This gate has already shipped one check whose regex
  // could not reach 6 of its 33 inputs and passed looking like coverage; an input set that has
  // become empty is the same failure one step earlier.
  if (md.length < 10) return `only ${md.length} .md files were found under ${PROSE.join(", ")} — this check swept almost nothing`;
  if (!modules.length) return `no module was found under ${GATE}/ — the comments this check is half about were not read`;

  const bad = [];
  for (const rel of md) {
    const txt = readFileSync(join(root, rel), "utf8");
    // A NAME ON OUR SURFACE IN THE CURRENT SPELLING, in call shape: `plugin_invented` is a
    // claim on the platform's `plugin` noun and no door registers it.
    for (const name of names(txt, CALL)) {
      if (s.served.has(name) || !claimsOurs(name, s)) continue;
      bad.push(`${rel} names \`${name}\`, which no door registers`);
    }
    // AND IN THE SPELLING THIS PLATFORM ABANDONED, bare or not. `claimsOurs` cannot see a
    // verb-first name — it reads the first segment, the verb, finds no tool registered under
    // a noun by that name, and concludes the whole thing is somebody else's. That blind spot
    // is exactly where the dead names were sitting.
    for (const name of names(txt, SNAKE)) {
      if (s.served.has(name) || !claimsPreRename(name, s)) continue;
      bad.push(`${rel} names \`${name}\`, a verb-first name from before the rename that no door registers`);
    }
  }

  let withComments = 0;
  for (const rel of modules) {
    const text = commentsOnly(readFileSync(join(root, rel), "utf8"));
    if (text.trim()) withComments++;
    // COMMENTS GET THE PRE-RENAME READING ONLY, and this is measured rather than assumed. A
    // gate check's comments are ABOUT this repository: they name a dropped table
    // (`platform_credential`), a telemetry string value (`skill_view`), a team slug
    // (`team_one`), a SQL constraint (`skill_kind_check`) and a deliberately invented example
    // (`plugin_invented`). Applying `claimsOurs` here reports all five and finds no dead tool
    // at all — five false positives for nothing, and every one of them a comment that cannot
    // honestly be rewritten, because the table, the slug and the constraint are real. The
    // verb-first reading reports the dead tools and nothing else, in the same files. Nothing
    // this repository has ever named a table, a column, a slug or a constraint verb-first;
    // that spelling only ever belonged to tools.
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
  // `skill_read("blocks-capabilities")` sat in zz-backbone — the skill every flow loads first —
  // for as long as that skill was gone. "a skill_read a skill spells out names a skill that
  // exists" catches that form, and "no skill references a skill that is not shipped" catches a
  // backticked SIBLING inside a flow. Neither reaches a `.md` that is not a SKILL.md, and
  // neither reaches a cross-family citation from outside a flow's own skill tree — a reference
  // page, a command's markdown, the rendered copy an installer receives.
  //
  // THE FAMILY IS DERIVED, like everything else here: the first segment of the names this
  // repository actually ships. `zz-`, `sdlc-` and `building-` are what our skills are called,
  // so a kebab name under one of those prefixes is a claim that WE ship it.
  const shipped = everyShippedSkill();
  if (shipped.size < 10) return `only ${shipped.size} shipped skills were found — the set this check compares against is not being read`;
  const families = new Set([...shipped].map((n) => n.split("-")[0]));
  // A PLUGIN IS NOT A SKILL and shares the families. `zz-core`, `zz-access`, `sdlc-flow` and
  // `zz-plugin-eval` are packages, named in prose constantly and correctly; derived from the
  // catalog rather than written down, so a new package never becomes a false finding.
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
  // CALL SHAPE ONLY, and here it IS load-bearing: a skill name is hyphenated English, and
  // "the zz-core platform" in running prose is a sentence, not a citation. The convention this
  // repository already relies on is that a backticked or quoted name is an identifier the
  // reader is expected to load.
  //
  // THE COMMENTS UNDER scripts/gate/ ARE DELIBERATELY NOT SWEPT HERE, and the check
  // above says why the other half of it sweeps them. Measured: those comments name thirteen
  // skills this repository no longer ships — `zz-block-defects`, `zz-journal`, `zz-kb-usage`,
  // `zz-okr` and the rest — every one inside a paragraph explaining the defect that removing
  // it caused. That is a check's history, correct as written; a rule demanding it be deleted
  // would delete the reason the rule exists.
  return firstOf(bad, 12);
});

check("no shipped prose types a slash command the plugin does not declare", () => {
  // `/zz-core:update` and `/zz-core:doctor` were what `client_setup` told every new person to
  // type. Both commands are real and both belong to ZZ-ACCESS — its manifest declares them and
  // `checks/skill-homes.ts` has held that line for the skills behind them the whole time. The
  // prose was never checked against either. A person following the first instruction they are
  // ever given typed a command that does not exist and got nothing back, in the onboarding
  // text, which is the worst place in this repository to be wrong: it is read by the one
  // person who cannot tell whether the fault is theirs.
  //
  // IT SWEEPS SOURCE, NOT ONLY MARKDOWN, and that is the point rather than thoroughness. The
  // defect lived in `services/gateway/src/package/describe.ts` — a TypeScript file that BUILDS
  // the setup text at runtime, inside a template literal. A check reading `.md` alone would
  // have swept the whole tree, reported nothing, and left the one wrong sentence where it was.
  //
  // COMMENTS ARE EXCLUDED, and the exclusion is what makes the rest of it usable. Measured
  // before it was added: the only hits in the whole tree were three comments quoting a wrong
  // form in order to explain why it is wrong — two about the `-flow` derivation that makes
  // `/sdlc:flow` out of a flow called `sdlc-flow`, and this check's own paragraph above. A
  // rule that forbade those would delete the reason each one exists. `withoutComments` keeps
  // strings and template literals, which is precisely where prose destined for a person lives.
  //
  // THE PREFIX IS DERIVED THROUGH NAMING.pluginName, the same rule client-package.ts publishes
  // with, because the plugin a person types is not the flow's name: `sdlc-flow` ships as
  // `sdlc`. Re-deriving it here would make this check disagree with the thing it checks.
  //
  // THE PLUGIN MUST BE ONE OF OURS FOR THIS TO FIRE. An unfamiliar prefix is somebody else's
  // command or a path that happens to rhyme with one, and neither is this check's business —
  // so a new plugin never becomes a false finding.
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
  // A SWEEP THAT MATCHES NOTHING IS NOT A PASS. This repository types its own commands
  // constantly; finding zero citations would mean the pattern or the file set is wrong, and
  // "no bad ones" would be the most confident empty answer available.
  if (cited === 0) return "no slash command of ours was cited anywhere in the swept tree — the pattern is not matching";
  return firstOf(bad, 12);
});
