/**
 * A subject's session.
 *
 * Its own module, and not part of `auth.mjs`, for a boundary reason. This needs
 * Waypoint's tables; `auth.mjs` is shared with Northwood, which is a CUSTOMER
 * of Waypoint and must not have an import path into its data — not directly,
 * and not transitively through a module both happen to use.
 *
 * `check-boundary.mjs` reads direct imports only, so putting this in `auth.mjs`
 * would have opened exactly the kind of leak it exists to catch and would not
 * have been caught. Only Waypoint imports this file.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A ROW AND NOT A SIGNED TOKEN
 *
 * This was an HMAC carrying the person id and an expiry: no table, no lookup,
 * and no way to end it. A subject who lost their phone had one answer — wait
 * twelve hours — and an officer had nothing they could do for them meanwhile.
 *
 * Staff sessions have been revocable server-side rows since they existed. The
 * subjects' session, the one that opens a person's own supervision record from
 * a device that gets lost far more often than a work laptop, was the weaker of
 * the two.
 *
 * The token is random rather than derived, so nothing about a person can be
 * read back out of it, and only its SHA-256 hash is stored — this table
 * leaking must not hand anybody a live session.
 * ---------------------------------------------------------------------------
 */
import { randomBytes } from "node:crypto";
import { hashToken } from "./auth.mjs";
import { createLearnerSession, learnerSession, revokeLearnerSession,
         revokeLearnerSessionsFor, sweepLearnerSessions } from "./db/waypoint.mjs";

/** A working day plus the evening. Long enough not to interrupt a course. */
export const LEARNER_TTL_MS = 12 * 60 * 60 * 1000;

export function mintLearnerSession(personId, { ip, user_agent } = {}) {
  const token = randomBytes(32).toString("base64url");
  createLearnerSession({
    token_hash: hashToken(token), person_id: personId,
    ttl_ms: LEARNER_TTL_MS, ip, user_agent });
  return token;
}

/** The person id, or null if the session is unknown, expired or revoked. */
export function verifyLearnerSession(token) {
  if (typeof token !== "string" || !token) return null;
  const s = learnerSession(hashToken(token));
  return s ? s.person_id : null;
}

/** End one session — signing out on this device. */
export const endLearnerSession = token =>
  token ? revokeLearnerSession(hashToken(token)) : undefined;

/** End every session this person has. What a lost phone actually needs. */
export const endAllLearnerSessions = person_id =>
  revokeLearnerSessionsFor(person_id);

export { sweepLearnerSessions };

/**
 * Resolve the caller, or say why not.
 *
 * Returns the token as well as the person, so a handler that ends a session
 * does not have to re-read the header to find out which one.
 */
export function requireLearner(req) {
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return { error: "sign in required", status: 401 };
  const personId = verifyLearnerSession(token);
  if (personId === null)
    return { error: "session expired — please sign in again", status: 401 };
  return { ok: true, person_id: personId, token };
}
