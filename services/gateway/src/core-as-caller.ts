/**
 * A zz-core client that acts as the person the request belongs to.
 *
 * The gateway stamps a request's `x-zz-*` headers from the identity it resolved (identity.ts): who
 * is calling, how they authenticated, and the team their console session acts for. zz-core reads
 * its caller from exactly those headers and trusts them because a peer allowlist admits only the
 * gateway, so forwarding them unchanged is what keeps a console route from acting as anybody but
 * the person who pressed the button or asked the question. Nothing else of the request travels.
 *
 * Shared by the console's acts (console-write.ts) and its one read that is a zz-core tool rather
 * than a query of this gateway's own (console/search.ts).
 */
import type { Request } from "express";

import { Mcp } from "@zz/mcp-client";

export function coreFor(req: Request): Mcp {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase().startsWith("x-zz-") && typeof v === "string") headers[k] = v;
  }
  return new Mcp(process.env.CORE_MCP_URL || "http://zz-core:8000/mcp", { headers });
}
