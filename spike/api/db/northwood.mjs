/**
 * Northwood's data — the corrections system.
 *
 * Subjects, visits, staff, supervision agreements, and the profile modules
 * (vehicles, contacts, curfew, obligations, travel permits, employment,
 * documents). Plus the inbox where completions pushed by Waypoint land.
 *
 * This module imports nothing from db/waypoint.mjs. Northwood is a customer
 * of the LMS: it holds an API key and asks over HTTP, exactly as a real
 * integrator would. That is the claim the whole PoC rests on, and keeping the
 * two data layers apart is what stops it quietly becoming untrue — it already
 * did once, twice, before this split existed.
 */

import { one, all, run, now, db } from "./connect.mjs";
import "./schema.mjs";
import { transcriptsForVisit, summariesForVisit } from "./insights.mjs";
import { agendaFor } from "./agenda.mjs";

/* ---------------- mock SaaS inbox ---------------- */

export const saasReceive = d => run(
  `INSERT INTO saas_inbox (subject_id, program_id, payload, verified, received_at)
   VALUES (?,?,?,?,?)`,
  d.subject_id, d.program_id, JSON.stringify(d.payload), d.verified ? 1 : 0, now());

export const saasInbox = (limit = 50) =>
  all(`SELECT * FROM saas_inbox ORDER BY id DESC LIMIT ?`, limit);


/* ---------------- visits (corrections side) ---------------- */

