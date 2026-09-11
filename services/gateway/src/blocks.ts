/** The building blocks this gateway knows, and the ONE place that knows them.
 *
 * A block was described in three places that had to agree and had nothing making them:
 * the routing table here, a hand-copied Open WebUI connection map in admin.ts, and each
 * flow's `tools`. They drifted in the direction that is hardest to notice — a block added
 * to the router reached terminal clients on the next request and the browser never, because
 * the copy in admin.ts had never heard of it and said so in a WARNING inside an install
 * report.
 *
 * Everything about a block is now one entry. Adding one is one edit, and the gate checks
 * that the bootstrap agrees with it.
 */
import { PlatformMap, whyNot } from "@zz/contracts";

/** A blank PLATFORMS is ABSENT, not empty.
 *
 * The compose file passed `PLATFORMS=${PLATFORMS:-{}}`, so every deployment that set nothing
 * received a literal `{}` — and `??` only defers to the default when the variable is unset,
 * never when it is blank. The registry below was therefore dead on every fresh install: no
 * blocks at all, /p/<block>/mcp answering 404 for all three. The live host worked only
 * because its .env carried a hand-written fourth copy of this list, which had already
 * drifted from the one here. Blank now means "use the registry", which is the only reading
 * that makes an unset variable and an empty one behave the same. */
const configured = (process.env.PLATFORMS ?? "").trim();

/** The registry, or a sentence and a refusal to start.
 *
 * `JSON.parse` and `PlatformMap.parse` both throw here, at module load, so a mistyped
 * PLATFORMS took the container down with a SyntaxError or a ZodError dump — a wall of JSON
 * whose one useful word is buried, in a log an operator reads while the platform is not
 * starting. @zz/catalog reached the same conclusion about a manifest and says so in
 * manifestAt: the throw is right, the shape of it was not.
 *
 * Refusing to start IS correct. Every block on the platform is described here, and a gateway
 * that starts with a registry it could not read answers 404 for every block and looks like
 * an outage somewhere else. */
function registry(raw: string): PlatformMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`PLATFORMS is not valid JSON — ${(err as Error).message}. It is a map of ` +
                    "block id to { url, header?, name, tools? }; leave it unset to use the " +
                    "registry this image ships.");
  }
  const checked = PlatformMap.safeParse(parsed);
  if (checked.success) return checked.data;
  const why = whyNot(checked.error);
  throw new Error(`PLATFORMS is not a valid block registry — ${why}`);
}

/** The blocks this gateway routes.
 *
 * EMPTY BY DEFAULT, AND THAT IS A REAL STATE. This deployment routes no building block: the
 * two stand-ins were their own repository and went with it on 2026-09-10, and the one real
 * block belonged to work rather than to this project. `/p/<block>/mcp` therefore answers "no
 * such block" for everything, which is the honest answer and the one its own refusal already
 * gives by name.
 *
 * The machinery stays, and is not dead code waiting for a use. It is the whole credential
 * model — a caller's OWN key, looked up per person and injected at the proxy, with the block's
 * own delegated sign-in chained into the same click. Deleting it because nothing is registered
 * today would mean rebuilding it the day something is, and the parts of it that were expensive
 * to get right are not the parts that look expensive.
 *
 * PLATFORMS in the environment overrides this, which is how a block is added without a
 * release: a map of block id to { url, header?, name, tools? }.
 */
export const PLATFORMS: PlatformMap = registry(configured || "{}");

/** Every block id, for validating what an admin or a manifest names. */
export const blockIds = (): string[] => Object.keys(PLATFORMS);

