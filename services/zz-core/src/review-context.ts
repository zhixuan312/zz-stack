/**
 * Review contexts: who was shown which snapshot of a document, in which review, and how much of it.
 *
 * A REVIEW CONTEXT is minted by the server — `rc_` and 26 base32 characters of 128 random bits — by
 * the first `document_present` that does not name one, and handed back in its reply (and in the
 * panel's `_meta`). It is scoped to the team, the document, the authenticated principal and the
 * credential kind the gateway stamped (`x-zz-via`: `pat`, `forwarded` or `session`); `x-zz-client`
 * is asserted by the client, so it is recorded and never trusted. A context passed by anybody else,
 * for another document, or under another credential is unknown to the caller: the present starts a
 * new context and says so.
 *
 * A context lives on the presentation record and nowhere else: every `document.shown` /
 * `document.shown_part` row a present, the panel or the console writes carries `review_context`,
 * `target` (the snapshot's `content_revision`), `baseline` (or null), `kind` (`full` or `delta`)
 * and the page span — `start`, `end` and `total`, where `total` is the body's length for a full
 * page and the change set's text length for a delta page — beside `credential` and `client`.
 *
 * COVERAGE, per context. Snapshot C is covered when the full pages of exactly C cover its whole
 * body, or when a covered baseline B in the same context and the pages of the delta B→C cover the
 * delta's whole text. Pages of a different target or baseline never combine, and neither do pages
 * of two contexts. The context's baseline is the target it covered last. That is all a "covered
 * baseline" is: delivered coverage — the characters were handed over — not proof a person read them.
 *
 * DELIBERATE: the record of a presentation and the check that it shows what the row holds commit
 * together, under the document's own lock, BEFORE the text is returned (`commitPresentation`): a
 * partial presentation pins its snapshot before an edit can rewrite it in place, and a present that
 * lost the race to an edit says so and covers nothing.
 */
import { contentRevision, documentBody, parseCaller } from "@zz/contracts";
import { requestHeaders } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { recordPresented } from "./attest.js";
import { mintRef } from "./document-details.js";
import type { PartAsk } from "./document-parts.js";
import { lockPath, rowHeld, stampGeneration } from "./document-snapshot.js";
import { insertEvent } from "./indexing.js";
import { type loadDocument, splitStorePath } from "./versions.js";

/** The caller a presentation is scoped to: the team, the principal, the credential kind the
 *  gateway stamped, and the client it says it is. */
export interface Viewer { team: string; email: string; credential: string; client: string | null }

/** The current request's viewer. */
export function viewerOf(team: string): Viewer {
  const h = requestHeaders();
  const one = (k: string): string => { const v = h[k]; return (Array.isArray(v) ? v[0] : v) ?? ""; };
  return { team, email: parseCaller(h).email, credential: one("x-zz-via"), client: one("x-zz-client") || null };
}

/** A snapshot as a present shows it: its body, envelope stripped, trimmed. A full page's `total`
 *  is this text's length, the same for the present's text and the panel's record of it. */
export const presentedBody = (text: string): string => documentBody(text).trim();

/** The content revision a loaded snapshot is named by: its own generation, else — on the current row
 *  alone — the document's (the rule `generationOf` in versions.ts keeps); null for a superseded row
 *  written before generations were recorded per row. */
export function snapshotRevision(l: Extract<Awaited<ReturnType<typeof loadDocument>>, { ok: true }>): string | null {
  const g = l.rev.content_generation ?? (l.rev.revision === l.doc.current_revision ? l.doc.content_generation : null);
  return g == null ? null : contentRevision(l.doc.id, Number(g));
}

/** A new context. COUPLED: `mintRef` is `dr_` and 26 base32 characters of 128 random bits — the
 *  same token a context is, under another prefix, so the one minting rule serves both. */
export const mintContext = (): string => `rc_${mintRef().slice(3)}`;

/** One page of one presentation, as its row records it. */
interface Page {
  context: string | null; target: string | null; baseline: string | null;
  kind: "full" | "delta"; start: number; end: number; total: number;
}

/** What `document_present` takes beyond `path`, as the argument handling below reads it: the part
 *  asked for, the public version, and the context. */
export interface PresentAsk extends PartAsk { review_context?: string; full?: boolean; version?: number }

/** The two arguments a context present adds to `document_present`'s schema. */
export const CONTEXT_INPUT = {
  review_context: z.string().optional()
    .describe("The review context an earlier document_present of this document returned (`rc_…`). With it, " +
              "the present shows only what changed since that context last covered the document."),
  full: z.boolean().optional()
    .describe("Present the whole document even when the review context has a covered baseline."),
};

