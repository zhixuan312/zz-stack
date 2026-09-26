/**
 * The version of the running deployment — the one release version every catalog plugin ships
 * at. The gateway's `PLATFORM_VERSION` (client-package.ts) is what it stamps into the
 * plugin.json a person installs; this is the same number, read from zz-core's own manifest in
 * the same image, which set-version keeps equal to the gateway's.
 *
 * COUPLED: this module sits at the root of `src/`, because `serviceVersion` reads the
 * package.json exactly one directory above the calling module. Called from `dist/eval/` it
 * looks for `dist/package.json` and answers its "0.0.0" fallback.
 */
import { serviceVersion } from "@zz/mcp-http";

export const PLATFORM_VERSION: string = serviceVersion(import.meta.url);
