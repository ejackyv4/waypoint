/**
 * Everything Northwood does WITH the LMS.
 *
 * This module is the integration, in one file: the catalog it pulls, the
 * assignments it pushes, the logins it provisions, the status it polls, and
 * the signed webhook it receives. If you want to know what a customer has to
 * build to use Waypoint, this is the file to read — it is roughly a hundred
 * lines, which is the honest answer to "how hard is this to integrate".
 *
 * Every outbound call goes through `waypoint()`, which holds the API key
 * server-side. Northwood has no other route into the LMS: `check-boundary.mjs`
 * fails the build if it ever imports one.
 */

import { saasReceive, saasInbox, subjectByKey } from "../db/northwood.mjs";
import { WEBHOOK_SECRET, verifyWebhook } from "../auth.mjs";
import { APP_ORIGIN } from "../config.mjs";
import { readJson } from "../http.mjs";
import { saasJson, waypoint, makePassword } from "./shared.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPdf } from "../pdf.mjs";
import { DOCS_DIR } from "./documents.mjs";
import { addDocument, documentsFor } from "../db/northwood.mjs";
import { createAnalysisJob, analysisJob, analysisJobsFor, analysisReview, saveAnalysisReview, createComparison, comparison } from "../db/program-analysis.mjs";
import { LLM_READY, LLM_MODEL } from "../config.mjs";
import { enqueueProgramAnalysis } from "./program-analysis.mjs";

