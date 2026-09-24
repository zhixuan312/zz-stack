/**
 * Turning the catalog's flows into the skills and commands a client will carry.
 *
 * The router skill is the largest piece and the one that matters most: it is what an agent
 * reads first, and it has to name every flow on the shelf without teaching the agent to
 * load anything it cannot reach. A skill promoted to a standalone command is the same text
 * under a name a person can type — one source, two projections, never two copies.
 */
import { catalogEntries, catalogEntry, catalogManifest, installableFlows, pluginName, skillText } from "@zz/catalog";
import { ENVELOPE_BLOCK, documentBody } from "@zz/contracts";

import { PLATFORM_VERSION, type ShelfFlow, type PackageFile } from "../client-package.js";

/** Every optional plugin on the shelf, from the catalog.
 *
 * One shelf for everyone: every catalog flow is offered to every person, because the platform
 * cannot see what anybody has installed on their own machine. */
export function shelfFlows(): ShelfFlow[] {
  return installableFlows()
    .map((qualified) => qualified.split("/")[1] ?? qualified)
    .map((flow) => {
      const m = catalogManifest(flow);
      if (!m) throw new Error(`catalog lists '${flow}' but has no manifest for it`);
      const entry = m.entry || flow;
      return {
        flow, version: PLATFORM_VERSION, entry, agentName: m.agentName ?? null,
        whenToUse: whenToUse(flow, entry), servers: m.servers ?? [],
      };
    })
    .sort((a, b) => a.flow.localeCompare(b.flow));
}

/** The entry skill's own `when_to_use`, so the router describes each flow in
 * the flow's words rather than ours. Falls back to `description`. */
export function whenToUse(flow: string, entry: string): string {
  const md = skillText(flow, entry);
  // Through fmField, so there is one frontmatter parser in this file.
  const v = md ? fmField(md, "when_to_use") || fmField(md, "description") : undefined;
  if (v) return v.length > 300 ? v.slice(0, 297) + "..." : v;
  return `work that belongs to the ${flow} flow`;
}
/** One field out of a skill's own frontmatter, from markdown already in hand.
 *
 * whenToUse above reads the same shape but goes to the catalog by (flow, entry); the command
 * builders already hold the file's text. */
export function fmField(md: string, key: string): string | undefined {
  // COUPLED: where a frontmatter block starts and ends is ENVELOPE_BLOCK's to say, shared with
  // the document envelope. A second spelling here parses a fence the gate does not.
  const fm = md.match(ENVELOPE_BLOCK);
  return fm?.[1].match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, "m"))?.[1]?.trim();
}
/** Platform plugins, read from the catalog rather than written here.
 *
 * A platform plugin is a capability every person gets, as opposed to a flow, which a team
 * installs. Their description and their skills are catalog content either way.
 *
 * DELIBERATE: `zz-core` is shelved and is excluded here by name. Its manifest is read for what
 * it declares — the commands map above all — but its files are synthesised, because the router
 * among them is generated at build time; returning it here too would emit the plugin twice. */
interface PlatformPlugin {
  name: string;
  /** The catalog directory, which is where its skills are. Separate from `name`: `name` is
   * what the plugin is called on the shelf, this is where to read it from, and a manifest
   * whose `name` differs from its folder needs both. */
  dir: string;
  description: string;
  servers: { name: string; path: string }[];
}
/** The baseline plugin's name, which is also its catalog directory and its MCP server's name.
 *
 * Named once because three questions turn on it: which catalog entry is the baseline's own
 * manifest, which plugin the packager synthesises, and which skills tree that plugin ships.
 * A plugin's name is its server's name. */
export const BASELINE = "zz-core";

export function platformPlugins(): PlatformPlugin[] {
  return catalogEntries()
    .filter((e) => e.manifest.shelved === true && e.flow !== BASELINE)
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
 * Not `when_to_use`, which is written for a model deciding whether to load a skill and reads
 * as trigger phrases. Trimmed at a sentence boundary rather than a character count. */
export function cardDescription(flow: string, fallback: string): string {
  return trimTo(catalogEntry(flow, true)?.manifest.description?.trim() || fallback, 180);
}
/** Trim prose to a length a card can hold, at a boundary a reader recognises.
 *
 * A sentence if one ends late enough to be worth keeping, else a word with an ellipsis. The
 * threshold is a third of the budget: below that the sentence says less than the truncation
 * would. COUPLED: every shelf card trims through here, so none cuts mid-word. */
function trimTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return stop > max / 3 ? cut.slice(0, stop + 1) : cut.slice(0, cut.lastIndexOf(" ")) + "…";
}
/** The commands a package declares: the name a person types, mapped to the skill that
 * carries the method.
 *
 * Read from the manifest rather than ShelfFlow because it is a property of the package as
 * authored, not of how a team installed it. */
