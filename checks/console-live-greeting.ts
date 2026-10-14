#!/usr/bin/env node
/**
 * checks/console-live-greeting.ts — a console tab's change stream opens with one `resync` of the collections it named.
 *
 *   node checks/console-live-greeting.ts   # needs Docker and a built tree (`npm run build`)
 *
 * ZZ Meridian's stream client (the console's `src/lib/live.ts`, the release's file) takes the first `resync` on a
 * stream as the greeting that stands for the read the page made while it mounted, and reads again on every later one.
 * A gateway that sent no greeting would have its first real `resync`, the one that says a tab missed changes, taken for
 * the greeting and thrown away. So the stream's first frame after `retry` is a `resync` naming exactly the
 * collections the tab asked for, and nothing else comes before it.
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), loads the gateway's built
 * `mountConsoleLive`, and opens the route as a signed-in console session would, reading what is written to the
 * response. The only database it touches is the one it started.
 *
 * Exit 0: the greeting held. Exit 1: it did not, with what was written. Exit 2: Docker is not available — the check
 * could not run, and that is not a pass.
 */
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-live-greeting";
const ASKED = ["overview", "activity"];

type Route = (req: unknown, res: unknown) => unknown;

/** A response that keeps every frame written to it, and closes the way a tab leaving does. */
class Stream extends EventEmitter {
  frames: string[] = [];
  statusCode = 200;
  writeHead(code: number): this { this.statusCode = code; return this; }
  flushHeaders(): void {}
  status(code: number): this { this.statusCode = code; return this; }
  type(): this { return this; }
  send(body: string): this { this.frames.push(`refused ${this.statusCode}: ${body}`); return this; }
  write(frame: string): boolean { this.frames.push(frame); return true; }
  end(): void {}
}

async function run(url: string): Promise<string | null> {
  process.env.TEAM_DB_URL = url;
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const db = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const { mountConsoleLive } = (await load("services/gateway/dist/console/live.js")) as { mountConsoleLive: (app: unknown) => void };
  const routes = new Map<string, Route>();
  mountConsoleLive({ get: (path: string, h: Route) => routes.set(path, h) });
  const live = routes.get("/api/console/live");
  if (!live) return "no route GET /api/console/live";

  const res = new Stream();
  const req = Object.assign(new EventEmitter(), {
    query: { collections: ASKED.join(",") },
    headers: {},
    zzIdentity: { email: "greeting@example.com", displayName: "Greeting", platformRole: "user", via: "session",
                  teams: [{ slug: "greeting", role: "admin" }], activeTeam: "greeting", patTeam: null, sessionTeam: "greeting" },
  });
  try {
    await live(req, res);
    // The frames before any change can arrive: the stream's own opening, nothing that a database event caused.
    await new Promise((r) => setTimeout(r, 300));
    const frames = res.frames.filter((f) => !f.startsWith(": beat"));
    const firstEvent = frames.find((f) => f.startsWith("event:"));
    const want = `event: resync\ndata: ${JSON.stringify({ collections: ASKED })}\n\n`;
    if (firstEvent !== want) return `the first event was ${JSON.stringify(firstEvent ?? null)}, not ${JSON.stringify(want)}; frames: ${JSON.stringify(frames)}`;
    if (frames.filter((f) => f.startsWith("event: resync")).length !== 1) return `more than one resync on opening: ${JSON.stringify(frames)}`;
    return null;
  } finally {
    res.emit("close");
    await db.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
  }
}

async function main(): Promise<number> {
  let url = "";
  let problem: string | null = null;
  try {
    await withThrowawayDb(async () => { problem = await run(url); }, async (u) => { url = u; });
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error(`${NAME}: Docker is not available — the check could not run, which is not a pass`);
      return 2;
    }
    console.error(`${NAME}: ${String((err as Error)?.stack ?? err)}`);
    return 1;
  }
  if (problem) { console.error(`${NAME}: FAILED: ${problem}`); return 1; }
  console.log(`${NAME}: a tab's stream opens with one resync naming the collections it asked for: ok`);
  return 0;
}

process.exitCode = await main();