export const routes = {

  /* What we can offer — pulled live rather than kept in step by hand. */
  "ALL /api/catalog": async (req, res) => {
    const r = await waypoint("/api/content");
    return saasJson(res, r.status, r.body);
  },

  /* Assign a program. */
  "POST /api/assign": async (req, res) => {
    const b = await readJson(req);
    if (!b.subject_id || !b.program_id)
      return saasJson(res, 400, { error: "customer and program required" });

    // Assigning work and issuing a login are separate acts. A login belongs
    // to the subject and outlives any one program; creating one here is what
    // used to rotate a password every time a second program was assigned.
    const email = b.email || `${b.subject_id}@example.com`;
    const u = await waypoint("/api/users", { method: "POST", body: JSON.stringify({
      subject_id: b.subject_id, name: b.name, email }) });
    if (u.status !== 200) return saasJson(res, u.status, u.body);

    const a = await waypoint("/api/assign", { method: "POST", body: JSON.stringify({
      subject_id: b.subject_id, program_id: b.program_id, name: b.name, email }) });
    if (a.status !== 200) return saasJson(res, a.status, a.body);

    const l = await waypoint(`/api/logins?subject_id=${encodeURIComponent(b.subject_id)}`);
    return saasJson(res, 200, {
      assigned: true,
      // Assigned, but they cannot reach it until someone gives them a login.
      needs_login: !l.body.has_login,
      learner_url: `${APP_ORIGIN}/learn`
    });
  },

  /* Cancel an assignment. Waypoint refuses once the learner has started. */
  "POST /api/unassign": async (req, res) => {
    const b = await readJson(req);
    const r = await waypoint("/api/unassign", { method: "POST", body: JSON.stringify(b) });
    return saasJson(res, r.status, r.body);
  },

  /* Create or reset a subject's Waypoint login.
     The password is generated here and returned exactly once; Waypoint only
     ever sees its hash, and will not overwrite an existing login unless
     `reset` says so. */
  "POST /api/subject/login": async (req, res) => {
    const b = await readJson(req);
    if (!b.subject_id) return saasJson(res, 400, { error: "subject_id required" });
    const subject = subjectByKey(b.subject_id);
    if (!subject) return saasJson(res, 404, { error: "no such subject" });

    const email = subject.email || `${b.subject_id}@example.com`;
    const password = makePassword();
    const u = await waypoint("/api/users", { method: "POST", body: JSON.stringify({
      subject_id: b.subject_id, name: subject.name, email, password,
      reset_password: !!b.reset }) });
    if (u.status !== 200) return saasJson(res, u.status, u.body);

    if (!u.body.issued)
      return saasJson(res, 409, { error: "This subject already has a login.",
                                  login: u.body.credential?.identifier });

    return saasJson(res, 200, {
      reset: !!b.reset,
      credentials: { login: email, password },   // shown once, as a real system would
      learner_url: `${APP_ORIGIN}/learn`
    });
  },

  /* Who has a login — one call, so the roster can mark them all. */
  "ALL /api/logins": async (req, res, ctx) => {
    const sid = ctx.url.searchParams.get("subject_id");
    const r = await waypoint(sid ? `/api/logins?subject_id=${encodeURIComponent(sid)}`
                                 : "/api/logins");
    return saasJson(res, r.status, r.body);
  },

  /* Live status, pulled from Waypoint. The webhook is the push; this is the
     pull. A system needs both — the push for timeliness, the pull for
     reconciling anything missed. */
  "ALL /api/enrollments": async (req, res) => {
    const r = await waypoint("/api/status");
    return saasJson(res, r.status, r.body);
  },

  /* Survey answers remain in Waypoint's xAPI statement store. Northwood reads
     the registration-scoped view over HTTP, exactly as another customer LMS
     integration would; it never reaches into Waypoint's database. */
  "ALL /api/program-responses": async (req, res, ctx) => {
    const id = Number(ctx.url.searchParams.get("registration_id"));
    if (!Number.isInteger(id) || id < 1)
      return saasJson(res, 400, { error: "registration_id required" });
    const r = await waypoint(`/api/registrations/${id}/responses`);
    return saasJson(res, r.status, r.body);
  },

  "POST /api/program-responses/pdf": async (req, res, ctx) => {
    const b = await readJson(req);
    const id = Number(b.registration_id);
    if (!Number.isInteger(id) || id < 1)
      return saasJson(res, 400, { error: "registration_id required" });
    const r = await waypoint(`/api/registrations/${id}/responses`);
    if (r.status !== 200) return saasJson(res, r.status, r.body);
    const sid = r.body.subject_id;
    const subject = sid ? subjectByKey(sid) : null;
    if (!subject) return saasJson(res, 404, { error: "subject is unavailable" });
    const blocks = [
      { h1: `${r.body.title || "Course"} — Survey Responses` },
      { p: `${subject.name} · Attempt ${r.body.attempt || 1}` }, { rule: true }
    ];
    for (const a of (r.body.responses || [])) {
      if (a.section) blocks.push({ h2: `Section: ${a.section}` });
      if (a.lesson) blocks.push({ h2: `Lesson: ${a.lesson}` });
      blocks.push({ h2: a.question || "Survey question" },
                  { p: `Response: ${typeof a.response === "object"
                    ? JSON.stringify(a.response) : (a.response ?? "No response")}` },
                  ...(a.quality_flags?.length
                    ? [{ small: `Deterministic review flag: ${a.quality_flags.join(", ")}` }]
                    : []),
                  { small: `Submitted: ${a.submitted_at || "not reported"}` }, { gap: 8 });
    }
    if (!r.body.responses?.length) blocks.push({ p: "No survey responses have been received for this attempt." });
    const pdf = buildPdf(blocks, { title: `${r.body.title || "Course"} survey responses`,
      footer: `${subject.case_number} · ${subject.name}` });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `program-responses-${sid}-${id}-${stamp}.pdf`;
    await writeFile(join(DOCS_DIR, filename), pdf);
    const doc = addDocument({ subject_id: sid, doc_type: "program_responses",
      title: `${r.body.title || "Program"} survey responses`, filename,
      byte_size: pdf.length, source_id: id, created_by: ctx.session?.name || null });
    return saasJson(res, 200, { document: doc, documents: documentsFor(sid) });
  },

  /* Phase 2 foundation: capture an immutable evidence snapshot and queue it.
     Provider execution is deliberately disabled until the privacy/provider
     decision is approved; no learner content leaves this machine. */
  "POST /api/program-analysis": async (req, res, ctx) => {
    const b = await readJson(req);
    const id = Number(b.registration_id);
    if (!Number.isInteger(id) || id < 1)
      return saasJson(res, 400, { error: "registration_id required" });
    const r = await waypoint(`/api/registrations/${id}/responses`);
    if (r.status !== 200) return saasJson(res, r.status, r.body);
    const job = createAnalysisJob({ registration_id: id, evidence: {
      registration_id: id, subject_id: r.body.subject_id, program_id: r.body.program_id,
      title: r.body.title, attempt: r.body.attempt,
      completion_status: r.body.completion_status, success_status: r.body.success_status,
      started_at: r.body.started_at, completed_at: r.body.completed_at,
      last_write_at: r.body.last_write_at, responses: r.body.responses || []
    }, requested_by: ctx.session?.name || null, model: LLM_MODEL });
    enqueueProgramAnalysis(job.id);
    return saasJson(res, 202, { job, provider_ready: LLM_READY(),
      message: LLM_READY() ? "queued" : "queued; provider is disabled" });
  },

  "ALL /api/program-analysis/:id": async (req, res, ctx) => {
    const id = Number(ctx.params?.id || ctx.url.pathname.split("/").pop());
    const job = analysisJob(id);
    if (!job) return saasJson(res, 404, { error: "analysis job not found" });
    return saasJson(res, 200, { job });
  },

  "POST /api/program-analysis/review": async (req, res, ctx) => {
    const b = await readJson(req), id = Number(b.analysis_id);
    if (!Number.isInteger(id) || !["approved", "edited", "dismissed", "escalated"].includes(b.disposition))
      return saasJson(res, 400, { error: "analysis_id and valid disposition required" });
    const job = analysisJob(id);
    if (!job || job.status !== "draft") return saasJson(res, 409, { error: "analysis draft is not ready" });
    return saasJson(res, 200, { review: saveAnalysisReview({ analysis_id: id,
      disposition: b.disposition, notes: b.notes, reviewed_by: ctx.session?.name || "staff" }) });
  },

  "POST /api/program-analysis/pdf": async (req, res, ctx) => {
    const b = await readJson(req), id = Number(b.analysis_id), job = analysisJob(id), review = analysisReview(id);
    if (!job || !review || review.disposition === "dismissed")
      return saasJson(res, 409, { error: "an approved or escalated review is required before export" });
    const e = JSON.parse(job.evidence_json), result = JSON.parse(job.result_json || "{}");
    if (e.completion_status !== "completed")
      return saasJson(res, 409, { error: "the final completion summary can only be exported after the program is complete" });
    const subject = e.subject_id ? subjectByKey(e.subject_id) : null;
    if (!subject) return saasJson(res, 404, { error: "subject is unavailable" });
    const blocks = [{ h1: `${e.title || "Program"} — Completion Summary` },
      { p: `${subject.name} · Attempt ${e.attempt || 1} · ${e.completion_status || "unknown"}` }, { rule: true },
      { h2: result.headline || "Analysis" },
      ...(result.findings || []).map(f => ({ p: `${f.text || ""}\nEvidence: ${f.evidence || ""}` })),
      ...(result.danger_signs || []).map(f => ({ p: `Danger-sign review: ${f.severity || "review"} — ${f.evidence || ""}` })),
      { h2: "Officer review" }, { p: `Disposition: ${review.disposition}\nReviewed by: ${review.reviewed_by}\nNotes: ${review.notes || "—"}` }];
    const pdf = buildPdf(blocks, { title: `${e.title || "Program"} completion summary`, footer: `${subject.case_number} · ${subject.name}` });
    const filename = `program-analysis-${e.subject_id}-${id}.pdf`;
    await writeFile(join(DOCS_DIR, filename), pdf);
    const doc = addDocument({ subject_id: e.subject_id, doc_type: "program_analysis",
      title: `${e.title || "Program"} completion summary`, filename, byte_size: pdf.length,
      source_id: id, created_by: ctx.session?.name || null });
    saveAnalysisReview({ analysis_id: id, disposition: review.disposition, notes: review.notes,
      reviewed_by: review.reviewed_by, document_id: doc.id });
    return saasJson(res, 200, { document: doc });
  },

  "POST /api/program-analysis/compare": async (req, res, ctx) => {
    const b = await readJson(req), current = analysisJob(Number(b.analysis_id));
    if (!current || current.status !== "draft") return saasJson(res, 409, { error: "current analysis draft is not ready" });
    const e = JSON.parse(current.evidence_json);
    if (e.completion_status !== "completed") return saasJson(res, 409, { error: "comparison is offered only after completion" });
    const regs = await waypoint(`/api/registrations/${encodeURIComponent(e.subject_id)}`);
    const prior = (regs.body.registrations || []).filter(r => r.completion_status === "completed" && r.id !== e.registration_id && r.attempt < e.attempt)
      .sort((a, z) => z.attempt - a.attempt)[0];
    if (!prior) return saasJson(res, 404, { error: "no previous completed attempt" });
    const jobs = analysisJobsFor(prior.id), previous = jobs.find(j => j.status === "draft");
    if (!previous) return saasJson(res, 409, { error: "previous attempt has no completed analysis" });
    const out = createComparison({ current_analysis_id: current.id, previous_analysis_id: previous.id,
      evidence: { subject_id: e.subject_id, current_attempt: e.attempt, previous_attempt: prior.attempt,
        current: JSON.parse(current.result_json || "{}"), previous: JSON.parse(previous.result_json || "{}") } });
    return saasJson(res, 202, { comparison: out, message: "comparison snapshot ready for analysis" });
  },

  "ALL /api/program-analysis/comparison/:id": async (req, res, ctx) => {
    const out = comparison(Number(ctx.params.id));
    return out ? saasJson(res, 200, { comparison: out }) : saasJson(res, 404, { error: "comparison not found" });
  },

  /* What Waypoint has told us. */
  "ALL /api/results": async (req, res) =>
    saasJson(res, 200, { results: saasInbox() }),

  /* The webhook Waypoint calls when someone finishes.
     Verified before a word of it is trusted — this is the check a real
     integrator implements, and auth.mjs exports it so they can copy it. */
  "POST /webhook": async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();

    const check = verifyWebhook(raw, req.headers, WEBHOOK_SECRET);
    if (!check.ok) {
      console.log(`  [SaaS] REJECTED delivery — ${check.reason}`);
      return saasJson(res, 401, { accepted: false, reason: check.reason });
    }
    const d = JSON.parse(raw);
    saasReceive({ subject_id: d.subject_id, program_id: d.program_id,
                  payload: d, verified: 1 });
    console.log(`  [SaaS] ✓ ${d.subject_id} — ${d.completion_status}/${d.success_status}`
              + (d.score?.raw != null ? ` score ${d.score.raw}` : ""));
    return saasJson(res, 200, { accepted: true });
  }
};
