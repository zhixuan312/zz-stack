/**
 * The gateway — the one authenticated door. Every request is resolved to a person from their
 * platform token or console session, then served here (/manage, the console API) or proxied to
 * zz-core (/core/mcp, /eval/mcp).
 *
 * The endpoints are `DOORS` below, which is also what `/` serves and what this process
 * prints on boot.
 */
import { CatalogManifest, Envelope, jsonSchema, NO_TOKEN_ONBOARDING } from "@zz/contracts";
import { serveMcp } from "@zz/mcp-http";
import express from "express";
import { z } from "zod";

import { buildAccessServer } from "./access-door.js";
import { recordAccessSurface } from "./access-surface.js";
import { mountConsoleAsk } from "./console-ask.js";
import { mountConsoleWrite } from "./console-write.js";
import { mountConsole } from "./console.js";
import { issueMyAccessTokenFor, myAccessTokensFor, revokeMyAccessTokenFor } from "./credentials.js";
import { initPlatformDb, platformDbReady } from "./db.js";
import { mountDiscussion } from "./discussion.js";
import { strandedEvents } from "./events.js";
import { identityMiddleware } from "./identity.js";
import { mountMcpOauth } from "./mcp-oauth.js";
import { mountPasskey, sweepSessions } from "./passkey.js";
import { CORE_URL, EVAL_URL, passThrough } from "./relay.js";
import { reconcileRuns } from "./runs.js";
import { mountSettings } from "./settings.js";
import { doorSurface, toolCallTelemetry } from "./tool-telemetry.js";

const app = express();
/**
 * How many proxy hops sit in front of this gateway — one, Caddy, in every deployment.
 *
 * DELIBERATE: a number, never `true`. A number tells Express to trust exactly that many hops
 * from the socket end of `X-Forwarded-For` and derive `req.ip` from the address just past
 * them. `true` trusts the entire header down to its first entry, which is whatever the
 * client sent, so a caller could make `req.ip` report any address it likes.
 * `console_session.ip`, written by `issueSession`, is that value.
 *
 * Set before any route is mounted, since `req.ip` is read from the first middleware on.
 * Changing the topology means changing this constant and nothing else.
 */
const PROXY_HOPS = 1;
app.set("trust proxy", PROXY_HOPS);
app.use(express.json({ limit: "20mb" }));
// The OAuth token endpoint is form-encoded, and only this line makes ours one: RFC 6749
// §4.1.3 requires `application/x-www-form-urlencoded` there, and the MCP SDK sends it. With
// json() alone `req.body` is empty for every exchange and the endpoint answers
// `unsupported_grant_type`.
//
// Body parsers are content-type gated, so this only runs on a form-encoded request and
// changes nothing about the JSON routes. `extended: false` because these bodies are flat
// key-value pairs.
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

/** Authenticated by default; public only by exception. Anything not named here demands a
 * token, so a route added later without touching this list costs a 401 rather than an
 * exposure.
 *
 * The three exceptions:
 *   /        the door index — the shape of the platform, never anything inside
 *   /health  liveness only
 *   /schemas the envelope and manifest as JSON Schema — the rules for writing a file, never
 *            a fact about anybody's data, and readable before the platform refuses a write */
const PUBLIC_PATHS = new Set(["/", "/health"]);
/** Public by prefix, kept separate from the exact set so the default stays "deny".
 *
 * `/auth/` is the passkey sign-in: a person arriving at the console has no credential yet.
 * Each route accepts its own single-use challenge, minted by the route before it. A prefix
 * rather than exact paths because /auth/status, the two register steps, the two login steps
 * and /auth/logout are one flow, and the next one added would otherwise 401 a person trying
 * to sign in. */