export function scheduleVisit(v) {
  run(`INSERT INTO visits (subject_id, scheduled_at, officer, location, notes,
                           time_fixed, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      v.subject_id, v.scheduled_at, v.officer ?? null, v.location ?? null,
      v.notes ?? null, v.time_fixed ? 1 : 0, now());
  return one(`SELECT * FROM visits WHERE subject_id = ? ORDER BY id DESC LIMIT 1`, v.subject_id);
}

export const visitsFor = subject_id =>
  all(`SELECT * FROM visits WHERE subject_id = ? ORDER BY scheduled_at ASC`, subject_id)
    .map(hydrate);

/**
 * Visits the subject has not looked at yet.
 *
 * A genuinely separate fact from whether they have confirmed one — the
 * console shows "Seen, not confirmed" as its own state for exactly that
 * reason — but it is NOT what a badge should count. See below.
 */
export const unseenVisitCount = subject_id =>
  one(`SELECT COUNT(*) n FROM visits WHERE subject_id = ? AND seen_at IS NULL`, subject_id)?.n ?? 0;

/**
 * Visits still waiting on the subject to confirm.
 *
 * This is what the badge counts. It used to count unseen visits, which meant
 * glancing at the Visits tab cleared the indicator on an appointment nobody
 * had confirmed — the badge said "nothing to do" while the officer's screen
 * still said "Not confirmed".
 *
 * Seen is not acted on. Same mistake as a completion status that also has to
 * mean passed: one indicator, two facts, and the one that disappears is the
 * one somebody needed.
 */
export const unconfirmedVisitCount = subject_id => one(
  `SELECT COUNT(*) n FROM visits
    WHERE subject_id = ? AND accepted_at IS NULL
      AND status NOT IN ('cancelled','completed','requested')`, subject_id)?.n ?? 0;

export const markVisitsSeen = subject_id =>
  run(`UPDATE visits SET seen_at = ? WHERE subject_id = ? AND seen_at IS NULL`, now(), subject_id);

export const cancelVisit = id =>
  run(`UPDATE visits SET status = 'cancelled' WHERE id = ?`, id);

const VISIT_FIELDS = ["scheduled_at", "officer", "location", "notes", "time_fixed"];

/**
 * Change a visit that has not started yet.
 *
 * Only that. Once an officer has arrived, the visit is no longer a plan — it
 * is something happening, and rescheduling it while standing on the doorstep
 * is not a real act. Once it is complete it is a record, and a correction is
 * a note, which is the rule everywhere else here.
 *
 * The console hides Edit in both cases, but hiding a button is not enforcing
 * a rule: anything that only the interface prevents is something the next
 * client does by accident.
 *
 * Moving it in time or place withdraws the subject's acceptance. They agreed
 * to be somewhere at a time; change either and they have not agreed to
 * anything — the same rule an amended agreement and a moved appointment
 * follow.
 */
export function updateVisit(id, patch) {
  const cur = one(`SELECT * FROM visits WHERE id = ?`, id);
  if (!cur) return { error: "no such visit" };
  if (cur.status === "completed")
    return { error: "This visit has already taken place. Add a note instead." };
  if (cur.status === "cancelled")
    return { error: "This visit was cancelled." };
  if (cur.started_at)
    return { error: "This visit is under way. Add a note instead of rescheduling it." };

  // Merge, never overwrite: a payload that omits a field leaves it alone.
  const fields = VISIT_FIELDS.filter(f => patch[f] !== undefined);
  if (fields.length) {
    const vals = fields.map(f => f === "time_fixed" ? (patch[f] ? 1 : 0) : patch[f]);
    run(`UPDATE visits SET ${fields.map(f => `${f}=?`).join(", ")} WHERE id = ?`,
        ...vals, id);
  }

  const moved = ["scheduled_at", "location"].some(f =>
    patch[f] !== undefined && patch[f] !== cur[f]);
  if (moved && (cur.accepted_at || cur.seen_at))
    run(`UPDATE visits SET accepted_at = NULL, seen_at = NULL,
           status = 'scheduled' WHERE id = ?`, id);

  return { ok: true, visit: visit(id), reconfirm: moved && !!cur.accepted_at };
}

/**
 * A visit is never just its own row. Its notes and photographs are part of the
 * record, so every path that returns a visit returns them too — defined once
 * here rather than remembered at each call site.
 */
export const hydrate = v =>
  v && { ...v, notes_log: notesForVisit(v.id), photos: photosForVisit(v.id),
         agenda: agendaFor(v.id), recordings: recordingsFor(v.id),
         transcripts: transcriptsForVisit(v.id),
         summaries: summariesForVisit(v.id) };

export const visit = id => hydrate(one(`SELECT * FROM visits WHERE id = ?`, id));

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
  if (v.accepted_at) return { ok: true, visit: hydrate(v) };   // idempotent
  run(`UPDATE visits SET status = 'accepted', accepted_at = ? WHERE id = ?`, now(), id);
  return { ok: true, visit: visit(id) };
}

/** The officer records that the visit happened. The timestamp is ours, taken
 *  at the moment of recording — not supplied by the caller. */
export function addVisitNote({ visit_id, body, author }) {
  run(`INSERT INTO visit_notes (visit_id, body, author, created_at) VALUES (?,?,?,?)`,
      visit_id, body, author ?? null, now());
  return one(`SELECT * FROM visit_notes WHERE visit_id = ? ORDER BY id DESC LIMIT 1`, visit_id);
}

/* ---------------- visit photographs ---------------- */

export const photosForVisit = visit_id => all(
  `SELECT * FROM visit_photos WHERE visit_id = ? ORDER BY id`, visit_id);

export const photoById = id => one(`SELECT * FROM visit_photos WHERE id = ?`, id);

/** Append only, deliberately. See the table comment. */
export function addVisitPhoto(p) {
  run(`INSERT INTO visit_photos
         (visit_id, filename, mime_type, byte_size, caption, author, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      p.visit_id, p.filename, p.mime_type, p.byte_size ?? null,
      p.caption ?? null, p.author ?? null, now());
  return one(`SELECT * FROM visit_photos WHERE visit_id = ? ORDER BY id DESC LIMIT 1`,
             p.visit_id);
}

/* ---------------- visit recordings ---------------- */

export const recordingsFor = visit_id => all(
  `SELECT * FROM visit_recordings WHERE visit_id = ? ORDER BY id`, visit_id);

export const recordingById = id =>
  one(`SELECT * FROM visit_recordings WHERE id = ?`, id);

/** Append only, deliberately. See the table comment. */
export function addVisitRecording(r) {
  run(`INSERT INTO visit_recordings
         (visit_id, filename, mime_type, byte_size, duration_ms, note, author, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      r.visit_id, r.filename, r.mime_type, r.byte_size ?? null,
      r.duration_ms ?? null, r.note ?? null, r.author ?? null, now());
  return one(`SELECT * FROM visit_recordings WHERE visit_id = ? ORDER BY id DESC LIMIT 1`,
             r.visit_id);
}

export const notesForVisit = visit_id =>
  all(`SELECT * FROM visit_notes WHERE visit_id = ? ORDER BY created_at ASC`, visit_id);

export const notesForSubject = subject_id => all(
  `SELECT n.*, v.scheduled_at
     FROM visit_notes n JOIN visits v ON v.id = n.visit_id
    WHERE v.subject_id = ? ORDER BY n.created_at DESC`, subject_id);

/** What an officer may record about a visit, and the values each accepts.
 *  Exported so both clients build the same form from one source. */
export const VISIT_OBSERVATIONS = {
  subject_present: { label: "Subject present",
    options: [["yes", "Present"], ["no_contact", "No contact made"]] },
  location_safe:   { label: "Location",
    options: [["yes", "Safe"], ["concerns", "Concerns"], ["not_assessed", "Not assessed"]] },
  contraband:      { label: "Contraband",
    options: [["none_seen", "None seen"], ["observed", "Observed"],
              ["not_assessed", "Not assessed"]] },
  demeanour:       { label: "Demeanour",
    options: [["cooperative", "Cooperative"], ["guarded", "Guarded"],
              ["agitated", "Agitated"], ["distressed", "Distressed"],
              ["impaired", "Appeared impaired"]] }
};

/**
 * The officer arrives and begins the visit.
 *
 * The start time is taken HERE, at the moment they act — never accepted from
 * the caller. A time typed in afterwards is a recollection, and this record
 * may end up supporting a revocation.
 *
 * Deliberately NOT gated on the subject having accepted. Acceptance is an
 * acknowledgment, not permission: an officer may turn up to an appointment
 * nobody confirmed, and that is often exactly the visit worth making.
 */
export function startVisit(id, officer) {
  const v = visit(id);
  if (!v) return { error: "no such visit" };
  if (v.status === "cancelled") return { error: "this visit was cancelled" };
  if (v.completed_at) return { error: "this visit is already complete" };
  if (v.started_at) return { ok: true, visit: v };               // idempotent
  run(`UPDATE visits SET started_at = ?, officer = COALESCE(officer, ?) WHERE id = ?`,
      now(), officer ?? null, id);
  return { ok: true, visit: visit(id) };
}

const OBSERVATION_FIELDS = ["subject_present", "location_safe", "contraband",
                            "contraband_detail", "demeanour", "others_present",
                            "concerns"];

export function completeVisit(id, officer, observations = null) {
  const v = visit(id);
  if (!v) return { error: "no such visit" };
  if (v.status === "cancelled") return { error: "this visit was cancelled" };
  if (v.completed_at) return { ok: true, visit: v };            // idempotent

  /* Only the fields actually supplied are written, so a later correction
     cannot blank an observation nobody meant to touch. */
  const cols = observations
    ? OBSERVATION_FIELDS.filter(f => observations[f] !== undefined) : [];
  const set = cols.map(c => `${c}=?`).join(", ");

  run(`UPDATE visits SET status = 'completed', completed_at = ?, completed_by = ?,
                         ended_at = ?, started_at = COALESCE(started_at, ?)
                         ${set ? ", " + set : ""}
        WHERE id = ?`,
      now(), officer ?? null, now(), now(), ...cols.map(c => observations[c]), id);
  return { ok: true, visit: visit(id) };
}

/* ---------------- Northwood roster ---------------- */

export const allSubjects = () => all(
  `SELECT s.*, o.name AS officer,
          s.first_name || ' ' || s.last_name AS name
     FROM subjects s LEFT JOIN officers o ON o.id = s.officer_id
    ORDER BY s.last_name, s.first_name`);

/* Fields an officer may edit on a subject's record. An allowlist, so a
   payload cannot reach columns it has no business touching — officer_id and
   subject_id are assignment decisions, not demographics. */
const SUBJECT_FIELDS = ["first_name","last_name","case_number","dob","phone","email",
                        "address_line1","address_line2","city","state","postal_code",
                        "status","intake_date","next_review"];

/**
 * Update a subject's own details.
 *
 * MERGES: only fields actually present are written. A payload that omits a
 * field must leave it alone — the same partial-save rule that once blanked an
 * entire supervision agreement.
 */
/**
 * A new person on the roster.
 *
 * The subject_id is minted here, not accepted from the client. It is the key
 * every other table hangs off, it appears in URLs, and a caller that could
 * choose it could collide with an existing record or overwrite one — the same
 * reason a recording's filename is generated rather than supplied.
 *
 * They land on the creating officer's caseload. Moving them elsewhere is
 * `reassignSubject`, which writes a case note naming both officers; a subject
 * who changes hands with nothing on the record is how a case goes quiet.
 */
export function createSubject(patch, officer_id) {
  let subject_id;
  do { subject_id = `cust-${Math.floor(1000 + Math.random() * 9000)}`; }
  while (one(`SELECT 1 FROM subjects WHERE subject_id = ?`, subject_id));

  /* first_name, last_name and case_number are NOT NULL, so they belong in the
     insert rather than in the update that follows. A case number is real-world
     data an officer should type, but the column will not take nothing — so an
     obviously-provisional one is minted and shown in the form to be replaced,
     which is better than an empty string that looks like a real value. */
  const caseNo = String(patch.case_number || "").trim()
    || `NC-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9000) + 1000)}`;

  run(`INSERT INTO subjects
         (subject_id, first_name, last_name, case_number, status, officer_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      subject_id, patch.first_name, patch.last_name, caseNo,
      patch.status || "active", officer_id ?? null, now());

  /* Everything else goes through the same update path the edit form uses, so
     there is one place that knows how a subject's fields are written. */
  return saveSubject(subject_id, { ...patch, case_number: caseNo });
}

