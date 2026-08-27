#!/usr/bin/env node
/**
 * The sweeper closes sessions that never said goodbye.
 *
 * Runs in-process against the real database rather than over HTTP, because
 * the thing under test is a background job, not an endpoint.
 *
 *   node spike/api/test-sweeper.mjs
 */
import { openRegistration, updateRegistration, registration, upsertPerson,
         upsertProgram, latestVersion, idleRegistrations, now, db } from "./db/waypoint.mjs";
import { DB_PATH } from "./db/connect.mjs";
import { sweepIdleSessions } from "./sweeper.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${m}`))
                        : (fail++, console.log(`  \x1b[31m✕\x1b[0m ${m}`)));

console.log("\n\x1b[1mSession sweeper\x1b[0m\n");

/* Guard the path itself. Moving connect.mjs one directory deeper silently
   relocated the database, and `./spike/demo reset` then deleted an empty
   directory and reported success — stale data survived every "clean slate"
   for two hours. The tooling assumes spike/data; assert it. */
ok(DB_PATH.endsWith("/spike/data/waypoint.db"),
   `\x1b[1mthe database is at spike/data, where the tooling expects it\x1b[0m`
   + (DB_PATH.endsWith("/spike/data/waypoint.db") ? "" : ` — found ${DB_PATH}`));

const person  = upsertPerson({ subject_id: "sweep-" + Date.now() });
const program = upsertProgram({ program_id: "golf-101", title: "Golf Explained" });
const cv = latestVersion(program.id);
if (!cv) { console.log("  — skipped: no content ingested\n"); process.exit(0); }

/* A session opened, written to, then abandoned — the phone-killed case. */
const stale = openRegistration({ person_id: person.id, content_version_id: cv.id });
updateRegistration(stale.id, {
  location: "page-4", suspend_data: "lesson=4;score=60",
  completion_status: "incomplete"
});
/* Backdate directly: updateRegistration always stamps last_write_at = now(),
   which is correct behaviour and exactly why it cannot be used to fake age. */
const long_ago = new Date(Date.now() - 90 * 60 * 1000).toISOString();
db.prepare(`UPDATE registrations SET started_at = ?, last_write_at = ? WHERE id = ?`)
  .run(long_ago, long_ago, stale.id);

/* A second one, active seconds ago. It must be left alone. */
const fresh = upsertPerson({ subject_id: "fresh-" + Date.now() });
const live = openRegistration({ person_id: fresh.id, content_version_id: cv.id });
updateRegistration(live.id, { started_at: now(), location: "page-1" });

ok(idleRegistrations(new Date(Date.now() - 30 * 60 * 1000).toISOString())
     .some(r => r.id === stale.id),
   "a session silent for 90 minutes is found");

const before = registration(stale.id);
await sweepIdleSessions(30 * 60 * 1000);
const after = registration(stale.id);

ok(after.terminated_at !== null,
   "\x1b[1mthe server closes a session the course never terminated\x1b[0m");
ok(registration(live.id).terminated_at === null,
   "a session that is still being written to is left open");

/* The most important property: closing must not alter what the learner did. */
ok(after.location === before.location && after.suspend_data === before.suspend_data
   && after.completion_status === before.completion_status
   && after.total_seconds === before.total_seconds,
   "\x1b[1mit keeps whatever the last Commit gave us — bookmark, suspend_data, status\x1b[0m");

/* Idempotence: the sweeper runs every minute forever. */
const closedAt = after.terminated_at;
await sweepIdleSessions(30 * 60 * 1000);
ok(registration(stale.id).terminated_at === closedAt,
   "sweeping again does not re-close or re-stamp it");

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
