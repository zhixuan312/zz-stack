/**
 * Initiatives and the documents inside them: the list, one initiative's own state, and one
 * document's content with its version history. A document is returned as the store holds it,
 * envelope included, because the job here is to show what was approved rather than a rendering
 * of it.
 */
import type { Express } from "express";

import { decisionRows } from "@zz/indexing";

import { platformDb } from "../db.js";
import { flowShape, handler, stageOf, type DocRow, type StageDoc } from "./shared.js";

/** The three document types that state claims. The type is the document's own, and it is what
 *  the role on every claim is stamped from — the reader that already knows the type does not
 *  have to be told it twice. */
const CLAIM_ROLES = /^(selection|agreement|plan)$/;

/** One row of the claim ledger, before the fields that cannot state absence state it. */
interface ClaimRow {
  path: string; role: string; key: string;
  verdict: string; qualifier: string; detail: string; checker: string;
}

/** Every claim a set of documents makes, computed from the bodies they hold.
 *
 * The claims are not stored: a stage states them in the text it writes for a reader, and
 * `decisionRows` parses that text back out on every read, so nothing can drift from the body
 * the console shows beside it. A document whose type is not one of the three stages that state
 * claims is skipped.
 *
 * COUPLED: the initiative view and the document view both compute their ledger through here,
 * and `knowledge_reconcile` in zz-core reads the same bodies the same way. */
