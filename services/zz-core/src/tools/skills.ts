/**
 * Who the caller is, and which skills they can reach.
 *
 * `session_whoami` answers the two facts every flow asks for before anything else — today's
 * date and the team this person acts for — and the rest of the door is the skill library:
 * what is installed, what a skill says, and what a connected block teaches about itself.
 *
 * A team's own overlay is resolved here rather than at each call, because a skill of one
 * name can exist in three places and only the order between them decides which answers.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { catalogEntries, catalogPackages } from "@zz/catalog";
import { parseCaller, parseEnvelope } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { safeName, safeRelPath, userRoot } from "../paths.js";
import { logActivity } from "../persist.js";
import { teamsFor } from "../platform-db.js";
import { allSkillRoots } from "../skill-roots.js";
import { isoToday } from "../write-guards.js";

export function registerSkillTools(server: McpServer): void {
  server.registerTool(
    "session_whoami",
    {
      // WHAT ONLY THIS TOOL ANSWERS. Three tools answer some form of "who am I" and they are
      // deliberately not merged — see the same note over `whoami` in the gateway's admin.ts,
      // which was sharpened first. Each names the other two, because a model choosing between
      // three overlapping identity tools picks by description and there is no other signal.
      //
      // This is the one an agent DOING WORK calls, and it is the only source of two things:
      // `today`, which no other tool anywhere returns, and `how_this_works`, the pointer to
      // the rules for a session that connected without a flow to tell it. Neither is a fact
      // about the caller's account, which is what the other two answer.
      //
      // "THE ONLY TOOL THAT ANSWERS EITHER" is what this said first, and it was false:
      // `team_mine` returns the acting team too. Overclaiming on the ONE tool whose job is to
      // be told apart from two others is the defect this task exists to fix, so the exclusive
      // claim is made where it is true — the date — and the team is described by WHO asks for
      // it here rather than by nobody else having it.
      description:
        "TODAY'S DATE — no other tool on any door returns it — and the team this session is " +
        "acting for, which every document you write and every search you run is scoped to. " +
        "The two facts to establish before anything else. Use `today` wherever a date is " +
        "needed; never work one out from the store or from a run tag. It also returns " +
        "how_this_works, the skill to read before your first write. For your platform role, " +
        "how this request authenticated, or why a tool is missing from your list, call " +
        "whoami on /manage; for every team you belong to and how to switch between them, " +
        "call team_mine.",
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
        // A flow's entry skill tells you to read zz-platform first. An agent that connected
        // this server WITHOUT a flow — a person wiring zz-core into Claude Code, an operator
        // on the admin door — is told by nothing at all, and then works out the gates, the
        // envelope and the store from error messages. The spine is one call away and its
        // name is not guessable, so the one tool every session already calls carries the
        // pointer.
        how_this_works: 'skill_read("zz-platform") — gates, the envelope, the artifact store, ' +
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

  /** THE SHELF: every skill this caller can reach, grouped by whatever owns it.
   *
   * ONE TOOL WHERE THERE WERE TWO, and the split was never a design. `list_skills` returned
   * `JSON.stringify([...names].sort())` — a flat array of strings with no owner, no
   * description and no order — and `block_skills` existed as a second tool only because
   * block-owned skills were the one case the first could not express. An agent asking "what
   * can I read, and what is each one for" had to call both, and after both still could not
   * tell which flow a stage skill belonged to or where in that flow it sat.
   *
   * Both costs block_skills was written to fix are still paid here, and both were measured on
   * this deployment.
   *
   * WHICH SKILLS DOES THIS BLOCK SHIP. ops-select told the agent to look for "usage guides in
   * the shared skills library named `<block>-usage`". A block ships its usage skills under the
   * names its own authors chose, which is rarely that one. So an agent following the
   * instruction guesses `<block>-usage`, finds nothing, and builds without them — and they
   * come out of evaluation BLIND, never opened by anybody. That reads as agents preferring to
   * improvise and it is nothing of the sort: it is a naming convention that was never true,
   * used as a lookup.
   *
   * WHICH BLOCKS ARE THERE AT ALL. The flat array carried no block attribution and no
   * descriptions, so "what could I build this on" was answered from a capability sheet
   * somebody maintains by hand.
   *
   * NOTHING HERE IS RETYPED FROM ANYWHERE. The block-to-skill mapping is zz.skill joined to
   * zz.block — the registry the indexer writes and the console reads. `when_to_use` comes out
   * of each skill's own SKILL.md. A stage's position comes out of its package's flow.json.
   * That is the only reason this can be trusted at a hundred blocks.
   *
   * OWNER IS A FILTER, NOT A DEPTH SWITCH, which is the one thing that is deliberately not
   * carried over. block_skills had two depths and its argument chose between them, so the
   * cheap call could not say what anything was for and the useful call had to be made once per
   * block. Every skill carries its when_to_use here whatever you asked for; `owner` narrows
   * WHICH skills, and an owner nothing answers to is refused with the list of owners that do —
   * an empty answer reads like a platform with no skills on it.
   *
   * PRECEDENCE IS THE ONE THING THIS MUST NOT RESTATE. A skill of one name can exist in three
   * places and allSkillRoots() decides which answers; this lists each name once, under the
   * root that wins, exactly as skill_read would resolve it. Listing a shadowed copy would
   * advertise text that skill_read can never return.
   */
  server.registerTool(
    "skill_list",
    {
      description:
        "Call this BEFORE guessing a skill name, and before deciding what to build on: it is " +
        "the whole shelf you can reach. Returns every skill grouped by the plugin or building " +
        "block that owns it — each with when to use it, its position in its flow where it has " +
        "one, and the supporting files beside it — plus every block this platform routes, " +
        "including the ones that publish no usage skill. Refuses an owner id that names no " +
        "plugin or block, listing the ones that exist; never invents a skill name and never " +
        "returns a skill's body — that is skill_read, one at a time.",
      inputSchema: {
        owner: z.string().optional().describe(
          "A plugin or block id exactly as this tool prints it, such as 'sdlc-flow' or " +
          "'casebox'. Omit for everything you can reach."),
      },
    },
    async ({ owner }) => {
      const { roots, degraded } = await allSkillRoots();

      // WHERE A ROOT CAME FROM, decided by matching it rather than by spelling a path. The
      // catalog's location is settable (`CATALOG_DIR`) and this file used to be one of the
      // places that hardcoded it; the team's own store is under an artifact root that varies
      // per caller. So both are matched against the values that produced them, `/blocks` is a
      // shape, and the platform's own `/skills` is what is left.
      const packageAt = new Map<string, { owner: string; name: string; dir: string }>();
      for (const p of catalogPackages()) packageAt.set(join(p.dir, "skills"), p);
      const stagesOf = new Map<string, Map<string, { at: number; of: number; produces: string }>>();
      const agentNameOf = new Map<string, string>();
      for (const e of catalogEntries()) {
        const declared = e.manifest.stages ?? [];
        const stages = new Map<string, { at: number; of: number; produces: string }>();
        declared.forEach((s, i) => stages.set(s.name, {
          at: i + 1, of: declared.length, produces: s.produces ?? "",
        }));
        stagesOf.set(e.dir, stages);
        if (e.manifest.agentName) agentNameOf.set(e.dir, e.manifest.agentName);
      }
      let teamRoot = "";
      let teamSlug: string | null = null;
      try {
        teamRoot = join(await userRoot(), "skills");
        teamSlug = (await teamsFor(parseCaller(requestHeaders()).email)).active;
      } catch { /* no store and no team yet: a person with nothing written has nothing to add */ }

      /** The reference material beside a SKILL.md — what `skill_read(name, file)` can open.
       *
       * Named here because nothing else names them. A skill says "see references/foo.md" in
       * its own prose or it does not, and where it does not, the file is unreachable in
       * practice: skill_read takes an exact relative path and there was no way to learn one. */
      const supporting = (dir: string): string[] => {
        const out: string[] = [];
        const walkFiles = (d: string, prefix: string): void => {
          let entries: string[];
          try { entries = readdirSync(d).sort(); } catch { return; }
          for (const e of entries) {
            const rel = prefix ? `${prefix}/${e}` : e;
            const p = join(d, e);
            if (statSync(p).isDirectory()) walkFiles(p, rel);
            else if (rel !== "SKILL.md") out.push(rel);
          }
        };
        walkFiles(dir, "");
        return out;
      };

      const unquote = (v: string): string => v.replace(/^["']|["']$/g, "").trim();
      /** One skill, from its own file. A description written here would be a second copy of
       * something the skill already says, and the second copy is the one that goes stale.
       *
       * `when_to_use` first, `description` only as a fallback: they answer different
       * questions — one says when to reach for this, the other says what it is — and an agent
       * choosing between forty skills needs the first. Every skill on this shelf carries both;
       * a block's skill written by its own team may carry neither, and that is said out loud
       * rather than rendered as an empty dash. */
      const describe = (
        name: string, dir: string | null,
        stage?: { at: number; of: number; produces: string },
      ): string[] => {
        const head = stage
          ? `- ${name} [stage ${stage.at} of ${stage.of}` +
            (stage.produces && stage.produces !== "nothing" ? ` → ${stage.produces}]` : "]")
          : `- ${name}`;
        // Registered and not on this caller's shelf. Said plainly rather than omitted: a
        // skill missing from the list reads as a block that does not ship one.
        if (!dir) return [head, "  (registered; its text is not installed for your team)"];
        // INDEXED, not read as a property, and not because the property read is wrong. A
        // SKILL.md's frontmatter is not a document envelope — `when_to_use` and `description`
        // are a skill's own fields and belong in no document's schema — but the gate's
        // "every envelope field the platform reads is one the schema publishes" cannot see
        // the difference and reads `env.when_to_use` as an undeclared document field.
        const md = readFileSync(join(dir, "SKILL.md"), "utf8");
        const front = (field: string): string => unquote(parseEnvelope(md)[field] ?? "");
        const when = front("when_to_use")
          || front("description").split(/(?<=\.)\s/)[0].trim()
          || "(its SKILL.md declares neither when_to_use nor description)";
        const out = [head, `  ${when}`];
        const files = supporting(dir);
        if (files.length) out.push(`  files: ${files.join(", ")}`);
        return out;
      };

      const groups: { id: string; label: string; lines: string[] }[] = [];
      const groupFor = (id: string, label: string): { id: string; label: string; lines: string[] } => {
        let g = groups.find((x) => x.id === id);
        if (!g) { g = { id, label, lines: [] }; groups.push(g); }
        return g;
      };

      // ── What is on disk for this caller, in precedence order ──────────────────────────
      const BLOCK_ROOT = /^\/blocks\/([^/]+)\/skills$/;
      const seen = new Set<string>();
      for (const root of roots) {
        if (BLOCK_ROOT.test(root)) continue;       // the registry answers for blocks, below
        if (!existsSync(root)) continue;
        const pkg = packageAt.get(root);
        const agent = pkg ? agentNameOf.get(pkg.dir) : undefined;
        const id = pkg ? pkg.name : root === teamRoot ? (teamSlug ?? "your-team") : "zz-core";
        const label = pkg
          ? `${pkg.name}${agent ? ` (${agent})` : ""} — a plugin, owned by ${pkg.owner}`
          : root === teamRoot
            ? `${teamSlug ?? "your-team"} — your team's own store`
            : "zz-core — the platform's own, readable by everybody";
        const stages = pkg ? stagesOf.get(pkg.dir) : undefined;
        const g = groupFor(id, label);
        for (const entry of readdirSync(root).sort()) {
          if (!existsSync(join(root, entry, "SKILL.md"))) continue;
          if (seen.has(entry)) continue;
          seen.add(entry);
          g.lines.push(...describe(entry, join(root, entry), stages?.get(entry)));
        }
      }

      // ── The answer ────────────────────────────────────────────────────────────────────
      if (owner !== undefined && !groups.some((g) => g.id === owner)) {
        return text(
          `ERROR: '${owner}' is not a plugin you can reach. The owners that ` +
          `are: ${groups.map((g) => g.id).join(", ") || "none — nothing is installed for you"}. ` +
          "Call this with no argument for all of them.");
      }
      const shown = owner === undefined ? groups : groups.filter((g) => g.id === owner);
      const lines: string[] = [];
      for (const g of shown) {
        lines.push(`# ${g.label}`);
        if (!g.lines.length) {
          lines.push(
            "Ships no usage skill. That is a gap in what the block team published, not a " +
            "reason to skip reading: read_api_spec and the block's own overview tool are what " +
            "is left, and say in the selection that this block documents itself only through " +
            "its API.");
        }
        lines.push(...g.lines);
        lines.push("");
      }
      // THE TOOL, NAMED, because a live run reached for the wrong one. An agent that had just
      // been handed these names called `bookit:usage_skill_view` with a casebox skill name in
      // it — a block's own reader knows only that block's skills, so it answered "no usage
      // skill", which reads as the skill not existing rather than as the wrong door. These sit
      // on the PLATFORM's shelf; the platform's reader is what opens them.
      lines.push(
        'Read any of these with skill_read("<name>"), and a supporting file with ' +
        'skill_read("<name>", file: "<path>") — this server\'s tools, by the exact names ' +
        "above. Never derive a skill name from a block name, and never a block's own " +
        'usage_skill_view: it knows only that block\'s skills and answers "no usage skill" ' +
        "for a name it does not own, which looks like the skill being missing when it is not.");

      // A SHORT LIST FOR A REASON, said out loud. Without the platform database there is no
      // way to know which flows this team installed, so this is the platform's own skills and
      // nothing else — which looks exactly like a team that has installed nothing.
      if (degraded) {
        return text(
          "ERROR: the platform database is unreachable, so which flows your team has installed " +
          "cannot be read. What follows is what is on disk for everybody, not your team's " +
          "shelf.\n\n" + lines.join("\n"));
      }
      return text(lines.join("\n"));
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
   * no overlay can shadow zz-platform or a stage of the flow — not by policy, but because
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
    "skill_read",
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
            { user: parseCaller(requestHeaders()).email, action: "skill_read", skill: name });
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
      return text(`ERROR: no skill named '${name}' is available to you — either it does not exist, or its flow is not installed for your team. Call skill_list to see what is.`);
    },
  );
}