export function saveSubject(subject_id, patch) {
  const cols = SUBJECT_FIELDS.filter(f => patch[f] !== undefined);
  if (cols.length)
    run(`UPDATE subjects SET ${cols.map(c => `${c}=?`).join(", ")}, updated_at=?
          WHERE subject_id = ?`, ...cols.map(c => patch[c]), now(), subject_id);
  return subjectByKey(subject_id);
}

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
          address_line1, address_line2, city, state, postal_code, status, officer_id,
          intake_date, next_review, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        s.subject_id, s.case_number, s.first_name, s.last_name, s.dob, s.phone,
        s.email ?? null, s.address_line1, s.address_line2 ?? null,
        s.city, s.state, s.postal_code,
        s.status, off?.id ?? null, s.intake_date, s.next_review, now());
  }
  return true;
}

/* ---------------- staff accounts & sessions ---------------- */

export const officerByEmail = email => one(
  `SELECT * FROM officers WHERE lower(email) = lower(?) AND active = 1`, email);

export const officerById = id => one(`SELECT * FROM officers WHERE id = ?`, id);

/* What an officer may change about themselves.
 *
 * `role` and `active` are deliberately absent. Letting someone edit their own
 * role is privilege escalation with a form around it, and the whole point of a
 * profile screen is that it edits the person who is signed in — so the two
 * fields that decide what they may do are not on it. Those move through
 * whatever admin path exists, and there is currently none, which is honest for
 * a proof of concept.
 */
