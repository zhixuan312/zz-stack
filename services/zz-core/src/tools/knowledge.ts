/**
 * The two shelves: writing a node, superseding one, and searching both.
 *
 * `scope` has no default and every call sends it — `"platform"` for a fact about a registry
 * entry that holds for everybody, `"team"` for a fact about how this team works. Guessing it
 * from context is how a team's own circumstances end up on the shelf every team reads.
 *
 * A node IS a row: `zz.knowledge_node` carries its ordinal, slug, kind, lifecycle, title, body
 * and tags, and `zz.knowledge_node_evidence` records which initiatives it cites. The journal
 * files under `_knowledge/nodes/` are retired with the store, so both tools below write the row
 * through `indexNode`/`supersedeNode` — the package's one writer for that shape.
 *
 * A node that contradicts an existing one goes through `knowledge_supersede` rather than
 * beside it, and supersession refuses a pair that spans both shelves: the two are different
 * kinds of claim and one cannot retire the other.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { catalogEntries } from "@zz/catalog";
import { parseCaller } from "@zz/contracts";
import { indexNode, supersedeNode } from "@zz/indexing";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { journalLog, platformEvent } from "../indexing.js";
import { KNOWLEDGE_TEAM, PLAIN_TOKEN, tagRefusal, titleSlug } from "../paths.js";
import { db, subjectVersionFor, teamFor, teamsFor } from "../platform-db.js";

import { registerKnowledgeSearch } from "./knowledge-search.js";

/** The highest ordinal a shelf's rows say it has issued, or 0 — the high-water mark an id is
 *  allocated above. Read from the rows because they are the whole record: the journal's
 *  append-only `log.md` was the other half and it is retired with the store, so a number once
 *  issued is held by the row that carries it. */
async function issuedOrdinals(shelf: string | null): Promise<number> {
  const p = db();
  if (!p || !shelf) return 0;
  const { rows } = await p.query<{ n: number | null }>(
    `select max(k.node_ordinal::int) as n from zz.knowledge_node k
       join zz.team t on t.id = k.team_id
      where t.slug = $1`, [shelf]);
  const n = rows[0]?.n ?? 0;
  return Number.isFinite(n) ? Number(n) : 0;
}

/** A journal tag that names a registry entry, checked so the query stays answerable.
 *
 * "What have we learned about X" is answerable only if every node about X is findable by one
 * key, and free tags drift the moment two people write them — `casebox`, `plugin:casebox`,
 * `CaseBox`. Each variant removes nodes from the answer without removing them from the store.
 *
 * So a tag shaped `<kind>:<name>` must name a kind the platform has: the four classes of
 * pluggable thing plus the platform itself.
 *
 * `flow:` is checked against the catalog, which zz-core reads. The rest are not — zz-core
 * cannot see the plugin registry or the provider bindings, and a check that guessed would
 * refuse a true tag. Kind is verified, name is verified where it can be.
 *
 * Tags without a colon are ordinary free tags and are left alone. */
// `plugin`, not `block`: a plugin — skills plus the MCP servers those skills call — is the
// only installable thing on this platform, so it is what a knowledge node is about.
export const SUBJECT_KINDS = ["plugin", "flow", "provider", "interface", "platform"] as const;

function subjectTagError(tags: string[] | undefined): string | null {
  for (const raw of tags ?? []) {
    const t = raw.trim();
    const m = /^([a-z]+):(.+)$/.exec(t);
    if (!m) continue;
    const [, kind, name] = m;
    if (!(SUBJECT_KINDS as readonly string[]).includes(kind)) {
      return (
        `ERROR: tag \`${t}\` looks like it names a registry entry, but \`${kind}\` is not a kind ` +
        `this platform has. Use one of ${SUBJECT_KINDS.join(", ")} — or drop the colon if it ` +
        "was meant as an ordinary tag."
      );
    }
    if (kind === "flow") {
      // The same catalog reader everything else uses: a directory with no flow.json — zz-access
      // has none — is not a flow.
      const known = new Set(catalogEntries().map((e) => e.flow));
      if (known.size && !known.has(name)) {
        return (
          `ERROR: tag \`${t}\` names a flow this platform does not ship. Known: ` +
          `${[...known].sort().join(", ")}.`
        );
      }
    }
  }
  return null;
}

/** The initiatives a set of slugs names across the shelves this caller may already read, as
 *  `(slug, id)` pairs. One query, because the evidence existence check and the row's evidence
 *  relation ask the same question.
 *
 *  DELIBERATE: the shelves are the caller's own teams, plus the platform's — a platform-team
 *  member records a generalisable finding on the platform shelf with a tenant's initiative as
 *  evidence, and nobody may cite a shelf they cannot already read. */
