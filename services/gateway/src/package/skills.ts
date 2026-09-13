/**
 * Turning a team's installed flows into the skills and commands a client will carry.
 *
 * The router skill is the largest piece and the one that matters most: it is what an agent
 * reads first, and it has to name every flow the team runs without teaching the agent to
 * load anything it cannot reach. A skill promoted to a standalone command is the same text
 * under a name a person can type — one source, two projections, never two copies.
 */
import { catalogEntries, catalogEntry, skillText } from "@zz/catalog";
import { ENVELOPE_BLOCK, documentBody } from "@zz/contracts";

import { PLATFORM_VERSION, type InstalledFlow, type PackageFile } from "../client-package.js";

/** The entry skill's own `when_to_use`, so the router describes each flow in
 * the flow's words rather than ours. Falls back to `description`. */
export function whenToUse(flow: string, entry: string): string {
  const md = skillText(flow, entry);
  // Through fmField, which is the same read. This carried its own copy of that regex fifteen
  // lines above the function that is now the only one — two parsers for one frontmatter, in
  // one file, which is the shape this repository removes everywhere else it finds it.
  const v = md ? fmField(md, "when_to_use") || fmField(md, "description") : undefined;
  if (v) return v.length > 300 ? v.slice(0, 297) + "..." : v;
  return `work that belongs to the ${flow} flow`;
}
/** One field out of a skill's own frontmatter, from markdown already in hand.
 *
 * whenToUse above reads the same shape but goes to the catalog by (flow, entry). The command
 * builders already hold the file's text, and re-reading it from disk to get one line would
 * be a second way of answering the same question. */
export function fmField(md: string, key: string): string | undefined {
  // ENVELOPE_BLOCK, not a fourth spelling. A skill's frontmatter and a document's envelope are
  // different vocabularies inside the same syntax, and where that block STARTS and ENDS is one
  // fact — this copy required `---\n` exactly, so a fence written `--- ` parsed here and not
  // in the gate, or the other way about.
  const fm = md.match(ENVELOPE_BLOCK);
  return fm?.[1].match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, "m"))?.[1]?.trim();
}
/** Platform plugins, read from the catalog rather than written here.
 *
 * A platform plugin is a capability EVERY person gets, as opposed to a flow, which a team
 * installs. They differ in who receives them and in whether their entry becomes a typed
 * command — but their description and their skills are catalog content either way, and
 * keeping that prose in TypeScript meant the shelf said one thing and the catalog another.
 *
 * `zz` is deliberately not one of these: its only skill is GENERATED from the person's
 * installed flows, so there is nothing in the catalog to read. */
interface PlatformPlugin {
  name: string;
  /** The catalog DIRECTORY, which is where its skills are. Separate from `name` because
   * they answer different questions: `name` is what the plugin is called on the shelf, and
   * this is where to read it from. One value did both, so a manifest whose `name` differed
   * from its folder would have shipped a plugin with no skills in it and said nothing. */
  dir: string;
  description: string;
  servers: { name: string; path: string }[];
}
export function platformPlugins(): PlatformPlugin[] {
  return catalogEntries()
    .filter((e) => e.manifest.shelved === true)
    .map((e) => ({
      name: e.manifest.name ?? e.flow,
      dir: e.flow,
      description: e.manifest.description ?? e.flow,
      servers: e.manifest.servers ?? [],
    }))
    // Stable order so the shelf and its digest do not move with the filesystem.
    .sort((a, b) => a.name.localeCompare(b.name));
}
/** The flow's own one-line description, for the marketplace card.
 *
 * NOT `when_to_use`: that is written for a model deciding whether to load a skill, and it
 * reads as a list of trigger phrases. A person scanning six plugins wants to know what the
 * thing IS. flow.json's `description` is authored for exactly that and was going unused.
 *
 * Trimmed at a sentence boundary rather than a character count, because a card cut
 * mid-word — "...an initiative is at. This i" — reads as a bug in the shelf. */
export function cardDescription(flow: string, fallback: string): string {
  return trimTo(catalogEntry(flow, true)?.manifest.description?.trim() || fallback, 180);
}
/** Trim prose to a length a card can hold, at a boundary a reader recognises.
 *
 * A sentence if one ends late enough to be worth keeping, else a word with an ellipsis. The
 * threshold is a third of the budget: below that the sentence is so short it says less than
 * the truncation would.
 *
 * Its own function because there were two answers to one question. The Claude Code shelf
 * trimmed this way and Codex's `shortDescription` was `pl.description.slice(0, 100)` — a raw
 * cut that severed all five plugin cards mid-word ("...and where ea", "...Only insta"), in
 * the one field a person reads while choosing what to install. cardDescription's own comment
 * had already named that failure: a card cut mid-word "reads as a bug in the shelf". */
function trimTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return stop > max / 3 ? cut.slice(0, stop + 1) : cut.slice(0, cut.lastIndexOf(" ")) + "…";
}
/** Skills the flow declares as standing outside its sequence — deck, tldr and the like.
 *
 * Read from the manifest rather than InstalledFlow because it is a property of the flow
 * as authored, not of how a team installed it. NOT `tools`: that field already names the
 * flow's building blocks, and the installer grants MCP access from it. */
function standaloneSkills(flow: string): string[] {
  const v = catalogEntry(flow, true)?.manifest.standalone;
  return Array.isArray(v) ? v : [];
}
/** The ONLY skill we ship. Everything it names is fetched at run time.
 *
 * Its description is the entire door on Codex and Hermes, which have no
 * commands — so it has to match delivery work and nothing else. Too broad and
 * it fires on ordinary coding; too narrow and those two clients have no way in.
 */
export function routerSkill(flows: InstalledFlow[]): string {
  const names = flows.map((f) => f.flow).join(", ") || "none yet";
  const fm = [
    "---",
    "name: zz-router",
    `description: ${JSON.stringify(
      "Use FIRST when the request is delivery work for your team on the ZZ platform " +
      "— a new capability, a change to a service someone operates, or continuing work already " +
      `under way. Picks the right installed flow (${names}) and loads it. Not for ordinary ` +
      "coding, debugging or questions about this repository.")}`,
    // The router's own version is the PLATFORM's: its text is generated from this
    // person's installed flows by this build of the gateway, so "which version of the
    // router is this" and "which version of the platform generated it" are the same
    // question. A literal here answers neither, and never moves.
    `version: ${JSON.stringify(PLATFORM_VERSION)}`,
  ];
  fm.push("---");

  const body = [
    "",
    "# zz-router",
    "",
    "You are on the ZZ platform. Work here follows an installed flow: declared",
    "stages, documents and approval gates, with the record kept by the platform",
    "rather than by this conversation.",
    "",
    "## Before anything else",
    "",
    "If the person refers to work that already exists — by name, or with",
    '"continue", "where were we" — call `initiative_status(<initiative>)` first,',
    "or `initiative_status()` with no argument to list what is open. It computes",
    "the next move from the flow's manifest and the documents' own envelope.",
    "Never resume from your memory of a conversation.",
    "",
    "## Pick the flow",
    "",
  ];

  if (flows.length === 0) {
    body.push(
      "No flow is installed for your team yet. Say so, and point the person at the",
      "**ZZ Access** agent to find out who can install one. Do not improvise a method.",
      "",
    );
  } else {
    for (const f of flows) {
      body.push(
        `### ${f.flow}${f.version ? ` (v${f.version})` : ""}`,
        "",
        `**When:** ${f.whenToUse}`,
        "",
          // NAMED ARGUMENT, AND THE SERVER SAID OUT LOUD. This told the agent to "load
          // skill_view(...)", and on a client with a Skill mechanism of its own that is
          // ambiguous twice over. Measured on the first turn of a round: the agent called
          // the CLIENT's Skill tool with the platform's tool name ("Unknown skill:
          // zz:skill_view"), then called the right tool positionally with the argument
          // dropped ("Invalid arguments for tool skill_view: Required at name"). Four
          // wasted calls and four refusals before the flow had begun, every round, on that
          // client. Codex and Hermes have no Skill tool, which is why this stayed invisible
          // until there was a Claude Code harness to see it.
          "**Then:** call the `zz-core` tool **skill_view**, passing `zz-backbone` as its",
          `\`name\` argument; then call it again passing \`${f.entry}\`. Both are MCP tools`,
          "on the zz-core server, not this client's own skills. Follow those skills",
          "exactly — they are the method; this file is only the door.",
        "",
      );
    }
  }

  body.push(
    "## What holds regardless",
    "",
    "- Documents are written through `write_file` / `patch_file` / `revise_document`",
    "  into your team's store — never into this repository. You send the BODY;",
    "  the platform writes the frontmatter, and content that opens with one is refused.",
    "- A gate passes only once `approve(path)` has recorded it. A \"yes\" in the",
    "  conversation is not an approval, and you cannot write one by hand — the",
    "  platform stamps who approved and when, and refuses the fields if you try.",
    "- An approved document changes through `revise_document`, never by writing over it.",
    "- Keys for the building blocks and tokens belong to the **ZZ Access** agent.",
    "  Never ask anyone to paste a key here.",
    "",
    "Outside a flow you are yourself. This skill is not a personality.",
    "",
  );

  return fm.join("\n") + body.join("\n");
}
/** What a flow is called as a plugin, and what a skill is called as its command.
 *
 * A command is `/<plugin>:<file>`, so the two names are typed together every time. Taken
 * literally from the catalog they repeat themselves: the flow `sdlc-flow` and the skill
 * `sdlc-deck` gave `/sdlc-flow:sdlc-deck`, which says "sdlc" twice and "flow" once more than
 * anyone needs. The trailing `-flow` on the plugin and the leading `sdlc-` on the command are
 * both the same fact the namespace already carries.
 *
 * `/sdlc:deck`, `/sdlc:flow`, `/sm:flow`. A flow whose name does not end in `-flow` keeps it,
 * and an entry skill that would be left with nothing to say becomes `flow` — the front door
 * of every flow is called the same thing, which is what makes it guessable. */
