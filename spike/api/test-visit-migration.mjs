/* The scheduled_at relaxation rebuilds visits on older databases. This test
   proves that rebuild preserves conduct data and existing child rows. */
import "./test-isolate.mjs";

const { db } = await import("./db/connect.mjs");
db.exec(`
  CREATE TABLE officers (id INTEGER PRIMARY KEY, name TEXT);
  INSERT INTO officers VALUES (7, 'R. Alvarez');
  CREATE TABLE visits (
    id INTEGER PRIMARY KEY, subject_id TEXT NOT NULL, scheduled_at TEXT NOT NULL,
    officer TEXT, location TEXT, notes TEXT, status TEXT NOT NULL,
    seen_at TEXT, accepted_at TEXT, completed_at TEXT, completed_by TEXT,
    created_at TEXT NOT NULL, officer_id INTEGER,
    started_at TEXT, ended_at TEXT, location_safe TEXT, contraband TEXT,
    contraband_detail TEXT, demeanour TEXT, others_present TEXT,
    subject_present TEXT, concerns TEXT, legacy_field TEXT
  );
  CREATE TABLE visit_notes (
    id INTEGER PRIMARY KEY, visit_id INTEGER REFERENCES visits(id),
    body TEXT NOT NULL, created_at TEXT NOT NULL
  );
  INSERT INTO visits
    (id, subject_id, scheduled_at, officer, status, created_at, started_at,
     location_safe, concerns, legacy_field)
    VALUES (12, 'cust-test', '2026-09-20T10:00:00.000Z', 'R. Alvarez',
            'completed', '2026-09-01T00:00:00.000Z',
            '2026-09-20T10:01:00.000Z', 'concerns', 'Keep the gate locked', 'preserve me');
  INSERT INTO visit_notes (id, visit_id, body, created_at)
    VALUES (44, 12, 'Observed the gate.', '2026-09-20T10:05:00.000Z');
`);

await import("./db/schema.mjs");
const visit = db.prepare("SELECT * FROM visits WHERE id = 12").get();
const note = db.prepare("SELECT * FROM visit_notes WHERE id = 44").get();
const columns = new Set(db.prepare("PRAGMA table_info(visits)").all().map(c => c.name));
const checks = [
  [visit.scheduled_at === "2026-09-20T10:00:00.000Z", "scheduled date survives and is nullable"],
  [visit.started_at && visit.location_safe === "concerns" && visit.concerns === "Keep the gate locked", "conduct observations survive"],
  [visit.legacy_field === "preserve me", "unknown legacy columns survive"],
  [columns.has("ended_at") && columns.has("contraband_detail"), "new visit fields exist after migration"],
  [note?.body === "Observed the gate.", "child visit notes survive"],
];
let failed = 0;
for (const [good, label] of checks) {
  console.log(`${good ? "  ✓" : "  ✕"} ${label}`);
  if (!good) failed++;
}
if (failed) process.exitCode = 1;
