/**
 * Who is looking, what the platform has been doing, and who is on it.
 *
 * `/me` is the one route here not behind `ok()`: it answers 200 even to a caller the console
 * will refuse everywhere else, with `mayRead: false`, so the front end can render "you are
 * signed in and this view is not for you" rather than a bare 403 that reads as a broken login.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import { isSuper } from "../identity.js";
import { readMetrics } from "./overview-metrics.js";
import { ZZ_TZ, grainForSpan, handler, mayReadConsole, periodCutoff } from "./shared.js";

export function mountOverview(app: Express): void {
  /** Who is looking, and whether the console will answer them at all. Returns nothing but the
   *  caller's own identity. */
  app.get("/api/console/me", (req, res) => {
    const id = req.zzIdentity;
    if (!id) { res.status(401).json({ error: "authentication required" }); return; }
    res.json({
      email: id.email, name: id.displayName, role: id.platformRole,
      mayRead: mayReadConsole(id), superadmin: isSuper(id), via: id.via,
      // The sentence, not just the verdict: `ok()` names its refusals — "the console needs a
      // browser sign-in — x@y authenticated by pat" — and that sentence is the diagnosis. This
      // route answers 200, so it carries the same wording from the same two facts.
      ...(mayReadConsole(id) ? {} : {
        why: `the console needs a browser sign-in — ${id.email} authenticated by ${id.via}`,
      }),
      // `id.teams` already carries `{ slug, role }`; mapping it down to slugs would throw the
      // role away and the browser could not tell a team admin from a member.
      teams: id.teams, activeTeam: id.activeTeam,
    });
  });

  /** The landing page in one shape: the counts it leads with, the daily event series
   * behind its chart, and the refusals worth acting on — for the fleet, or for one team.
   *
   * DELIBERATE: `handler`, not `teamless`. `teamless` is for a catalog with no team dimension
   * at all; a census of the platform's work has a team dimension in every row, and answering it
   * the same way for everybody is the "null means every team" wildcard scope.ts exists to rule
   * out, spelled as a missing predicate rather than a permissive one.
   *
   * Two complete statements per query, not one assembled from `scope` — see /activity;
   * `check:sql` can only PREPARE a literal it can read whole.
   *
   * In team mode `teams` is 1 and `superadmins` counts only those in the team, because both are
   * answers about the team; the console drops the tiles that carry them. `unattributedEvents`
   * is 0 by construction — the team branch reaches zz.event through `team_id`, so an event with
   * no team cannot be in the set being counted.
   *
   * Events are joined through team_id, never the denormalised `team_slug` beside it: the copy
   * is written only by acts that belong to a team, so filtering on it silently changes what
   * "the team's events" means.
   */
  app.get("/api/console/overview", handler("the overview", async (req, res, scope) => {
    // One cutoff for all five statements — see periodCutoff for why it is not five
    // separate `now()`s.
    const db = platformDb();
    const since = periodCutoff(req);
    // The window before this one, of equal length, so every tile can say what it was rather
    // than only what it is. Null for all time — a tile with nothing to compare against draws
    // no arrow.
    const prevSince = since ? new Date(since.getTime() - (Date.now() - since.getTime())) : null;
    // Measured before the rest, because it decides the shape of one of them: one indexed
    // min/max over the same rows the trend will group, so the grain is chosen from the series
    // about to be drawn rather than from the window somebody asked for — see grainForSpan.
    const spanQ = scope.kind === "platform"
      ? await db.query<{ days: string | null }>(
        `select extract(epoch from (max(ts) - min(ts))) / 86400 as days
           from zz.event
          where ($1::timestamptz is null or ts >= $1)`,
        [since])
      : await db.query<{ days: string | null }>(
        `select extract(epoch from (max(e.ts) - min(e.ts))) / 86400 as days
           from zz.event e join zz.team t on t.id = e.team_id
          where t.slug = $1
            and ($2::timestamptz is null or e.ts >= $2)`,
        [scope.slug, since]);
    // Null when the window holds no events at all — nothing to draw, and `hour` is the
    // grain that says "very little time" rather than one that pretends to a range.
    const grain = grainForSpan(Number(spanQ.rows[0]?.days ?? 0));
    // `count(distinct (team_slug, initiative))` in the platform branch groups BY team_slug
    // to avoid double-counting an initiative that spans several documents; it is a
    // de-duplication key inside an aggregate, not a predicate. The team branch counts
    // `distinct initiative` instead — inside one team the slug is already fixed, so the
    // tuple would be the same key written twice.
    const [counts, totals, toolTrend, kinds, byTool, byMessage] = scope.kind === "platform"
      ? await Promise.all([
      // One statement, and deliberately not joined to zz.event: an initiative is counted by
      // (team_slug, initiative) over zz.doc, and mixing that into a statement that also reads
      // the event log puts a team column and the event table in one query — the shape that
      // produces per-team counts built from rows that carry no team.
      db.query<{ teams: string; active: string; people: string; supers: string;
                 docs: string; initiatives: string }>(
        `select (select count(*) from zz.team)                                as teams,
                (select count(*) from zz.team where status='active')          as active,
                (select count(*) from zz.principal)                           as people,
                (select count(*) from zz.principal where role='superadmin')   as supers,
                (select count(*) from zz.doc
                  where ($1::timestamptz is null or updated_at >= $1))        as docs,
                (select count(distinct (team_slug, initiative)) from zz.doc
                   where initiative <> '_knowledge'
                     and ($1::timestamptz is null or updated_at >= $1))       as initiatives`,
        [since]),
      db.query<{ events: string; failures: string; unattributed: string }>(
        // `unattributed` because the per-team rows cannot sum to this total. Turns, tool
        // calls made outside a team, and admin acts that belong to a person are all teamless
        // by design — see the activity endpoint.
        `select count(*) as events,
                -- Tool calls only: that is the word the reader is shown, and the refusal
                -- tile counts the same population.
                count(*) filter (where kind = 'tool_call' and ok = false) as failures,
                count(*) filter (where team_id is null) as unattributed
           from zz.event
          where ($1::timestamptz is null or ts >= $1)`,
        [since]),
      db.query<{ bucket: string; inside: string; outside: string; refused: string }>(
        /* Tool calls, split three ways that are disjoint and sum to the total, so the chart
         * can stack them and the stack height is the real number of calls.
         *
         * `ok is not false`, not `ok = true`: a tool call whose `ok` was never written
         * recorded no refusal, and calling it refused would invent one. It is placed by its
         * run instead, like any other call that did not fail.
         *
         * An instant, not a pre-formatted local string. A bare `15:00` rendered from the
         * database's own timezone is 23:00 to a reader in Singapore, on every bucket, with
         * nothing on screen saying which zone it is. The browser formats it. */
        /* Every bucket in the window, including the empty ones. Grouping the events alone
         * emits no row for a quiet hour, and a chart that draws unevenly spaced buckets at
         * even intervals states a shape the data does not have. An hour with no tool calls is
         * a real zero. */
        /* Cut on the deployment's calendar, not on UTC's — see `ZZ_TZ`. `slot.b` is a local
         * wall-clock timestamp, so it is turned back into an instant before it is written out:
         * the browser still receives an instant and still formats it. */
        `with bounds as (
           select coalesce($1::timestamptz, min(ts)) as lo, max(ts) as hi
             from zz.event where kind='tool_call'),
         slot as (
           select generate_series(date_trunc($2::text, lo at time zone $3::text),
                                  date_trunc($2::text, hi at time zone $3::text),
                                  ('1 ' || $2)::interval) as b from bounds)
         select to_char((slot.b at time zone $3::text) at time zone 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS"Z"') as bucket,
                count(*) filter (where e.id is not null and e.ok is not false and e.run_id is not null) as inside,
                count(*) filter (where e.id is not null and e.ok is not false and e.run_id is null)     as outside,
                count(*) filter (where e.ok = false)                                                   as refused
           from slot left join zz.event e
             on date_trunc($2::text, e.ts at time zone $3::text) = slot.b and e.kind='tool_call'
             -- And inside the window: generate_series starts at date_trunc(grain, since), earlier
             -- than since, so without this the first bucket would count events from before the window
             -- opens and the panel would not sum to the tile beside it.
             and ($1::timestamptz is null or e.ts >= $1)
          group by 1 order by 1`,
        [since, grain, ZZ_TZ]),
      db.query<{ kind: string; n: string }>(
        `select kind, count(*) as n
           from zz.event
          where ($1::timestamptz is null or ts >= $1)
          group by 1 order by count(*) desc`,
        [since]),
      /* Refusals, on two axes, over the same population the refusal rate tile counts:
       * `kind='tool_call'`, so the panel's total and the tile's total are the same number.
       *
       * Which tool and which message are different questions and neither answers the other:
       * one tool refusing for nine reasons is a surface problem, nine tools refusing with one
       * message is a single bug. The panel offers both. */
      db.query<{ tool: string; n: string }>(
        `-- Through tool_key, not subject: tool_key is the alias-resolved name, so a renamed
        -- tool folds onto one series. coalesce covers a row with no tool_key.
        select coalesce(tool_key, subject) as tool, count(*) as n
           from zz.event
          where kind='tool_call' and ok = false and coalesce(tool_key, subject) <> ''
            and ($1::timestamptz is null or ts >= $1)
          group by 1 order by count(*) desc limit 12`,
        [since]),
      db.query<{ message: string; tool: string; tools: string; n: string }>(
        `select refusal as message, min(coalesce(tool_key, subject)) as tool,
                count(distinct coalesce(tool_key, subject)) as tools, count(*) as n
           from zz.event
          where kind='tool_call' and ok = false and refusal is not null
            and ($1::timestamptz is null or ts >= $1)
          group by 1 order by count(*) desc limit 12`,
        [since]),
    ])
      : await Promise.all([
      db.query<{ teams: string; active: string; people: string; supers: string;
                 docs: string; initiatives: string }>(
        // `teams` is the literal 1 — the caller's own — rather than a count over zz.team,
        // which would be the platform's answer to a question asked about one team.
        `select 1                                                             as teams,
                (select count(*) from zz.team
                  where slug = $1 and status='active')                        as active,
                (select count(*) from zz.membership m
                   join zz.team t on t.id = m.team_id
                  where t.slug = $1)                                          as people,
                (select count(*) from zz.membership m
                   join zz.team t on t.id = m.team_id
                   join zz.principal p on p.id = m.principal_id
                  where t.slug = $1 and p.role='superadmin')                  as supers,
                (select count(*) from zz.doc
                  where team_slug = $1
                    and ($2::timestamptz is null or updated_at >= $2))        as docs,
                (select count(distinct initiative) from zz.doc
                  where team_slug = $1 and initiative <> '_knowledge'
                    and ($2::timestamptz is null or updated_at >= $2))        as initiatives`,
        [scope.slug, since]),
      db.query<{ events: string; failures: string; unattributed: string }>(
        // `0 as unattributed` is arithmetic, not a decision: this set is reached through
        // team_id, so every row in it has a team and none can be unattributed.
        `select count(*) as events,
                count(*) filter (where e.ok = false) as failures,
                0 as unattributed
           from zz.event e join zz.team t on t.id = e.team_id
          where t.slug = $1
            and ($2::timestamptz is null or e.ts >= $2)`,
        [scope.slug, since]),
      db.query<{ bucket: string; inside: string; outside: string; refused: string }>(
        `with bounds as (
           select coalesce($2::timestamptz, min(e.ts)) as lo, max(e.ts) as hi
             from zz.event e join zz.team t on t.id = e.team_id
            where e.kind='tool_call' and t.slug = $1),
         slot as (
           select generate_series(date_trunc($3::text, lo at time zone $4::text),
                                  date_trunc($3::text, hi at time zone $4::text),
                                  ('1 ' || $3)::interval) as b from bounds)
         select to_char((slot.b at time zone $4::text) at time zone 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS"Z"') as bucket,
                count(*) filter (where e.id is not null and e.ok is not false and e.run_id is not null) as inside,
                count(*) filter (where e.id is not null and e.ok is not false and e.run_id is null)     as outside,
                count(*) filter (where e.ok = false)                                                   as refused
           from slot
           left join zz.team t on t.slug = $1
           left join zz.event e
             on date_trunc($3::text, e.ts at time zone $4::text) = slot.b
            and e.kind='tool_call' and e.team_id = t.id
          group by 1 order by 1`,
        [scope.slug, since, grain, ZZ_TZ]),
      db.query<{ kind: string; n: string }>(
        `select e.kind, count(*) as n
           from zz.event e join zz.team t on t.id = e.team_id
          where t.slug = $1
            and ($2::timestamptz is null or e.ts >= $2)
          group by 1 order by count(*) desc`,
        [scope.slug, since]),
      db.query<{ tool: string; n: string }>(
        `select coalesce(e.tool_key, e.subject) as tool, count(*) as n
           from zz.event e join zz.team t on t.id = e.team_id
          where e.kind='tool_call' and t.slug = $1 and e.ok = false and coalesce(e.tool_key, e.subject) <> ''
            and ($2::timestamptz is null or e.ts >= $2)
          group by 1 order by count(*) desc limit 12`,
        [scope.slug, since]),
      db.query<{ message: string; tool: string; tools: string; n: string }>(
        `select e.refusal as message, min(coalesce(e.tool_key, e.subject)) as tool,
                count(distinct coalesce(e.tool_key, e.subject)) as tools, count(*) as n
           from zz.event e join zz.team t on t.id = e.team_id
          where e.kind='tool_call' and t.slug = $1 and e.ok = false and e.refusal is not null
            and ($2::timestamptz is null or e.ts >= $2)
          group by 1 order by count(*) desc limit 12`,
        [scope.slug, since]),
    ]);
    const c = counts.rows[0], t = totals.rows[0];
    // The four the page leads with. Read after the census rather than beside it: they
    // share no statement with it, and a failure in one should name itself.
    const metrics = await readMetrics(db, scope, since, prevSince);
    res.json({
      metrics,
      counts: {
        teams: +c.teams, activeTeams: +c.active, people: +c.people, superadmins: +c.supers,
        documents: +c.docs, initiatives: +c.initiatives,
        events: +t.events, failures: +t.failures,
        unattributedEvents: +t.unattributed,
      },
      grain,
      /* The zone the buckets were cut in, so the browser renders them on the same calendar
       * rather than on the viewer's. */
      timezone: ZZ_TZ,
      toolTrend: toolTrend.rows.map((r) => ({
        bucket: r.bucket, inside: +r.inside, outside: +r.outside, refused: +r.refused,
      })),
      eventKinds: kinds.rows.map((r) => ({ kind: r.kind, n: +r.n })),
      refusals: {
        /* The total is summed from the trend, not counted a third time: it is the same
         * predicate over the same window, and the panel's total has to equal the tile's. */
        total: toolTrend.rows.reduce((n, r) => n + +r.refused, 0),
        byTool: byTool.rows.map((r) => ({ tool: r.tool, n: +r.n })),
        byMessage: byMessage.rows.map((r) => ({
          message: r.message, tool: r.tool, tools: +r.tools, n: +r.n,
        })),
      },
    });
  }));

  /** The event log, filterable, newest first. The console's audit view. */
  app.get("/api/console/activity", handler("activity", async (req, res, scope) => {
    const db = platformDb();
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const kind = typeof req.query.kind === "string" ? req.query.kind : null;
    // `failed=1` rather than a tri-state string: the only question asked of this log is
    // "show me what broke".
    const failedOnly = req.query.failed === "1";
    // Through team_id, not the team_slug column beside it. zz.event carries both, and the
    // denormalised copy is written only by acts that belong to a team — reading it makes every
    // person-level act (a token issued, a package downloaded) look like a row whose team went
    // missing rather than one that never had a team. The join says the true thing: `team` is
    // null because there is no team, and the console renders that as "—".
    //
    // DELIBERATE: there is no `($2::text is null or t.slug = $2)` guard. That treated an absent
    // `?team=` as "match every team's events". A team scope always names its own slug; only a
    // platform scope may see every team's activity.
    //
    // Two complete statements, not one assembled from `scope` — see the note in
    // /api/console/initiatives above; `check:sql` can only PREPARE a literal it can read whole.
    // The team branch's predicate is numbered `$4`, after the three fixed parameters both
    // branches share.
    const { rows } = scope.kind === "platform"
      ? await db.query(
      `select to_char(e.ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as ts, e.actor, t.slug as team, e.kind,
              -- The resolved name, so a renamed tool is one name in the feed.
              coalesce(e.tool_key, e.subject) as subject,
              e.initiative, e.step, e.ok, e.refusal
         from zz.event e
         left join zz.team t on t.id = e.team_id
        where ($1::text is null or e.kind = $1)
          and ($2::boolean is false or e.ok = false)
        order by e.ts desc limit $3`,
      [kind, failedOnly, limit])
      : await db.query(
      `select to_char(e.ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as ts, e.actor, t.slug as team, e.kind,
              -- The resolved name, so a renamed tool is one name in the feed.
              coalesce(e.tool_key, e.subject) as subject,
              e.initiative, e.step, e.ok, e.refusal
         from zz.event e
         left join zz.team t on t.id = e.team_id
        where ($1::text is null or e.kind = $1)
          and ($2::boolean is false or e.ok = false)
          and t.slug = $4
        order by e.ts desc limit $3`,
      [kind, failedOnly, limit, scope.slug]);
    res.json({ events: rows, limit });
  }));

  /** People, their teams, and their tokens' state.
   *
   * Never the tokens. `zz.pat` stores a hash and this returns whether one is
   * live and when it was last used — which is what an administrator asks — and
   * nothing that could be replayed. */
  app.get("/api/console/people", handler("people", async (_req, res, scope) => {
    const db = platformDb();
    // A team scope narrows this to people who are members of the caller's own team; only a
    // platform scope sees the whole-platform directory. Two colleagues in one department have
    // no standing to read another department's roster just because both can sign in to the
    // console.
    //
    // Two complete statements, not one assembled from `scope` — see the note in
    // /api/console/initiatives above; `check:sql` can only PREPARE a literal it can read
    // whole.
    const { rows } = scope.kind === "platform"
      ? await db.query(
      `select p.email, p.display_name as name, p.role, p.status,
              to_char(p.created_at,'YYYY-MM-DD') as created,
              coalesce(t.slug,'') as active_team,
              (select coalesce(array_agg(tm.slug || ' (' || m.role || ')' order by tm.slug), '{}')
                 from zz.membership m join zz.team tm on tm.id = m.team_id
                where m.principal_id = p.id)                                   as teams,
              (select count(*) from zz.pat pt
                where pt.principal_id = p.id and pt.revoked_at is null)        as tokens,
              (select to_char(max(pt.last_used_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') from zz.pat pt
                where pt.principal_id = p.id)                                  as last_used
         from zz.principal p
         left join zz.team t on t.id = p.active_team_id
        order by p.role, p.created_at`)
      : await db.query(
      `select p.email, p.display_name as name, p.role, p.status,
              to_char(p.created_at,'YYYY-MM-DD') as created,
              coalesce(t.slug,'') as active_team,
              (select coalesce(array_agg(tm.slug || ' (' || m.role || ')' order by tm.slug), '{}')
                 from zz.membership m join zz.team tm on tm.id = m.team_id
                where m.principal_id = p.id)                                   as teams,
              (select count(*) from zz.pat pt
                where pt.principal_id = p.id and pt.revoked_at is null)        as tokens,
              (select to_char(max(pt.last_used_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') from zz.pat pt
                where pt.principal_id = p.id)                                  as last_used
         from zz.principal p
         left join zz.team t on t.id = p.active_team_id
        where exists (select 1 from zz.membership m2 join zz.team tm2 on tm2.id = m2.team_id
                       where m2.principal_id = p.id and tm2.slug = $1)
        order by p.role, p.created_at`, [scope.slug]);
    res.json({ people: rows.map((r) => ({
      ...r, tokens: +r.tokens, activeTeam: r.active_team || null,
    })) });
  }));
}
