/**
 * The two shelves: writing a node, superseding one, and searching both.
 *
 * `scope` has no default and every call sends it — `"platform"` for a fact about a registry
 * entry that holds for everybody, `"team"` for a fact about how this team works. Guessing it
 * from context is how a team's own circumstances end up on the shelf every team reads.
 *
 * A node that contradicts an existing one goes through `knowledge_supersede` rather than
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
import { journalLog, platformEvent } from "../indexing.js";
import { KNOWLEDGE_TEAM, PLAIN_TOKEN, knowledgeRoot, sanitize, tagRefusal, titleSlug, userRoot, yamlValue } from "../paths.js";
import { commitStore, logActivity, setEnvelopeField } from "../persist.js";
import { subjectVersionFor, teamFor, teamsFor } from "../platform-db.js";
import { isoToday } from "../write-guards.js";

/** Every node id this shelf's journal has ever issued, deleted ones included.
 *
 * `log.md` is appended on every mint and rewritten by nothing, which makes it the high-water
 * mark for allocation. A shelf with no log yet answers with nothing, and the directory decides
 * alone. */
function journalIds(kdir: string): number[] {
  const log = join(kdir, "log.md");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n")
    .map((line) => /^\|[^|]*\|[^|]*\|\s*(\d+)\s*\|/.exec(line)?.[1])
    .filter((x): x is string => !!x)
    .map((x) => parseInt(x, 10))
    .filter((n) => !isNaN(n));
}

import { registerKnowledgeSearch } from "./knowledge-search.js";

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

