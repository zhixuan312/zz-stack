#!/usr/bin/env node
/**
 * Dynamic Client Registration takes a loopback redirect by name as well as by address.
 *
 * Claude Code registers `http://localhost:<port>/callback` and nothing else. The gateway refused
 * the name — "uses the name 'localhost'. Use 127.0.0.1" — so a client with no token fell back to
 * OAuth and that failed too, before anybody was asked to sign in. `localhost` is a loopback
 * redirect now, the same as 127.0.0.1 and [::1], on any port (RFC 8252 §7.3, §8.3), and nothing
 * else about the rule widens. Driven against the built `redirectAllowed`, which is all of
 * /oauth/register's decision about a redirect:
 *
 *   1. localhost, 127.0.0.1 and [::1] are allowed, with a port, without one, over http or https;
 *   2. a name that only contains `localhost`, another scheme, and an origin nobody configured are
 *      refused, and a configured origin is allowed.
 *
 * Run: node checks/oauth-redirect-loopback.ts   (needs a built tree: `npm run build`)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Read when the module loads, so set before the import.
process.env.OAUTH_REDIRECT_ORIGINS = "https://chatgpt.com";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const { redirectAllowed } = await import(
  pathToFileURL(join(process.cwd(), "services/gateway/dist/mcp-oauth.js")).href);
is(typeof redirectAllowed === "function", "mcp-oauth.js does not export redirectAllowed");
const ok = (uri: string): boolean => typeof redirectAllowed === "function" && redirectAllowed(uri).ok === true;

// 1. Loopback, by name or by address
for (const uri of ["http://localhost:42225/callback", "http://localhost/callback", "https://localhost:1/x",
                   "http://127.0.0.1:1455/callback", "http://[::1]:8080/cb"]) {
  is(ok(uri), `${uri} is refused, and it is a loopback redirect`);
}

// 2. Nothing else
for (const uri of ["http://localhost.evil.example/callback", "http://evil.localhost/callback", "ftp://localhost/x",
                   "https://claude.ai/api/mcp/auth_callback", "http://10.0.0.5/callback", "not a url"]) {
  is(!ok(uri), `${uri} is allowed, and it is neither loopback nor a configured origin`);
}
is(ok("https://chatgpt.com/connector_platform_oauth_redirect"), "a configured origin is refused");

if (fail.length) {
  for (const f of fail) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("PASS a loopback redirect is allowed by name or by address, and nothing else widened");
