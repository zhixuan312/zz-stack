/**
 * Split a configured command — `--psql "docker compose exec -T postgres psql -U zz -d zz"` —
 * into argv without going through a shell, so nothing on the command line is expanded.
 *
 * Quoting is supported because a path can contain a space. Expansion is not.
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
 * COUPLED: the reports on disk carry this shape and --ledger orders runs by it, so changing
 * the format reorders a history nobody edited. */
export function localStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}
