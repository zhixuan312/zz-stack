#!/usr/bin/env node
/**
 * The pages a person sees while a client connects escape what they are given, load nothing, and
 * wear the console's mark.
 *
 * The refusal page once printed the `resource` a request named straight into its HTML, so a link
 * carrying `resource=<img onerror=…>` ran script on the gateway's origin. Every page now goes
 * through `oauth-page.ts`, whose `html` tag escapes each value it interpolates.
 *
 * Driven, then read:
 *   1. hostile values in every field of the consent page and the refusal page come out escaped,
 *      and a hidden input's value cannot close its attribute;
 *   2. the rendered pages request nothing — no URL in a src, an href or a stylesheet;
 *   3. `mcp-oauth.ts` builds no HTML of its own: a second builder is a page that can skip the
 *      escaping;
 *   4. the gateway's wordmark is byte-identical to the one the document panel ships, which
 *      checks/document-panel.ts holds to the console's own.
 *
 * Run: node checks/consent-page.ts   (also run by scripts/gate.ts)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const { consentHtml, refusalPage } = await import(
  pathToFileURL(join(process.cwd(), "services/gateway/dist/oauth-page.js")).href);

const EVIL = `"><script>alert(1)</script><img src=x onerror=alert(2)>`;
const consent: string = consentHtml({
  client: EVIL, door: EVIL, email: EVIL, admin: false, dest: EVIL, hidden: { state: EVIL, resource: EVIL },
});
const refusal: string = refusalPage(400, EVIL, `'${EVIL}' is not one of this platform's MCP doors.`);

for (const [name, page] of [["consent", consent], ["refusal", refusal]] as const) {
  is(!/<script>alert/.test(page), `the ${name} page carries a caller's <script> unescaped`);
  is(!/<img src=x/.test(page), `the ${name} page carries a caller's <img> unescaped`);
  is(/&lt;script&gt;/.test(page), `the ${name} page dropped the hostile value instead of escaping it`);
  // Nothing loaded from anywhere: the page is the request.
  is(!/(src|href)="https?:/i.test(page) && !/url\(\s*['"]?https?:/i.test(page) && !/@import/i.test(page),
     `the ${name} page requests something from the network`);
}
is(/value="&quot;&gt;&lt;script&gt;/.test(consent), "a hidden input's value is not attribute-escaped");
is(/<form method="post" action="\/oauth\/authorize">/.test(consent), "the consent form no longer posts to /oauth/authorize");

const src = readFileSync(join(process.cwd(), "services/gateway/src/mcp-oauth.ts"), "utf8");
is(!/<!doctype|<body|<h1|<form/i.test(src), "mcp-oauth.ts builds HTML itself; every page goes through oauth-page.ts");

const mine = readFileSync(join(process.cwd(), "services/gateway/assets/wordmark.png"));
const panel = readFileSync(join(process.cwd(), "services/zz-core/app/brand/wordmark.png"));
is(mine.equals(panel), "services/gateway/assets/wordmark.png is not the panel's (and so the console's) wordmark");

if (fail.length) {
  for (const f of fail) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("PASS the connection pages escape every value, load nothing, and carry the console's mark");
