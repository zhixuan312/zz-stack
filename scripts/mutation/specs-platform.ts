/**
 * Defects planted in the platform's own code — services, packages, scripts, deploy.
 *
 * TWO KINDS OF SUBJECT, AND THE DIFFERENCE IS STATED RATHER THAN BLURRED. Some checks here
 * RUN something (the monitor's exit status, the scope resolver through its own probe) and the
 * defect changes what it does. Others READ source text for a shape that has hurt this
 * repository before — a null parameter standing in for "every team", a second psql transport,
 * an envelope line rendered by hand — and for those the planted defect IS that shape, put
 * into the file the check examines. In both cases the check's own name and its comments are
 * untouched: nothing in this directory can write to `scripts/gate/`.
 */
import type { MutationSpec } from "./plant.ts";

export const PLATFORM_SPECS: readonly MutationSpec[] = [
  {
    check: "scripts/gate/checks/build.ts",
    target: "a package that imports a workspace package declares it",
    subject: "packages/indexing/package.json",
    find: '    "@zz/contracts": "*",\n',
    replace: "",
    planted: "the indexing package stops declaring the workspace package its source imports, " +
      "so the dependency holds only by the root install happening to have hoisted it",
  },
  {
    check: "scripts/gate/checks/catalog-servers.ts",
    target: "every server a manifest declares is a door the gateway mounts",
    subject: "services/gateway/src/server.ts",
    find: '  "/eval/mcp": { name: "zz-plugin-eval"',
    replace: '  "/eval/mcpx": { name: "zz-plugin-eval"',
    planted: "the evaluation door is mounted at a path one character off the one every " +
      "manifest declares, so the flow's clients reach nothing",
  },
  {
    check: "scripts/gate/checks/config-env.ts",
    target: "the documented defaults are the actual defaults",
    subject: "deploy/.env.example",
    find: "# CRED_PROXY_PORT=8764",
    replace: "# CRED_PROXY_PORT=8765",
    planted: "the documented default port disagrees with the one compose actually uses, so an " +
      "operator uncommenting the line moves a service nobody asked to move",
  },
  {
    check: "scripts/gate/checks/console.ts",
    target: "a console query cannot fall back to every team",
    subject: "services/gateway/src/console/knowledge.ts",
    find: "        where team_slug = $1",
    replace: "        where ($1::text is null or team_slug = $1)",
    planted: "a null team parameter makes the predicate true for every row, so a caller who " +
      "simply omits ?team= is served every team's knowledge",
  },
  {
    check: "scripts/gate/checks/data-sql.ts",
    target: "a SELECT DISTINCT is ordered only by columns it selects",
    subject: "services/zz-core/src/tenant-info/corpus-registry.ts",
    find: "    select distinct corpus_key, owner_id, artifact_id, 'current'::text as scope from zz.search_current",
    replace: "    select distinct corpus_key, owner_id, artifact_id, 'current'::text as scope from zz.search_current order by updated_at",
    planted: "a SELECT DISTINCT is ordered by a column it does not select, which Postgres " +
      "rejects at parse time — every caller of the route above it gets a 500",
  },
  {
    check: "scripts/gate/checks/data-telemetry.ts",
    target: "a tool that changes something records that it did",
    subject: "services/zz-core/src/tools/artifacts.ts",
    // BOTH RECORDERS. Removing `logActivity` alone left `commitStore` in the same body, which
    // the check also accepts as a record — correctly, since a commit IS one — so the first
    // attempt planted a defect the check does not claim to detect and it survived, as it
    // should have. The defect this check is about is a mutation with NO record at all.
    find: '      logActivity(root, rel, { user: who.email, action: "source_add", path: rel, supports: list.join(",") });\n      commitStore(root, who.email, "source", rel);',
    replace: "      void [logActivity, commitStore, who];",
    planted: "a tool that writes the store stops recording that it did, so the change can " +
      "only be recovered by reading the state it made",
  },
  {
    check: "scripts/gate/checks/deploy-compose.ts",
    target: "the compose file names this release's images",
    subject: "deploy/docker-compose.yml",
    // THE TAG, NOT THE REPOSITORY. A first attempt renamed the image repository and this
    // check did not notice, because it reads only the `ZZ_VERSION:-…` literal and compares it
    // to package.json — so a repository that drifted is outside what it measures, whatever its
    // name suggests. Recorded as a finding about the check's reach; the mutation moved to what
    // it does measure. The tag itself is never written out here, only prefixed, so this file
    // carries no version literal of its own.
    find: "ZZ_VERSION:-",
    replace: "ZZ_VERSION:-stale-",
    all: true,
    planted: "the compose image tag stops naming this release, so a bundle that looks correct " +
      "pulls the previous version on every host",
  },
  {
    check: "scripts/gate/checks/deploy-ops.ts",
    target: "the monitor treats its own silence as a failure",
    subject: "packages/tools/src/ops/watch-results.ts",
    find: "    return 2;",
    replace: "    return 0;",
    planted: "the monitor exits successfully on a window with no activity at all, so being " +
      "pointed at nothing reads as an all-clear",
  },
  {
    check: "scripts/gate/checks/deploy-release.ts",
    target: "no release document points at a repository path that does not exist",
    subject: "README.md",
    find: "`deploy/README.md`",
    replace: "`deploy/INSTALL.md`",
    all: true,
    planted: "a release document sends an installer to a repository path that does not " +
      "resolve, which reads as the instructions having been withdrawn",
  },
  {
    check: "scripts/gate/checks/documents-envelope.ts",
    target: "one function decides what a document's envelope says",
    subject: "services/zz-core/src/indexing.ts",
    find: "  return renderEnvelope(",
    replace: "  const line = (k: string, v: string): string => `${k}: ${v}`;\n  void line;\n  return renderEnvelope(",
    planted: "an envelope line is rendered by hand outside the one renderer, which is how a " +
      "second status: line reached a document and two tools reported two different truths",
  },
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "no statement is written twice in a row",
    subject: "services/gateway/src/scope.ts",
    // NOT the final `return { kind: "team", slug }`: duplicating THAT one puts the copy in
    // unreachable code, where TypeScript drops the narrowing that made `slug` a string, and the
    // planted defect arrives with a type error beside it. A refusal carries nothing narrowed.
    find: '    return { kind: "refused", status: 400, error: "team must be a slug" };',
    replace: '    return { kind: "refused", status: 400, error: "team must be a slug" };\n' +
      '    return { kind: "refused", status: 400, error: "team must be a slug" };',
    planted: "a statement is duplicated onto the line below itself — the debris an edit that " +
      "copies a line instead of moving it leaves, which reads as deliberate until somebody looks",
  },
  {
    check: "scripts/gate/checks/image.ts",
    target: "no fixture directory enters the image",
    subject: ".dockerignore",
    find: "catalog/**/tests",
    replace: "catalog/*/tests",
    planted: "the fixture exclusion stops matching the nested tests directories the catalog " +
      "actually has, so every flow's expectations ship inside the release image",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    target: "_knowledge is never recorded as an initiative",
    subject: "services/gateway/src/runs.ts",
    find: "     where e.initiative is not null and e.initiative not in ('', '_knowledge')",
    replace: "     where e.initiative is not null and e.initiative <> ''",
    planted: "the reserved knowledge directory stops being excluded from the initiative " +
      "insert, so every deployment grows a _knowledge initiative with runs filed against it",
  },
  {
    check: "scripts/gate/checks/security-identity.ts",
    target: "authority is decided by one function, never by comparing the role",
    subject: "services/gateway/src/scope.ts",
    find: '  if (req.query.scope === "platform" && isSuper(id)) return { kind: "platform" };',
    replace: '  if (req.query.scope === "platform" && id.platformRole === "superadmin") return { kind: "platform" };',
    planted: "authority is decided by comparing the role instead of by the one function that " +
      "also weighs how the caller authenticated, so a token bound to one team reaches every team",
  },
  {
    check: "scripts/gate/checks/security-secrets.ts",
    target: "nothing in this repository discloses an address, a host or a credential",
    subject: "deploy/.env.example",
    find: "# POSTGRES_PORT=5432",
    replace: `# POSTGRES_PORT=5432   # reachable at ${[93, 184, 216, 34].join(".")}`,
    redact: true,
    planted: "a routable host address is written into a shipped configuration example — built " +
      "from four numbers here, and redacted in the report, so neither this file nor the " +
      "artifact becomes the disclosure the check exists to refuse",
  },
  {
    check: "scripts/gate/checks/suites.ts",
    target: "scope and authority refuse what they say they refuse",
    subject: "services/gateway/src/scope.ts",
    find: "  if (!id.teams.some((t) => t.slug === slug) && !isSuper(id)) {",
    replace: "  if (!id.teams.some((t) => t.slug === slug) && !isSuper(id) && slug === \"\") {",
    planted: "membership stops being required, so a caller naming any team slug is scoped to " +
      "that team's data whether or not they belong to it",
  },
];
