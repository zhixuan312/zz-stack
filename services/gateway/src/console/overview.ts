/**
 * Who is looking, what the platform has been doing, and who is on it.
 *
 * `/me` is the ONE route here not behind `ok()`: it answers 200 even to a caller the console
 * will refuse everywhere else, with `mayRead: false`, so the front end can render "you are
 * signed in and this view is not for you" rather than a bare 403 that reads as a broken
 * login.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import { isSuper } from "../identity.js";
import { readMetrics } from "./overview-metrics.js";
import { ZZ_TZ, grainForSpan, handler, mayReadConsole, periodCutoff } from "./shared.js";

export function mountOverview(app: Express): void {
  /** Who is looking, and whether the console will answer them at all.
   *
   * Answers 200 even for a caller it will refuse everywhere else, with
   * `mayRead: false`, so the front end can render "you are signed in, and this
   * view is not for you" instead of a bare 403 that looks like a broken login.
   * It is the ONE endpoint here that is not behind `ok()` — and it returns
   * nothing but the caller's own identity. */
  app.get("/api/console/me", (req, res) => {
    const id = req.zzIdentity;
    if (!id) { res.status(401).json({ error: "authentication required" }); return; }
    res.json({
      email: id.email, name: id.displayName, role: id.platformRole,
      mayRead: mayReadConsole(id), superadmin: isSuper(id), via: id.via,
      // `id.teams` already carries `{ slug, role }` — mapping it down to slugs threw the
      // role away, so the browser could not tell a team admin from a member. Pass it through.
      teams: id.teams, activeTeam: id.activeTeam,
    });
  });

  /** The landing page in one shape: the counts it leads with, the daily event series
   * behind its chart, and the refusals worth acting on — for the fleet, or for one team.
   *
   * IT USED TO BE `teamless`, AND THAT WAS WRONG. The header here claimed "a team scope
   * and a platform scope see the identical response", which was true and was the bug: a
   * member signing in got the whole fleet's census on the first screen of the console —
   * how many teams exist, every team's documents, 43,318 events across every team — on a
   * route that never resolved a scope, so the mode switch could not touch it. `teamless`
   * is for a catalog with no team dimension at all (blocks, the skills library); a census
   * of the platform's work has a team dimension in every row, and answering it the same
   * way for everybody is the "null means every team" wildcard that scope.ts exists to rule
   * out, just spelled as a missing predicate rather than a permissive one.
   *
   * TWO COMPLETE STATEMENTS PER QUERY, not one assembled from `scope` — see /activity;
   * `check:sql` can only PREPARE a literal it can read whole.
   *
   * WHAT A TEAM SCOPE'S NUMBERS MEAN. `teams` is 1 and `superadmins` counts only those in
   * the team, because both are answers about the team rather than about the platform, and
   * the console drops the tiles that carry them in team mode rather than showing a person
   * a "Teams: 1" that tells them nothing. `unattributedEvents` is 0 by construction: the
   * team branch reaches zz.event through `team_id`, so an event with no team cannot be in
   * the set being counted — it is not a suppressed number, it is an empty one.
   *
   * EVENTS ARE JOINED THROUGH team_id, never the denormalised `team_slug` beside it —
   * same reasoning as /activity's own note: the copy is written only by acts that belong
   * to a team, so filtering on it silently changes what "the team's events" means.
   */
  app.get("/api/console/overview", handler("the overview", async (req, res, scope) => {
    // ONE cutoff for all five statements — see periodCutoff for why it is not five
    // separate `now()`s.
    const db = platformDb();
    const since = periodCutoff(req);
    // THE WINDOW BEFORE THIS ONE, of equal length, so every tile can say what it was
    // rather than only what it is. Null for all time — there is no previous all time, and
    // a tile with nothing to compare against draws no arrow at all.
    const prevSince = since ? new Date(since.getTime() - (Date.now() - since.getTime())) : null;
    // MEASURED BEFORE THE REST, because it decides the shape of one of them. One indexed
    // min/max over the same rows the trend will group, so the grain is chosen from the
    // series that is about to be drawn rather than from the window somebody asked for —
    // see grainForSpan. Two statements for the same reason every other query here has
    // two: check:sql PREPAREs literals, and the team branch must name its scope.
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
      // One statement, and deliberately NOT joined to zz.event: an initiative is
      // counted by (team_slug, initiative) over zz.doc, and mixing that into a
      // statement that also reads the event log puts a team column and the event
      // table in one query — which is the shape that has produced per-team counts
      // built from rows that carry no team. The event totals are their own query
      // below, keyed by nothing.
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
        // `unattributed` because the per-team rows CANNOT sum to this total and a
        // reader who adds them up should be told why rather than left to find the
        // gap. Turns, tool calls made outside a team, and admin acts that belong to
        // a person are all teamless by design — see the activity endpoint.
        `select count(*) as events,
                count(*) filter (where ok = false) as failures,
                count(*) filter (where team_id is null) as unattributed
           from zz.event
          where ($1::timestamptz is null or ts >= $1)`,
        [since]),
      db.query<{ bucket: string; inside: string; outside: string; refused: string }>(
        /* TOOL CALLS, SPLIT THREE WAYS THAT ARE DISJOINT AND SUM TO THE TOTAL — so the
         * chart can stack them and the stack height is the real number of calls.
         *
         * This used to be every EVENT with a failure line over it, which put bulk imports
         * and admin acts in the same series as somebody working and made the chart's
         * biggest feature an archive load. Tool calls are the thing an operator acts on.
         *
         * `ok is not false`, not `ok = true`: a tool call whose `ok` was never written
         * recorded no refusal, and calling it refused would invent one. It is placed by
         * its run instead, like any other call that did not fail.
         *
         * AN INSTANT, not a pre-formatted local string — the rule this file states above
         * and which an HOUR bucket is the first thing here to actually depend on. A bare
         * `15:00` rendered from the database's own timezone is 23:00 to the reader in
         * Singapore this platform is deployed for: eight hours wrong, on every bucket,
         * with nothing on screen saying which zone it is. The browser formats it. */
        /* EVERY BUCKET IN THE WINDOW, INCLUDING THE EMPTY ONES. Grouping the events alone
         * emits no row for a quiet hour, and a chart that draws thirteen unevenly spaced
         * buckets at even intervals states a shape the data does not have. Measured here:
         * a 24-hour window returned 13 rows, and eleven hours of silence would have been
         * drawn as no time at all. An hour with no tool calls is a real zero. */
        /* CUT ON THE DEPLOYMENT'S CALENDAR, not on UTC's — see `ZZ_TZ`. `slot.b` is a local
         * wall-clock timestamp, so it is turned back into an INSTANT before it is written
         * out: the browser still receives an instant and still formats it, which is the
         * rule this file states above. Only the boundary moved. */
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
          group by 1 order by 1`,
        [since, grain, ZZ_TZ]),
      db.query<{ kind: string; n: string; failed: string }>(
        `select kind, count(*) as n, count(*) filter (where ok = false) as failed
           from zz.event
          where ($1::timestamptz is null or ts >= $1)
          group by 1 order by count(*) desc`,
        [since]),
      /* REFUSALS, ON TWO AXES, OVER THE SAME POPULATION THE REFUSAL RATE TILE COUNTS.
       *
       * `kind='tool_call'`, which the old statement did not say — it took every failed
       * event of any kind, so this panel's total and the tile's total were two different
       * numbers wearing one word. If the panel says 191 and the tile says 191 they have
       * to be the same 191.
       *
       * WHICH TOOL and WHICH MESSAGE are different questions and neither answers the
       * other: one tool refusing for nine reasons is a surface problem, and nine tools
       * refusing with one message is a single bug. The panel offers both. */
      db.query<{ tool: string; n: string }>(
        `select subject as tool, count(*) as n
           from zz.event
          where kind='tool_call' and ok = false and subject <> ''
            and ($1::timestamptz is null or ts >= $1)
          group by 1 order by count(*) desc limit 12`,
        [since]),
      db.query<{ message: string; tool: string; tools: string; n: string }>(
        `select refusal as message, min(subject) as tool,
                count(distinct subject) as tools, count(*) as n
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
        // `0 as unattributed` is arithmetic, not a decision: this set is reached THROUGH
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
      db.query<{ kind: string; n: string; failed: string }>(
        `select e.kind, count(*) as n, count(*) filter (where e.ok = false) as failed
           from zz.event e join zz.team t on t.id = e.team_id
          where t.slug = $1
            and ($2::timestamptz is null or e.ts >= $2)
          group by 1 order by count(*) desc`,
        [scope.slug, since]),
      db.query<{ tool: string; n: string }>(
        `select e.subject as tool, count(*) as n
           from zz.event e join zz.team t on t.id = e.team_id
          where e.kind='tool_call' and t.slug = $1 and e.ok = false and e.subject <> ''
            and ($2::timestamptz is null or e.ts >= $2)
          group by 1 order by count(*) desc limit 12`,
        [scope.slug, since]),
      db.query<{ message: string; tool: string; tools: string; n: string }>(
        `select e.refusal as message, min(e.subject) as tool,
                count(distinct e.subject) as tools, count(*) as n
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
      /* THE ZONE THE BUCKETS WERE CUT IN, so the browser renders them on the same calendar
       * rather than on the viewer's. A laptop in another country would otherwise label a
       * Singapore day with its own, and the bars and their labels would disagree. */
      timezone: ZZ_TZ,
      toolTrend: toolTrend.rows.map((r) => ({
        bucket: r.bucket, inside: +r.inside, outside: +r.outside, refused: +r.refused,
      })),
      eventKinds: kinds.rows.map((r) => ({ kind: r.kind, n: +r.n, failed: +r.failed })),
      refusals: {
        /* THE TOTAL IS SUMMED FROM THE TREND, not counted a third time. It is the same
         * predicate as the trend's `refused` over the same window, so a separate
         * statement could only ever agree with it or reveal a bug in one of them —
         * and the panel's total has to equal the tile's. */
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
    // `failed=1` rather than a tri-state string: the only question anybody asks
    // of this log is "show me what broke", and a param that can also mean
    // "show me what worked" is one nobody has needed.
    const failedOnly = req.query.failed === "1";
    // THROUGH team_id, not the team_slug column beside it. zz.event carries both,
    // and the denormalised copy is written only by the acts that belong to a team —
    // so reading it makes every person-level act (a token issued, a package
    // downloaded) look like a row whose team went missing, rather than one that
    // never had a team. The join says the true thing: `team` is null because there
    // is no team, and the console renders that as "—" rather than as a gap.
    //
    // DELETED, not guarded: `($2::text is null or t.slug = $2)` treated an absent
    // `?team=` as "match every team's events" — the same wildcard shape as /initiatives.
    // A team scope always names its own slug; only a platform scope may see every team's
    // activity, which is what an unfiltered request actually returned before this.
    //
    // TWO COMPLETE STATEMENTS, not one assembled from `scope` — see the note in
    // /api/console/initiatives above; `check:sql` can only PREPARE a literal it can read
    // whole. The team branch's predicate is numbered `$4`, after the three fixed
    // parameters both branches share, rather than renumbering the shared ones.
    const { rows } = scope.kind === "platform"
      ? await db.query(
      `select to_char(e.ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as ts, e.actor, t.slug as team, e.kind,
              e.subject, e.initiative, e.step, e.block, e.ok, e.refusal
         from zz.event e
         left join zz.team t on t.id = e.team_id
        where ($1::text is null or e.kind = $1)
          and ($2::boolean is false or e.ok = false)
        order by e.ts desc limit $3`,
      [kind, failedOnly, limit])
      : await db.query(
      `select to_char(e.ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as ts, e.actor, t.slug as team, e.kind,
              e.subject, e.initiative, e.step, e.block, e.ok, e.refusal
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
    // EVERY PERSON ON THE PLATFORM — their team memberships, their token state, their
    // — is exactly the directory-wide view a team scope must not see
    // whole: two colleagues in one department have no standing to read another
    // department's roster just because both signed in through the same the identity provider gateway.
    // A team scope narrows this to people who are members of the caller's own team;
    // only a platform scope keeps today's whole-platform directory.
    //
    // TWO COMPLETE STATEMENTS, not one assembled from `scope` — see the note in
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
                where pt.principal_id = p.id)                                  as last_used,
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
                where pt.principal_id = p.id)                                  as last_used,
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
