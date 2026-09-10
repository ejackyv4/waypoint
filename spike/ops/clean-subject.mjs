#!/usr/bin/env node
/**
 * Remove a subject's demo/case activity while keeping the subject identity.
 *
 * This is deliberately an allow-list of subject-owned tables.  Catalog data,
 * staff, the subject row, and the subject's login are never touched.
 */
import { DatabaseSync } from "node:sqlite";

const [dbPath, subjectId = "cust-1041"] = process.argv.slice(2);
if (!dbPath) {
  console.error("usage: clean-subject.mjs DATABASE [SUBJECT_ID]");
  process.exit(2);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
const tableSet = new Set(db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
).all().map(row => row.name));
const has = name => tableSet.has(name);
const q = name => `\"${name.replaceAll('"', '""')}\"`;
const count = (sql, ...args) => Number(db.prepare(sql).get(...args)?.c ?? 0);
const deleted = [];
function del(table, where, ...args) {
  if (!has(table)) return;
  const result = db.prepare(`DELETE FROM ${q(table)} WHERE ${where}`).run(...args);
  if (result.changes) deleted.push(`${table}: ${result.changes}`);
}

if (!has("subjects") || !count("SELECT COUNT(*) c FROM subjects WHERE subject_id = ?", subjectId)) {
  console.error(`subject not found: ${subjectId}`);
  process.exit(1);
}

// Capture relationship keys before deleting their parents.
db.exec("DROP TABLE IF EXISTS temp._clean_people; DROP TABLE IF EXISTS temp._clean_regs; DROP TABLE IF EXISTS temp._clean_visits; DROP TABLE IF EXISTS temp._clean_agreements; DROP TABLE IF EXISTS temp._clean_plans; DROP TABLE IF EXISTS temp._clean_goals; DROP TABLE IF EXISTS temp._clean_financial; DROP TABLE IF EXISTS temp._clean_analysis;");
db.exec("CREATE TEMP TABLE _clean_people (id INTEGER PRIMARY KEY)");
db.exec("CREATE TEMP TABLE _clean_regs (id INTEGER PRIMARY KEY)");
db.exec("CREATE TEMP TABLE _clean_visits (id INTEGER PRIMARY KEY)");
db.exec("CREATE TEMP TABLE _clean_agreements (id INTEGER PRIMARY KEY)");
db.exec("CREATE TEMP TABLE _clean_plans (id INTEGER PRIMARY KEY)");
db.exec("CREATE TEMP TABLE _clean_goals (id INTEGER PRIMARY KEY)");
db.exec("CREATE TEMP TABLE _clean_financial (id INTEGER PRIMARY KEY)");
db.exec("CREATE TEMP TABLE _clean_analysis (id INTEGER PRIMARY KEY)");
if (has("people")) db.prepare("INSERT INTO _clean_people SELECT id FROM people WHERE subject_id = ?").run(subjectId);
if (has("registrations")) db.exec("INSERT INTO _clean_regs SELECT r.id FROM registrations r JOIN _clean_people p ON p.id=r.person_id");
if (has("visits")) db.prepare("INSERT INTO _clean_visits SELECT id FROM visits WHERE subject_id = ?").run(subjectId);
if (has("agreements")) db.prepare("INSERT INTO _clean_agreements SELECT id FROM agreements WHERE subject_id = ?").run(subjectId);
if (has("reentry_plans")) db.prepare("INSERT INTO _clean_plans SELECT id FROM reentry_plans WHERE subject_id = ?").run(subjectId);
if (has("goals")) db.prepare("INSERT INTO _clean_goals SELECT id FROM goals WHERE subject_id = ?").run(subjectId);
if (has("financial_items")) db.prepare("INSERT INTO _clean_financial SELECT id FROM financial_items WHERE subject_id = ?").run(subjectId);
if (has("program_analysis_jobs")) db.exec("INSERT INTO _clean_analysis SELECT id FROM program_analysis_jobs WHERE registration_id IN (SELECT id FROM _clean_regs)");

db.exec("BEGIN IMMEDIATE");
try {
  // LMS runtime, attempts, survey evidence, and generated analysis.
  del("program_analysis_comparisons", "current_analysis_id IN (SELECT id FROM _clean_analysis) OR previous_analysis_id IN (SELECT id FROM _clean_analysis)");
  del("program_analysis_reviews", "analysis_id IN (SELECT id FROM _clean_analysis)");
  del("program_analysis_jobs", "registration_id IN (SELECT id FROM _clean_regs)");
  for (const t of ["launch_tickets", "webhook_deliveries", "xapi_statements", "xapi_state"]) del(t, "registration_id IN (SELECT id FROM _clean_regs)");
  del("registrations", "person_id IN (SELECT id FROM _clean_people)");
  del("assignments", "person_id IN (SELECT id FROM _clean_people)");
  del("learner_sessions", "person_id IN (SELECT id FROM _clean_people)");
  del("saas_inbox", "subject_id = ?", subjectId);

  // Visit evidence and appointments.
  for (const t of ["visit_agenda", "visit_notes", "visit_photos", "visit_recordings", "visit_transcripts", "visit_summaries", "visit_summary_actions"]) del(t, "visit_id IN (SELECT id FROM _clean_visits)");
  del("visits", "subject_id = ?", subjectId);

  // Agreements, plans, goals, obligations, and money.
  del("agreement_acknowledgments", "agreement_id IN (SELECT id FROM _clean_agreements)");
  del("agreement_conditions", "agreement_id IN (SELECT id FROM _clean_agreements)");
  del("agreements", "subject_id = ?", subjectId);
  del("reentry_acknowledgments", "plan_id IN (SELECT id FROM _clean_plans)");
  del("reentry_events", "plan_id IN (SELECT id FROM _clean_plans)");
  del("reentry_items", "plan_id IN (SELECT id FROM _clean_plans)");
  del("reentry_plans", "subject_id = ?", subjectId);
  del("goal_steps", "goal_id IN (SELECT id FROM _clean_goals)");
  del("goals", "subject_id = ?", subjectId);
  del("financial_payments", "item_id IN (SELECT id FROM _clean_financial)");
  del("financial_items", "subject_id = ?", subjectId);
  del("obligations", "subject_id = ?", subjectId);

  // Northwood profile modules and documents. The subjects row, people row,
  // credentials, and officer/case roster are intentionally preserved.
  for (const t of ["subject_vehicles", "subject_contacts", "case_notes", "curfews", "documents", "travel_permits", "employment", "important_dates"]) del(t, "subject_id = ?", subjectId);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

console.log(`cleaned ${subjectId}; subject profile and login preserved`);
if (deleted.length) console.log(deleted.join("\n"));
