/**
 * The two shelves: writing a node, superseding one, and searching both.
 *
 * `scope` has no default and every call sends it — `"platform"` for a fact about a registry
 * entry that holds for everybody, `"team"` for a fact about how this team works. Guessing it
 * from context is how a team's own circumstances end up on the shelf every team reads.
 *
 * A node that CONTRADICTS an existing one goes through `knowledge_supersede` rather than
 * beside it, and supersession refuses a pair that spans both shelves: the two are different
 * kinds of claim and one cannot retire the other.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { catalogEntries } from "@zz/catalog";
import { parseCaller } from "@zz/contracts";
import { ARTIFACTS_DIR, indexDoc } from "@zz/indexing";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { tableRow } from "../document-rules.js";
import { journalLog, knowledgeEvent, type KbRow } from "../indexing.js";
import { KNOWLEDGE_TEAM, PLAIN_TOKEN, knowledgeRoot, sanitize, tagRefusal, titleSlug, userRoot, yamlValue } from "../paths.js";
import { commitStore, logActivity, setEnvelopeField } from "../persist.js";
import { blockVersionFor, db, teamFor, teamsFor } from "../platform-db.js";
import { isoToday } from "../write-guards.js";

export function registerKnowledgeTools(server: McpServer): void {
/** A journal tag that names a registry entry, checked so the query stays answerable.
 *
 * "What have we learned about casebox" is worth asking only if every node about casebox is findable by
 * one key. Free tags drift the moment two people write them — `casebox`, `plugin:casebox`, `CaseBox`,
 * `casebox` — and each variant silently removes nodes from the answer without
 * removing them from the store, which is the worst shape a knowledge base can fail in: the
 * search says nothing is known and the knowledge is right there.
 *
 * So a tag shaped `<kind>:<name>` must name a kind the platform actually has. The kinds are
 * the four classes of pluggable thing plus the platform itself, because that is what this
 * kind of knowledge is ever ABOUT: a block behaved a certain way, a flow's stage keeps
 * stalling, a provider did something under load, an interface drops something, or one of our
 * own rules turned out to be written in a way people cannot satisfy.
 *
 * `flow:` is checked against the catalog, which zz-core reads. The rest are not: zz-core
 * cannot see the block registry or the provider bindings, and a check that guessed would
 * refuse a true tag — worse than no check, because it teaches people to stop using the
 * convention. Kind is verified, name is verified where it can be, and the difference is
 * stated rather than hidden.
 *
 * Tags without a colon are ordinary free tags and are left alone. */
