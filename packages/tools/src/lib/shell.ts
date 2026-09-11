/**
 * Splitting a configured command into argv, without a shell.
 *
 * `--psql "docker compose exec -T postgres psql -U zz -d zz"` is one string an operator
 * types, and it has to become an argv. Running it THROUGH a shell would be the easy way and
 * the wrong one: the command carries a database name and a user from the same command line
 * that carries `--actor <email>`, and a shell would happily expand whatever it found in
 * either.
 *
 * Quoting is supported because a path can contain a space. Expansion is not, because nothing
 * here should want it.
 */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  if (quote) throw new Error(`unbalanced ${quote} in command: ${command}`);
  return out;
}

/** Local time as `YYYY-MM-DDTHH:MM:SS`, with no zone.
 *
 * The same shape the reports already on disk carry, because --ledger orders runs by this
 * field and a format change would reorder a history nobody edited. */
export function localStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}