const OFFICER_FIELDS = ["name", "email", "phone", "badge", "office_id"];

export function saveOfficer(officer_id, patch) {
  const cols = OFFICER_FIELDS.filter(f => patch[f] !== undefined);
  if (cols.length)
    run(`UPDATE officers SET ${cols.map(c => `${c}=?`).join(", ")} WHERE id = ?`,
        ...cols.map(c => patch[c]), officer_id);
  return officerById(officer_id);
}

/** Is this email already somebody else's? Sign-in is by email, so a duplicate
 *  would make one of the two accounts unreachable. */
export const emailTakenBy = (email, exceptId) => one(
  `SELECT id FROM officers WHERE lower(email) = lower(?) AND id <> ?`,
  email, exceptId ?? -1);

/**
 * Where this officer starts their day.
 *
 * Their own office if one is set, otherwise the first active office — a
 * fallback rather than a guess, and never a name match. An officer without a
 * base is a data problem to fix, not a reason for a route to have no origin.
 */
export const officerBase = officer_id => one(
  `SELECT o.id, o.name, o.address, o.phone
     FROM officers f
     LEFT JOIN offices o ON o.id = f.office_id
    WHERE f.id = ? AND o.id IS NOT NULL`, officer_id)
  ?? one(`SELECT id, name, address, phone FROM offices WHERE active = 1 ORDER BY id LIMIT 1`)
  ?? null;

export const setOfficerOffice = (officer_id, office_id) =>
  run(`UPDATE officers SET office_id = ? WHERE id = ?`, office_id, officer_id);

/**
 * Move a subject to a different officer.
 *
 * Deliberately its own function rather than a field on the details form: who
 * supervises someone is an assignment decision with consequences — it changes
 * whose caseload they appear on and who is accountable for their visits — and
 * it should not be reachable by a payload aimed at an address change.
 */
export function reassignSubject(subject_id, officer_id) {
  const s = one(`SELECT * FROM subjects WHERE subject_id = ?`, subject_id);
  if (!s) return { error: "no such subject" };
  const o = one(`SELECT * FROM officers WHERE id = ? AND active = 1`, officer_id);
  if (!o) return { error: "no such officer" };
  if (s.officer_id === o.id) return { ok: true, unchanged: true, officer: o.name };
  const from = s.officer_id ? officerById(s.officer_id)?.name : null;
  run(`UPDATE subjects SET officer_id = ? WHERE subject_id = ?`, o.id, subject_id);
  return { ok: true, officer: o.name, from };
}

export const setOfficerPassword = (id, hash, must_change = 0) =>
  run(`UPDATE officers SET password_hash = ?, must_change = ? WHERE id = ?`,
      hash, must_change ? 1 : 0, id);

/* Throttle repeated failures. Not a full lockout policy, but enough that
   an admin login is not a free guessing gallery. */
export function recordLoginFailure(id) {
  const o = officerById(id); if (!o) return;
  const n = (o.failed_attempts || 0) + 1;
  const lock = n >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
  run(`UPDATE officers SET failed_attempts = ?, locked_until = ? WHERE id = ?`, n, lock, id);
}

export const clearLoginFailures = id =>
  run(`UPDATE officers SET failed_attempts = 0, locked_until = NULL, last_login_at = ?
        WHERE id = ?`, now(), id);

export function createStaffSession({ token_hash, officer_id, ttl_ms, ip, user_agent }) {
  run(`INSERT INTO staff_sessions (token_hash, officer_id, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES (?,?,?,?,?,?,?)`,
      token_hash, officer_id, now(), new Date(Date.now() + ttl_ms).toISOString(),
      now(), ip ?? null, user_agent ?? null);
}

export function staffSession(token_hash) {
  const s = one(
    `SELECT ss.*, o.name, o.email, o.role, o.active
       FROM staff_sessions ss JOIN officers o ON o.id = ss.officer_id
      WHERE ss.token_hash = ?`, token_hash);
  if (!s) return null;
  if (s.revoked_at) return null;
  if (!s.active) return null;
  if (new Date(s.expires_at) < new Date()) return null;
  run(`UPDATE staff_sessions SET last_seen_at = ? WHERE id = ?`, now(), s.id);
  return s;
}

export const revokeStaffSession = token_hash =>
  run(`UPDATE staff_sessions SET revoked_at = ? WHERE token_hash = ?`, now(), token_hash);

/* ---------------- officer views ---------------- */

/** An officer's own schedule: every open visit across their caseload.
 *  Requests have no date yet, so they are returned separately rather than
 *  sorted into a chronological list with a null. */
