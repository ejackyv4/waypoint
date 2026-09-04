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
   Schema. Core LMS tables plus append-only xAPI statements and mutable xAPI
   state. Resist adding another projection of either.

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

-- The immutable evidence received from an xAPI course. Statements are kept
-- whole instead of projecting selected fields into columns: authoring tools
-- add extensions over time, and dropping an unfamiliar field here would make
-- it impossible to reconstruct what the learner actually submitted.
CREATE TABLE IF NOT EXISTS xapi_statements (
  id              TEXT PRIMARY KEY,
  registration_id INTEGER NOT NULL REFERENCES registrations(id),
  statement       TEXT NOT NULL,
  stored_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_xapi_statements_registration
  ON xapi_statements(registration_id, stored_at, id);

-- xAPI State documents are mutable resume state, not learner answers. Keeping
-- them separate preserves the append-only statement record while allowing a
-- course to replace its bookmark/session document as the xAPI spec expects.
CREATE TABLE IF NOT EXISTS xapi_state (
  registration_id INTEGER NOT NULL REFERENCES registrations(id),
  activity_id     TEXT NOT NULL,
  state_id        TEXT NOT NULL,
  document        BLOB NOT NULL,
  content_type    TEXT,
  etag            TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (registration_id, activity_id, state_id)
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

-- A signed-in subject's session, so it can be ENDED.
--
-- This was a stateless HMAC carrying a person id and an expiry: cheap, needing
-- no table, and impossible to revoke. A subject who lost their phone had no
-- answer but to wait twelve hours, and there was nothing an officer could do
-- for them in the meantime. Staff sessions have been server-side rows since
-- they existed; the subjects' session — the one that opens a person's own
-- supervision record — was the weaker of the two.
--
-- Only a HASH of the token is kept, exactly as for staff: a leak of this table
-- must not hand anybody a live session.
CREATE TABLE IF NOT EXISTS learner_sessions (
  id           INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  person_id    INTEGER NOT NULL REFERENCES people(id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT,
  ip           TEXT,
  user_agent   TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_learner_sessions_person
  ON learner_sessions(person_id);

-- Who looked at whose record, and when.
--
-- Supervision data is the kind where reading it is itself an act worth
-- recording: "which officer opened this person's file" is a question that gets
-- asked after something has gone wrong, and it can only be answered if it was
-- being written down beforehand. Retrofitting this once real records exist is
-- archaeology — there is no way to reconstruct who read what last year.
--
-- Append-only. Nothing in the application deletes from here.
--
-- Deliberately NOT a general query log. It records reads of a PERSON's record,
-- which is the thing with a subject to be accountable to; logging every SELECT
-- would produce volume nobody reads and hide the entries that matter.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  actor       TEXT,            -- 'officer:3', 'subject:cust-1041', 'api-key', 'system'
  action      TEXT NOT NULL,   -- 'read' | 'write' | 'export'
  entity      TEXT NOT NULL,   -- 'subject' | 'visit' | 'recording' | 'registrations'
  entity_id   TEXT,            -- the subject_id or row id it concerns
  detail      TEXT,            -- free text, short
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_log(entity, entity_id, id);
CREATE INDEX IF NOT EXISTS ix_audit_at     ON audit_log(at);

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

-- The officer's running record of a case: what was said, decided or noticed
-- between visits. Distinct from visit_notes, which belong to one appointment;
-- a case note stands on its own.
--
-- APPEND-ONLY. A correction is a new note, never an edit. In this domain the
-- record of what was recorded, and when, is itself evidence — and a note that
-- can be rewritten later is worth nothing at a hearing.
CREATE TABLE IF NOT EXISTS case_notes (
  id         INTEGER PRIMARY KEY,
  subject_id TEXT NOT NULL,
  body       TEXT NOT NULL,
  author     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_case_notes ON case_notes(subject_id, id);

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

-- Photographs taken during a visit. The image itself lives on disk; this row
-- is the record of it — who took it, when, and what they said it shows.
--
-- APPEND-ONLY, like the notes it sits beside. A photograph of a doorway, a
-- damaged window or an empty room is evidence, and evidence that can be
-- quietly removed later is not evidence. Deleting one is a deliberate act
-- somebody has to be able to answer for; there is no endpoint for it.
CREATE TABLE IF NOT EXISTS visit_photos (
  id         INTEGER PRIMARY KEY,
  visit_id   INTEGER NOT NULL REFERENCES visits(id),
  filename   TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  byte_size  INTEGER,
  caption    TEXT,
  author     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_visit_photos ON visit_photos(visit_id, id);
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



/* Dates were seeded as display strings — "17 April 1991" — which cannot be
   compared, sorted, or turned into an age. Same rule as SCORM time: normalise
   on write, format on read. Migrate prose to ISO once. */
(function isoDates() {
  const MONTHS = ["january","february","march","april","may","june","july",
                  "august","september","october","november","december"];
  const toIso = v => {
    if (!v || /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;          // already ISO
    const m = String(v).trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (!m) return v;
    const mi = MONTHS.indexOf(m[2].toLowerCase());
    if (mi < 0) return v;
    return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  };
  for (const col of ["dob", "intake_date", "next_review"]) {
    for (const r of db.prepare(`SELECT id, ${col} AS v FROM subjects WHERE ${col} IS NOT NULL`).all()) {
      const iso = toIso(r.v);
      if (iso !== r.v) db.prepare(`UPDATE subjects SET ${col} = ? WHERE id = ?`).run(iso, r.id);
    }
  }
})();
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
/* WARNING: this rebuilds `visits` from an explicit column list, so it DROPS
   anything added before it runs. Every visits migration must come after it —
   the visit-conduct columns were added above and silently vanished. */
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

-- Photographs taken during a visit. The image itself lives on disk; this row
-- is the record of it — who took it, when, and what they said it shows.
--
-- APPEND-ONLY, like the notes it sits beside. A photograph of a doorway, a
-- damaged window or an empty room is evidence, and evidence that can be
-- quietly removed later is not evidence. Deleting one is a deliberate act
-- somebody has to be able to answer for; there is no endpoint for it.
CREATE TABLE IF NOT EXISTS visit_photos (
  id         INTEGER PRIMARY KEY,
  visit_id   INTEGER NOT NULL REFERENCES visits(id),
  filename   TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  byte_size  INTEGER,
  caption    TEXT,
  author     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_visit_photos ON visit_photos(visit_id, id);
CREATE INDEX IF NOT EXISTS ix_visits_subject ON visits(subject_id, scheduled_at);`);
})();

/* Conducting a visit.
 *
 * scheduled_at is when it was MEANT to happen; started_at and ended_at are
 * when it actually did. They are different facts and reports need both — a
 * visit that ran an hour late, or ran for four minutes, is worth knowing.
 * Both timestamps are taken server-side at the moment the officer acts, never
 * typed, because a time somebody enters afterwards is a recollection.
 *
 * The observations are what the officer saw. They are recorded once, when the
 * visit ends. A correction afterwards is a new note in visit_notes, never an
 * edit — the record of what was recorded when is itself evidence. */
for (const [c, d] of [
  ["started_at",        "TEXT"],
  ["ended_at",          "TEXT"],
  ["location_safe",     "TEXT"],   // yes | concerns | not_assessed
  ["contraband",        "TEXT"],   // none_seen | observed | not_assessed
  ["contraband_detail", "TEXT"],
  ["demeanour",         "TEXT"],   // cooperative | guarded | agitated | impaired | distressed
  ["others_present",    "TEXT"],
  ["subject_present",   "TEXT"],   // yes | no_contact
  ["concerns",          "TEXT"]    // free text: anything the fields above do not cover
]) ensureColumn("visits", c, d);


/* ================================================================
   The reentry plan
   ================================================================

   A plan is not an agreement, and the difference drives the schema.

   The supervision agreement is a document: written once, signed, and true
   from then on. A reentry plan is a *programme of work* — twenty-one areas
   of someone's life that have to be arranged before release, worked through
   over weeks, each one arriving at "done" at a different moment.

   So the plan carries two kinds of signature and they mean different things:

   - On the plan itself, the subject accepts the plan's terms. Same shape as
     the agreement's acknowledgment, and for the same reason: a snapshot of
     what they accepted, append-only, so an amendment cannot rewrite history.

   - On each item, BOTH the officer and the subject sign the checkpoint off.
     An officer cannot declare somebody's housing arranged on their own, and
     a subject cannot declare it either. That is the whole point of a
     checkpoint, and it is why an item's "done" is derived from two
     timestamps rather than typed into one column.

   Readiness is never stored. It is computed from the items every time it is
   asked for, because a stored percentage is a second copy of a fact that
   already exists and will eventually disagree with it. */
db.exec(`
CREATE TABLE IF NOT EXISTS reentry_plans (
  id                  INTEGER PRIMARY KEY,
  subject_id          TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft',  -- draft|active|released|closed
  target_release_date TEXT,
  actual_release_date TEXT,
  facility            TEXT,
  officer_name        TEXT,
  notes               TEXT,
  -- The officer issues the plan; the subject accepts it. Separately stamped,
  -- for the same reason the agreement stamps them separately.
  officer_signed_at   TEXT,
  officer_signed_by   TEXT,
  subject_signed_at   TEXT,
  amended_at          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT
);

-- One checkpoint. The area groups them; critical decides whether it gates
-- release. Both come from the template the plan was built from, so an item
-- cannot be quietly promoted to critical after the fact.
CREATE TABLE IF NOT EXISTS reentry_items (
  id                INTEGER PRIMARY KEY,
  plan_id           INTEGER NOT NULL REFERENCES reentry_plans(id),
  area              TEXT NOT NULL,
  label             TEXT NOT NULL,
  critical          INTEGER NOT NULL DEFAULT 0,
  -- The officer's assessment of where this stands. NOT the same question as
  -- "has it been signed off", which is the two timestamps below.
  status            TEXT NOT NULL DEFAULT 'not_started',
  detail            TEXT,        -- the address, the provider, the appointment
  -- "Not complete" must never automatically mean "cannot release". An
  -- exception is how a real obstacle gets carried: a documented plan, and a
  -- named person who approved it. Both are required, and enforced.
  mitigation        TEXT,
  approved_by       TEXT,
  approved_at       TEXT,
  officer_signed_at TEXT,
  officer_signed_by TEXT,
  subject_signed_at TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT,
  updated_by        TEXT,
  created_at        TEXT NOT NULL
);

-- Every change to a checkpoint, append-only. "How long did housing take" and
-- "who marked this ready, and when" are questions a plan has to answer, and
-- they are unanswerable if each update overwrites the last.
CREATE TABLE IF NOT EXISTS reentry_events (
  id          INTEGER PRIMARY KEY,
  plan_id     INTEGER NOT NULL REFERENCES reentry_plans(id),
  item_id     INTEGER REFERENCES reentry_items(id),
  kind        TEXT NOT NULL,       -- status | sign | exception | plan
  from_status TEXT,
  to_status   TEXT,
  body        TEXT,
  author      TEXT,
  actor_role  TEXT,                -- officer | subject
  created_at  TEXT NOT NULL
);

-- What the subject accepted, and when, with the plan as it read at that
-- moment. Append-only, exactly like the agreement's.
CREATE TABLE IF NOT EXISTS reentry_acknowledgments (
  id              INTEGER PRIMARY KEY,
  plan_id         INTEGER NOT NULL REFERENCES reentry_plans(id),
  subject_id      TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  snapshot        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_reentry_subject ON reentry_plans(subject_id, status);
CREATE INDEX IF NOT EXISTS ix_reentry_items   ON reentry_items(plan_id, area, sort_order);
CREATE INDEX IF NOT EXISTS ix_reentry_events  ON reentry_events(plan_id, id);
CREATE INDEX IF NOT EXISTS ix_reentry_ack     ON reentry_acknowledgments(plan_id, id);
`);

/* "Address verified" was a duplicate of "Residence identified" — the address
   is the identification, and it lives in the item's detail. It is gone from
   the template, but a plan copies the template at creation, so plans made
   before this keep the extra checkpoint.
 *
 * That immutability is deliberate and this does not weaken it: the delete is
 * guarded so it can only ever remove a copy with NOTHING recorded on it —
 * still not started, no detail, no mitigation, neither signature, and no
 * event in its history. A row matching all six carries no information that
 * could be lost. Anything an officer has touched is left exactly alone, and
 * shows up as a duplicate they can mark not applicable. */
(function dropDuplicateHousingItem() {
  const gone = db.prepare(`
    DELETE FROM reentry_items
     WHERE label = 'Address verified'
       AND status = 'not_started'
       AND detail IS NULL
       AND mitigation IS NULL
       AND officer_signed_at IS NULL
       AND subject_signed_at IS NULL
       AND id NOT IN (SELECT item_id FROM reentry_events WHERE item_id IS NOT NULL)
  `).run();
  if (gone.changes)
    console.log(`  removed ${gone.changes} untouched duplicate reentry checkpoint(s)`);
})();

/* The officer's final sign-off.
 *
 * A third signature, and deliberately a different one from the two already
 * on the plan. The subject's acceptance at the start is an acknowledgment of
 * what the plan asks of them; the per-checkpoint signatures are the two of
 * them agreeing each piece actually happened. This is the officer alone,
 * at the end, certifying that the whole thing is done.
 *
 * Kept as its own columns rather than a `status` value, because the plan
 * stays active after certification — the subject must go on being able to
 * see it, and a status change would hide it from them. */
ensureColumn("reentry_plans", "certified_at", "TEXT");
ensureColumn("reentry_plans", "certified_by", "TEXT");

/* ================================================================
   Goals and their action steps
   ================================================================

   A goal is what the officer and the subject are working towards — obtain
   employment, secure housing. An action step is the concrete thing that gets
   somebody there: submit ten resumes a week, visit the career office.

   Two rules shape this, and they pull in opposite directions on purpose:

   - **Progress is computed from the steps**, never typed in. Same rule as the
     reentry plan's readiness, and for the same reason: a stored percentage is
     a second copy of a fact the steps already carry.

   - **Completing the goal is the officer's decision, not arithmetic.** Ten
     resumes submitted is not a job. The steps say how far along somebody is;
     only the officer says the goal is met. So `status` is a real column that
     a person sets, sitting next to a progress figure that nobody sets — and
     the two answer different questions.

   Steps are ticked off by the subject, because the subject is the one doing
   them. That is the whole point of the module appearing in their app. */
db.exec(`
CREATE TABLE IF NOT EXISTS goals (
  id           INTEGER PRIMARY KEY,
  subject_id   TEXT NOT NULL,
  title        TEXT NOT NULL,
  detail       TEXT,
  due_date     TEXT,
  status       TEXT NOT NULL DEFAULT 'open',   -- open | complete | cancelled
  completed_at TEXT,
  completed_by TEXT,
  -- The subject has seen it. Distinct from having started it, and distinct
  -- again from having finished it: three facts, three columns, because
  -- collapsing any two loses the one somebody needed.
  seen_at      TEXT,
  created_at   TEXT NOT NULL,
  created_by   TEXT,
  updated_at   TEXT
);

CREATE TABLE IF NOT EXISTS goal_steps (
  id         INTEGER PRIMARY KEY,
  goal_id    INTEGER NOT NULL REFERENCES goals(id),
  body       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  done_at    TEXT,
  done_by    TEXT,                              -- officer | subject
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_goals_subject ON goals(subject_id, status);
CREATE INDEX IF NOT EXISTS ix_goal_steps    ON goal_steps(goal_id, sort_order);
`);

/* ================================================================
   Financial obligations
   ================================================================

   Fines, restitution, court costs, supervision fees. What a subject owes,
   what they have paid against it, and what is left.

   Three decisions:

   - **Amounts are integer cents.** Never a float. Money in a float is how
     a balance ends up at 0.009999999999 and a report says somebody still
     owes a penny they paid last year.

   - **Payments are rows, not a running total on the item.** "How much is
     left" is easy either way; "what did they pay, and when" is unanswerable
     the moment a payment overwrites the last one. A payment history is also
     the thing anybody disputes, so it has to survive.

   - **The balance is computed.** Same rule as everywhere else here: a stored
     balance is a second copy of a fact the payments already carry.

   Waiving is its own act with its own timestamp and author, because "they
   paid it" and "we stopped requiring it" are different facts about a case
   and a report that cannot tell them apart is worth nothing. */
db.exec(`
CREATE TABLE IF NOT EXISTS financial_items (
  id           INTEGER PRIMARY KEY,
  subject_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,            -- fine | restitution | court_costs | …
  description  TEXT,
  amount_cents INTEGER NOT NULL,
  due_date     TEXT,
  waived_at    TEXT,
  waived_by    TEXT,
  waived_note  TEXT,
  created_at   TEXT NOT NULL,
  created_by   TEXT,
  updated_at   TEXT
);

CREATE TABLE IF NOT EXISTS financial_payments (
  id           INTEGER PRIMARY KEY,
  item_id      INTEGER NOT NULL REFERENCES financial_items(id),
  amount_cents INTEGER NOT NULL,
  paid_on      TEXT NOT NULL,            -- the day it was paid, not recorded
  method       TEXT,
  note         TEXT,
  recorded_by  TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_fin_items    ON financial_items(subject_id, due_date);
CREATE INDEX IF NOT EXISTS ix_fin_payments ON financial_payments(item_id, id);
`);

/* Who recorded a payment, as a role rather than only a name.
 *
 * Either party may record one — the subject paid at an office and is entering
 * the transaction; the officer took the money or saw the receipt. Those are
 * different claims about the same money, exactly as with a goal's action
 * steps, and a case file that cannot tell them apart has lost the part
 * anybody would dispute. */
ensureColumn("financial_payments", "recorded_role", "TEXT");

/* ================================================================
   Important dates
   ================================================================

   Appointments a subject has to keep that are NOT officer visits: a parole
   board hearing, a court date, a treatment session, a drug test.

   Kept apart from `visits` on purpose, even though the two look similar. A
   visit is something the officer conducts and records observations against;
   these are things the subject attends somewhere else and reports back on.
   Merging them would mean one table where half the columns are null for half
   the rows, and every query afterwards carrying a `WHERE kind = …` that
   somebody eventually forgets.

   The lifecycle has three steps because they are three different facts:
   the subject has SEEN it, the subject has AGREED they will be there, and
   somebody has recorded WHAT HAPPENED. A single "done" flag loses the middle
   one, which is the one that matters when nobody turns up. */
db.exec(`
CREATE TABLE IF NOT EXISTS important_dates (
  id              INTEGER PRIMARY KEY,
  subject_id      TEXT NOT NULL,
  kind            TEXT NOT NULL,
  title           TEXT,
  detail          TEXT,
  scheduled_at    TEXT NOT NULL,        -- ISO, like a visit: date AND time
  location        TEXT,                 -- "Third District Court, Room 214"
  address         TEXT,                 -- what a map link is built from
  status          TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled|completed|missed|cancelled
  acknowledged_at TEXT,                 -- the subject has agreed to be there
  seen_at         TEXT,                 -- the subject has looked at it
  completed_at    TEXT,
  completed_by    TEXT,
  completed_role  TEXT,                 -- officer | subject
  outcome_note    TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT,
  updated_at      TEXT
);

CREATE INDEX IF NOT EXISTS ix_important_dates
  ON important_dates(subject_id, scheduled_at);
`);

/* ================================================================
   Visit agenda
   ================================================================

   What needs discussing at a visit: an outstanding fine, a court date coming
   up, a goal that has stalled.

   The obvious implementation is a live query — ask the case file what is
   outstanding, every time the visit is opened. That is wrong, and the reason
   is worth stating: a visit record has to say what was ON THE TABLE THAT DAY.
   If a fine is paid next week, a derived agenda quietly loses the item the
   officer actually raised, and "did you discuss the restitution" becomes
   unanswerable.

   So the agenda is MATERIALISED when the visit is scheduled — a snapshot of
   what was outstanding at that moment — and refreshed only when somebody asks
   for it. The same instinct as a course version freezing once a registration
   references it, and an agreement snapshot at acknowledgment.

   `source_kind` / `source_id` point back at what raised the item, so the
   officer can still jump to the live record; `body` is what it said at the
   time, so the row means something even if the source is deleted. */
db.exec(`
CREATE TABLE IF NOT EXISTS visit_agenda (
  id          INTEGER PRIMARY KEY,
  visit_id    INTEGER NOT NULL REFERENCES visits(id),
  source_kind TEXT NOT NULL,          -- financial | date | goal | custom
  source_id   INTEGER,                -- null for an officer's own item
  body        TEXT NOT NULL,          -- as it read when the agenda was built
  detail      TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  covered_at  TEXT,
  covered_by  TEXT,
  note        TEXT,                   -- what was said about it
  added_by    TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_visit_agenda ON visit_agenda(visit_id, sort_order, id);
`);

/* A program is raised by Waypoint, which has no row id on this side of the
   boundary — its key is a `program_id` string. Kept in its own column rather
   than squeezed into source_id, because one concept in one column of one type
   is the rule, and an integer column holding "golf-101" breaks it. */
ensureColumn("visit_agenda", "source_ref", "TEXT");

/* Where a subject actually is, so a route can be ordered by distance rather
   than by the order somebody happened to book them.
 *
 * Cached on the row and never looked up twice: geocoding is an outbound call
 * carrying a home address, and doing it once per address rather than once per
 * route planning is both faster and a smaller exposure. `geocoded_from` holds
 * the address the coordinates were derived from, so a moved subject is
 * re-geocoded and a stale pin cannot survive an address change. */
ensureColumn("subjects", "latitude",      "REAL");
ensureColumn("subjects", "longitude",     "REAL");
ensureColumn("subjects", "geocoded_at",   "TEXT");
ensureColumn("subjects", "geocoded_from", "TEXT");

/* How precisely the coordinates were found: a doorstep, a street, or just the
   town. A route built from town-level points is still a useful route, but a
   screen should not imply a pin it does not have. */
ensureColumn("subjects", "geocode_precision", "TEXT");

/* Which office an officer works out of.
 *
 * An officer always starts their day somewhere, and that somewhere is almost
 * always their office. Without it the console was guessing — matching an
 * office by name and hoping — which is the kind of thing that works until
 * somebody renames an office. */
ensureColumn("officers", "office_id", "INTEGER");

/* Is the time on this visit a commitment, or just the day?
 *
 * A parole hearing is at 9:00 and nobody is moving it. A home visit is "I'll
 * come by Thursday" — the day is fixed, the hour is not. Treating both the
 * same made two things wrong at once: the route pretended it had optimised a
 * day whose order was already decided, and the subject was shown "12:00 PM"
 * as though somebody had promised it.
 *
 * Defaults to 1 for rows that already exist: every visit booked before this
 * was booked AS a time, and quietly reinterpreting them as "sometime that
 * day" would rewrite what people were told. New visits from the form default
 * the other way, because a home visit usually is flexible — that default
 * belongs in the form, where a person can see and change it. */
ensureColumn("visits", "time_fixed", "INTEGER NOT NULL DEFAULT 1");

/* Audio recorded during a visit.
 *
 * Kept apart from visit_photos rather than folded into one "attachments"
 * table: a photograph and a recording of a conversation are different things
 * with different retention questions, and a column that means "duration" for
 * half the rows and nothing for the other half is the shape this codebase
 * already has a rule against.
 *
 * Append-only, like the photographs and the notes. There is no delete
 * endpoint: a recording that can be quietly removed is not evidence, and the
 * one somebody wants gone is the one that mattered. */
db.exec(`
CREATE TABLE IF NOT EXISTS visit_recordings (
  id           INTEGER PRIMARY KEY,
  visit_id     INTEGER NOT NULL REFERENCES visits(id),
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  byte_size    INTEGER,
  duration_ms  INTEGER,
  note         TEXT,
  author       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_visit_recordings ON visit_recordings(visit_id, id);
`);

/* What a machine heard, and what a machine made of it.
 *
 * Three tables rather than columns on visit_recordings, because these are
 * three different kinds of thing with three different lifetimes:
 *
 *   · the RECORDING is evidence. Append-only, never edited, never deleted.
 *   · the TRANSCRIPT is a derived reading of that evidence. It is regenerable
 *     — a better model next year produces a better one from the same audio —
 *     so there is exactly one per recording and re-running replaces it. The
 *     audio owns the fact; this derives from it.
 *   · the SUMMARY is a written document somebody may rely on. Those append:
 *     re-summarising adds a row, so what an officer read in March is still
 *     there in June rather than quietly rewritten underneath them.
 *
 * And the action items are PROPOSALS, never obligations. A machine reading of
 * a conversation may not create work for a person on its own — an officer
 * accepts or dismisses each one, and until they do it counts as nothing.
 * Same rule as everywhere else here: the thing that is not a person's decision
 * does not get to assert an outcome. */
db.exec(`
CREATE TABLE IF NOT EXISTS visit_transcripts (
  id            INTEGER PRIMARY KEY,
  recording_id  INTEGER NOT NULL REFERENCES visit_recordings(id),
  visit_id      INTEGER NOT NULL REFERENCES visits(id),
  status        TEXT NOT NULL,          -- queued | running | done | failed
  text          TEXT,
  language      TEXT,
  engine        TEXT,
  word_count    INTEGER,
  error         TEXT,
  requested_by  TEXT,
  created_at    TEXT NOT NULL,
  completed_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_visit_transcripts_rec
  ON visit_transcripts(recording_id);
CREATE INDEX IF NOT EXISTS ix_visit_transcripts_visit
  ON visit_transcripts(visit_id, id);

CREATE TABLE IF NOT EXISTS visit_summaries (
  id            INTEGER PRIMARY KEY,
  visit_id      INTEGER NOT NULL REFERENCES visits(id),
  status        TEXT NOT NULL,          -- queued | running | done | failed
  headline      TEXT,
  body          TEXT,
  model         TEXT,
  source_ids    TEXT,                   -- JSON array of transcript ids
  error         TEXT,
  requested_by  TEXT,
  created_at    TEXT NOT NULL,
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_visit_summaries ON visit_summaries(visit_id, id);

CREATE TABLE IF NOT EXISTS visit_summary_actions (
  id            INTEGER PRIMARY KEY,
  summary_id    INTEGER NOT NULL REFERENCES visit_summaries(id),
  visit_id      INTEGER NOT NULL REFERENCES visits(id),
  body          TEXT NOT NULL,
  owner         TEXT,                   -- officer | subject | unclear
  due_hint      TEXT,
  quote         TEXT,                   -- what was said that produced it
  position      INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'proposed',  -- proposed | accepted | dismissed
  decided_by    TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_visit_summary_actions
  ON visit_summary_actions(summary_id, position);

-- Lesson-aware program analysis. The evidence snapshot is immutable; the
-- generated result is a separate derived value and may be superseded.
CREATE TABLE IF NOT EXISTS program_analysis_jobs (
  id                  INTEGER PRIMARY KEY,
  registration_id     INTEGER NOT NULL REFERENCES registrations(id),
  status              TEXT NOT NULL DEFAULT 'queued', -- queued|running|draft|failed|rejected
  evidence_json       TEXT NOT NULL,
  result_json         TEXT,
  model               TEXT,
  prompt_version      TEXT,
  error               TEXT,
  requested_by        TEXT,
  created_at          TEXT NOT NULL,
  started_at          TEXT,
  completed_at        TEXT
);
CREATE INDEX IF NOT EXISTS ix_program_analysis_registration
  ON program_analysis_jobs(registration_id, id);
CREATE TABLE IF NOT EXISTS program_analysis_reviews (
  id             INTEGER PRIMARY KEY,
  analysis_id    INTEGER NOT NULL REFERENCES program_analysis_jobs(id),
  disposition    TEXT NOT NULL, -- approved|edited|dismissed|escalated
  notes          TEXT,
  reviewed_by    TEXT NOT NULL,
  reviewed_at    TEXT NOT NULL,
  document_id    INTEGER,
  UNIQUE (analysis_id)
);
CREATE TABLE IF NOT EXISTS program_analysis_comparisons (
  id                 INTEGER PRIMARY KEY,
  current_analysis_id INTEGER NOT NULL REFERENCES program_analysis_jobs(id),
  previous_analysis_id INTEGER NOT NULL REFERENCES program_analysis_jobs(id),
  status             TEXT NOT NULL DEFAULT 'draft', -- draft|reviewed
  evidence_json      TEXT NOT NULL,
  result_json        TEXT,
  created_at         TEXT NOT NULL,
  reviewed_by        TEXT,
  reviewed_at        TEXT
);
`);

/* What the MODEL said the owner was, kept beside what a person decided it is.
 *
 * Not one concept in two columns — two different facts. `owner_proposed` is a
 * machine's reading of a transcript that has no speaker labels; `owner` is a
 * named officer's decision. Keeping both is what lets the screen say "corrected
 * from officer", and what would let anyone later ask how often the inference is
 * wrong. Collapsing them would throw that away to save a column. */
ensureColumn("visit_summary_actions", "owner_proposed", "TEXT");
ensureColumn("visit_summary_actions", "owner_set_by", "TEXT");
ensureColumn("visit_summary_actions", "owner_set_at", "TEXT");
db.exec(`UPDATE visit_summary_actions
            SET owner_proposed = owner
          WHERE owner_proposed IS NULL`);

/* An accepted action item is work somebody owes, so it needs a finish as well
   as a start. Kept as its own pair rather than folded into decided_by/at: when
   an officer ACCEPTED an item and when they DID it are two facts, and a to-do
   list that cannot tell them apart cannot answer how long anything took. */
ensureColumn("visit_summary_actions", "done_by", "TEXT");
ensureColumn("visit_summary_actions", "done_at", "TEXT");

/* A real date, beside the phrase that was actually said.
 *
 * `due_hint` is evidence — "by Friday", quoted as spoken. `due_date` is a date
 * you can sort by, filter on, and go overdue against. They are two facts, and
 * the second is DERIVED FROM THE FIRST BY ARITHMETIC, not by a model: the visit
 * date is known, so "Friday" has one right answer and a language model has no
 * business guessing it. An officer can overwrite it. */
ensureColumn("visit_summary_actions", "due_date", "TEXT");

/* When the subject first saw this action item.
 *
 * The same shape as goals.seen_at: a banner is only useful while something is
 * genuinely new, and a badge that never clears is a badge people stop reading.
 * Only accepted items are ever shown to a subject, so only those are marked. */
ensureColumn("visit_summary_actions", "subject_seen_at", "TEXT");

/* What the model wrote, kept beside what a person corrected it to.
 *
 * Same shape as owner_proposed, and for the same reason: a transcript mishears
 * "reinstatement" as "read statement", and an officer has to be able to fix the
 * words. Overwriting would erase the evidence of what the machine actually
 * produced — which is the thing you want when asking how much to trust it. */
ensureColumn("visit_summary_actions", "body_proposed", "TEXT");
ensureColumn("visit_summary_actions", "body_set_by", "TEXT");
ensureColumn("visit_summary_actions", "body_set_at", "TEXT");
db.exec(`UPDATE visit_summary_actions
            SET body_proposed = body WHERE body_proposed IS NULL`);
