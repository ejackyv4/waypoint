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
         subjectByKey } from "../db/northwood.mjs";
import { hashPassword } from "../auth.mjs";
import { waypoint } from "./shared.mjs";

const seeded = seedRoster(
  [ { name: "R. Alvarez",  email: "r.alvarez@northwood.gov",  badge: "NC-114" },
    { name: "T. Nakamura", email: "t.nakamura@northwood.gov", badge: "NC-207" } ],
  [ { subject_id: "cust-1041", case_number: "NC-2026-0418",
      first_name: "Dana", last_name: "Whitfield", dob: "1991-04-17",
      phone: "(423) 555-0142", email: "cust-1041@example.com", address_line1: "412 Ridgeway Ave, Apt 3B",
      city: "Kingsport", state: "TN", postal_code: "37660",
      status: "Active supervision", officer: "R. Alvarez",
      intake_date: "2026-02-03", next_review: "2026-09-15" },
    { subject_id: "cust-2298", case_number: "NC-2026-0511",
      first_name: "Marcus", last_name: "Oyelaran", dob: "1986-11-02",
      phone: "(423) 555-0197", email: "cust-2298@example.com", address_line1: "77 Beechmont Rd",
      city: "Bristol", state: "TN", postal_code: "37620",
      status: "Probation — Level 2", officer: "T. Nakamura",
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
export async function seedSubjectLogins() {
  if (!seeded) return;
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
  console.log(`  Subject login     cust-1041@example.com / ${DEMO_PASSWORD}`);
}

seedOffices([
  { name: "Northwood Corrections — Kingsport", address: "220 Center St, Kingsport, TN 37660",
    phone: "(423) 555-0100" },
  { name: "Northwood Corrections — Bristol", address: "18 Volunteer Pkwy, Bristol, TN 37620",
    phone: "(423) 555-0180" },
  { name: "Northwood Corrections — Regional Office", address: "1 Statehouse Plaza, Nashville, TN 37243",
    phone: "(615) 555-0140" }
]);
