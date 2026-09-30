#!/usr/bin/env node
/**
 * Every authorization response names its issuer, and the metadata promises it (RFC 9207).
 *
 * The authorize page is on the console's origin and the issuer is the gateway's. Codex refuses
 * that split — "authorization endpoint origin does not match the authorization server origin
 * without issuer-bound callbacks" — unless the metadata carries
 * `authorization_response_iss_parameter_supported` and the redirect carries `iss`. Its first
 * login against this platform stopped there, before anybody was asked to sign in.
 *
 * Driven, then read:
 *   1. the metadata the real router serves carries the flag as `true`;
 *   2. `authorizationResponse` keeps what it was given and adds `iss` equal to the issuer;
 *   3. no authorization redirect in the source is built anywhere else — a second builder is a
 *      redirect that can leave without `iss`.
 *
 * Run: node checks/oauth-issuer-bound.ts   (also run by scripts/gate.ts)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ISSUER = "https://api.issuer.test";
process.env.GATEWAY_PUBLIC_URL = ISSUER;
process.env.CONSOLE_PUBLIC_URL = "https://console.issuer.test";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const dist = (f: string) => pathToFileURL(join(process.cwd(), "services/gateway/dist", f)).href;
const { mountMcpOauth, authorizationResponse } = await import(dist("mcp-oauth.js"));
const { default: express } = await import(
  pathToFileURL(join(process.cwd(), "services/gateway/node_modules/express/index.js")).href)
  .catch(() => import("express"));

const app = express();
mountMcpOauth(app);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
try {
  const meta = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`)).json();
  is(meta.issuer === ISSUER, `the metadata's issuer is ${meta.issuer}, not ${ISSUER}`);
  is(meta.authorization_response_iss_parameter_supported === true,
     "the metadata does not promise `iss` on the authorization response");
  is(new URL(meta.authorization_endpoint).origin !== new URL(ISSUER).origin,
     "the fixture no longer splits the authorize page from the issuer, so it tests nothing");
} finally {
  server.close();
}

const code = new URL(authorizationResponse("http://127.0.0.1:1455/callback?keep=1", { code: "c1", state: "s1" }));
is(code.searchParams.get("iss") === ISSUER, `a code redirect carries iss=${code.searchParams.get("iss")}`);
is(code.searchParams.get("code") === "c1" && code.searchParams.get("state") === "s1"
   && code.searchParams.get("keep") === "1", `a code redirect lost what it was given: ${code}`);
const deny = new URL(authorizationResponse("https://chatgpt.com/connector/oauth/x", { error: "access_denied" }));
is(deny.searchParams.get("iss") === ISSUER && deny.searchParams.get("error") === "access_denied",
   `a refusal redirect is ${deny}`);

const src = readFileSync(join(process.cwd(), "services/gateway/src/mcp-oauth.ts"), "utf8");
const builders = [...src.matchAll(/searchParams\.set\(\s*["'](code|error)["']/g)];
is(builders.length === 0,
   `${builders.length} authorization redirect(s) are built outside authorizationResponse, where iss can be missed`);

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok oauth-issuer-bound");
