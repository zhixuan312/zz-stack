/**
 * Initiatives and the documents inside them.
 *
 * The list, one initiative's own state, and one document's content with its version history.
 * A document is returned as the store holds it, envelope included, because the console's job
 * here is to show what was approved rather than a rendering of it.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import { flowShape, handler, stageOf, type DocRow, type StageDoc } from "./shared.js";

export function mountInitiatives(app: Express): void {
  /** Every initiative on the platform, with where it got to.
   *
   * From zz.doc — see the header. One query for every document, grouped in
   * memory, because the stage rule lives in `stageOf` and duplicating it in SQL
   * is how the API and the front end start disagreeing about step 4. */
  app.get("/api/console/initiatives", handler("initiatives", async (req, res, scope) => {
    const db = platformDb();
    /* `?team=` IS A FILTER AGAIN — but never a nullable one.
     *
     * It was deleted outright because `($1::text is null or team_slug = $1)` made an absent
     * parameter match every row: a caller who forgot the query string got every team's
     * initiatives. Deleting it fixed that and broke the one caller that was passing it
     * honestly — the team page asks for `/initiatives?team=xuan`, the parameter was no
     * longer read, and a platform-scoped reader clicking into xuan got all 70 initiatives
     * on the platform, 54 of them another team's. The count beside the panel came from the
     * rows, so it agreed with itself and disagreed with the Teams table's 10.
     *
     * The wildcard was the bug, not the parameter. Absent means "every team I may see";
     * present means that one team, and a team scope may only ever name its own — anything
     * else is the same 404 a missing team gets, never a 403 that would confirm it exists.
     *
     * THREE COMPLETE STATEMENTS, not one assembled from `scope` at request time: `check:sql`
     * PREPAREs every query in this file against a live schema before release — see
     * packages/tools/src/testing/sql-check.ts for the 0.4.0 incident that check exists to
     * catch — and it can only PREPARE a literal it can read whole. A predicate built from
     * `scope.kind` is invisible to it, so all three branches below are spelled out in full.
     * Two of them are the same text with a different bound value, and that repetition is
     * the price of the check reading them. */

    // A team scope may name its own slug and nothing else. Naming another team's is not a
    // narrower request it is entitled to make, so it gets the not-found it would get for a
    // team that does not exist.
    const want = typeof req.query.team === "string" && req.query.team ? req.query.team : null;
    if (scope.kind === "team" && want !== null && want !== scope.slug) {
      res.status(404).json({ error: `no team ${want}` });
      return;
    }
    /* NOT `DocRow`, which is the shape of a document READ. This route builds a summary per
       initiative — count, stage, who signed — and reads none of the body. Typing the rows as
       DocRow is what put `length(coalesce(body,''))` in the select, and Postgres detoasts
       every body to answer it: 195.8 ms for this platform's 832 rows against 1.3 ms without.
       The list asks for what the list uses. */
    type ListRow = StageDoc & {
      team_slug: string; initiative: string; flow: string | null;
      approved_by: string | null; updated_at: string;
    };
    const { rows } = scope.kind !== "platform"
      ? await db.query<ListRow>(
      `select team_slug, initiative, flow, path, type, status, outcome, approved_by, supports,
              to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
         from zz.doc
        where initiative <> '_knowledge' and team_slug = $1
        order by team_slug, initiative, path`, [scope.slug])
      : want !== null
      ? await db.query<ListRow>(
      `select team_slug, initiative, flow, path, type, status, outcome, approved_by, supports,
              to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
         from zz.doc
        where initiative <> '_knowledge' and team_slug = $1
        order by team_slug, initiative, path`, [want])
      : await db.query<ListRow>(
      `select team_slug, initiative, flow, path, type, status, outcome, approved_by, supports,
              to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
         from zz.doc
        where initiative <> '_knowledge'
        order by team_slug, initiative, path`);
    const byInit = new Map<string, typeof rows>();
    for (const r of rows) {
      // "/" as the separator, because a team slug cannot contain one (TEAM_SLUG is
      // [a-z0-9_-]), so the split below is unambiguous. This was a NUL byte: it worked,
      // and it made the whole file unsearchable — grep classifies a file holding a
      // control byte as binary and skips it without saying so.
      const key = `${r.team_slug}/${r.initiative}`;
      const got = byInit.get(key);
      if (got) got.push(r); else byInit.set(key, [r]);
    }
    const initiatives = [...byInit.entries()].map(([key, docs]) => {
      const cut = key.indexOf("/");
      const teamSlug = key.slice(0, cut), slug = key.slice(cut + 1);
      const live = docs.filter((d) => !d.path.startsWith("_versions/"));
      return {
        team: teamSlug, slug,
        flow: docs.map((d) => d.flow).find(Boolean) ?? null,
        // `approvals`, NOT `revisions`, which is what this was called while counting
        // exactly this. A `_versions/` file is written when a document is APPROVED; a
        // revision that was never approved leaves none. So the number was always the
        // approval count, and under its old name it under-reported every revision that
        // a later one replaced before anyone signed it.
        documents: live.length, approvals: docs.length - live.length,
        updated: docs.reduce((a, d) => (d.updated_at > a ? d.updated_at : a), ""),
        // Whoever approved something is the person the work belongs to. There is
        // no owner column, and inventing one from the first document's author
        // would name whoever happened to type first rather than who signed.
        stakeholder: docs.map((d) => d.approved_by).find(Boolean) ?? null,
        ...stageOf(docs, docs.map((d) => d.flow).find(Boolean) ?? null),
      };
    }).sort((a, b) => b.updated.localeCompare(a.updated));
    res.json({ initiatives });
  }));

  /** One row of the claim ledger, with the fields that cannot state absence stating it.
   *
   * zz.decision's text columns are `not null default \'\'` (migration 011), so the database
   * has one spelling for "this row states no verdict" and for "this row\'s verdict is the
   * empty string". Only two of the four readers that write these rows produce a verdict at
   * all — a plan\'s task and a spec\'s acceptance criterion have none to give — so the empty
   * value is the ordinary case rather than the broken one, and it must not read as a value.
   *
   * ONE FUNCTION, TWO ENDPOINTS. The initiative view and the document view both return these
   * rows, and both had them raw; fixed inline they would have been two copies of one rule,
   * which is how the first of them came to be fixed and the second missed. */
  const claimRow = (d: unknown) => {
    const row = d as { verdict: string; qualifier: string; checker: string };
    return { ...row, verdict: row.verdict || null, qualifier: row.qualifier || null,
             checker: row.checker || null };
  };

  /** One initiative: every document, and the acceptance-criterion ledger.
   *
   * The ledger is `zz.decision` — one row per claim a stage document made, derived
   * from what the stage already wrote. It is the densest real content the platform
   * holds and nothing had ever displayed it.
   *
   * NOT EVERY ROW CARRIES A VERDICT, and this docblock used to say otherwise: "one
   * row per criterion with the verdict the selection step reached". Four readers
   * produce these rows and only two of them are reading a fit ledger. A plan's task
   * has no verdict — its `qualifier` holds the criteria it discharges — and a spec's
   * acceptance criterion has none either, because stating a criterion is not judging
   * whether a block can meet it. On the production store that is every row: 374
   * `agreement` and 104 `plan`, none of them a fit claim, because no selection
   * document has ever been indexed there.
   *
   * So an empty verdict is reported as `null` rather than as `""`. The column is
   * `not null default ''` and cannot express "this row states none"; the API can,
   * and the same rule already governs every aggregate this console returns — see
   * skills.ts, where an unmeasured average is null and never a confident zero.
   * `counts` below is what makes the distinction legible without opening a row:
   * a blank verdict column is then visibly "nothing here states a fit verdict"
   * rather than "this field is broken", which is how it read.
   *
   * BREAKING: `verdict`, `qualifier` and `checker` are now `null` where they were
   * `""`. A consumer testing truthiness is unaffected; one comparing to `""` is not. */
  app.get("/api/console/initiatives/:team/:slug", handler("the initiative", async (req, res, scope) => {
    const db = platformDb();
    const { team, slug } = req.params;
    // Same not-found rather than a refusal as /teams/:slug, for the same reason: a 403 for
    // a team scope naming someone else's team would confirm the initiative exists there.
    if (scope.kind === "team" && team !== scope.slug) {
      res.status(404).json({ error: `no initiative ${team}/${slug}` });
      return;
    }
    const [docs, decisions] = await Promise.all([
      db.query<DocRow & { flow: string | null }>(
        // `flow` as well, because which documents are gated is the FLOW's
        // declaration and there is no way to ask the manifest without it.
        `select path, type, status, outcome, approved_by, title, flow, supports,
                to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
                length(coalesce(body,'')) as bytes
           from zz.doc where team_slug = $1 and initiative = $2 order by path`, [team, slug]),
      db.query(
        `select path, role, key, verdict, qualifier, detail, checker
           from zz.decision where team_slug = $1 and initiative = $2
          order by path, key`, [team, slug]),
    ]);
    if (!docs.rows.length) { res.status(404).json({ error: `no initiative ${team}/${slug}` }); return; }
    const shape = flowShape(docs.rows.map((d) => (d as { flow?: string }).flow).find(Boolean) ?? null);
    res.json({
      team, slug,
      documents: docs.rows.map((d) => {
        // A snapshot answers to the same rules as the document it froze.
        const name = d.path.replace(/^_versions\//, "").replace(/\.v\d+\.md$/, ".md");
        const rule = shape.get(name);
        return {
          ...d, bytes: +d.bytes,
          // Null when the flow declares nothing about this file — a source, or a
          // document some other flow owns. Null is "we do not know", which is a
          // different answer from "no approval needed" and must not read as it.
          gated: rule ? rule.gate : null,
          closing: rule?.closing ?? false,
          requiredForClose: rule?.requiredForClose ?? false,
        };
      }),
      decisions: decisions.rows.map(claimRow),
      // What the ledger actually holds, so a column of blanks is readable as a fact about the
      // documents rather than as a fault in the derivation. READ, now: the panel prints it as
      // its aside. It was sent and dropped, which is the same gap one layer along — the
      // reader still could not tell "these rows carry no verdict" from "the derivation
      // stopped running", because nothing on screen said which.
      decisionCounts: {
        rows: decisions.rows.length,
        withVerdict: decisions.rows.filter((d) => (d as { verdict: string }).verdict).length,
        withQualifier: decisions.rows.filter((d) => (d as { qualifier: string }).qualifier).length,
        withChecker: decisions.rows.filter((d) => (d as { checker: string }).checker).length,
      },
      ...stageOf(docs.rows, docs.rows.map((d) => d.flow).find(Boolean) ?? null),
    });
  }));

  /** ONE DOCUMENT, whole — its text, its envelope, and the claims it makes.
   *
   * The console could show that a spec existed, who approved it and how many
   * bytes it was, and not a word of what it said. A reader looking at "plan.md,
   * approved, 54,691 bytes" has been told everything except the thing they came
   * for.
   *
   * The decisions come back WITH the document rather than beside it, because
   * they are keyed by its path: an acceptance-criterion ledger is what one
   * particular selection or spec claims, and floating it next to the initiative
   * detached it from the document that has to answer for it.
   *
   * Reads zz.doc.body — the same text the index was built from, so what is shown
   * and what is searchable cannot disagree. */
  app.get("/api/console/document/:team/:initiative/*", handler("the document", async (req, res, scope) => {
    const db = platformDb();
    const path = (req.params as Record<string, string>)[0];
    const { team, initiative } = req.params;
    // Same not-found rather than a refusal as /teams/:slug: a team scope naming someone
    // else's team gets the response it would get for a document that never existed.
    if (scope.kind === "team" && team !== scope.slug) {
      res.status(404).json({ error: `no document ${team}/${initiative}/${path}` });
      return;
    }
    // The live document is `spec.md`; its frozen predecessors are
    // `_versions/spec.v1.md`, `spec.v2.md` and so on. Derived from the name
    // rather than stored, because that IS the convention the store is written
    // with and a second copy of it could drift from the files.
    const base = path.replace(/^_versions\//, "").replace(/\.v\d+\.md$/, ".md");
    const [doc, decisions, versions, sources] = await Promise.all([
      db.query(
        `select team_slug as team, initiative, path, flow, type, status, outcome,
                approved_by, approved_at, closed_by, title, tags, evidence,
                superseded_by, body,
                to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
                length(coalesce(body,'')) as bytes
           from zz.doc where team_slug = $1 and initiative = $2 and path = $3`,
        [team, initiative, path]),
      db.query(
        `select key, role, verdict, qualifier, detail, checker
           from zz.decision
          where team_slug = $1 and initiative = $2 and path = $3
          order by key`, [team, initiative, path]),
      // EVERY VERSION OF THIS DOCUMENT, oldest first — the frozen snapshots plus
      // the live one. A reader asking "what changed" needs both sides, and the
      // console had no way to reach either.
      db.query(
        `select path, body, status, approved_by,
                to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
                length(coalesce(body,'')) as bytes,
                coalesce((regexp_match(path, '\\.v(\\d+)\\.md$'))[1]::int, 9999) as version
           from zz.doc
          where team_slug = $1 and initiative = $2
            and (path = $3 or path = '_versions/' || replace($3, '.md', '') || '.v' || (regexp_match(path, '\\.v(\\d+)\\.md$'))[1] || '.md')
          order by version`, [team, initiative, base]),
      // WHY IT CHANGED. Every source declares the document it was attached to, and
      // until now nothing indexed that — so the chain from "what we learned" to
      // "what we changed" existed in the files and in no query.
      db.query(
        `select path, title, body, supports,
                to_char(updated_at,'YYYY-MM-DD') as added,
                length(coalesce(body,'')) as bytes
           from zz.doc
          where team_slug = $1 and initiative = $2 and supports = $3
          order by updated_at, path`, [team, initiative, base]),
    ]);
    if (!doc.rows.length) {
      res.status(404).json({ error: `no document ${team}/${initiative}/${path}` });
      return;
    }
    // WHAT THE FLOW SAYS ABOUT THIS ONE, same as the initiative list computes
    // for the table. Without it the reader's own status bar was left guessing
    // from `status` alone and printed "draft" on a document nothing will ever
    // approve — the exact grey area the table was fixed to remove, still live
    // one click deeper.
    const rule = flowShape(doc.rows[0].flow).get(base);
    res.json({
      ...doc.rows[0], bytes: +doc.rows[0].bytes,
      gated: rule ? rule.gate : null,
      closing: rule?.closing ?? false,
      requiredForClose: rule?.requiredForClose ?? false,
      decisions: decisions.rows.map(claimRow),
      // What the ledger actually holds, so a column of blanks is readable as a fact about the
      // documents rather than as a fault in the derivation. READ, now: the panel prints it as
      // its aside. It was sent and dropped, which is the same gap one layer along — the
      // reader still could not tell "these rows carry no verdict" from "the derivation
      // stopped running", because nothing on screen said which.
      decisionCounts: {
        rows: decisions.rows.length,
        withVerdict: decisions.rows.filter((d) => (d as { verdict: string }).verdict).length,
        withQualifier: decisions.rows.filter((d) => (d as { qualifier: string }).qualifier).length,
        withChecker: decisions.rows.filter((d) => (d as { checker: string }).checker).length,
      },
      versions: versions.rows.map((v) => ({ ...v, bytes: +v.bytes, version: +v.version })),
      sources: sources.rows.map((x) => ({ ...x, bytes: +x.bytes })),
    });
  }));
}
