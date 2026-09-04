/**
 * Waypoint's data — the LMS half.
 *
 * People, programs, content versions, assignments, registrations, launch
 * tickets, credentials and webhook deliveries. Nothing here knows about
 * probation, visits or supervision agreements.
 *
 * northwood.mjs must never import this module. It is a customer of the LMS
 * and reaches it over HTTP; `check-boundary.mjs` fails the build if that
 * stops being true.
 */

import { one, all, run, now, db } from "./connect.mjs";
import { readFileSync } from "node:fs";
import "./schema.mjs";
import { registrationResumable } from "../scorm.mjs";

/* ---------------- people & programs ---------------- */

export function upsertPerson({ subject_id, name = null, email = null }) {
  const found = one(`SELECT * FROM people WHERE subject_id = ?`, subject_id);
  if (found) {
    // COALESCE so a call that omits name/email refreshes activity without
    // wiping details a previous call supplied.
    run(`UPDATE people
            SET name = COALESCE(?, name), email = COALESCE(?, email), last_active_at = ?
          WHERE id = ?`, name, email, now(), found.id);
    return one(`SELECT * FROM people WHERE id = ?`, found.id);
  }
  run(`INSERT INTO people (subject_id, name, email, created_at, last_active_at)
       VALUES (?,?,?,?,?)`, subject_id, name, email, now(), now());
  return one(`SELECT * FROM people WHERE subject_id = ?`, subject_id);
}

export function upsertProgram({ program_id, title, description = null }) {
  const found = one(`SELECT * FROM programs WHERE program_id = ?`, program_id);
  if (found) return found;
  run(`INSERT INTO programs (program_id, title, description, created_at) VALUES (?,?,?,?)`,
      program_id, title, description, now());
  return one(`SELECT * FROM programs WHERE program_id = ?`, program_id);
}

/* ---------------- content versions ----------------
   Immutable once created. A new upload is a new version; nothing is
   ever updated in place, so a learner mid-progress keeps the version
   they started. */
