/**
 * The staging page a link from `upload_start` opens: where a person whose agent has no shell picks
 * the file on their own device. Its four states are ready (the form), staged (what was bound),
 * expired, and not a link at all; a refusal of the file itself — another format, too large, not
 * UTF-8, different bytes from the ones already staged — comes back from the PUT and is shown in
 * place by the page's script, as text.
 *
 * Rendered through `oauth-page.ts`'s `html` and `page`, so every value the page shows — the
 * filename is the caller's own choice — is escaped by the one tag `checks/consent-page.ts` proves,
 * and the page wears the console's look and loads nothing from anywhere.
 *
 * The link is a capability: whoever holds it can stage this one upload, and nothing else. So the
 * page never prints the secret (the script PUTs to its own `location.pathname`), sends no referrer,
 * cannot be framed, is never cached, and runs exactly one script — its own, allowed by hash in the
 * Content-Security-Policy and by nothing else. The form never posts: the script reads the chosen
 * file and PUTs its raw bytes, so the gateway's body parsers never see them.
 */
import { createHash } from "node:crypto";

import { html, page } from "./oauth-page.js";

/** The page's one script. A template literal with no interpolation, so `html` passes it through
 *  exactly as written and its hash is taken over the text the browser runs.
 *
 *  DELIBERATE: no backslash, backtick or dollar-brace in it — `html` receives the template's
 *  cooked strings, and any of those would make the text served differ from the text read here. */
const SCRIPT = html`<script>(function () {
  var form = document.getElementById("stage");
  var input = document.getElementById("file");
  var status = document.getElementById("status");
  var button = form.querySelector("button");
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var file = input.files && input.files[0];
    if (!file) { status.textContent = "Choose a file first."; return; }
    button.disabled = true;
    status.textContent = "Sending " + file.name + " ...";
    fetch(location.pathname, {
      method: "PUT", body: file, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) }
    }).then(function (res) {
      return res.json().then(function (answer) {
        if (res.ok) { location.reload(); return; }
        status.textContent = String(answer.error || "The file was not staged.").replace(/^ERROR: [A-Z_]+ . /, "");
        button.disabled = false;
      });
    }).catch(function () {
      status.textContent = "The file did not reach ZZ. Check the connection and send it again.";
      button.disabled = false;
    });
  });
})();</script>`;

type UploadPageState =
  | { kind: "ready"; filename: string }
  | { kind: "staged"; filename: string; bytes: number; sha256: string }
  | { kind: "expired"; filename: string }
  | { kind: "invalid" };

const extOf = (filename: string): string => /^.+\.([^.]+)$/.exec(filename)?.[1].toLowerCase() ?? "";

/** The page for one state, and the HTTP status it is served with. */
export function uploadPage(state: UploadPageState): { status: number; body: string } {
  switch (state.kind) {
    case "ready":
      return { status: 200, body: page("Send a file to ZZ", html`<p class="eyebrow">File upload</p>
<h1>Send ${state.filename}<span class="dot">.</span></h1>
<p class="lede">Choose the file on this device. It is held for the agent that asked for it, and nothing else happens until that agent writes it — this link cannot read, change or approve anything.</p>
<form id="stage"><input type="file" id="file" accept=".${extOf(state.filename)}" required>
<button class="allow" type="submit">Send</button></form>
<p id="status" class="warn" role="status" aria-live="polite"></p>
${SCRIPT}`) };
    case "staged":
      return { status: 200, body: page("File staged", html`<p class="eyebrow">File upload · staged</p>
<h1>Staged<span class="dot">.</span></h1>
<p class="lede">Tell the agent the file is staged. It writes it into the document or source it asked for.</p>
<div class="card"><dl>
<div class="row"><dt>File</dt><dd>${state.filename}</dd></div>
<div class="row"><dt>Bytes</dt><dd>${state.bytes}</dd></div>
<div class="row key"><dt>sha256</dt><dd><code>${state.sha256}</code></dd></div>
</dl></div>`) };
    case "expired":
      return { status: 410, body: page("Upload expired", html`<p class="eyebrow">File upload · expired</p>
<h1>This link has expired<span class="dot">.</span></h1>
<p class="refusal">An upload stays open for 15 minutes. Ask the agent to start a new upload for ${state.filename}.</p>`) };
    case "invalid":
      return { status: 404, body: page("Not an upload link", html`<p class="eyebrow">File upload</p>
<h1>This is not a link ZZ issued<span class="dot">.</span></h1>
<p class="refusal">Check that the whole link was copied, or ask the agent for a new one.</p>`) };
  }
}

const hashOf = (text: string): string => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/** The headers every response on a staging link carries; given the page it serves, also the
 *  Content-Security-Policy that allows that page's own script and stylesheet by hash and nothing
 *  else. Taken from the page as served, so the policy cannot drift from the text it governs. */
export function linkHeaders(body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
  const inline = (tag: string): string[] =>
    [...(body ?? "").matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => hashOf(m[1]!));
  const scripts = inline("script");
  const styles = inline("style");
  headers["Content-Security-Policy"] = [
    "default-src 'none'",
    ...(scripts.length ? [`script-src ${scripts.join(" ")}`] : []),
    ...(styles.length ? [`style-src ${styles.join(" ")}`] : []),
    "img-src data:", "connect-src 'self'", "form-action 'none'", "frame-ancestors 'none'", "base-uri 'none'",
  ].join("; ");
  return headers;
}