export function pluginName(flow: string): string {
  return flow.endsWith("-flow") ? flow.slice(0, -"-flow".length) : flow;
}
export function commandName(plugin: string, skill: string): string {
  const short = skill.startsWith(`${plugin}-`) ? skill.slice(plugin.length + 1) : skill;
  return short === plugin || short === "" ? "flow" : short;
}
/** The flow's front door.
 *
 * A pointer command is deliberately about five lines. If it grows, method has leaked into
 * the package and the whole design has quietly stopped holding.
 *
 * Two forms, because a flow reaches its user differently depending on where its
 * method lives:
 *
 *   pointer flow — the method is on the platform, so the command fetches it.
 *   local flow   — the method shipped as files, so the command IS the method.
 *
 * `entryBody` is the entry skill's markdown with its own frontmatter removed. When
 * it is present the command carries it verbatim, and the caller ships no separate
 * skill for the entry: on Claude Code a flow's front door is a command, and having
 * both means the same router arrives twice under two names. Codex has no commands
 * and keeps the skill — same text, the door its runtime actually has. */
export function commandFile(f: InstalledFlow, entryBody?: string): string {
  const plugin = pluginName(f.flow);
  const cmd = commandName(plugin, f.entry || f.flow);
  const head = [
    "---",
    // QUOTED, like the two fields under it. `cmd` is derived from a catalog directory name,
    // and every one of them today is [a-z0-9-]+ — but that is a fact about the catalog, not a
    // property of this function, and the comment below records what happened the last time a
    // field here trusted its input: a value with a quote in it closed the string early and the
    // command silently did not exist. Quoting the generator's output is the fix that does not
    // depend on anybody validating the input.
    `name: ${JSON.stringify(cmd)}`,
    // QUOTED WITH JSON.stringify, like the standalone command forty lines down. `agentName`
    // is free text an admin types at install_flow — "what the team sees" — and it went into
    // a hand-quoted YAML string. An agent called `My "Special" Agent` closed the quote early
    // and produced frontmatter the client cannot parse, so the command silently does not
    // exist and nothing says why.
    `description: ${JSON.stringify(`Run the ${f.agentName || f.flow} flow for your team.`)}`,
    // The plugin is named for the flow, so the command is /<flow>:<flow>. This said /zz:
    // — the namespace from when every flow shipped inside one `zz` plugin — which sends
    // anyone who reads it looking for a command that does not exist.
    `when_to_use: ${JSON.stringify(`The person typed /${plugin}:${cmd}. This is a command, not an auto-matched skill.`)}`,
    // Omitted when the install recorded no version, rather than filled in with "1.0.0".
    // An invented number is the exact failure the version rules here exist to prevent: it
    // tells a client a release that never happened, and it never moves afterwards.
    ...(f.version ? [`version: ${JSON.stringify(f.version)}`] : []),
    "disable-model-invocation: true",
    "---",
    "",
  ];
  if (entryBody) return head.concat(entryBody.trimEnd(), "").join("\n");
  return head.concat([
    "Call the `zz-core` tool **skill_view**, passing `zz-backbone` as its `name` argument;",
    `then call it again passing \`${f.entry}\`, and follow it exactly. Both are MCP tools on`,
    "the zz-core server, not this client's own skills.",
    "",
    "If the person named work that already exists, call `initiative_status(<initiative>)`",
    "first and say what you found before acting on it.",
    "",
  ]).join("\n");
}
/** Promote the skills a manifest marks `standalone` into commands, and say which files moved.
 *
 * A standalone skill is one a PERSON types on purpose, and that is a property of the skill,
 * not of the kind of plugin carrying it. This was inline on the flow branch only, so the same
 * manifest field was honoured for a delivery flow and silently ignored for a platform one —
 * zz-knowledge could declare zz-okr standalone, the JSON would validate, the package would build,
 * and no command would exist. A field that means something in one branch and nothing in the
 * other is not one field.
 *
 * The entry skill's promotion stays on the flow branch: it needs the InstalledFlow to build a
 * pointer command, and a platform plugin has no front door of that kind. */