async function initiativesNamed(
  p: pg.Pool, slugs: string[], shelves: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!slugs.length || !shelves.length) return out;
  const { rows } = await p.query<{ slug: string; id: string }>(
    `select i.slug, i.id::text as id from zz.initiative i
       join zz.team t on t.id = i.team_id
      where i.slug = any($1::text[]) and t.slug = any($2::text[])`,
    [slugs, shelves]);
  for (const r of rows) if (!out.has(r.slug)) out.set(r.slug, r.id);
  return out;
}

export function registerKnowledgeTools(server: McpServer): void {
  server.registerTool(
    "knowledge_add",
    {
      description:
        "Mint a knowledge-journal node in the team's journal: numbered, typed, evidence-linked. " +
        "type: decision|design|behavior|process|knowledge|style. evidence: initiative slug(s) the " +
        "lesson comes from — a node without evidence is an opinion and is refused. " +
        "WHEN THE LESSON IS ABOUT SOMETHING THE PLATFORM PLUGS IN rather than about your own " +
        "work, tag it with what it is about: `plugin:<name>`, `flow:sdlc-flow`, " +
        "`provider:forgejo`, `interface:claude-code`, `platform:guardrail`. That is what makes " +
        "'what have we learned about this block' a query instead of a search through " +
        "documents, and the kinds are checked so " +
        "one node cannot go missing behind a spelling.",
      inputSchema: {
        title: z.string(), type: z.enum(["decision", "design", "behavior", "process", "knowledge", "style"]),
        body: z.string(), evidence: z.array(z.string()).min(1),
        // DELIBERATE: no `.optional()` and no `.default()`. A default would make silence a
        // sayable answer, and the caller has to choose between the two shelves. The handler
        // below repeats the check, for callers that reach the tool past its schema.
        scope: z.enum(["team", "platform"]),
        tags: z.array(z.string()).optional(),
        // Which version of the plugin the claim was checked against, so "is this defect still
        // true" has a mechanical answer. Resolved automatically for a `plugin:<name>` tag;
        // passed explicitly when the claim was checked against something else.
        verified_against: z.string().optional(),
      },
    },
    async ({ title, type, body, evidence, tags, verified_against, scope }) => {
      const who = parseCaller(requestHeaders());
      // The schema above already refuses a call that omits `scope`; this repeats the check for
      // a caller that reaches the handler past the schema, so the refusal keeps its reasoning
      // instead of degrading to a generic type error.
      if (scope !== "team" && scope !== "platform") {
        return text(
          "ERROR: `scope` says which shelf this node belongs on and there is no default. " +
          "Send `scope: \"team\"` for a lesson about how THIS team works, or " +
          "`scope: \"platform\"` for a fact about a plugin, flow, provider or interface that " +
          "holds for everybody."
        );
      }
      const badTag = subjectTagError(tags);
      if (badTag) return text(badTag);

      // The shelves this caller may cite from: the one they act in, and every other team they
      // belong to, plus the platform's own.
      const { active: team, all: evidenceTeams } = await teamsFor(who.email);
      // A team-scoped node from a teamless caller would land on a shelf team-gated search
      // cannot reach. `scope: "platform"` is untouched — that shelf is not team-resolved, so a
      // teamless caller writes there regardless.
      if (scope === "team" && !team) {
        return text("ERROR: you are not in a team — the knowledge base is team-scoped");
      }

      // A consistency guard on top of the explicit `scope`, never a substitute: it does not
      // infer scope from tags, it refuses a `scope` the tags contradict. A `platform`-scoped
      // node needs a tag naming a registry entry; `scope: "team"` is left alone, because a team
      // lesson need not be about one.
      //
      // COUPLED: reuses SUBJECT_KINDS, so a kind added there is honoured here.
      if (scope === "platform") {
        const hasSubjectTag = (tags ?? []).some((raw) => {
          const m = /^([a-z]+):(.+)$/.exec(raw.trim());
          return m !== null && (SUBJECT_KINDS as readonly string[]).includes(m[1]);
        });
        if (!hasSubjectTag) {
          const carried = tags && tags.length ? tags.join(", ") : "no tags";
          return text(
            "ERROR: `scope: \"platform\"` needs a registry-entry tag — `plugin:`, `flow:`, " +
            "`provider:`, `interface:` or `platform:` — because platform knowledge is by " +
            `definition about one of them. This node carries \`${carried}\`. Tag what it is ` +
            "about, or send `scope: \"team\"`."
          );
        }
      }

      const p = db();
      if (!p) return text("ERROR: no platform database — there is nowhere to write this node.");

      // Every list value is written straight into the node's row, so the check is about the
      // token shape: evidence names an initiative, and a comma or a bracket in one would split
      // it into two entries nothing can resolve.
      //
      // The shelf comes from `scope` — a team-scoped lesson lands on the caller's own shelf, a
      // platform-scoped one on KNOWLEDGE_TEAM's.
      const shelf = scope === "platform" ? KNOWLEDGE_TEAM : team as string;
      const shelves = [...new Set([...evidenceTeams, KNOWLEDGE_TEAM, shelf])];
      const names = evidence.map((e) => e.trim());
      for (const e of names) {
        if (!PLAIN_TOKEN.test(e)) {
          return text(`ERROR: evidence entry "${e}" must be an initiative slug — ` +
                      "letters, digits, dot, dash or underscore, nothing else");
        }
      }
      // Existence, not shape: an evidence entry has to name an initiative that is really
      // there, or the node reads as checked while its link goes nowhere. The set is exactly the
      // shelves this caller may already read, so a member of one team still cannot cite
      // another's.
      const found = await initiativesNamed(p, names, shelves);
      const missing = names.filter((e) => !found.has(e));
      if (missing.length) {
        return text(`ERROR: evidence entry "${missing[0]}" is not an initiative in any shelf ` +
                    `you are a member of (${shelves.join(", ") || "none"}). document_list with ` +
                    "no argument shows what is in the one you are acting for. Evidence names " +
                    "where the lesson came from, and a node whose evidence points at nothing " +
                    "is the opinion this tool exists to refuse.");
      }
      const badTagShape = tagRefusal(tags);
      if (badTagShape) return text(badTagShape);

      const slug = titleSlug(title, type);
      // Resolved from the registry when the node is about a plugin and the caller did not say:
      // a claim with no version behind it cannot be retired when the plugin moves.
      //
      // COUPLED: `verified_against` and the version resolved for it are recorded on the ACT —
      // the `zz.event` row below — and not on the node. `zz.knowledge_node` has no column for
      // either, so a node carries them nowhere; the fact survives on the event that minted it.
      const version = await subjectVersionFor(tags);
      const pinned = (verified_against ?? "").trim() || version || "";
      // Allocate the ordinal and claim it in one step, retrying if somebody got there first:
      // the shelf is shared and reachable from every client at once, so two calls reading the
      // same maximum is ordinary. The row's own unique key is the arbiter — `indexNode` inserts
      // with `on conflict do nothing` and answers `taken` when the number was not free.
      const issued = await issuedOrdinals(shelf);
      for (let attempt = 0; attempt < 50; attempt++) {
        const ordinal = String(issued + 1 + attempt).padStart(4, "0");
        const written = await indexNode({
          team: shelf, ordinal, slug, kind: type, title, body, tags: tags ?? [], cited: names,
        });
        if ("taken" in written) continue;
        if ("refusal" in written) return text(written.refusal);
        journalLog(shelf, "create", ordinal, title);
        platformEvent({
          actor: who.email, kind: "knowledge.add", subject: ordinal, team: shelf,
          detail: { title, type, scope, verified_against: pinned || undefined },
        });
        return text(`journal node ${ordinal} created on ${shelf}'s shelf`);
      }
      return text("ERROR: could not allocate a journal node id after 50 attempts");
    },
  );

  server.registerTool(
    "knowledge_supersede",
    {
      description:
        "Mark a journal node superseded by a newer one — knowledge evolves, nothing is deleted. " +
        "WHEN a node is now wrong and a newer node states what is true: mint the newer one with " +
        "`knowledge_add` first, then call this with both four-digit ids as `knowledge_search` " +
        "reports them. The old node stays readable and searchable, labelled superseded and " +
        "pointing at its successor. Both nodes must be on one shelf; pass `shelf` only when an " +
        "id names a node on each. REFUSES an id no node carries, and a pair that spans the two " +
        "shelves.",
      // `{4,}`, not `{4}`: ids are padded to four digits and grow past it, and the allocator
      // counts without a ceiling.
      inputSchema: {
        old_id: z.string().regex(/^\d{4,}$/),
        new_id: z.string().regex(/^\d{4,}$/),
        // The way out of the ambiguity below. Ids are allocated per shelf and both shelves
        // start at 0001, so the same number naming two nodes is ordinary. Both ids are on this
        // shelf: a node is superseded by one beside it, which is enforced further down.
        shelf: z.enum(["team", "platform"]).optional()
          .describe("Which shelf both ids are on. Only needed when a bare id means a node on " +
                    "each shelf; the refusal says so when it does."),
      },
    },
    async ({ old_id, new_id, shelf }) => {
      const who = parseCaller(requestHeaders());
      const p = db();
      if (!p) return text("ERROR: no platform database — there is no node to supersede.");
      // Ids are allocated per shelf, so a bare id is ambiguous. Resolving hands back which
      // shelf a node was found on, not just which one it is, or a cross-shelf pair would
      // relabel whichever node was looked at first.
      const team = await teamFor(who.email);
      // DELIBERATE: `which` is the caller's WORD, and the shelf it names is a team SLUG. `resolve`
      // compares against `zz.team.slug`, so joining on the word `team` looks for a team literally
      // named that and finds nothing — a team-scoped node is minted on the caller's own slug, and
      // the platform shelf is `KNOWLEDGE_TEAM`. `knowledge_add` maps scope the same way, and both
      // halves of the pair have to: a node written to one shelf and looked for on another reads as
      // "no node 0001" for a node that exists.
      const shelfSlug = (which: "team" | "platform"): string =>
        which === "platform" ? KNOWLEDGE_TEAM : (team ?? "");
      const resolve = async (id: string, which: "team" | "platform") => {
        const slug = shelfSlug(which);
        if (!slug) return null;
        const row = (await p.query<{ id: string; slug: string }>(
          `select k.id::text as id, k.slug from zz.knowledge_node k
             join zz.team t on t.id = k.team_id
            where t.slug = $1 and k.node_ordinal = $2`, [slug, id])).rows[0];
        return row ? { shelf: which, id: row.id, slug: row.slug } : null;
      };
      // Ambiguous is refused, not guessed: an id present on both shelves is an error the
      // caller settles with `shelf`, and the refusal names which two nodes it could mean.
      // Resolving team-first and returning the first hit would relabel unrelated team nodes
      // for a caller superseding two platform ones.
      async function findId(id: string) {
        // The team shelf is looked up only when the caller resolves to one: a teamless caller
        // has no shelf there, and `team` is null rather than a personal name beside it.
        const onTeam = team ? await resolve(id, "team") : null;
        const onPlatform = await resolve(id, "platform");
        // An explicit shelf is a choice between the two, never a third answer: asking for a
        // shelf the id is not on is refused as "no node", not fallen back to the other.
        if (shelf) return (shelf === "team" ? onTeam : onPlatform);
        if (onTeam && onPlatform) return { ambiguous: true as const, id, onTeam, onPlatform };
        return onTeam ?? onPlatform;
      }
      const bothShelves = (id: string, a: string, b: string) =>
        `ERROR: node ${id} exists on BOTH shelves — \`${a}\` on your team's and \`${b}\` on ` +
        "the platform's. Ids are allocated per shelf, so a bare number means two different " +
        "nodes here. Pass `shelf: \"team\"` or `shelf: \"platform\"` to say which you mean — " +
        "both ids are read from that one shelf. A team lesson is replaced " +
        "by a team node, a platform fact by a platform node, and promoting a lesson means " +
        "writing a NEW platform node with the old one as evidence rather than relabelling " +
        "across shelves.";
      const oldFound = await findId(old_id);
      if (!oldFound) return text(`ERROR: no node ${old_id}`);
      if ("ambiguous" in oldFound) {
        return text(bothShelves(old_id, oldFound.onTeam.slug, oldFound.onPlatform.slug));
      }
      const oldNode = oldFound;
      // The replacement must exist, or recall surfaces "we moved past this — see 0099"
      // pointing at nothing.
      const newFound = await findId(new_id);
      if (!newFound) return text(`ERROR: no node ${new_id} — supersede with a node that exists`);
      if ("ambiguous" in newFound) {
        return text(bothShelves(new_id, newFound.onTeam.slug, newFound.onPlatform.slug));
      }
      const newNode = newFound;
      if (old_id === new_id) return text("ERROR: a node cannot supersede itself");
      // A node is superseded by one on the same shelf. Promoting a team lesson to the platform
      // is writing a new platform node with the old one as evidence, not relabelling it across
      // shelves.
      if (oldNode.shelf !== newNode.shelf) {
        return text(
          `ERROR: \`${old_id}\` is on the \`${oldNode.shelf}\` shelf and \`${new_id}\` is on ` +
          `the \`${newNode.shelf}\` shelf. A node is superseded by one on the same shelf; ` +
          "promoting a lesson means writing a new platform node, not superseding across shelves."
        );
      }
      await supersedeNode(oldNode.id, newNode.id);
      journalLog(oldNode.shelf, "supersede", old_id, `superseded by ${new_id}`);
      // The shelf is read from where the old node was found, not from the caller's team:
      // `findId` searches both, so a platform node superseded by somebody with a team of their
      // own still belongs to the platform shelf.
      platformEvent({
        actor: who.email, kind: "knowledge.supersede", subject: old_id,
        team: oldNode.shelf,
        detail: { supersededBy: new_id },
      });
      return text(`node ${old_id} superseded by ${new_id}`);
    },
  );

  // The read side is its own file: `knowledge_search` shares nothing with the two tools above
  // but the rows they write into. See knowledge-search.ts.
  registerKnowledgeSearch(server);
}
