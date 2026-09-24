/**
 * What this door says about itself at `initialize`, before any tool is called.
 *
 * `instructions` is the MCP handshake's own field for it: the server hands a client one
 * paragraph, once, at connect time. It exists here for the client that reads nothing else and
 * otherwise discovers the gates, the envelope and the store from error messages.
 *
 * COUPLED: it is an addition and never a replacement. Claude Desktop parses this field without
 * ever showing it to the model, so a rule that lives only here does not apply there. Everything
 * load-bearing is said twice: this text, and the `how_this_works` pointer inside
 * `session_whoami`'s payload, which arrives through a tool result and reaches every client.
 *
 * Two lengths are real, and both are asserted by checks/orientation.ts: Claude Code truncates
 * the field at about 2KB, and Codex's guidance is that the first 512 characters be
 * self-contained — so the purpose and the pointer to the rules come first, and the per-noun
 * detail after.
 *
 * COUPLED: checks/orientation.ts derives the noun prefixes from the tools actually registered
 * and compares them against this text in both directions, so a tool group that arrives or
 * leaves makes this paragraph red.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** The paragraph a client is handed at `initialize`.
 *
 * `zz-platform` is named rather than described because a name is what `skill_read` takes, and
 * it must stay the name of a skill that exists. COUPLED: this text and `session_whoami`'s
 * `how_this_works` move together, and checks/orientation.ts fails unless both point at a
 * SKILL.md on disk.
 *
 * DELIBERATE: not exported. Reading the constant is not reading the handshake — a client
 * receives this only if `coreServer` below hands it to the SDK, and the check opens a real
 * client rather than importing the string. */
const CORE_INSTRUCTIONS =
  "zz-core is one team's record of what it decided and why. Documents pass through a gate " +
  "before anything downstream of them may be written, and what an initiative settled " +
  "outlives it in a knowledge store the next one reads.\n\n" +
  "START HERE: call session_whoami — it answers today's date and which team you are acting " +
  'for — then skill_read("zz-platform") before your first write. The platform skill carries the ' +
  "gates, the frontmatter every document needs, and how the store is laid out. Guessing " +
  "those costs a rewrite; reading them costs one call.\n\n" +
  "The nouns, one line each:\n" +
  "  bug_*         report something broken, read what is open, close one with what was decided\n" +
  "  document_*    write, revise, read, present and approve a flow's documents\n" +
  "  initiative_*  open a piece of work, ask where it stands, close it with an outcome\n" +
  "  knowledge_*   search what earlier initiatives settled, and add to it — search first\n" +
  "  session_*     who you are, which team you act for, and today's date\n" +
  "  skill_*       which skills are installed, who owns each, and what each one is for\n" +
  "  source_*      register the material a document cites, so a reader can follow it\n\n" +
  "NOT FOR: source code, builds, tickets, or files of any other kind. This door holds a " +
  "team's documents and its knowledge store and nothing else, and it has no clock but " +
  "`today`.";

/** The core door, constructed with what it says about itself.
 *
 * A function rather than an object literal in server.ts, so that the thing a client receives
 * can be received: server.ts cannot be imported — it binds :8000 at module scope — and a grep
 * for `instructions:` passes on a field that is declared and never delivered. This runs the
 * real SDK constructor, so checks/orientation.ts can hand it a real client and read back
 * exactly what the handshake carries. */
export function coreServer(version: string): McpServer {
  // Second argument, not the first. `instructions` is `ServerOptions`, beside `capabilities`;
  // the first argument is `Implementation` and carries only name/version/title. In an object
  // the SDK spreads it would be dropped in silence.
  return new McpServer({ name: "zz-core", version }, { instructions: CORE_INSTRUCTIONS });
}
