/**
 * The browser door: a passkey, and the only one.
 *
 * This file is the ceremony half — the challenge, the verification, and the session it mints.
 * COUPLED: `resolveSession` in identity.ts is the adapter half, and states the rule both
 * follow: an adapter answers only "which person is calling", never what they may do.
 *
 * Nobody registers themselves. An authenticator asserts possession of a key, not an identity,
 * so registration requires an enrolment token naming a principal that already exists, and the
 * registration reads the principal off that token's row — never off the request body.
 *
 * Minting an enrolment link needs a superadmin, and before anyone has a passkey there is no
 * superadmin session to be one, so `deploy/issue-enrolment.sh` mints the first one on the host,
 * where shell access is the authority. Every later link comes from the console.
 *
 * The RP ID is `CONSOLE_PUBLIC_URL`'s hostname, which encodes the droplet's IP address. A
 * credential is bound to the RP ID it was created under, so moving the droplet stops every
 * credential in `zz.passkey` verifying at once and everyone re-enrols.
 *
 * Same origin is load-bearing. Caddy serves the console app and this API from one host,
 * splitting on path, so the session cookie is a plain first-party cookie: host-only,
 * SameSite=Lax, no CORS, no preflight. WebAuthn needs that too — a ceremony's origin must match
 * `expectedOrigin` exactly.
 *
 * DELIBERATE: no rate limiter. An assertion is a signature over a challenge this server chose;
 * there is nothing to guess, and a limiter here would be a way to lock somebody out of their
 * own console by hammering it from elsewhere.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Express, Request, Response } from "express";

import { platformDb, platformDbReady } from "./db.js";
import { logEvent } from "./events.js";
import { CONSOLE_COOKIE, readCookie, sha256 } from "./identity.js";

/** Spelled as a literal, never assembled at runtime: a name built from a variable cannot be
 * found by searching the source, so it cannot be checked against .env.example. The gate
 * enforces this. */
const PUBLIC_URL = (process.env.CONSOLE_PUBLIC_URL ?? "").replace(/\/+$/, "");

/** Twelve hours: a working day. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** A ceremony has five minutes — a keypress and a fingerprint, not a round trip through
 * somebody else's login screen. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** An enrolment link is good for a week: it is sent out of band and opened when the person
 * gets to it. Single-use is what makes it safe, not brevity. */
const ENROLMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The cookie that binds a browser to the challenge it was given. Without it the challenge id
 * is a bearer token in a table and anyone holding one could finish somebody else's ceremony.
 * Host-only, HttpOnly, and gone the moment the ceremony ends either way. */
const CEREMONY_COOKIE = "zz_ceremony";

const b64 = (b: Buffer): string => b.toString("base64url");

/** Configured means we know our own origin. Everything else about a passkey is derived from
 * it. */
function configured(): boolean { return PUBLIC_URL !== ""; }

/** The relying party, derived from the origin and never written down separately. `rpID` is a
 * hostname and `expectedOrigin` is a full origin — WebAuthn compares them against different
 * things, and deriving both from one variable makes disagreeing impossible. */
function rp(): { id: string; origin: string; name: string } {
  const u = new URL(PUBLIC_URL);
  return { id: u.hostname, origin: u.origin, name: "ZZ Stack" };
}

/** HttpOnly so no script can read it; Secure because the console is only served over TLS;
 * SameSite=Lax so a cross-site form cannot drive it; and no Domain attribute, so a sibling
 * subdomain can neither send it nor set it. */
