#!/usr/bin/env node
/* Additive identity migration checks. */
import "./test-isolate.mjs";
import "./db/schema.mjs";
import { db } from "./db/connect.mjs";
import { setStepDone } from "./db/goals.mjs";

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) { pass++; console.log(`  ✓ ${message}`); }
  else { fail++; console.error(`  ✕ ${message}`); }
};

const columns = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name));
const steps = columns("goal_steps");
const actions = columns("subject_action_items");

ok(steps.has("done_by_subject_id"), "goal steps have a subject completion ID");
ok(steps.has("done_by_officer_id"), "goal steps have an officer completion ID");
ok(actions.has("assigned_subject_id"), "standalone actions have an assigned subject ID");
ok(actions.has("assigned_officer_id"), "standalone actions have an assigned officer ID");
ok(actions.has("done_by_subject_id"), "standalone actions have a subject completion ID");
ok(actions.has("done_by_officer_id"), "standalone actions have an officer completion ID");
ok(actions.has("decided_by_officer_id"), "standalone actions have an officer decision ID");

db.prepare(`INSERT INTO subjects (subject_id, case_number, first_name, last_name, created_at) VALUES (?, ?, ?, ?, datetime('now'))`)
  .run("cust-identity", "CASE-IDENTITY", "Identity", "Test");
db.prepare(`INSERT INTO officers (name, email, active, created_at) VALUES (?, ?, 1, datetime('now'))`)
  .run("Officer Test", "identity@example.test");
const officer = db.prepare(`SELECT id FROM officers WHERE email = ?`).get("identity@example.test");
db.prepare(`INSERT INTO goals (subject_id, title, created_at) VALUES (?, ?, datetime('now'))`)
  .run("cust-identity", "Identity goal");
const goal = db.prepare(`SELECT id FROM goals WHERE subject_id = ?`).get("cust-identity");
db.prepare(`INSERT INTO goal_steps (goal_id, body, created_at) VALUES (?, ?, datetime('now'))`)
  .run(goal.id, "Identity step");
const step = db.prepare(`SELECT id FROM goal_steps WHERE goal_id = ?`).get(goal.id);
setStepDone(step.id, true, "Officer Test", { officer_id: officer.id });
const saved = db.prepare(`SELECT done_by, done_by_officer_id FROM goal_steps WHERE id = ?`).get(step.id);
ok(saved.done_by_officer_id === officer.id, "officer completion stores the officer ID");

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
