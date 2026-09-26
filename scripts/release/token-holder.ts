/**
 * Who a token belongs to, asked of the deployment it is for: `/manage`'s whoami, which answers
 * every role. The release names this beside a probe it could not run, because "no probe token"
 * read as if the operator's own token were missing when ZZ_TOKEN was a member's smoke-test PAT.
 */
import { run } from "../deployment.ts";

/** `"<email> (<platform role>)"`, or null when the deployment could not say. */
export function tokenHolder(gateway: string, token: string): string | null {
  if (!gateway || !token) return null;
  try {
    const out = run("curl", ["-s", "-m", "20", "-H", `Authorization: Bearer ${token}`,
      "-H", "content-type: application/json", "-H", "accept: application/json, text/event-stream",
      "-d", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }),
      `${gateway}/manage/mcp`]);
    const body = out.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? out;
    const text = (JSON.parse(body) as { result?: { content?: { text?: string }[] } }).result?.content?.[0]?.text ?? "";
    const id = JSON.parse(text) as { email?: string; platformRole?: string };
    return id.email ? `${id.email} (${id.platformRole ?? "unknown role"})` : null;
  } catch { return null; }
}