/** The arguments a context cannot be combined with: a context is one review of one document's
 *  current snapshot, and `version` and `section` are reads beside it. */
export function presentRefusal(path: string | string[], a: PresentAsk): string | null {
  if (a.review_context !== undefined && (Array.isArray(path) || a.version !== undefined || a.section !== undefined)) {
    return "ERROR: INVALID_MODE — `review_context` continues one review of one document's current snapshot; " +
      "it cannot be combined with `version`, `section` or an array `path`.";
  }
  if (a.full && (a.version !== undefined || a.section !== undefined)) {
    return "ERROR: INVALID_MODE — `full` presents the current snapshot whole; it cannot be combined with " +
      "`version` or `section`.";
  }
  return null;
}

/** Every page the viewer was shown of `rel` in a context — one context's, or all of them — in the
 *  order they were recorded. Scoped by the row itself: the principal it was shown to, the
 *  credential kind, and the document. */
async function pagesOf(
  c: Pick<pg.Pool, "query">, who: Viewer, rel: string, context: string | null,
): Promise<(Page & { context: string })[]> {
  const { initiative } = splitStorePath(rel);
  const { rows } = await c.query<Page & { context: string }>(
    `select e.detail->>'review_context' as context, e.detail->>'target' as target,
            e.detail->>'baseline' as baseline, e.detail->>'kind' as kind,
            (e.detail->>'start')::int as start, (e.detail->>'end')::int as "end",
            (e.detail->>'total')::int as total
       from zz.event e
       join zz.initiative i on i.id = e.initiative_id
       join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug = $2 and e.subject = $3
        and e.kind in ('document.shown', 'document.shown_part')
        and e.detail->>'review_context' is not null
        and lower(e.detail->>'user') = lower($4) and coalesce(e.detail->>'credential', '') = $5
        and ($6::text is null or e.detail->>'review_context' = $6)
      order by e.ts, e.id`,
    [who.team, initiative, rel, who.email, who.credential, context]);
  return rows;
}

/** The targets a context covered, in the order each became covered: the last is its baseline. */
function coverageOf(pages: Page[]): string[] {
  const spans = new Map<string, { kind: string; baseline: string; target: string; total: number; at: [number, number][] }>();
  const done: string[] = [];
  const reached = (g: { total: number; at: [number, number][] }): boolean => {
    let at = 0;
    for (const [s, e] of [...g.at].sort((x, y) => x[0] - y[0])) { if (s > at) break; at = Math.max(at, e); }
    return at >= g.total;
  };
  for (const pg of pages) {
    if (!pg.target) continue;
    const baseline = pg.kind === "delta" ? pg.baseline ?? "" : "";
    const key = [pg.kind, baseline, pg.target, pg.total].join("\u0000");
    const g = spans.get(key) ?? { kind: pg.kind, baseline, target: pg.target, total: pg.total, at: [] };
    g.at.push([pg.start, pg.end]);
    spans.set(key, g);
    // A delta page can complete a target whose baseline completes only later, so this runs until
    // nothing more is covered.
    for (let grew = true; grew;) {
      grew = false;
      for (const s of spans.values()) {
        if (done.includes(s.target) || (s.kind === "delta" && !done.includes(s.baseline)) || !reached(s)) continue;
        done.push(s.target);
        grew = true;
      }
    }
  }
  return done;
}

/** One context as the viewer holds it: whether it is theirs at all, what it covered, its baseline,
 *  and its open presentation — the last page recorded in it. */
export async function contextState(
  c: Pick<pg.Pool, "query">, who: Viewer, rel: string, context: string,
): Promise<{ known: boolean; covered: string[]; baseline: string | null; open: Page | null }> {
  const pages = await pagesOf(c, who, rel, context);
  const covered = coverageOf(pages);
  return { known: pages.length > 0, covered, baseline: covered[covered.length - 1] ?? null, open: pages[pages.length - 1] ?? null };
}

/** What a present in a context shows: the context, why it is a new one when that needs saying,
 *  and the presentation — full or the delta from the baseline, of `target`, from `offset`. */
export interface Resolved {
  context: string; note: string | null; kind: "full" | "delta"; target: string; baseline: string | null;
  /** A continuation of the context's open presentation, which may be of a snapshot no longer current. */
  continuing: boolean;
}

/** The argument handling of a present without `version` or `section`, against the document's
 *  current snapshot `current`:
 *    - `review_context` names one of the viewer's contexts for this document, or a new one is
 *      minted and the reply says why;
 *    - a continuation (`offset` > 0, not `full`) with no context joins the viewer's most recent
 *      context whose open presentation is of the current snapshot, and a new one only when none is;
 *    - a continuation in a context serves that context's open presentation, full or delta, whatever
 *      is current now;
 *    - otherwise the present is full when the context has no covered baseline or `full` is asked,
 *      and the delta from the baseline when it has one. */
