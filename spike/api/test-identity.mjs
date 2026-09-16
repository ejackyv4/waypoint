#!/usr/bin/env node
/* Additive identity migration checks. */
import "./test-isolate.mjs";
import "./db/schema.mjs";
import { db } from "./db/connect.mjs";

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

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
