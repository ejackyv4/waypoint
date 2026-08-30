/**
 * A supervision agreement, signed and issued and waiting on the subject.
 *
 * Building one during a demo means choosing a kind, a level, dates, an office,
 * an officer, then adding a dozen conditions by hand, then signing, then
 * activating — and the first time it was done live the officer's signature
 * was missed and the plan silently never reached the app.
 *
 * Seeded signed and issued, but NOT acknowledged. The demo's whole point is
 * that the subject has an active part in this, so the app opens with both
 * things she owes on it: acknowledge the conditions, and co-sign the last two
 * reentry checkpoints.
 *
 * (An earlier version seeded it acknowledged, because the app showed one
 * banner at a time and this one outranked the reentry plan. That priority
 * was a mistake in the app, not a reason to hide the work — it now lists
 * everything waiting on her.)
 *
 * Written through the same functions the API calls, never raw SQL, so a rule
 * change either keeps being satisfied or fails loudly here.
 */

import { agreementFor, agreementById, saveAgreement, saveCondition, signAgreement,
         subjectByKey, CONDITION_CATEGORIES } from "../db/northwood.mjs";
import { CONDITION_TEMPLATES, DEFAULT_VIOLATION_TEXT } from "../templates.mjs";

const SUBJECT = "cust-2298";
const OFFICER = "R. Alvarez";

/* Which template clauses this agreement actually carries. Not every clause in
   every category — a real agreement is a selection, and one that includes
   everything reads like boilerplate nobody chose. */
const USE = {
  reporting:     [0, 1, 2],
  residence:     [0, 1, 2],
  employment:    [0, 1],
  travel:        [0, 2],
  conduct:       [0, 1, 2],
  substance:     [0, 1],
  weapons:       [0],
  programs:      [0],
  financial:     [0],
  monitoring:    [0],
  documentation: [0]
};

export function seedAgreement() {
  const subject = subjectByKey(SUBJECT);
  if (!subject) return;
  if (agreementFor(SUBJECT)) return;              // never touch an existing one

  const created = saveAgreement({
    subject_id: SUBJECT,
    kind: "probation",
    supervision_level: "standard",
    start_date: "2026-03-28",
    end_date: "2028-03-27",
    office: "Northwood Corrections — Ogden",
    officer_name: OFFICER,
    violation_text: DEFAULT_VIOLATION_TEXT
  });

  let order = 0;
  for (const [category] of CONDITION_CATEGORIES) {
    for (const i of USE[category] ?? []) {
      const t = CONDITION_TEMPLATES[category]?.[i];
      if (!t) continue;
      saveCondition({ agreement_id: created.id, category, body: t.body,
                      sort_order: order++ });
    }
  }

  /* Signed, then activated — in that order, because activating a document
     nobody has signed is refused, and being refused mid-demo is exactly what
     this seed exists to prevent. */
  signAgreement(created.id, "officer", OFFICER);
  saveAgreement({ id: created.id, status: "active" });

  const done = agreementById(created.id);
  if (!done.officer_signed_at || done.status !== "active")
    console.error("  [seed] supervision agreement is not signed and issued — the "
                + "demo will open on a draft nobody can see");
  else if (done.subject_signed_at)
    console.error("  [seed] supervision agreement is already acknowledged — the "
                + "subject has nothing to do in the app");
  else
    console.log(`  Agreement         ${done.conditions.length} conditions, signed `
              + `and issued — awaiting Marcus's acknowledgment`);
}
