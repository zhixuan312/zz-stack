/**
 * /app + /api/kb — web v1: knowledge browsing, and attaching what people say.
 *
 * The SPA is one static page (no build step) served by the gateway; every
 * API call authenticates with a PAT, so the browser user IS a platform
 * principal. Files are read from the artifacts volume (read-only mount) and
 * search uses the derived zz.doc index.
 *
 * Writes go through zz-core over MCP, as the caller. This container mounts
 * the store read-only and should keep doing so: one writer stamps the
 * envelope, snapshots and commits, and the web is a client like any other.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { catalogManifest } from "@zz/catalog";
import { Mcp } from "@zz/mcp-client";
import { documentBody, parseEnvelope } from "@zz/contracts";
import type { Express, Request, Response } from "express";

import { platformDb, platformDbReady } from "./db.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import { logEvent } from "./events.js";
import { isSuper, TEAM_SLUG } from "./identity.js";

const ARTIFACTS = "/artifacts";
const APP_HTML = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "index.html");

/** A team's store root.
 *
 * The slug is checked HERE, not only at the door, because this is the function that turns a
 * caller's string into a filesystem path — and it was taking it unchecked. `?team=../..`
 * resolved this to `/`, and every guard downstream compares against the SAME poisoned root,
 * so `inside()` agreed that /etc/passwd was inside it. Proven on the live gateway with
 * `?team=../../etc&path=hostname`, which returned the container's hostname, and with
 * `?team=../..`, which listed its root directory.
 *
 * Membership alone did not stop it: a superadmin passes the membership test for any string,
 * and that is the whole point of a superadmin — it is not meant to be a filesystem key. */
function teamRoot(slug: string): string {
  if (!TEAM_SLUG.test(slug)) throw new Error(`not a team slug: ${slug}`);
  return join(ARTIFACTS, "teams", slug);
}

/** Whether `target` really sits inside `root`.
 *
 * NOT a string prefix. `/artifacts/teams/foo` is a prefix of
 * `/artifacts/teams/foobar`, so `startsWith` let a member of one team read another's
 * documents by passing `initiative=../foobar` — as long as a slug existed with theirs as a
 * prefix. `team_one` and `team_one0` would have been enough.
 *
 * `relative()` answers the question that was actually being asked: an escape produces a
 * path that starts with "..", and an absolute result means a different root entirely. */
function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !/^([A-Za-z]:)?[\\/]/.test(rel);
}

/** Guard every handler that needs the platform database.
 *
 * These used to `return` when the database was not ready, having sent nothing — so the
 * request hung until the client gave up, and the browser showed a spinner rather than a
 * problem. A 503 is both true and actionable. */
function requireDb(res: Response): boolean {
  if (platformDbReady()) return true;
  res.status(503).json({ error: "platform database unavailable" });
  return false;
}

function requireTeam(req: Request, res: Response): string | null {
  const id = req.zzIdentity;
  // The team they are ACTING as, not whichever membership row came back first. The web
  // view and the agent must agree about that: a person in two teams was otherwise reading
  // one team's documents in the browser while their agent wrote into the other's.
  const slug = (req.query.team as string | undefined) ?? id?.activeTeam ?? undefined;
  if (!id || !slug) {
    res.status(400).json({ error: "no team — join a team or pass ?team=" });
    return null;
  }
  // Answered at the door as well as in teamRoot: a caller gets a 400 that names the problem
  // rather than a 500 from a thrown path error, and the endpoints that never touch the
  // filesystem — search and sources, which pass the slug to SQL — are covered by the same
  // line rather than by nothing.
  if (!TEAM_SLUG.test(slug)) {
    res.status(400).json({ error: "team must be a slug" });
    return null;
  }
  // isSuper, not platformRole: the knowledge store is the one place where reading another
  // team's work is most of the harm, and a team-bound token has to be held to its team here
  // above all.
  if (!id.teams.some((t) => t.slug === slug) && !isSuper(id)) {
    res.status(403).json({ error: `not a member of ${slug}` });
    return null;
  }
  return slug;
}

