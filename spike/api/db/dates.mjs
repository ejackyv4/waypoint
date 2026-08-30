/**
 * Important dates — data layer.
 *
 * Appointments the subject attends somewhere else: hearings, court, treatment,
 * testing. Not officer visits, which have their own table and their own shape.
 */

import { all, one, run } from "./connect.mjs";

const now = () => new Date().toISOString();

/**
 * The kinds an officer can raise.
 *
 * Server-owned, like every other vocabulary here. The list is deliberately
 * concrete rather than a free-text field: "court" and "Court date" and
 * "COURT HEARING" typed by three officers is a report nobody can group.
 */
export const DATE_KINDS = [
  ["parole_board",   "Parole board hearing"],
  ["court",          "Court hearing"],
  ["review_hearing", "Probation review hearing"],
  ["treatment",      "Treatment or counselling session"],
  ["drug_test",      "Drug test"],
  ["medical",        "Medical appointment"],
  ["program",        "Program or class session"],
  ["community_svc",  "Community service shift"],
  ["employment",     "Employment interview or appointment"],
  ["benefits",       "Benefits or social services appointment"],
  ["identification", "Identification or DMV appointment"],
  ["registration",   "Registration requirement"],
  ["housing",        "Housing appointment or inspection"],
  ["other",          "Other"]
];

const KIND_LABEL = Object.fromEntries(DATE_KINDS);

/* ---------------- the derived rules ---------------- */

/**
 * Where an appointment is in its lifecycle.
 *
 *   assigned   raised, and the subject does not know about it yet
 *   viewed     it has been in front of them; they have not agreed
 *   accepted   they have said they will be there
 *   completed  they attended
 *   missed     they did not
 *
 * An earlier version had `overdue` as a sixth state, returned as soon as the
 * date passed. That was wrong: it *replaced* the lifecycle state, so an
 * appointment past its date could no longer be told apart from one nobody had
 * ever looked at. Whether the day has come and gone is orthogonal to how far
 * the subject got with it, and the two are now separate — see
 * `awaitingOutcome` below.
 */
export function dateState(d) {
  if (d.status === "cancelled") return "cancelled";
  if (d.status === "missed") return "missed";
  if (d.status === "completed") return "completed";
  if (d.acknowledged_at) return "accepted";
  return d.seen_at ? "viewed" : "assigned";
}

/**
 * The day has passed and nobody has said what happened.
 *
 * A flag, not a state, so it can be true of an appointment that was accepted
 * AND of one that was never looked at — which are different problems needing
 * different conversations.
 */
export const awaitingOutcome = d =>
  d.status === "scheduled" && new Date(d.scheduled_at) < new Date();

/** Roll-up for a badge: red while something is unacknowledged or unreported. */
export function dateSummary(dates) {
  const open = dates.filter(d => d.status === "scheduled");
  if (!open.length)
    return { n: 0, tone: null, unaccepted: 0, unseen: 0, awaiting_outcome: 0, next: null };
  const states = open.map(dateState);
  const late = open.filter(awaitingOutcome).length;
  return {
    n: open.length,
    unaccepted: states.filter(x => x === "assigned" || x === "viewed").length,
    unseen: states.filter(x => x === "assigned").length,
    awaiting_outcome: late,
    next: open.map(d => d.scheduled_at).sort()[0] || null,
    tone: late || states.some(x => x === "assigned" || x === "viewed")
            ? "urgent" : "active"
  };
}

/* ---------------- reads ---------------- */

const hydrate = d => d && {
  ...d,
  kind_label: KIND_LABEL[d.kind] || d.kind,
  state: dateState(d),
  awaiting_outcome: awaitingOutcome(d)
};

export const datesFor = subject_id => all(
  `SELECT * FROM important_dates WHERE subject_id = ?
    ORDER BY (status = 'scheduled') DESC, scheduled_at`, subject_id).map(hydrate);

export const dateById = id =>
  hydrate(one(`SELECT * FROM important_dates WHERE id = ?`, id));

export const datesSummary = subject_id => {
  const dates = datesFor(subject_id);
  return { dates, summary: dateSummary(dates) };
};