export async function resolvePresentation(
  c: Pick<pg.Pool, "query">, who: Viewer, rel: string, current: string, a: PresentAsk,
): Promise<Resolved> {
  const continuing = (a.offset ?? 0) > 0 && !a.full;
  let context: string | null = null;
  let note: string | null = null;
  if (a.review_context !== undefined) {
    if (/^rc_[a-z2-7]{26}$/.test(a.review_context) && (await contextState(c, who, rel, a.review_context)).known) {
      context = a.review_context;
    } else {
      note = `The review context ${a.review_context} is not one of yours for ${rel}, so a new one was started`;
    }
  } else if (continuing) {
    const last = new Map<string, Page>();
    for (const pg of await pagesOf(c, who, rel, null)) { last.delete(pg.context); last.set(pg.context, pg); }
    context = [...last].filter(([, pg]) => pg.target === current).pop()?.[0] ?? null;
  }
  if (!context) return { context: mintContext(), note, kind: "full", target: current, baseline: null, continuing: false };
  const state = await contextState(c, who, rel, context);
  if (continuing && state.open?.target) {
    return { context, note, kind: state.open.kind, target: state.open.target, baseline: state.open.baseline, continuing: true };
  }
  return { context, note, kind: a.full || !state.baseline ? "full" : "delta", target: current,
           baseline: state.baseline, continuing: false };
}

/** A page about to be recorded, and the snapshot it was cut from: its row and generation when it
 *  is the document's current snapshot, so the record can confirm the row still holds it. */
export interface Presented extends Page {
  version: number; revision: number;
  /** The current row and the generation it was loaded at; null for a snapshot no longer current. */
  current: { revision: number; generation: number } | null;
  /** Which surface showed it: `panel`, `console`, or none for a present's text. */
  via?: string;
  meta_bytes: number;
}

/** Record one presented page, and compose what the caller is told, in one transaction:
 *  the document's lock; when the page is of the current snapshot, the row must still hold the
 *  generation presented — a current row written before generations were recorded per row is stamped
 *  with the document's — or nothing is recorded and the reply says so; then the row, and
 *  `presented_at` when the page completes the current snapshot's coverage in its context.
 *  Committed before `compose`'s text is returned, which states whether the target is now covered;
 *  the row records that text's length and the panel payload's beside it. */
export async function commitPresentation(
  p: pg.Pool, who: Viewer, rel: string, page: Presented, compose: (covered: boolean) => string,
): Promise<string> {
  const client = await p.connect();
  try {
    await client.query("begin");
    await lockPath(client, who.team, rel);
    let docId: string | null = null;
    if (page.current) {
      const row = await rowHeld(client, who.team, rel);
      const held = row ? Number(row.own_generation ?? row.content_generation) : -1;
      if (!row || row.current_revision !== page.current.revision || held !== page.current.generation) {
        await client.query("rollback");
        const now = row ? contentRevision(row.id, held) : "nothing";
        return `ERROR: ${rel} changed while it was being presented — it is at content revision ${now} now, not ` +
          `${page.target}. Nothing was recorded; present it again.`;
      }
      if (row.own_generation == null) await stampGeneration(client, row.id, page.current.revision);
      docId = row.id;
    }
    const prior = page.context ? await pagesOf(client, who, rel, page.context) : [];
    const covered = !!page.context && !!page.target && coverageOf([...prior, page]).includes(page.target);
    const said = compose(covered);
    const whole = page.start === 0 && page.end === page.total;
    const recorded = await insertEvent(client, {
      actor: who.email, team: who.team, initiative: splitStorePath(rel).initiative,
      kind: whole ? "document.shown" : "document.shown_part", subject: rel,
      detail: { user: who.email, action: whole ? "shown" : "shown_part", path: rel, version: String(page.version),
                revision: page.revision, ...(page.context ? { review_context: page.context } : {}),
                target: page.target, baseline: page.baseline,
                kind: page.kind, start: page.start, end: page.end, total: page.total, credential: who.credential,
                client: who.client, ...(page.via ? { via: page.via } : {}), text_chars: said.length,
                meta_bytes: page.meta_bytes },
    });
    if (!recorded.ok) throw new Error(recorded.error);
    if (covered && page.current && docId) await recordPresented(client, docId, page.current.revision);
    await client.query("commit");
    return said;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    return `ERROR: the presentation of ${rel} could not be recorded (${err instanceof Error ? err.message : String(err)}) ` +
      "— nothing counts as presented; present it again.";
  } finally {
    client.release();
  }
}
