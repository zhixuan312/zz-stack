#!/usr/bin/env node
/**
 * checks/access-words.ts — the platform names the console's Access, not the Settings page that is gone (AC-1.12).
 *
 *   node checks/access-words.ts   # needs a built tree (`npm run build`)
 *
 * Two strings send a person to the console's page for their own access: `NO_TOKEN_ONBOARDING`, which the
 * gateway's `GET /` and `zz-tool` print to somebody with no token, and `team_switch`'s description on the access
 * door, which tells an agent where a signed-in browser switches its own team. Both read the built modules: the
 * onboarding text from `packages/contracts/dist/index.js`, and the description from the access door that
 * `services/gateway/dist/access-door.js` builds, connected to a real client over an `InMemoryTransport` pair and
 * read from its `tools/list`, so it is the description a client is served. What it establishes:
 *
 *   - each names Access, the page that holds a person's tokens and their browser's team;
 *   - neither names Settings, in any case: the console answers `/settings` as an address no page answers.
 *
 * DELIBERATE: the words are written here and nothing is read from the code but the two strings under test. The
 * gateway's `GET /` and `zz-tool` print the onboarding text by importing it, so its one source is the one read.
 *
 * Exit 0: both held — one line each, then the final line.
 * Exit 1: a string names Settings, does not name Access, or could not be read — which, and what it says.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { root } from "../scripts/deployment.ts";

const NAME = "access-words";
const DONE = "access-words: the no-token onboarding text and team_switch's served description each name Access and neither " +
  "names Settings: ok";

/** The console's page for a person's own access, as a word, and the page it replaced, in any case. */
const ACCESS = /\bAccess\b/;
const SETTINGS = /\bsettings\b/i;

const load = (p: string) => import(pathToFileURL(join(root, p)).href);

/** What `text` says wrong, as `what`: a phrase per fault. */
function faults(what: string, text: string): string[] {
  const wrong: string[] = [];
  if (!ACCESS.test(text)) wrong.push(`${what} does not name Access`);
  const at = text.search(SETTINGS);
  if (at >= 0) wrong.push(`${what} names Settings: "…${text.slice(Math.max(0, at - 40), at + 20)}…"`);
  return wrong;
}

async function main(): Promise<number> {
  const wrong: string[] = [];

  const { NO_TOKEN_ONBOARDING } = (await load("packages/contracts/dist/index.js")) as { NO_TOKEN_ONBOARDING: readonly string[] };
  const onboarding = NO_TOKEN_ONBOARDING.join("\n");
  const said = faults("NO_TOKEN_ONBOARDING", onboarding);
  if (said.length) wrong.push(...said);
  else console.log("ok NO_TOKEN_ONBOARDING names Access and not Settings");

  const { buildAccessServer } = (await load("services/gateway/dist/access-door.js")) as { buildAccessServer: () => Promise<McpServer> };
  const [forServer, forClient] = InMemoryTransport.createLinkedPair();
  const server = await buildAccessServer();
  await server.connect(forServer);
  const client = new Client({ name: NAME, version: "0" });
  await client.connect(forClient);
  try {
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === "team_switch")?.description;
    if (description === undefined) {
      wrong.push(`the access door serves no team_switch (it serves ${tools.map((t) => t.name).join(", ") || "nothing"})`);
    } else {
      const found = faults("team_switch's description", description);
      if (found.length) wrong.push(...found);
      else console.log("ok team_switch's description, as the access door serves it, names Access and not Settings");
    }
  } finally {
    await client.close();
  }

  if (wrong.length) {
    console.error(`${NAME}: FAILED — ${wrong.join("; ")}`);
    return 1;
  }
  console.log(DONE);
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`${NAME}: FAILED — ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
}