// `plugin`, not `block`. A plugin is the only installable thing on this platform — skills
// plus the MCP servers those skills call — so the subject a knowledge node is about is a
// plugin, never a "block". The concept was deleted from the platform; this is the tag
// vocabulary catching up, and 58 existing nodes are migrated with it.
const SUBJECT_KINDS = ["plugin", "flow", "provider", "interface", "platform"] as const;

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
      // The same catalog reader everything else uses. This walked it itself and counted every
      // directory as a flow, so a package with no flow.json — zz-access has none — was a
      // "known flow" here and is not one anywhere else.
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

  server.registerTool(
    "knowledge_add",
    {
      description:
        "Mint a knowledge-journal node in the team's _knowledge/: numbered, typed, evidence-linked. " +
        "type: decision|design|behavior|process|knowledge|style. evidence: initiative folder(s) the " +
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
        // NO `.optional()`, NO `.default()`. A default here would make silence a sayable
        // answer again — the exact defect DR-3 exists to prevent, and knowledge node 0097
        // records forcing a choice between two sayable answers as the move that works. The
        // schema layer refuses a call that omits this before the handler ever runs; the
        // handler below repeats the check because a schema is only as strong as the one
        // place it is declared, and this tool has a history of being called past its schema.
        scope: z.enum(["team", "platform"]),
        tags: z.array(z.string()).optional(),
        // WHICH VERSION OF THE BLOCK THE CLAIM WAS CHECKED AGAINST. The building-block
        // standard already requires a usage skill to declare `verified_against:`, and no
        // node carried it — so "is this defect still true" had no mechanical answer, and a
        // finding recorded on one version routed work around itself across every version
        // after it. Resolved automatically for a `plugin:<name>` tag; passed explicitly when
        // the claim was checked against something else.
        verified_against: z.string().optional(),
      },
    },
    async ({ title, type, body, evidence, tags, verified_against, scope }) => {
      const who = parseCaller(requestHeaders());
      // Defense in depth: the schema above already refuses a call that omits `scope` or
      // sends anything but these two values, but this tool has a history of being reached
      // past its schema (direct calls, older clients). Repeating the check here means the
      // refusal — and the reasoning in it — survives even if the schema layer is ever
      // bypassed, rather than degrading to a generic type error.
      if (scope !== "team" && scope !== "platform") {
        return text(
          "ERROR: `scope` says which shelf this node belongs on and there is no default. " +
          "Send `scope: \"team\"` for a lesson about how THIS team works, or " +
          "`scope: \"platform\"` for a fact about a block, flow, provider or interface that " +
          "holds for everybody."
        );
      }
      const badTag = subjectTagError(tags);
      if (badTag) return text(badTag);

      // The stores this caller may cite from: the one they act in, and every other team they
      // belong to. Resolved once, before `scope` is checked against it, so the team-scoped
      // refusal below and the evidence-root list further down share one lookup.
      const { active: team, all: evidenceTeams } = await teamsFor(who.email);
      // userRoot() falls back to a personal directory OUTSIDE teams/ when teamFor() is falsy
      // (server.ts:2374) — a team-scoped node from such a caller would report success and
      // land where team-gated search can never reach it. knowledge_search already refuses
      // this caller in these terms; this closes the same silent-loss path here. It used to
      // say "and knowledge_reindex" too, which stopped being true at Task I-38: that tool is
      // on /manage now and takes the team as an argument, so it has no caller's team to find
      // missing. `scope: "platform"` is untouched: the platform shelf is not
      // team-resolved, so a teamless caller still writes there.
      if (scope === "team" && !team) {
        return text("ERROR: you are not in a team — the knowledge base is team-scoped");
      }

      // This is a consistency guard on top of the explicit `scope` choice, never a
      // substitute for it: it does not infer scope from tags, it refuses a `scope` the
      // tags contradict. Platform knowledge is by definition about a registry entry —
      // a block, flow, provider, interface, or platform-wide fact — so a `platform`-scoped
      // node with no tag naming one is an opinion wearing the wrong shelf. `scope: "team"`
      // is left alone: a team lesson need not be about a registry entry.
      // SUBJECT_KINDS is reused rather than re-declared so a kind added there is honoured
      // here without a second edit.
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

      // Every list value is written straight into the node's YAML and read back by a
      // comma-splitter, so the check has to be about YAML, not about paths.
      //
      // safeName was the wrong rule here and the live test said so: it rejects separators
      // and traversal, and a comma sailed through — one evidence entry silently became two.
      // `]` plus a newline was worse: it closed the array and injected a second `type:` line
      // into the frontmatter, and parseEnvelope takes the last one, so a caller could set
      // the envelope field the index and the ranking read.
      // The shelf is chosen from `scope`, not hardcoded to the platform's: a team-scoped
      // lesson lands under the caller's own team, a platform-scoped one under
      // knowledgeRoot(). Written in this direction — platform first — so an inverted
      // ternary reads as wrong rather than merely different.
      const root = scope === "platform" ? knowledgeRoot() : await userRoot();
      // THE PLATFORM STORE STAYS IN THIS SET WHATEVER THE SCOPE IS. Before the shelf split,
      // `root` was always knowledgeRoot(), so the platform's initiatives were always citable as
      // evidence. Routing `root` by scope quietly removed that for every team-scoped write by a
      // caller who is not a zz-platform member — a narrowing the spec does not ask for and says
      // explicitly it does not want ("evidence validation is unchanged"). Listed first and
      // separately so the two concerns cannot drift into each other again.
      const evidenceRoots = [knowledgeRoot(), root, ...evidenceTeams.map((t) => join(ARTIFACTS_DIR, "teams", sanitize(t)))];
      for (const e of evidence) {
        if (!PLAIN_TOKEN.test(e.trim())) {
          return text(`ERROR: evidence entry "${e}" must be an initiative folder name — ` +
                      "letters, digits, dot, dash or underscore, nothing else");
        }
        // Shape was all this checked, and shape is not provenance. Both skills that teach
        // this tool say a node must POINT AT the initiative it came from — that is the whole
        // difference between knowledge and an opinion with a citation-shaped string next to
        // it. A typo passed silently and produced a permanent node whose evidence link goes
        // nowhere, which is worse than no link: it reads as checked.
        //
        // ANY TEAM THE CALLER IS IN, not only the one they are acting for. zz-distil is the
        // platform's second distillation: a platform-team member reads a tenant's
        // learnings.md — "because you are a member of that team", as that skill says in as
        // many words — and records the generalisable finding in the PLATFORM's knowledge,
        // "with the initiative it came from as evidence". Checking the acting team's store
        // alone refused every such node, so the platform capability could not be run at all.
        //
        // This does not widen what anybody can reach: it is exactly the set of stores this
        // caller may already read, and a member of one team still cannot cite another's.
        if (!evidenceRoots.some((r) => existsSync(join(r, e.trim())))) {
          return text(`ERROR: evidence entry "${e}" is not an initiative in any store you are a ` +
                      `member of (${evidenceTeams.join(", ") || "none"}). document_list with no ` +
                      "argument shows what is in the one you are acting for. Evidence names " +
                      "where the lesson came from, and a node whose evidence points at nothing " +
                      "is the opinion this tool exists to refuse.");
        }
      }
      const badTagShape = tagRefusal(tags);
      if (badTagShape) return text(badTagShape);

      const kdir = join(root, "_knowledge");
      const ndir = join(kdir, "nodes");
      mkdirSync(ndir, { recursive: true });
      const slug = titleSlug(title, type);
      const date = isoToday();

      // Allocate the id and claim it in one step, retrying if someone got there first.
      //
      // This read the highest existing id and added one, then wrote unconditionally. Two
      // knowledge_add calls landing together read the same maximum, produced the same id, and
      // the second overwrote the first node completely — a lost lesson, with nothing to
      // show it had ever existed. The store is team-shared and reachable from every client
      // at once, so "together" is ordinary, not exotic.
      //
      // wx fails if the file exists, which makes the filesystem the arbiter rather than a
      // lock this process would have to hold across an await.
      let id = "", file = "";
      for (let attempt = 0; attempt < 50; attempt++) {
        // parseInt on the whole name, not on the first four characters. Ids are padded to
        // four digits, so `slice(0, 4)` reads a five-digit id as its first four — the ten
        // thousandth node would have read the maximum as 1000 and started handing out ids
        // that already exist, which the wx claim below turns into fifty failed attempts and
        // a refusal. parseInt stops at the dash by itself and has no ceiling.
        const ids = readdirSync(ndir).map((f) => parseInt(f, 10)).filter((n) => !isNaN(n));
        id = String((ids.length ? Math.max(...ids) : 0) + 1).padStart(4, "0");
        file = `${id}-${slug}.md`;
        try {
          writeFileSync(join(ndir, file), "", { flag: "wx" });
          break;
        } catch {
          id = "";   // taken between the read and the write — recompute
        }
      }
      if (!id) return text("ERROR: could not allocate a journal node id after 50 attempts");
      const doc = [
        "---", `id: "${id}"`, `title: ${yamlValue(title)}`, `type: ${type}`,
        "status: adopted", `date: ${date}`, `author: ${who.email}`,
        `evidence: [${evidence.join(", ")}]`,
        `tags: [${(tags ?? []).join(", ")}]`,
        // Resolved from the registry when the node is about a block and the caller did not
        // say. A claim about a block with no version behind it cannot be retired when the
        // block moves, so it is followed forever.
        `verified_against: ${yamlValue(verified_against ?? (await blockVersionFor(tags, team)) ?? "")}`,
        "supersededBy: null", "---", "", body, "",
      ].filter((l) => l !== null).join("\n");
      writeFileSync(join(ndir, file), doc);   // fills the placeholder claimed above
      const index = join(kdir, "index.md");
      if (!existsSync(index)) writeFileSync(index, "| id | date | type | status | title |\n|---|---|---|---|---|\n");
      // The title is escaped for the frontmatter by yamlValue and was written raw here, so
      // a title carrying `|` re-columned the row and one carrying a newline appended a
      // second, fully-fabricated node to the index people are told to read first.
      appendFileSync(index, tableRow(id, date, type, "adopted", title));
      journalLog(root, "create", id, title);
      logActivity(root, null, { user: who.email, action: "knowledge_add", node: id });
      void indexDoc(root, `_knowledge/nodes/${file}`, doc);
      commitStore(root, who.email, "journal", id);
      const shelfName = scope === "platform" ? KNOWLEDGE_TEAM : team;
      knowledgeEvent({
        actor: who.email, action: "add", subject: id, team: shelfName,
        detail: { title, type, scope, file },
      });
      const shelf = shelfName ? `${shelfName}'s shelf` : "your personal shelf";
      return text(`journal node ${id} created (${file}) on ${shelf}`);
    },
  );

  server.registerTool(
    "knowledge_supersede",
    {
      description: "Mark a journal node superseded by a newer one — knowledge evolves, nothing is deleted.",
      // `{4,}`, not `{4}`. Ids are PADDED to four digits and grow past it: the ten thousandth
      // node is "10000", and an exact width would have made it the one node that can never be
      // superseded — in the tool whose whole premise is that knowledge evolves and nothing is
      // deleted. The allocator counts without a ceiling; this matches it.
      inputSchema: {
        old_id: z.string().regex(/^\d{4,}$/),
        new_id: z.string().regex(/^\d{4,}$/),
        // THE WAY OUT OF THE AMBIGUITY BELOW. Ids are allocated per shelf and both shelves
        // start at 0001, so the same number naming two nodes is the normal case rather than
        // an edge one — and the refusal told the caller to "supersede the one you mean by its
        // own shelf" with no argument in which to say so. A node whose number happened to
        // exist on the other shelf could therefore never be superseded at all, in the tool
        // whose premise is that knowledge evolves. Both ids are on this shelf: a node is
        // superseded by one beside it, which is the rule enforced further down anyway.
        shelf: z.enum(["team", "platform"]).optional()
          .describe("Which shelf both ids are on. Only needed when a bare id means a node on " +
                    "each shelf; the refusal says so when it does."),
      },
    },
    async ({ old_id, new_id, shelf }) => {
      const who = parseCaller(requestHeaders());
      // Two shelves now, and ids are allocated per shelf, so the same number can exist on
      // both — a bare id is ambiguous by design. Resolving must therefore hand back WHICH
      // shelf a node was found on, not just a path, or a cross-shelf pair would silently
      // relabel whichever node this happened to look at first.
      //
      // The team shelf is only checked when teamFor() actually gives a team: userRoot()
      // falls back to a personal directory OUTSIDE teams/ for a teamless caller, and that
      // directory is not a shelf a node can be superseded on — the platform shelf is the
      // only place left to look for such a caller.
      const team = await teamFor(who.email);
      const resolve = (id: string, shelf: "team" | "platform", root: string) => {
        const ndir = join(root, "_knowledge", "nodes");
        const file = existsSync(ndir) ? readdirSync(ndir).find((f) => f.startsWith(id + "-")) : undefined;
        return file ? { shelf, root, file } : null;
      };
      // AMBIGUOUS IS REFUSED, NOT GUESSED. Ids restart at 0001 on every shelf, so the same
      // number exists in two places as soon as both shelves hold a few nodes. Resolving
      // team-first and returning the first hit meant a caller superseding two PLATFORM nodes
      // whose numbers also existed on their own shelf would silently relabel two unrelated
      // team nodes — no error, no cross-shelf refusal, because both resolved to the same
      // shelf. This function's own docstring already warned against picking "whichever node
      // this happened to look at first"; ordering the lookup was doing exactly that.
      //
      // So an id present on both shelves is an error the caller has to settle, and the
      // refusal says which two nodes it could mean.
      async function findId(id: string) {
        const onTeam = team ? resolve(id, "team", await userRoot()) : null;
        const onPlatform = resolve(id, "platform", knowledgeRoot());
        // An explicit shelf settles it. It is a CHOICE BETWEEN the two, never a third answer:
        // asking for a shelf the id is not on returns nothing and is refused as "no node",
        // rather than quietly falling back to the other one and relabelling it.
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
        return text(bothShelves(old_id, oldFound.onTeam.file, oldFound.onPlatform.file));
      }
      const oldNode = oldFound;
      // The replacement must exist. Without this a node could be superseded by an id that
      // was never minted, and recall surfaces that as "we moved past this — see 0099"
      // pointing at nothing, which is worse than leaving the old node standing.
      const newFound = await findId(new_id);
      if (!newFound) return text(`ERROR: no node ${new_id} — supersede with a node that exists`);
      if ("ambiguous" in newFound) {
        return text(bothShelves(new_id, newFound.onTeam.file, newFound.onPlatform.file));
      }
      const newNode = newFound;
      if (old_id === new_id) return text("ERROR: a node cannot supersede itself");
      // A node is superseded by one on the same shelf. Promoting a team lesson to the
      // platform is writing a new platform node with the old one as evidence, not
      // reaching across shelves to relabel it — otherwise a team could mark its own node
      // superseded by an id that only means something on the platform shelf, or vice versa.
      if (oldNode.root !== newNode.root) {
        return text(
          `ERROR: \`${old_id}\` is on the \`${oldNode.shelf}\` shelf and \`${new_id}\` is on ` +
          `the \`${newNode.shelf}\` shelf. A node is superseded by one on the same shelf; ` +
          "promoting a lesson means writing a new platform node, not superseding across shelves."
        );
      }
      const root = oldNode.root;
      const oldFile = oldNode.file;
      const path = join(root, "_knowledge", "nodes", oldFile);
      let doc = readFileSync(path, "utf8");
      doc = setEnvelopeField(doc, "status", "superseded");
      doc = setEnvelopeField(doc, "supersededBy", `"${new_id}"`);
      writeFileSync(path, doc);
      // Re-index the node, or the change stays invisible to every search.
      //
      // This wrote the file and the human-readable index.md and stopped. zz.doc — which is
      // what knowledge_search actually reads — kept status: adopted and superseded_by:
      // null until the next boot or an explicit reindex. So "we tried this and moved on",
      // the single most useful thing recall can surface, was the one thing a search could
      // not see, for as long as the service happened to stay up.
      void indexDoc(root, `_knowledge/nodes/${oldFile}`, doc);
      const index = join(root, "_knowledge", "index.md");
      if (existsSync(index)) {
        writeFileSync(index, readFileSync(index, "utf8").replace(
          new RegExp(`^(\\| ${old_id} \\|[^|]*\\|[^|]*\\|) adopted (\\|)`, "m"), "$1 superseded $2"));
      }
      journalLog(root, "supersede", old_id, `superseded by ${new_id}`);
      commitStore(root, who.email, "journal supersede", `${old_id} -> ${new_id}`);
      logActivity(root, null, { user: who.email, action: "knowledge_supersede", node: old_id });
      // The shelf is read from the ROOT the old node was actually found on, not from the
      // caller's team: `findId` searches both shelves, so a platform node superseded by
      // somebody with a team of their own belongs to the platform shelf and filing the
      // entry under their team would put it on a log nobody looking for it would read.
      knowledgeEvent({
        actor: who.email, action: "supersede", subject: old_id,
        team: root === knowledgeRoot() ? KNOWLEDGE_TEAM : team,
        detail: { supersededBy: new_id, file: oldFile },
      });
      return text(`node ${old_id} superseded by ${new_id}`);
    },
  );

  server.registerTool(
    "knowledge_search",
    {
      description:
        "Search your team's knowledge base and get ANSWERS, not just a list of paths. Ranks by " +
        "relevance — fusing full-text match, tag overlap, and the initiatives a node cites as " +
        "evidence — and returns a matched excerpt from each result, so a caller can cite it " +
        "without opening it. Superseded nodes are surfaced and labelled rather than hidden: " +
        "'we tried this and moved on' is usually the most valuable thing here. Envelope filters " +
        "narrow the pool; provenance (status, approvals, outcome, path) comes back on every row.",
      inputSchema: {
        query: z.string().optional().describe("What you want to know. Natural language; supports quoted phrases and -exclusions."),
        type: z.string().optional().describe("decision|design|behavior|process|knowledge|style, or a document type."),
        status: z.string().optional(), initiative: z.string().optional(),
        flow: z.string().optional().describe("Restrict to one flow's documents, e.g. 'ops-flow'."),
        tags: z.array(z.string()).optional().describe("Require at least one of these tags."),
        include_superseded: z.boolean().optional().describe("Default true — a superseded decision is usually the point. Set false for current state only."),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, type, status, initiative, flow, tags, include_superseded, limit }) => {
      const who = parseCaller(requestHeaders());
      const team = await teamFor(who.email);
      if (!team) return text("ERROR: you are not in a team — the knowledge base is team-scoped");
      const p = db();
      if (!p) return text("ERROR: knowledge index unavailable (no platform db)");

      const want = limit ?? 15;
      const withHistory = include_superseded !== false;
      const tokens = (query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

      /* Pull a CANDIDATE-BOUNDED pool, not a corpus-bounded one: the row count a query
       * materialises never grows with the knowledge base, only with how many documents could
       * plausibly matter for one question. Ordered by ts_rank_cd, so the pool is already the
       * lexical ranking — cover density, which rewards matched terms appearing close together,
       * over the A/B/C weighting indexDoc applies (title > tags > body). */
      // Built once and applied to BOTH queries below. The neighbour expansion used to
      // rebuild a subset by hand and dropped initiative, flow and tags — so a caller who
      // scoped a search to one initiative got rows from others, arriving as via:["evidence"]
      // with no indication that the scope had been ignored. A filter the caller asked for is
      // not a hint to the ranker.
      // The caller's own documents AND the platform's journal. Knowledge is
      // filed under zz-platform now, so a search scoped to one team alone would
      // return a team's specs and none of the lessons written about them.
      const cond = ["team_slug = any($1::text[])"];
      const args: unknown[] = [[team, KNOWLEDGE_TEAM]];
      const put = (v: unknown) => { args.push(v); return `$${args.length}`; };
      const applyFilters = (push: (sql: string) => void, add: (v: unknown) => string) => {
        if (type) push(`type = ${add(type)}`);
        if (status) push(`status = ${add(status)}`);
        if (initiative) push(`initiative = ${add(initiative)}`);
        if (flow) push(`flow = ${add(flow)}`);
        // Lowercased on the way in, because the stored side is: a filter is a value arriving
        // from outside and has to be brought to the one spelling, exactly as an address typed
        // as a tool argument is. Without this, tags are stored lowercase and a caller who
        // filters `plugin:CaseBox` gets an empty result that reads as "nothing is known".
        if (tags?.length) push(`tags && ${add(tags.map((t) => t.trim().toLowerCase()))}::text[]`);
        // "Replaced" is recorded in two columns, and a filter for current state has to
        // read both. `status = 'superseded'` is the journal node's convention, set by
        // knowledge_supersede; `superseded_by` is the pointer, and it is what a _versions/
        // snapshot carries. This tested the first alone, so `include_superseded: false` —
        // whose whole purpose is "current state only" — returned every frozen approval
        // snapshot in the corpus, three rows deep for one spec.
        if (!withHistory) push(`superseded_by is null and status <> 'superseded'`);
      };
      applyFilters((c) => cond.push(c), put);

      // team_slug IS SELECTED, because the query spans TWO shelves and the answer used to
      // discard which one each row came from. A caller then read a path back with document_read,
      // which is scoped to their own team, and got "does not exist" for a node that is right
      // there on the platform's shelf. Observed on a live ops-flow round: the agent searched,
      // found the two nodes describing the exact casebox refusal it was about to hit, could not
      // read either, hit the refusal, and asked a non-technical person to build the thing by
      // hand. The lessons were visible and unreachable, which is worse than absent — it looks
      // like the knowledge base is working.
      const COLS = `initiative, path, flow, type, status, outcome, approved_by, approved_at,
                    updated_at, title, tags, evidence, superseded_by, team_slug`;
      let rank = "0::float4", head = "left(body, 400)";
      if (query) {
        const q = put(query);
        // websearch_to_tsquery accepts what a person actually types — quoted phrases, OR,
        // leading minus — and never throws on syntax, which plainto_ silently flattens and
        // to_tsquery rejects outright.
        cond.push(`body_tsv @@ websearch_to_tsquery('english', ${q})`);
        rank = `ts_rank_cd(body_tsv, websearch_to_tsquery('english', ${q}))`;
        // Matched terms are marked so a reader can see WHY a result came back, in markdown
        // rather than ts_headline's default <b>: everything else in this corpus is markdown,
        // and a model reading HTML tags in a snippet treats them as content.
        head = `ts_headline('english', body, websearch_to_tsquery('english', ${q}),
                 'MaxFragments=2, MaxWords=28, MinWords=12, FragmentDelimiter=" … ",
                  StartSel=**, StopSel=**')`;
      }
      const CANDIDATE_CAP = 200;
      const sql = `select ${COLS}, ${rank} as rank, ${head} as snippet
                   from zz.doc where ${cond.join(" and ")}
                   order by ${query ? "rank desc, updated_at desc" : "updated_at desc"}
                   limit ${CANDIDATE_CAP}`;
      const pooled = (await p.query(sql, args)).rows as KbRow[];

      /* Retrieve by TAG as its own list, not as a re-ranking of the lexical one.
       *
       * The tag signal was computed from `pooled` — the lexical hits — so it could only
       * reorder documents full-text had already found, never surface one it had missed.
       * That is precisely the case tags exist for: a node tagged `booking` does not
       * necessarily contain the word someone typed. Fusing a list drawn from another list
       * is not fusion; it is a tiebreak wearing the name. */
      let tagged: KbRow[] = [];
      if (tokens.length) {
        // SUBJECT TAGS ARE REACHABLE FROM THE WORD, which is the whole reason they exist.
        //
        // `tokens` splits the query on everything that is not a letter or a digit, so "what
        // have we learned about casebox" yields `casebox` — and a node tagged `plugin:casebox` was matched by
        // neither arm: not by `tags && tokens`, because the stored tag is one string with a
        // colon in it, and not by the lexical arm unless the body happened to spell it. The
        // platform validates the kind half, refuses a kind it does not have, and names that
        // exact question in knowledge_add's own description; the retrieval that answers it
        // could not see the tag.
        //
        // Expanded on the QUERY side rather than the stored side: a compound candidate is
        // only ever a tag somebody actually wrote, so `&&` and the overlap count that orders
        // these rows both keep working unchanged. Five kinds, so the list stays small.
        const wanted = [...new Set(tokens.flatMap((t) => [t, ...SUBJECT_KINDS.map((k) => `${k}:${t}`)]))];
        const tArgs: unknown[] = [[team, KNOWLEDGE_TEAM], wanted];
        const tPut = (v: unknown) => { tArgs.push(v); return `$${tArgs.length}`; };
        const tCond = ["team_slug = any($1::text[])", "tags && $2::text[]"];
        applyFilters((c) => tCond.push(c), tPut);
        tagged = (await p.query(
          `select ${COLS}, 0::float4 as rank, left(body, 400) as snippet
           from zz.doc where ${tCond.join(" and ")}
           order by cardinality(array(select unnest(tags) intersect select unnest($2::text[]))) desc,
                    updated_at desc
           limit 50`, tArgs)).rows as KbRow[];
      }

      /* Expand to graph neighbours of the top hits. A node's `evidence` names the initiatives
       * it was learned from, and that is the edge this store has: a node that cites the same
       * initiative as a strong hit is about the same work even when it shares no vocabulary.
       * Bounded by (seeds x their evidence), fetched in one targeted query — never a scan. */
      const seen = new Set([...pooled, ...tagged].map((r) => `${r.initiative}/${r.path}`));
      // Seeds come from BOTH retrieved lists: a node found only by its tags is as good a
      // starting point for the evidence graph as one found by its words.
      const seedInitiatives = [...new Set(
        [...pooled.slice(0, 10), ...tagged.slice(0, 10)].flatMap((r) => [...(r.evidence ?? []), r.initiative]),
      )];
      let neighbours: KbRow[] = [];
      if (query && seedInitiatives.length) {
        const nArgs: unknown[] = [[team, KNOWLEDGE_TEAM], seedInitiatives];
        const nPut = (v: unknown) => { nArgs.push(v); return `$${nArgs.length}`; };
        const nCond = ["team_slug = any($1::text[])", "(initiative = any($2::text[]) or evidence && $2::text[])"];
        applyFilters((c) => nCond.push(c), nPut);
        neighbours = ((await p.query(
          `select ${COLS}, 0::float4 as rank, left(body, 400) as snippet
           from zz.doc where ${nCond.join(" and ")} order by updated_at desc limit 50`, nArgs,
        )).rows as KbRow[]).filter((r) => !seen.has(`${r.initiative}/${r.path}`));
      }

      /* Reciprocal Rank Fusion over three ranked lists, k=60. RRF beats score-averaging
       * here because the three signals are not on a common scale: ts_rank_cd is a float,
       * tag overlap is a count, neighbour proximity is a boolean. Fusing POSITIONS makes
       * them comparable without inventing weights for quantities that cannot be compared. */
      const RRF_K = 60;
      const key = (r: KbRow) => `${r.initiative}/${r.path}`;
      const fused = new Map<string, { row: KbRow; score: number; via: Set<string> }>();
      const fuse = (list: KbRow[], via: string) => list.forEach((row, i) => {
        const k = key(row);
        const e = fused.get(k) ?? { row, score: 0, via: new Set<string>() };
        e.score += 1 / (RRF_K + i + 1); e.via.add(via); fused.set(k, e);
      });

      fuse(pooled, "lexical");
      fuse(tagged, "tag");
      fuse(neighbours, "evidence");

      const ranked = [...fused.values()].sort((a, b) => b.score - a.score);

      /* Fill a byte budget best-first rather than truncating at `limit` blindly: a caller's
       * context is finite, and reporting what was withheld is what stops a trimmed set being
       * read as the complete match. */
      const BUDGET = 24_000;
      const results: unknown[] = [];
      let spent = 0;
      for (const { row, score, via } of ranked) {
        if (results.length >= want) break;
        const snippet = (row.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
        const size = snippet.length + row.path.length + (row.title?.length ?? 0) + 120;
        if (spent + size > BUDGET && results.length > 0) break;
        spent += size;
        results.push({
          initiative: row.initiative, path: row.path, title: row.title, type: row.type,
          // WHICH SHELF, and therefore how to read it back. `platform` rows live in the
          // journal every team shares; document_read reaches them with scope: "platform".
          shelf: row.team_slug === team ? "team" : "platform",
          status: row.status, superseded_by: row.superseded_by ?? null,
          tags: row.tags ?? [], evidence: row.evidence ?? [], flow: row.flow,
          outcome: row.outcome, approved_by: row.approved_by, approved_at: row.approved_at,
          updated_at: row.updated_at,
          snippet,
          score: Number(score.toFixed(5)),
          via: [...via].sort(),
        });
      }

      const superseded = results.filter((r) => (r as { status: string }).status === "superseded").length;

      // WHAT CAME BACK, recorded against who asked. Until this line the knowledge base could
      // say what had been written into it and nothing at all about what anyone read out —
      // `knowledge_add` and `knowledge_supersede` each left three records and a search left
      // none. "Which nodes does anybody actually read" is the question that decides whether a
      // node earned its place, and it was unanswerable on a store with hundreds of them.
      //
      // THE IDS, not just the count. A row saying "someone searched and got nine results" is
      // the same shape of half-measurement as a run that records that it happened and not what
      // it did: it cannot tell a node nobody ever retrieves from one retrieved every day.
      // `initiative/path` is the identifier the caller is handed back and the one
      // `document_read` takes, so it is the id that joins to anything else.
      //
      // THE RETURNED SET, not the ranked one. `ranked` is everything retrieval considered,
      // which is bounded by a candidate cap and says more about the query than about what
      // reached a reader; `results` is what was actually put in front of the caller. Both
      // numbers are kept so the difference stays visible.
      knowledgeEvent({
        actor: who.email, action: "search", subject: (query ?? "").slice(0, 200),
        team,
        detail: {
          returned: results.map((r) => {
            const row = r as { initiative: string; path: string; shelf: string };
            return `${row.shelf}:${row.initiative}/${row.path}`;
          }),
          ranked_total: ranked.length, filters: { type, status, initiative, flow, tags },
        },
      });

      return text(JSON.stringify({
        team,
        query: query ?? null,
        ranked_total: ranked.length,
        returned: results.length,
        withheld: ranked.length - results.length,
        superseded_in_results: superseded,
        note:
          ranked.length > results.length
            ? `${ranked.length - results.length} lower-ranked results not shown — ask a narrower question to see them.`
            : undefined,
        results,
      }));
    },
  );
}
