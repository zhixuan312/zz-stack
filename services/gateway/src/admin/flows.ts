/**
 * The shelf and the client package: what the catalog offers, and the setup text that carries
 * it into somebody's terminal.
 *
 * THERE IS NO INSTALL REGISTRY. The platform used to record which flows each team had
 * "installed" and gate the package on it. It cannot see what is on a person's machine, so the
 * record was a claim it could not back and the gate a restriction it could not enforce. The
 * shelf is the same for everyone, zz-core and zz-access are required, and every other plugin is
 * a person's own choice.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { catalogManifest, installableFlows } from "@zz/catalog";
import { text } from "@zz/mcp-http";

import { buildClientPackage, PLATFORM_VERSION, type ClientPackage } from "../client-package.js";
import { callerIdentity as caller } from "../identity.js";
import { describePackage } from "../package/describe.js";

/** No default, deliberately.
 *
 * It used to fall back to this deployment's own tailnet address. A client package is a file
 * a person installs, and every URL inside it has to be the address they will actually
 * reach — so on any install that did not set GATEWAY_PUBLIC_URL, everyone would have been
 * handed a package pointing at our host, and nothing would have said so. */
const publicBase = (): string => {
  const base = (process.env.GATEWAY_PUBLIC_URL || "").trim();
  if (!base) {
    throw new Error(
      "GATEWAY_PUBLIC_URL is not set on this gateway. A client package carries the address " +
      "people will reach it at, and this service cannot guess it — set it in deploy/.env " +
      "and restart the gateway.");
  }
  return base;
};
/** Build a person's client package — the same shelf for everyone, addressed to this gateway. */
function clientPackageFor(target: string): ClientPackage {
  return buildClientPackage({ target, base: publicBase() });
}
/** Render a person's client setup as instructions they can follow.
 *
 * Note what is NO LONGER here: the "paste into CLAUDE.md" stanza. Those files
 * are engine-global, so a flow placed there rewrites how the person's whole
 * engine behaves on every unrelated task, and two installed flows collide in
 * one file. The package installs and uninstalls as a unit instead. */
export async function renderClientSetup(target: string): Promise<string> {
  return describePackage(clientPackageFor(target), target);
}
/** The shelf, on the door everyone has — seeing what could be installed is nobody's privilege. */
export function registerShelf(server: McpServer): void {
  server.registerTool("catalog_list", {
    description:
      "WHEN the question is 'what could I use?'. RETURNS the shelf: every optional plugin " +
      "this platform offers, with what it is for. Installing one is your own choice, made in " +
      "your client — client_setup prints the command. REFUSES only a caller the platform " +
      "cannot identify.",
    inputSchema: {},
  }, async () => {
    const id = await caller();
    if (!id) return text("ERROR: no platform identity");
    const catalog = installableFlows().map((entry) => {
      const flow = entry.split("/")[1] ?? entry;
      return {
        flow,
        version: PLATFORM_VERSION,
        description: (catalogManifest(flow)?.description ?? "").slice(0, 160),
      };
    });
    return text(JSON.stringify({ catalog }, null, 2));
  });
}
