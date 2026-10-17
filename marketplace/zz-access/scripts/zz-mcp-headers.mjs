// Supplies the ZZ platform bearer token to the client as MCP connection
// headers. Read at connect time and never stored in the package, so the
// token never lands in a file that gets committed.
//
// Resolution order:
//   1. $ZZ_TOKEN        (env override)
//   2. $ZZ_TOKEN_FILE   (explicit path)
//   3. ~/.zz/token      (written by the install step, mode 600)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let token = process.env.ZZ_TOKEN || null;
if (token === null) {
  const file = process.env.ZZ_TOKEN_FILE || join(homedir(), ".zz", "token");
  try { token = readFileSync(file, "utf8").replace(/[\r\n]/g, ""); } catch { token = null; }
}
// No token: emit no credential rather than failing the connection, so the
// person sees an auth error they can act on instead of a silent no-op.
const headers = token === null
  ? { "X-ZZ-Client": "zz-plugin" }
  : { Authorization: "Bearer " + token, "X-ZZ-Client": "zz-plugin" };
process.stdout.write(JSON.stringify(headers) + "\n");