// `/oauth/` and `/.well-known/` are the OAuth surface, and every one of them has to answer a
// caller holding no credential. Discovery is read by a client deciding how to authenticate;
// /oauth/register is how it introduces itself; /oauth/authorize is reached by a browser
// before its person has signed in; /oauth/token is presented a code and a PKCE verifier,
// which are its credential.
const PUBLIC_PREFIXES = ["/schemas/", "/auth/", "/oauth/", "/.well-known/"];
const requireIdentity = identityMiddleware();
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) {
    next(); return;
  }
  requireIdentity(req, res, next);
});
// What each door means, filed under the path it is mounted at. Unauthenticated by design: it
// reveals the shape of the platform, never anything inside it.
//
// The set of paths is not kept here — `doorIndex` below asks express which routes were
// mounted, and this map supplies only the prose. `who`, `what`, `auth` and `name` are
// judgement and no derivation produces them.
//
// A key is the express path, parameter syntax and all, because that is the string the route
// is mounted at. `/` prints it the way a person types it.
const DOORS: Record<string, { name: string; who: string; what: string; auth: string }> = {
  "/core/mcp": { name: "zz-core", who: "everyone",
    what: "The process layer: skills, your team's knowledge store, documents and their gates, the sources behind them, and where each initiative stands.",
    auth: "Bearer <your token>" },
  "/manage/mcp": { name: "zz-access", who: "everyone; the tool list is your role",
    what: "Access, yours and everybody's: your platform token, the team you act for and your client setup \u2014 and, if your role carries them, people, teams and who is on them. The tools you are offered are the ones your role can execute, so a tool you cannot see is a fact about you, not about the platform; whoami says which. Each tool still authorises per call, because a tool you can run for one team is not one you can run for another.",
    auth: "Bearer <your token>" },
  "/eval/mcp": { name: "zz-plugin-eval", who: "everyone; a client reaches it through the zz-plugin-eval plugin",
    what: "Evaluating a plugin: what its real runs did, read from this platform's own door telemetry, and the ruler they are scored against. Separate from /core/mcp because it is one plugin's instrument rather than everybody's process layer — a client gets it by installing that plugin.",
    auth: "Bearer <your token>" },
};

/** Every MCP path this app has actually mounted, in the order it mounted them.
 *
 * `_router` is express's own registration table and the only place that knows the answer:
 * `serveMcp` and `app.all` both end in `app.all(path, …)`, so one read covers every door
 * however it was mounted. It is a private API, read in this one function with a declared
 * shape, and an empty answer is a failure rather than an empty list.
 *
 * DELIBERATE: the test is that a route answers POST, GET and DELETE, not that its path ends
 * in `/mcp`. Other things live at such a path — the OAuth spec puts a door's resource
 * metadata at `/.well-known/oauth-protected-resource/core/mcp` — and they are GETs. A
 * path-only test would read one as an extra door, find no prose for it, and take the gateway
 * down at boot. */
const mountedDoors = (): string[] => {
  const router = (app as unknown as {
    _router?: { stack?: { route?: { path?: unknown; methods?: Record<string, boolean> } }[] };
  })._router;
  return (router?.stack ?? [])
    .filter((layer) => {
      const m = layer.route?.methods;
      return Boolean(m?.post && m.get && m.delete);
    })
    .map((layer) => layer.route?.path)
    .filter((path): path is string => typeof path === "string" && path.endsWith("/mcp"));
};

/** The door index a stranger reads at `/`, and the boot line prints.
 *
 * Throws on an empty list and on either half going short: an empty index would answer 200
 * and tell every caller the platform offers nothing, a mounted door with no prose would be
 * served and never announced, and prose for a door nothing mounts would 404 whoever
 * believed it.
 */
