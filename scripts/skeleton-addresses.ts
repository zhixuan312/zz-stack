/**
 * skeleton-addresses.ts — the walking skeleton's removed addresses: `/teams`, `/teams/<slug>`, `/people` and
 * `/settings` on the built console, each the missing page, for the member and for the superadmin (AC-1.12). Not a
 * script of its own: `scripts/skeleton.ts` calls `removedAddresses` once Platform's pages are drawn, so no file
 * passes the 700-line ceiling.
 *
 * What it establishes, for each person:
 *
 *   - each removed address answers 200 with the console's missing page (`data-missing-page`), no redirect;
 *   - its words are those of an address no page answers, read as the same person in each workspace and in none,
 *     so the old page is told from an unknown address by nothing a reader sees, the chrome around it included;
 *   - the member's holds none of another team's words but what its own address names.
 *
 * DELIBERATE: the status is 200, not 404, and the body the one a refusal draws (`refusal: 'absent'`), so a
 * removed address reads exactly as one never answered. `/teams/<slug>` names the isolation seed's second team,
 * a real team the superadmin could once open there. COUPLED: `data-missing-page` in
 * ../zz-stack-dashboard/src/views/no-access.tsx, and `(dash)/[...missing]`, which answers every address no page does.
 */
import { randomBytes } from "node:crypto";

import type { ConsolePage, PageContext } from "./skeleton-work.ts";

/** The console's addresses that are gone, `/teams/<slug>` for `slug`. */
const removed = (slug: string): string[] => ["/teams", `/teams/${slug}`, "/people", "/settings"];

/** What a person reads on a page, as a set of words: where Next streamed the title and the search box into the
 *  body does not tell two answers apart, and a word either holds that the other does not does. */
export const words = (p: ConsolePage): string => [...new Set(p.text.split(" "))].sort().join(" ");

/** The words of an address no page answers, in each workspace and in none, as the person whose secret is given:
 *  a page that names nothing reads as one of them. */
export const nowhere = (ctx: PageContext, secret: string): Promise<string[]> =>
  Promise.all(["/platform", "/record", ""].map(async (at) => words(await ctx.page(`${at}/${randomBytes(8).toString("hex")}`, secret))));

/** Each removed address as each reader, against that reader's own unknown address. */
export async function removedAddresses(ctx: PageContext, readers: [string, string][], slug: string): Promise<void> {
  for (const [who, email] of readers) {
    const secret = ctx.cookies.get(email)!;
    const unknown = await nowhere(ctx, secret);
    for (const path of removed(slug)) {
      const step = `the built console's removed ${path} as ${who}`;
      const p = await ctx.page(path, secret);
      const member = email === ctx.member;
      const held = member ? [...ctx.withheld, ctx.slug].filter((s) => p.body.includes(s) && !path.includes(s)) : [];
      // Next streams a redirect inside a 200 as its `NEXT_REDIRECT` marker, so the status alone cannot say there is none.
      const redirects = /NEXT_REDIRECT;/.test(p.body);
      if (p.status !== 200 || redirects || !p.body.includes("data-missing-page") || !unknown.includes(words(p)) || held.length) {
        ctx.fail(step, `answered ${p.status}${redirects ? " with a streamed redirect" : ""}${held.length ? `, holding ${held.join(", ")}` : ""}, ` +
                 `not the missing page an unknown address draws ${who}: ${p.text.slice(0, 400)}`);
      }
      ctx.pass(`${step} answers 200 with the missing page and no redirect, its words those of an address no page answers` +
               (member ? `, and none of the ${ctx.withheld.length + 1} words of another team's in its body` : ""));
    }
  }
}
