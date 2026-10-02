/**
 * The pages a person sees while a hosted client connects to this platform: the consent question,
 * and the handful of refusals a browser can be told. Everything else in the OAuth flow answers a
 * program in JSON.
 *
 * They wear the console's look — the cream ground, the one purple, the wordmark — because the
 * consent page is the moment a person decides whether to trust a connection, and a bare
 * system-font page is indistinguishable from a phishing kit's.
 *
 * DELIBERATE: no webfont and no request of any kind. The stylesheet and the mark are inside the
 * document, so the page loads nothing from anywhere — a font host would learn who is connecting
 * what, on the one page whose subject is what gets shared. The headline asks for the system's
 * rounded face (SF Rounded on Apple platforms), which is the nearest thing to the console's
 * Baloo 2 that every reader already has.
 *
 * Every value a caller supplies goes through `html`, which escapes whatever it interpolates.
 * There is no way to put an unescaped string into these pages short of building an `Html` by
 * hand, and that constructor is not exported.
 *
 * COUPLED: the palette is the console's (zz-stack-dashboard, app/globals.css), and the mark is
 * its wordmark — `checks/consent-page.ts` holds the PNG byte-identical to the console's.
 */
import { readFileSync } from "node:fs";

/** A fragment of markup whose every interpolated value has already been escaped. */
class Html {
  constructor(readonly text: string) {}
}

/** HTML-escape. The quotes matter as much as the angle brackets: a value inside a double-quoted
 *  attribute without `"` escaped closes the attribute and opens another. */
const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Markup with its interpolations escaped, unless an interpolation is itself `Html`. */
export function html(strings: TemplateStringsArray, ...values: (string | number | Html | Html[])[]): Html {
  let out = strings[0]!;
  values.forEach((v, i) => {
    const part = Array.isArray(v) ? v.map((h) => h.text).join("") : v instanceof Html ? v.text : escapeHtml(String(v));
    out += part + strings[i + 1]!;
  });
  return new Html(out);
}

/** The wordmark, read once. Next to `dist/` at runtime: the image copies `services/` whole and
 *  prunes only TypeScript sources. */
const MARK = `data:image/png;base64,${readFileSync(new URL("../assets/wordmark.png", import.meta.url)).toString("base64")}`;

