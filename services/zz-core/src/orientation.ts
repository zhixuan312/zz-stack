/**
 * What this door says about itself at `initialize`, before any tool is called.
 *
 * `instructions` is the MCP handshake's own field for it: the server hands a client one
 * paragraph, once, at connect time. It exists here for the client that reads NOTHING else —
 * somebody who wired zz-core into a terminal with no flow installed, and who otherwise
 * discovers the gates, the envelope and the store from error messages.
 *
 * IT IS AN ADDITION AND NEVER A REPLACEMENT. Claude Desktop is a binding target and parses
 * this field without ever showing it to the model, so a rule that lives ONLY here silently
 * does not apply there. Everything load-bearing is said twice: this text, and the
 * `how_this_works` pointer inside `session_whoami`'s payload, which arrives through a tool
 * result and therefore reaches every client. If you are tempted to delete the pointer
 * because "the instructions already say it" — that is the mistake this paragraph exists to
 * stop.
 *
 * TWO LENGTHS ARE REAL, and both are asserted by checks/orientation.ts. Claude Code
 * truncates the field at about 2KB, and Codex's guidance is that the first 512 characters
 * be self-contained — so the purpose and the pointer to the rules come first, and the
 * per-noun detail comes after, where losing it costs a reader nothing they cannot ask for.
 *
 * THE NOUNS LISTED BELOW ARE THE NOUNS THE DOOR SERVES. checks/orientation.ts derives the
 * prefix set from the tools actually registered and compares it against this text in both
 * directions, so a tool group that arrives or leaves makes this paragraph red rather than
 * quietly wrong. That is the same discipline server.ts applies to its own recorded surface:
 * this is not a description of the door, it IS the door describing itself.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** The paragraph a client is handed at `initialize`.
 *
 * `zz-platform` is named rather than described because a name is what `skill_read` takes.
 * It must stay the name of a skill that exists: if the skill is ever renamed, this text and
 * `session_whoami`'s `how_this_works` move together, and checks/orientation.ts fails unless
 * both point at a SKILL.md on disk.
 *
 * NOT EXPORTED, on purpose. Reading the constant is not reading the handshake — a client
 * receives this only if `coreServer` below actually hands it to the SDK, and the whole point
 * of that function is that the check opens a real client rather than importing the string.
 * Exporting it would offer the weaker read to the next person who needs one. */
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
 * A FUNCTION RATHER THAN AN OBJECT LITERAL IN server.ts, so that the thing a client receives
 * can be received. server.ts cannot be imported — it binds :8000 at module scope — so a
 * check that read the handshake would have had to grep the constructor's source instead, and
 * a grep for `instructions:` passes on a field that is declared and never delivered. This
 * runs the real SDK constructor, so checks/orientation.ts can hand it a real client and read
 * back exactly what the handshake carries. */
export function coreServer(version: string): McpServer {
  // SECOND ARGUMENT, not the first. `instructions` is `ServerOptions`, beside `capabilities`;
  // the first argument is `Implementation` and carries only name/version/title. Put it in the
  // first and TypeScript rejects it — put it in an object the SDK spreads and it would be
  // dropped in silence, which is the failure this whole file is about.
  return new McpServer({ name: "zz-core", version }, { instructions: CORE_INSTRUCTIONS });
}
