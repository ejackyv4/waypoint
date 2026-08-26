/**
 * Waypoint PoC — data layer.
 *
 * All database access goes through this module. Nothing else opens the
 * database or writes SQL. That is the chokepoint rule from CLAUDE.md:
 * the insurance that makes later structural change (scoping, auditing,
 * caching) a one-file edit instead of an archaeology project.
 *
 * Zero dependencies — node:sqlite, built in since Node 22.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(HERE, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, "waypoint.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

/* ------------------------------------------------------------------
   Schema. Six tables. Resist a seventh.

   The shape here is load-bearing, not incidental — see CLAUDE.md:
     · completion_status and success_status are SEPARATE columns
     · suspend_data is opaque, stored with its length so overflow is
       queryable rather than anecdotal
     · time is integer seconds, normalized at the boundary
     · content_versions are immutable once referenced
------------------------------------------------------------------ */
db.exec(`
CREATE TABLE IF NOT EXISTS people (
  id             INTEGER PRIMARY KEY,
  subject_id     TEXT NOT NULL UNIQUE,     -- the SaaS's identifier for this person
  name           TEXT,
  email          TEXT,                     -- NOT unique: see CLAUDE.md on identity
  created_at     TEXT NOT NULL,
  last_active_at TEXT
);

CREATE TABLE IF NOT EXISTS programs (
  id          INTEGER PRIMARY KEY,
  program_id  TEXT NOT NULL UNIQUE,        -- the SaaS's identifier for this program
  title       TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_versions (
  id            INTEGER PRIMARY KEY,
  program_pk    INTEGER NOT NULL REFERENCES programs(id),
  version       INTEGER NOT NULL,
  scorm_version TEXT NOT NULL,             -- "1.2" | "2004 3rd Edition" | ...
  launch_href   TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  sco_count     INTEGER NOT NULL,
  title         TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (program_pk, version)
);

CREATE TABLE IF NOT EXISTS assignments (
  id          INTEGER PRIMARY KEY,
  person_id   INTEGER NOT NULL REFERENCES people(id),
  program_pk  INTEGER NOT NULL REFERENCES programs(id),
  assigned_at TEXT NOT NULL,
  due_at      TEXT,
  source      TEXT NOT NULL DEFAULT 'saas',
  UNIQUE (person_id, program_pk)
);

-- The core record. Everything else exists to produce rows in this table.
CREATE TABLE IF NOT EXISTS registrations (
  id                 INTEGER PRIMARY KEY,
  person_id          INTEGER NOT NULL REFERENCES people(id),
  content_version_id INTEGER NOT NULL REFERENCES content_versions(id),
  attempt            INTEGER NOT NULL DEFAULT 1,

  completion_status  TEXT NOT NULL DEFAULT 'not attempted',
  success_status     TEXT NOT NULL DEFAULT 'unknown',

  score_raw          REAL,
  score_min          REAL,
  score_max          REAL,
  score_scaled       REAL,

  location           TEXT NOT NULL DEFAULT '',
  suspend_data       TEXT NOT NULL DEFAULT '',
  suspend_data_len   INTEGER NOT NULL DEFAULT 0,

  total_seconds      INTEGER NOT NULL DEFAULT 0,
  entry              TEXT NOT NULL DEFAULT 'ab-initio',
  exit_mode          TEXT NOT NULL DEFAULT '',

  started_at         TEXT,
  last_write_at      TEXT,
  terminated_at      TEXT,
  completed_at       TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE (person_id, content_version_id, attempt)
);

CREATE TABLE IF NOT EXISTS launch_tickets (
  id              INTEGER PRIMARY KEY,
  token           TEXT NOT NULL UNIQUE,
  registration_id INTEGER NOT NULL REFERENCES registrations(id),
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT,
  created_at      TEXT NOT NULL
);

-- A completion must never be silently lost. Every delivery attempt is
-- recorded, successful or not, so a failure is visible and retryable
-- rather than a gap nobody notices.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              INTEGER PRIMARY KEY,
  registration_id INTEGER NOT NULL REFERENCES registrations(id),
  endpoint        TEXT,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL,          -- delivered | failed | skipped
  http_status     INTEGER,
  error           TEXT,
  created_at      TEXT NOT NULL
);

-- Credentials are ROWS, not columns on people. A person may have none (a
-- SaaS-provisioned learner who only ever arrives by handoff), one, or later
-- several — password today, SSO tomorrow. Adding a login method then means
-- inserting a row, not reworking the auth path.
CREATE TABLE IF NOT EXISTS credentials (
  id           INTEGER PRIMARY KEY,
  person_id    INTEGER NOT NULL REFERENCES people(id),
  kind         TEXT NOT NULL,              -- 'password' | later 'oidc' | 'saml'
  identifier   TEXT NOT NULL,              -- email or username used to sign in
  secret_hash  TEXT,                       -- scrypt; null for external kinds
  must_change  INTEGER NOT NULL DEFAULT 0, -- provisioned temp password
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (kind, identifier)
);

-- The mock SaaS's OWN record of what Waypoint told it. Conceptually this
-- belongs to the other system entirely; it lives here only because the PoC
-- runs both in one process.
CREATE TABLE IF NOT EXISTS saas_inbox (
  id          INTEGER PRIMARY KEY,
  subject_id  TEXT NOT NULL,
  program_id  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  verified    INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL
);

-- ============================================================
-- Northwood's own records. Conceptually a separate system; they
-- live here only because the PoC runs both in one process.
-- ============================================================

CREATE TABLE IF NOT EXISTS officers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  badge       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subjects (
  id            INTEGER PRIMARY KEY,
  subject_id    TEXT NOT NULL UNIQUE,   -- the key shared with Waypoint
  case_number   TEXT NOT NULL,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  dob           TEXT,
  phone         TEXT,
  email         TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city          TEXT,
  state         TEXT,
  postal_code   TEXT,
  status        TEXT NOT NULL DEFAULT 'Active supervision',
  officer_id    INTEGER REFERENCES officers(id),
  intake_date   TEXT,
  next_review   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

-- Visits belong to the corrections system, not the LMS. They live here only
-- because the PoC runs both in one process.
CREATE TABLE IF NOT EXISTS visits (
  id              INTEGER PRIMARY KEY,
  subject_id      TEXT NOT NULL,
  scheduled_at    TEXT NOT NULL,          -- ISO datetime of the visit
  officer         TEXT,
  location        TEXT,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled|accepted|completed|cancelled
  seen_at         TEXT,                   -- when the subject viewed it; drives the badge
  accepted_at     TEXT,                   -- subject confirmed they will attend
  completed_at    TEXT,                   -- officer marked the visit as having happened
  completed_by    TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_visits_subject ON visits(subject_id, scheduled_at);
CREATE INDEX IF NOT EXISTS ix_reg_person ON registrations(person_id);
CREATE INDEX IF NOT EXISTS ix_cred_ident ON credentials(kind, identifier);
CREATE INDEX IF NOT EXISTS ix_ticket_token ON launch_tickets(token);
`);

