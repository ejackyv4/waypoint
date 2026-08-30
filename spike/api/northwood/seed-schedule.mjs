/**
 * Marcus's diary: a visit tomorrow, and appointments spread across the coming
 * week.
 *
 * Everything here is relative to the moment of the reset, never a fixed date.
 * A demo whose "upcoming" visit was last March makes the whole product look
 * abandoned, and it is the first thing anybody notices.
 *
 * The spread is deliberate. Each appointment sits at a different point in its
 * own lifecycle — one never seen, one seen but not accepted, one accepted, one
 * whose day has passed with nothing reported — so every state the module can
 * be in is on screen at once rather than needing four clicks to produce.
 */

import { scheduleVisit, subjectByKey } from "../db/northwood.mjs";
import { saveDate, datesFor, markDateSeen, acknowledgeDate } from "../db/dates.mjs";
import { buildAgenda } from "../db/agenda.mjs";
import { one } from "../db/connect.mjs";

const SUBJECT = "cust-2298";
const OFFICER = "R. Alvarez";

/* Its own tiny helper rather than importing visitsFor, which hydrates every
   visit with its notes, photographs and agenda just to answer "any?". */
const visitsExist = subject_id =>
  (one(`SELECT COUNT(*) n FROM visits WHERE subject_id = ?`, subject_id)?.n ?? 0) > 0;

/** A time on a day relative to now, as an ISO instant. */
const at = (days, hour, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

export function seedSchedule() {
  const subject = subjectByKey(SUBJECT);
  if (!subject) return;
  const done = [];

  /* ---- a visit tomorrow ----
     Flexible, because a home visit is a day rather than an hour — which is
     also what makes the route planner worth demonstrating. */
  const visits = [];
  if (!visitsExist(SUBJECT)) {
    const tomorrow = scheduleVisit({
      subject_id: SUBJECT, scheduled_at: at(1, 10),
      officer: OFFICER,
      location: [subject.address_line1, subject.city, subject.state]
                  .filter(Boolean).join(", "),
      notes: "Bring the pay stub and the insurance card.",
      time_fixed: false
    });
    // The agenda is built at booking, exactly as the API does it.
    buildAgenda(tomorrow.id, SUBJECT, OFFICER);
    visits.push(tomorrow);

    // And one next week, so the schedule is not a single row.
    const later = scheduleVisit({
      subject_id: SUBJECT, scheduled_at: at(8, 14),
      officer: OFFICER,
      location: "Northwood Corrections — Ogden, 18 Washington Blvd",
      notes: "Office report.",
      time_fixed: true
    });
    buildAgenda(later.id, SUBJECT, OFFICER);
    visits.push(later);
    done.push(`${visits.length} visits`);
  }

  /* ---- appointments across the coming week ----
     Each on its own day, and each at a different point in its lifecycle. */
  if (!datesFor(SUBJECT).length) {
    const made = [];
    for (const d of [
      { kind: "court", title: "Status hearing", days: 2, hour: 9,
        location: "Second District Court, Room 214",
        address: "2525 Grant Ave, Ogden, UT 84401",
        detail: "Bring photo identification. Arrive thirty minutes early." },
      { kind: "drug_test", title: "Random test", days: 3, hour: 7, minute: 30,
        location: "Averhealth Ogden",
        address: "1150 Washington Blvd, Ogden, UT 84404" },
      { kind: "treatment", title: "Group session", days: 5, hour: 18,
        location: "Weber Human Services",
        address: "237 26th St, Ogden, UT 84401",
        detail: "Weekly. Missing two consecutively is a violation." },
      { kind: "parole_board", title: "Board review", days: 7, hour: 11,
        location: "Utah Board of Pardons and Parole",
        address: "448 E Winchester St, Murray, UT 84107" },
      /* Already happened, and nobody has said what came of it — the state an
         officer is meant to chase, and the one that is otherwise invisible
         until somebody waits a week. */
      { kind: "medical", title: "Clinic appointment", days: -3, hour: 15,
        location: "Midtown Community Health",
        address: "2240 Adams Ave, Ogden, UT 84401" }
    ]) {
      made.push(saveDate({
        subject_id: SUBJECT, kind: d.kind, title: d.title,
        scheduled_at: at(d.days, d.hour, d.minute || 0),
        location: d.location, address: d.address, detail: d.detail
      }, OFFICER));
    }

    /* Lifecycle spread. Deliberately through the real functions: "seen" and
       "accepted" are separate facts and the seed has no business writing
       either straight into a column. */
    const [hearing, test, group] = made;
    markDateSeen(hearing.id);
    acknowledgeDate(hearing.id);      // seen and accepted
    markDateSeen(test.id);            // seen, not accepted
    // `group` is left untouched — assigned, and he does not know yet.
    void group;

    done.push(`${made.length} important dates`);
  }

  if (done.length) console.log(`  Diary             ${done.join(", ")}`);
}
