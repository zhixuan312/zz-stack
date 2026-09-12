/**
 * workspace-gateway — per-user credential gateway for building-block MCP
 * endpoints. Every user brings their OWN API key per platform. The caller is
 * resolved from their platform token on every MCP call; this gateway looks up
 * THAT user's stored key for the target platform, injects it, and streams the
 * request through to the real endpoint. Keys live in /data/credentials.json
 * (named volume, never leaves the host).
 *
 * Endpoints:
 *   /manage/mcp          MCP server with credential-management tools
 *   /p/<platform>/mcp    streaming reverse proxy to the platform's real MCP,
 *                        authenticated with the calling user's stored key
 */
import { CatalogManifest, Envelope, jsonSchema } from "@zz/contracts";
import { serveMcp } from "@zz/mcp-http";
import express from "express";
import { z } from "zod";

import { buildAccessServer } from "./access-door.js";
import { mountBlockOauth } from "./block-oauth.js";
import { PLATFORMS } from "./blocks.js";
import { CLIENT_KINDS, type ClientKind } from "./client-package.js";
import { mountConsoleAsk } from "./console-ask.js";
import { mountConsoleWrite } from "./console-write.js";
import { mountConsole } from "./console.js";
import { deleteMyCredentialFor, issueMyAccessTokenFor, myAccessTokensFor, myCredentialsFor, revokeMyAccessTokenFor, setMyCredentialFor } from "./credentials.js";
import { initPlatformDb } from "./db.js";
import { mountDiscussion } from "./discussion.js";
import { logEvent, strandedEvents } from "./events.js";
import { identityMiddleware } from "./identity.js";
import { mountMcpOauth } from "./mcp-oauth.js";
import { mountPasskey, sweepSessions } from "./passkey.js";
import { CORE_URL, HOP_HEADERS, NEVER_FORWARD, STRIP_RESPONSE, mcpRefusal, relayBody } from "./relay.js";
import { proxy } from "./relay.js";
import { reconcileRuns } from "./runs.js";
import { mountSettings } from "./settings.js";
import { toolCallTelemetry } from "./tool-telemetry.js";
import { clientPackageFor } from "./admin/flows.js";
import { tarGz } from "./package/archive.js";








// ---------------------------------------------------------------- shared "my_*" logic
//
// The query/mutation each of these does, extracted once so /manage/mcp's tools (below) and
// settings.ts's browser routes (Task I-13) call the SAME function rather than two copies of
// the same store read or SQL statement drifting apart. `settings.ts` never imports these as
// VALUES — that would make server.ts and settings.ts import each other at runtime, a cycle
// this codebase avoids everywhere else (console-write.ts depends on console.ts, never the
// reverse) — so these are handed to `mountSettings` as a dependency object instead; see its
// call below and `SettingsDeps` in settings.ts. (settings.ts does take a TYPE-ONLY import of
// two of these functions' result shapes — erased by `tsc` before anything runs, so it is not
// a runtime edge and not the cycle this paragraph is about.)
//
// EACH WRITE TAKES `extraDetail`, merged into its own `logEvent` call's `detail`. A tool
// call passes none, so an agent-issued write logs exactly as it always has; settings.ts's
// routes pass `{ via: "web" }` — see settings.ts's own header for why the marker must be
// added by the CALLER rather than assumed here, and gate.mjs's "every console write route
// records the door it came through" check for what reads that literal text back out of the
// route body.










// ---------------------------------------------------------------- proxy




const app = express();
/**
 * How many proxy hops sit in front of this gateway — ONE, Caddy, in every deployment.
 *
 * A NUMBER, never `true`. A number tells Express to trust exactly that many hops from the
 * socket end of `X-Forwarded-For` and derive `req.ip` (and `req.secure`, and everything
 * else built on it) from the address just past them. `true` would instead trust the ENTIRE
 * header, all the way to its first entry — and the first entry is whatever the client
 * itself sent, so a caller could prepend any address it likes and have `req.ip` report
 * that address back. `console_session.ip`, written by `issueSession`, is that value.
 *
 * Set before any route is mounted, since `req.ip` is read from the first middleware on.
 * Changing the topology — a second proxy in front of Caddy, say — means changing this
 * constant and nothing else.
 */
