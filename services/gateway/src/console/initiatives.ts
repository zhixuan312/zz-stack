/**
 * Initiatives and the documents inside them: the list, one initiative's own state, and one
 * document's content with its version history. A document is returned as the store holds it,
 * envelope included, because the job here is to show what was approved rather than a rendering
 * of it.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import { flowShape, handler, stageOf, type DocRow, type StageDoc } from "./shared.js";

export function mountInitiatives(app: Express): void {
  /** Every initiative on the platform, with where it got to.
   *
   * COUPLED: one query for every document, grouped in memory, because the stage rule lives in
   * `stageOf`. Duplicating it in SQL is how the API and the front end start disagreeing. */
  app.get("/api/console/initiatives", handler("initiatives", async (req, res, scope) => {
    const db = platformDb();
    /* `?team=` is a filter, never a nullable one. Absent means "every team I may see"; present
     * means that one team, and a team scope may only ever name its own — anything else is the
     * same 404 a missing team gets, never a 403 that would confirm it exists.
     * `($1::text is null or team_slug = $1)` would make an absent parameter match every row.
     *
     * DELIBERATE: three complete statements, not one assembled from `scope` at request time.
     * `check:sql` PREPAREs every query in this file against a live schema before release and can
     * only PREPARE a literal it can read whole, so a predicate built from `scope.kind` is
     * invisible to it. Two of the three are the same text with a different bound value. */

    // A team scope may name its own slug and nothing else. Naming another team's is not a
    // narrower request it is entitled to make, so it gets the not-found it would get for a
    // team that does not exist.
    const want = typeof req.query.team === "string" && req.query.team ? req.query.team : null;
    if (scope.kind === "team" && want !== null && want !== scope.slug) {
      res.status(404).json({ error: `no team ${want}` });
      return;
    }
    /* Not `DocRow`, which is the shape of a document read. This route builds a summary per
       initiative — count, stage, who signed — and reads none of the body. Typing the rows as
       DocRow puts `length(coalesce(body,''))` in the select, and Postgres detoasts every body
       to answer it. */
    type ListRow = StageDoc & {
      team_slug: string; initiative: string; flow: string | null;
      approved_by: string | null; updated_at: string;
    };
    // FR-58 (Task I-27): the same three scope shapes as the docs query above, mirrored for
    // `zz.initiative_fact` (migration 085) — the console's own copy of `<initiative>/
    // _facts.json`, which it cannot read directly (it has no filesystem access to the store).
    // Written as three complete statements rather than one assembled at request time, for the
    // same reason the docs query above is: `check:sql` PREPAREs every statement it can read
    // whole, and a predicate built from `scope.kind` is invisible to it.
    type FactRow = { team: string; initiative: string; fact: string; value: string };
    const { rows: factRows } = scope.kind !== "platform"
      ? await db.query<FactRow>(
      `select team, initiative, fact, value from zz.initiative_fact where team = $1`, [scope.slug])
      : want !== null
      ? await db.query<FactRow>(
      `select team, initiative, fact, value from zz.initiative_fact where team = $1`, [want])
      : await db.query<FactRow>(`select team, initiative, fact, value from zz.initiative_fact`);
    const factsByInit = new Map<string, Record<string, string>>();
    for (const r of factRows) {
      const key = `${r.team}/${r.initiative}`;
      const got = factsByInit.get(key) ?? {};
      got[r.fact] = r.value;
      factsByInit.set(key, got);
    }

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
      // "/" as the separator, because a team slug cannot contain one (TEAM_SLUG is [a-z0-9_-]),
      // so the split below is unambiguous. A NUL byte here makes grep skip the file as binary.
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
        // `approvals`, not revisions: a `_versions/` file is written when a document is
        // approved, and a revision that was never approved leaves none. Counting it as
        // revisions under-reports every revision a later one replaced before anyone signed.
        documents: live.length, approvals: docs.length - live.length,
        updated: docs.reduce((a, d) => (d.updated_at > a ? d.updated_at : a), ""),
        // Whoever approved something is the person the work belongs to. There is no owner
        // column, and the first document's author is whoever typed first, not who signed.
        stakeholder: docs.map((d) => d.approved_by).find(Boolean) ?? null,
        ...stageOf(docs, docs.map((d) => d.flow).find(Boolean) ?? null, factsByInit.get(key) ?? {}),
      };
    }).sort((a, b) => b.updated.localeCompare(a.updated));
    res.json({ initiatives });
  }));

  /** One row of the claim ledger, with the fields that cannot state absence stating it.
   *
   * zz.decision's text columns are `not null default ''`, so the database has
   * one spelling for "this row states no verdict" and for "the verdict is the empty string".
   * Only two of the four readers that write these rows produce a verdict at all, so the empty
   * value is the ordinary case and must not read as a value.
   *
   * COUPLED: the initiative view and the document view both return these rows through here. */
  const claimRow = (d: unknown) => {
    const row = d as { verdict: string; qualifier: string; checker: string };
    return { ...row, verdict: row.verdict || null, qualifier: row.qualifier || null,
             checker: row.checker || null };
  };

  /** One initiative: every document, and the acceptance-criterion ledger.
   *
   * The ledger is `zz.decision` — one row per claim a stage document made, derived from what
   * the stage already wrote.
   *
   * Not every row carries a verdict. A plan's task has none (its `qualifier` holds the criteria
   * it discharges) and a spec's acceptance criterion has none either, because stating a
   * criterion is not judging whether it can be met. An empty verdict is reported as `null`
   * rather than `""`, the same rule skills.ts applies to an unmeasured average, and `counts`
   * below makes a blank column legible as "nothing here states a fit verdict". */
  app.get("/api/console/initiatives/:team/:slug", handler("the initiative", async (req, res, scope) => {
    const db = platformDb();
    const { team, slug } = req.params;
    // Same not-found rather than a refusal as /teams/:slug, for the same reason: a 403 for
    // a team scope naming someone else's team would confirm the initiative exists there.
    if (scope.kind === "team" && team !== scope.slug) {
      res.status(404).json({ error: `no initiative ${team}/${slug}` });
      return;
    }
    const [docs, decisions, facts] = await Promise.all([
      db.query<DocRow & { flow: string | null }>(
        // `flow` as well, because which documents are gated is the flow's
        // declaration and there is no way to ask the manifest without it.
        `select path, type, status, outcome, approved_by, title, flow, supports,
                to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
                length(coalesce(body,'')) as bytes
           from zz.doc where team_slug = $1 and initiative = $2 order by path`, [team, slug]),
      db.query(
        `select path, role, key, verdict, qualifier, detail, checker
           from zz.decision where team_slug = $1 and initiative = $2
          order by path, key`, [team, slug]),
      // FR-58 (Task I-27): this initiative's own mirror of `_facts.json` (migration 085),
      // read for `stageOf` below the same way the list route reads it for every initiative.
      db.query<{ fact: string; value: string }>(
        `select fact, value from zz.initiative_fact where team = $1 and initiative = $2`, [team, slug]),
    ]);
    if (!docs.rows.length) { res.status(404).json({ error: `no initiative ${team}/${slug}` }); return; }
    const factMap = Object.fromEntries(facts.rows.map((f) => [f.fact, f.value]));
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
      // What the ledger actually holds, so a column of blanks reads as a fact about the
      // documents rather than a fault in the derivation. The panel prints it as its aside —
      // without that, "these rows carry no verdict" and "the derivation stopped" look alike.
      decisionCounts: {
        rows: decisions.rows.length,
        withVerdict: decisions.rows.filter((d) => (d as { verdict: string }).verdict).length,
        withQualifier: decisions.rows.filter((d) => (d as { qualifier: string }).qualifier).length,
        withChecker: decisions.rows.filter((d) => (d as { checker: string }).checker).length,
      },
      ...stageOf(docs.rows, docs.rows.map((d) => d.flow).find(Boolean) ?? null, factMap),
    });
  }));

  /** One document, whole — its text, its envelope, and the claims it makes.
   *
   * The decisions come back with the document rather than beside it, because they are keyed by
   * its path: an acceptance-criterion ledger is what one particular document claims.
   *
   * Reads zz.doc.body, the same text the index was built from, so what is shown and what is
   * searchable cannot disagree. */
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
    // The live document is `spec.md`; its frozen predecessors are `_versions/spec.v1.md`,
    // `spec.v2.md` and so on. Derived from the name rather than stored, because that is the
    // convention the store is written with and a second copy of it could drift.
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
      // Every version of this document, oldest first — the frozen snapshots plus the live one.
      db.query(
        `select path, body, status, approved_by,
                to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
                length(coalesce(body,'')) as bytes,
                coalesce((regexp_match(path, '\\.v(\\d+)\\.md$'))[1]::int, 9999) as version
           from zz.doc
          where team_slug = $1 and initiative = $2
            and (path = $3 or path = '_versions/' || replace($3, '.md', '') || '.v' || (regexp_match(path, '\\.v(\\d+)\\.md$'))[1] || '.md')
          order by version`, [team, initiative, base]),
      // Why it changed. Every source declares the document it was attached to, which is the
      // chain from "what we learned" to "what we changed".
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
    // What the flow says about this one, same as the initiative list computes for the table.
    // Without it the status bar guesses from `status` alone and prints "draft" on a document
    // nothing will ever approve.
    const rule = flowShape(doc.rows[0].flow).get(base);
    res.json({
      ...doc.rows[0], bytes: +doc.rows[0].bytes,
      gated: rule ? rule.gate : null,
      closing: rule?.closing ?? false,
      requiredForClose: rule?.requiredForClose ?? false,
      decisions: decisions.rows.map(claimRow),
      // What the ledger actually holds, so a column of blanks reads as a fact about the
      // documents rather than a fault in the derivation. The panel prints it as its aside —
      // without that, "these rows carry no verdict" and "the derivation stopped" look alike.
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