const doorIndex = (): { path: string; name: string; who: string; what: string; auth: string }[] => {
  const mounted = mountedDoors();
  if (mounted.length === 0) {
    throw new Error("this gateway has mounted no MCP door: `/` would answer with an empty index, " +
                    "which tells every caller the platform offers nothing.");
  }
  const undescribed = mounted.filter((path) => !DOORS[path]);
  if (undescribed.length) {
    throw new Error(`mounted and unannounced: ${undescribed.join(", ")} — a door nobody can be ` +
                    "told about is a door nobody can use. Give it an entry in DOORS.");
  }
  const unmounted = Object.keys(DOORS).filter((path) => !mounted.includes(path));
  if (unmounted.length) {
    throw new Error(`announced and unmounted: ${unmounted.join(", ")} — the door index would ` +
                    "send a caller to a path this process does not serve.");
  }
  // The set is the router's; the order is DOORS'. The guards above have proved the two sets
  // identical, so iterating DOORS cannot announce an unmounted path or omit a mounted one.
  // Mount order puts /manage before /core, and /core is the door almost every caller wants.
  return Object.keys(DOORS).map((path) => ({
    path: path.replace(/:([A-Za-z_]\w*)/g, "<$1>"),
    ...DOORS[path],
  }));
};

app.get("/", (req, res) => {
  const base = process.env.GATEWAY_PUBLIC_URL || `http://${req.headers.host ?? "this-host"}`;
  const wantsJson = (req.headers.accept ?? "").includes("application/json");
  if (wantsJson) {
    res.json({ platform: "ZZ Stack", base, doors: doorIndex(),
               how_to_get_a_token: "Ask any agent on the platform: 'issue me an access token'. It is shown once." });
    return;
  }
  res.type("text/plain").send([
    "ZZ Stack — platform gateway",
    "",
    "Every door below speaks MCP over streamable HTTP, and every MCP server",
    "describes itself: connect and call tools/list to see exactly what it",
    "offers, with each tool's arguments. Nothing here needs a manual.",
    "",
    ...doorIndex().flatMap((d) => [
      `${base}${d.path}`,
      `    ${d.name} — ${d.who}`,
      `    ${d.what}`,
      `    auth: ${d.auth}`,
      "",
    ]),
    // COUPLED: `zz-tool` prints these same lines when it cannot find a token, so they live
    // in @zz/contracts rather than here.
    ...NO_TOKEN_ONBOARDING,
    "",
  ].join("\n"));
});

mountMcpOauth(app);

/* The envelope and the manifest, as JSON Schema, unauthenticated so a team writing their own
 * flow can check a manifest before the platform refuses their write.
 *
 * Emitted from the same zod schemas the platform validates with, never a checked-in file. */
