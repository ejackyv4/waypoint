/**
 * The reentry plan template: twenty-one areas of a person's life that have to
 * be arranged before release, and the checkpoints that make each one real.
 *
 * Two decisions worth defending:
 *
 * 1. **Areas carry a description, items carry the work.** "Housing" as a
 *    single tick answers nothing — a residence is identified, then approved
 *    for supervision, then moved into, and those are three different days.
 *    An area that cannot be broken into checkpoints does not belong here.
 *
 *    The corollary is that two checkpoints must be two different days. The
 *    first draft had both "Residence identified" and "Address verified",
 *    which are one fact wearing two labels — the address IS the
 *    identification, and it lives in the item's detail.
 *
 * 2. **`critical` lives in the template, not in the row.** A critical item is
 *    one that gates release, and that is policy, not a per-case judgement an
 *    officer makes on a Tuesday. Copying it onto the item at creation means a
 *    plan keeps the rules it was issued under even if the template changes
 *    later — the same reason a course version is immutable once somebody has
 *    started it.
 *
 * Nothing here is a legal instrument; it is a working template. Real policy
 * would replace this file.
 */

export const REENTRY_AREAS = [
  ["housing", "Housing",
   "Confirmed place to live; address; move-in date; household and contact "
   + "information; housing meets supervision requirements."],
  ["identification", "Identification",
   "State ID or driver's licence, Social Security card, birth certificate, or "
   + "a documented plan to obtain anything missing."],
  ["supervision", "Supervision",
   "Probation or parole officer identified; reporting location; first reporting "
   + "date; conditions understood."],
  ["transportation", "Transportation",
   "Reliable way to get home and to supervision, work, treatment and "
   + "appointments; public transit plan where applicable."],
  ["employment", "Employment",
   "Job secured, job leads established, or an employment-search plan; resume "
   + "and application readiness."],
  ["education", "Education & Training",
   "School, GED, vocational training, certification or other educational plan "
   + "established where needed."],
  ["healthcare", "Healthcare",
   "Medical provider identified; immediate appointments scheduled; continuity "
   + "of care and prescriptions addressed."],
  ["behavioral", "Behavioral Health",
   "Required counselling or treatment provider identified; appointments "
   + "scheduled; continuity of services established."],
  ["substance", "Substance Use Treatment",
   "Treatment requirements identified; provider and enrolment established; "
   + "recovery and support resources identified."],
  ["benefits", "Benefits & Insurance",
   "Medicaid or insurance, SNAP, Social Security, veterans benefits or other "
   + "eligible benefits applied for or activated."],
  ["financial", "Financial Readiness",
   "Immediate financial needs addressed; banking and payment access; fines, "
   + "restitution, fees or support obligations understood."],
  ["family", "Family & Support Network",
   "Positive support contacts identified; family reunification considerations "
   + "addressed; mentor, peer or community support available."],
  ["programs", "Required Programs",
   "Court-, parole- or case-plan-required programming identified with enrolment "
   + "or continuation arrangements."],
  ["legal", "Legal Obligations",
   "Outstanding court dates, warrants, registration requirements, restrictions "
   + "and other legal obligations understood."],
  ["documents", "Documents & Records",
   "Important records available — identity documents, certificates, education "
   + "records, medical information, programme completion records."],
  ["communication", "Communication",
   "Access to a phone or email and the ability to reach the supervising "
   + "officer, employers, providers and support network."],
  ["basic_needs", "Basic Needs",
   "Clothing, food, hygiene supplies, immediate medications and other "
   + "necessities available upon release."],
  ["community", "Community Resources",
   "Appropriate providers and community services identified with contact "
   + "information and referrals where necessary."],
  ["release_day", "Release-Day Plan",
   "Release date and time, transport from the facility, destination, who is "
   + "meeting the person, medications, documents and property provided."],
  ["first_72", "First 72 Hours",
   "Critical actions immediately after release clearly identified and "
   + "prioritised."],
  ["first_30", "First 30 Days",
   "Initial appointments, reporting requirements, employment activities, "
   + "treatment, benefits and other major milestones scheduled."]
];

