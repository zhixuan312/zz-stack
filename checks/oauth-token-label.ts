#!/usr/bin/env node
/**
 * Connecting one application never signs another one out.
 *
 * An OAuth-minted token is filed under a label, and minting revokes the live token with the same
 * label. The label once named only the person and the door, so connecting Codex revoked ChatGPT's
 * token for /core/mcp and reconnecting ChatGPT revoked Codex's; a ChatGPT Work task holding the
 * revoked token asked to reconnect in a loop. The label now names the application too.
 *
 *   1. two applications on the same door get different labels — they coexist;
 *   2. the same application re-registering (a new client_id, the same name) gets the same label —
 *      its reconnect replaces its previous token instead of piling up beside it;
 *   3. the token endpoint files tokens under `oauthTokenLabel` and nothing else.
 *
 * Run: node checks/oauth-token-label.ts   (also run by scripts/gate.ts)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.GATEWAY_PUBLIC_URL ??= "https://api.label.test";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const { oauthTokenLabel } = await import(pathToFileURL(join(process.cwd(), "services/gateway/dist/mcp-oauth.js")).href);
const door = "https://api.label.test/core/mcp";
const who = "someone@example.com";

is(oauthTokenLabel("ChatGPT", door, who) !== oauthTokenLabel("Codex", door, who),
   "ChatGPT and Codex on the same door share a label — connecting one revokes the other");
is(oauthTokenLabel("ChatGPT", door, who) === oauthTokenLabel("  ChatGPT ", door, who),
   "the same application gets a different label when it re-registers — its reconnects pile up instead of replacing");
is(oauthTokenLabel("ChatGPT", door, who) !== oauthTokenLabel("ChatGPT", "https://api.label.test/manage/mcp", who),
   "one application's tokens for two doors share a label — connecting one door revokes the other");
is(oauthTokenLabel(null, door, who).includes("unnamed client"), "a client with no name gets no readable label");

const src = readFileSync("services/gateway/src/mcp-oauth.ts", "utf8");
is(/const label = oauthTokenLabel\(/.test(src), "the token endpoint does not file tokens under oauthTokenLabel");
is((src.match(/`mcp oauth — /g) ?? []).length === 1, "mcp-oauth.ts builds a token label in more than one place");

if (fail.length) {
  for (const f of fail) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("PASS one live OAuth token per person, application and door");
