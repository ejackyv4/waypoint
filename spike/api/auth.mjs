/**
 * Waypoint PoC — authentication.
 *
 * THREE different callers, three different models. Conflating them is how
 * you end up with one credential that can do everything.
 *
 *   1. The SaaS  → Waypoint      API key.      Can assign, launch, read.
 *   2. The player → Waypoint     Session token, minted only by redeeming a
 *                                launch ticket, scoped to ONE registration.
 *                                Cannot touch any other record.
 *   3. Waypoint  → the SaaS      HMAC-signed webhook, so the receiver can
 *                                prove it came from us and reject replays.
 *
 * Model 2 is the important one. A runtime endpoint that accepts a bare
 * registration id lets any learner write to any registration — the same
 * bug as a customer id in a URL.
 */

import { createHmac, createHash, timingSafeEqual, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./db/connect.mjs";

/* In production these come from a secret store and are per-tenant.
   Generated rather than hardcoded so the PoC is never accidentally shipped
   with a known key. */
export const API_KEY        = process.env.WAYPOINT_API_KEY     || "wp_demo_" + randomBytes(12).toString("hex");
export const WEBHOOK_SECRET = process.env.WAYPOINT_WEBHOOK_SECRET || randomBytes(24).toString("hex");

/**
 * The session secret MUST survive a restart.
 *
 * It signs the token a running course uses to save its progress. Regenerating
 * it per boot meant every restart silently invalidated every session already
 * in flight: the learner kept clicking, every write was refused, and the
 * Terminate that records their completion never landed. In production a
 * routine deploy would have done that to everyone mid-course, and the first
 * anyone would know is a learner insisting they finished something the record
 * says they did not.
 *
 * So it is persisted, owner-readable only, next to the database. An operator
 * can still override it from a real secret store.
 */
const SESSION_SECRET = process.env.WAYPOINT_SESSION_SECRET || loadOrCreateSecret();

function loadOrCreateSecret() {
  const file = join(DATA_DIR, ".session-secret");
  try { return readFileSync(file, "utf8").trim(); } catch {}
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const SESSION_TTL_MS = 4 * 60 * 60 * 1000;   // a course sitting open all afternoon

const b64 = s => Buffer.from(s).toString("base64url");
const unb64 = s => Buffer.from(s, "base64url").toString();

function sign(secret, data) {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/** Constant-time compare that cannot throw on length mismatch. */
function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

/* ---------------- 1. the SaaS calling us ---------------- */

export function requireApiKey(req) {
  const header = req.headers["authorization"] || "";
  const key = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-api-key"];
  if (!key) return { error: "missing API key", status: 401 };
  if (!safeEqual(key, API_KEY)) return { error: "invalid API key", status: 403 };
  return { ok: true };
}

/* ---------------- 2. the player calling us ----------------
   Stateless: the token carries its own registration id and expiry, and
   the signature makes it unforgeable. No table, nothing to clean up. */

export function mintSession(registrationId) {
  const body = `${registrationId}.${Date.now() + SESSION_TTL_MS}`;
  return `${b64(body)}.${sign(SESSION_SECRET, body)}`;
}

/** Stable, opaque xAPI registration UUID for one internal registration row. */
export function xapiRegistrationId(registrationId) {
  const hex = createHmac("sha256", SESSION_SECRET)
    .update(`waypoint-xapi-registration:${registrationId}`).digest("hex").slice(0, 32);
  // RFC 4122 variant/version bits make this acceptable to clients that insist
  // the xAPI registration value be UUID-shaped.
  const versioned = `${hex.slice(0, 12)}5${hex.slice(13, 16)}`
    + `${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17)}`;
  return `${versioned.slice(0,8)}-${versioned.slice(8,12)}-${versioned.slice(12,16)}`
    + `-${versioned.slice(16,20)}-${versioned.slice(20)}`;
}

export function verifySession(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const i = token.lastIndexOf(".");
  const payload = token.slice(0, i), sig = token.slice(i + 1);
  let body;
  try { body = unb64(payload); } catch { return null; }
  if (!safeEqual(sig, sign(SESSION_SECRET, body))) return null;

  const [regId, expiry] = body.split(".");
  if (!regId || !expiry) return null;
  if (Date.now() > +expiry) return null;
  return +regId;
}

/** Pull the session from the request and confirm it is for THIS registration.
 *  A valid session for registration 7 must not be able to write to 8. */
export function requireSession(req, registrationId) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return { error: "missing session token", status: 401 };
  const regId = verifySession(token);
  if (regId === null) return { error: "invalid or expired session", status: 403 };
  if (regId !== Number(registrationId))
    return { error: "session is not valid for this registration", status: 403 };
  return { ok: true, registration_id: regId };
}

/* ---------------- 2b. the learner signing in ----------------
   A person-scoped session, distinct from the registration-scoped runtime
   session. Signing in gets you your own program list and the right to
   ask for launch tickets — never the right to write to a registration
   directly. That still requires redeeming a ticket. */

/** scrypt with a per-credential salt. Format: scrypt$<salt>$<hash>. */
export function hashPassword(plain) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(plain, salt, 64).toString("hex")}`;
}

export function verifyPassword(plain, stored) {
  if (typeof stored !== "string") return false;
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  return safeEqual(scryptSync(plain, salt, 64).toString("hex"), hash);
}

/* The subject's session lives in learner-session.mjs.
 *
 * It needs Waypoint's tables, and this module is shared with Northwood — which
 * is a CUSTOMER of Waypoint and must not have an import path to its data, even
 * a transitive one through here. `check-boundary.mjs` only reads direct
 * imports, so this is the kind of leak it would have missed. */

/* ---------------- 2c. staff signing in to the admin app ----------------

   Different from the learner session on purpose.

   The learner surfaces (mobile app, learner site) use a BEARER token: the
   app cannot easily hold cookies, and it talks to two origins.

   The admin app is a browser on one origin, so it uses an httpOnly COOKIE.
   JavaScript cannot read it, which means an XSS bug on an admin page cannot
   steal a staff session — a materially bigger risk here, since staff can see
   every subject's record.

   Sessions are stored server-side so they can be revoked; only a hash of the
   token is kept, so a database leak does not hand over live sessions.
------------------------------------------------------------------ */

export const STAFF_COOKIE = "nw_session";
export const STAFF_TTL_MS = 8 * 60 * 60 * 1000;    // a working day

export const newStaffToken = () => randomBytes(32).toString("base64url");
export const hashToken = t => createHash("sha256").update(String(t)).digest("hex");

export function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Secure is set only over HTTPS — a Secure cookie is silently dropped on
 *  plain http, which would make the PoC appear to lose its session. */
export function staffCookie(token, { secure = false, maxAge = STAFF_TTL_MS / 1000 } = {}) {
  return `${STAFF_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
       + (secure ? "; Secure" : "");
}
export const clearStaffCookie = () =>
  `${STAFF_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/** Roles are checked against a list, so adding supervisor or admin later is
 *  a change to the list rather than to every route. */
export function allow(session, ...roles) {
  if (!session) return { error: "sign in required", status: 401 };
  if (roles.length && !roles.includes(session.role))
    return { error: "you do not have access to that", status: 403 };
  return { ok: true };
}

/* ---------------- 3. us calling the SaaS ----------------
   Signed so the receiver can verify origin, with a timestamp so an
   intercepted delivery cannot be replayed later. */

export function signWebhook(bodyString, timestamp = Date.now()) {
  const signature = sign(WEBHOOK_SECRET, `${timestamp}.${bodyString}`);
  return {
    "X-Waypoint-Timestamp": String(timestamp),
    "X-Waypoint-Signature": `v1=${signature}`
  };
}

/** What the SaaS side implements. Included so the integration doc can point
 *  at working code rather than prose. */
export function verifyWebhook(bodyString, headers, secret = WEBHOOK_SECRET, toleranceMs = 5 * 60 * 1000) {
  const ts = headers["x-waypoint-timestamp"];
  const sig = String(headers["x-waypoint-signature"] || "").replace(/^v1=/, "");
  if (!ts || !sig) return { ok: false, reason: "missing signature headers" };
  if (Math.abs(Date.now() - Number(ts)) > toleranceMs)
    return { ok: false, reason: "timestamp outside tolerance — possible replay" };
  if (!safeEqual(sig, sign(secret, `${ts}.${bodyString}`)))
    return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}
