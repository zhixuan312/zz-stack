/**
 * Defects planted in the security boundary, in who the caller is, in what holds a credential,
 * and in what the platform records about itself.
 *
 * SIX CHECK FILES, THIRTY-EIGHT REGISTERED CHECKS, one row each. The grouping is not
 * cosmetic: every check here protects a property that is invisible when it holds and
 * expensive when it stops — a refusal that keeps handling the request, an address that is
 * canonical at twenty call sites instead of one, a column a report groups by that nothing
 * writes. None of those breaks a build, and none of them shows up in a passing gate run, so
 * the only way to learn whether the check would notice is to put the defect back.
 *
 * THREE ROWS ARE DISCLOSED RATHER THAN QUIETLY ARRANGED, each in its own comment below:
 * `DROPPED_TABLE` (this file would otherwise fail one of the checks it is measuring),
 * `credential_set_mine` (the check it is aimed at is vacuous on today's surface and its own
 * comment says so), and the acting-team row (its defect is the one expression two different
 * checks both forbid, so it turns two red and only one of them is its target).
 *
 * WHY NO ROW HERE CARRIES A CREDENTIAL. `security-secrets.ts` refuses any tracked file that
 * carries a routable address, an email or a credential shape, and `testing/mutation-report.json`
 * is a tracked file that quotes every `find` and `replace` verbatim. So the password row
 * plants `change-me` — the literal this repository actually shipped, and a string no shape in
 * that sweep matches — and the token row changes a byte COUNT rather than writing a token.
 * Nothing here needs `redact`.
 */
import type { MutationSpec } from "./plant.ts";

/**
 * The dropped table this file names, assembled rather than written out.
 *
 * `nothing queries a table the migrations dropped` scans `scripts/` as well as the services,
 * matching `from|join|into|update|delete from` followed by `zz.<table>` with no comment
 * stripping and no exemption for this directory. A `replace` string spelling the dropped table
 * out would therefore make THIS file the finding — a spec that turns the gate red at baseline
 * on the very check it exists to measure, which is worse than no spec at all.
 *
 * Disclosed rather than left in, for the same reason `specs-documents.ts` disclosed its own
 * assembled path: a script under `scripts/` stepping around one of this repository's checks is
 * exactly the shape those checks exist to find, and saying so is what stops it becoming a
 * pattern somebody copies. The planted file gets the contiguous name; this file never holds it.
 */
const DROPPED_TABLE = `zz.${"block_tool"}`;