app.get("/schemas/:name.json", (req, res) => {
  const schemas: Record<string, z.ZodTypeAny> = { envelope: Envelope, manifest: CatalogManifest };
  const schema = schemas[req.params.name];
  if (!schema) {
    res.status(404).json({ error: `no schema '${req.params.name}'`, available: Object.keys(schemas) });
    return;
  }
  // The same base the door index publishes, not req.protocol: behind Caddy that reports
  // `http` for an https deployment, and `$id` is the schema's canonical address, so anyone
  // resolving it would fetch a URL that does not answer.
  const base = process.env.GATEWAY_PUBLIC_URL || `http://${req.headers.host ?? "this-host"}`;
  res.json({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${base}/schemas/${req.params.name}.json`,
    title: req.params.name,
    ...jsonSchema(schema),
  });
});

/** Liveness, plus the one thing that fails silently.
 *
 * A stranded event is provenance the database refused: the module writes it to disk and says
 * so in the log, and nothing else mentions it again. `zz-tool watch-results` reads this
 * route's body, which is the only thing that reports it.
 *
 * `db` is here for the same reason: a failed migration, or an unset
 * PLATFORM_DB_URL/TEAM_DB_URL, leaves the process listening and refusing every real call,
 * and nothing outside it could otherwise tell that from a healthy one.
 *
 * DELIBERATE: `ok` stays true and neither condition becomes a 503. The gateway is serving,
 * nothing in this repository reads this route's status code, and db.ts's own choice is that
 * a database problem does not take the platform down. */
app.get("/health", (_req, res) => {
  const stranded = strandedEvents();
  res.json({ ok: true, db: platformDbReady(),
             ...(stranded.count ? { stranded_events: stranded } : {}) });
});


// The admin console: browser sign-in, and the cross-team read API behind it.
// Mounted after the identity gate, like every other authenticated surface — /auth/*
// is exempted by PUBLIC_PREFIXES above, /api/console/* is not.
mountPasskey(app);
mountConsole(app);
mountConsoleWrite(app);
mountConsoleAsk(app);
mountDiscussion(app);
// DELIBERATE: the `my_*` functions are handed over as a dependency object rather than
// imported by settings.ts. They live in credentials.ts so /manage/mcp's tools and
// settings.ts's browser routes call the same function, and a value import there would make
// server.ts and settings.ts import each other at runtime. settings.ts's type-only import of
// two result shapes is erased by `tsc` and is not that edge. See `SettingsDeps` in
// settings.ts.
//
// Each write takes `extraDetail`, merged into its own `logEvent` call's `detail`. A tool
// call passes none; these routes pass `{ via: "web" }`. COUPLED: the gate's "every console
// write route records the door it came through" check reads that literal text back out of
// the route body.
mountSettings(app, {
  myAccessTokensFor, issueMyAccessTokenFor, revokeMyAccessTokenFor,
});

// One event per tool call, on every door, recording the outcome. Mounted after identity (it
// records who called) and before the routes (it wraps the response they write to). See
// tool-telemetry.ts for what it does and does not record.
//
// COUPLED: `doorSurface` in tool-telemetry.ts must know every path in DOORS. A door added
// here and not there is recorded as `core` — nothing fails and every number about it is
// wrong.
app.use(Object.keys(DOORS),
        toolCallTelemetry((req) => doorSurface(req.originalUrl)));

serveMcp(app, "/manage/mcp", buildAccessServer);


app.all("/core/mcp", passThrough(CORE_URL, "core proxy",
  "The ZZ platform service is not reachable right now. Nothing about " +
  "your access has changed and nothing needs reconnecting — retry the call."));

// The evaluation door. zz-core is the process behind it too — it mounts a second MCP
// endpoint rather than running a second service — and the identity gate above authenticates
// it like every path outside PUBLIC_PATHS and PUBLIC_PREFIXES.
//
// Separate from /core/mcp so the `plugin_*` tools are carried by the plugin that owns them:
// the core door is in the required baseline plugin, so a tool on it reaches every account.
app.all("/eval/mcp", passThrough(EVAL_URL, "eval proxy",
  "The ZZ evaluation door is not reachable right now. The platform's other doors are " +
  "unaffected, nothing about your access has changed and nothing needs reconnecting — retry " +
  "the call."));


initPlatformDb()
  .catch((err: unknown) => {
    console.error("platform db init failed (continuing without it):", err);
  })
  .finally(() => {
    // Expired sessions and abandoned half-finished logins, swept on a timer rather than at
    // read time: `resolveSession` runs on every authenticated request, and a read that also
    // writes turns each page load into a transaction. The rows are already refused by their
    // own expiry, so this only keeps the table from growing. `unref` so a sweep pending at
    // shutdown does not hold the process open.
    setInterval(() => {
      void sweepSessions()
        .catch((err) => console.error("console_session sweep failed:", err));
    }, 60 * 60_000).unref();
    // zz.run recomputed from the event log, on start and every few minutes. It is derived
    // data with no writer — see runs.ts — so nothing else keeps it current. Set-based and
    // idempotent, so re-running it costs little.
    const runs = () => void reconcileRuns()
      .then((n) => {
        if (n.runs || n.linked || n.docs) {
          console.log(`runs: ${n.runs} recorded, ${n.linked} event(s) linked, ` +
                      `${n.docs} document(s) attributed`);
        }
      })
      .catch((err: unknown) => console.error("run reconcile failed:", err));
    runs();
    setInterval(runs, 5 * 60_000).unref();
    void recordAccessSurface();
    app.listen(8000, "0.0.0.0", () =>
      // Printed from DOORS, the same list served at `/`, so the boot line cannot drift from
      // what is mounted.
      console.log(`workspace-gateway (TS) listening on :8000 (${doorIndex().map((d) => d.path).join(" ")})`),
    );
  });