const PROXY_HOPS = 1;
app.set("trust proxy", PROXY_HOPS);
app.use(express.json({ limit: "20mb" }));
// AN OAUTH TOKEN ENDPOINT IS FORM-ENCODED, and only this line makes ours one.
//
// RFC 6749 §4.1.3 requires `application/x-www-form-urlencoded` at the token endpoint, and the
// MCP SDK sends exactly that. With json() alone, `req.body` was an empty object for every
// exchange: `grant_type` read as "", the endpoint answered `unsupported_grant_type`, and
// LibreChat reported "Authentication failed. Please check your login method and try again."
// — a sentence about the person's credentials, produced by a parser that had not been given
// the body.
//
// It survived every test I wrote because I tested with JSON, which no OAuth client sends. The
// browser flow reached the block's consent screen, came back with a code, and died on
// the last hop of five.
//
// Body parsers are content-type gated, so this only ever runs on a form-encoded request and
// changes nothing about the JSON routes. `extended: false` because these bodies are flat
// key-value pairs; `extended: true` would pull in a nested-object parser nothing here wants.
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

/** Authenticated by default; public only by exception.
 *
 * This used to list the protected prefixes, which meant a route added later
 * without touching that list was silently public. On a gateway reachable from
 * the internet that is the wrong way round: anything not named here demands a
 * token, so forgetting costs a 401 rather than an exposure.
 *
 * The three exceptions and why they are safe:
 *   /        the door index — the shape of the platform, never anything inside
 *   /health  liveness only
 *   /schemas the envelope and manifest as JSON Schema — the RULES for writing a file,
 *            never a fact about anybody's data. It is exempt for the same reason the door
 *            index is: somebody writing a flow has to be able to read the rules before the
 *            platform refuses their write, and a rulebook that needs a token is one people
 *            copy by hand, which is how the second, drifting copy gets made. */
// `/oauth/<block>/callback` is public because it HAS to be: a building block redirects a
// BROWSER here at the end of a consent flow, and that browser carries no platform token. The
// request is identified by its single-use `state`, which was written down before the person
// ever left — so an anonymous callback is still bound to exactly one person, and a replayed
// one finds nothing. Being public is not the same as being unauthenticated.
const OAUTH_CALLBACK = /^\/oauth\/[a-z0-9-]+\/callback$/;
const PUBLIC_PATHS = new Set(["/", "/health"]);
/** Public by PREFIX, kept separate from the exact set so the default stays "deny".
 * Adding one should feel like the deliberate act it is.
 *
 * `/auth/` is the passkey sign-in, and it is public because it HAS to be: a person arriving
 * at the console has no credential yet — that is what they came to get. What each route
 * actually accepts is its own challenge, minted by the route before it and single-use. Same
 * argument as the block callback above, and the same answer: public is not unauthenticated.
 *
 * It is a PREFIX rather than the exact paths because /auth/status, the two register steps,
 * the two login steps and /auth/logout are one flow, and listing them separately is how the
 * next one gets added behind the identity gate and 401s a person who is trying to sign in. */
// `/oauth/` and `/.well-known/` are the OAuth surface, and every one of them has to answer
// a caller holding no credential — that is what they are for. Discovery is read by a client
// deciding how to authenticate; /oauth/register is how it introduces itself; /oauth/authorize
// is reached by a browser before its person has signed in, and answers by sending them to do
// so; /oauth/token is presented a code and a PKCE verifier, which are its credential. Putting
// any of them behind the identity gate means the only callers who could start the flow are
// the ones who had already finished it.
const PUBLIC_PREFIXES = ["/schemas/", "/auth/", "/oauth/", "/.well-known/"];
const requireIdentity = identityMiddleware();
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || OAUTH_CALLBACK.test(req.path)
      || PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) {
    next(); return;
  }
  requireIdentity(req, res, next);
});
// The doors are ours and their names mean nothing from outside. Anyone who
// reaches this gateway — a person, an agent, a new team's engineer — must be
// able to ask it what it offers without being told first. Unauthenticated by
// design: it reveals the shape of the platform, never anything inside it.
const DOORS = [
  { path: "/core/mcp", name: "zz-core", who: "everyone",
    what: "The process layer: skills, your team's knowledge store, documents and their gates, the sources behind them, and where each initiative stands.",
    auth: "Bearer <your token>" },
  { path: "/manage/mcp", name: "access (behind the ZZ Access agent)", who: "everyone; the tool list is your role",
    what: "Access, yours and everybody's: your own building-block keys, your platform token and your client setup \u2014 and, if your role carries them, people, teams, the flow registry, block grants and the projections into every client the platform serves. The tools you are offered are the ones your role can execute, so a tool you cannot see is a fact about you, not about the platform; whoami says which. Each tool still authorises per call, because a tool you can run for one team is not one you can run for another.",
    auth: "Bearer <your token>" },
  { path: "/p/<block>/mcp", name: "building blocks", who: "teams granted that block",
    what: "A third-party platform, called with YOUR OWN key. Store the key first via /manage.",
    auth: "Bearer <your token>" },
  { path: "/pkg/<client>.tgz", name: "client package", who: "everyone, for their own",
    what: "Your access, rendered as an installable marketplace for Claude Code, Codex or Hermes: the platform baseline, the tools for your own keys and tokens, and one plugin per flow your teams installed \u2014 so you receive no block and no method you do not use. A flow you run only in a terminal travels whole; one you also run in a browser stays a pointer, so both places run the same method. Your CLAUDE.md / AGENTS.md / SOUL.md are never touched.",
    auth: "Bearer <your token>" },
];