export function promoteStandalone(flow: string, skills: PackageFile[], useCommands: boolean):
    { commands: PackageFile[]; promoted: Set<PackageFile> } {
  if (!useCommands) return { commands: [], promoted: new Set() };
  const picked = standaloneSkills(flow)
    .map((n) => ({ name: n, file: skills.find((sk) => sk.path === `skills/${n}/SKILL.md`) }))
    .filter((x): x is { name: string; file: PackageFile } => x.file !== undefined);
  return {
    commands: picked.map((x) => ({
      path: `commands/${commandName(pluginName(flow), x.name)}.md`,
      content: standaloneCommandFile(flow, x.name, x.file.content),
    })),
    promoted: new Set(picked.map((x) => x.file)),
  };
}
/** The platform's own standalone skills, as commands.
 *
 * A flow says which of its skills a person types by listing them in its manifest's
 * `standalone`. The platform's own skills have no manifest — they are a tree beside the
 * catalog — so each one declares it in its OWN frontmatter with `standalone: true`, and the
 * baseline plugin promotes exactly those. A second list here would be a place for the answer
 * to drift away from the skill it is about.
 *
 * zz-backbone and zz-knowledge declare nothing and stay skills, which is right: they are
 * loaded by a method, not typed by a person. */
export function promotePlatformOwn(skills: PackageFile[]):
    { commands: PackageFile[]; promoted: Set<PackageFile> } {
  const picked = skills.filter((sk) =>
    /^skills\/[^/]+\/SKILL\.md$/.test(sk.path) && fmField(sk.content, "standalone") === "true");
  return {
    commands: picked.map((sk) => {
      const name = sk.path.split("/")[1];
      return {
        path: `commands/${commandName("zz", name)}.md`,
        content: standaloneCommandFile("zz", name, sk.content),
      };
    }),
    promoted: new Set(picked),
  };
}
/** A standalone skill, as a Claude Code command.
 *
 * Same rule as the flow's front door: Claude Code has commands and Codex does not, so a
 * skill a person invokes on purpose becomes `/sdlc:deck` there and stays a skill here. The
 * body is the skill's own text, so there is one method however it is reached. */
function standaloneCommandFile(flow: string, name: string, md: string): string {
  const plugin = pluginName(flow);
  const cmd = commandName(plugin, name);
  const body = withoutFrontmatter(md);
  // The skill's OWN description, not "Run the <name> skill." That sentence is what a person
  // reads in the command list to decide whether this is the thing they want, and it told
  // them only the name they had already typed. The skill states what it does in one line;
  // this is that line.
  const says = fmField(md, "description") || `Run the ${name} skill.`;
  return [
    "---",
    `name: ${JSON.stringify(cmd)}`,
    `description: ${JSON.stringify(says.length > 300 ? says.slice(0, 297) + "..." : says)}`,
    `when_to_use: ${JSON.stringify(`The person typed /${plugin}:${cmd}.`)}`,
    "disable-model-invocation: true",
    "---",
    "",
    body.trimEnd(),
    "",
  ].join("\n");
}
/** Markdown of a skill file with its YAML frontmatter stripped. */
export function withoutFrontmatter(md: string): string {
  return documentBody(md).replace(/^\n+/, "");
}
/** Reads the token at CONNECT time so it never enters a file the person might
 * commit. Rotating the token file is picked up on the next connection. */
export function headersHelper(): string {
  return [
    "#!/usr/bin/env bash",
    "# Supplies the ZZ platform bearer token to the client as MCP connection",
    "# headers. Read at connect time and never stored in the package, so the",
    "# token never lands in a file that gets committed.",
    "#",
    "# Resolution order:",
    "#   1. $ZZ_TOKEN        (env override)",
    "#   2. $ZZ_TOKEN_FILE   (explicit path)",
    "#   3. ~/.zz/token      (written by the install step, mode 600)",
    "set -uo pipefail",
    "",
    'if [ -n "${ZZ_TOKEN:-}" ]; then',
    '  token="$ZZ_TOKEN"',
    "else",
    '  token_file="${ZZ_TOKEN_FILE:-$HOME/.zz/token}"',
    '  if [ -r "$token_file" ]; then',
    `    token="$(tr -d '\\r\\n' < "$token_file")"`,
    "  else",
    "    # No token: emit no credential rather than failing the connection, so the",
    "    # person sees an auth error they can act on instead of a silent no-op.",
    `    printf '{"X-ZZ-Client":"zz-plugin"}\\n'`,
    "    exit 0",
    "  fi",
    "fi",
    "",
    `escaped=$(printf '%s' "$token" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')`,
    `printf '{"Authorization":"Bearer %s","X-ZZ-Client":"zz-plugin"}\\n' "$escaped"`,
    "",
  ].join("\n");
}
