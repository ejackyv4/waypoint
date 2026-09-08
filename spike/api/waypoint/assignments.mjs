/** Assignment and enrollment-status routes used by the customer system. */
import { upsertPerson, upsertProgram, latestVersion, assign, openRegistration,
  assignmentState, unassign, enrollments } from "../db/waypoint.mjs";
import { requireApiKey } from "../auth.mjs";

const gate = (req, res, ctx) => {
  const auth = requireApiKey(req);
  return auth.error ? ctx.json(res, auth.status, { error: auth.error }) : null;
};

export const routes = {
  "POST /api/assign": async (req, res, ctx) => {
    if (gate(req, res, ctx)) return;
    const b = await ctx.readJson(req);
    if (!b.subject_id || !b.program_id)
      return ctx.json(res, 400, { error: "subject_id and program_id required" });
    const person = upsertPerson(b);
    const program = upsertProgram({ program_id: b.program_id, title: b.title || b.program_id });
    const cv = latestVersion(program.id);
    if (!cv) return ctx.json(res, 422, { error: `no content ingested for program "${b.program_id}"` });
    assign({ person_id: person.id, program_pk: program.id });
    const registration = openRegistration({ person_id: person.id, content_version_id: cv.id });
    return ctx.json(res, 200, { person, program, content_version: cv, registration });
  },

  "POST /api/unassign": async (req, res, ctx) => {
    if (gate(req, res, ctx)) return;
    const b = await ctx.readJson(req);
    const state = assignmentState(b.subject_id, b.program_id);
    if (!state) return ctx.json(res, 404, { error: "no such assignment" });
    const touched = state.last_write_at !== null
      || (state.completion_status && state.completion_status !== "not attempted");
    if (touched) return ctx.json(res, 409, {
      error: "This program has already been started and can no longer be cancelled.",
      completion_status: state.completion_status });
    unassign({ person_id: state.person_id, program_pk: state.program_pk });
    return ctx.json(res, 200, { cancelled: true });
  },

  "GET /api/status": async (req, res, ctx) => {
    if (gate(req, res, ctx)) return;
    return ctx.json(res, 200, { enrollments: enrollments() });
  }
};
