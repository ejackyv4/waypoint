/**
 * A reentry plan, worked to the last signature.
 *
 * The demo needs Dana's plan worked almost to the end, because building that
 * by hand in front of an audience takes twenty minutes of clicking.
 *
 * "Almost" is the point. Two checkpoints are left carrying the officer's
 * signature but not hers, which puts the banner in her app and leaves the
 * demo two acts rather than one:
 *
 *   1. Dana signs the last two steps in the app
 *   2. the officer certifies the plan in the console
 *
 * Seeding it to 100% skipped straight to act two and hid the half of the
 * model that makes a checkpoint a checkpoint.
 *
 * It is seeded through the same functions the API calls, never with raw SQL.
 * That matters: if a rule changes — a checkpoint needing both signatures, an
 * exception needing a named approver — the seed either keeps satisfying it or
 * fails loudly. A seed that writes rows directly is a second implementation
 * of the rules, and it drifts.
 *
 * Marcus is deliberately left without a plan, so the empty state and the
 * "Create reentry plan" flow can be demonstrated too.
 */

import { planFor, createPlan, savePlan, saveItem, signItem, signPlan, readiness }
  from "../db/reentry.mjs";
import { subjectByKey } from "../db/northwood.mjs";
import { asProfile } from "./shared.mjs";
import { reentryBlocks, blocksToText } from "./reentry-doc.mjs";

const SUBJECT = "cust-2298";
const OFFICER = "R. Alvarez";

/* What each checkpoint actually says, so the demo reads like a real case
   rather than sixty identical ticks. Anything not named here is simply
   marked ready with no detail. */
const DETAIL = {
  "Residence identified": "1665 W 3500 S, Apt 3B, West Valley City UT 84119 — mother's address",
  "Residence approved for supervision": "Home visit 4 Sept; no co-residents with records",
  "Move-in confirmed": "Move-in 2 Oct, day of release",
  "Household members and contact details recorded": "Marlene Whitfield (mother), (801) 555-0188",

  "Birth certificate": "Certified copy held in property",
  "Social Security card": "Replacement received 22 Aug",

  "Supervising office identified": "Northwood Corrections — Salt Lake, 220 Center St",
  "Conditions reviewed with the subject": "Reviewed 12 Sept; agreement signed",
  "First reporting appointment scheduled": "3 Oct, 9:00 AM — R. Alvarez",
  "Transportation to first appointment confirmed": "Mother driving; UTA route 217 as fallback",

  "Transport from the facility arranged": "Collected by Marlene Whitfield, 2 Oct 8:00 AM",
  "Routine travel to supervision and appointments": "2014 Honda Civic (registered to her mother); UTA pass issued",

  "Employment status determined": "Seeking work; cleared for full-time",
  "Job secured or leads established": "Employed at Ridgeway Fabrication, Salt Lake City — swing shift, verified 18 Aug",
  "Resume and applications ready": "Resume completed in the facility programme",

  "Primary care provider identified": "Dr Halloran, Redwood Family Medicine, Salt Lake City",
  "Medication supply arranged": "30-day supply released with property; refill 1 Nov",
  "Initial appointment scheduled": "9 Oct, 10:30 AM",

  "Behavioral health need assessed": "Assessed 14 Aug — outpatient counselling indicated",
  "Provider identified": "Valley Behavioral Health, Salt Lake City",
  "First appointment scheduled": "7 Oct, 2:00 PM",

  "Benefit eligibility reviewed": "Reviewed with benefits liaison 30 Aug",
  "Medicaid or insurance activated": "Utah Medicaid reinstated 18 Sept",

  "Immediate financial needs addressed": "$120 gate money; family support for first month",
  "Banking or payment access arranged": "Account opened, Mountain America Credit Union",
  "Fines, restitution and fees understood": "Restitution $1,240 — $50/month from 1 Nov",

  "Support contacts identified": "Marlene Whitfield (mother); Nia Whitfield (sister); Terrence Boyd (sponsor)",
  "Mentor, peer or community support available": "Peer mentor assigned via Utah Reentry Coalition",

  "Required programming identified": "Cognitive-behavioural programme, 12 weeks",
  "Enrolment or continuation arranged": "Enrolled, starts 8 Oct",

  "Outstanding court dates and obligations reviewed": "None outstanding as of 20 Sept",
  "Warrants and holds resolved or documented": "Salt Lake County hold cleared 2 Sept",

  "Identity documents in the subject's possession": "Birth certificate and SSN card in property",
  "Education and programme records available": "GED certificate on file",

  "Phone or email access arranged": "(801) 555-0142 — active on release",
  "Contact details shared with the supervising officer": "Confirmed 12 Sept",

  "Clothing available on release": "Two weeks of clothing provided by family",
  "Food and hygiene supplies for the first week": "Provided by household",
  "Immediate medications in hand": "Released with 30-day supply",

  "Local providers and services identified": "Salt Lake County resource list issued",

  "Release date and time confirmed": "2 October 2026, 8:00 AM",
  "Destination confirmed": "1665 W 3500 S, Apt 3B, West Valley City",
  "Person meeting them identified": "Marlene Whitfield (mother)",
  "Property, medications and documents released": "Checked against property inventory",

  "Critical first-72-hour actions listed and prioritised":
    "Report by phone; collect prescriptions; confirm start date with programme",
  "First-30-day appointments and milestones scheduled":
    "Supervision 3 Oct · counselling 7 Oct · programme 8 Oct · primary care 9 Oct"
};