export const officerSchedule = officer_id => all(
  `SELECT v.*, s.first_name || ' ' || s.last_name AS subject_name,
          s.case_number, s.phone,
          s.address_line1, s.address_line2, s.city, s.state, s.postal_code
     FROM visits v
     JOIN subjects s ON s.subject_id = v.subject_id
    WHERE s.officer_id = ?
      AND v.status IN ('scheduled','accepted','requested')
    ORDER BY (v.scheduled_at IS NULL) ASC, v.scheduled_at ASC`, officer_id)
  .map(hydrate);

/** Recently completed, so the officer can see what they have already done. */
export const officerRecent = (officer_id, limit = 10) => all(
  `SELECT v.*, s.first_name || ' ' || s.last_name AS subject_name, s.case_number
     FROM visits v
     JOIN subjects s ON s.subject_id = v.subject_id
    WHERE s.officer_id = ? AND v.status = 'completed'
    ORDER BY v.completed_at DESC LIMIT ?`, officer_id, limit)
  .map(hydrate);

export const officerCaseload = officer_id => all(
  `SELECT s.*, s.first_name || ' ' || s.last_name AS name,
          (SELECT COUNT(*) FROM visits v
             WHERE v.subject_id = s.subject_id AND v.status IN ('scheduled','accepted')) AS upcoming_visits,
          (SELECT COUNT(*) FROM visits v
             WHERE v.subject_id = s.subject_id AND v.status = 'requested') AS pending_requests
     FROM subjects s
    WHERE s.officer_id = ?
    ORDER BY s.last_name, s.first_name`, officer_id);

/* ---------------- vehicles ---------------- */

export const vehiclesFor = subject_id =>
  all(`SELECT * FROM subject_vehicles WHERE subject_id = ? ORDER BY id`, subject_id);

/**
 * A model year, normalised to the one type the column holds.
 *
 * `year` is a TEXT column, and the two callers disagreed about what to send:
 * the form posts the string "2014", the seed passed the number 2014 — which
 * node:sqlite binds as REAL, so SQLite stored the text "2014.0". Same field,
 * same function, two different values on disk depending on who wrote it.
 *
 * Normalised here rather than at each call site, because "normalise at the
 * boundary, once" is the only version of this that stays true.
 */
const modelYear = y => {
  if (y === null || y === undefined || y === "") return null;
  const n = Math.trunc(Number(y));
  return Number.isFinite(n) && n > 1885 && n < 2100 ? String(n) : null;
};

