/**
 * The visit agenda — what needs discussing when the officer turns up.
 *
 * Built from the case file at the moment a visit is scheduled, and from then
 * on it is the visit's own record. See the table comment in schema.mjs for why
 * it is a snapshot rather than a live query.
 */

import { all, one, run } from "./connect.mjs";
import { financialFor, money } from "./financial.mjs";
import { datesFor } from "./dates.mjs";
import { goalsFor } from "./goals.mjs";

const now = () => new Date().toISOString();

const shortDate = d => {
  if (!d) return "";
  const t = new Date(d.length <= 10 ? d + "T00:00:00" : d);
  return isNaN(t) ? "" : t.toLocaleDateString("en-US",
    { month: "short", day: "numeric", year: "numeric" });
};

/* ---------------- what the case file suggests ----------------

   Each source answers one question: what would an officer want to raise about
   this, standing in someone's front room? Anything that is not actionable at
   a visit does not belong here — an agenda that lists everything is a list
   nobody reads. */

/**
 * The candidate agenda for a subject, right now.
 *
 * Pure: it reads the case file and returns items, it writes nothing. That
 * makes it usable for a preview when scheduling, before any visit exists.
 *
 * `programs` arrives as data rather than being read here, because programs
 * live in Waypoint and this is Northwood's data layer — it may not import
 * across that boundary. The caller fetches them over the API like any other
 * integrator and hands them in. If Waypoint is unreachable the agenda is
 * simply built without them, which is the right failure: an officer should
 * get the rest of their agenda rather than none of it.
 */
export function suggestedAgenda(subject_id, { horizonDays = 45, programs = [] } = {}) {
  const items = [];
  const horizon = new Date(Date.now() + horizonDays * 864e5).toISOString();

  /* Money owed. Waived and settled items are not raised — the point is what
     is still owed, not a recital of the whole ledger. */
  for (const f of financialFor(subject_id)) {
    if (f.balance_cents <= 0) continue;
    items.push({
      source_kind: "financial", source_id: f.id,
      body: `${f.kind_label || f.kind}: ${money(f.balance_cents)} outstanding`,
      detail: [f.description,
               f.due_date ? `${f.state === "overdue" ? "was due" : "due"} `
                          + shortDate(f.due_date) : null]
              .filter(Boolean).join(" · ")
    });
  }

  /* Appointments coming up, and any that have passed with nothing reported —
     the second being exactly what an officer is there to ask about. */
  for (const d of datesFor(subject_id)) {
    if (d.status !== "scheduled") continue;
    const upcoming = d.scheduled_at <= horizon;
    if (!upcoming && !d.awaiting_outcome) continue;
    items.push({
      source_kind: "date", source_id: d.id,
      body: d.awaiting_outcome
        ? `${d.kind_label}: did they attend on ${shortDate(d.scheduled_at)}?`
        : `${d.kind_label}: ${shortDate(d.scheduled_at)}`,
      /* The lifecycle state still reads through even for a past appointment,
         which is the point of keeping the two apart: "they never looked at it"
         and "they accepted and then went quiet" are different conversations. */
      detail: [d.location,
               d.state === "assigned" ? "not yet seen by the subject"
                 : d.state === "viewed" ? "seen but not accepted" : null]
              .filter(Boolean).join(" · ")
    });
  }

  /* Open goals, because a goal nobody asks about is a goal nobody works. */
  for (const g of goalsFor(subject_id)) {
    if (g.status !== "open") continue;
    items.push({
      source_kind: "goal", source_id: g.id,
      body: `Goal: ${g.title}`,
      detail: [g.progress.total ? `${g.progress.done} of ${g.progress.total} steps` : "no steps yet",
               g.due_date ? `${g.overdue ? "was due" : "due"} ${shortDate(g.due_date)}` : null]
              .filter(Boolean).join(" · ")
    });
  }

  /* Training assigned through Waypoint. Only what is worth raising: not
     started, part-way through, or failed. A course somebody passed is not an
     agenda item — it is a thing that went well. */
  for (const pr of programs) {
    const done = pr.completion_status === "completed";
    const failed = pr.success_status === "failed";
    if (done && !failed) continue;
    const started = pr.completion_status && pr.completion_status !== "not attempted";
    items.push({
      source_kind: "program", source_id: null, source_ref: pr.program_id,
      body: failed ? `Course not passed: ${pr.title}`
          : started ? `Course in progress: ${pr.title}`
          : `Course not started: ${pr.title}`,
      detail: [failed && pr.score_raw != null ? `scored ${pr.score_raw}` : null,
               pr.total_seconds ? `${Math.round(pr.total_seconds / 60)} minutes so far` : null,
               pr.assigned_at ? `assigned ${shortDate(pr.assigned_at)}` : null]
              .filter(Boolean).join(" · ")
    });
  }

  return items;
}

