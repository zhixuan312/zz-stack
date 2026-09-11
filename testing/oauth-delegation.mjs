// The delegated-access loop, end to end against a live deployment: connect_block mints a
// consent URL, the person approves, the callback stores the grant, and a later tool call goes
// out carrying THEIR token instead of the shared key.
//
// Every check here exists because some part of it silently didn't work:
//   · the block reported `acting_as: the shared api key` while a valid grant sat in the table,
//     because fastmcp's get_http_headers() strips `authorization` and the read looked fine;
//   · delegatedToken() compared an email against a uuid column and answered nothing;
//   · the mock's 120-second tokens mean the SECOND call almost always takes the refresh path,
//     so a passing first call proves less than half of it.
//
// The baseline check is the control. Without it, "whoami names a person" could just as easily
// mean whoami always names a person. Start from a revoked grant:
//   docker compose exec -T postgres psql -U zz -d zz -c \
//     "delete from zz.block_token t using zz.principal p \
//       where p.id=t.principal_id and p.email='<you>' and t.block in ('bookit','n8n')"
//
// Usage: ZZ_URL=... ZZ_TOKEN=... node testing/oauth-delegation.mjs <block> [block ...]

const { Mcp } = await import("../packages/mcp-client/dist/index.js");

// ZZ_URL / ZZ_TOKEN — the names every other tool here uses, and the ones deploy/zz-tool
// forwards. This read ZZ_UAT_URL and ZZ_UAT_TOKEN until 2026-09-11: variables for a UAT
// deployment retired on 2026-09-10, so the script could not start at all, and said so by
// naming two environment variables nobody would think to set.
const BASE = process.env.ZZ_URL, PAT = process.env.ZZ_TOKEN;
const SUB = process.env.OAUTH_TEST_SUBJECT || "person@example.com";
// NAMED, NEVER DEFAULTED. The default was ["bookit", "n8n"] — two mock blocks that moved
// to their own repository — and `blocks.ts` ships an empty registry, so there is no block this
// platform can assume. A run with no argument would have exercised nothing and reported it as
// two failures against blocks that are not there.
const BLOCKS = process.argv.slice(2);
if (!BASE || !PAT) { console.error("set ZZ_URL and ZZ_TOKEN"); process.exit(2); }
if (!BLOCKS.length) {
  console.error("name the block(s) to drive: ./testing/oauth-delegation.mjs <block> [block...]");
  console.error("  this deployment registers blocks through PLATFORMS; there is no default.");
  process.exit(2);
}

let bad = 0;
const ok = (pass, msg) => { if (!pass) bad++; console.log(`  ${pass ? "PASS" : "FAIL"}  ${msg}`); };
const whoami = async (block) => {
  const c = new Mcp(`${BASE}/p/${block}/mcp`, { pat: PAT, client: "zz-oauth-test" });
  return JSON.parse(String(await c.call("whoami", {})));
};

