/**
 * Goals and action steps — the officer's side.
 *
 * The subject's half lives in me.mjs, because it authenticates completely
 * differently and because the two sides can do different things: an officer
 * writes the goal and decides when it is met; the subject ticks off the
 * steps they have actually done.
 */

import { goalsFor, goalById, saveGoal, completeGoal, deleteGoal,
         saveStep, deleteStep, setStepDone, stepById } from "../db/goals.mjs";
import { subjectByKey } from "../db/northwood.mjs";
import { readJson } from "../http.mjs";
import { saasJson } from "./shared.mjs";

const clean = v => String(v ?? "").trim();

/** ISO date, or nothing. A due date typed as prose cannot be compared. */
const validDue = d => {
  if (!d) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? null : "A due date must be a calendar date.";
};

export const routes = {

  "ALL /api/goals": async (req, res, ctx) => {
    const sid = ctx.url.searchParams.get("subject_id");
    if (!sid) return saasJson(res, 400, { error: "subject_id required" });
    return saasJson(res, 200, { goals: goalsFor(sid) });
  },

  "POST /api/goals": async (req, res, ctx) => {
    const b = await readJson(req);
    const title = clean(b.title);
    if (!b.id && !b.subject_id)
      return saasJson(res, 400, { error: "subject_id required" });
    if (!b.id && !subjectByKey(b.subject_id))
      return saasJson(res, 404, { error: "no such subject" });
    if ((!b.id || b.title !== undefined) && !title)
      return saasJson(res, 400, { error: "A goal needs a title." });
    const bad = validDue(b.due_date);
    if (bad) return saasJson(res, 400, { error: bad });

    const goal = saveGoal({ ...b, title: b.title === undefined ? undefined : title },
                          ctx.session?.name || null);
    return saasJson(res, 200, { goal, goals: goalsFor(goal.subject_id) });
  },

  /* The officer's decision, and only theirs. Progress is computed from the
     steps; whether the goal is met is a judgement about the world. */
  "POST /api/goals/complete": async (req, res, ctx) => {
    const b = await readJson(req);
    const r = completeGoal(Number(b.id), ctx.session?.name || null, b.complete !== false);
    if (r.error) return saasJson(res, 404, r);
    return saasJson(res, 200, { ...r, goals: goalsFor(r.goal.subject_id) });
  },

  "POST /api/goals/delete": async (req, res) => {
    const b = await readJson(req);
    const g = goalById(Number(b.id));
    if (!g) return saasJson(res, 404, { error: "no such goal" });
    deleteGoal(g.id);
    return saasJson(res, 200, { ok: true, goals: goalsFor(g.subject_id) });
  },

  "POST /api/goals/step": async (req, res) => {
    const b = await readJson(req);
    const body = clean(b.body);
    if (!body) return saasJson(res, 400, { error: "An action step cannot be empty." });
    const goal = goalById(Number(b.goal_id ?? stepById(Number(b.id))?.goal_id));
    if (!goal) return saasJson(res, 404, { error: "no such goal" });
    saveStep({ ...b, goal_id: goal.id, body });
    return saasJson(res, 200, { goal: goalById(goal.id), goals: goalsFor(goal.subject_id) });
  },

  "POST /api/goals/step/delete": async (req, res) => {
    const b = await readJson(req);
    const st = stepById(Number(b.id));
    if (!st) return saasJson(res, 404, { error: "no such action step" });
    const goal = goalById(st.goal_id);
    deleteStep(st.id);
    return saasJson(res, 200, { goal: goalById(goal.id), goals: goalsFor(goal.subject_id) });
  },

  /* An officer may tick a step off too — they are the one who hears about it
     at a visit. Who did it is recorded either way. */
  "POST /api/goals/step/done": async (req, res) => {
    const b = await readJson(req);
    const r = setStepDone(Number(b.id), b.done !== false, "officer");
    if (r.error) return saasJson(res, 404, r);
    return saasJson(res, 200, { ...r, goals: goalsFor(r.goal.subject_id) });
  }
};
