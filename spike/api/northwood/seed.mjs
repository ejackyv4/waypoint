/**
 * Northwood Corrections — the demo roster.
 *
 * A real deployment imports its roster from the case-management system; the
 * demo needs one to exist. Staff passwords are Northwood's own; SUBJECT logins
 * are not — those belong to Waypoint and are provisioned over its API once the
 * servers are listening, because Northwood is a customer and has no other way
 * in. It used to write straight into Waypoint's tables, which meant the first
 * thing the demo did was skip the integration it exists to prove.
 */

import { seedRoster, seedOffices, officerByEmail, setOfficerPassword,
         subjectByKey, activeOffices, setOfficerOffice } from "../db/northwood.mjs";
import { hashPassword } from "../auth.mjs";
import { waypoint } from "./shared.mjs";
import { seedCaseFile } from "./seed-case.mjs";
import { seedAgreement } from "./seed-agreement.mjs";
import { seedReentryPlan } from "./seed-reentry.mjs";
import { seedSchedule } from "./seed-schedule.mjs";

const seeded = seedRoster(
  [ { name: "R. Alvarez",  email: "r.alvarez@northwood.gov",  badge: "NC-114" },
    { name: "T. Nakamura", email: "t.nakamura@northwood.gov", badge: "NC-207" } ],
  [ { subject_id: "cust-1041", case_number: "NC-2026-0418",
      first_name: "Dana", last_name: "Whitfield", dob: "1991-04-17",
      phone: "(801) 555-0142", email: "cust-1041@example.com",
      /* Real, for the same reason as Marcus's below: the route planner
         geocodes these, and an invented street is silently dropped from the
         route — which reads as the feature failing rather than the data. */
      address_line1: "1665 W 3500 S", address_line2: "Apt 3B",
      city: "West Valley City", state: "UT", postal_code: "84119",
      status: "Active supervision", officer: "R. Alvarez",
      intake_date: "2026-02-03", next_review: "2026-09-15" },
    { subject_id: "cust-2298", case_number: "NC-2026-0511",
      first_name: "Marcus", last_name: "Oyelaran", dob: "1986-11-02",
      phone: "(801) 555-0197", email: "cust-2298@example.com",
      /* A REAL address, because the route planner geocodes it. An invented
         street returns nothing from Nominatim, the stop is dropped from the
         route, and the feature looks broken when it is the data that is. */
      address_line1: "194 25th St",
      city: "Ogden", state: "UT", postal_code: "84401",
      /* Both subjects on one officer: the demo signs in as Alvarez, and a
         caseload of one makes half the product invisible — no route to plan,
         no second person on the dashboard, nothing to compare. Moving Marcus
         to Nakamura is then a live demonstration of the transfer rather than
         a precondition. */
      status: "Probation — Level 2", officer: "R. Alvarez",
      intake_date: "2026-03-28", next_review: "2026-10-12" } ]
);

/* Demo passwords, set once on an empty database. A real deployment invites
   staff and provisions subjects individually; the demo needs logins that
   survive a reset, because a demo credential that changes every time the
   database is rebuilt is a credential nobody can write down. */
const DEMO_PASSWORD = "northwood";

/* Staff are Northwood's own — its table, its passwords. */
if (seeded) {
  for (const email of ["r.alvarez@northwood.gov", "t.nakamura@northwood.gov"]) {
    const o = officerByEmail(email);
    if (o) setOfficerPassword(o.id, hashPassword(DEMO_PASSWORD), 0);
  }
  console.log(`  Staff login       r.alvarez@northwood.gov / ${DEMO_PASSWORD}`);
}

/**
 * Give the seeded subjects a Waypoint login, over the API.
 *
 * This used to write to Waypoint's `people` and `credentials` tables directly,
 * which quietly made the two systems one — and meant the very first thing the
 * demo did was skip the integration it exists to prove. Splitting the file
 * surfaced it: `upsertPerson` is not importable here any more.
 *
 * Runs after the servers are listening, because it speaks HTTP like any
 * integrator would. `/api/users` will not overwrite a password that already
 * exists, so this is safe to call on every start.
 */
/**
 * Provision the demo subjects' Waypoint logins, and keep their names right.
 *
 * Runs on EVERY boot, not only on a fresh roster. It used to be gated behind
 * the roster seed, which meant a name written wrong once stayed wrong forever:
 * cust-2298 carried "Dana Whitfield" for days, so the subject's own app showed
 * somebody else's name and `done_by` recorded the wrong person on an
 * evidentiary row.
 *
 * Safe to repeat. The upsert refreshes the name, and Waypoint only sets a
 * password when there is none or the caller explicitly asks — the rule that
 * exists because assigning a second program used to rotate a live password.
 */
export async function seedSubjectLogins() {
  for (const sub of ["cust-1041", "cust-2298"]) {
    const row = subjectByKey(sub);
    if (!row) continue;
    const r = await waypoint("/api/users", { method: "POST", body: JSON.stringify({
      subject_id: sub, name: row.name, email: `${sub}@example.com`,
      password: DEMO_PASSWORD
    }) }).catch(e => ({ status: 0, body: { error: e.message } }));
    if (r.status !== 200)
      console.error(`  [seed] could not provision ${sub}:`, r.body?.error);
  }
  console.log(`  Subject login     cust-2298@example.com / ${DEMO_PASSWORD}`);

  /* Assigning a course happens in ./spike/demo, not here: this runs the moment
     the server is listening, and content is not ingested until afterwards. */
}

seedOffices([
  { name: "Northwood Corrections — Salt Lake", address: "220 Center St, Salt Lake City, UT 84111",
    phone: "(801) 555-0100" },
  { name: "Northwood Corrections — Ogden", address: "18 Washington Blvd, Ogden, UT 84401",
    phone: "(801) 555-0180" },
  { name: "Northwood Corrections — Regional Office", address: "1 Statehouse Plaza, Salt Lake City, UT 84114",
    phone: "(385) 555-0140" }
]);

/* Marcus's case, ready to demo: modules populated, an agreement awaiting his
   acknowledgment, a reentry plan two of his signatures short, a visit
   tomorrow and appointments across the week.

   Dana is left bare on purpose. Every module has an empty state and a Create
   flow, and a demo that can only show populated screens cannot show either. */
if (seeded) {
  seedCaseFile();
  seedAgreement();
  seedReentryPlan();
  seedSchedule();
}

/* Each officer works out of an office, which is where their day starts. The
   route planner needs an origin, and "the first office in the list" is a
   fallback, not an answer. */
if (seeded) {
  const offices = activeOffices();
  const find = frag => offices.find(o => o.name.includes(frag));
  for (const [email, frag] of [["r.alvarez@northwood.gov", "Salt Lake"],
                               ["t.nakamura@northwood.gov", "Ogden"]]) {
    const o = officerByEmail(email), office = find(frag);
    if (o && office) setOfficerOffice(o.id, office.id);
  }
}