/* Requirements vary by person, and a plan that pretends otherwise produces a
   dishonest score. These leave the calculation entirely. */
const NOT_APPLICABLE = [
  "Driver's licence, if applicable",
  "Public transit plan or fare assistance",
  "Education or training need assessed",
  "Programme identified and enrolment arranged",
  "Treatment requirement identified",
  "Provider and enrolment established",
  "Recovery support resources identified",
  "Registration requirements understood",
  "Reunification considerations addressed"
];

/* The other half of "not complete must never mean cannot release": a real
   obstacle, carried by a documented plan and a named approver. */
const EXCEPTIONS = {
  "State ID": {
    mitigation: "Utah DLD cannot issue before release. An appointment is booked at "
      + "the Salt Lake office for 6 October; facility ID and certified birth "
      + "certificate carried in the interim. Officer to verify issue at the "
      + "first reporting appointment.",
    approved_by: "T. Nakamura"
  }
};

/**
 * Left waiting on Dana's signature.
 *
 * The officer has verified both; she has not co-signed either. That is what
 * raises the banner in her app, keeps the plan short of certifiable, and
 * gives the officer's Certify button its disabled state with a reason —
 * three things on screen from one piece of seed data.
 */
const AWAITING_SUBJECT = [
  "Move-in confirmed",
  "First reporting appointment scheduled"
];

export function seedReentryPlan() {
  const subject = subjectByKey(SUBJECT);
  if (!subject) return;
  if (planFor(SUBJECT)) return;                    // never touch an existing plan

  const plan = createPlan({
    subject_id: SUBJECT,
    target_release_date: "2026-10-02",
    facility: "Northwood Regional Correctional Facility",
    officer_name: OFFICER,
    notes: "Release plan reviewed with the subject 12 September. Housing and "
         + "supervision confirmed; state ID carried as an approved exception."
  }, OFFICER);

  for (const item of plan.items) {
    if (NOT_APPLICABLE.includes(item.label)) {
      saveItem({ id: item.id, status: "not_applicable" }, OFFICER);
      continue;
    }
    const ex = EXCEPTIONS[item.label];
    if (ex) {
      saveItem({ id: item.id, status: "exception", ...ex }, OFFICER);
      continue;
    }
    saveItem({ id: item.id, status: "ready", detail: DETAIL[item.label] ?? null }, OFFICER);
    signItem(item.id, "officer", OFFICER);
    // Both parties, because one signature is not a completed checkpoint —
    // except the two deliberately left for Dana to give during the demo.
    if (!AWAITING_SUBJECT.includes(item.label))
      signItem(item.id, "subject", `${subject.first_name} ${subject.last_name}`);
  }

  // The officer issues it, and the subject accepts — an acknowledgment of the
  // plan, not of a finished one. Only then is there anything to certify.
  signPlan(plan.id, "officer", OFFICER);
  savePlan({ id: plan.id, status: "active" });

  const doc = planFor(SUBJECT);
  signPlan(doc.id, "subject", null,
           blocksToText(reentryBlocks(doc, asProfile(subject))));

  /* The seed exists to leave exactly the right things undone. If it leaves
     none, the demo skips the app entirely; if it leaves the wrong ones, it
     opens mid-plan. Either way nobody finds out until they are in front of
     an audience, so say so here. */
  const r = readiness(planFor(SUBJECT).items);
  if (r.awaiting_signature !== AWAITING_SUBJECT.length)
    console.error(`  [seed] reentry plan has ${r.awaiting_signature} checkpoint(s) `
                + `awaiting a signature, expected ${AWAITING_SUBJECT.length}`);
  else
    console.log(`  Reentry plan      ${r.complete}/${r.total} complete, `
              + `${r.not_applicable} n/a — ${r.awaiting_signature} awaiting Marcus's `
              + `signature, then the officer certifies`);
}
