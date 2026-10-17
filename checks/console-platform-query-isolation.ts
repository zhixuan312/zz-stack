/**
 * checks/console-platform-query-isolation.ts — the isolation harness's round of the Platform prepared query, which
 * `checks/console-isolation.ts` runs on its own seeded database, zz-core and gateway once its other rounds are done.
 * Not a check of its own: it is listed among the helpers that are not (AC-1.14, AC-4.4).
 *
 * What the round establishes, for the first team's member: every measure the route answers a member, read from its
 * own refusals so one added later is asked without editing this file, by every dimension and bucket it allows but the
 * superadmin's, over every day from the first recorded one, against the window before, plainly, with the second team
 * named and the platform asked for, which answers as plainly, and with a where filter on the second team; every group drilled to its rows where the measure is drilled, and its rows
 * asked with no group; each answer holds none of the second team's sentinels and no link. A measure only the
 * superadmin is shown, a team as a dimension or a where filter, and the questions searches asked are each answered the one
 * body Teams answers a member, naming nobody.
 */
import type { Isolation } from "../scripts/schema/isolation-seed.ts";

import { hrefs, leaks, send, tally, type Answer, type Sent } from "./console-isolation-work.ts";

export const PLATFORM_QUERY = "/api/console/platform/query";
const BUCKETS = ["day", "week", "month", "weekday"];

/** The window every question here is asked over: every day from the first recorded one through tomorrow. */
const everything = (): string => `from=0001-01-01&to=${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}`;

/** The question the harness's failure round sends: one that reaches a read. */
export const platformFailureQuery = (): string => `?measure=calls&by=tool&${everything()}`;

export interface Round { s: Isolation; base: string; found: string[]; pass: (line: string) => void }

export async function platformQueryRound(c: Round): Promise<void> {
  const { s } = c;
  const cookie = s.cookies.one;
  const bad: string[] = [];
  const statuses: number[] = [];
  const ask = async (url: string): Promise<Answer> => {
    const req: Sent = { method: "get", url, body: null };
    const a = await send(c.base, cookie, req);
    statuses.push(a.status);
    for (const l of leaks(s, req, a)) bad.push(`the ${l.field} sentinel in ${url} at ${l.at}`);
    for (const set of hrefs(a.text).set) bad.push(`a link in ${url}: ${set}`);
    return a;
  };
  const error = (a: Answer): string => (a.status === 400 ? String((JSON.parse(a.text) as { error: string }).error) : "");

  const named = /^measure must be one of (.+)$/.exec(error(await ask(PLATFORM_QUERY)))?.[1].split(", ") ?? [];
  if (named.length < 10) bad.push(`${PLATFORM_QUERY} named ${named.length} measures in its refusal`);
  const refusedBodies = new Set<string>();
  let asked = 0;
  for (const measure of named) {
    const first = await ask(`${PLATFORM_QUERY}?measure=${measure}&by=nothing`);
    if (first.status === 403) { refusedBodies.add(`${first.status} ${first.text}`); continue; }
    const sentence = error(first);
    const dims = /grouped by one of (.+?), or a bucket/.exec(sentence)?.[1].split(", ") ?? /grouped by (?!a bucket)(.+)$/.exec(sentence)?.[1].split(", ") ?? [];
    const bys = [...dims, ...(sentence.includes("a bucket") ? BUCKETS : [])];
    for (const by of bys) {
      const theirs = `&where=${encodeURIComponent(`team=${s.two.slug}`)}`;
      for (const forged of ["", `&team=${s.two.slug}&scope=platform`, theirs]) {
        const url = `${PLATFORM_QUERY}?measure=${measure}&by=${by}&${everything()}${measure === "teams" || measure === "people" ? "" : "&compare=previous"}${forged}`;
        const a = await ask(url);
        asked++;
        if (forged === theirs || by === "team") {
          if (a.status !== 403) bad.push(`${url} answered ${a.status}, not refused`);
          else refusedBodies.add(`${a.status} ${a.text}`);
          continue;
        }
        if (a.status !== 200) { bad.push(`${url} answered ${a.status}: ${a.text.slice(0, 200)}`); continue; }
        if (forged) continue;
        const q = JSON.parse(a.text) as { groups: { key: string | null; value: { value: number | null } }[] };
        for (const g of q.groups.filter((x) => (x.value.value ?? 0) > 0)) {
          const drilled = await ask(`${url}&group=${encodeURIComponent(g.key ?? "")}&limit=20`);
          if (drilled.status === 403) refusedBodies.add(`${drilled.status} ${drilled.text}`);
          else if (drilled.status !== 200 && !/not drilled/.test(error(drilled))) bad.push(`${url} drilled to ${g.key} answered ${drilled.status}: ${drilled.text.slice(0, 200)}`);
        }
      }
    }
    await ask(`${PLATFORM_QUERY}?measure=${measure}&${everything()}&rows=20`);
  }
  const [body] = refusedBodies;
  const names = [s.one.slug, s.two.slug, s.one.email, s.two.email, s.both, s.superadmin];
  if (refusedBodies.size !== 1 || !body.startsWith("403 ") || names.some((n) => body.includes(n))) {
    bad.push(`the member's refusals answered ${[...refusedBodies].join(" | ").slice(0, 400)}`);
  }
  if (bad.length) c.found.push(...bad.map((b) => `the first team's member, the platform query: ${b}`));
  else c.pass(`the first team's member asked ${PLATFORM_QUERY} ${named.length} measures by ${asked} dimensions and buckets, plainly and ` +
    `forged, every group drilled, answered ${tally(statuses)}, none holding the second team's words or a link, every refusal ${body}`);
}
