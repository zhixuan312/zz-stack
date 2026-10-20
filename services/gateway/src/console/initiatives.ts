/**
 * Initiatives and the documents inside them: one initiative's own state, and one document's content
 * with its version history; the list is initiative-list.ts's. A document is returned as the store
 * holds it, envelope included, because the job here is to show what was approved rather than a
 * rendering of it.
 *
 * Both are Work's, so both are the active team's, for the superadmin too (reconciliations 31, 39): the
 * team in the address must be the one the caller acts for, and nothing the request names widens it.
 *
 * An initiative is answered by its own row, documents or none: the list reads every `zz.initiative`
 * row, so one opened and never written in is listed, and its page is where it is abandoned.
 *
 * A not-found is one fixed sentence per kind, whatever was asked: an answer that repeated the team,
 * slug or path would hand back the name of something the caller may not read.
 */
import type { Express } from "express";

import { contentRevision, Envelope } from "@zz/contracts";
import { decisionRows } from "@zz/indexing";

import { platformDb } from "../db.js";
import { mountInitiativeList, stateOf } from "./initiative-list.js";
import { pendingRevisions } from "./pending.js";
import { flowShape, NO_TEAM, platformPublic, stageOf, type DocRow, ZZ_TZ } from "./shared.js";

/** The envelope keys the platform reserves; every other field is a flow's own. COUPLED:
 *  RESERVED_ENVELOPE in services/zz-core/src/document-rules.ts derives from the same schema. */
const RESERVED = new Set(Object.keys(Envelope.shape));

/** The three document types that state claims. The type is the document's own, and it is what
 *  the role on every claim is stamped from — the reader that already knows the type does not
 *  have to be told it twice. */
const CLAIM_ROLES = /^(selection|agreement|plan)$/;

/** The not-found answers, each the same whatever the request named.
 *  COUPLED: the close's 404 (console-close.ts) answers NO_INITIATIVE; checks/console-work-initiatives.ts and
 *  checks/console-close.ts hold the sentences. */