/* Add columns to a table that already exists. SQLite has no
   ADD COLUMN IF NOT EXISTS, so check first. */
function ensureColumn(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
for (const [c, d] of [["accepted_at","TEXT"],["completed_at","TEXT"],["completed_by","TEXT"],
                      ["requested_by","TEXT"],["requested_at","TEXT"],["request_note","TEXT"]])
  ensureColumn("visits", c, d);

/* A subject-requested appointment has no date yet — the officer sets it.
   SQLite cannot drop NOT NULL, so rebuild the table if it still has one. */
(function relaxVisitDate() {
  const col = db.prepare(`PRAGMA table_info(visits)`).all().find(c => c.name === "scheduled_at");
  if (!col || col.notnull === 0) return;
  db.exec(`
    CREATE TABLE visits_new (
      id INTEGER PRIMARY KEY, subject_id TEXT NOT NULL, scheduled_at TEXT,
      officer TEXT, location TEXT, notes TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled', seen_at TEXT,
      accepted_at TEXT, completed_at TEXT, completed_by TEXT,
      requested_by TEXT, requested_at TEXT, request_note TEXT,
      created_at TEXT NOT NULL);
    INSERT INTO visits_new SELECT id, subject_id, scheduled_at, officer, location, notes,
      status, seen_at, accepted_at, completed_at, completed_by,
      requested_by, requested_at, request_note, created_at FROM visits;
    DROP TABLE visits;
    ALTER TABLE visits_new RENAME TO visits;
    CREATE INDEX IF NOT EXISTS ix_visits_subject ON visits(subject_id, scheduled_at);`);
})();

const now = () => new Date().toISOString();
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

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
  if (prev && prev.exit_mode === "suspend") return prev;        // suspended: resume it

  const attempt = prev ? prev.attempt + 1 : 1;
  const carried = prev ? prev.total_seconds : 0;                // time accrues across attempts
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
          r.score_raw, r.score_max, r.total_seconds, r.attempt, r.entry, r.exit_mode
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

/* ---------------- mock SaaS inbox ---------------- */

export const saasReceive = d => run(
  `INSERT INTO saas_inbox (subject_id, program_id, payload, verified, received_at)
   VALUES (?,?,?,?,?)`,
  d.subject_id, d.program_id, JSON.stringify(d.payload), d.verified ? 1 : 0, now());

export const saasInbox = (limit = 50) =>
  all(`SELECT * FROM saas_inbox ORDER BY id DESC LIMIT ?`, limit);

/** Everyone the SaaS knows about, with whatever LMS state came back. */
export const saasPeople = () => all(
  `SELECT p.subject_id, p.name, p.email,
          (SELECT identifier FROM credentials c WHERE c.person_id = p.id AND c.kind='password') AS login,
          (SELECT COUNT(*) FROM assignments a WHERE a.person_id = p.id) AS assigned_count
     FROM people p ORDER BY p.id`);

/** Live state of every assignment, for the SaaS to poll.
 *  A completion webhook is a push; this is the pull. A system needs both:
 *  the push for timeliness, the pull for anything that arrives before a
 *  completion — or for reconciling a delivery that was missed. */
export const enrollments = () => all(
  `SELECT p.subject_id, p.name, pr.program_id, pr.title,
          r.completion_status, r.success_status, r.score_raw, r.score_max,
          r.total_seconds, r.attempt, r.exit_mode,
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

/* ---------------- visits (corrections side) ---------------- */

export function scheduleVisit(v) {
  run(`INSERT INTO visits (subject_id, scheduled_at, officer, location, notes, created_at)
       VALUES (?,?,?,?,?,?)`,
      v.subject_id, v.scheduled_at, v.officer ?? null, v.location ?? null,
      v.notes ?? null, now());
  return one(`SELECT * FROM visits WHERE subject_id = ? ORDER BY id DESC LIMIT 1`, v.subject_id);
}

export const visitsFor = subject_id =>
  all(`SELECT * FROM visits WHERE subject_id = ? ORDER BY scheduled_at ASC`, subject_id);

/** Unseen visits drive the badge on the mobile app's Visits tab. */
export const unseenVisitCount = subject_id =>
  one(`SELECT COUNT(*) n FROM visits WHERE subject_id = ? AND seen_at IS NULL`, subject_id)?.n ?? 0;

export const markVisitsSeen = subject_id =>
  run(`UPDATE visits SET seen_at = ? WHERE subject_id = ? AND seen_at IS NULL`, now(), subject_id);

export const cancelVisit = id =>
  run(`UPDATE visits SET status = 'cancelled' WHERE id = ?`, id);

export const visit = id => one(`SELECT * FROM visits WHERE id = ?`, id);

/** The subject asks for an appointment. No date — the officer sets that. */
export function requestVisit({ subject_id, note }) {
  run(`INSERT INTO visits (subject_id, scheduled_at, status, requested_by,
                           requested_at, request_note, created_at)
       VALUES (?, NULL, 'requested', 'subject', ?, ?, ?)`,
      subject_id, now(), note ?? null, now());
  return one(`SELECT * FROM visits WHERE subject_id = ? ORDER BY id DESC LIMIT 1`, subject_id);
}

/** The officer turns a request into a real appointment. */
export function scheduleRequested(id, { scheduled_at, officer, location }) {
  const v = visit(id);
  if (!v) return { error: "no such request" };
  if (v.status !== "requested") return { error: "that appointment is already scheduled" };
  run(`UPDATE visits SET scheduled_at = ?, officer = ?, location = ?,
                         status = 'scheduled', seen_at = NULL
        WHERE id = ?`, scheduled_at, officer ?? null, location ?? null, id);
  return { ok: true, visit: visit(id) };
}

/** The subject confirms they will attend. Scoped by subject_id so a valid
 *  session cannot accept somebody else's appointment. */
export function acceptVisit(id, subject_id) {
  const v = one(`SELECT * FROM visits WHERE id = ? AND subject_id = ?`, id, subject_id);
  if (!v) return { error: "no such visit" };
  if (v.status === "cancelled") return { error: "this visit was cancelled" };
  if (v.status === "completed") return { error: "this visit has already taken place" };
  if (v.accepted_at) return { ok: true, visit: v };            // idempotent
  run(`UPDATE visits SET status = 'accepted', accepted_at = ? WHERE id = ?`, now(), id);
  return { ok: true, visit: visit(id) };
}

/** The officer records that the visit happened. The timestamp is ours, taken
 *  at the moment of recording — not supplied by the caller. */
export function completeVisit(id, officer) {
  const v = visit(id);
  if (!v) return { error: "no such visit" };
  if (v.status === "cancelled") return { error: "this visit was cancelled" };
  if (v.completed_at) return { ok: true, visit: v };            // idempotent
  run(`UPDATE visits SET status = 'completed', completed_at = ?, completed_by = ? WHERE id = ?`,
      now(), officer ?? null, id);
  return { ok: true, visit: visit(id) };
}

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

/* ---------------- Northwood roster ---------------- */

export const allSubjects = () => all(
  `SELECT s.*, o.name AS officer,
          s.first_name || ' ' || s.last_name AS name
     FROM subjects s LEFT JOIN officers o ON o.id = s.officer_id
    ORDER BY s.last_name, s.first_name`);

export const subjectByKey = subject_id => one(
  `SELECT s.*, o.name AS officer,
          s.first_name || ' ' || s.last_name AS name
     FROM subjects s LEFT JOIN officers o ON o.id = s.officer_id
    WHERE s.subject_id = ?`, subject_id);

/** Seeded once, on an empty database. Real deployments import from the
 *  case-management system; the demo needs a roster to exist. */
export function seedRoster(officers, subjects) {
  if (one(`SELECT COUNT(*) n FROM subjects`).n > 0) return false;
  for (const o of officers)
    run(`INSERT INTO officers (name, email, phone, badge, created_at) VALUES (?,?,?,?,?)`,
        o.name, o.email ?? null, o.phone ?? null, o.badge ?? null, now());
  for (const s of subjects) {
    const off = one(`SELECT id FROM officers WHERE name = ?`, s.officer);
    run(`INSERT INTO subjects
         (subject_id, case_number, first_name, last_name, dob, phone, email,
          address_line1, city, state, postal_code, status, officer_id,
          intake_date, next_review, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        s.subject_id, s.case_number, s.first_name, s.last_name, s.dob, s.phone,
        s.email ?? null, s.address_line1, s.city, s.state, s.postal_code,
        s.status, off?.id ?? null, s.intake_date, s.next_review, now());
  }
  return true;
}

export { db, now };