export function addContentVersion(v) {
  const next = (one(`SELECT MAX(version) m FROM content_versions WHERE program_pk = ?`,
                    v.program_pk)?.m ?? 0) + 1;
  run(`INSERT INTO content_versions
       (program_pk, version, scorm_version, launch_href, storage_path, sco_count, title, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      v.program_pk, next, v.scorm_version, v.launch_href, v.storage_path,
      v.sco_count, v.title ?? null, now());
  return one(`SELECT * FROM content_versions WHERE program_pk = ? AND version = ?`,
             v.program_pk, next);
}

/** Set once, immediately after ingest moves the files into place. */
export const setStoragePath = (id, path) =>
  run(`UPDATE content_versions SET storage_path = ? WHERE id = ?`, path, id);

export const latestVersion = program_pk =>
  one(`SELECT * FROM content_versions WHERE program_pk = ? ORDER BY version DESC LIMIT 1`, program_pk);

export const contentVersion = id =>
  one(`SELECT * FROM content_versions WHERE id = ?`, id);

/* ---------------- assignments ---------------- */

export function assign({ person_id, program_pk, due_at = null }) {
  run(`INSERT OR IGNORE INTO assignments (person_id, program_pk, assigned_at, due_at)
       VALUES (?,?,?,?)`, person_id, program_pk, now(), due_at);
  return one(`SELECT * FROM assignments WHERE person_id = ? AND program_pk = ?`,
             person_id, program_pk);
}

/* ---------------- registrations ---------------- */

/** The registration for this person + content version. A previous attempt that
 *  ended with a normal exit means the next launch is a NEW attempt, not a resume —
 *  a rule the harness surfaced and the server now owns. */
export function openRegistration({ person_id, content_version_id }) {
  const prev = one(
    `SELECT * FROM registrations
      WHERE person_id = ? AND content_version_id = ?
      ORDER BY attempt DESC LIMIT 1`, person_id, content_version_id);

  if (prev && !prev.terminated_at) return prev;                 // still open

  /* Suspended and unfinished: resume that attempt. Completion alone is not
     enough to make a quiz course finished — Rustici's Golf sample writes it
     on ARRIVAL at the quiz page. A missing result plus an explicit suspend is
     still resumable. Rise's completed courses carry passed/failed, so they
     correctly fall through to a new attempt even if Rise leaves suspend set.
     Attempts are rows, not overwritten fields. */
  if (prev && registrationResumable(prev)) return prev;

  const attempt = prev ? prev.attempt + 1 : 1;
  // Time accrues across attempts — the accrued total only, never a
  // session that was still open when the last attempt ended.
  const carried = prev ? (prev.total_seconds + (prev.session_seconds || 0)) : 0;
  run(`INSERT INTO registrations
       (person_id, content_version_id, attempt, total_seconds, entry, created_at)
       VALUES (?,?,?,?,?,?)`,
      person_id, content_version_id, attempt, carried, "ab-initio", now());
  return one(`SELECT * FROM registrations WHERE person_id = ? AND content_version_id = ? AND attempt = ?`,
             person_id, content_version_id, attempt);
}

export const registration = id => one(`SELECT * FROM registrations WHERE id = ?`, id);

/** Persist on EVERY write. Courses do not call Commit — observed: five bookmarks
 *  and zero commits in 244 seconds — so durability cannot be delegated to them. */
export function updateRegistration(id, patch) {
  const cols = Object.keys(patch);
  if (!cols.length) return registration(id);
  run(`UPDATE registrations SET ${cols.map(c => `${c} = ?`).join(", ")}, last_write_at = ?
        WHERE id = ?`, ...cols.map(c => patch[c]), now(), id);
  return registration(id);
}

/** The integration contract: subject_id + program_id identify this record
 *  to the SaaS. Both live behind joins, so callers never assemble SQL. */
export const contextFor = registration_id => one(
  `SELECT p.subject_id, pr.program_id, pr.title, cv.scorm_version
     FROM registrations r
     JOIN people p           ON p.id  = r.person_id
     JOIN content_versions cv ON cv.id = r.content_version_id
     JOIN programs pr        ON pr.id = cv.program_pk
    WHERE r.id = ?`, registration_id);

/** Sessions that were opened, written to, and then went quiet. `Terminate`
 *  usually never arrives from a phone, so the server has to notice itself. */
export const idleRegistrations = (cutoffIso) => all(
  `SELECT * FROM registrations
    WHERE terminated_at IS NULL
      AND started_at IS NOT NULL
      AND COALESCE(last_write_at, started_at) < ?`, cutoffIso);

export const registrationsFor = subject_id => all(
  `SELECT r.*, p.subject_id, pr.program_id, pr.title
     FROM registrations r
     JOIN people p ON p.id = r.person_id
     JOIN content_versions cv ON cv.id = r.content_version_id
     JOIN programs pr ON pr.id = cv.program_pk
    WHERE p.subject_id = ?
    ORDER BY r.id DESC`, subject_id);

/* ---------------- launch tickets ----------------
   Short-lived, single-use, bound to one registration. Replaces the
   "customer id in the URL" IDOR this project exists to remove. */
const TICKET_TTL_MS = 60_000;

export function issueTicket(registration_id) {
  const token = crypto.randomUUID().replace(/-/g, "");
  run(`INSERT INTO launch_tickets (token, registration_id, expires_at, created_at)
       VALUES (?,?,?,?)`,
      token, registration_id, new Date(Date.now() + TICKET_TTL_MS).toISOString(), now());
  return { token, expires_in: TICKET_TTL_MS / 1000 };
}

/** Validate and consume in one step. Returns {error} rather than throwing so the
 *  caller can distinguish expired from already-used from unknown. */
export function redeemTicket(token) {
  const t = one(`SELECT * FROM launch_tickets WHERE token = ?`, token);
  if (!t) return { error: "unknown ticket" };
  if (t.consumed_at) return { error: "ticket already used" };
  if (new Date(t.expires_at) < new Date()) return { error: "ticket expired" };
  run(`UPDATE launch_tickets SET consumed_at = ? WHERE id = ?`, now(), t.id);
  return { registration_id: t.registration_id };
}

/* ---------------- webhook deliveries ---------------- */

export const recordDelivery = d => run(
  `INSERT INTO webhook_deliveries
     (registration_id, endpoint, payload, status, http_status, error, created_at)
   VALUES (?,?,?,?,?,?,?)`,
  d.registration_id, d.endpoint ?? null, JSON.stringify(d.payload),
  d.status, d.http_status ?? null, d.error ?? null, now());

export const deliveries = (limit = 50) => all(
  `SELECT d.*, p.subject_id
     FROM webhook_deliveries d
     JOIN registrations r ON r.id = d.registration_id
     JOIN people p ON p.id = r.person_id
    ORDER BY d.id DESC LIMIT ?`, limit);

/* ---------------- xAPI statements & state ----------------
   The registration-scoped session is the authority for both stores. Actor,
   activity and registration values inside a submitted statement are useful
   evidence, but they never decide which learner row receives it. */

export function storeXapiStatement(registration_id, statement) {
  const result = run(
    `INSERT OR IGNORE INTO xapi_statements (id, registration_id, statement, stored_at)
     VALUES (?,?,?,?)`,
    statement.id, registration_id, JSON.stringify(statement), now());
  return { inserted: result.changes === 1, id: statement.id };
}

export const xapiStatement = (registration_id, id) => one(
  `SELECT * FROM xapi_statements WHERE registration_id = ? AND id = ?`,
  registration_id, id);

export const xapiStatements = registration_id => all(
  `SELECT * FROM xapi_statements WHERE registration_id = ? ORDER BY stored_at, id`,
  registration_id);

const languageValue = value => {
  if (!value || typeof value !== "object") return null;
  return value["en-US"] || value["en"] || Object.values(value)[0] || null;
};

const activityLabels = activities => (Array.isArray(activities) ? activities : [])
  .map(a => languageValue(a?.definition?.name) || a?.id || null).filter(Boolean);

const COURSE_METADATA = new Map();
function courseMetadata(storagePath) {
  if (!storagePath || COURSE_METADATA.has(storagePath)) return COURSE_METADATA.get(storagePath) || new Map();
  const map = new Map();
  try {
    const raw = readFileSync(`${storagePath}/scormcontent/runtime-data.js`, "utf8");
    const b64 = raw.match(/__jsonp\("runtime-data\.js","([\s\S]*)"\);?$/)?.[1];
    const course = b64 ? JSON.parse(Buffer.from(b64, "base64").toString()).course : null;
    let section = null;
    for (const lesson of course?.lessons || []) {
      if (lesson.type === "section") { section = lesson.title; continue; }
      const visit = item => {
        if (!item || typeof item !== "object") return;
        if (item.id) map.set(String(item.id), { lesson: lesson.title || null, section });
        for (const child of item.items || []) visit(child);
      };
      for (const item of lesson.items || []) visit(item);
    }
  } catch {}
  COURSE_METADATA.set(storagePath, map);
  return map;
}

/** A staff-facing view derived from the immutable statement record. */
export function xapiResponsesForRegistration(registration_id) {
  const storage = one(`SELECT cv.storage_path FROM registrations r
    JOIN content_versions cv ON cv.id = r.content_version_id WHERE r.id = ?`, registration_id)?.storage_path;
  const metadata = courseMetadata(storage);
  const answers = xapiStatements(registration_id).flatMap(row => {
    let s;
    try { s = JSON.parse(row.statement); } catch { return []; }
    if (!String(s?.verb?.id || "").endsWith("/answered")) return [];
    const definition = s?.object?.definition || {};
    const objectId = String(s?.object?.id || "");
    const parts = objectId.split("/");
    const courseContext = metadata.get(parts.at(-2)) || metadata.get(parts.at(-1)) || {};
    return [{
      statement_id: s.id,
      question_id: s?.object?.id || null,
      question: languageValue(definition.description)
        || languageValue(definition.name) || s?.object?.id || "Survey response",
      interaction_type: definition.interactionType || null,
      // Articulate includes parent/grouping activity metadata when available.
      // Keep both labels separately so staff can distinguish a lesson from
      // its containing section; raw statements remain the source if a future
      // export adds richer activity definitions.
      lesson: courseContext.lesson || activityLabels(s?.context?.contextActivities?.parent)
        .find((_, i) => i > 0) || null,
      section: courseContext.section || activityLabels(s?.context?.contextActivities?.grouping)
        .find(v => v.includes("/section")) || null,
      response: s?.result?.response ?? null,
      submitted_at: s.timestamp || row.stored_at
    }];
  });
  const prior = new Map();
  return answers.map(answer => {
    const text = typeof answer.response === "string" ? answer.response.trim() : "";
    const flags = [];
    if (!text) flags.push("empty");
    const normalized = text.toLowerCase().replace(/\s+/g, " ");
    if (normalized && prior.has(normalized)) flags.push("repeated");
    if (normalized) prior.set(normalized, true);
    // A conservative deterministic check for obvious keyboard-gibberish:
    // long runs of repeated/alternating characters with no word boundaries.
    if (text.length >= 8 && !/\s/.test(text)
        && (/(.)\1{3,}/i.test(text) || /(.{1,3})\1{2,}/i.test(text)))
      flags.push("possible_gibberish");
    return { ...answer, quality_flags: flags,
      quality_status: flags.length ? "review" : "ok" };
  });
}

export const xapiState = (registration_id, activity_id, state_id) => one(
  `SELECT * FROM xapi_state
    WHERE registration_id = ? AND activity_id = ? AND state_id = ?`,
  registration_id, activity_id, state_id);

export const xapiStateIds = (registration_id, activity_id) => all(
  `SELECT state_id FROM xapi_state
    WHERE registration_id = ? AND activity_id = ? ORDER BY state_id`,
  registration_id, activity_id).map(r => r.state_id);

export function putXapiState({ registration_id, activity_id, state_id,
                               document, content_type, etag }) {
  run(`INSERT INTO xapi_state
         (registration_id, activity_id, state_id, document, content_type, etag, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(registration_id, activity_id, state_id) DO UPDATE SET
         document = excluded.document,
         content_type = excluded.content_type,
         etag = excluded.etag,
         updated_at = excluded.updated_at`,
      registration_id, activity_id, state_id, document, content_type, etag, now());
  return xapiState(registration_id, activity_id, state_id);
}

export const deleteXapiState = (registration_id, activity_id, state_id = null) =>
  state_id === null
    ? run(`DELETE FROM xapi_state WHERE registration_id = ? AND activity_id = ?`,
          registration_id, activity_id)
    : run(`DELETE FROM xapi_state
            WHERE registration_id = ? AND activity_id = ? AND state_id = ?`,
          registration_id, activity_id, state_id);

/* Everything captured, for the console. */
export const allRegistrations = () => all(
  `SELECT r.*, p.subject_id, p.name, pr.program_id, pr.title, cv.scorm_version, cv.version
     FROM registrations r
     JOIN people p            ON p.id  = r.person_id
     JOIN content_versions cv ON cv.id = r.content_version_id
     JOIN programs pr         ON pr.id = cv.program_pk
    ORDER BY r.last_write_at DESC NULLS LAST, r.id DESC`);

/** What a learner has been assigned, with where they are in each.
 *  Both joins pin to a specific row — the LATEST content version, and the
 *  LATEST attempt against it. Joining "any" version silently returns the
 *  wrong registration once a package has been re-uploaded. */
export const assignmentsFor = subject_id => all(
  `SELECT pr.program_id, pr.title, cv.scorm_version, cv.id AS content_version_id,
          r.id AS registration_id, r.completion_status, r.success_status,
          r.score_raw, r.score_max, r.attempt, r.entry, r.exit_mode,
          r.suspend_data_len, r.suspend_overflow_at,
          (r.total_seconds + COALESCE(r.session_seconds,0)) AS total_seconds
     FROM assignments a
     JOIN people p    ON p.id  = a.person_id
     JOIN programs pr ON pr.id = a.program_pk
     JOIN content_versions cv ON cv.id = (
            SELECT id FROM content_versions
             WHERE program_pk = pr.id ORDER BY version DESC LIMIT 1)
     LEFT JOIN registrations r ON r.id = (
            SELECT id FROM registrations
             WHERE person_id = p.id AND content_version_id = cv.id
             ORDER BY attempt DESC LIMIT 1)
    WHERE p.subject_id = ?
    ORDER BY a.assigned_at DESC`, subject_id);

/* ---------------- credentials ---------------- */

export const personById = id => one(`SELECT * FROM people WHERE id = ?`, id);
export const personBySubjectId = subject_id =>
  one(`SELECT * FROM people WHERE subject_id = ?`, subject_id);

/** Which people have a Waypoint login, keyed by the SaaS's own id. One query
 *  so a roster of any size costs the same as a single subject. */
export const subjectsWithLogin = () => all(
  `SELECT DISTINCT p.subject_id FROM credentials c JOIN people p ON p.id = c.person_id
    WHERE c.kind = 'password'`).map(r => r.subject_id);

export const passwordFor = person_id =>
  one(`SELECT * FROM credentials WHERE kind = 'password' AND person_id = ?`, person_id);

/** Overwrites any existing password — this is the reset primitive. Callers that
 *  only want a login to exist must check {@link passwordFor} first: silently
 *  rotating a password invalidates one already handed to the person. */
export function setPassword({ person_id, identifier, secret_hash, must_change = 0 }) {
  const existing = one(`SELECT * FROM credentials WHERE kind = 'password' AND person_id = ?`, person_id);
  if (existing) {
    run(`UPDATE credentials SET identifier = ?, secret_hash = ?, must_change = ? WHERE id = ?`,
        identifier, secret_hash, must_change ? 1 : 0, existing.id);
    return one(`SELECT * FROM credentials WHERE id = ?`, existing.id);
  }
  run(`INSERT INTO credentials (person_id, kind, identifier, secret_hash, must_change, created_at)
       VALUES (?,'password',?,?,?,?)`, person_id, identifier, secret_hash, must_change ? 1 : 0, now());
  return one(`SELECT * FROM credentials WHERE kind = 'password' AND identifier = ?`, identifier);
}

/** Look up by what the learner typed. Identifier is matched case-insensitively
 *  because people do not type their email consistently. */
export const credentialByIdentifier = identifier =>
  one(`SELECT c.*, p.subject_id, p.name
         FROM credentials c JOIN people p ON p.id = c.person_id
        WHERE c.kind = 'password' AND lower(c.identifier) = lower(?)`, identifier);

export const markCredentialUsed = id =>
  run(`UPDATE credentials SET last_used_at = ? WHERE id = ?`, now(), id);

/* ---------------- catalog ---------------- */

/** What the SaaS can offer. Only programs with ingested content appear. */
export const catalog = () => all(
  `SELECT pr.program_id, pr.title, pr.description,
          cv.scorm_version, cv.version, cv.id AS content_version_id
     FROM programs pr
     JOIN content_versions cv ON cv.id = (
            SELECT id FROM content_versions
             WHERE program_pk = pr.id ORDER BY version DESC LIMIT 1)
    ORDER BY pr.title`);

/** Live state of every assignment, for the SaaS to poll.
 *  A completion webhook is a push; this is the pull. A system needs both:
 *  the push for timeliness, the pull for anything that arrives before a
 *  completion — or for reconciling a delivery that was missed. */
export const enrollments = () => all(
  `SELECT p.subject_id, p.name, pr.program_id, pr.title,
          cv.scorm_version, r.id AS registration_id,
          r.completion_status, r.success_status, r.score_raw, r.score_max,
          (r.total_seconds + COALESCE(r.session_seconds,0)) AS total_seconds,
          r.attempt, r.exit_mode,
          r.started_at, r.last_write_at, r.terminated_at,
          a.assigned_at
     FROM assignments a
     JOIN people p    ON p.id  = a.person_id
     JOIN programs pr ON pr.id = a.program_pk
     LEFT JOIN content_versions cv ON cv.id = (
            SELECT id FROM content_versions
             WHERE program_pk = pr.id ORDER BY version DESC LIMIT 1)
     LEFT JOIN registrations r ON r.id = (
            SELECT id FROM registrations
             WHERE person_id = p.id AND content_version_id = cv.id
             ORDER BY attempt DESC LIMIT 1)
    ORDER BY COALESCE(r.last_write_at, a.assigned_at) DESC`);

/* ---------------- unassign ----------------
   Only while untouched. Once a learner has written anything there is a
   record of what they did, and deleting it would destroy that. */

export function assignmentState(subject_id, program_id) {
  return one(
    `SELECT a.id AS assignment_id, p.id AS person_id, pr.id AS program_pk,
            r.id AS registration_id, r.completion_status, r.last_write_at, r.attempt
       FROM assignments a
       JOIN people p    ON p.id  = a.person_id
       JOIN programs pr ON pr.id = a.program_pk
       LEFT JOIN content_versions cv ON cv.program_pk = pr.id
       LEFT JOIN registrations r ON r.person_id = p.id
                                AND r.content_version_id = cv.id
      WHERE p.subject_id = ? AND pr.program_id = ?
      ORDER BY r.attempt DESC LIMIT 1`, subject_id, program_id);
}

export function unassign({ person_id, program_pk }) {
  // Remove the untouched registrations first — a foreign key points at them.
  run(`DELETE FROM registrations
        WHERE person_id = ? AND last_write_at IS NULL
          AND content_version_id IN (SELECT id FROM content_versions WHERE program_pk = ?)`,
      person_id, program_pk);
  run(`DELETE FROM assignments WHERE person_id = ? AND program_pk = ?`, person_id, program_pk);
}


/* ---------------- a subject's session ----------------

   Server-side rows so a session can be ENDED. The token itself is never
   stored, only its hash — the same rule as staff sessions, for the same
   reason: this table leaking must not hand anybody a live session. */

export function createLearnerSession({ token_hash, person_id, ttl_ms, ip, user_agent }) {
  run(`INSERT INTO learner_sessions
         (token_hash, person_id, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES (?,?,?,?,?,?,?)`,
      token_hash, person_id, now(), new Date(Date.now() + ttl_ms).toISOString(),
      now(), ip ?? null, user_agent ?? null);
}

/** The person this session belongs to, or null if it is over for any reason. */
export function learnerSession(token_hash) {
  const s = one(`SELECT ls.*, p.subject_id, p.name
                   FROM learner_sessions ls JOIN people p ON p.id = ls.person_id
                  WHERE ls.token_hash = ?`, token_hash);
  if (!s) return null;
  if (s.revoked_at) return null;
  if (new Date(s.expires_at) < new Date()) return null;
  run(`UPDATE learner_sessions SET last_seen_at = ? WHERE id = ?`, now(), s.id);
  return s;
}

export const revokeLearnerSession = token_hash =>
  run(`UPDATE learner_sessions SET revoked_at = ? WHERE token_hash = ?`, now(), token_hash);

/** Every session this person has, everywhere. What a lost phone needs. */
export const revokeLearnerSessionsFor = person_id =>
  run(`UPDATE learner_sessions SET revoked_at = ?
        WHERE person_id = ? AND revoked_at IS NULL`, now(), person_id);

/* Expired rows are cleared on a schedule rather than left to accumulate; the
   session is already invalid by then, so this is housekeeping, not security. */
export const sweepLearnerSessions = () =>
  run(`DELETE FROM learner_sessions WHERE expires_at < ?`,
      new Date(Date.now() - 7 * 864e5).toISOString());

export { now, db };