export const NO_INITIATIVE = "No initiative of the team you act for has that name.";
const NO_DOCUMENT = "No document of the team you act for is at that address.";
const NO_REVISION = "No snapshot of a document of the team you act for has that number.";

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
  // The list lives in initiative-list.ts; this module keeps the reads of one initiative and one
  // document.
  mountInitiativeList(app);

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

  /** One initiative: every document, the acceptance-criterion ledger, and its state as the list says it (stateOf in
   * initiative-list.ts, at the read's own instant), so the list and the page name one state in one set of words.
   *
   * The ledger is computed from the documents' own bodies — every numbered claim a selection, an
   * agreement or a plan states, parsed back out of the text the stage wrote for a reader.
   *
   * Not every row carries a verdict. A plan's task has none (its `qualifier` holds the criteria
   * it discharges) and a spec's acceptance criterion has none either, because stating a
   * criterion is not judging whether it can be met. An empty verdict is reported as `null`
   * rather than `""`, the same rule skills.ts applies to an unmeasured average, and `counts`
   * below makes a blank column legible as "nothing here states a fit verdict". */
  app.get("/api/console/initiatives/:team/:slug", platformPublic("the initiative", async (req, res, { activeTeam }) => {
    if (activeTeam === null) { res.status(400).json({ error: NO_TEAM }); return; }
    const db = platformDb();
    const { slug } = req.params;
    // A not-found rather than a refusal: a 403 for an address naming someone else's team would
    // confirm the initiative exists there. Every statement below reads the active team, never the
    // address's, so the address can name nothing else.
    if (req.params.team !== activeTeam) {
      res.status(404).json({ error: NO_INITIATIVE });
      return;
    }
    const team = activeTeam;
    // One instant for the whole read, as the list reads at its cutoff: the state below is the list's rule at it.
    const asOf = new Date().toISOString();
    const [docs, claimDocs, facts, anchor, pending] = await Promise.all([
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
                length(coalesce(r.body,'')) as bytes,
                case when i.closed_at is not null and d.status <> 'approved' and d.path <> 'handover.md'
                           and coalesce(i.flow, '') <> '' and d.approved_revision is not null and d.updated_at > i.closed_at
                           and (i.outcome <> 'abandoned'
                                or (select x.fields->>'outcome' from zz.doc_revision x
                                     where x.doc_id = d.id and x.revision = d.approved_revision) is not null)
                     then d.current_version end as correction
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
      // FR-58 (Task I-27): this initiative's own mirror of `_facts.json` (001), read for `stageOf`
      // below the same way the list (initiative-list.ts) reads it for every initiative.
      db.query<{ fact: string; value: string }>(
        `select f.fact, f.value
           from zz.initiative_fact f
           join zz.initiative i on i.id = f.initiative_id
           join zz.team t on t.id = i.team_id
          where t.slug = $1 and i.slug = $2`, [team, slug]),
      // The initiative's own lifecycle — `flow`, whether it is closed, and its outcome — read
      // from `zz.initiative`, the one authority for a state no document may answer any more, and
      // for whether the initiative exists at all.
      // When it was last touched, as the list reads it: the newest revision written of any of its documents and
      // sources, or, with none, when it was opened.
      db.query<{ flow: string | null; closed: boolean; outcome: string | null; touched_ms: number }>(
        `select i.flow, i.closed_at is not null as closed, i.outcome,
                (extract(epoch from coalesce((select max(r.written_at)
                                                from zz.doc d
                                                join zz.doc_revision r on r.doc_id = d.id
                                               where d.initiative_id = i.id), i.opened_at)) * 1000)::float8 as touched_ms
           from zz.initiative i join zz.team t on t.id = i.team_id
          where t.slug = $1 and i.slug = $2`, [team, slug]),
      pendingRevisions(asOf),
    ]);
    // Its row, not its documents: an initiative opened and never written in has none, and is still
    // listed. Every document joins this row, so no document is ever read without it.
    const lifecycle = anchor.rows[0];
    if (!lifecycle) { res.status(404).json({ error: NO_INITIATIVE }); return; }
    const decisions = claimsOf(claimDocs.rows);
    const factMap = Object.fromEntries(facts.rows.map((f) => [f.fact, f.value]));
    const shape = flowShape(lifecycle.flow);
    // An initiative with no flow has no steps, no gates and no position to answer, and the console reads it as freeform
    // from `flow`: its finished close names the document it lands on. stageOf's ops-flow fallback is for a flow the
    // catalog cannot resolve, which keeps it; answered for no flow, it drew a stepper over work no flow governs.
    // No flow asks for anything, so a finished close is complete and only an abandoned one is not, as the fake answers.
    const flow = lifecycle.flow || null;
    const { closed, outcome } = lifecycle;
    const waiting = pending.some((p) => p.team === team && p.initiative === slug);
    const state = stateOf({ outcome, closed, touchedMs: lifecycle.touched_ms }, waiting, Date.parse(asOf));
    const lastTouched = new Date(lifecycle.touched_ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    const position = flow === null
      ? { at: 0, of: 0, stage: "", steps: [], gates: [], closed, outcome, correction: null,
          accepted: outcome === "accepted", complete: outcome != null && outcome !== "abandoned" }
      : stageOf(docs.rows, flow, { closed, outcome }, factMap);
    res.json({
      team, slug, flow, state, lastTouched,
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
      ...position,
    });
  }));

  /** One document, whole — its text, its envelope, and the claims it makes.
   *
   * The decisions come back with the document rather than beside it, because they are keyed by
   * its path: an acceptance-criterion ledger is what one particular document claims.
   *
   * Reads zz.doc.body, the same text the index was built from, so what is shown and what is
   * searchable cannot disagree. */
  app.get("/api/console/document/:team/:initiative/*", platformPublic("the document", async (req, res, { activeTeam }) => {
    if (activeTeam === null) { res.status(400).json({ error: NO_TEAM }); return; }
    const db = platformDb();
    const path = (req.params as Record<string, string>)[0];
    const { initiative } = req.params;
    // A not-found rather than a refusal: an address naming someone else's team gets the response
    // it would get for a document that never existed. Every statement below reads the active team.
    if (req.params.team !== activeTeam) {
      res.status(404).json({ error: NO_DOCUMENT });
      return;
    }
    const team = activeTeam;
    // The document's address, with no snapshot name to strip: a version is a `doc_revision`
    // row, not a second `zz.doc` row filed under a snapshot name, so the path asked for IS the
    // document's own.
    const base = path;
    /* One snapshot's text, on request: `?revision=<n>`, the snapshot id a `versions` entry names.
     * It answers with the public version that snapshot belongs to beside it.
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
      const { rows } = await db.query<{ version: number; revision: number; body: string | null }>(
        `select r.version, r.revision, r.body
           from zz.doc d
           join zz.initiative i on i.id = d.initiative_id
           join zz.team t on t.id = i.team_id
           join zz.doc_revision r on r.doc_id = d.id
          where t.slug = $1 and i.slug = $2 and d.path = $3 and r.revision = $4`,
        [team, initiative, path, wantRevision]);
      if (!rows.length) {
        res.status(404).json({ error: NO_REVISION });
        return;
      }
      res.json({ version: +rows[0].version, revision: +rows[0].revision, body: rows[0].body ?? null });
      return;
    }
    const [doc, versions, sources] = await Promise.all([
      db.query(
        `select d.id, coalesce(r.content_generation, d.content_generation) as content_generation,
                t.slug as team, i.slug as initiative, d.path, d.current_revision, d.current_version,
                case when i.closed_at is not null and d.status <> 'approved' and d.path <> 'handover.md'
                           and coalesce(i.flow, '') <> '' and d.approved_revision is not null and d.updated_at > i.closed_at
                           and (i.outcome <> 'abandoned'
                                or (select x.fields->>'outcome' from zz.doc_revision x
                                     where x.doc_id = d.id and x.revision = d.approved_revision) is not null)
                     then d.current_version end as correction,
                coalesce(i.flow,'') as flow,
                d.type, d.status, r.fields->>'outcome' as outcome,
                a.email as approved_by, r.approved_at, r.fields->>'closed_by' as closed_by,
                d.title, d.tags, r.fields->>'evidence' as evidence, r.fields->>'stakeholder' as stakeholder,
                coalesce(r.fields, '{}'::jsonb) as envelope_fields,
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
      // One entry per public version of this document, oldest first. A version can hold several
      // snapshots (a presented or approved row that changed with no new cause files another row in
      // the same version), and its entry is the one it is read as: its last retained state, the
      // version's last row. `version` is the public number; `revision` is the snapshot a reader
      // fetches through `?revision=`.
      //
      // COUPLED: the subquery's order is `snapshotOf`'s rule in services/zz-core/src/versions.ts,
      // so the console and `document_read(version: N)` show the same bytes for vN.
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
      // alternative is sending that 94 MB to the browser to compare it there. The snapshot is
      // picked before the hash is taken, so only one body per version is read.
      //
      // `sealed_*`: a version read as an unsigned row can hold an approved row before it — a
      // metadata-only change after the approval, a closed document's correction among them, files
      // a new row in the same version. That approval is named, so it stays findable: its snapshot
      // id, who signed it and its generation, which becomes the `content_revision` zz-core reads it
      // by. Metadata only, like the rest; no body of it is read.
      //
      // COUPLED: `supersededApproval` in services/zz-core/src/versions.ts names the same
      // snapshot by the same rule — the version's last approved row before its last row.
      db.query(
        `select d.path, r.version, r.revision,
                md5(coalesce(r.body, '')) as hash,
                case when r.approved_by is not null then 'approved'
                     when r.revision = d.current_revision then d.status
                     else 'draft' end as status,
                a.email as approved_by,
                to_char(coalesce(r.written_at, d.updated_at) at time zone 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
                d.id as doc_id, s.revision as sealed_revision, s.content_generation::text as sealed_generation,
                s.approved_by as sealed_by,
                to_char(s.approved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as sealed_at
           from zz.doc d
           join zz.initiative i on i.id = d.initiative_id
           join zz.team t on t.id = i.team_id
           join zz.doc_revision r on r.doc_id = d.id
           left join zz.principal a on a.id = r.approved_by
           left join lateral (select x.revision, x.content_generation, xa.email as approved_by, x.approved_at
                                from zz.doc_revision x
                                join zz.principal xa on xa.id = x.approved_by
                               where x.doc_id = d.id and x.version = r.version and x.revision < r.revision
                                 and r.approved_by is null
                               order by x.revision desc limit 1) s on true
          where t.slug = $1 and i.slug = $2 and d.path = $3
            and r.revision in (select distinct on (x.version) x.revision
                                 from zz.doc_revision x
                                where x.doc_id = d.id
                                order by x.version, x.revision desc)
          order by r.version`, [team, initiative, path]),
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
                to_char(s.updated_at at time zone $4,'YYYY-MM-DD') as added,
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
          order by s.updated_at, s.path`, [team, initiative, base, ZZ_TZ]),
    ]);
    if (!doc.rows.length) {
      res.status(404).json({ error: NO_DOCUMENT });
      return;
    }
    // What the flow says about this one, same as the initiative list computes for the table.
    // Without it the status bar guesses from `status` alone and prints "draft" on a document
    // nothing will ever approve.
    const rule = flowShape(doc.rows[0].flow).get(base);
    // The claims this one document makes, computed from the body the response already carries.
    // A snapshot keeps none: its claims are the live document's.
    const decisions = claimsOf([doc.rows[0]]);
    // The displayed snapshot's identity, the token zz-core names it by, so the console can record
    // that it showed exactly this snapshot and approve exactly it. The current row's own generation,
    // or the document's while that row predates per-row generations — exact, because both describe
    // the same current content.
    //
    // COUPLED: `snapshotRevision` in services/zz-core/src/review-context.ts states the same rule.
    const { id, content_generation, envelope_fields, ...row } = doc.rows[0];
    res.json({
      ...row, bytes: +row.bytes,
      content_revision: contentRevision(id, Number(content_generation)),
      // The review metadata an approval signs beside the body, as zz-core's changeSnapshot reads it:
      // the stakeholder above, and every envelope field the platform does not reserve.
      fields: Object.fromEntries(Object.entries(envelope_fields as Record<string, unknown>)
        .filter(([k, v]) => !RESERVED.has(k) && typeof v === "string").sort(([a], [b]) => a.localeCompare(b))),
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
      // A superseded approval's token is minted only from a generation it carries: a row written
      // before generations were kept has none, and generation 0 would name other bytes.
      versions: versions.rows.map(({ doc_id, sealed_revision, sealed_generation, sealed_by, sealed_at, ...v }) => ({
        ...v, version: +v.version, revision: +v.revision,
        superseded_approved: sealed_revision == null ? null : {
          revision: +sealed_revision, approved_by: sealed_by, approved_at: sealed_at,
          content_revision: sealed_generation == null ? null : contentRevision(doc_id, Number(sealed_generation)),
        },
      })),
      sources: sources.rows.map((x) => ({ ...x, bytes: +x.bytes })),
    });
  }));
}