export function registerKnowledgeTools(server: McpServer): void {
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

      // The stores this caller may cite from: the one they act in, and every other team they
      // belong to. One lookup, shared by the team-scoped refusal below and the evidence-root
      // list further down.
      const { active: team, all: evidenceTeams } = await teamsFor(who.email);
      // userRoot() falls back to a personal directory outside teams/ when teamFor() is falsy, so
      // a team-scoped node from a teamless caller would report success and land where team-gated
      // search cannot reach it. `scope: "platform"` is untouched — that shelf is not
      // team-resolved, so a teamless caller writes there regardless.
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

      // Every list value is written straight into the node's YAML and read back by a
      // comma-splitter, so the check is about YAML, not about paths: a comma splits one
      // evidence entry into two, and `]` plus a newline closes the array and injects a second
      // frontmatter line that parseEnvelope, which takes the last, would read as the document's.
      //
      // The shelf comes from `scope` — a team-scoped lesson lands under the caller's own team,
      // a platform-scoped one under knowledgeRoot().
      const root = scope === "platform" ? knowledgeRoot() : await userRoot();
      // The platform store stays in this set whatever the scope is, so the platform's
      // initiatives are citable as evidence by a caller who is not a zz-platform member. Listed
      // first and separately from `root`, which the scope routes.
      const evidenceRoots = [knowledgeRoot(), root, ...evidenceTeams.map((t) => join(ARTIFACTS_DIR, "teams", sanitize(t)))];
      for (const e of evidence) {
        if (!PLAIN_TOKEN.test(e.trim())) {
          return text(`ERROR: evidence entry "${e}" must be an initiative folder name — ` +
                      "letters, digits, dot, dash or underscore, nothing else");
        }
        // Existence, not shape: an evidence entry has to name an initiative that is really
        // there, or the node reads as checked while its link goes nowhere.
        //
        // Any team the caller is in, not only the one they are acting for — a platform-team
        // member records a generalisable finding on the platform shelf with a tenant's
        // initiative as evidence. The set is exactly the stores this caller may already read,
        // so a member of one team still cannot cite another's.
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

      // Allocate the id and claim it in one step, retrying if someone got there first: the
      // store is team-shared and reachable from every client at once, so two calls reading the
      // same maximum is ordinary. `wx` fails if the file exists, which makes the filesystem the
      // arbiter rather than a lock this process would hold across an await.
      let id = "", file = "";
      for (let attempt = 0; attempt < 50; attempt++) {
        // parseInt on the whole name, not on the first four characters: ids are padded to four
        // digits and grow past it, and parseInt stops at the dash by itself with no ceiling.
        const ids = readdirSync(ndir).map((f) => parseInt(f, 10)).filter((n) => !isNaN(n));
        // Every id ever issued on this shelf, not only the ones whose file is still here: an
        // id names one node forever, so deleting the newest must not make its number available
        // again. `log.md` is the append-only record of every mint and covers deletions; the
        // directory covers a shelf whose log was never written.
        const highest = Math.max(0, ...ids, ...journalIds(kdir));
        id = String(highest + 1).padStart(4, "0");
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
        // Resolved from the registry when the node is about a plugin and the caller did not
        // say: a claim with no version behind it cannot be retired when the plugin moves.
        `verified_against: ${yamlValue(verified_against ?? (await subjectVersionFor(tags)) ?? "")}`,
        "supersededBy: null", "---", "", body, "",
      ].filter((l) => l !== null).join("\n");
      writeFileSync(join(ndir, file), doc);   // fills the placeholder claimed above
      const index = join(kdir, "index.md");
      if (!existsSync(index)) writeFileSync(index, "| id | date | type | status | title |\n|---|---|---|---|---|\n");
      // Escaped through tableRow: a title carrying `|` would re-column the row, and one
      // carrying a newline would append a second, fabricated node to the index.
      appendFileSync(index, tableRow(id, date, type, "adopted", title));
      journalLog(root, "create", id, title);
      logActivity(root, null, { user: who.email, action: "knowledge_add", node: id });
      void indexDoc(root, `_knowledge/nodes/${file}`, doc);
      commitStore(root, who.email, "journal", id);
      const shelfName = scope === "platform" ? KNOWLEDGE_TEAM : team;
      platformEvent({
        actor: who.email, kind: "knowledge.add", subject: id, team: shelfName,
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
      // Ids are allocated per shelf, so a bare id is ambiguous. Resolving hands back which
      // shelf a node was found on, not just a path, or a cross-shelf pair would relabel
      // whichever node was looked at first.
      //
      // The team shelf is checked only when teamFor() gives a team: userRoot() falls back to a
      // personal directory outside teams/, which is not a shelf a node can be superseded on.
      const team = await teamFor(who.email);
      const resolve = (id: string, shelf: "team" | "platform", root: string) => {
        const ndir = join(root, "_knowledge", "nodes");
        const file = existsSync(ndir) ? readdirSync(ndir).find((f) => f.startsWith(id + "-")) : undefined;
        return file ? { shelf, root, file } : null;
      };
      // Ambiguous is refused, not guessed: an id present on both shelves is an error the
      // caller settles with `shelf`, and the refusal names which two nodes it could mean.
      // Resolving team-first and returning the first hit would relabel unrelated team nodes
      // for a caller superseding two platform ones.
      async function findId(id: string) {
        const onTeam = team ? resolve(id, "team", await userRoot()) : null;
        const onPlatform = resolve(id, "platform", knowledgeRoot());
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
        return text(bothShelves(old_id, oldFound.onTeam.file, oldFound.onPlatform.file));
      }
      const oldNode = oldFound;
      // The replacement must exist, or recall surfaces "we moved past this — see 0099"
      // pointing at nothing.
      const newFound = await findId(new_id);
      if (!newFound) return text(`ERROR: no node ${new_id} — supersede with a node that exists`);
      if ("ambiguous" in newFound) {
        return text(bothShelves(new_id, newFound.onTeam.file, newFound.onPlatform.file));
      }
      const newNode = newFound;
      if (old_id === new_id) return text("ERROR: a node cannot supersede itself");
      // A node is superseded by one on the same shelf. Promoting a team lesson to the platform
      // is writing a new platform node with the old one as evidence, not relabelling it across
      // shelves.
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
      // Re-index the node, or the change stays invisible to every search: knowledge_search
      // reads zz.doc, which otherwise keeps `status: adopted` and `superseded_by: null` until
      // the next boot or an explicit reindex.
      void indexDoc(root, `_knowledge/nodes/${oldFile}`, doc);
      const index = join(root, "_knowledge", "index.md");
      if (existsSync(index)) {
        writeFileSync(index, readFileSync(index, "utf8").replace(
          new RegExp(`^(\\| ${old_id} \\|[^|]*\\|[^|]*\\|) adopted (\\|)`, "m"), "$1 superseded $2"));
      }
      journalLog(root, "supersede", old_id, `superseded by ${new_id}`);
      commitStore(root, who.email, "journal supersede", `${old_id} -> ${new_id}`);
      logActivity(root, null, { user: who.email, action: "knowledge_supersede", node: old_id });
      // The shelf is read from the root the old node was found on, not from the caller's team:
      // `findId` searches both, so a platform node superseded by somebody with a team of their
      // own still belongs to the platform shelf.
      platformEvent({
        actor: who.email, kind: "knowledge.supersede", subject: old_id,
        team: root === knowledgeRoot() ? KNOWLEDGE_TEAM : team,
        detail: { supersededBy: new_id, file: oldFile },
      });
      return text(`node ${old_id} superseded by ${new_id}`);
    },
  );

  // The read side is its own file: `knowledge_search` shares nothing with the two tools above
  // but the store they write into. See knowledge-search.ts.
  registerKnowledgeSearch(server);
}
