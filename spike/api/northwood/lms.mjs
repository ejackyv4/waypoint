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