export function saveVehicle(v) {
  if (v.id) {
    run(`UPDATE subject_vehicles
            SET make=?, model=?, year=?, color=?, plate=?, state=?, notes=?, updated_at=?
          WHERE id = ?`,
        v.make ?? null, v.model ?? null, modelYear(v.year), v.color ?? null,
        v.plate ?? null, v.state ?? null, v.notes ?? null, now(), v.id);
    return one(`SELECT * FROM subject_vehicles WHERE id = ?`, v.id);
  }
  run(`INSERT INTO subject_vehicles
       (subject_id, make, model, year, color, plate, state, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      v.subject_id, v.make ?? null, v.model ?? null, modelYear(v.year), v.color ?? null,
      v.plate ?? null, v.state ?? null, v.notes ?? null, now());
  return one(`SELECT * FROM subject_vehicles WHERE subject_id = ? ORDER BY id DESC LIMIT 1`,
             v.subject_id);
}

export const deleteVehicle = id => run(`DELETE FROM subject_vehicles WHERE id = ?`, id);

/* ---------------- case notes ---------------- */

/** Newest first — an officer opening a case wants the latest, not the oldest. */
export const caseNotesFor = subject_id => all(
  `SELECT * FROM case_notes WHERE subject_id = ? ORDER BY id DESC`, subject_id);

/** Append only. There is deliberately no update and no delete. */
export function addCaseNote({ subject_id, body, author }) {
  run(`INSERT INTO case_notes (subject_id, body, author, created_at) VALUES (?,?,?,?)`,
      subject_id, body, author ?? null, now());
  return one(`SELECT * FROM case_notes WHERE subject_id = ? ORDER BY id DESC LIMIT 1`,
             subject_id);
}

/* ---------------- family contacts ---------------- */

/** The relationships people actually name. "Other" is last and catches the
 *  rest rather than pretending this list is complete. */
export const CONTACT_RELATIONSHIPS = [
  "Mother", "Father", "Stepmother", "Stepfather", "Guardian",
  "Spouse", "Partner", "Girlfriend", "Boyfriend", "Fiancé(e)", "Ex-spouse",
  "Son", "Daughter", "Brother", "Sister",
  "Grandmother", "Grandfather", "Aunt", "Uncle", "Cousin", "Nephew", "Niece",
  "In-law", "Friend", "Neighbor", "Roommate", "Clergy", "Sponsor", "Other"
];

export const contactsFor = subject_id =>
  all(`SELECT * FROM subject_contacts WHERE subject_id = ? ORDER BY name, id`, subject_id);

export const contactById = id =>
  one(`SELECT * FROM subject_contacts WHERE id = ?`, id);

/**
 * @param by "officer" or "subject" — who is making this change. Recorded so
 *   the provenance of a row survives; both sides edit the same list, and an
 *   officer reading it should be able to tell what the subject supplied.
 */
export function saveContact(c, by = "officer") {
  if (c.id) {
    run(`UPDATE subject_contacts
            SET name=?, relationship=?, phone=?, notes=?, updated_by=?, updated_at=?
          WHERE id = ?`,
        c.name, c.relationship, c.phone, c.notes ?? null, by, now(), c.id);
    return contactById(c.id);
  }
  run(`INSERT INTO subject_contacts
         (subject_id, name, relationship, phone, notes, added_by, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      c.subject_id, c.name, c.relationship, c.phone, c.notes ?? null, by, now());
  return one(`SELECT * FROM subject_contacts WHERE subject_id = ? ORDER BY id DESC LIMIT 1`,
             c.subject_id);
}

export const deleteContact = id => run(`DELETE FROM subject_contacts WHERE id = ?`, id);

export const vehicleById = id => one(`SELECT * FROM subject_vehicles WHERE id = ?`, id);

/* ---------------- curfew ---------------- */

export const curfewFor = subject_id =>
  one(`SELECT * FROM curfews WHERE subject_id = ?`, subject_id);

export function saveCurfew(c) {
  const existing = curfewFor(c.subject_id);
  if (existing) {
    run(`UPDATE curfews SET active=?, start_time=?, end_time=?, notes=?, updated_at=?
          WHERE subject_id = ?`,
        c.active ? 1 : 0, c.start_time ?? null, c.end_time ?? null,
        c.notes ?? null, now(), c.subject_id);
  } else {
    run(`INSERT INTO curfews (subject_id, active, start_time, end_time, notes, created_at)
         VALUES (?,?,?,?,?,?)`,
        c.subject_id, c.active ? 1 : 0, c.start_time ?? null, c.end_time ?? null,
        c.notes ?? null, now());
  }
  return curfewFor(c.subject_id);
}

/* ---------------- obligations ---------------- */

export const obligationsFor = (subject_id, kind = "community_service") =>
  all(`SELECT * FROM obligations WHERE subject_id = ? AND kind = ? ORDER BY id`,
      subject_id, kind);

export function saveObligation(o) {
  if (o.id) {
    run(`UPDATE obligations
            SET title=?, description=?, required_quantity=?, unit=?, status=?, due_at=?, updated_at=?
          WHERE id = ?`,
        o.title, o.description ?? null, o.required_quantity ?? null, o.unit ?? "hours",
        o.status ?? "todo", o.due_at ?? null, now(), o.id);
    return one(`SELECT * FROM obligations WHERE id = ?`, o.id);
  }
  run(`INSERT INTO obligations
       (subject_id, kind, title, description, required_quantity, unit, status, due_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      o.subject_id, o.kind ?? "community_service", o.title, o.description ?? null,
      o.required_quantity ?? null, o.unit ?? "hours", o.status ?? "todo",
      o.due_at ?? null, now());
  return one(`SELECT * FROM obligations WHERE subject_id = ? ORDER BY id DESC LIMIT 1`,
             o.subject_id);
}

export const deleteObligation = id => run(`DELETE FROM obligations WHERE id = ?`, id);

/* ---------------- travel permit ---------------- */

export const TRAVEL_LEVELS = ["none", "local", "interstate", "international"];

export const travelPermitFor = subject_id =>
  one(`SELECT * FROM travel_permits WHERE subject_id = ?`, subject_id);

export function saveTravelPermit(t) {
  const existing = travelPermitFor(t.subject_id);
  if (existing) {
    run(`UPDATE travel_permits SET level=?, expires_on=?, notes=?, issued_by=?, updated_at=?
          WHERE subject_id = ?`,
        t.level, t.expires_on ?? null, t.notes ?? null, t.issued_by ?? null,
        now(), t.subject_id);
  } else {
    run(`INSERT INTO travel_permits (subject_id, level, expires_on, notes, issued_by, created_at)
         VALUES (?,?,?,?,?,?)`,
        t.subject_id, t.level, t.expires_on ?? null, t.notes ?? null,
        t.issued_by ?? null, now());
  }
  return travelPermitFor(t.subject_id);
}

/* ---------------- employment ---------------- */

export const EMPLOYMENT_STATUSES = [
  ["employed",      "Employed"],
  ["self_employed", "Self-employed"],
  ["not_employed",  "Not employed"]
];

export const employmentFor = subject_id =>
  one(`SELECT * FROM employment WHERE subject_id = ?`, subject_id);

/** Only an employer has employer details. Clearing them when the status moves
 *  away from `employed` keeps the record honest: a "not employed" row that
 *  still names last year's company reads as current employment to anyone who
 *  looks at the columns rather than the status. */
/**
 * @param by "officer" or "subject". Employment is reported by the subject and
 *   recorded by the officer, and now both can write it — so the row says which
 *   of them did, the same way a contact does.
 */
export function saveEmployment(e, by = "officer") {
  const employed = e.status === "employed";
  const v = {
    company_name: employed ? (e.company_name ?? null) : null,
    address:      employed ? (e.address ?? null) : null,
    phone:        employed ? (e.phone ?? null) : null,
    supervisor:   employed ? (e.supervisor ?? null) : null,
    notes:        e.notes ?? null
  };
  const existing = employmentFor(e.subject_id);
  if (existing) {
    run(`UPDATE employment SET status=?, company_name=?, address=?, phone=?,
                               supervisor=?, notes=?, updated_by=?, updated_at=?
          WHERE subject_id = ?`,
        e.status, v.company_name, v.address, v.phone, v.supervisor, v.notes,
        by, now(), e.subject_id);
  } else {
    run(`INSERT INTO employment
           (subject_id, status, company_name, address, phone, supervisor, notes,
            updated_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        e.subject_id, e.status, v.company_name, v.address, v.phone, v.supervisor,
        v.notes, by, now());
  }
  return employmentFor(e.subject_id);
}

/* ---------------- documents ---------------- */

export const documentsFor = subject_id =>
  all(`SELECT * FROM documents WHERE subject_id = ? ORDER BY created_at DESC`, subject_id);

export const documentById = id => one(`SELECT * FROM documents WHERE id = ?`, id);

export function addDocument(d) {
  run(`INSERT INTO documents
       (subject_id, doc_type, title, filename, mime_type, byte_size,
        source_id, generated_at, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      d.subject_id, d.doc_type, d.title, d.filename,
      d.mime_type ?? "application/pdf", d.byte_size ?? null,
      d.source_id ?? null, d.generated_at ?? now(), d.created_by ?? null, now());
  return one(`SELECT * FROM documents WHERE subject_id = ? ORDER BY id DESC LIMIT 1`, d.subject_id);
}

/* ---------------- reference data ----------------
   Served to the client so every dropdown is filled from one source rather
   than a list copied into each form. */

export const SUPERVISION_KINDS = [
  ["probation", "Probation"], ["parole", "Parole"],
  ["supervision", "Community Supervision"], ["pretrial", "Pretrial Release"],
  ["drug_court", "Drug Court"], ["deferred", "Deferred Adjudication"]
];

export const SUPERVISION_LEVELS = [
  ["administrative", "Administrative"], ["minimum", "Minimum"],
  ["standard", "Standard"], ["medium", "Medium"],
  ["high", "High"], ["intensive", "Intensive"]
];

export const OBLIGATION_UNITS = [
  ["hours", "hours"], ["sessions", "sessions"], ["classes", "classes"],
  ["payments", "payments"], ["tests", "tests"], ["reports", "reports"]
];

export const activeOffices = () =>
  all(`SELECT * FROM offices WHERE active = 1 ORDER BY name`);

export const activeOfficers = () =>
  all(`SELECT id, name, email, badge, role FROM officers WHERE active = 1 ORDER BY name`);

export function seedOffices(names) {
  if (one(`SELECT COUNT(*) n FROM offices`).n > 0) return false;
  for (const o of names)
    run(`INSERT INTO offices (name, address, phone, created_at) VALUES (?,?,?,?)`,
        o.name, o.address ?? null, o.phone ?? null, now());
  return true;
}

/* ---------------- supervision agreement ---------------- */

/* The categories from the requirements. Supervision Information,
   Acknowledgment and Violation Language are not here: the first two are
   fields on the agreement and the third is standing text. */
export const CONDITION_CATEGORIES = [
  ["reporting",     "Reporting Requirements"],
  ["residence",     "Residence"],
  ["employment",    "Employment / Education"],
  ["travel",        "Travel & Movement"],
  ["conduct",       "Laws & Conduct"],
  ["substance",     "Substance Use"],
  ["weapons",       "Weapons & Contraband"],
  ["programs",      "Programs & Treatment"],
  ["financial",     "Financial Obligations"],
  ["monitoring",    "Search & Monitoring"],
  ["contact",       "Contact Restrictions"],
  ["documentation", "Required Documentation"],
  ["special",       "Special Conditions"]
];

export const agreementFor = subject_id => {
  const a = one(`SELECT * FROM agreements WHERE subject_id = ?
                  ORDER BY (status='active') DESC, id DESC LIMIT 1`, subject_id);
  return a ? { ...a, conditions: conditionsFor(a.id) } : null;
};

export const agreementById = id => {
  const a = one(`SELECT * FROM agreements WHERE id = ?`, id);
  return a ? { ...a, conditions: conditionsFor(a.id) } : null;
};

export const conditionsFor = agreement_id => all(
  `SELECT c.*, o.title AS obligation_title, o.status AS obligation_status,
          o.required_quantity, o.unit
     FROM agreement_conditions c
     LEFT JOIN obligations o ON o.id = c.obligation_id
    WHERE c.agreement_id = ?
    ORDER BY c.category, c.sort_order, c.id`, agreement_id);

const AGREEMENT_FIELDS = ["kind","supervision_level","start_date","end_date",
                          "office","officer_name","status","violation_text"];

export function saveAgreement(a) {
  if (a.id) {
    // Merge, do not overwrite. A payload that omits a field must leave it
    // alone — a partial save should never blank the rest of the record.
    const patch = AGREEMENT_FIELDS.filter(f => a[f] !== undefined);
    if (patch.length) {
      run(`UPDATE agreements SET ${patch.map(f => `${f}=?`).join(", ")}, updated_at=?
            WHERE id = ?`, ...patch.map(f => a[f]), now(), a.id);
    }
    return agreementById(a.id);
  }
  run(`INSERT INTO agreements
       (subject_id, kind, supervision_level, start_date, end_date, office,
        officer_name, status, violation_text, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      a.subject_id, a.kind ?? "probation", a.supervision_level ?? null,
      a.start_date ?? null, a.end_date ?? null, a.office ?? null,
      a.officer_name ?? null, a.status ?? "draft", a.violation_text ?? null, now());
  // The row just inserted — NOT agreementFor(), which prefers the active
  // agreement and so answered a "create a draft" with somebody's existing
  // executed one. A create that returns another record's id is the whole
  // reason every response must carry the real id of what it acted on.
  return one(`SELECT * FROM agreements WHERE subject_id = ? ORDER BY id DESC LIMIT 1`,
             a.subject_id);
}

export function saveCondition(c) {
  if (c.id) {
    run(`UPDATE agreement_conditions SET category=?, body=?, sort_order=? WHERE id = ?`,
        c.category, c.body, c.sort_order ?? 0, c.id);
    return one(`SELECT * FROM agreement_conditions WHERE id = ?`, c.id);
  }
  run(`INSERT INTO agreement_conditions (agreement_id, category, body, sort_order, created_at)
       VALUES (?,?,?,?,?)`,
      c.agreement_id, c.category, c.body, c.sort_order ?? 0, now());
  return one(`SELECT * FROM agreement_conditions WHERE agreement_id = ? ORDER BY id DESC LIMIT 1`,
             c.agreement_id);
}

export const deleteCondition = id =>
  run(`DELETE FROM agreement_conditions WHERE id = ?`, id);

/** Changing an executed agreement invalidates what the subject agreed to.
 *  Their acknowledgment refers to the text as it stood, so it is withdrawn
 *  and they are asked again. */
export function markAmended(agreement_id) {
  const a = one(`SELECT * FROM agreements WHERE id = ?`, agreement_id);
  if (!a || a.status !== "active") return false;
  if (!a.subject_signed_at) return false;
  run(`UPDATE agreements SET subject_signed_at = NULL, amended_at = ? WHERE id = ?`,
      now(), agreement_id);
  return true;
}

/** Turn a condition into something actionable. The clause stays as written;
 *  the obligation is what gets tracked. */
export function obligationFromCondition({ condition_id, subject_id, title, quantity, unit, due_at }) {
  const c = one(`SELECT * FROM agreement_conditions WHERE id = ?`, condition_id);
  if (!c) return { error: "no such condition" };
  if (c.obligation_id) return { error: "this condition already has a requirement" };
  run(`INSERT INTO obligations
       (subject_id, kind, title, description, required_quantity, unit, status, due_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      subject_id, "agreement_condition", title, c.body,
      quantity ?? null, unit ?? null, "todo", due_at ?? null, now());
  const o = one(`SELECT * FROM obligations WHERE subject_id = ? ORDER BY id DESC LIMIT 1`, subject_id);
  run(`UPDATE agreement_conditions SET obligation_id = ? WHERE id = ?`, o.id, condition_id);
  return { ok: true, obligation: o };
}

/** Every acceptance the subject has ever given, newest first. */
export const acknowledgmentsFor = agreement_id => all(
  `SELECT id, acknowledged_at, length(snapshot) AS snapshot_bytes
     FROM agreement_acknowledgments WHERE agreement_id = ?
    ORDER BY id DESC`, agreement_id);

export const acknowledgmentSnapshot = id => one(
  `SELECT * FROM agreement_acknowledgments WHERE id = ?`, id);

/**
 * @param snapshot the agreement text as the subject read it. Required when the
 *   subject is the signer — an acceptance with nothing attached to it is not
 *   evidence of anything.
 */
export function signAgreement(id, who, name, snapshot) {
  const col = who === "subject" ? "subject_signed_at" : "officer_signed_at";
  const a = one(`SELECT * FROM agreements WHERE id = ?`, id);
  if (!a) return { error: "no such agreement" };
  if (a[col]) return { ok: true, agreement: agreementById(id) };   // idempotent
  if (who === "subject") {
    if (!snapshot) return { error: "nothing to record an acknowledgment against" };
    run(`INSERT INTO agreement_acknowledgments
           (agreement_id, subject_id, acknowledged_at, snapshot) VALUES (?,?,?,?)`,
        id, a.subject_id, now(), snapshot);
  }
  if (who === "subject") run(`UPDATE agreements SET subject_signed_at = ? WHERE id = ?`, now(), id);
  else run(`UPDATE agreements SET officer_signed_at = ?, officer_signed_by = ? WHERE id = ?`,
           now(), name ?? null, id);
  return { ok: true, agreement: agreementById(id) };
}

export { now, db };