app.get("/", (req, res) => {
  const base = process.env.GATEWAY_PUBLIC_URL || `http://${req.headers.host ?? "this-host"}`;
  const wantsJson = (req.headers.accept ?? "").includes("application/json");
  if (wantsJson) {
    res.json({ platform: "ZZ Stack", base, doors: DOORS,
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
    ...DOORS.flatMap((d) => [
      `${base}${d.path}`,
      `    ${d.name} — ${d.who}`,
      `    ${d.what}`,
      `    auth: ${d.auth}`,
      "",
    ]),
    "No token yet?",
    "  Open the platform and pick the ZZ Access agent. Ask it for a token:",
    "  it is shown once, carries your identity and your team's access, and",
    "  you can revoke it yourself at any time. That same agent stores your",
    "  keys for the building blocks and prints the setup for Claude Code,",
    "  Codex or Hermes. One agent, everything about your access.",
    "",
  ].join("\n"));
});

/** A person's client package, built for whoever is asking and streamed as one
 * archive. Deliberately not a git remote: both CLIs accept a local directory,
 * so a tarball plus `tar xz` costs us nothing to serve and the person keeps no
 * repository. The archive holds pointers only — the method stays here. */
mountBlockOauth(app, (block) => PLATFORMS[block]?.url);
mountMcpOauth(app);

app.get("/pkg/:file", (req, res) => {
  void (async () => {
    const email = req.zzIdentity?.email ?? "";
    const kind = req.params.file.replace(/\.tgz$/, "") as ClientKind;
    if (!CLIENT_KINDS.includes(kind)) {
      res.status(404).json({
        error: `unknown client '${req.params.file}'`,
        available: CLIENT_KINDS.map((k) => `/pkg/${k}.tgz`),
      });
      return;
    }
    const pkg = await clientPackageFor(email, kind);
    const body = tarGz(pkg.files, pkg.archivePrefix);
    logEvent({ actor: email, kind: "pkg.download", subject: kind,
               detail: { flows: pkg.flows.map((f) => f.flow), bytes: body.length } });
    res.setHeader("content-type", "application/gzip");
    res.setHeader("content-disposition", `attachment; filename="zz-${kind}.tgz"`);
    res.send(body);
  })().catch((err: unknown) => {
    console.error("package render failed:", err);
    if (!res.headersSent) res.status(500).json({ error: "package render failed" });
  });
});

/* The envelope and the manifest, as JSON Schema, unauthenticated.
 *
 * A schema nobody can fetch is a type, and a type only helps the people compiling against
 * it. The reason to have this one is a team writing their own flow: they need something
 * that can tell them their manifest is not legal BEFORE the platform refuses a write, and
 * rules living inside validation functions cannot be read in advance.
 *
 * Open on purpose. These are the rules for writing a file, not a fact about anybody's data,
 * and a rulebook that needs a token is one people copy by hand instead — which is how the
 * second, drifting copy gets made.
 *
 * Emitted from the same zod schemas the platform validates with, never a checked-in file:
 * a hand-maintained schema beside a live validator is exactly the second definition this
 * one exists to remove. */
app.get("/schemas/:name.json", (req, res) => {
  const schemas: Record<string, z.ZodTypeAny> = { envelope: Envelope, manifest: CatalogManifest };
  const schema = schemas[req.params.name];
  if (!schema) {
    res.status(404).json({ error: `no schema '${req.params.name}'`, available: Object.keys(schemas) });
    return;
  }
  // The same base the door index publishes, not req.protocol — behind Caddy that reports
  // `http` for an https deployment, and `$id` is the schema's CANONICAL address: anyone
  // resolving it would fetch a URL that does not answer. GATEWAY_PUBLIC_URL is the address
  // people actually reach this at, which is the only thing an identifier may claim to be.
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
 * A stranded event is provenance the database refused: the module writes it to disk and
 * says so in the log, and nothing else ever mentions it again. Its own comment reads "that
 * file existing means something needs attention" — which was true and had no way of
 * reaching anyone. It belongs here, and `zz-tool watch-results` is what reads it: saying
 * "a monitor already polls this" was an assumption about somebody else's setup, and nothing
 * in this repository polled it.
 *
 * `ok` stays true, because the gateway IS serving. Provenance being incomplete is something
 * to fix, not a reason to take the platform out of a load balancer. */
app.get("/health", (_req, res) => {
  const stranded = strandedEvents();
  res.json({ ok: true, ...(stranded.count ? { stranded_events: stranded } : {}) });
});


// The admin console: browser sign-in, and the cross-team read API behind it.
// Mounted after the identity gate, like every other authenticated surface — /auth/*
// is exempted by PUBLIC_PREFIXES above, /api/console/* is not.
mountPasskey(app);
mountConsole(app);
mountConsoleWrite(app);
mountConsoleAsk(app);
mountDiscussion(app);
mountSettings(app, {
  myCredentialsFor, setMyCredentialFor, deleteMyCredentialFor,
  myAccessTokensFor, issueMyAccessTokenFor, revokeMyAccessTokenFor,
});

// One event per tool call, on every door, recording the OUTCOME. Mounted here because it
// has to sit after identity (it records who called) and before the routes (it wraps the
// response they write to) — and because these four paths are the whole tool surface, so
// one mount is the whole implementation. See tool-telemetry.ts for what it does and does
// not record.
app.use(["/core/mcp", "/manage/mcp", "/p/:platform/mcp"],
        toolCallTelemetry((req) => {
          // originalUrl, not baseUrl: under app.use with a path array baseUrl is not the
          // matched entry, and every surface was recorded as "core" — telemetry that names
          // the wrong door is worse than none, because it reads as an answer.
          const url = req.originalUrl;
          const block = /^\/p\/([^/]+)\/mcp/.exec(url)?.[1];
          if (block) return block;
          return url.startsWith("/manage") ? "manage" : "core";
        }));

serveMcp(app, "/manage/mcp", buildAccessServer);


app.all("/core/mcp", (req, res) => {
  void (async () => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (HOP_HEADERS.has(lk) || NEVER_FORWARD.has(lk)) continue;
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(", ");
    }
    const hasBody = req.method !== "GET" && req.method !== "DELETE";
    const upstream = await fetch(CORE_URL, {
      method: req.method, headers,
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
      signal: req.method === "GET" ? undefined : AbortSignal.timeout(120_000),
    });
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!STRIP_RESPONSE.has(k.toLowerCase())) res.setHeader(k, v);
    });
    relayBody(upstream.body, res, "core proxy");
  })().catch((err: unknown) => {
    console.error("core proxy failed:", err);
    mcpRefusal(req, res, "The ZZ platform service is not reachable right now. Nothing about " +
      "your access has changed and nothing needs reconnecting — retry the call.");
  });
});

