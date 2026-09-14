/**
 * LAYER 4 — does every door answer?
 *
 * The doors are where a person or an agent actually meets this platform, and they fail in
 * ways the layer above cannot see: a container can be running the right image, healthy by
 * every measure compose knows, and still 500 every MCP request.
 *
 * THE TOKEN IS READ ONCE, from one place. A verification credential that is wrong for the
 * target does not report "I could not check" — it reports the TARGET as broken, and it does it
 * at the moment an operator is most likely to act on it. A release once read ~/.zz/token,
 * which held one of two deployments' tokens, got 401 from every door, announced three dead MCP
 * doors and offered to roll back a deployment that was live, correct and serving.
 *
 * Here that cannot happen the same way: a missing token is a probe that DID NOT RUN, which is
 * never a verdict about the platform. See run.mjs.
 */
import { DASH_REMOTE, HOST, REMOTE, asExecError, envToken, initFrame, publicUrl, run, ssh } from "../../deployment.ts";
import { layer, probe } from "../run.ts";

layer("doors", "does every door answer", ["services/gateway/src"]);

/** The address, or a throw — which the runner turns into `unknown`, never into a failure
 *  attributed to the platform. This is the distinction the whole runner exists for: not
 *  knowing where to look is not evidence that what you were looking for is broken. */
function url() {
  const u = publicUrl({ quiet: true });
  if (!u) throw new Error(`ZZ_PUBLIC_URL is not set and ${HOST} could not be asked for it — there is no address to probe`);
  return u;
}
function token() {
  const t = envToken();
  if (!t) throw new Error("no ZZ_TOKEN in the environment or this repository's .env — the authenticated doors cannot be asked");
  return t;
}
/* A PROBE MAY THROW ONLY FOR A PRECONDITION — no address, no token, no host. Once a request
 * has actually been SENT, whatever comes back is the platform's answer and must be RETURNED,
 * because the runner turns a throw into `unknown` and `unknown` is not evidence.
 *
 * This is the mirror of the bug the runner exists for, and it is the more dangerous one. curl
 * exits 7 on a refused connection, so `execFileSync` throws — and a crash-looping gateway
 * would have produced seven "did not run" lines, zero disagreements, and a release that TAGGED
 * itself. The old loopback console probe already knew this; that is what its `|| true` was for.
 * The direct curl calls never had the equivalent.
 *
 * curl writes %{http_code} to stdout even when it exits non-zero, so the answer is already
 * there in the throw. A refused connection is "000", which is a fact about the deployment. */
const code = (args: string[]): string => {
  try { return run("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "25", ...args]); }
  catch (err) { return (asExecError(err).stdout ?? "").trim() || "000"; }
};

probe("gateway /health", () => {
  const c = code([`${url()}/health`]);
  return c === "200" ? null : `http ${c}`;
});

// The one that catches the outage that has actually happened here. The MCP server is built per
// request, so a throw at construction — a duplicate tool registration, a bad import — 500s
// EVERY endpoint while /health stays perfectly green.
// EVERY DOOR THIS GATEWAY SERVES, including the one added last. A door left out of this list
// is a door whose failure to mount looks exactly like a healthy deployment: /health is green,
// every other probe is green, and the only symptom is that one plugin's tools answer nothing.
for (const path of ["/core/mcp", "/eval/mcp", "/manage/mcp"]) {
  probe(`MCP initialize ${path}`, () => {
    const c = code(["-H", `Authorization: Bearer ${token()}`, "-H", "content-type: application/json",
      "-H", "accept: application/json, text/event-stream", "-d", initFrame("doctor"), `${url()}${path}`]);
    return c === "200" ? null : `http ${c}`;
  });
}

// Public, and emitted at REQUEST time from the live zod schemas — so a construct the emitter
// has no rule for turns this into a 500 while every check above stays green. It is the
// rulebook somebody reads before writing a flow, and a rulebook that answers 401 is one people
// copy by hand instead.
for (const name of ["envelope", "manifest"]) {
  probe(`schema ${name} is public`, () => {
    const c = code([`${url()}/schemas/${name}.json`]);
    return c === "200" ? null : `http ${c}`;
  });
}

// THE CONSOLE IS THE INTERFACE PEOPLE SIT IN FRONT OF, and it can go down while every probe
// above stays green — none of them touch it. Probed on the host because it binds to loopback.
//
// Named for the ROLE, and anything short of 5xx passes: the front end is the piece of this
// stack most likely to be swapped. This probe was first written against Open WebUI's /health
// on 8080, then LibreChat on 3080, then the console — each swap would have failed a probe
// naming the last one and rolled back a good release. The claim that survives a swap is
// "something is answering HTTP here". A sign-in redirect is the console working; a dead port
// answers 000.
probe("the console answers on the host", () => {
  // `|| true`, not `|| echo 000`: curl writes %{http_code} itself on a refused connection, so
  // the fallback echo appended a SECOND 000 and the failure read "http 000000".
  const c = ssh(`curl -s -o /dev/null -w '%{http_code}' -m 15 "http://127.0.0.1:3100/" || true`) || "000";
  const n = Number(c);
  return n >= 100 && n < 500 ? null : `http ${c}`;
});

// Through Caddy, not the loopback port — the console is a browser application and the thing
// that breaks is the path split in front of it, which a container probe cannot see.
probe("the console answers through its public address", () => {
  const addr = (process.env.ZZ_CONSOLE_URL || "").trim()
    || ssh(`grep -oP '(?<=^CONSOLE_PUBLIC_URL=).*' ${REMOTE}/deploy/.env 2>/dev/null || echo ''`).trim()
    || ssh(`grep -oP '(?<=^CONSOLE_PUBLIC_URL=).*' ${DASH_REMOTE}/.env 2>/dev/null || echo ''`).trim();
  if (!addr) throw new Error("nothing declares a public console address — CONSOLE_PUBLIC_URL is unset on both sides");
  const n = Number(code([addr]));
  return n >= 100 && n < 500 ? null : `http ${n} from ${addr}`;
});
