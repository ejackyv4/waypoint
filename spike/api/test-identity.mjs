#!/usr/bin/env node
/* Additive identity migration checks. */
import "./test-isolate.mjs";
import "./db/schema.mjs";
import { db } from "./db/connect.mjs";
import { setStepDone, saveGoal, completeGoal } from "./db/goals.mjs";
import { addStandaloneAction, completeAction, decideAction } from "./db/insights.mjs";
import { startVisit, completeVisit } from "./db/northwood.mjs";

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

const created = addStandaloneAction("cust-identity", { body: "Identity action", owner: "officer", assigned_officer_id: officer.id });
ok(created.ok, "standalone action accepts a validated officer assignment");
const action = db.prepare(`SELECT * FROM subject_action_items WHERE subject_id = ? ORDER BY id DESC LIMIT 1`).get("cust-identity");
ok(action.assigned_officer_id === officer.id && action.assigned_subject_id === null,
   "standalone action stores the assigned officer ID only");
const subjectAction = addStandaloneAction("cust-identity", { body: "Subject action", owner: "subject" });
const subjectRow = db.prepare(`SELECT * FROM subject_action_items WHERE id = last_insert_rowid()`).get();
completeAction(`standalone-${subjectRow.id}`, "Identity Test", { subject_id: "cust-identity" });
const completed = db.prepare(`SELECT done_by_subject_id FROM subject_action_items WHERE id = ?`).get(subjectRow.id);
ok(completed.done_by_subject_id === "cust-identity", "subject completion stores the subject ID");
decideAction(`standalone-${action.id}`, "done", "Officer Test", { officer_id: officer.id });
const decided = db.prepare(`SELECT decided_by_officer_id, done_by_officer_id FROM subject_action_items WHERE id = ?`).get(action.id);
ok(decided.decided_by_officer_id === officer.id && decided.done_by_officer_id === officer.id,
   "officer decision and completion store the officer ID");

const createdGoal = saveGoal({ subject_id: "cust-identity", title: "Created identity goal" }, "Officer Test", { officer_id: officer.id });
const createdGoalRow = db.prepare(`SELECT created_by_officer_id FROM goals WHERE id = ?`).get(createdGoal.id);
ok(createdGoalRow.created_by_officer_id === officer.id, "goal creation stores the officer ID");
const completedGoal = completeGoal(createdGoal.id, "Officer Test", true, { officer_id: officer.id });
const completedGoalRow = db.prepare(`SELECT completed_by_officer_id FROM goals WHERE id = ?`).get(createdGoal.id);
ok(completedGoal.ok && completedGoalRow.completed_by_officer_id === officer.id,
   "goal completion stores the officer ID");

db.prepare(`INSERT INTO visits (subject_id, scheduled_at, status, created_at) VALUES (?, ?, 'scheduled', datetime('now'))`)
  .run("cust-identity", "2026-09-16T10:00:00.000Z");
const visit = db.prepare(`SELECT id FROM visits WHERE subject_id = ? ORDER BY id DESC LIMIT 1`).get("cust-identity");
startVisit(visit.id, "Officer Test", { officer_id: officer.id });
completeVisit(visit.id, "Officer Test", null, { officer_id: officer.id });
const visitAudit = db.prepare(`SELECT started_by_officer_id, completed_by_officer_id FROM visits WHERE id = ?`).get(visit.id);
ok(visitAudit.started_by_officer_id === officer.id && visitAudit.completed_by_officer_id === officer.id,
   "visit start and completion store the officer ID");

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