app.all("/p/:platform/mcp", (req, res) => {
  void proxy(req, res).catch((err: unknown) => {
    console.error("proxy failed:", err);
    mcpRefusal(req, res, `Block '${req.params.platform}' did not answer. Its own service is ` +
      "unreachable or timed out; your credential for it is unaffected and needs no reconnecting. " +
      "Retry, and if it keeps failing report the block as down rather than asking anyone to sign in again.");
  });
});


initPlatformDb()
  .catch((err: unknown) => {
    console.error("platform db init failed (continuing without it):", err);
  })
  .finally(() => {
    // Expired sessions and abandoned half-finished logins, swept on a timer rather
    // than at read time: `resolveSession` runs on every authenticated request, and a
    // read that also writes turns each page load into a transaction. Hourly is far
    // more often than it needs — the rows are already refused by their own expiry,
    // and this only keeps the table from growing forever. `unref` so a sweep pending
    // at shutdown does not hold the process open.
    setInterval(() => { void sweepSessions().catch(() => undefined); },
                60 * 60_000).unref();
    // zz.run recomputed from the event log, on start and every few minutes. It is derived
    // data with no writer — see runs.ts — and for five days nothing recomputed it, so every
    // skill's measured reach stopped on the day the migration that created the table ran.
    // Cheap because it is set-based and idempotent; five minutes is far more often than the
    // evaluation track needs and keeps the console's numbers honest between rounds.
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
    app.listen(8000, "0.0.0.0", () =>
      // Printed from DOORS, the same list served at `/`. Written by hand it had already
      // drifted: it named four doors and the gateway serves six, so /app and /pkg — the two
      // a person is most likely to be looking for — appeared nowhere in the logs.
      console.log(`workspace-gateway (TS) listening on :8000 (${DOORS.map((d) => d.path).join(" ")})`),
    );
  });
