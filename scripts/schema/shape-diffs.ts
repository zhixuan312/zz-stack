/**
 * Where a real answer's shape and the console's fake answer's differ: the one comparison every
 * `checks/console-*.ts` that holds a gateway route to its fake makes.
 *
 * At an object both hold, the key sets; at an array both hold, the first elements, the same way; a
 * null on either side, nothing. What a route answers beyond that is named by its check in `rules`,
 * never by a copy of this function, so a fix to the comparison reaches every check at once.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** A path is the keys that lead to an object, dot-joined (`summary.byKind`), and it matches
 *  wherever the comparison reaches that object, under whatever path the caller started from. */
interface ShapeRules {
  /** Records keyed by data, such as a count per kind: their keys are not a shape, so nothing under
   *  them is compared. */
  readonly keyedByData?: readonly string[];
  /** Records keyed by data whose values are counts: held to whole numbers instead of compared. */
  readonly counts?: readonly string[];
  /** An array filled on one side and empty on the other is a difference: its elements went
   *  uncompared, so the comparison would otherwise pass on a shape it never saw. */
  readonly bothFilled?: boolean;
}

const reaches = (path: string, names: readonly string[] | undefined): boolean =>
  (names ?? []).some((p) => path === p || path.endsWith(`.${p}`));

/** The fields `console/read-envelope.ts` stamps on every console GET answer, which describe the request that asked and
 *  never the figures: no fixture can state them, because a fixture has no request. */
export const REQUEST_SCOPED: ReadonlySet<string> = new Set(["observedAt", "revision", "cacheHit", "builtAt", "sourceRevision"]);

/** Every difference, appended to `out` (which is also answered), each naming its path. */
export function shapeDiffs(a: unknown, b: unknown, path: string, out: string[], rules: ShapeRules = {}): string[] {
  if (a === null || b === null || reaches(path, rules.keyedByData)) return out;
  if (reaches(path, rules.counts)) {
    if (!isObj(a) || !Object.values(a).every((n) => Number.isInteger(n))) out.push(`${path} is ${JSON.stringify(a)}, not counts by key`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length && b.length) shapeDiffs(a[0], b[0], `${path}[0]`, out, rules);
    else if (rules.bothFilled && a.length !== b.length) out.push(`${path} is empty on one side, so its elements were not compared`);
  } else if (isObj(a) && isObj(b)) {
    // The fields that describe the REQUEST rather than the figures. A console route is answered by the read-envelope
    // middleware, which stamps `observedAt`, `revision`, `cacheHit`, `builtAt` and `sourceRevision` on its `meta`; a
    // fixture answers what the figures are and has no request to describe, so it can never state them. They are compared
    // where they belong — `checks/console-read-envelope.ts` proves every console GET carries them and
    // `checks/console-read-contract.ts` proves their values — and not against a fixture that is not asked for them.
    //
    // DELIBERATE: the mask is keyed on the PATH, never on the name alone. Filtering these five names at every object
    // would stop comparing a data field that happens to share one: a document's `versions[]` each hold a `revision`,
    // and the snapshot route answers `{ version, revision, body }`. A check that compared one of those would have gone
    // silently blind to it, and a field dropped or renamed there would ship green.
    const atMeta = path === "meta" || path.endsWith(".meta");
    const kept = (o: Obj): string[] =>
      Object.keys(o).filter((k) => !(atMeta && REQUEST_SCOPED.has(k))).sort();
    const ka = kept(a);
    const kb = kept(b);
    if (ka.join() !== kb.join()) out.push(`${path || "the answer"} has keys {${ka.join(", ")}} where the fake has {${kb.join(", ")}}`);
    for (const k of ka.filter((x) => kb.includes(x))) shapeDiffs(a[k], b[k], path ? `${path}.${k}` : k, out, rules);
  }
  return out;
}
