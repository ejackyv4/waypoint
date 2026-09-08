/* Persistent Phase 2 analysis jobs. Northwood owns the workflow; evidence is
   fetched from Waypoint over HTTP and stored as an immutable snapshot. */
import { one, all, run, now } from "./connect.mjs";
import "./schema.mjs";

export const analysisJob = id => one(`SELECT * FROM program_analysis_jobs WHERE id = ?`, id);
export const analysisJobsFor = registration_id => all(
  `SELECT * FROM program_analysis_jobs WHERE registration_id = ? ORDER BY id DESC`, registration_id);
export function createAnalysisJob({ registration_id, evidence, requested_by = null,
                                    model = null, prompt_version = "phase2-v1" }) {
  run(`INSERT INTO program_analysis_jobs
       (registration_id, evidence_json, requested_by, model, prompt_version, created_at)
       VALUES (?,?,?,?,?,?)`, registration_id, JSON.stringify(evidence), requested_by,
      model, prompt_version, now());
  return one(`SELECT * FROM program_analysis_jobs WHERE id = last_insert_rowid()`);
}
export const markAnalysisRunning = id => run(
  `UPDATE program_analysis_jobs SET status = 'running', started_at = ? WHERE id = ?`, now(), id);
export const finishAnalysisDraft = (id, result) => run(
  `UPDATE program_analysis_jobs SET status = 'draft', result_json = ?, completed_at = ? WHERE id = ?`,
  JSON.stringify(result), now(), id);
export const failAnalysis = (id, error) => run(
  `UPDATE program_analysis_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
  String(error || "analysis failed"), now(), id);
export const failStaleAnalysisJobs = () => run(
  `UPDATE program_analysis_jobs SET status = 'failed', error = ?, completed_at = ?
    WHERE status IN ('queued','running') AND started_at IS NOT NULL`,
  "The server restarted while this was running. Try again.", now());
export const analysisReview = analysis_id => one(
  `SELECT * FROM program_analysis_reviews WHERE analysis_id = ?`, analysis_id);
export function saveAnalysisReview({ analysis_id, disposition, notes, reviewed_by, document_id = null }) {
  run(`INSERT INTO program_analysis_reviews
       (analysis_id, disposition, notes, reviewed_by, reviewed_at, document_id)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(analysis_id) DO UPDATE SET disposition=excluded.disposition,
         notes=excluded.notes, reviewed_by=excluded.reviewed_by,
         reviewed_at=excluded.reviewed_at, document_id=excluded.document_id`,
      analysis_id, disposition, notes || null, reviewed_by, now(), document_id);
  return analysisReview(analysis_id);
}
export function createComparison({ current_analysis_id, previous_analysis_id, evidence }) {
  run(`INSERT INTO program_analysis_comparisons
       (current_analysis_id, previous_analysis_id, evidence_json, created_at)
       VALUES (?,?,?,?)`, current_analysis_id, previous_analysis_id, JSON.stringify(evidence), now());
  return one(`SELECT * FROM program_analysis_comparisons WHERE id = last_insert_rowid()`);
}
export const comparison = id => one(`SELECT * FROM program_analysis_comparisons WHERE id = ?`, id);
