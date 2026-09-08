/* Phase 2 proof-of-concept worker. The provider is selected entirely through
   configuration; this module never embeds a vendor name or credential. */
import { analysisJob, markAnalysisRunning, finishAnalysisDraft, failAnalysis } from "../db/program-analysis.mjs";
import { analyzeProgram } from "./ai.mjs";
import { LLM_READY } from "../config.mjs";
import { subjectByKey } from "../db/northwood.mjs";
const queue = [];
let working = false;
const formatEvidence = evidence => (evidence.responses || []).map((r, i) =>
  `Response ${i + 1}\nSection: ${r.section || "unknown"}\nLesson: ${r.lesson || "unknown"}\nQuestion: ${r.question}\nAnswer: ${typeof r.response === "object" ? JSON.stringify(r.response) : (r.response ?? "")}`
).join("\n\n");
async function drain() {
  if (working) return;
  working = true;
  while (queue.length) {
    const id = queue.shift(); markAnalysisRunning(id);
    try {
      if (!LLM_READY()) throw new Error("AI provider is not configured");
      const job = analysisJob(id), e = JSON.parse(job.evidence_json);
      const subject = subjectByKey(e.subject_id);
      const firstName = subject?.first_name || subject?.name?.split(/\s+/)[0] || "the subject";
      const result = await analyzeProgram(formatEvidence(e), { subject_name: firstName,
        program: e.title, status: `${e.completion_status || "unknown"}; started ${e.started_at || "not recorded"}; completed ${e.completed_at || "not completed"}` });
      finishAnalysisDraft(id, { ...result, phase: "phase2-poc", evidence_count: e.responses?.length || 0 });
    } catch (err) { failAnalysis(id, err?.message || err); }
  }
  working = false;
}
export const enqueueProgramAnalysis = id => { queue.push(id); drain(); };