/* ---------------- reads ---------------- */

export const agendaFor = visit_id => all(
  `SELECT * FROM visit_agenda WHERE visit_id = ? ORDER BY sort_order, id`, visit_id);

export const agendaItemById = id =>
  one(`SELECT * FROM visit_agenda WHERE id = ?`, id);

/* ---------------- writes ---------------- */

/**
 * Fill a visit's agenda from the case file.
 *
 * Additive by design. An item already on the agenda is left exactly as it is —
 * including anything already marked covered, and including its wording, which
 * is what it said when it was raised. Refreshing brings in what is new; it
 * never rewrites what was there.
 *
 * Officer-added items are never touched, because nothing here can suggest one.
 */
export function buildAgenda(visit_id, subject_id, author, { programs = [] } = {}) {
  /* Identity is the source plus its key. A program has no numeric id on this
     side of the boundary — Waypoint's `program_id` is the key, and it is
     stored in source_ref rather than pretending it is a row id here. */
  const key = i => `${i.source_kind}:${i.source_id ?? i.source_ref ?? ""}`;
  const have = new Set(agendaFor(visit_id)
    .filter(i => i.source_id !== null || i.source_ref)
    .map(key));

  let order = one(`SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM visit_agenda
                    WHERE visit_id = ?`, visit_id).n;
  let added = 0;
  for (const it of suggestedAgenda(subject_id, { programs })) {
    if (have.has(key(it))) continue;
    run(`INSERT INTO visit_agenda
           (visit_id, source_kind, source_id, source_ref, body, detail,
            sort_order, added_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        visit_id, it.source_kind, it.source_id ?? null, it.source_ref ?? null,
        it.body, it.detail || null, order++, author ?? null, now());
    added++;
  }
  return { added, agenda: agendaFor(visit_id) };
}

/** An officer's own item — something the case file cannot know to suggest. */
export function addAgendaItem({ visit_id, body, detail }, author) {
  const order = one(`SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM visit_agenda
                      WHERE visit_id = ?`, visit_id).n;
  run(`INSERT INTO visit_agenda
         (visit_id, source_kind, source_id, body, detail, sort_order, added_by, created_at)
       VALUES (?,?,NULL,?,?,?,?,?)`,
      visit_id, "custom", body, detail ?? null, order, author ?? null, now());
  return one(`SELECT * FROM visit_agenda WHERE visit_id = ? ORDER BY id DESC LIMIT 1`,
             visit_id);
}

export const removeAgendaItem = id => run(`DELETE FROM visit_agenda WHERE id = ?`, id);

/**
 * Mark an item discussed, with what was said.
 *
 * The note is the point. "Covered" on its own says an officer ticked a box;
 * "covered — says he will pay $50 on the 1st" is the thing anybody reads the
 * visit record for.
 */
export function coverAgendaItem(id, { covered = true, note }, author) {
  const it = agendaItemById(id);
  if (!it) return { error: "no such agenda item" };
  if (covered)
    run(`UPDATE visit_agenda SET covered_at = ?, covered_by = ?, note = ? WHERE id = ?`,
        now(), author ?? null, note ?? it.note ?? null, id);
  else
    run(`UPDATE visit_agenda SET covered_at = NULL, covered_by = NULL WHERE id = ?`, id);
  return { ok: true, item: agendaItemById(id) };
}

/** How much of the agenda was actually worked through. Computed, never stored. */
export const agendaProgress = agenda => ({
  covered: agenda.filter(i => i.covered_at).length,
  total: agenda.length
});
