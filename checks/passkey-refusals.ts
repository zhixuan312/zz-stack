#!/usr/bin/env node
/**
 * checks/passkey-refusals.ts — a registration that fails tells the person their enrolment link is
 * used up, never to open it again; a sign-in that fails quotes no verifier internals.
 *
 *   node checks/passkey-refusals.ts   # needs Docker and a built tree (`npm run build`)
 *
 * The enrolment token is spent when the ceremony starts (`register/options`), and `register/verify`
 * takes the ceremony whatever it answers. So every refusal from verify leaves the person needing a
 * new link, and the console's /enrol page shows the gateway's sentence as it is. A runtime pass found
 * two that sent them the wrong way: an expired ceremony said "Open your enrolment link again", which
 * the spent link then refuses, and a verify carrying no credential said the verifier library's own
 * "Cannot destructure property 'id' of 'response'". It starts a throwaway PostgreSQL and a real
 * zz-core (`withThrowawayCore`) and the gateway's own routes (`listenGateway`), and establishes:
 *
 *   - each failed verify (no ceremony cookie, no credential, a credential for another challenge)
 *     says the link is used up and to ask for a new one, and quotes none of the verifier's own words
 *     (a challenge, a field name), which go to the gateway's log;
 *   - the link then really is spent: register/options refuses it;
 *   - a fresh link still registers;
 *   - a sign-in answering another challenge is refused in a sentence of the gateway's own, as the
 *     registration's is, and the same key then signs in;
 *   - a `next` that would leave the site — another origin, `/` then a tab or a newline the URL
 *     parser strips, or a dot segment it consumes before a second slash (`/.//host`, `/x/..//host`),
 *     which leaves a path a browser reads as another host — is stored as `/`, and the sign-in
 *     answers `/`; a path on the site is kept.
 */
import { randomBytes } from "node:crypto";

import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";
import { authenticator, headersOf, listenGateway, type Gateway } from "../scripts/schema/throwaway-gateway.ts";

const NAME = "passkey-refusals";
const DONE = "passkey-refusals: every failed registration says its enrolment link is used up and to ask for " +
  "a new one, the link is then refused, a fresh link registers, a failed sign-in quotes no verifier internals, " +
  "and a next that leaves the site is kept as /: ok";

/** `next` values that resolve to another host, and one on the site that must be kept as it was sent. */
const OFF_SITE = ["/\t/evil.example", "/\n/evil.example", "https://evil.example/x",
  "/.//evil.example", "/x/..//evil.example", "/%2e//evil.example"];
const ON_SITE = "/console/home?tab=a#b";

/** The words every failed verify must carry, and the ones none may. */
const SPENT = /enrolment link is used up: ask an administrator for a new one\.$/;
const WRONG_WAY = /open your enrolment link again|destructure|undefined|challenge|expected/i;

