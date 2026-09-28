/**
 * Who the caller is, and which skills they can reach.
 *
 * `session_whoami` answers the two facts every flow asks for before anything else — today's
 * date and the team this person acts for — and the rest of the door is the skill library:
 * what is installed and what a skill says.
 *
 * Two places can carry a skill of one name, and the order between them is the whole rule: the
 * platform's own `/skills`, then the catalog's packages, platform-owned ones first. That order
 * is `skill-roots.ts`'s, and it is the only thing that decides which of two answers.
 *
 * DELIBERATE: there was a third — a team's own overlay under the team root, and a skills root
 * of the team's own beside it — and both are gone with the store. Something used to be layered
 * on top of the shelf's text here; now nothing is. A layer that silently stopped arriving is
 * exactly what a reader would not notice, so it is stated rather than left to the absence.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { catalogEntries, catalogPackages } from "@zz/catalog";
import { parseCaller, parseEnvelope } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { safeName, safeRelPath } from "../paths.js";
import { platformEvent } from "../indexing.js";
import { teamsFor } from "../platform-db.js";
import { allSkillRoots } from "../skill-roots.js";
import { isoToday } from "../write-guards.js";

export function registerSkillTools(server: McpServer): void {
  server.registerTool(
    "session_whoami",
    {
      // Three tools answer some form of "who am I" and they are deliberately not merged — see
      // the same note over `whoami` in the gateway's admin.ts. Each names the other two,
      // because a model choosing between three overlapping identity tools picks by description
      // and there is no other signal.
      //
      // This is the one an agent doing work calls, and the only source of `today`, which no
      // other tool anywhere returns, and of `how_this_works`. Neither is a fact about the
      // caller's account, which is what the other two answer. `team_mine` also returns the
      // acting team, so the exclusive claim is made only about the date.
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
        // Where the rules are, said to everybody, because nothing else says it. A flow's entry
        // skill tells you to read zz-platform first; an agent that connected this server
        // without a flow is told by nothing at all. The name is not guessable, so the one tool
        // every session already calls carries the pointer.
        how_this_works: 'skill_read("zz-platform") — gates, the envelope and the document store. ' +
                        "Read it before your first write.",
        // The clock, because the alternative is a guess. The model has no clock and every
        // harness hides it, so it pattern-matches its way to one — from the newest stored row
        // plus digits in a run tag. An initiative's folder name is chosen before any document
        // exists, so stampEnvelope cannot repair a wrong date afterwards.
        today,
        // Said out loud when it applies. The store is per team and no tool takes a team
        // argument, so a person in two teams works in one of them and cannot otherwise tell
        // which, or that the other exists.
        ...(others.length ? {
          other_teams: others,
          // A token is a person, and the acting team is switched on /manage, not by a second
          // token bound to that team.
          note: `your tools read and write ${active} only. To work in ${others.join(" or ")}, ` +
                "call team_switch on /manage. Your token is yours and works in all of them; " +
                "team_switch is what says which one you are acting for.",
        } : {}),
      }));
    },
  );

  /** The shelf: every skill this caller can reach, grouped by whatever owns it.
   *
   * One tool, not two. Every skill carries its `when_to_use` whatever you asked for, the plugin
   * that owns it, and its position in its flow.
   *
   * Nothing here is retyped from anywhere: `when_to_use` comes out of each skill's own SKILL.md,
   * and a stage's position out of its package's flow.json.
   *
   * DELIBERATE: `owner` is a filter, not a depth switch. It narrows which skills are listed and
   * never what is said about each. An owner nothing answers to is refused with the list of owners
   * that do — an empty answer reads like a platform with no skills on it.
   *
   * COUPLED: precedence is allSkillRoots()'s and must not be restated here. A skill of one name
   * can exist in three places; this lists each name once, under the root that wins, exactly as
   * skill_read would resolve it. Listing a shadowed copy advertises text skill_read can never
   * return.
   */
  server.registerTool(
    "skill_list",
    {
      description:
        "Call this BEFORE guessing a skill name, and before deciding what to build on: it is " +
        "the whole shelf you can reach. Returns every skill grouped by the plugin that owns " +
        "it — each with when to use it, its position in its flow where it has one, and the " +
        "supporting files beside it. Refuses an owner id that names no plugin, listing the " +
        "ones that exist; never invents a skill name and never returns a skill's body — that " +
        "is skill_read, one at a time.",
      inputSchema: {
        owner: z.string().optional().describe(
          "A plugin id exactly as this tool prints it, such as 'sdlc-flow'. Omit for " +
          "everything you can reach."),
      },
    },
    async ({ owner }) => {
      const roots = await allSkillRoots();

      // Where a root came from, decided by matching it rather than by spelling a path. The
      // catalog's location is settable (`CATALOG_DIR`), so a root is matched against the value
      // that produced it, and the platform's own `/skills` is what is left. There is no team
      // root any more: a team's own skills were store files, and the store is retired.
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
      /** The reference material beside a SKILL.md — what `skill_read(name, file)` can open.
       *
       * Named here because nothing else names them: skill_read takes an exact relative path, and
       * a file a skill's prose does not mention is unreachable in practice. */
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
       * something the skill already says.
       *
       * `when_to_use` first, `description` only as a fallback: one says when to reach for this,
       * the other says what it is, and an agent choosing between many skills needs the first. A
       * skill may carry neither, and that is said out loud rather than rendered as an
       * empty dash. */
      const describe = (
        name: string, dir: string | null,
        stage?: { at: number; of: number; produces: string },
      ): string[] => {
        const head = stage
          ? `- ${name} [stage ${stage.at} of ${stage.of}` +
            (stage.produces && stage.produces !== "nothing" ? ` → ${stage.produces}]` : "]")
          : `- ${name}`;
        // Registered and not on disk here. Said plainly rather than omitted: a skill missing
        // from the list reads as a package that does not ship one.
        if (!dir) return [head, "  (registered; its text is not on this deployment)"];
        // DELIBERATE: indexed, not read as a property. A SKILL.md's frontmatter is not a
        // document envelope, but the gate's "every envelope field the platform reads is one the
        // schema publishes" cannot see the difference and reads `env.when_to_use` as an
        // undeclared document field.
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

      // What is on disk for this caller, in precedence order.
      const seen = new Set<string>();
      for (const root of roots) {
        if (!existsSync(root)) continue;
        const pkg = packageAt.get(root);
        const agent = pkg ? agentNameOf.get(pkg.dir) : undefined;
        const id = pkg ? pkg.name : "zz-core";
        const label = pkg
          ? `${pkg.name}${agent ? ` (${agent})` : ""} — a plugin, owned by ${pkg.owner}`
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

      // The answer.
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
          lines.push("Ships no skill.");
        }
        lines.push(...g.lines);
        lines.push("");
      }
      lines.push(
        'Read any of these with skill_read("<name>"), and a supporting file with ' +
        'skill_read("<name>", file: "<path>") — this server\'s tools, by the exact names ' +
        "above.");

      return text(lines.join("\n"));
    },
  );

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
      const roots = await allSkillRoots();
      for (const root of roots) {
        const dir = join(root, name);
        const path = join(dir, "SKILL.md");
        if (existsSync(path)) {
          platformEvent({ actor: parseCaller(requestHeaders()).email, kind: "skill_read", skill: name });
          // DELIBERATE: nothing is layered on top. A team's own overlay was a file in the store
          // the platform kept for them — `<team root>/overlays/<name>/SKILL.md` — and the store
          // is retired, so the shelf's text IS the text. An overlay that silently stopped
          // arriving is exactly the failure this line would otherwise hide.
          if (file === undefined) return text(readFileSync(path, "utf8"));
          // Resolved inside the skill already found, never searched for on its own. Two
          // packages may ship a skill of one name — the roots are ordered so the first wins —
          // and an independent lookup could splice one package's reference onto another
          // package's skill.
          const sub = join(dir, file);
          if (!existsSync(sub) || !statSync(sub).isFile()) {
            return text(
              `ERROR: '${name}' ships no file at '${file}'. Its SKILL.md names the ` +
              "supporting files it has; read the skill first and follow what it points at.");
          }
          // Read straight out of the skill's own directory. Nothing is layered on a supporting
          // file, and never was: the team layer that used to exist was a team's addition to a
          // skill's instructions, and a reference document is not instructions.
          return text(readFileSync(sub, "utf8"));
        }
      }
      return text(`ERROR: no skill named '${name}'. Call skill_list to see what is.`);
    },
  );
}