export const COV_SECURITY: readonly MutationSpec[] = [
  // ── scripts/gate/checks/security-boundary.ts ────────────────────────────────────────────
  {
    check: "scripts/gate/checks/security-boundary.ts",
    target: "a value crossing into a shell is quoted for a shell",
    assertion: "a generated shell word is single-quoted, whatever language generates it",
    subject: "testing/reset-store.sh",
    find: 'TEAM=""; PREFIX=""; DRY=""',
    replace: 'eval "$(node -e \'process.stdout.write(`export PGPASSWORD=' +
      '${JSON.stringify(process.env.POSTGRES_PASSWORD ?? "")}`)\')"\n' +
      'TEAM=""; PREFIX=""; DRY=""',
    planted: "the reset script builds a shell word with JSON.stringify and evaluates it, so a " +
      "database password containing a quote is expanded by the shell before psql ever sees " +
      "it — the connection then fails and the one value that is wrong is the one thing " +
      "nothing prints",
    caveat: "no shell script in this repository evaluates generated shell today, so the " +
      "check's own loop skips every file and it cannot currently fail. This row supplies the " +
      "subject the check was written for; it shows the check fires on one, not that anything " +
      "shipping is covered by it",
  },
  {
    check: "scripts/gate/checks/security-boundary.ts",
    target: "the write guards see a path traversal cannot hide from",
    assertion: "the guard tests a normalised path, never the one the caller wrote",
    subject: "services/zz-core/src/paths.ts",
    find: '  const relPath = resolve("/", rawPath).slice(1);',
    replace: "  const relPath = rawPath;",
    planted: "writeGuard tests the path exactly as the caller wrote it, so `a/../_knowledge/" +
      "nodes/0001-x.md` walks around the journal guard that anchors at the start — " +
      "document_write can then mint a knowledge node with no evidence, no index row and no " +
      "line in the append-only log, which are the four things knowledge_add exists to guarantee",
  },
  {
    check: "scripts/gate/checks/security-boundary.ts",
    target: "no replacement string can be read as a pattern",
    assertion: "a replacement carrying somebody's own words is a function, never a value",
    subject: "services/zz-core/src/tools/artifacts.ts",
    find: "      const result = body.replace(find, () => replace);",
    replace: "      const result = body.replace(find, replace);",
    planted: "document_patch puts the model's own replacement text straight into the second " +
      "argument of String.replace, where $& and $' are read as patterns — a patch containing " +
      "a shell example swallows its own line and injects the entire rest of the document " +
      "after it, silently, in the call described as how a draft is filled in section by section",
  },
  {
    check: "scripts/gate/checks/security-boundary.ts",
    target: "the gateway is authenticated by default, and the exceptions are the intended ones",
    assertion: "a path that must carry a token is not on the public list",
    subject: "services/gateway/src/server.ts",
    find: 'const PUBLIC_PREFIXES = ["/schemas/", "/auth/", "/oauth/", "/.well-known/"];',
    replace: 'const PUBLIC_PREFIXES = ["/schemas/", "/auth/", "/oauth/", "/.well-known/", "/p/"];',
    planted: "every block door under /p/ becomes reachable with no token at all, on a gateway " +
      "that answers from the internet — the exception list is the one thing standing between " +
      "a deny-by-default middleware and a public MCP surface",
  },
  {
    check: "scripts/gate/checks/security-boundary.ts",
    target: "a psql variable is bound, never interpolated",
    assertion: "an operator's own flag reaches the server as a literal, not as SQL",
    subject: "packages/tools/src/testing/tool-report.ts",
    find: "  const where = [\"ts > now() - (:'since')::interval\"];",
    replace: '  const where = ["ts > now() - (:since)::interval"];',
    planted: "the operator's --since flag is substituted into the statement as raw SQL instead " +
      "of arriving as a string literal, because psql interpolates a bare :name while lexing — " +
      "an apostrophe alone is then enough to change what the query means",
  },
  {
    check: "scripts/gate/checks/security-boundary.ts",
    target: "both services authenticate their own network the same way",
    assertion: "the shared address mechanism answers 'no policy' and 'nobody matched' differently",
    subject: "packages/contracts/src/identity.ts",
    find: "    if (!hosts.length) return null;",
    replace: "    if (!hosts.length) return new Set<string>();",
    planted: "a deployment that trusts no hosts resolves to an empty set rather than to " +
      "nothing, so 'there is no policy' arrives at both services as 'nobody matched' — it " +
      "fails closed, which sounds safe and means zz-core 403s every call from its own " +
      "gateway, a whole deployment down while reading like a network fault",
  },
  {
    check: "scripts/gate/checks/security-boundary.ts",
    target: "the paths documented as public are the ones the gateway exempts",
    assertion: "a document that lists the unauthenticated paths lists all of them",
    subject: "deploy/README.md",
    find: "## Interfaces\n\n**Claude Code** installs from the public shelf",
    replace: "## Interfaces\n\nEverything but `/` and `/health` requires a token.\n\n" +
      "**Claude Code** installs from the public shelf",
    planted: "the deployment guide states which paths need no token and names two of the six " +
      "the gateway actually exempts — a reader auditing the exposed surface counts four " +
      "fewer than are open, and the ones they did not count are the ones nobody told them about",
    caveat: "neither README makes the claim today — the check reads only where a document " +
      "actually lists the unauthenticated paths, and both skip — so it cannot currently fail. " +
      "This row supplies the claim and shows the check catches an incomplete one",
  },
  {
    check: "scripts/gate/checks/security-boundary.ts",
    target: "an MCP door is stateless, and never answers with an HTTP error status",
    assertion: "a non-POST on a door answers the one status the client is built to tolerate",
    subject: "packages/mcp-http/src/index.ts",
    find: '      res.status(405).set("Allow", "POST").json({',
    replace: '      res.status(404).set("Allow", "POST").json({',
    planted: "opening the optional server-to-client stream answers 404 instead of the spec's " +
      "405, so the client reads a dead transport where it should read 'this server does not " +
      "push' — three of those open the front end's per-user circuit breaker for good, and " +
      "the person is told to reconnect credentials that were never the problem",
  },

  // ── scripts/gate/checks/security-identity.ts ────────────────────────────────────────────
  {
    check: "scripts/gate/checks/security-identity.ts",
    target: "the team a person acts for is stored, not asserted",
    assertion: "changing which team somebody acts for is recorded as an event",
    subject: "services/gateway/src/access-door.ts",
    find: '      logEvent({ actor: email, kind: "team.switch", subject: slug, teamSlug: slug });',
    replace: '      logEvent({ actor: email, kind: "team.change", subject: slug, teamSlug: slug });',
    planted: "switching team stops being recorded under the kind anything looks for, so who " +
      "was acting for which team, and when, leaves no readable trace — on a platform whose " +
      "whole point is who approved what and when, that is the one state change nobody can " +
      "reconstruct afterwards",
  },
  {
    check: "scripts/gate/checks/security-identity.ts",
    target: "a tool picks the caller's team the platform's way",
    assertion: "a tool reading memberships does not select one of them itself",
    subject: "services/gateway/src/access-door.ts",
    find: "      if (!done.rowCount) {",
    replace: "      if (!done.rowCount) {\n" +
      "        const rows = (await db.query<{ slug: string }>(\n" +
      '          "select t.slug from zz.membership m join zz.team t on t.id = m.team_id" +\n' +
      '          " join zz.principal p on p.id = m.principal_id where lower(p.email) = $1' +
      ' order by t.slug",\n' +
      "          [email])).rows;\n" +
      '        if (rows[0]) return text("you are now acting for " + rows[0].slug + ".");',
    planted: "team_switch answers with a team the caller never chose, by taking the first row " +
      "of its own differently ordered query — somebody who is a member of alpha and an admin " +
      "of beta is told alpha while every other call on the platform acts for beta, and no " +
      "other check sees it because both answers are a team the person really is in",
  },
  {
    check: "scripts/gate/checks/security-identity.ts",
    target: "identity is a port, and a door that says no ends the request",
    assertion: "a refusing adapter ends the request rather than yielding to the next",
    subject: "services/gateway/src/identity.ts",
    find: '    if (got && "refuse" in got) return got;   ' +
      "// this door said no: stop, do not try another",
    replace: '    if (got && "refuse" in got) continue;   // try the next door',
    planted: "a door that refuses no longer ends the request — a revoked PAT falls through to " +
      "the forwarded-header adapter and comes back out as an unauthenticated header claim, " +
      "which is the exact opposite of revoking it",
  },
  {
    check: "scripts/gate/checks/security-identity.ts",
    target: "a caller's email is normalised at the boundary, never at the call site",
    assertion: "parseCaller is where the address becomes canonical",
    subject: "packages/contracts/src/identity.ts",
    find: '    email: one(headers["x-zz-user-email"]).trim().toLowerCase(),',
    replace: '    email: one(headers["x-zz-user-email"]).trim(),',
    planted: "there is no longer a place where the caller's address becomes one spelling, so " +
      "every comparison depends on what the sender happened to send — the forwarded caller a " +
      "gateway with no platform database passes straight through reads their own draft as " +
      "somebody else's and is told to open a second initiative",
  },
  {
    check: "scripts/gate/checks/security-identity.ts",
    target: "the request-scoped header store is only read where it exists",
    assertion: "a function express handed a request does not read the MCP header store",
    subject: "services/zz-core/src/server.ts",
    find: '    console.warn(`refused ${req.method} ${req.url} from ${addr || "an unknown peer"}`);',
    replace: "    const who = parseCaller(requestHeaders()).email;\n" +
      '    console.warn(`refused ${req.method} ${req.url} from ${addr || "an unknown peer"}' +
      ' for ${who || "an unknown caller"}`);',
    planted: "the trusted-peer middleware reads the request-scoped header store, which only " +
      "serveMcp ever enters — express called this one, so the bag is empty, the address is " +
      "always the empty string and the refusal log names no caller at all while looking as " +
      "though it does",
  },
  {
    check: "scripts/gate/checks/security-identity.ts",
    target: "nothing picks a team by taking the first membership row",
    assertion: "the team named to a person is the team the platform scopes them by",
    subject: "services/gateway/src/settings.ts",
    find: "    actingFor: id.activeTeam,",
    replace: "    actingFor: teams[0].slug,",
    planted: "the one line that tells a person which team they are acting for names the " +
      "alphabetically first team they belong to instead of the one every call is scoped by. " +
      "The data stays right and only the label is wrong, which is worse in one specific way: " +
      "that sentence is what a reader would use to notice a mistake. This expression is " +
      "forbidden by two checks in this file, so the row turns both red and only one is its " +
      "target",
  },

  // ── scripts/gate/checks/security-secrets.ts ─────────────────────────────────────────────
  {
    check: "scripts/gate/checks/security-secrets.ts",
    target: "no proxy forwards the caller's credentials upstream",
    assertion: "a header-copy loop drops the credential headers",
    subject: "services/gateway/src/relay.ts",
    find: "        if (HOP_HEADERS.has(lk) || NEVER_FORWARD.has(lk)) continue;",
    replace: "        if (HOP_HEADERS.has(lk)) continue;",
    planted: "the one relay both the core door and every block door pass through copies the " +
      "caller's Authorization header upstream, so a third party receives the PAT that " +
      "authenticates as that person against this platform — and nothing about the call fails",
  },
  {
    check: "scripts/gate/checks/security-secrets.ts",
    target: "anything that stores a credential can also remove it",
    assertion: "a tool that writes into the credential store has a counterpart that removes",
    subject: "services/gateway/src/access-door.ts",
    find: '  server.registerTool(\n    "team_mine",',
    replace: "  server.registerTool(\n" +
      '    "credential_set_mine",\n' +
      "    {\n" +
      "      description:\n" +
      '        "WHEN you want your own key used for a block instead of the team\'s. RETURNS " +\n' +
      '        "confirmation that it is stored. REFUSES a request it cannot identify.",\n' +
      "      inputSchema: { api_key: z.string() },\n" +
      "    },\n" +
      "    async ({ api_key }) => {\n" +
      '      if (!id) return text("ERROR: no user identity on this request");\n' +
      '      return text("stored a key of " + api_key.length + " characters");\n' +
      "    },\n" +
      "  );\n\n" +
      '  server.registerTool(\n    "team_mine",',
    planted: "a tool that stores a person's own block key ships with no counterpart that " +
      "removes one, so a key put into the store can never be taken out — deactivating the " +
      "person stops them authenticating and leaves the platform going on injecting their key, " +
      "which is no answer at all when the reason to remove one is that it leaked",
    caveat: "this check selects setters by NAME, and its own comment records that the " +
      "verb-first selector matches nothing on today's noun-first surface — there are in fact " +
      "no credential tools on this door at all, so the loop runs zero times and the check " +
      "cannot currently fail. This row adds the surface the check was written for and shows " +
      "it fires on that; it does not show the check covers anything that ships today",
  },
  {
    check: "scripts/gate/checks/security-secrets.ts",
    target: "no deployment ships with a password we chose",
    assertion: "a secret-shaped variable has no default in compose",
    subject: "deploy/docker-compose.yml",
    find: "      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD" +
      " — openssl rand -hex 16}",
    replace: "      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-change-me}",
    planted: "the documented install completes and the platform comes up, on a database whose " +
      "password is published in this repository — the database holding the team registry and " +
      "the entire audit record. Nothing fails, which is the defect, and POSTGRES_BIND exists " +
      "so an operator can put that database on a tailnet where the default is reachable by " +
      "everyone on it",
  },
  {
    check: "scripts/gate/checks/security-secrets.ts",
    target: "a platform token is one shape, whoever writes or reads it",
    assertion: "the shell minter and the contract agree on what a token is",
    subject: "deploy/issue-first-pat.sh",
    find: "openssl rand -hex 24",
    replace: "openssl rand -hex 32",
    planted: "the one minter that cannot import the contract — it runs as root on a host with " +
      "no toolchain — mints a token of a different length from the one @zz/contracts defines, " +
      "so the FIRST token on a fresh platform is not a token anything else recognises and " +
      "nobody can log in on the day it is installed",
  },

  // ── scripts/gate/checks/data-sql.ts ─────────────────────────────────────────────────────
  {
    check: "scripts/gate/checks/data-sql.ts",
    target: "a team whose store is gone loses its index rows",
    assertion: "a vanished team's decisions go with its documents",
    subject: "packages/indexing/src/index.ts",
    find: '    await p.query("delete from zz.decision where team_slug=$1", [teamSlug]);',
    replace: "    // the claims go with the documents when the per-document reap runs",
    planted: "a team whose store was removed keeps every claim derived from its documents for " +
      "good — indexDoc is what clears them and it never runs for a document that is gone, so " +
      "the rows stay joined to a path nothing will ever produce again. The two tables are " +
      "keyed the same way and only one is being cleaned, which is the bug this function " +
      "already fixed once for a single document",
  },
  {
    check: "scripts/gate/checks/data-sql.ts",
    target: "a database read is not silently cut off at one megabyte",
    assertion: "every psql invocation bounds its own output",
    subject: "packages/tools/src/lib/psql.ts",
    find: '{ input: sql, encoding: "utf8", maxBuffer: MAX_OUTPUT, stdio: ["pipe", "pipe", "pipe"] }',
    replace: '{ input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }',
    planted: "an answer over a megabyte is truncated where execFileSync kills the child, and " +
      "the only symptom is JSON that stops parsing — every tool reading this database breaks " +
      "at exactly the volume the platform exists to produce, and the refusal blames the " +
      "operator's psql command, which is the one thing that was working",
  },
  {
    check: "scripts/gate/checks/data-sql.ts",
    target: "a document's two derived tables are cleaned together",
    assertion: "the per-document reap removes the claims as well as the document",
    subject: "packages/indexing/src/index.ts",
    find: '    await p.query("delete from zz.decision where team_slug=$1 and initiative=$2' +
      ' and path=$3",\n      [teamSlug, g.initiative, g.path]);',
    replace: "    // indexDoc clears a document's claims before re-deriving them",
    planted: "a deleted or renamed document leaves its derived claims behind permanently — the " +
      "reap knows about zz.doc and not about the second table keyed the same way, so the " +
      "predictions stay, joined to a path that will never be produced again",
  },
  {
    check: "scripts/gate/checks/data-sql.ts",
    target: "the platform database is reached one way",
    assertion: "no caller writes the transport's own result envelope by hand",
    subject: "packages/tools/src/ops/watch-results.ts",
    find: '    "select team_slug, initiative, path, status, outcome, updated_at from zz.doc", {});',
    replace: "    \"select coalesce(json_agg(row_to_json(t)), '[]') from (\" +\n" +
      '    "  select team_slug, initiative, path, status, outcome, updated_at' +
      ' from zz.doc) t", {});',
    planted: "a caller writes psqlRows' own json_agg envelope by hand, so the rows come back " +
      "wrapped twice and the tool reads nothing — composing that wrapper is the transport's " +
      "job, and a hand-written one is how the rule it carries, statement on stdin and never " +
      "through -c, starts being decided per call site again",
  },
  {
    check: "scripts/gate/checks/data-sql.ts",
    target: "nothing queries a table the migrations dropped",
    assertion: "every zz.<table> a statement names is one the replayed migrations leave standing",
    subject: "packages/tools/src/ops/plugin-surface.ts",
    find: "      select name, door from zz.plugin_tool",
    replace: `      select name, door from ${DROPPED_TABLE}`,
    planted: "the surface report reads the table migration 058 dropped, left behind by the " +
      "rename that moved the surface onto the plugin — the statement errors at run time and " +
      "takes whatever reads its result with it, and no compiler can see it because the SQL " +
      "is a template literal",
  },
  {
    check: "scripts/gate/checks/data-sql.ts",
    target: "a column the platform enforces is a column something can write",
    assertion: "a timestamp column that gates access is one something sets",
    subject: "services/gateway/src/passkey.ts",
    find: "set used_at = now()",
    replace: "set consumed_at = now()",
    planted: "an enrolment link is never marked as used, so the one-time token stays usable " +
      "for as long as it has not expired while the guard on the very next line goes on " +
      "testing a column nothing writes — enforcement without issuance, which reads to anybody " +
      "looking at the schema like a platform that consumes its invitations",
  },
  {
    check: "scripts/gate/checks/data-sql.ts",
    target: "a service reaches its database through one accessor",
    assertion: "nothing outside the accessor consults a lazily built pool",
    subject: "services/zz-core/src/platform-db.ts",
    find: "  return pool;",
    replace: "  return pool;\n}\n\n" +
      "/** Whether this deployment has a database at all. */\n" +
      "export function dbConfigured(): boolean {\n" +
      "  return pool !== undefined;",
    planted: "a second place answers 'does this deployment have a database' by reading the " +
      "lazily built pool, so that question and 'has anybody connected yet' become the same " +
      "answer and which one it means depends on who ran first — the boot rebuild returning " +
      "0/0/0 for every team is what that looked like the last two times",
  },
  {
    check: "scripts/gate/checks/data-sql.ts",
    target: "a run is attributed to a version by time, not by a column nothing stamps",
    assertion: "an event resolves to the version in force when it happened",
    subject: "services/gateway/src/runs.ts",
    find: "released_at",
    replace: "created_at",
    all: true,
    planted: "a run is attributed to whichever version of a skill was CREATED before the event " +
      "rather than whichever was RELEASED before it — a version drafted months earlier and " +
      "released yesterday claims every run in between, and the table fills with plausible " +
      "rows, which is exactly how the last attribution bug stayed invisible",
  },

  // ── scripts/gate/checks/data-telemetry.ts ───────────────────────────────────────────────
  {
    check: "scripts/gate/checks/data-telemetry.ts",
    target: "an initiative that does not exist yet is not cached as an initiative with no flow",
    assertion: "flowFor caches a hit and never a miss",
    subject: "services/gateway/src/step-trace.ts",
    find: "    if (flow) flowCache.set(key, { flow, at: now });",
    replace: "    flowCache.set(key, { flow, at: now });",
    planted: "the flow lookup caches its misses as well as its hits, so an initiative asked " +
      "about before it existed reads as a flowless initiative for the whole TTL — which is " +
      "exactly the window in which it is opened and its first document written, and which the " +
      "flow's own first instruction walks into every time",
  },
  {
    check: "scripts/gate/checks/data-telemetry.ts",
    target: "every identifier the telemetry keeps is one a tool can send",
    assertion: "the allowlist holds no entry no tool declares",
    subject: "services/gateway/src/tool-telemetry.ts",
    find: '  "old_id", "new_id", "slug", "role",',
    replace: '  "old_id", "new_id", "slug", "role", "open_only",',
    planted: "the allowlist deciding which argument values the platform keeps carries a name " +
      "no tool on any door declares — an entry that cannot be reached reads as a considered " +
      "decision about what may be recorded, and this list is the one place that reasoning is " +
      "supposed to live, so debris in it is worse than debris anywhere else",
  },
  {
    check: "scripts/gate/checks/data-telemetry.ts",
    target: "telemetry keeps identifiers and never the team's own words",
    assertion: "nothing that is content by definition is on the identifier allowlist",
    subject: "services/gateway/src/tool-telemetry.ts",
    find: '  "scope", "status", "prefix", "version", "limit",',
    replace: '  "scope", "status", "prefix", "version", "limit", "title",',
    planted: "document titles start being copied into the telemetry table — the team's own " +
      "words about their own work, in a table people and tooling read, arriving under an " +
      "allowlist whose entire purpose is to keep identifiers and nothing else",
  },
  {
    check: "scripts/gate/checks/data-telemetry.ts",
    target: "a record that is counted is a record that is written once",
    assertion: "the ledger appends one row per close, however many times it is called",
    subject: "services/zz-core/src/persist.ts",
    find: "    if (parseEnvelope(prev).outcome) return; // already closed once",
    replace: "    if (!prev) return; // nothing on disk to compare against",
    planted: "closing an initiative a second time appends a second ledger row while the " +
      "document keeps one outcome, so what OKR grading and flow-compare COUNT and what the " +
      "closing documents SAY disagree — silently, and the disagreement is invisible from " +
      "either side",
  },
  {
    check: "scripts/gate/checks/data-telemetry.ts",
    target: "the platform records its own surface, the way it records everybody else's",
    assertion: "a surface row is written once per version and never rewritten",
    subject: "services/zz-core/src/server.ts",
    find: "          on conflict (plugin_version_id, name) do nothing",
    replace: "          on conflict (plugin_version_id, name) do update set door = excluded.door",
    planted: "the row recording what a version served is rewritten rather than written once, " +
      "so the history agrees with today by construction — a tool that moved between doors " +
      "after a release leaves no trace of having been anywhere else, and a history that " +
      "cannot disagree with the present is the one thing a history must not be",
  },
  {
    check: "scripts/gate/checks/data-telemetry.ts",
    target: "every header the telemetry correlates on is actually sent",
    assertion: "the header the caller key is built from is one the client writes",
    subject: "packages/mcp-client/src/index.ts",
    find: '      "x-zz-client": this.#client,',
    replace: '      "x-zz-agent": this.#client,',
    planted: "the second half of the caller key is never sent, so the key collapses to the " +
      "address and every process acting as one person — a provisioner, a scheduled run and " +
      "that person's own session — shares and overwrites a single skill trace. Nothing " +
      "errors, the key still has two halves, and the numbers stay plausible",
  },
  {
    check: "scripts/gate/checks/data-telemetry.ts",
    target: "a step's version comes from the skill, never from a file beside it",
    assertion: "the hash recorded for a step is the hash of the skill, not of a supporting file",
    subject: "services/gateway/src/step-trace.ts",
    find: "    stepSha: whole ? createHash(\"sha256\").update(servedBody).digest(\"hex\")" +
      ".slice(0, 12) : undefined,",
    replace: '    stepSha: createHash("sha256").update(servedBody).digest("hex").slice(0, 12),',
    planted: "the hash recorded for a step is taken from whatever bytes were served, so " +
      "reading a reference file inside the skill you are following stamps a hash that names " +
      "a version of that skill which does not exist — and the per-version reports that join " +
      "on it quietly stop containing those calls",
  },

  // ── scripts/gate/checks/data-telemetry-reports.ts ───────────────────────────────────────
  {
    check: "scripts/gate/checks/data-telemetry-reports.ts",
    target: "the evolution loop is closed, and separate from what it measures",
    assertion: "a refusal is attributed to the skill the agent was following",
    subject: "packages/tools/src/testing/evolve-report.ts",
    find: '      if (ids.name) following.set(e.caller ?? "", resolveStep(ids.name));',
    replace: "      if (ids.name) void resolveStep(ids.name);",
    planted: "the report stops tracing which skill each actor was following, so every refusal " +
      "recorded before the gateway began stamping the step outright becomes unattributable — " +
      "and 'this step is where it stalls' is the only form of the answer a skill can actually " +
      "be edited from",
  },
  {
    check: "scripts/gate/checks/data-telemetry-reports.ts",
    target: "provenance the platform records is provenance something reads",
    assertion: "a _by column written on every row is selected somewhere",
    subject: "services/gateway/src/admin.ts",
    find: "      `select t.slug, t.name, t.status, t.created_at, c.email as created_by,\n" +
      "              count(m.principal_id)::int as members\n" +
      "         from team t left join membership m on m.team_id = t.id\n" +
      "         left join principal c on c.id = t.created_by`;",
    replace: "      `select t.slug, t.name, t.status, t.created_at, c.email as creator,\n" +
      "              count(m.principal_id)::int as members\n" +
      "         from team t left join membership m on m.team_id = t.id\n" +
      "         left join principal c on c.id = t.id`;",
    planted: "who set a team up goes back to being written on every row and read by nothing, " +
      "so 'who created this team' can only be answered by opening the database by hand — " +
      "which is the same answer as not having recorded it, in the form that looks most like " +
      "compliance",
  },
  {
    check: "scripts/gate/checks/data-telemetry-reports.ts",
    target: "a report counting an activity counts the ones that happened",
    assertion: "a count of an activity asks whether the call succeeded",
    subject: "packages/tools/src/testing/evolve-report.ts",
    find: '    if (tool === "document_revise" && e.ok) s.revisions += 1;',
    replace: '    if (tool === "document_revise") s.revisions += 1;',
    planted: "the revision count includes calls that were refused, so a step that tried five " +
      "times and got through once reports five revisions — the number the improvement loop " +
      "reads says the opposite of what happened",
  },
  {
    check: "scripts/gate/checks/data-telemetry-reports.ts",
    target: "a telemetry field a report reads is a field something writes",
    assertion: "a reader scoping on a kind reads a kind something attributes",
    subject: "services/gateway/src/tool-telemetry.ts",
    find: "          teamSlug: req.zzIdentity?.activeTeam ?? null,",
    replace: "          // a measurement is not a team's property",
    planted: "every tool call is written with no team, on the busiest kind of row there is — " +
      "flow-compare counts each one UNATTRIBUTED and watch-results builds 'a team has gone " +
      "quiet' out of a column that is always null. Both run, both report nothing, and nothing " +
      "is wrong as far as either can tell: an absent team reads exactly like a quiet platform",
  },
  {
    check: "scripts/gate/checks/data-telemetry-reports.ts",
    target: "a count of what is on this deployment says when it was counted",
    assertion: "a live count in shipped prose carries the date it was taken",
    subject: "catalog/sdlc/sdlc-flow/skills/sdlc-recall/SKILL.md",
    find: "Measured on this deployment on 2026-09-21: across eight common",
    replace: "On this deployment, across eight common",
    planted: "a shipped skill states a live measurement of this deployment's own corpus in the " +
      "present tense with no date, so a count that was true of one week is read as current " +
      "for ever by every tenant who loads the skill — the reasoning stays sound and the tense " +
      "is what rots",
  },
  {
    check: "scripts/gate/checks/data-telemetry-reports.ts",
    target: "whether a refusal taught anything is one judgement",
    assertion: "the judgement is not a length floor",
    subject: "packages/tools/src/lib/refusal.ts",
    find: "  return useful.length >= 3;",
    replace: "  return useful.length >= 3 || text.trim().length >= 40;",
    planted: "a length floor comes back beside the judgement, so 'RPC ERROR: request failed " +
      "with status code 422' — forty-six characters, the commonest shape this engine produces " +
      "and the one quoted as the reason the rule exists — scores as a refusal that taught the " +
      "rule, and the conformance answer and the usage answer disagree again",
  },
];