/* [area, label, critical] — critical items gate release. */
export const REENTRY_TEMPLATE = [
  // "Residence identified" and "Address verified" were the same fact wearing
  // two labels — the address IS the identification, and it sits in the item's
  // detail. What is left is three genuinely different days: a place is named,
  // supervision approves it, the person moves in.
  ["housing", "Residence identified", 1],
  ["housing", "Residence approved for supervision", 1],
  ["housing", "Move-in confirmed", 1],
  ["housing", "Household members and contact details recorded", 0],

  ["identification", "Birth certificate", 1],
  ["identification", "Social Security card", 1],
  ["identification", "State ID", 1],
  ["identification", "Driver's licence, if applicable", 0],

  ["supervision", "Supervising office identified", 1],
  ["supervision", "Conditions reviewed with the subject", 1],
  ["supervision", "First reporting appointment scheduled", 1],
  ["supervision", "Transportation to first appointment confirmed", 1],

  ["transportation", "Transport from the facility arranged", 1],
  ["transportation", "Routine travel to supervision and appointments", 0],
  ["transportation", "Public transit plan or fare assistance", 0],

  ["employment", "Employment status determined", 0],
  ["employment", "Job secured or leads established", 0],
  ["employment", "Resume and applications ready", 0],

  ["education", "Education or training need assessed", 0],
  ["education", "Programme identified and enrolment arranged", 0],

  ["healthcare", "Primary care provider identified", 1],
  ["healthcare", "Medication supply arranged", 1],
  ["healthcare", "Initial appointment scheduled", 0],
  ["healthcare", "Continuity of care records transferred", 0],

  ["behavioral", "Behavioral health need assessed", 0],
  ["behavioral", "Provider identified", 0],
  ["behavioral", "First appointment scheduled", 0],

  ["substance", "Treatment requirement identified", 0],
  ["substance", "Provider and enrolment established", 0],
  ["substance", "Recovery support resources identified", 0],

  ["benefits", "Benefit eligibility reviewed", 0],
  ["benefits", "Medicaid or insurance activated", 1],
  ["benefits", "Other benefits applied for", 0],

  ["financial", "Immediate financial needs addressed", 0],
  ["financial", "Banking or payment access arranged", 0],
  ["financial", "Fines, restitution and fees understood", 0],

  ["family", "Support contacts identified", 0],
  ["family", "Reunification considerations addressed", 0],
  ["family", "Mentor, peer or community support available", 0],

  ["programs", "Required programming identified", 1],
  ["programs", "Enrolment or continuation arranged", 1],

  ["legal", "Outstanding court dates and obligations reviewed", 1],
  ["legal", "Warrants and holds resolved or documented", 1],
  ["legal", "Registration requirements understood", 0],

  ["documents", "Identity documents in the subject's possession", 1],
  ["documents", "Education and programme records available", 0],
  ["documents", "Medical information available", 0],

  ["communication", "Phone or email access arranged", 1],
  ["communication", "Contact details shared with the supervising officer", 1],

  ["basic_needs", "Clothing available on release", 1],
  ["basic_needs", "Food and hygiene supplies for the first week", 1],
  ["basic_needs", "Immediate medications in hand", 1],

  ["community", "Local providers and services identified", 0],
  ["community", "Referrals made where necessary", 0],

  ["release_day", "Release date and time confirmed", 1],
  ["release_day", "Destination confirmed", 1],
  ["release_day", "Person meeting them identified", 0],
  ["release_day", "Property, medications and documents released", 1],

  ["first_72", "Critical first-72-hour actions listed and prioritised", 1],
  ["first_72", "Reviewed with the subject", 1],

  ["first_30", "First-30-day appointments and milestones scheduled", 0],
  ["first_30", "Reviewed with the subject", 0]
];

/**
 * What a checkpoint can be.
 *
 * `not_applicable` is not a lesser form of incomplete — requirements vary
 * enormously between people. Someone may need no substance-use treatment;
 * employment may be inappropriate for someone on disability. Counting those
 * against a readiness score would make the score dishonest, so an N/A item
 * leaves the calculation entirely.
 *
 * `exception` is the other half of that principle: not complete must never
 * automatically mean cannot release. A real obstacle is carried by a
 * documented mitigation and a named approver, not by pretending it is done.
 */
export const REENTRY_STATUSES = [
  ["not_started",    "Not started"],
  ["in_progress",    "In progress"],
  ["ready",          "Verified / Ready"],
  ["not_applicable", "Not applicable"],
  ["exception",      "Exception approved"]
];
