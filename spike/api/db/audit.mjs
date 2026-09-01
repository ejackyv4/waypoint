/**
 * Who looked at whose record, and when.
 *
 * Supervision data is the kind where READING it is itself an act worth
 * recording. "Which officer opened this person's file, and when" is a question
 * asked after something has gone wrong, and it can only be answered if it was
 * being written down beforehand. There is no way to reconstruct it afterwards.
 *
 * Its own module, belonging to neither system. Waypoint and Northwood both
 * write here, and Northwood may not import Waypoint's data layer — a shared
 * table with two owners would otherwise mean either a boundary violation or
 * two copies of this function drifting apart. In a real deployment these are
 * two logs in two systems; here there is one database, so there is one table.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 *
 * It is not a query log. It records reads of a PERSON's record — the thing
 * with a subject who could ask "who has been looking at my file". Logging every
 * SELECT would produce volume nobody reads and bury the entries that matter.
 *
 * It never throws. An audit write failing must not take down the read it is
 * recording: losing an entry is bad, refusing an officer their caseload
 * because the log is full is worse. It complains to stderr and returns.
 *
 * It is append-only. Nothing in the application deletes from it.
 * ---------------------------------------------------------------------------
 */
import { all, run, now } from "./connect.mjs";
import "./schema.mjs";

/**
 * @param actor      who did it: "officer:3", "subject:cust-1041", "api-key"
 * @param action     "read" | "write" | "signin" | "signout" | "revoke" | "export"
 * @param entity     "subject" | "visit" | "recording" | "registrations" | "person"
 * @param entity_id  the subject_id or row id it concerns
 * @param detail     short free text; truncated rather than rejected
 */
export function audit({ actor, action, entity, entity_id, detail, ip }) {
  try {
    run(`INSERT INTO audit_log (at, actor, action, entity, entity_id, detail, ip)
         VALUES (?,?,?,?,?,?,?)`,
        now(), actor ?? null, action, entity,
        entity_id == null ? null : String(entity_id),
        detail ? String(detail).slice(0, 500) : null, ip ?? null);
  } catch (e) {
    console.error("[audit] could not record:", e.message,
                  JSON.stringify({ actor, action, entity, entity_id }));
  }
}

/** Everything recorded about one thing, newest first. */
export const auditFor = (entity, entity_id, limit = 200) =>
  all(`SELECT * FROM audit_log WHERE entity = ? AND entity_id = ?
        ORDER BY id DESC LIMIT ?`, entity, String(entity_id), limit);

/** The most recent entries across everything — for an operator, not a screen. */
export const auditRecent = (limit = 200) =>
  all(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`, limit);

/** The address a request came from, for the log. Behind a proxy the socket is
 *  the proxy, so the forwarded header is preferred — it is untrusted input and
 *  is only ever written down, never used to make a decision. */
export const callerIp = req =>
  (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
  || req.socket?.remoteAddress?.replace(/^::ffff:/, "")
  || null;