export function mountKb(app: Express): void {
  // READ ONCE, at mount. A synchronous file read per request is the smaller half; the larger
  // is that a missing file threw out of a synchronous handler, where Express answers with a
  // stack rather than a sentence — which is the argument the next handler's own comment
  // makes, eight lines down, about a different read. Failing at boot instead says which file
  // is missing, once, to whoever is watching the container start.
  const appHtml = readFileSync(APP_HTML, "utf8");
  app.get("/app", (_req, res) => {
    res.type("html").send(appHtml);
  });

  app.get("/api/kb/me", (req, res) => {
    res.json(req.zzIdentity ?? {});
  });

  // GUARDED like every other handler here. This one was not, and it is the one that does the
  // most filesystem work: a directory listing per initiative and a read per document. A file
  // removed between the listing and the read — a reindex, a person tidying the store — threw
  // out of a synchronous handler, where Express answers with a stack rather than a sentence.
  app.get("/api/kb/initiatives", (req, res) => {
    try {
      const slug = requireTeam(req, res);
      if (!slug) return;
      const root = teamRoot(slug);
      if (!existsSync(root)) { res.json({ team: slug, initiatives: [] }); return; }
      // Dot-entries are not initiatives, and a team's store is a git repository — so this
      // landing view listed `.git` beside their work, then read every `.md` inside it to build
      // a card for it.
      const initiatives = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
        .map((e) => {
          const found = readdirSync(join(root, e.name)).filter((f) => f.endsWith(".md"));
          // ONE READ PER DOCUMENT. The flow and the outcome were found by two separate passes
          // over the same files, so opening the browser's landing view read every document in
          // every initiative twice. The envelope carries both.
          const envelopes = new Map(found.map((f) =>
            [f, parseEnvelope(readFileSync(join(root, e.name, f), "utf8"))]));
          // IN THE FLOW'S DECLARED ORDER, not alphabetical.
          //
          // The browser opened whichever document came first and had no way to know which one
          // that should be, so it special-cased the filename "spec.md" — one flow's document,
          // standing in for every flow, which is the same mistake the outcome lookup below
          // used to make. The manifest already says the order; nothing was asking it.
          const flow = found.map((f) => envelopes.get(f)?.flow).find(Boolean);
          const declared = (flow ? catalogManifest(flow, true)?.documents ?? [] : []).map((d) => d.name);
          const rank = (f: string) => {
            const i = declared.indexOf(f);
            return i === -1 ? declared.length : i;    // anything undeclared sorts after
          };
          const docs = [...found].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
          // Find the outcome wherever the flow put it, rather than assuming spec.md.
          // Which document closes an initiative is the FLOW's decision — its manifest marks
          // one `closing: true` — and it differs between flows. Hardcoding a filename here
          // meant this column silently read null for any flow that closes somewhere else,
          // and a closed initiative would look open in the browser.
          //
          // Through parseEnvelope, so it reads the ENVELOPE. Its own regex ran over the first
          // 2000 characters of the whole file, frontmatter or not, so a document that merely
          // discussed an outcome — a spec quoting the closing rule, a guide explaining it —
          // marked its initiative closed for everyone looking at the browser.
          let outcome: string | null = null;
          for (const f of found) {
            const v = envelopes.get(f)?.outcome;
            if (v) { outcome = v; break; }
          }
          return { name: e.name, docs, outcome };
        })
        .sort((a, b) => b.name.localeCompare(a.name));
      res.json({ team: slug, initiatives });
    } catch (err) {
      console.error("initiatives failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not read the team's store" });
    }
  });

  app.get("/api/kb/doc", (req, res) => {
    void (async () => {
      const slug = requireTeam(req, res);
      if (!slug) return;
      const initiative = String(req.query.initiative ?? "");
      const path = String(req.query.path ?? "");
      const target = resolve(teamRoot(slug), initiative, path);
      if (!inside(teamRoot(slug), target) || !existsSync(target) || !statSync(target).isFile()) {
        res.status(404).json({ error: "no such document" });
        return;
      }
      const raw = readFileSync(target, "utf8");
      const body = documentBody(raw);
      const meta = parseEnvelope(raw);
      // The non-markdown branch escaped nothing at all — a .txt or .json containing a tag
      // went straight into the page inside a <pre>, which does not neuter markup.
      const html = path.endsWith(".md") ? renderMarkdown(body) : `<pre>${escapeHtml(body)}</pre>`;
      res.json({ meta, html });
    })().catch(() => res.status(500).json({ error: "render failed" }));
  });

  app.get("/api/kb/search", (req, res) => {
    void (async () => {
      const slug = requireTeam(req, res);
      if (!slug || !requireDb(res)) return;
      // websearch_to_tsquery, and ranked — the same two choices search_knowledge makes and
      // for the reasons written there: it accepts what a person actually types (quoted
      // phrases, OR, a leading minus) and never throws on syntax, where plainto_ silently
      // flattens all of it; and ordering by recency answers "what changed lately" to
      // somebody who asked "where is this discussed". The same question typed in the browser
      // and in a chat was being answered by two different search engines over one index.
      const q = String(req.query.q ?? "").trim();
      const args: unknown[] = [slug];
      let cond = "team_slug = $1";
      let order = "updated_at desc";
      let rank = "0::float4";
      if (q) {
        args.push(q);
        const qp = `$${args.length}`;
        cond += ` and body_tsv @@ websearch_to_tsquery('english', ${qp})`;
        rank = `ts_rank_cd(body_tsv, websearch_to_tsquery('english', ${qp}))`;
        order = "rank desc, updated_at desc";
      }
      // `superseded_by` comes back, because the corpus holds frozen approval snapshots and
      // this said nothing about them. indexDoc indexes `<initiative>/_versions/spec.v1.md` and
      // derives its `superseded_by` from the path, so a search for a term in a spec returned
      // the live document AND every version of it ever approved — "three rows deep for one
      // spec", in zz-core's own words about the same corpus — with type, status and path all
      // looking alike and nothing saying which one is current.
      //
      // Surfaced and labelled rather than hidden, which is the platform's stance where it is
      // written down: a frozen copy is legitimately readable, and search_knowledge returns
      // this field on every row for exactly this reason. Filtering them out here instead
      // would make the browser and the chat two different search engines over one index
      // again, which is what the paragraph above records unifying.
      const r = await platformDb().query(
        `select initiative, path, type, status, outcome, superseded_by, updated_at, ${rank} as rank
         from zz.doc where ${cond} order by ${order} limit 30`, args);
      res.json({ results: r.rows });
    })().catch(() => res.status(500).json({ error: "search failed" }));
  });

  /* What somebody writes on a document is a SOURCE, not a second kind of record.
   *
   * There used to be a `comment` table and three MCP tools beside it, and that made two
   * routes to one effect with different costs: a comment left the document's version alone,
   * never reached `_versions/`, and never appeared in the envelope's `sources`. So "B said
   * this is wrong" was either a comment or a source depending on which door B walked
   * through, and only one of the two was part of the record.
   *
   * One door now. B writes on their phone, it lands as a source on the initiative, and the
   * agent that reads it revises the document and cites it — which is what "the comment was
   * addressed" actually means. Resolution needs no flag of its own: the next version, and
   * the source it names, are the evidence.
   *
   * The write goes THROUGH zz-core, not around it. This container mounts /artifacts
   * read-only, and it should stay that way — one writer owns the store, stamps the envelope
   * and commits to git. The web is a client here like Claude Code is. */
  app.get("/api/kb/sources", (req, res) => {
    void (async () => {
      const slug = requireTeam(req, res);
      if (!slug) return;
      const initiative = String(req.query.initiative ?? "");
      const path = String(req.query.path ?? "");
      const dir = join(teamRoot(slug), initiative, "sources");
      if (!inside(teamRoot(slug), dir) || !existsSync(dir)) { res.json({ sources: [] }); return; }
      const out = [];
      for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith(".md")) continue;
        const raw = readFileSync(join(dir, name), "utf8");
        const env = parseEnvelope(raw);
        // `supports` names the documents this material bears on. Filtering here rather than
        // showing every source keeps the panel about the document being read.
        const supports = (env.supports ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        if (path && supports.length && !supports.includes(path)) continue;
        out.push({
          file: `${initiative}/sources/${name}`,
          title: env.title ?? name.replace(/\.md$/, ""),
          // `contributed_by` is the field add_source writes. zz-core's list_sources carries a
          // comment about reading `added_by` here instead — "a field nothing has ever
          // written, so every source came back with an empty author" — and this was written
          // by guessing the name rather than reading it, three thousand lines from where the
          // same mistake was already recorded.
          author: env.contributed_by ?? "",
          added_at: env.added_at ?? env.date ?? "",
          supports,
          // documentBody, like every other strip. This one's own regex accepted `---x` as an
          // opening fence where @zz/contracts' requires a line of its own — four spellings of
          // where a frontmatter block ends, disagreeing about trailing whitespace.
          body: documentBody(raw).trim(),
        });
      }
      res.json({ sources: out });
    })().catch(() => res.status(500).json({ error: "sources failed" }));
  });

  app.post("/api/kb/sources", (req, res) => {
    void (async () => {
      const slug = requireTeam(req, res);
      if (!slug) return;
      const { initiative, path, body, title } = (req.body ?? {}) as Record<string, string>;
      if (!initiative || !body?.trim()) {
        res.status(400).json({ error: "initiative and body required" });
        return;
      }
      const author = req.zzIdentity?.email ?? "unknown";
      // The caller's own identity, forwarded — the same x-zz-* headers the middleware
      // stamped on this request and the same ones the /core/mcp proxy passes on. The web
      // never acts as somebody else, and zz-core reads the author from them.
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase().startsWith("x-zz-") && typeof v === "string") headers[k] = v;
      }
      const core = new Mcp(process.env.CORE_MCP_URL || "http://zz-core:8000/mcp", { headers });
      const reply = await core.call("add_source", {
        initiative, title: (title ?? "").trim() || `Note from ${author}`,
        content: body.trim(), ...(path ? { supports: path } : {}),
      });
      if (/^ERROR/.test(reply)) { res.status(400).json({ error: reply }); return; }
      logEvent({ actor: author, teamSlug: slug, kind: "source.add",
                 subject: `${initiative}${path ? `/${path}` : ""}`, detail: { via: "web" } });
      res.json({ ok: true, result: reply });
    })().catch((err: unknown) => {
      console.error("source add failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "source failed" });
    });
  });

}
