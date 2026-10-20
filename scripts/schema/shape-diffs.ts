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

/** Every difference, appended to `out` (which is also answered), each naming its path. */
export function shapeDiffs(a: unknown, b: unknown, path: string, out: string[], rules: ShapeRules = {}): string[] {
  if (a === null || b === null || reaches(path, rules.keyedByData)) return out;
  if (reaches(path, rules.counts)) {
    if (!isObj(a) || !Object.values(a).every((n) => Number.isInteger(n))) out.push(`${path} is ${JSON.stringify(a)}, not counts by key`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length && b.length) shapeDiffs(a[0], b[0], `${path}[0]`, out, rules);
    else if (rules.bothFilled && a.length !== b.length) out.push(`${path} is empty on one side, so its elements were not compared`);
  } else if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) out.push(`${path || "the answer"} has keys {${ka.join(", ")}} where the fake has {${kb.join(", ")}}`);
    for (const k of ka.filter((x) => kb.includes(x))) shapeDiffs(a[k], b[k], path ? `${path}.${k}` : k, out, rules);
  }
  return out;
}