function claimsOf(docs: { path: string; type: string | null; body: string | null }[]): ClaimRow[] {
  const out: ClaimRow[] = [];
  for (const d of docs) {
    const role = (d.type ?? "").trim();
    if (!CLAIM_ROLES.test(role)) continue;
    // A body this cannot read is one document with no claims, never an empty panel for the
    // whole initiative.
    if (typeof d.body !== "string") continue;
    // Keyed the way the ledger was keyed: by path, then by key within the document.
    for (const c of decisionRows(d.body).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
      out.push({ path: d.path, role, ...c });
    }
  }
  return out;
}

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
       to answer it. Carries neither `flow` nor `outcome`: both are the initiative's own, read
       from `zz.initiative` below, never from a document. */
    type ListRow = StageDoc & {
      team_slug: string; initiative: string;
      approved_by: string | null; updated_at: string;
      /** How many revisions of this document carry a seal. A document is approved once per
       *  revision, so this is what the panel's "approvals" column counts — the frozen copy an
       *  approval used to file beside the document is a `doc_revision` row now. */
      approvals: string;
    };
    /* THREE complete statements, not one assembled at request time.
       COUPLED: check:sql PREPAREs every query call in this repository against a live schema
       (scripts/gate/checks/console.ts, through packages/tools/src/lib/sql-scan.ts), and a query
       built from a `where` argument is a variable to that scan — there is no longer one statement
       for it to read, so it is neither prepared nor checked. Written out per branch, the same
       reason the fact and anchor queries above are.
       DELIBERATE: the names in this comment carry no backticks. The scanner reads this file as
       text, comments included, so a backtick here opens a template literal it then parses as code
       — which is how this comment broke the very check it is describing.
       COUPLED: a document reaches its team and its initiative through initiative_id — zz.doc
       carries neither slug — its approver through the revision it currently points at, and its
       supports through that revision's envelope payload. None of the four is a column of zz.doc,
       so a select naming them off it would stop preparing the day the migration lands. */
    // FR-58 (Task I-27): the same three scope shapes as the docs query above, mirrored for
    // `zz.initiative_fact` (001) — the console's own copy of `<initiative>/
    // _facts.json`, which it cannot read directly (it has no filesystem access to the store).
    // Written as three complete statements rather than one assembled at request time, for the
    // same reason the docs query above is: `check:sql` PREPAREs every statement it can read
    // whole, and a predicate built from `scope.kind` is invisible to it.
    type FactRow = { team: string; initiative: string; fact: string; value: string };
    const { rows: factRows } = scope.kind !== "platform"
      ? await db.query<FactRow>(
      `select t.slug as team, i.slug as initiative, f.fact, f.value
         from zz.initiative_fact f
         join zz.initiative i on i.id = f.initiative_id
         join zz.team t on t.id = i.team_id
        where t.slug = $1`, [scope.slug])
      : want !== null
      ? await db.query<FactRow>(
      `select t.slug as team, i.slug as initiative, f.fact, f.value
         from zz.initiative_fact f
         join zz.initiative i on i.id = f.initiative_id
         join zz.team t on t.id = i.team_id
        where t.slug = $1`, [want])
      : await db.query<FactRow>(
      `select t.slug as team, i.slug as initiative, f.fact, f.value
         from zz.initiative_fact f
         join zz.initiative i on i.id = f.initiative_id
         join zz.team t on t.id = i.team_id`);
    const factsByInit = new Map<string, Record<string, string>>();
    for (const r of factRows) {
      const key = `${r.team}/${r.initiative}`;
      const got = factsByInit.get(key) ?? {};
      got[r.fact] = r.value;
      factsByInit.set(key, got);
    }

    // The initiative's own lifecycle: `flow`, whether it is closed, and its outcome, all read
    // from `zz.initiative` — the one authority for a state no document derivation may answer
    // any more. Same three scope shapes as the queries above, for the same `check:sql` reason.
    type AnchorRow = { team: string; slug: string; flow: string | null; closed: boolean; outcome: string | null };
    const { rows: anchorRows } = scope.kind !== "platform"
      ? await db.query<AnchorRow>(
      `select t.slug as team, i.slug, i.flow, i.closed_at is not null as closed, i.outcome
         from zz.initiative i join zz.team t on t.id = i.team_id
        where t.slug = $1`, [scope.slug])
      : want !== null
      ? await db.query<AnchorRow>(
      `select t.slug as team, i.slug, i.flow, i.closed_at is not null as closed, i.outcome
         from zz.initiative i join zz.team t on t.id = i.team_id
        where t.slug = $1`, [want])
      : await db.query<AnchorRow>(
      `select t.slug as team, i.slug, i.flow, i.closed_at is not null as closed, i.outcome
         from zz.initiative i join zz.team t on t.id = i.team_id`);
    const anchorByInit = new Map<string, { flow: string | null; closed: boolean; outcome: string | null }>();
    for (const r of anchorRows) {
      anchorByInit.set(`${r.team}/${r.slug}`, { flow: r.flow, closed: r.closed, outcome: r.outcome });
    }
    // A document group with no `zz.initiative` row yet — the reconcile lag Q2/E of the schema
    // review names — reads as open with no declared flow, the same answer this route gave every
    // initiative before this row existed at all.
    const noAnchor = { flow: null as string | null, closed: false, outcome: null as string | null };

    const { rows } = scope.kind !== "platform"
      ? await db.query<ListRow>(
      `select t.slug as team_slug, i.slug as initiative, d.path, d.type, d.status,
              a.email as approved_by, (select string_agg(regexp_replace(td.path, '^.*/', ''), ', ' order by td.path)
                              from zz.doc_link l
                              join zz.doc td on td.id = l.to_doc_id
                             where l.from_doc_id = d.id and l.from_revision = r.revision
                               and l.kind = 'supports') as supports,
              (select count(*) from zz.doc_revision r2
                where r2.doc_id = d.id and r2.approved_by is not null)::text as approvals,
              to_char(d.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
         from zz.doc d
         join zz.initiative i on i.id = d.initiative_id
         join zz.team t on t.id = i.team_id
         left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
         left join zz.principal a on a.id = r.approved_by
        where i.slug <> '_knowledge' and t.slug = $1
        order by t.slug, i.slug, d.path`, [scope.slug])
      : want !== null
      ? await db.query<ListRow>(
      `select t.slug as team_slug, i.slug as initiative, d.path, d.type, d.status,
              a.email as approved_by, (select string_agg(regexp_replace(td.path, '^.*/', ''), ', ' order by td.path)
                              from zz.doc_link l
                              join zz.doc td on td.id = l.to_doc_id
                             where l.from_doc_id = d.id and l.from_revision = r.revision
                               and l.kind = 'supports') as supports,
              (select count(*) from zz.doc_revision r2
                where r2.doc_id = d.id and r2.approved_by is not null)::text as approvals,
              to_char(d.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
         from zz.doc d
         join zz.initiative i on i.id = d.initiative_id
         join zz.team t on t.id = i.team_id
         left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
         left join zz.principal a on a.id = r.approved_by
        where i.slug <> '_knowledge' and t.slug = $1
        order by t.slug, i.slug, d.path`, [want])
      : await db.query<ListRow>(
      `select t.slug as team_slug, i.slug as initiative, d.path, d.type, d.status,
              a.email as approved_by, (select string_agg(regexp_replace(td.path, '^.*/', ''), ', ' order by td.path)
                              from zz.doc_link l
                              join zz.doc td on td.id = l.to_doc_id
                             where l.from_doc_id = d.id and l.from_revision = r.revision
                               and l.kind = 'supports') as supports,
              (select count(*) from zz.doc_revision r2
                where r2.doc_id = d.id and r2.approved_by is not null)::text as approvals,
              to_char(d.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
         from zz.doc d
         join zz.initiative i on i.id = d.initiative_id
         join zz.team t on t.id = i.team_id
         left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
         left join zz.principal a on a.id = r.approved_by
        where i.slug <> '_knowledge'
        order by t.slug, i.slug, d.path`);
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
      const anchor = anchorByInit.get(key) ?? noAnchor;
      return {
        team: teamSlug, slug,
        flow: anchor.flow,
        // `approvals`, not revisions: a seal lands on a revision, and a revision nobody
        // approved carries none. What each row counts is the sealed revisions of ONE document,
        // so the initiative's total is their sum — not the document count, which would report
        // a document approved twice as one approval.
        documents: docs.length,
        approvals: docs.reduce((n, d) => n + Number(d.approvals ?? 0), 0),
        updated: docs.reduce((a, d) => (d.updated_at > a ? d.updated_at : a), ""),
        // Whoever approved something is the person the work belongs to. There is no owner
        // column, and the first document's author is whoever typed first, not who signed.
        stakeholder: docs.map((d) => d.approved_by).find(Boolean) ?? null,
        ...stageOf(docs, anchor.flow, { closed: anchor.closed, outcome: anchor.outcome },
                   factsByInit.get(key) ?? {}),
      };
    }).sort((a, b) => b.updated.localeCompare(a.updated));
    /* What the console's alert bell and its "Waiting on you" panel ask: the gate documents a person
     * can sign today — written, not yet approved, on an open initiative.
     *
     * DELIBERATE: its own projection rather than the whole list. The bell sits in the frame every
     * console page renders, so this read happens on every page, and the full list carries a stepper
     * and a gate list per initiative for every initiative the caller may read — kilobytes, to draw
     * a badge that is usually empty. This answers it in a row per open gate.
     *
     * `written`, because a gate nobody has drafted is waiting on the agent and not on a person, and
     * `!passed`, which is the approval itself. */
    if (req.query.waiting === "1") {
      const waiting = initiatives
        .filter((i) => !i.closed)
        .flatMap((i) => i.gates
          .filter((g) => g.written && !g.passed)
          .map((g) => ({ id: `${i.team}/${i.slug}/${g.name}`,
                         // The verb is the platform's ("approve spec"); the reader is shown the noun.
                         gate: g.name.replace(/^approve /, ""),
                         team: i.team, slug: i.slug, updated: i.updated,
                         stage: i.stage, at: i.at, of: i.of })))
        .sort((a, b) => b.updated.localeCompare(a.updated));
      res.json({ waiting });
      return;
    }
    res.json({ initiatives });
  }));

  /** One row of the claim ledger, with the fields that cannot state absence stating it.
   *
   * `decisionRows` gives every claim a string for every field and only two of its readers ever
   * produce a verdict, so "" is the ordinary spelling of "this row states no verdict" for both
   * a claim that has none and one whose verdict is genuinely empty. The empty value must not
   * read as a value.
   *
   * COUPLED: the initiative view and the document view both return these rows through here. */
  const claimRow = (row: ClaimRow) => ({ ...row, verdict: row.verdict || null,
                                         qualifier: row.qualifier || null, checker: row.checker || null });

  /** One initiative: every document, and the acceptance-criterion ledger.
   *
   * The ledger is computed from the documents' own bodies — every numbered claim a selection, an
   * agreement or a plan states, parsed back out of the text the stage wrote for a reader.
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
    const [docs, claimDocs, facts, anchor] = await Promise.all([
      // `flow`/`outcome` stay in this select as this document's own metadata — what the
      // dashboard renders per row. Neither drives `stageOf` below any more; the anchor query
      // does, and both are read from where they live now: the initiative's `flow`, and the
      // revision's own `outcome` key.
      db.query<DocRow & { flow: string | null }>(
        `select d.path, d.type, d.status, r.fields->>'outcome' as outcome,
                a.email as approved_by, d.title, coalesce(i.flow,'') as flow,
                (select string_agg(regexp_replace(td.path, '^.*/', ''), ', ' order by td.path)
                              from zz.doc_link l
                              join zz.doc td on td.id = l.to_doc_id
                             where l.from_doc_id = d.id and l.from_revision = r.revision
                               and l.kind = 'supports') as supports,
                to_char(d.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
                length(coalesce(r.body,'')) as bytes
           from zz.doc d
           join zz.initiative i on i.id = d.initiative_id
           join zz.team t on t.id = i.team_id
           left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
           left join zz.principal a on a.id = r.approved_by
          where t.slug = $1 and i.slug = $2 order by d.path`, [team, slug]),
      // The bodies the claims are recomputed from, in their own statement: the select above
      // reads `length(body)` and must not detoast every document to answer it.
      db.query<{ path: string; type: string | null; body: string | null }>(
        `select d.path, d.type, coalesce(r.body, d.body) as body
           from zz.doc d
           join zz.initiative i on i.id = d.initiative_id
           join zz.team t on t.id = i.team_id
           left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
          where t.slug = $1 and i.slug = $2
          order by d.path`, [team, slug]),
      // FR-58 (Task I-27): this initiative's own mirror of `_facts.json` (001),
      // read for `stageOf` below the same way the list route reads it for every initiative.
      db.query<{ fact: string; value: string }>(
        `select f.fact, f.value
           from zz.initiative_fact f
           join zz.initiative i on i.id = f.initiative_id
           join zz.team t on t.id = i.team_id
          where t.slug = $1 and i.slug = $2`, [team, slug]),
      // The initiative's own lifecycle — `flow`, whether it is closed, and its outcome — read
      // from `zz.initiative`, the one authority for a state no document may answer any more.
      db.query<{ flow: string | null; closed: boolean; outcome: string | null }>(
        `select i.flow, i.closed_at is not null as closed, i.outcome
           from zz.initiative i join zz.team t on t.id = i.team_id
          where t.slug = $1 and i.slug = $2`, [team, slug]),
    ]);
    if (!docs.rows.length) { res.status(404).json({ error: `no initiative ${team}/${slug}` }); return; }
    const decisions = claimsOf(claimDocs.rows);
    const factMap = Object.fromEntries(facts.rows.map((f) => [f.fact, f.value]));
    // No `zz.initiative` row yet is the same reconcile lag the list route allows for: read as
    // open, no declared flow.
    const lifecycle = anchor.rows[0] ?? { flow: null, closed: false, outcome: null };
    const shape = flowShape(lifecycle.flow);
    res.json({
      team, slug,
      documents: docs.rows.map((d) => {
        // Every row here is a live document: a version is a revision row now, so no row is a
        // frozen copy of another and none of them answers to a neighbour's rules.
        const rule = shape.get(d.path);
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
      decisions: decisions.map(claimRow),
      // What the ledger actually holds, so a column of blanks reads as a fact about the
      // documents rather than a fault in the derivation. The panel prints it as its aside —
      // without that, "these rows carry no verdict" and "the derivation stopped" look alike.
      decisionCounts: {
        rows: decisions.length,
        withVerdict: decisions.filter((d) => d.verdict).length,
        withQualifier: decisions.filter((d) => d.qualifier).length,
        withChecker: decisions.filter((d) => d.checker).length,
      },
      ...stageOf(docs.rows, lifecycle.flow, { closed: lifecycle.closed, outcome: lifecycle.outcome }, factMap),
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
    // The document's address, with no snapshot name to strip: a version is a `doc_revision`
    // row, not a second `zz.doc` row filed under a snapshot name, so the path asked for IS the
    // document's own.
    const base = path;
    /* One revision's text, on request: `?revision=<n>`.
     *
     * DELIBERATE: the history is listed by its metadata and its bodies are read one at a time.
     * `zz.doc_revision` holds the whole text of every write — 184 MB of it on this deployment,
     * and one plan.md alone carries 109 revisions totalling 94 MB. Returning those bodies with
     * the document made opening it a 94 MB download which the browser then diffed pairwise,
     * and reading them at all detoasts every revision. A reader looking at one change needs the
     * two texts the diff is drawn between, not every text the document has ever had.
     *
     * The version is validated as digits before it reaches the statement, so an empty or
     * malformed parameter is not silently read as revision 0. */
    const wantRevision = typeof req.query.revision === "string" && /^\d+$/.test(req.query.revision)
      ? Number(req.query.revision) : null;
    if (wantRevision !== null) {
      const { rows } = await db.query<{ version: number; body: string | null }>(
        `select r.revision as version, r.body
           from zz.doc d
           join zz.initiative i on i.id = d.initiative_id
           join zz.team t on t.id = i.team_id
           join zz.doc_revision r on r.doc_id = d.id
          where t.slug = $1 and i.slug = $2 and d.path = $3 and r.revision = $4`,
        [team, initiative, path, wantRevision]);
      if (!rows.length) {
        res.status(404).json({ error: `no revision ${wantRevision} of ${team}/${initiative}/${path}` });
        return;
      }
      res.json({ version: +rows[0].version, body: rows[0].body ?? null });
      return;
    }
    const [doc, versions, sources] = await Promise.all([
      db.query(
        `select t.slug as team, i.slug as initiative, d.path, d.current_revision,
                coalesce(i.flow,'') as flow,
                d.type, d.status, r.fields->>'outcome' as outcome,
                a.email as approved_by, r.approved_at, r.fields->>'closed_by' as closed_by,
                d.title, d.tags, r.fields->>'evidence' as evidence,
                d.status = 'superseded' as superseded,
                coalesce(r.body, d.body) as body,
                to_char(d.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
                length(coalesce(r.body,'')) as bytes
           from zz.doc d
           join zz.initiative i on i.id = d.initiative_id
           join zz.team t on t.id = i.team_id
           left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
           left join zz.principal a on a.id = r.approved_by
          where t.slug = $1 and i.slug = $2 and d.path = $3`,
        [team, initiative, path]),
      // Every version of this document, oldest first — the revision rows themselves, which ARE
      // the history now that a version is a row rather than a frozen copy beside the document.
      //
      // DELIBERATE: no body and no `length(body)`. Both detoast every revision the document has
      // ever had, and the browser needs neither to draw the history — it asks for the two texts
      // of the change it is showing, through `?revision=`. See the note where that is served.
      // `bytes` went with them: nothing rendered it, and measuring it was the whole
      // decompression bill.
      //
      // `hash` stays, because the history merges a revision that carries the same content as
      // the one above it — an approval that edited nothing files one — and telling that apart
      // needs a fingerprint of the body. md5 is the one that costs: it detoasts, so it is
      // proportional to a document's whole revision history (620 ms on the largest here, 94 MB
      // of it, and under a millisecond on the other 2,050 documents). Paid, because the
      // alternative is sending that 94 MB to the browser to compare it there.
      db.query(
        `select d.path, r.revision as version,
                md5(coalesce(r.body, '')) as hash,
                case when r.approved_by is not null then 'approved'
                     when r.revision = d.current_revision then d.status
                     else 'draft' end as status,
                a.email as approved_by,
                to_char(coalesce(r.written_at, d.updated_at) at time zone 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
           from zz.doc d
           join zz.initiative i on i.id = d.initiative_id
           join zz.team t on t.id = i.team_id
           join zz.doc_revision r on r.doc_id = d.id
           left join zz.principal a on a.id = r.approved_by
          where t.slug = $1 and i.slug = $2 and d.path = $3
          order by r.revision`, [team, initiative, path]),
      // Why it changed. A source declares the documents it bears on — the chain from "what we
      // learned" to "what we changed" — and that declaration is a `doc_link` row of kind
      // `supports`, pinned to the revision that wrote it at one end and to the target document's
      // identity at the other.
      //
      // DELIBERATE: read from `doc_link` and not from the envelope. `supports` used to be a
      // comma-joined key of the source's own revision, and that is no longer written —
      // `sourceDocument` leaves it to the relation, which is its only home. A reader left on the
      // key would empty this panel for every source added after that change, and the two would
      // be two answers to one question for every source added before it.
      db.query(
        `select s.path, s.title, coalesce(sr.body, s.body) as body,
                (select string_agg(regexp_replace(td.path, '^.*/', ''), ', ' order by td.path)
                              from zz.doc_link l
                              join zz.doc td on td.id = l.to_doc_id
                             where l.from_doc_id = s.id and l.from_revision = sr.revision
                               and l.kind = 'supports') as supports,
                to_char(s.updated_at,'YYYY-MM-DD') as added,
                length(coalesce(sr.body,'')) as bytes
           from zz.doc s
           join zz.initiative i on i.id = s.initiative_id
           join zz.team t on t.id = i.team_id
           left join zz.doc_revision sr on sr.doc_id = s.id and sr.revision = s.current_revision
          -- DELIBERATE: the match is against the LINK, one row per document supported, so a round
          -- attached to two documents is found from either. The envelope key this replaced held
          -- them comma-joined and was compared as a whole string, which found a source only when
          -- it supported exactly the document being read: a round attached to both intent.md and
          -- spec.md matched neither, and the panel was empty for exactly the material that bears
          -- on the document in front of the reader.
          where t.slug = $1 and i.slug = $2
            and exists (select 1 from zz.doc_link l
                          join zz.doc td on td.id = l.to_doc_id
                         where l.from_doc_id = s.id and l.from_revision = sr.revision
                           and l.kind = 'supports' and td.path = $3)
          order by s.updated_at, s.path`, [team, initiative, base]),
    ]);
    if (!doc.rows.length) {
      res.status(404).json({ error: `no document ${team}/${initiative}/${path}` });
      return;
    }
    // What the flow says about this one, same as the initiative list computes for the table.
    // Without it the status bar guesses from `status` alone and prints "draft" on a document
    // nothing will ever approve.
    const rule = flowShape(doc.rows[0].flow).get(base);
    // The claims this one document makes, computed from the body the response already carries.
    // A snapshot keeps none: its claims are the live document's.
    const decisions = claimsOf([doc.rows[0]]);
    res.json({
      ...doc.rows[0], bytes: +doc.rows[0].bytes,
      gated: rule ? rule.gate : null,
      closing: rule?.closing ?? false,
      requiredForClose: rule?.requiredForClose ?? false,
      decisions: decisions.map(claimRow),
      // What the ledger actually holds, so a column of blanks reads as a fact about the
      // documents rather than a fault in the derivation. The panel prints it as its aside —
      // without that, "these rows carry no verdict" and "the derivation stopped" look alike.
      decisionCounts: {
        rows: decisions.length,
        withVerdict: decisions.filter((d) => d.verdict).length,
        withQualifier: decisions.filter((d) => d.qualifier).length,
        withChecker: decisions.filter((d) => d.checker).length,
      },
      versions: versions.rows.map((v) => ({ ...v, bytes: +v.bytes, version: +v.version })),
      sources: sources.rows.map((x) => ({ ...x, bytes: +x.bytes })),
    });
  }));
}