async function post(g: Gateway, path: string, body: unknown, cookie?: string) {
  const res = await fetch(`${g.url}${path}`, {
    method: "POST", headers: headersOf(null, cookie ? { cookie } : {}), body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const ceremony = res.headers.getSetCookie().map((s) => s.split(";")[0]).find((s) => /^zz_ceremony=./.test(s));
  return { status: res.status, body: (await res.json()) as { error?: string; challenge?: string; next?: string }, ceremony };
}

async function run(c: Core): Promise<void> {
  const g = await listenGateway(c);
  try {
    const person = (await c.sql.query<{ id: string }>(
      "insert into zz.principal (email, display_name) values ($1, $2) returning id::text as id",
      ["enrol-refusals@example.test", "Enrol Refusals"])).rows[0].id;
    const link = async () => new URL((await g.enrol(person)).url).hash.replace(/^#t=/, "");
    const begin = async (step: string) => {
      const token = await link();
      const begun = await post(g, "/auth/passkey/register/options", { token });
      if (begun.status !== 200 || !begun.ceremony || !begun.body.challenge) {
        c.fail(step, `register/options answered ${begun.status}: ${JSON.stringify(begun.body)}`);
      }
      return { token, ceremony: begun.ceremony!, challenge: begun.body.challenge! };
    };

    const cases: [string, (b: Awaited<ReturnType<typeof begin>>) => Promise<Awaited<ReturnType<typeof post>>>][] = [
      ["a verify with no ceremony cookie", (b) => post(g, "/auth/passkey/register/verify",
        { credential: authenticator().create(b.challenge) })],
      ["a verify carrying no credential", (b) => post(g, "/auth/passkey/register/verify", {}, b.ceremony)],
      ["a verify answering another challenge", (b) => post(g, "/auth/passkey/register/verify",
        { credential: authenticator().create(randomBytes(32).toString("base64url")) }, b.ceremony)],
    ];
    for (const [step, verify] of cases) {
      const b = await begin(step);
      const answered = await verify(b);
      const said = answered.body.error ?? "";
      if (answered.status !== 400 || !SPENT.test(said) || WRONG_WAY.test(said)) {
        c.fail(step, `answered ${answered.status}: ${JSON.stringify(said)}`);
      }
      const again = await post(g, "/auth/passkey/register/options", { token: b.token });
      if (again.status !== 400) c.fail(step, `the link opened again after the failure: ${again.status}`);
      c.pass(`${step}: "${said}", and the link is then refused`);
    }

    let step = "a fresh link registers";
    const b = await begin(step);
    const key = authenticator();
    const done = await post(g, "/auth/passkey/register/verify", { credential: key.create(b.challenge) }, b.ceremony);
    if (done.status !== 200) c.fail(step, `answered ${done.status}: ${JSON.stringify(done.body)}`);
    c.pass(step);

    step = "a sign-in answering another challenge";
    const asked = await post(g, "/auth/passkey/login/options", {});
    const wrong = await post(g, "/auth/passkey/login/verify",
      { credential: key.get(randomBytes(32).toString("base64url"), person) }, asked.ceremony);
    if (wrong.status !== 401 || !/^[A-Z].*\.( Try again\.)?$/.test(wrong.body.error ?? "") || WRONG_WAY.test(wrong.body.error ?? "")) {
      c.fail(step, `answered ${wrong.status}: ${JSON.stringify(wrong.body)}`);
    }
    const again = await post(g, "/auth/passkey/login/options", { next: OFF_SITE[0] });
    const signedIn = await post(g, "/auth/passkey/login/verify", { credential: key.get(again.body.challenge!, person) }, again.ceremony);
    if (signedIn.status !== 200) c.fail(step, `the same key then answered ${signedIn.status}: ${JSON.stringify(signedIn.body)}`);
    if (signedIn.body.next !== "/") c.fail(step, `a sign-in begun with next ${JSON.stringify(OFF_SITE[0])} answered next ${JSON.stringify(signedIn.body.next)}`);
    c.pass(`${step}: "${wrong.body.error}", and the same key then signs in, sent to / rather than off the site`);

    step = "a next that leaves the site is stored as /";
    const stored = async (next: string): Promise<string | null> => {
      const asked = await post(g, "/auth/passkey/login/options", { next });
      if (asked.status !== 200 || !asked.body.challenge) c.fail(step, `login/options with next ${JSON.stringify(next)} answered ${asked.status}`);
      return (await c.sql.query<{ redirect_to: string | null }>(
        "select redirect_to from zz.passkey_challenge where challenge = $1", [asked.body.challenge])).rows[0]?.redirect_to ?? null;
    };
    for (const next of OFF_SITE) {
      const kept = await stored(next);
      if (kept !== "/") c.fail(step, `next ${JSON.stringify(next)} was stored as ${JSON.stringify(kept)}`);
    }
    const onSite = await stored(ON_SITE);
    if (onSite !== ON_SITE) c.fail(step, `next ${JSON.stringify(ON_SITE)} on the site was stored as ${JSON.stringify(onSite)}`);
    c.pass(`${step}: ${OFF_SITE.map((n) => JSON.stringify(n)).join(", ")} each, while ${ON_SITE} is kept`);
  } finally {
    await g.stop();
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
