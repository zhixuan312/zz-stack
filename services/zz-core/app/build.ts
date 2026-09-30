#!/usr/bin/env node
/**
 * Builds the document panel: one self-contained HTML page, `dist/apps/document-panel.html`, that
 * zz-core serves as the MCP Apps resource `ui://zz-core/document-panel.html`.
 *
 * Self-contained because the page runs in a sandbox another product frames: the script, the style
 * and both brand images are inside it, and the only thing it loads is the console's type from
 * Google Fonts — which is exactly what `PANEL_CSP` in src/document-panel.ts allows.
 *
 * Run by `npm run build` and by the image build, after `tsc -b`. `buildPanel` is exported so a
 * check builds the same page the release ships.
 *
 * Run: node services/zz-core/app/build.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { serviceVersion } from "@zz/mcp-http";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
export const PANEL_OUT = join(here, "..", "dist", "apps", "document-panel.html");

/** The console's three families, at the weights the console uses. */
const FONTS = "https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap";

export async function buildPanel(): Promise<string> {
  const out = await build({
    entryPoints: [join(here, "panel.ts")],
    bundle: true, format: "esm", platform: "browser", target: "es2022",
    minify: true, write: false, legalComments: "none",
    loader: { ".png": "dataurl" },
    // zz-core's own version, read the one way every service reads it — never a literal.
    define: { PANEL_VERSION: JSON.stringify(serviceVersion(pathToFileURL(join(here, "..", "dist", "server.js")).href)) },
  });
  const js = out.outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script");
  const css = readFileSync(join(here, "panel.css"), "utf8");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Document</title>",
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    `<link rel="stylesheet" href="${FONTS}">`,
    `<style>${css}</style>`,
    "</head>",
    "<body>",
    '<main id="panel"></main>',
    `<script type="module">${js}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const html = await buildPanel();
  mkdirSync(dirname(PANEL_OUT), { recursive: true });
  writeFileSync(PANEL_OUT, html);
  console.log(`document panel: ${PANEL_OUT} (${Math.round(html.length / 1024)} KB)`);
}
