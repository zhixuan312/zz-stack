/**
 * Operator tool: store people's personal building-block keys, in batch.
 *
 *   npm run set-credential -- --csv keys.csv
 *   ZZ_BLOCK_KEY='...' npm run set-credential -- --email alice@x --platform casebox
 *   npm run set-credential -- --email alice@x --platform casebox --delete
 *
 * CSV columns: Email,Platform,Key — header row optional. A two-column row (Email,Key) uses
 * --platform, which is REQUIRED then: there is no default block, for the same reason there is
 * no default gateway. A key stored against the wrong block authenticates as nobody, and every
 * row still prints OK.
 *
 * THE KEY IS NOT AN ARGUMENT. It used to be `--key '...'`, which put somebody else's
 * building-block credential into `ps` for every user on the host and into the operator's
 * shell history, where it stays. $ZZ_BLOCK_KEY is in neither. The CSV path never had the
 * problem — a file has permissions.
 *
 * Auth: the caller's own platform token, resolved by platformToken() — $ZZ_TOKEN, then
 * $ZZ_TOKEN_FILE, then ~/.zz/token. One token per person, carrying whatever that person may
 * do; there is no separate admin credential to keep beside it.
 *
 * This command stores a key ON SOMEBODY ELSE'S BEHALF, which needs admin authority. A token
 * deliberately CONFINED to member scope is refused by the gateway for exactly that — acting
 * for another person is what a narrowed token exists to prevent — so if you confined the
 * token you are holding, this is where you find out.
 *
 * --url, or $ZZ_URL, and there is NO DEFAULT on purpose. It used to fall back to the gateway
 * of the deployment this repo happens to be developed on, so an operator installing this
 * stack elsewhere and running the command as documented sent THEIR admin token, in an
 * Authorization header, to somebody else's host. It would be refused there, which is the
 * good case; what it cannot be is silent. The platform removed the same fallback from
 * GATEWAY_PUBLIC_URL for the same reason.
 *
 * WHY THIS TALKS TO THE GATEWAY. It used to `docker exec <cred-proxy> python -c` a script
 * that opened /data/credentials.json and rewrote it. Two things were wrong with that, and
 * the first hid the second: the container is Alpine + Node and had no python at all, so the
 * documented batch-import path had never once run. Underneath, writing the file directly
 * bypassed the serialisation and the atomic replace the gateway does — so a batch racing one
 * person storing their own key would have dropped a write, and a crash mid-write would have
 * truncated the file and lost every stored key on the platform.
 *
 * People can always do their own with the ZZ Access agent (credential_set). This is for
 * onboarding several at once.
 */
import { readFileSync } from "node:fs";

import { Mcp, McpError } from "@zz/mcp-client";

import { die, optional, parseArgs, platformToken } from "../lib/cli.js";

const token = (): string => platformToken();

/** A CSV row, split on commas with no quoting.
 *
 * The keys this reads are opaque tokens and the emails are addresses; neither carries a
 * comma. A real CSV parser here would be a dependency bought to handle input this format
 * does not have. */