function declaredCommands(flow: string): Record<string, string> {
  const v = catalogEntry(flow, true)?.manifest.commands;
  return v && typeof v === "object" ? v : {};
}
/** What a package's entry skill is typed as, or undefined when it declares no command for it.
 *
 * `entry` is which skill is the front door, which is what zz-router needs; this is the string
 * a person types to reach it, and it exists only if the manifest says so. The absence is the
 * answer: that package ships the method as a skill to be loaded rather than typed. */
export function entryCommand(flow: string, entry: string): string | undefined {
  return Object.entries(declaredCommands(flow)).find(([, skill]) => skill === entry)?.[0];
}
/** The only skill we ship. Everything it names is fetched at run time.
 *
 * Its description is what makes the client load it, so it has to match delivery work and
 * nothing else: too broad and it fires on ordinary coding, too narrow and it never loads.
 */
export function routerSkill(flows: ShelfFlow[]): string {
  const names = flows.map((f) => f.flow).join(", ") || "none yet";
  const fm = [
    "---",
    "name: zz-router",
    `description: ${JSON.stringify(
      "Use FIRST when the request is delivery work for your team on the ZZ platform " +
      "— a new capability, a change to a service someone operates, or continuing work already " +
      `under way. Picks the right installed flow (${names}) and loads it. Not for ordinary ` +
      "coding, debugging or questions about this repository.")}`,
    // The router's own version is the platform's: its text is generated from this person's
    // installed flows by this build of the gateway.
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
      "The shelf has no flow yet. Say so, and do not improvise a method.",
      "",
    );
  } else {
    for (const f of flows) {
      body.push(
        `### ${f.flow}${f.version ? ` (v${f.version})` : ""}`,
        "",
        `**When:** ${f.whenToUse}`,
        "",
          // The argument is named and the server said out loud, because a client with a Skill
          // mechanism of its own otherwise routes `skill_read(...)` to that instead and drops
          // the argument.
          "**Then:** call the `zz-core` tool **skill_read**, passing `zz-platform` as its",
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
    "- Documents are written through `document_write` / `document_patch` / `document_revise`",
    "  into your team's store — never into this repository. You send the BODY;",
    "  the platform writes the frontmatter, and content that opens with one is refused.",
    "- A gate passes only once `document_approve(path)` has recorded it. A \"yes\" in the",
    "  conversation is not an approval, and you cannot write one by hand — the",
    "  platform stamps who approved and when, and refuses the fields if you try.",
    "- An approved document changes through `document_revise`, never by writing over it.",
    "- Tokens belong to the **ZZ Access** agent. Never ask anyone to paste one here.",
    "",
    "Outside a flow you are yourself. This skill is not a personality.",
    "",
  );

  return fm.join("\n") + body.join("\n");
}
/** The flow's front door.
 *
 * DELIBERATE: a pointer command is about five lines. If it grows, method has leaked into the
 * package.
 *
 * Two forms, because a flow reaches its user differently depending on where its
 * method lives:
 *
 *   pointer flow — the method is on the platform, so the command fetches it.
 *   local flow   — the method shipped as files, so the command is the method.
 *
 * `entryBody` is the entry skill's markdown with its own frontmatter removed. When
 * it is present the command carries it verbatim, and the caller ships no separate
 * skill for the entry: on Claude Code a flow's front door is a command, and having
 * both means the same router arrives twice under two names. */
export function commandFile(f: ShelfFlow, cmd: string, entryBody?: string): string {
  const plugin = pluginName(f.flow);
  const head = [
    "---",
    // Quoted, like the two fields under it: `cmd` is a key a flow author typed into flow.json,
    // and the schema requires only a non-empty string. A value with a quote in it would close
    // a hand-quoted YAML string early and the command would silently not exist.
    `name: ${JSON.stringify(cmd)}`,
    // Quoted for the same reason: `agentName` is free text from a manifest.
    `description: ${JSON.stringify(`Run the ${f.agentName || f.flow} flow for your team.`)}`,
    // The plugin is named for the flow, so the command is /<flow>:<flow>.
    `when_to_use: ${JSON.stringify(`The person typed /${plugin}:${cmd}. This is a command, not an auto-matched skill.`)}`,
    // Omitted when the install recorded no version, rather than filled in with "1.0.0": an
    // invented number tells a client a release that never happened and never moves after.
    ...(f.version ? [`version: ${JSON.stringify(f.version)}`] : []),
    "disable-model-invocation: true",
    "---",
    "",
  ];
  if (entryBody) return head.concat(entryBody.trimEnd(), "").join("\n");
  return head.concat([
    "Call the `zz-core` tool **skill_read**, passing `zz-platform` as its `name` argument;",
    `then call it again passing \`${f.entry}\`, and follow it exactly. Both are MCP tools on`,
    "the zz-core server, not this client's own skills.",
    "",
    "If the person named work that already exists, call `initiative_status(<initiative>)`",
    "first and say what you found before acting on it.",
    "",
  ]).join("\n");
}
/** Promote the skills a manifest declares as commands, and say which files moved.
 *
 * A command is one a person types on purpose, which is a property of the skill rather than of
 * the kind of plugin carrying it, so both branches promote through here.
 *
 * `except` is the entry skill on the flow branch, promoted there because it needs the
 * ShelfFlow to build a pointer command when the skill did not ship. Excluded by skill name
 * rather than by command name, because the entry's command is whatever the manifest called
 * it. */
export function promoteCommands(flow: string, skills: PackageFile[], except: string[] = []):
    { commands: PackageFile[]; promoted: Set<PackageFile> } {
  const picked = Object.entries(declaredCommands(flow))
    .filter(([, skill]) => !except.includes(skill))
    .map(([cmd, skill]) => ({
      cmd, name: skill, file: skills.find((sk) => sk.path === `skills/${skill}/SKILL.md`),
    }))
    .filter((x): x is { cmd: string; name: string; file: PackageFile } => x.file !== undefined);
  return {
    commands: picked.map((x) => ({
      path: `commands/${x.cmd}.md`,
      content: standaloneCommandFile(flow, x.cmd, x.name, x.file.content),
    })),
    promoted: new Set(picked.map((x) => x.file)),
  };
}
/** A standalone skill, as a Claude Code command.
 *
 * Same rule as the flow's front door: a skill a person invokes on purpose becomes a command
 * such as `/sdlc:deck`. The body is the skill's own text, so there is one method however it is
 * reached. */
function standaloneCommandFile(flow: string, cmd: string, name: string, md: string): string {
  const plugin = pluginName(flow);
  const body = withoutFrontmatter(md);
  // The skill's own description: it is what a person reads in the command list to decide
  // whether this is the thing they want.
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
/** Reads the token at connect time so it never enters a file the person might
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

/** The baseline plugin's hook: every skill a Claude Code session loads from this shelf is
 *  reported to the platform as a `skill_read`, which is what attributes a step.
 *
 *  A flow's method asks a worker to load its stage with `skill_read`, but a Claude Code session
 *  loads a plugin's skills locally, through its own Skill tool, and the platform never sees it:
 *  across every sdlc initiative measured, ten of fourteen execute and review stages left no trace.
 *  The hook makes the record independent of whether the agent remembered. It runs after the
 *  tool, never blocks it, and prints nothing. */
export const SKILL_REPORT_HOOKS = JSON.stringify({
  hooks: {
    PostToolUse: [{
      matcher: "Skill",
      hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}"/scripts/zz-skill-report.mjs', timeout: 10 }],
    }],
  },
}, null, 2) + "\n";

/** The script the hook runs. `coreUrl` is the core door; `plugins` are the shelf's plugin names,
 *  so a skill from any other marketplace is never reported and never refused. */
export function skillReportScript(coreUrl: string, plugins: string[]): string {
  return [
    "#!/usr/bin/env node",
    "// Reports a skill this session loaded from the ZZ shelf to the platform, as skill_read.",
    "// Run by a PostToolUse hook on the Skill tool. Always exits 0 and prints nothing. The",
    "// credential comes from zz-mcp-headers.sh beside this file — the same resolution the MCP",
    "// connection uses, so there is one place a token is found.",
    'import { execFileSync } from "node:child_process";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    `const CORE = ${JSON.stringify(coreUrl)};`,
    `const SHELF = new Set(${JSON.stringify(plugins)});`,
    "",
    "function headers() {",
    '  try {',
    '    const out = execFileSync(join(dirname(fileURLToPath(import.meta.url)), "zz-mcp-headers.sh"),',
    '                             { encoding: "utf8", timeout: 3000 });',
    '    return JSON.parse(out);',
    '  } catch { return {}; }',
    "}",
    "",
    'let raw = "";',
    'process.stdin.on("data", (d) => { raw += d; }).on("end", async () => {',
    "  try {",
    '    const input = JSON.parse(raw || "{}").tool_input || {};',
    '    const named = String(input.skill || input.name || input.command || "").replace(/^\\//, "").trim();',
    '    const [plugin, name] = named.includes(":") ? named.split(":", 2) : ["", named];',
    "    if (!name || !SHELF.has(plugin)) return;",
    "    const h = headers();",
    "    if (!h.Authorization) return;",
    "    await fetch(CORE, {",
    '      method: "POST",',
    '      headers: { "content-type": "application/json", accept: "application/json, text/event-stream",',
    '                 authorization: h.Authorization, "x-zz-client": "zz-hook" },',
    '      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",',
    '                             params: { name: "skill_read", arguments: { name } } }),',
    "      signal: AbortSignal.timeout(8000),",
    "    }).then((r) => r.text()).catch(() => {});",
    "  } catch { /* a report that cannot be made is not the session's problem */ }",
    "});",
    "",
  ].join("\n");
}
