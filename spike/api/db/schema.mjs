/**
 * The schema, and the migrations that have run against it.
 *
 * Both systems' tables live here because they share one SQLite file in the
 * PoC. Which system OWNS which table is the important part, and it is marked
 * below — in a real deployment these are two databases, and the ownership
 * comment becomes a connection string.
 *
 * The shape is load-bearing, not incidental — see CLAUDE.md:
 *   · completion_status and success_status are SEPARATE columns
 *   · suspend_data is opaque, stored with its length so overflow is queryable
 *   · time is integer seconds, normalized at the boundary
 *   · content_versions are immutable once referenced
 *
 * Importing this module creates the tables. Import it once, from connect's
 * consumers, before any query runs.
 */

import { db, ensureColumn } from "./connect.mjs";

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

-- Staff of the corrections system. An officer IS a staff member, so this is
-- one table with a role rather than two that must be kept in step.
-- Subjects never appear here — they do not sign in to this system at all.
CREATE TABLE IF NOT EXISTS officers (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT UNIQUE,
  phone           TEXT,
  badge           TEXT,
  role            TEXT NOT NULL DEFAULT 'officer',  -- officer | supervisor | admin
  password_hash   TEXT,
  must_change     INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  last_login_at   TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);

-- Staff sessions are stored server-side so they can be revoked, listed and
-- expired. Only a HASH of the token is kept: a database leak must not hand
-- somebody a set of live sessions.
CREATE TABLE IF NOT EXISTS staff_sessions (
  id           INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  officer_id   INTEGER NOT NULL REFERENCES officers(id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT,
  ip           TEXT,
  user_agent   TEXT,
  revoked_at   TEXT
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

CREATE TABLE IF NOT EXISTS subject_vehicles (
  id         INTEGER PRIMARY KEY,
  subject_id TEXT NOT NULL,
  make       TEXT, model TEXT, year TEXT, color TEXT,
  plate      TEXT, state TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Family and friends. The first module both sides may write: the officer adds
-- what they learn at a visit, the subject keeps their own people current.
-- The added_by column records which side created the row, so an officer can tell what
-- came from the subject without the two becoming separate lists.
CREATE TABLE IF NOT EXISTS subject_contacts (
  id           INTEGER PRIMARY KEY,
  subject_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  relationship TEXT NOT NULL,
  phone        TEXT NOT NULL,
  notes        TEXT,
  added_by     TEXT NOT NULL DEFAULT 'officer',   -- officer|subject
  updated_by   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT
);

CREATE INDEX IF NOT EXISTS ix_contacts_subject ON subject_contacts(subject_id, id);

-- 0..1 per subject, so the subject_id is unique. History is not kept yet;
-- when it is needed this gains valid_from/valid_to and the constraint goes.
CREATE TABLE IF NOT EXISTS curfews (
  id         INTEGER PRIMARY KEY,
  subject_id TEXT NOT NULL UNIQUE,
  active     INTEGER NOT NULL DEFAULT 0,
  start_time TEXT,                       -- "21:00"
  end_time   TEXT,                       -- "06:00"
  notes      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Files held against a subject. Generated documents land here alongside
-- anything uploaded later.
CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY,
  subject_id   TEXT NOT NULL,
  doc_type     TEXT NOT NULL,          -- supervision_agreement | upload | …
  title        TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL DEFAULT 'application/pdf',
  byte_size    INTEGER,
  source_id    INTEGER,                -- the agreement it was rendered from
  generated_at TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_documents_subject ON documents(subject_id, doc_type);

-- Reference data. A table rather than a hardcoded list, because offices open,
-- close and rename, and an agreement must keep showing the one it named.
CREATE TABLE IF NOT EXISTS offices (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  address    TEXT,
  phone      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- The supervision agreement: the legal document. Supervision Information
-- from the spec lives here as fields, because it describes the agreement
-- rather than being a condition of it.
CREATE TABLE IF NOT EXISTS agreements (
  id                INTEGER PRIMARY KEY,
  subject_id        TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'probation',  -- probation | parole | supervision
  supervision_level TEXT,                                -- standard | medium | intensive …
  start_date        TEXT,
  end_date          TEXT,
  office            TEXT,
  officer_name      TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',       -- draft|active|expired|revoked
  violation_text    TEXT,
  -- Two signatures, separately timestamped. "Explained" and "understood"
  -- are claims about a moment; collapsing them into one flag loses who
  -- acknowledged what, and when.
  officer_signed_at TEXT,
  officer_signed_by TEXT,
  subject_signed_at TEXT,
  amended_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT
);

-- One clause. Grouped by the categories from the spec.
--
-- obligation_id is the bridge the spec asks for: "report as directed" is
-- text; the appointment it produces is an obligation. A condition may
-- create one, or be a rule with nothing to do.
CREATE TABLE IF NOT EXISTS agreement_conditions (
  id            INTEGER PRIMARY KEY,
  agreement_id  INTEGER NOT NULL REFERENCES agreements(id),
  category      TEXT NOT NULL,
  body          TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  obligation_id INTEGER REFERENCES obligations(id),
  created_at    TEXT NOT NULL
);

-- What the subject actually accepted, and when. Append-only: an amendment
-- clears their signature and asks again, and both acceptances stay on the
-- record. The snapshot is the full agreement text as it read at that moment --
-- without it, what they agreed to is unanswerable after the third edit.
CREATE TABLE IF NOT EXISTS agreement_acknowledgments (
  id              INTEGER PRIMARY KEY,
  agreement_id    INTEGER NOT NULL REFERENCES agreements(id),
  subject_id      TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  snapshot        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_ack_agreement ON agreement_acknowledgments(agreement_id, id);
CREATE INDEX IF NOT EXISTS ix_agreements_subject ON agreements(subject_id, status);
CREATE INDEX IF NOT EXISTS ix_conditions_agreement ON agreement_conditions(agreement_id, category, sort_order);

-- The subject's current travel permission. 0..1, like a curfew: a standing
-- status the officer sets, not a per-trip document. If per-trip permits are
-- needed later this loses the UNIQUE and gains a date range.
CREATE TABLE IF NOT EXISTS travel_permits (
  id         INTEGER PRIMARY KEY,
  subject_id TEXT NOT NULL UNIQUE,
  level      TEXT NOT NULL DEFAULT 'none',   -- none|local|interstate|international
  expires_on TEXT,                            -- ISO date; null means no expiry
  notes      TEXT,
  issued_by  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Where the subject works. 0..1, like a curfew or a travel permit: a standing
-- fact the officer records, not a history of every job held. The company
-- columns are only meaningful when status = 'employed'; self-employment and
-- unemployment carry no employer.
CREATE TABLE IF NOT EXISTS employment (
  id           INTEGER PRIMARY KEY,
  subject_id   TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'not_employed',  -- employed|not_employed|self_employed
  company_name TEXT,
  address      TEXT,
  phone        TEXT,
  supervisor   TEXT,
  notes        TEXT,
  updated_by   TEXT,                                    -- officer|subject
  created_at   TEXT NOT NULL,
  updated_at   TEXT
);

-- One table for every "must do X" placed on a subject. Community service is
-- the first kind; action steps, imposed responses and treatment attendance
-- are the same shape and become rows here rather than three more tables.
-- See docs/SCHEMA-PLAN.md.
CREATE TABLE IF NOT EXISTS obligations (
  id                INTEGER PRIMARY KEY,
  subject_id        TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'community_service',
  title             TEXT NOT NULL,
  description       TEXT,
  required_quantity REAL,                -- hours, sessions, payments…
  unit              TEXT,                -- 'hours'
  status            TEXT NOT NULL DEFAULT 'todo',   -- todo | in_progress | complete
  due_at            TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT
);

CREATE INDEX IF NOT EXISTS ix_obligations_subject ON obligations(subject_id, kind);
CREATE INDEX IF NOT EXISTS ix_vehicles_subject ON subject_vehicles(subject_id);

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

-- What the officer recorded about a visit. Separate from visits.notes,
-- which is the instruction given to the subject beforehand ("bring proof of
-- employment") — a different fact with a different author and audience.
--
-- Append-only: a correction is a new note, never an edit. In this domain the
-- record of what was recorded when is itself evidence.
CREATE TABLE IF NOT EXISTS visit_notes (
  id         INTEGER PRIMARY KEY,
  visit_id   INTEGER NOT NULL REFERENCES visits(id),
  body       TEXT NOT NULL,
  author     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_visit_notes ON visit_notes(visit_id, created_at);
CREATE INDEX IF NOT EXISTS ix_visits_subject ON visits(subject_id, scheduled_at);
CREATE INDEX IF NOT EXISTS ix_reg_person ON registrations(person_id);
CREATE INDEX IF NOT EXISTS ix_cred_ident ON credentials(kind, identifier);
CREATE INDEX IF NOT EXISTS ix_ticket_token ON launch_tickets(token);
`);

ensureColumn("agreements", "amended_at", "TEXT");
/* cmi.core.session_time is the elapsed time of the CURRENT session, rewritten
   as it grows — not a delta. It gets its own column and is folded into
   total_seconds when the session closes. See mapWrite in waypoint.mjs. */
ensureColumn("registrations", "session_seconds", "INTEGER NOT NULL DEFAULT 0");
/* When suspend_data first exceeded what this SCORM version allows. Resume is
   already broken for this learner at that point — the flag is how anyone finds
   out, instead of the learner discovering it and nobody being able to explain
   why. Never truncate: truncation IS the bug. */
ensureColumn("registrations", "suspend_overflow_at", "TEXT");
// Both sides maintain employment, so the record says who touched it last.
ensureColumn("employment", "updated_by", "TEXT");

for (const [c, d] of [["role","TEXT NOT NULL DEFAULT 'officer'"],["password_hash","TEXT"],
                      ["must_change","INTEGER NOT NULL DEFAULT 0"],
                      ["failed_attempts","INTEGER NOT NULL DEFAULT 0"],
                      ["locked_until","TEXT"],["last_login_at","TEXT"]])
  ensureColumn("officers", c, d);

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
    -- What the officer recorded about a visit. Separate from visits.notes,
-- which is the instruction given to the subject beforehand ("bring proof of
-- employment") — a different fact with a different author and audience.
--
-- Append-only: a correction is a new note, never an edit. In this domain the
-- record of what was recorded when is itself evidence.
CREATE TABLE IF NOT EXISTS visit_notes (
  id         INTEGER PRIMARY KEY,
  visit_id   INTEGER NOT NULL REFERENCES visits(id),
  body       TEXT NOT NULL,
  author     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_visit_notes ON visit_notes(visit_id, created_at);
CREATE INDEX IF NOT EXISTS ix_visits_subject ON visits(subject_id, scheduled_at);`);
})();