export const unseenDateCount = subject_id => one(
  `SELECT COUNT(*) n FROM important_dates
    WHERE subject_id = ? AND status = 'scheduled' AND seen_at IS NULL`,
  subject_id)?.n ?? 0;

/**
 * One appointment has been put in front of the subject.
 *
 * Per appointment, not per tab. Marking everything seen because somebody
 * opened a screen claims more than happened, and this is the flag an officer
 * uses to decide whether to ring them — so it had better mean what it says.
 *
 * Idempotent, and it keeps the FIRST time: when they saw it is the fact worth
 * having, not when they last scrolled past it.
 */
export function markDateSeen(id) {
  run(`UPDATE important_dates SET seen_at = ?
        WHERE id = ? AND seen_at IS NULL AND status = 'scheduled'`, now(), id);
  return dateById(id);
}

/* ---------------- writes ---------------- */

const FIELDS = ["kind", "title", "detail", "scheduled_at", "location", "address", "status"];

export function saveDate(d, author) {
  if (d.id) {
    // Merge, never overwrite: a payload that omits a field leaves it alone.
    const patch = FIELDS.filter(k => d[k] !== undefined);
    if (patch.length)
      run(`UPDATE important_dates SET ${patch.map(k => `${k}=?`).join(", ")}, updated_at=?
            WHERE id = ?`, ...patch.map(k => d[k]), now(), d.id);

    /* Moving an appointment withdraws the subject's acknowledgment. They
       agreed to be somewhere at a time; change either and they have not
       agreed to anything yet. Same rule as amending an agreement. */
    if (d.scheduled_at !== undefined || d.address !== undefined || d.location !== undefined) {
      const cur = one(`SELECT * FROM important_dates WHERE id = ?`, d.id);
      if (cur?.acknowledged_at)
        run(`UPDATE important_dates SET acknowledged_at = NULL, seen_at = NULL
              WHERE id = ?`, d.id);
    }
    return dateById(d.id);
  }
  run(`INSERT INTO important_dates
         (subject_id, kind, title, detail, scheduled_at, location, address,
          created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      d.subject_id, d.kind, d.title ?? null, d.detail ?? null, d.scheduled_at,
      d.location ?? null, d.address ?? null, now(), author ?? null);
  return dateById(
    one(`SELECT id FROM important_dates WHERE subject_id = ? ORDER BY id DESC LIMIT 1`,
        d.subject_id).id);
}

export const deleteDate = id => run(`DELETE FROM important_dates WHERE id = ?`, id);

/**
 * The subject confirms they will be there.
 *
 * Deliberately not the same as having seen it. "I know about this" and "I will
 * be there" are different claims, and the second is the one an officer relies
 * on. Idempotent — a repeated tap is not a second promise.
 */
export function acknowledgeDate(id) {
  const d = one(`SELECT * FROM important_dates WHERE id = ?`, id);
  if (!d) return { error: "no such appointment" };
  if (d.status !== "scheduled") return { error: "This appointment is closed." };
  if (!d.acknowledged_at)
    run(`UPDATE important_dates SET acknowledged_at = ? WHERE id = ?`, now(), id);
  return { ok: true, date: dateById(id) };
}

/**
 * Say what happened: attended, or missed.
 *
 * Either party may report it — the subject was there, the officer heard from
 * the court. Which of them said so is recorded, because "they say they
 * attended" and "the court confirmed they attended" are different claims.
 */
export function closeDate(id, { status, note }, author, role) {
  const d = one(`SELECT * FROM important_dates WHERE id = ?`, id);
  if (!d) return { error: "no such appointment" };
  if (!["completed", "missed", "cancelled", "scheduled"].includes(status))
    return { error: "not an outcome" };

  if (status === "scheduled") {
    run(`UPDATE important_dates SET status = 'scheduled', completed_at = NULL,
           completed_by = NULL, completed_role = NULL, outcome_note = NULL,
           updated_at = ? WHERE id = ?`, now(), id);
  } else {
    run(`UPDATE important_dates SET status = ?, completed_at = ?, completed_by = ?,
           completed_role = ?, outcome_note = ?, updated_at = ? WHERE id = ?`,
        status, now(), author ?? null, role ?? null, note ?? null, now(), id);
  }
  return { ok: true, date: dateById(id) };
}