const STYLE = `
:root{color-scheme:light;
  --bg:#f8efea;--surface:#fffbf9;--sunk:#f4e9e3;--line:#e9ddd6;--line-strong:#d8c8be;
  --ink:#221b26;--ink-soft:#5a5160;--ink-faint:#6e6574;
  --accent:#7548d8;--accent-deep:#5e2bcc;--accent-tint:#f1ebff;
  --red-text:#c0392f;--red-tint:#f9e7e3;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --round:ui-rounded,"SF Pro Rounded","Nunito","Segoe UI Variable Display",system-ui,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --ease:cubic-bezier(.22,.61,.36,1)}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--ink);font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased;
  display:grid;grid-template-rows:auto 1fr auto;min-height:100dvh}
.top{display:flex;align-items:center;gap:10px;padding:24px clamp(20px,5vw,48px)}
.top img{width:28px;height:28px}
.top b{font-size:14px;letter-spacing:-.01em}
main{display:grid;place-items:center;padding:16px clamp(20px,5vw,48px) 48px}
.sheet{width:100%;max-width:34rem;animation:rise .42s var(--ease) both}
.eyebrow{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint);margin:0 0 12px}
h1{font-family:var(--round);font-weight:700;font-size:clamp(30px,5.2vw,44px);line-height:1.05;letter-spacing:-.025em;margin:0 0 16px;text-wrap:balance}
h1 .dot{color:var(--accent)}
.lede{color:var(--ink-soft);margin:0 0 24px;font-size:16px}
.card{background:var(--surface);border:1px solid var(--line-strong);border-radius:16px;box-shadow:3px 3px 0 rgba(33,28,22,.07);overflow:hidden}
.card dl{margin:0}
.row{display:grid;grid-template-columns:7.5rem 1fr;gap:12px;padding:12px 18px;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.row dt{font-size:12px;color:var(--ink-faint);padding-top:2px}
.row dd{margin:0;font-size:14px;min-width:0;overflow-wrap:anywhere}
.row.key{background:var(--accent-tint)}
.row.key dd{font-weight:600;color:var(--accent-deep)}
code{font-family:var(--mono);font-size:13px;background:var(--sunk);border-radius:6px;padding:1px 6px}
.warn{display:flex;gap:10px;align-items:flex-start;margin:20px 2px 0;font-size:13px;color:var(--ink-soft)}
.warn svg{flex:none;margin-top:3px;color:var(--accent)}
form{display:flex;gap:10px;margin-top:24px;flex-wrap:wrap}
button{font:600 14px/1 var(--sans);height:44px;padding:0 22px;border-radius:10px;cursor:pointer;
  transition:transform .12s var(--ease),background-color .12s var(--ease),box-shadow .12s var(--ease),border-color .12s var(--ease)}
button:active{transform:translateY(1px)}
button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--bg),0 0 0 5px color-mix(in oklab,var(--accent) 35%,transparent)}
.allow{flex:1 1 12rem;background:var(--accent);color:#fff;border:0;box-shadow:0 2px 0 var(--accent-deep)}
.allow:hover{background:var(--accent-deep)}
.allow:active{box-shadow:none}
.deny{flex:0 1 auto;background:var(--surface);color:var(--ink);border:1px solid var(--line-strong)}
.deny:hover{background:var(--sunk);border-color:var(--ink-faint)}
.refusal{border-left:3px solid var(--red-text);background:var(--surface);border-radius:4px 16px 16px 4px;padding:16px 18px;color:var(--ink-soft);margin:0}
footer{padding:20px clamp(20px,5vw,48px);font-size:12px;color:var(--ink-faint)}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media (max-width:30rem){.row{grid-template-columns:1fr;gap:2px}.deny{flex:1 1 auto}}
`;

/** A whole page: the mark, one sheet, and a footer line. */
export function page(title: string, sheet: Html): string {
  return "<!doctype html>" + html`<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title><style>${new Html(STYLE)}</style></head>
<body><header class="top"><img src="${new Html(MARK)}" alt=""><b>ZZ</b></header>
<main><div class="sheet">${sheet}</div></main>
<footer>ZZ platform — connections to its MCP doors</footer></body></html>`.text;
}

/** A refusal a browser can be shown: what stopped, and what to do about it. */
export function refusalPage(status: number, title: string, detail: string): string {
  return page(title, html`<p class="eyebrow">Connection stopped · ${status}</p>
<h1>${title}<span class="dot">.</span></h1>
<p class="refusal">${detail}</p>`);
}

const SHIELD = new Html('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>');

/** The question a hosted client's authorization stops on.
 *
 *  The client names itself, so its name proves nothing — what it cannot forge is where the code
 *  goes, so that row is the one set apart. */
export function consentHtml(o: {
  client: string; door: string; email: string; admin: boolean; dest: string; hidden: Record<string, string>;
}): string {
  const reach = o.admin
    ? html`everything you can reach, <b>including platform administration</b> — you are a superadmin`
    : html`your teams' documents and knowledge, with the same access you have in the console`;
  const hidden = Object.entries(o.hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);
  return page("Connect to ZZ?", html`<p class="eyebrow">Connection request</p>
<h1>Connect ${o.client} to ZZ<span class="dot">?</span></h1>
<p class="lede">It will be able to read and change ${reach}.</p>
<div class="card"><dl>
<div class="row"><dt>Acting as</dt><dd><b>${o.email}</b></dd></div>
<div class="row"><dt>Door</dt><dd><code>${o.door}</code></dd></div>
<div class="row key"><dt>Handed to</dt><dd>${o.dest}</dd></div>
</dl></div>
<p class="warn">${SHIELD}<span>If you did not just press Connect on that site yourself, choose Deny.</span></p>
<form method="post" action="/oauth/authorize">${hidden}
<button class="allow" name="decision" value="allow">Allow</button>
<button class="deny" name="decision" value="deny">Deny</button>
</form>`);
}