for (const block of BLOCKS) {
  console.log(`\n== ${block} ==`);

  const before = await whoami(block);
  ok(before.acting_as === "the shared api key",
     `baseline: no grant, so the call uses the shared key (got "${before.acting_as}")`);
  if (before.acting_as !== "the shared api key") {
    console.log("        revoke the grant first — see the header of this file");
    continue;
  }

  const manage = new Mcp(`${BASE}/manage/mcp`, { pat: PAT, client: "zz-oauth-test" });
  const out = String(await manage.call("connect_block", { block }));
  const url = (out.match(/https?:\/\/\S*?authorize\S*/) || [])[0]?.replace(/[)"'\s]+$/, "");
  ok(!!url, "connect_block returns a consent URL");
  if (!url) { console.log("        " + out.slice(0, 300)); continue; }

  const page = await (await fetch(url)).text();
  const hidden = (n) => (page.match(new RegExp(`name=${n} value="([^"]*)"`)) || [])[1] ?? "";
  const perms = [...page.matchAll(/name="perm" value="([^"]+)"/g)].map((m) => m[1]);
  ok(perms.length > 0, `the consent screen names ${perms.length} permissions`);
  ok(!!hidden("code_challenge"), "the request carries a PKCE challenge");

  const body = new URLSearchParams({ sub: SUB, state: hidden("state"),
    redirect_uri: hidden("redirect_uri"), code_challenge: hidden("code_challenge") });
  for (const p of perms) body.append("perm", p);
  // SUBMIT WHAT THE PAGE SAYS. Building this URL by hand is how a broken form action survived
  // every green run: the page posted to a root-relative /authorize, which reaches the platform
  // rather than the block, and only a real browser ever found out. A test that constructs the
  // target is not testing the page — it is testing its own arithmetic.
  const action = (page.match(/<form[^>]*action="([^"]+)"/) || [])[1] ?? "";
  ok(/^https?:\/\//.test(action), `the form posts to an absolute address (${action || "MISSING"})`);
  const post = await fetch(new URL(action, url).toString(),
                           { method: "POST", body, redirect: "manual" });
  const loc = post.headers.get("location") || "";
  ok(post.status === 302 && loc.includes("/callback"), "approval redirects to the gateway callback");
  const cb = await fetch(loc);
  const confirmation = await cb.text();
  ok(cb.ok, `the callback accepts the code and stores the grant (HTTP ${cb.status})`);
  // The gateway learns WHO by calling the block's /userinfo. If that regresses it stores a blank
  // identity, keeps working, and every check above still passes — which is how a stale discovery
  // cache went unnoticed until a mismatch warning happened not to fire. Both bugs this session
  // were silent fallbacks; asserting on the confirmation text is what makes this one loud.
  ok(confirmation.includes(`You are ${SUB} to ${block}`),
     "the platform learned which account the block granted, and stored it");

  const after = await whoami(block);
  ok(after.acting_as === SUB, `the call now acts as the person: ${after.acting_as}`);
  ok(after.via === "delegated token", `via = ${after.via}`);
  ok(String(after.granted || "").split(" ").filter(Boolean).length === perms.length,
     `all ${perms.length} granted scopes reached the block`);

  // Refresh, actually. The token lives 120s and the gateway renews when under 60s remain, so
  // this wait has to clear that line — a 1.5s sleep sat here first and re-tested the stored
  // token under a label that said refresh. The one composition never observed end to end was
  // refresh -> whoami -> the person, which is precisely where the last bug lived.
  // REFRESH IS ONLY TESTED WHEN THE TOKEN IS SHORT-LIVED, and this says so rather than
  // pretending. The gateway renews when under a minute remains; with the blocks' production
  // lifetime of twelve hours, waiting 75 seconds crosses nothing and re-reads the stored token
  // under a label that claims a refresh. That is exactly the vacuous pass this file was written
  // to avoid. Run the blocks with OAUTH_ACCESS_TTL=120 to exercise it for real.
  const lifetime = Number((confirmation.match(/expires (\S+)/) || [])[1] &&
    (Date.parse((confirmation.match(/expires (\S+)/) || [])[1]) - Date.now()) / 1000) || 0;
  if (lifetime > 0 && lifetime < 600) {
    process.stdout.write("        (waiting 75s to cross the refresh threshold)\r");
    await new Promise((r) => setTimeout(r, 75_000));
    const again = await whoami(block);
    ok(again.acting_as === SUB,
       `after 75s the token was renewed and the call still acts as the person: ${again.acting_as}`);
  } else {
    console.log(`  UNTESTED  refresh: this token lives ${Math.round(lifetime / 3600)}h, so no wait ` +
                "this harness can afford crosses the renewal threshold. Start the block with " +
                "OAUTH_ACCESS_TTL=120 to test it.");
  }
}

console.log(bad ? `\n${bad} check(s) FAILED` : "\nall checks green");
process.exit(bad ? 1 : 0);