const splitRow = (line: string): string[] => line.split(",");

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, ["delete"]);
  const url = args.flags.get("url") || (process.env.ZZ_URL ?? "").trim();
  // NO DEFAULT, for the reason --url has none. This was "casebox" — one block on one deployment —
  // so an operator who forgot the flag stored a batch of people's keys against a block that
  // was not the one the keys are for. Every one of those authenticates as nobody, and the
  // tool prints OK for all of them. A three-column CSV carries its own platform per row and
  // needs no flag; everything else has to say which block.
  // Through optional(), all three. Given with nothing after it, each read as ABSENT and fell
  // into a message about the flag being missing — "provide --email with --delete" to an
  // operator who had just typed --email. optional() says which flag needs a value; the
  // messages below still answer the genuinely-absent case.
  const platformDefault = optional(args, "platform", "which block these keys are for") ?? "";
  const email = optional(args, "email", "the person whose key this is");
  const csv = optional(args, "csv", "a CSV of Email,Platform,Key rows");
  const remove = args.flags.has("delete");

  if (!url) {
    die(
      "no platform gateway address: pass --url or set $ZZ_URL. There is no default — a " +
        "wrong one would send your admin token to somebody else's host.",
    );
  }

  const rows: { email: string; platform: string; key: string }[] = [];
  // Skipped rows are COUNTED, not just mentioned. Both skips below print to stderr and then
  // dropped out of the row count, so a ten-row CSV with three bad lines finished with
  // "7/7 applied" and exit 0 — the operator reads that as done, and three people are holding
  // no key. A skip is a row that did not get what it came for.
  let skipped = 0;

  if (csv) {
    for (const raw of readFileSync(csv, "utf8").split("\n")) {
      const row = splitRow(raw).map((c) => c.trim());
      if (raw.trim() === "" || row[0].toLowerCase() === "email") continue;
      if (row.length < 2 || row.length > 3) {
        console.error(`SKIP  malformed row (want Email,Key or Email,Platform,Key): ${raw.trim()}`);
        skipped++;
        continue;
      }
      const platform = row.length > 2 ? row[1] : platformDefault;
      if (!platform) {
        // Which of the two ways it got here. `alice@x,,secret` is a three-column row with an
        // empty middle, and it was reported as "two-column row and no --platform" — a skip
        // naming a cause the row does not have sends the operator to the command line to fix
        // something that is wrong in the file.
        console.error(row.length > 2
          ? `SKIP  ${row[0]}: the platform column is empty, so which block this key is for is unknown`
          : `SKIP  ${row[0]}: two-column row and no --platform, so which block this key is for is unknown`);
        skipped++;
        continue;
      }
      const key = row[row.length - 1];
      // The key was taken as the last column with no length check, so a spreadsheet export
      // with a trailing empty column — alice@x,casebox,secret, — stored an EMPTY key and printed
      // OK. The person is then holding a credential that authenticates as nobody, and the
      // tool told the operator it worked.
      if (!key && !remove) {
        console.error(`SKIP  ${row[0]}: empty key`);
        skipped++;
        continue;
      }
      rows.push({ email: row[0], platform, key });
    }
  } else if (remove) {
    if (!email) die("provide --email with --delete");
    if (!platformDefault) die("provide --platform: which block's key to delete");
    rows.push({ email, platform: platformDefault, key: "" });
  } else {
    const key = (process.env.ZZ_BLOCK_KEY ?? "").trim();
    if (!email || !key) die("provide --email with $ZZ_BLOCK_KEY set, or --csv, or --email --delete");
    if (!platformDefault) die("provide --platform: which block this key is for");
    rows.push({ email, platform: platformDefault, key });
  }

  // One session for the whole batch. Re-initialising per row would work and would also leave
  // N sessions on the server for one batch; the transport keeps them until they time out.
  const mcp = new Mcp(`${url.replace(/\/+$/, "")}/manage/mcp`, { pat: token(), client: "set-credential" });

  let ok = 0;
  for (const { email: who, platform, key } of rows) {
    let out: string;
    try {
      out = remove
        ? await mcp.call("credential_admin_delete", { user_email: who, platform })
        : await mcp.call("credential_admin_set", { user_email: who, platform, api_key: key });
    } catch (err) {
      // Transport and protocol failures stop the batch. Unlike a refusal, they say nothing
      // about THIS row — carrying on would print N identical failures and bury the one
      // sentence that explains them.
      if (err instanceof McpError) die(err.message);
      throw err;
    }
    // The gateway reports refusals as tool text, not as HTTP errors, so a batch must read
    // what came back rather than assume 200 meant stored.
    if (out.startsWith("ERROR:")) console.log(`FAIL  ${who} ${platform}: ${out}`);
    else {
      ok++;
      console.log(`OK    ${out}`);
    }
  }

  const total = rows.length + skipped;
  console.log(
    `\n${ok}/${total} applied via ${url}` +
      (skipped ? ` (${skipped} skipped before sending — see the SKIP lines above)` : ""),
  );
  return ok === total ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
