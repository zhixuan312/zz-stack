/**
 * Who the caller is, and which skills they can reach.
 *
 * `get_my_info` answers the two facts every flow asks for before anything else — today's
 * date and the team this person acts for — and the rest of the door is the skill library:
 * what is installed, what a skill says, and what a connected block teaches about itself.
 *
 * A team's own overlay is resolved here rather than at each call, because a skill of one
 * name can exist in three places and only the order between them decides which answers.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller, parseEnvelope } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { safeName, safeRelPath, userRoot } from "../paths.js";
import { logActivity } from "../persist.js";
import { db, teamsFor } from "../platform-db.js";
import { allSkillRoots } from "../skill-roots.js";
import { isoToday } from "../write-guards.js";

export function registerSkillTools(server: McpServer): void {
  server.registerTool(
    "get_my_info",
    {
      description:
        "Who am I — the identity this session acts as, my team (artifacts " +
        "are shared with every member of my team), and TODAY'S DATE. Use `today` " +
        "wherever a date is needed; never work one out from the store.",
      inputSchema: {},
    },
    async () => {
      const who = parseCaller(requestHeaders());
      const { active, all } = await teamsFor(who.email);
      const others = all.filter((t) => t !== active);
      const today = isoToday();
      return text(JSON.stringify({
        ...who,
        team: active,
        // WHERE THE RULES ARE, said to everybody, because nothing else says it.
        //
        // A flow's entry skill tells you to read the backbone first. An agent that connected
        // this server WITHOUT a flow — a person wiring zz-core into Claude Code, an operator
        // on the admin door — is told by nothing at all, and then works out the gates, the
        // envelope and the store from error messages. The spine is one call away and its
        // name is not guessable, so the one tool every session already calls carries the
        // pointer.
        how_this_works: 'skill_view("zz-backbone") — gates, the envelope, the artifact store, ' +
                        "and when a building block is checked. Read it before your first write.",
        // The clock, because the alternative is a guess and the guess has been wrong.
        //
        // An agent naming an initiative reasoned: "latest stored activity is 27-08-2026 and
        // your tag names pilot-2808, so this is 28-08-2026-..." — and called that "today's
        // date from the system". It was inference from the newest row plus digits in a run
        // tag. The same reasoning produced 26-08-2026 on 2026-08-28 and named a directory
        // that no later stamp can repair: stampEnvelope can fix frontmatter, but a folder is
        // chosen before any document exists.
        //
        // The model has no clock. Every harness hides it, so it pattern-matches its way to
        // one. Handing it the date here is cheaper than any rule telling it not to guess.
        today,
        // Said out loud when it applies. The store is per team and no tool takes a team
        // argument, so a person in two teams works in one of them and could not previously
        // tell which, or that the other existed.
        ...(others.length ? {
          other_teams: others,
          // The advice here used to be "ask an admin for a token bound to that team". That
          // was true when the credential carried the team, and it is exactly what per-team
          // agents replaced: a token is a person now, and the team comes from the agent
          // they picked. Guidance that sends someone to an admin for a second token, when
          // the answer is a menu in front of them, costs more than saying nothing.
          note: `your tools read and write ${active} only. To work in ${others.join(" or ")}, ` +
                "switch to that team's agent — the same flow, manned for that team. Your " +
                "token is yours and works in all of them; the agent you pick is what says " +
                "which one you are acting for.",
        } : {}),
      }));
    },
  );

  // Encoding is arithmetic, not judgement — and a delivery agent has no
  // shell by design. Blocks whose APIs want encoded payloads (e.g. email
  // bodies) would otherwise stall the flow asking a stakeholder to paste
  // a base64 string. One deterministic tool, audited like any other.
  server.registerTool(
    "encode_base64",
    {
      description:
        "Base64-encode text (or decode it) for building-block APIs that require encoded " +
        "payloads, such as email bodies. Deterministic utility — never ask a person to " +
        "encode or decode by hand, and never guess an encoding yourself.",
      inputSchema: {
        text: z.string().describe("The exact text to encode (or the base64 to decode)."),
        direction: z.enum(["encode", "decode"]).optional().describe("Default: encode."),
      },
    },
    async ({ text: input, direction }) => {
      const mode = direction ?? "encode";
      try {
        if (mode === "encode") return text(Buffer.from(input, "utf8").toString("base64"));
        // DECODING IS CHECKED, because Buffer.from(x, "base64") never throws — it drops the
        // characters it does not recognise and returns whatever the rest happens to spell.
        // "not base64 at all!" comes back as eight bytes of mojibake, and the catch below
        // never fires. This tool's own description says never to guess an encoding, and
        // handing an agent plausible rubbish is the guess it warns about, made for it.
        //
        // Re-encoding is the whole test: the shape of valid base64 is that it survives a
        // round trip. Padding and any whitespace the caller wrapped it in are normalised
        // away first, because neither changes what the input means.
        const canonical = input.replace(/\s+/g, "").replace(/=+$/, "");
        const out = Buffer.from(input, "base64").toString("utf8");
        if (Buffer.from(out, "utf8").toString("base64").replace(/=+$/, "") !== canonical) {
          return text(
            "ERROR: that does not decode to text. Either it is not valid base64 — in which " +
            "case decoding it returns whatever the recognisable characters happen to spell — " +
            "or it encodes bytes that are not UTF-8, which this tool does not carry: it is " +
            "for text, such as an email body. Pass the exact string the block gave you, or " +
            'call this with direction: "encode" if you meant to encode.');
        }
        return text(out);
      } catch (err) {
        return text(`ERROR: could not ${mode}: ${String(err)}`);
      }
    },
  );

  /** THE SHELF: which building blocks exist, and which skills each one ships.
   *
   * Two questions an agent could not answer, and the cost of each is measured on this
   * deployment.
   *
   * WHICH SKILLS DOES THIS BLOCK SHIP. ops-select told the agent to look for "usage guides in
   * the shared skills library named `<block>-usage`". A block ships its usage skills under the
   * names its own authors chose, which is rarely that one. So an agent following the
   * instruction guesses `<block>-usage`, finds nothing, and builds without them — and they
   * come out of evaluation BLIND, never opened by anybody. That reads as agents preferring to improvise and it
   * is nothing of the sort: it is a naming convention that was never true, used as a lookup.
   *
   * WHICH BLOCKS ARE THERE AT ALL. `list_skills` returns a flat array of names with no block
   * attribution and no descriptions, so "what could I build this on" was answered from a
   * capability sheet somebody maintains by hand.
   *
   * BOTH HALVES COME FROM SOMETHING THAT CANNOT DRIFT. The block-to-skill mapping is
   * zz.skill joined to zz.block — the registry the indexer writes and the console reads, not
   * a list in a document. The description of each skill is read out of that skill's own
   * SKILL.md. Nothing here is retyped from anywhere, which is the only reason it can be
   * trusted at a hundred blocks.
   *
   * TWO DEPTHS, and the argument chooses. No argument is the shelf — every block, one line
   * each, cheap enough to call before you know what you want. A block name is that block's
   * skills with what each is for, which is what you read once you do. Neither returns a
   * skill's BODY: that is skill_view, one at a time, and keeping it that way is what stops
   * this becoming the thing it exists to avoid.
   */
  server.registerTool(
    "block_skills",
    {
      description:
        "Which building blocks this platform routes, and which usage skills each one ships. " +
        "Call it with no argument for the shelf: every block, its title, and how many skills " +
        "it ships. Call it with a block id for that block's skills and what each one is for. " +
        "READ THIS BEFORE GUESSING A SKILL NAME — a block's skills are named whatever its " +
        "team named them, and there is no convention to derive them from. Then skill_view " +
        "the ones you need, by the exact name this returns.",
      inputSchema: {
        block: z.string().optional().describe(
          "A block id as the gateway routes it, such as 'casebox'. Omit for every block."),
      },
    },
    async ({ block }) => {
      const p = db();
      if (!p) {
        return text(
          "ERROR: the platform database is unreachable, so which blocks exist and what they " +
          "ship cannot be read. This is not a statement about the blocks.");
      }
      const { rows } = await p.query<{ block: string; title: string; skill: string | null }>(
        `select b.name as block, b.title, s.name as skill
           from zz.block b
           left join zz.skill s on s.block_id = b.id and s.kind = 'block_usage' and not s.retired
          where b.origin <> 'platform' and ($1::text is null or b.name = $1)
          order by b.name, s.name`,
        [block ?? null],
      );
      if (!rows.length) {
        return text(block
          ? `ERROR: '${block}' is not a building block this platform routes. Call this with ` +
            "no argument to see the ones that are."
          : "No building block is registered on this deployment.");
      }
      // The skill's own first sentence, from its own file. A description written here would
      // be a second copy of something the skill already says, and the second copy is the one
      // that goes stale.
      const { roots } = await allSkillRoots();
      const describe = (name: string): string => {
        for (const root of roots) {
          const file = join(root, name, "SKILL.md");
          if (!existsSync(file)) continue;
          const said = parseEnvelope(readFileSync(file, "utf8")).description ?? "";
          return said.split(/(?<=\.)\s/)[0].trim();
        }
        // Registered and not on this caller's shelf. Said plainly rather than omitted: a
        // skill missing from the list reads as a block that does not ship one.
        return "(registered; its text is not installed for your team)";
      };
      const byBlock = new Map<string, { title: string; skills: string[] }>();
      for (const r of rows) {
        const e = byBlock.get(r.block) ?? { title: r.title, skills: [] };
        if (r.skill) e.skills.push(r.skill);
        byBlock.set(r.block, e);
      }
      const lines: string[] = [];
      for (const [name, e] of byBlock) {
        if (block) {
          lines.push(`# ${name}${e.title ? ` — ${e.title}` : ""}`);
          if (!e.skills.length) {
            lines.push(
              "Ships no usage skill. That is a gap in what the block team published, not a " +
              "reason to skip reading: read_api_spec and the block's own overview tool are " +
              "what is left, and say in the selection that this block documents itself " +
              "only through its API.");
          }
          for (const s of e.skills) lines.push(`- ${s} — ${describe(s)}`);
          if (e.skills.length) {
            lines.push("");
            // THE TOOL, NAMED, because a live run reached for the wrong one. An agent that had
            // just been handed these names called `bookit:usage_skill_view` with a casebox skill
            // name in it — a block's own reader knows only that block's skills, so it answered
            // "no usage skill", which reads as the skill not existing rather than as the wrong
            // door. These sit on the PLATFORM's shelf; the platform's reader is what opens them.
            lines.push('Read any of them with skill_view("<name>") — this server\'s tool. A ' +
              "block's own usage_skill_view knows only that block's skills and answers " +
              '"no usage skill" for a name it does not own, which looks like the skill being ' +
              "missing when it is not.");
          }
        } else {
          lines.push(`- ${name}${e.title ? ` (${e.title})` : ""} — ` +
            (e.skills.length
              ? `${e.skills.length} usage skill${e.skills.length === 1 ? "" : "s"}: ${e.skills.join(", ")}`
              : "no usage skill published"));
        }
      }
      if (!block) {
        lines.push("");
        lines.push(
          "Call block_skills(block: \"<id>\") for what each skill is for, then read them with " +
          "skill_view(\"<skill name>\") — the PLATFORM's tool, on this server, never a block's " +
          "own usage_skill_view. Do not derive a skill name from a block name; these are the " +
          "names.");
      }
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "list_skills",
    {
      description: "List the skills your team can reach: the platform's own, every skill of every flow installed for your team, and your team's own skills.",
      inputSchema: {},
    },
    async () => {
      const { roots, degraded } = await allSkillRoots();
      const names = new Set<string>();
      for (const root of roots) {
        if (!existsSync(root)) continue;
        for (const entry of readdirSync(root)) {
          if (existsSync(join(root, entry, "SKILL.md"))) names.add(entry);
        }
      }
      // A SHORT LIST FOR A REASON, said out loud. Without the platform database there is no
      // way to know which flows this team installed, so this is the platform's own skills and
      // nothing else — which looks exactly like a team that has installed nothing.
      if (degraded) {
        return text(
          `ERROR: the platform database is unreachable, so which flows your team has installed ` +
          `cannot be read. These are the platform's own skills only, not your flow's: ` +
          `${JSON.stringify([...names].sort())}`);
      }
      return text(JSON.stringify([...names].sort()));
    },
  );

  /** A team's own additions to a stage of the flow they run, appended to it.
   *
   * A team running ops-flow may want two more considerations at ops-select — the vendors they
   * are not allowed to use, the question their director always asks. That is not a different
   * ops-select and they should not have to fork one to say it.
   *
   * APPENDED, never substituted, and the difference is the whole design. A replacement can
   * quietly delete a rule the platform depends on; an addition cannot. So the shelf's text
   * arrives first and entire, the team's follows under a heading that says whose it is, and
   * no overlay can shadow zz-backbone or a stage of the flow — not by policy, but because
   * substitution is not a thing this can express.
   *
   * Structure stays the platform's. flow.json — documents, gate, requires, closing,
   * sections — is untouched by any of this: an overlay changes HOW a step is done, never
   * WHICH steps exist or which of them a person must sign. A team whose overlay talks an
   * agent into writing different headings meets sectionCheck at the write, which is where
   * that boundary is actually held rather than merely asked for.
   *
   * Lives in the team's own store, so it costs no approval from us. */
  async function teamOverlay(name: string): Promise<string> {
    try {
      const f = join(await userRoot(), "overlays", name, "SKILL.md");
      if (!existsSync(f)) return "";
      const body = readFileSync(f, "utf8").trim();
      if (!body) return "";
      return `\n\n---\n\n## Your team's additions to ${name}\n\n` +
        "*From your team's own store, layered on top of the skill above. It adds to that " +
        "method and never replaces it — where the two differ on a rule the platform sets, " +
        "the skill above wins.*\n\n" + body + "\n";
    } catch {
      return "";   // no store yet: an overlay is an addition, and its absence is normal
    }
  }

  server.registerTool(
    "skill_view",
    {
      description:
        "Read a skill's full instructions (e.g. 'sdlc-spec'). Load a skill before " +
        "following it. Scoped to your team: a flow your team has not installed is " +
        "not readable here. " +
        "A skill may ship supporting files beside its SKILL.md — reference material " +
        "too long to carry in every load; SKILL.md names them where they apply. Pass " +
        "`file` to read one, e.g. file: 'references/verified-traps.md'. Relative to the " +
        "skill's own directory: no leading slash, and no '..'.",
      inputSchema: {
        name: z.string(),
        file: z.string().optional()
          .describe("A supporting file beside the skill's SKILL.md, e.g. 'references/verified-traps.md'. Omit for the skill itself."),
      },
    },
    async ({ name, file }) => {
      const badName = safeName(name, "skill name");
      if (badName) return text(badName);
      const badFile = file === undefined ? null : safeRelPath(file, "file");
      if (badFile) return text(badFile);
      const { roots, degraded } = await allSkillRoots();
      for (const root of roots) {
        const dir = join(root, name);
        const path = join(dir, "SKILL.md");
        if (existsSync(path)) {
          logActivity(await userRoot(), null,
            { user: parseCaller(requestHeaders()).email, action: "skill_view", skill: name });
          if (file === undefined) return text(readFileSync(path, "utf8") + await teamOverlay(name));
          // RESOLVED INSIDE THE SKILL WE ALREADY FOUND, never searched for on its own.
          // Two packages may ship a skill of one name — the roots are ordered precisely
          // so the first wins — and looking the file up across roots independently could
          // splice one package's reference onto another package's skill.
          const sub = join(dir, file);
          if (!existsSync(sub) || !statSync(sub).isFile()) {
            return text(
              `ERROR: '${name}' ships no file at '${file}'. Its SKILL.md names the ` +
              "supporting files it has; read the skill first and follow what it points at.");
          }
          // NO TEAM OVERLAY on a supporting file. An overlay is a team's addition to a
          // skill's INSTRUCTIONS; appending it to a table of API traps would put a
          // sentence about how one team works at the bottom of a reference document.
          return text(readFileSync(sub, "utf8"));
        }
      }
      // WHICH of the two, when the platform can tell. During a database outage the flow list
      // cannot be read at all, and answering "its flow is not installed for your team" sends
      // the reader to an admin to install a flow they already have.
      if (degraded) {
        return text(
          `ERROR: the platform database is unreachable, so whether '${name}' belongs to a flow ` +
          "your team has installed cannot be read. This is not a statement about the skill. " +
          "Try again once the platform is back.");
      }
      return text(`ERROR: no skill named '${name}' is available to you — either it does not exist, or its flow is not installed for your team. Call list_skills to see what is.`);
    },
  );
}
