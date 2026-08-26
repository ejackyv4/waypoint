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

import { createHmac, timingSafeEqual, randomBytes, scryptSync } from "node:crypto";

/* In production these come from a secret store and are per-tenant.
   Generated per boot here so the PoC is never accidentally shipped with
   a hardcoded key. */
export const API_KEY        = process.env.WAYPOINT_API_KEY     || "wp_demo_" + randomBytes(12).toString("hex");
export const WEBHOOK_SECRET = process.env.WAYPOINT_WEBHOOK_SECRET || randomBytes(24).toString("hex");
const SESSION_SECRET        = process.env.WAYPOINT_SESSION_SECRET || randomBytes(32).toString("hex");

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

const LEARNER_TTL_MS = 12 * 60 * 60 * 1000;

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

export function mintLearnerSession(personId) {
  const body = `L${personId}.${Date.now() + LEARNER_TTL_MS}`;
  return `${b64(body)}.${sign(SESSION_SECRET, body)}`;
}

export function verifyLearnerSession(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const i = token.lastIndexOf(".");
  let body;
  try { body = unb64(token.slice(0, i)); } catch { return null; }
  if (!safeEqual(token.slice(i + 1), sign(SESSION_SECRET, body))) return null;
  const [who, expiry] = body.split(".");
  if (!who?.startsWith("L") || !expiry) return null;   // not a learner token
  if (Date.now() > +expiry) return null;
  return +who.slice(1);
}

export function requireLearner(req) {
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return { error: "sign in required", status: 401 };
  const personId = verifyLearnerSession(token);
  if (personId === null) return { error: "session expired — please sign in again", status: 401 };
  return { ok: true, person_id: personId };
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
