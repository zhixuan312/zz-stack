/**
 * The shell that records the outgoing version as the rollback target, run on the host before the switch so `--rollback`
 * works even if the release dies halfway.
 *
 * DELIBERATE: a release that redeploys the version already running writes nothing. The target on the host is then the
 * version the release that moved it there recorded, and overwriting it with the running version would leave
 * `--rollback` reading `ZZ_PREVIOUS_VERSION=<running>`, which rollback() treats as nothing to do.
 */
export function recordRollbackTarget(key: string, outgoing: string, incoming: string): string {
  if (outgoing === incoming) return "true";
  return `{ grep -q '^${key}=' .env && sed -i 's/^${key}=.*/${key}=${outgoing}/' .env || echo '${key}=${outgoing}' >> .env; }`;
}
