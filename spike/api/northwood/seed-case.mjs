/**
 * Marcus Oyelaran's case file: the things an officer would already know about
 * somebody six months into supervision — where he lives, what he drives, who
 * is around him, when he has to be home, where he works, what he owes and what
 * he is working towards.
 *
 * All of it is demo furniture, and all of it exists so the demo does not open
 * on empty modules. An empty screen makes a product look unfinished even when
 * the reason is simply that nobody has typed anything in yet.
 *
 * Written through the same functions the API calls, never raw SQL, so a rule
 * change either keeps being satisfied here or fails loudly.
 *
 * **Dana Whitfield is left bare on purpose.** Every module has an empty state
 * and a Create flow, and a demo that can only show populated screens cannot
 * show either.
 */

import { saveVehicle, vehiclesFor, saveContact, contactsFor,
         saveCurfew, curfewFor, saveEmployment, employmentFor,
         subjectByKey } from "../db/northwood.mjs";
import { saveFinancialItem, financialFor, addPayment, toCents }
  from "../db/financial.mjs";
import { saveGoal, saveStep, goalsFor, setStepDone, completeGoal }
  from "../db/goals.mjs";

const SUBJECT = "cust-2298";
const OFFICER = "R. Alvarez";

/* Dates are computed at reset time so the demo is never stale: a fine that
   fell due last year and an appointment in the past make the whole thing look
   abandoned. */
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

export function seedCaseFile() {
  if (!subjectByKey(SUBJECT)) return;
  const done = [];

  /* ---- vehicle ---- */
  if (!vehiclesFor(SUBJECT).length) {
    saveVehicle({
      subject_id: SUBJECT,
      make: "Ford", model: "F-150", year: "2011",
      color: "White", plate: "T94 2LM", state: "UT",
      notes: "Work truck. Registered to him; insurance verified 12 August."
    });
    done.push("vehicle");
  }

  /* ---- family and support network ----
     The same people the reentry plan names, because a case file that
     contradicts itself between two screens is worse than an empty one. */
  if (!contactsFor(SUBJECT).length) {
    for (const c of [
      { name: "Adaeze Oyelaran", relationship: "Mother", phone: "(801) 555-0214",
        notes: "Lives two streets away. Primary support." },
      { name: "Simone Oyelaran", relationship: "Sister", phone: "(801) 555-0288",
        notes: "Approved contact. Drives him when the truck is off the road." },
      { name: "Ray Whitlock", relationship: "Sponsor", phone: "(385) 555-0362",
        notes: "Recovery sponsor since February. Weekly contact." }
    ]) saveContact({ ...c, subject_id: SUBJECT }, OFFICER);
    done.push(`${contactsFor(SUBJECT).length} contacts`);
  }

  /* ---- curfew ---- */
  if (!curfewFor(SUBJECT)?.active) {
    saveCurfew({
      subject_id: SUBJECT, active: 1,
      start_time: "22:00", end_time: "05:00",
      notes: "In effect nightly. Extended to 00:30 on nights he is rostered "
           + "for the late shift; supervisor confirms the roster monthly."
    });
    done.push("curfew");
  }

  /* ---- employment ---- */
  if (!employmentFor(SUBJECT)?.company_name) {
    saveEmployment({
      subject_id: SUBJECT,
      status: "employed",
      company_name: "Wasatch Steel Fabrication",
      address: "2140 Wall Ave, Ogden, UT 84401",
      phone: "(801) 555-0455",
      supervisor: "D. Kovacs",
      notes: "Fabrication assistant, Monday to Friday 6am–2:30pm. Verified by "
           + "telephone with the supervisor on 12 August."
    }, OFFICER);
    done.push("employment");
  }

  /* ---- what he owes ----
     One overdue and one falling due shortly, because a balance that is either
     all clear or all late shows only half the module. */
  if (!financialFor(SUBJECT).length) {
    const restitution = saveFinancialItem({
      subject_id: SUBJECT, kind: "restitution",
      description: "Victim restitution, case NC-2026-0511",
      amount_cents: toCents("1840.00"), due_date: inDays(45)
    }, OFFICER);
    // Paying against it, so the payment history is not an empty list.
    addPayment({ item_id: restitution.id, amount_cents: toCents("120.00"),
                 paid_on: inDays(-38), method: "Money order" }, OFFICER, "officer");
    addPayment({ item_id: restitution.id, amount_cents: toCents("120.00"),
                 paid_on: inDays(-8), method: "Cash at office" }, "Marcus Oyelaran",
               "subject");

    saveFinancialItem({
      subject_id: SUBJECT, kind: "supervision_fee",
      description: "Monthly supervision fee",
      amount_cents: toCents("45.00"), due_date: inDays(-4)     // already late
    }, OFFICER);

    saveFinancialItem({
      subject_id: SUBJECT, kind: "court_costs",
      description: "Court costs, Second District",
      amount_cents: toCents("310.00"), due_date: inDays(9)
    }, OFFICER);
    done.push("3 financial items");
  }

  /* ---- goals ----
     One under way, one not started, one already met, so the badge, the
     progress bar and the closed state are all on screen at once. */
  if (!goalsFor(SUBJECT).length) {
    const employment = saveGoal({
      subject_id: SUBJECT, title: "Keep steady employment",
      detail: "Hold the fabrication job through the review period.",
      due_date: inDays(60)
    }, OFFICER);
    for (const body of ["Provide a pay stub each month",
                        "Report any change of shift within 72 hours",
                        "Complete the six-month probationary period"])
      saveStep({ goal_id: employment.id, body });
    // Two of three done: enough to show progress without looking finished.
    const steps = goalsFor(SUBJECT).find(g => g.id === employment.id).steps;
    setStepDone(steps[0].id, true, "subject");
    setStepDone(steps[1].id, true, "officer");

    const licence = saveGoal({
      subject_id: SUBJECT, title: "Reinstate driver's licence",
      detail: "Needed to keep the job once the current lift-share ends.",
      due_date: inDays(21)
    }, OFFICER);
    for (const body of ["Pay the outstanding reinstatement fee",
                        "Book the written test",
                        "Provide proof of insurance"])
      saveStep({ goal_id: licence.id, body });

    const housing = saveGoal({
      subject_id: SUBJECT, title: "Secure approved housing",
      detail: "Move out of the temporary room into an approved address."
    }, OFFICER);
    saveStep({ goal_id: housing.id, body: "Address approved by supervision" });
    const hs = goalsFor(SUBJECT).find(g => g.id === housing.id).steps;
    setStepDone(hs[0].id, true, "officer");
    /* Closed through the same function the officer's button calls, so it gets
       a completed_at and a name on it rather than just a status string. */
    completeGoal(housing.id, OFFICER);

    done.push("3 goals");
  }

  if (done.length) console.log(`  Case file         ${done.join(", ")}`);
}