function setSessionCookie(res: Response, token: string, maxAgeMs: number): void {
  res.append("Set-Cookie",
    `${CONSOLE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`);
}
function clearSessionCookie(res: Response): void {
  res.append("Set-Cookie", `${CONSOLE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
function setCeremonyCookie(res: Response, id: string): void {
  res.append("Set-Cookie",
    `${CEREMONY_COOKIE}=${id}; Path=/auth; HttpOnly; Secure; SameSite=Lax; ` +
    `Max-Age=${Math.floor(CHALLENGE_TTL_MS / 1000)}`);
}
function clearCeremonyCookie(res: Response): void {
  res.append("Set-Cookie", `${CEREMONY_COOKIE}=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

/** Where to send somebody after a successful sign-in: a path on this site or nothing.
 * `next=//evil` is an absolute URL spelled to survive a naive "starts with /" check, which is
 * why the second character is tested too. Backslash because some browsers normalise it to a
 * slash before following. */
function safeNext(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

/** Compare two secrets without leaking their contents through timing. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Mint a session and hand back the token exactly once. */
async function issueSession(principalId: string, req: Request): Promise<string> {
  const token = `zzs_${b64(randomBytes(32))}`;
  await platformDb().query(
    `insert into zz.console_session (principal_id, token_hash, expires_at, user_agent, ip)
     values ($1, $2, now() + ($3 || ' milliseconds')::interval, $4, $5)`,
    [principalId, sha256(token), String(SESSION_TTL_MS),
     (req.headers["user-agent"] ?? "").slice(0, 300), req.ip ?? null]);
  return token;
}

/** Take the challenge this browser was given, and take it away.
 *
 * Single use, enforced by the delete: select-then-delete leaves a window in which two requests
 * both find the row. The cookie is what proves the caller is the browser that asked. */
async function takeChallenge(
  req: Request, kind: "register" | "login",
): Promise<{ challenge: string; principalId: string | null; redirectTo: string } | null> {
  const id = readCookie(req, CEREMONY_COOKIE);
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const r = await platformDb().query<{ challenge: string; principal_id: string | null; redirect_to: string | null }>(
    `delete from zz.passkey_challenge
      where id = $1 and kind = $2 and created_at > now() - ($3 || ' milliseconds')::interval
      returning challenge, principal_id, redirect_to`, [id, kind, String(CHALLENGE_TTL_MS)]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { challenge: row.challenge, principalId: row.principal_id, redirectTo: row.redirect_to ?? "/" };
}

/** Mint an enrolment link for a principal, and return the URL exactly once.
 *
 * The token is in the fragment, not the query: a query token is written to Caddy's access log,
 * to the browser's history, and to the `Referer` of anything the page loads. A fragment never
 * leaves the browser, and the enrolment page reads it with script and POSTs it.
 *
 * `issuedBy` is null when an operator mints this from the host, which is the bootstrap. */
export async function issueEnrolment(
  principalId: string, issuedBy: string | null,
): Promise<{ url: string; expiresAt: Date }> {
  const token = `zze_${b64(randomBytes(32))}`;
  const r = await platformDb().query<{ expires_at: Date }>(
    `insert into zz.passkey_enrolment (token_hash, principal_id, issued_by, expires_at)
     values ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)
     returning expires_at`,
    [sha256(token), principalId, issuedBy, String(ENROLMENT_TTL_MS)]);
  return { url: `${PUBLIC_URL}/enrol#t=${token}`, expiresAt: r.rows[0].expires_at };
}

/** The principal an unused, unexpired enrolment token names — and it is spent by asking.
 *
 * DELIBERATE: spent here, at the start of the ceremony, not after the authenticator answers. A
 * token that survived a failed registration is one somebody can retry with. A person who
 * cancels Touch ID needs a new link, which is a superadmin action. */
async function spendEnrolment(token: unknown): Promise<{ principalId: string; email: string; name: string } | null> {
  if (typeof token !== "string" || !token.startsWith("zze_")) return null;
  const r = await platformDb().query<{ principal_id: string; email: string; display_name: string | null; status: string }>(
    `update zz.passkey_enrolment e set used_at = now()
       from zz.principal p
      where e.token_hash = $1 and e.used_at is null and e.expires_at > now()
        and p.id = e.principal_id
      returning e.principal_id, p.email, p.display_name, p.status`, [sha256(token)]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  // A suspended person holding a live link is still suspended. The link says who they are;
  // the platform says whether they may act.
  if (row.status !== "active") return null;
  return { principalId: row.principal_id, email: row.email, name: row.display_name ?? row.email };
}

/** What to call an authenticator in a list, from what the browser said it was. Used for the
 * label and nothing else. */
function deviceLabel(userAgent: unknown): string {
  const ua = typeof userAgent === "string" ? userAgent : "";
  const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Macintosh/.test(ua) ? "Mac"
    : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux" : "device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${os} · ${browser}`;
}

/** JSON in, JSON out, on every route here. Every route below is called by the console's own
 * script, which renders the words; an HTML page on failure and a JSON body on success is the
 * asymmetry that makes a client special-case every non-2xx response by hand. */
function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

export function mountPasskey(app: Express): void {
  /** What the sign-in screen needs to know before it offers a button. */
  app.get("/auth/status", (_req, res) => {
    res.json({ configured: configured(), rpId: configured() ? rp().id : null });
  });

  /** Begin a registration. The enrolment token is spent here and the principal comes from it. */
  app.post("/auth/passkey/register/options", (req, res) => {
    void (async () => {
      if (!configured()) { fail(res, 503, "This gateway has no CONSOLE_PUBLIC_URL, so it cannot be a relying party."); return; }
      if (!platformDbReady()) { fail(res, 503, "The platform database is unavailable. This is usually brief."); return; }
      const who = await spendEnrolment((req.body ?? {}).token);
      if (!who) { fail(res, 400, "That enrolment link is not valid — it may have been used already, or expired. Ask for a new one."); return; }

      // Exclude what they already have, so an authenticator holding a credential for this
      // account says so instead of silently minting a second one to tell apart from the first.
      const existing = await platformDb().query<{ id: string; transports: string[] | null }>(
        "select id, transports from zz.passkey where principal_id = $1", [who.principalId]);

      const options = await generateRegistrationOptions({
        rpName: rp().name, rpID: rp().id,
        // The principal id is the user handle. It comes back on every later assertion as
        // `userHandle`, which is what lets sign-in ask for no email at all.
        userID: Buffer.from(who.principalId, "utf8"),
        userName: who.email,
        userDisplayName: who.name,
        // Attestation says which make and model of authenticator this is, which matters only
        // when an organisation must accept certified hardware alone.
        attestationType: "none",
        excludeCredentials: existing.rows.map((c) => ({
          id: c.id,
          transports: (c.transports ?? []) as never,
        })),
        authenticatorSelection: {
          // Discoverable, so the credential carries the user handle and sign-in needs no email
          // field. Without it the browser must be told which credentials to offer.
          residentKey: "required",
          userVerification: "required",
          // DELIBERATE: authenticatorAttachment is unset. Left open, the same ceremony can end
          // in Touch ID, a phone over hybrid, or a USB key; "platform" would refuse the key.
        },
      });

      const saved = await platformDb().query<{ id: string }>(
        `insert into zz.passkey_challenge (challenge, kind, principal_id, redirect_to)
         values ($1, 'register', $2, $3) returning id`,
        [options.challenge, who.principalId, safeNext((req.body ?? {}).next)]);
      setCeremonyCookie(res, saved.rows[0].id);
      res.json(options);
    })().catch((err: unknown) => {
      console.error("passkey register options failed:", err);
      if (!res.headersSent) fail(res, 500, "Could not start the registration.");
    });
  });

  /** Finish a registration: store the credential and sign them in with it. */
  app.post("/auth/passkey/register/verify", (req, res) => {
    void (async () => {
      if (!configured() || !platformDbReady()) { fail(res, 503, "Sign-in is unavailable right now."); return; }
      const pending = await takeChallenge(req, "register");
      clearCeremonyCookie(res);
      if (!pending || !pending.principalId) { fail(res, 400, "That registration expired. Open your enrolment link again."); return; }

      let verified;
      try {
        verified = await verifyRegistrationResponse({
          response: (req.body ?? {}).credential,
          expectedChallenge: pending.challenge,
          expectedOrigin: rp().origin,
          expectedRPID: rp().id,
          requireUserVerification: true,
        });
      } catch (err) {
        fail(res, 400, `The authenticator's answer was refused: ${err instanceof Error ? err.message : "unknown"}`);
        return;
      }
      if (!verified.verified || !verified.registrationInfo) { fail(res, 400, "The authenticator's answer did not verify."); return; }

      const cred = verified.registrationInfo.credential;
      const label = deviceLabel(req.headers["user-agent"]);
      const stored = await platformDb().query<{ email: string }>(
        `with saved as (
           insert into zz.passkey (id, principal_id, public_key, counter, transports, label)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (id) do nothing
           returning principal_id)
         select email from zz.principal where id = $2`,
        [cred.id, pending.principalId, Buffer.from(cred.publicKey), cred.counter,
         cred.transports ?? null, label]);

      // Fire-and-forget, like every other logEvent call — a sign-in must not fail because the
      // audit write did.
      logEvent({
        actor: stored.rows[0]?.email ?? pending.principalId, kind: "console.passkey_registered",
        subject: cred.id, ok: true, detail: { label, via: "web" },
      });

      const token = await issueSession(pending.principalId, req);
      setSessionCookie(res, token, SESSION_TTL_MS);
      res.json({ ok: true, next: pending.redirectTo });
    })().catch((err: unknown) => {
      console.error("passkey register verify failed:", err);
      if (!res.headersSent) fail(res, 500, "Could not finish the registration.");
    });
  });

  /** Begin a sign-in. No email, no account name — the credential carries who it is for. */
  app.post("/auth/passkey/login/options", (req, res) => {
    void (async () => {
      if (!configured()) { fail(res, 503, "This gateway has no CONSOLE_PUBLIC_URL, so it cannot be a relying party."); return; }
      if (!platformDbReady()) { fail(res, 503, "The platform database is unavailable. This is usually brief."); return; }
      const options = await generateAuthenticationOptions({
        rpID: rp().id,
        userVerification: "required",
        // DELIBERATE: allowCredentials is empty. The browser offers every credential it holds
        // for this RP and the person picks one; naming credentials here means asking who they
        // are first, and answering that from an email is an account-existence oracle.
      });
      const saved = await platformDb().query<{ id: string }>(
        `insert into zz.passkey_challenge (challenge, kind, redirect_to)
         values ($1, 'login', $2) returning id`,
        [options.challenge, safeNext((req.body ?? {}).next)]);
      setCeremonyCookie(res, saved.rows[0].id);
      res.json(options);
    })().catch((err: unknown) => {
      console.error("passkey login options failed:", err);
      if (!res.headersSent) fail(res, 500, "Could not start the sign-in.");
    });
  });

  /** Finish a sign-in. */
  app.post("/auth/passkey/login/verify", (req, res) => {
    void (async () => {
      if (!configured() || !platformDbReady()) { fail(res, 503, "Sign-in is unavailable right now."); return; }
      const pending = await takeChallenge(req, "login");
      clearCeremonyCookie(res);
      if (!pending) { fail(res, 400, "That sign-in expired. Try again."); return; }

      const credential = (req.body ?? {}).credential;
      const id: unknown = credential?.id;
      if (typeof id !== "string" || !id) { fail(res, 400, "The browser sent no credential."); return; }

      const found = await platformDb().query<{
        principal_id: string; public_key: Buffer; counter: string; transports: string[] | null;
        email: string; status: string;
      }>(
        `select k.principal_id, k.public_key, k.counter, k.transports, p.email, p.status
           from zz.passkey k join zz.principal p on p.id = k.principal_id
          where k.id = $1`, [id]);
      if (!found.rows.length) { fail(res, 401, "That passkey is not registered here."); return; }
      const row = found.rows[0];
      // The credential says who; the platform says whether. A deactivated person keeps a
      // perfectly valid passkey and still may not in.
      if (row.status !== "active") { fail(res, 403, `This account is ${row.status}.`); return; }

      // The user handle must agree with the credential. Both come from the same authenticator,
      // so disagreeing means something assembled a response by hand. Constant-time, because it
      // decides a sign-in.
      //
      // Decoded first: `userHandle` arrives base64url over the wire (48 characters) and holds
      // the principal id as UTF-8 (36). Comparing them raw fails on length for every honest
      // login and the refusal reads like tampering.
      const handle: unknown = credential?.response?.userHandle;
      if (typeof handle === "string" && handle) {
        let decoded = "";
        try { decoded = Buffer.from(handle, "base64url").toString("utf8"); } catch { decoded = ""; }
        if (!sameSecret(decoded, row.principal_id)) {
          fail(res, 401, "The credential and the account it names do not agree."); return;
        }
      }

      let verified;
      try {
        verified = await verifyAuthenticationResponse({
          response: credential,
          expectedChallenge: pending.challenge,
          expectedOrigin: rp().origin,
          expectedRPID: rp().id,
          requireUserVerification: true,
          credential: {
            id, publicKey: new Uint8Array(row.public_key),
            counter: Number(row.counter), transports: (row.transports ?? []) as never,
          },
        });
      } catch (err) {
        fail(res, 401, `That passkey was refused: ${err instanceof Error ? err.message : "unknown"}`);
        return;
      }
      if (!verified.verified) { fail(res, 401, "That passkey did not verify."); return; }

      // A synced platform authenticator reports 0 forever, so the verifier — not this file —
      // decides what a counter means. This records what it was told, so a later clone shows up
      // as a counter that went backwards.
      await platformDb().query(
        "update zz.passkey set counter = $2, last_used_at = now() where id = $1",
        [id, verified.authenticationInfo.newCounter]);

      logEvent({
        actor: row.email, kind: "console.sign_in", subject: id, ok: true, detail: { via: "web" },
      });

      const token = await issueSession(row.principal_id, req);
      setSessionCookie(res, token, SESSION_TTL_MS);
      res.json({ ok: true, next: pending.redirectTo });
    })().catch((err: unknown) => {
      console.error("passkey login verify failed:", err);
      if (!res.headersSent) fail(res, 500, "Could not finish the sign-in.");
    });
  });

  /** Sign out of this dashboard, and only this dashboard.
   *
   * DELIBERATE: POST, not GET. It revokes a session row, and a state-changing GET is reachable
   * by anything that can make a browser issue one — an `<img src>`, a link in a mail, a
   * prefetch — which signs a person out while working. The console submits a form; 303 sends
   * the browser on with a GET, so the landing page is still a page.
   */
  app.post("/auth/logout", (req, res) => {
    void (async () => {
      const token = readCookie(req, CONSOLE_COOKIE);
      if (token && platformDbReady()) {
        await platformDb().query(
          "update zz.console_session set revoked_at = now() where token_hash = $1 and revoked_at is null",
          [sha256(token)]);
      }
      clearSessionCookie(res);
      res.redirect(303, `${PUBLIC_URL}/signed-out`);
    })().catch((err: unknown) => {
      console.error("console logout failed:", err);
      clearSessionCookie(res);
      res.redirect(303, `${PUBLIC_URL}/signed-out`);
    });
  });
}

/** Delete what has expired: sessions, half-finished ceremonies, and unopened invitations.
 *
 * On a timer rather than at read time — `resolveSession` runs on every request, and a read that
 * also writes turns each page load into a transaction. One pass for all three. Called from
 * server startup. */
export async function sweepSessions(): Promise<void> {
  if (!platformDbReady()) return;
  const db = platformDb();
  await db.query(
    "delete from zz.console_session where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days'");
  await db.query("delete from zz.passkey_challenge where created_at < now() - interval '1 hour'");
  await db.query(
    "delete from zz.passkey_enrolment where expires_at < now() - interval '7 days' or used_at < now() - interval '7 days'");
}
