/**
 * Goals and action steps — data layer.
 *
 * The derived rules live at the top, as they do for the reentry plan, because
 * they are the part worth reading: everything else here is CRUD.
 */

import { all, one, run } from "./connect.mjs";

const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

/* ---------------- the derived rules ---------------- */

/**
 * How far along a goal is, from its steps alone.
 *
 * A goal with no steps is 0% and stays that way — it is a statement of intent
 * with nothing under it, which is worth being visible rather than rounding up
 * to 100 because "no steps are outstanding".
 */
export const progressOf = steps => {
  const done = steps.filter(x => x.done_at).length;
  return { done, total: steps.length,
           percent: steps.length ? Math.round(done / steps.length * 100) : 0 };
};

/** Past its due date and not yet completed. Cancelled goals cannot be late. */
export const isOverdue = g =>
  g.status === "open" && !!g.due_date && g.due_date < today();

/**
 * What state a goal is in, for a badge or a chip.
 *
 * Deliberately NOT the same question as `status`. `status` is the officer's
 * decision; this is the situation, and an officer who has not yet marked a
 * finished-looking goal complete should see that it is waiting on them.
 */
export function goalState(g) {
  if (g.status === "cancelled") return "cancelled";
  if (g.status === "complete") return "complete";
  if (isOverdue(g)) return "overdue";
  const p = progressOf(g.steps || []);
  if (p.total && p.done === p.total) return "awaiting_officer";
  return p.done ? "in_progress" : "not_started";
}

/**
 * The subject's goals, rolled up for the app's badge.
 *
 * Red while something has not been started or has run past its date, amber
 * once everything outstanding is under way, nothing at all when they are all
 * closed — the same three-state rule the Programs tab uses, because a person
 * should not have to learn a second colour vocabulary.
 */
export function goalSummary(goals) {
  const open = goals.filter(g => g.status === "open");
  if (!open.length) return { n: 0, tone: null, overdue: 0, unseen: 0 };
  const states = open.map(goalState);
  return {
    n: open.length,
    overdue: states.filter(x => x === "overdue").length,
    unseen: open.filter(g => !g.seen_at).length,
    tone: states.some(x => x === "overdue" || x === "not_started") ? "urgent" : "active"
  };
}

/* ---------------- reads ---------------- */

export const stepsFor = goal_id => all(
  `SELECT * FROM goal_steps WHERE goal_id = ? ORDER BY sort_order, id`, goal_id);

/** A goal is never returned without its steps or its progress. */
const hydrate = g => g && {
  ...g,
  steps: stepsFor(g.id),
  progress: progressOf(stepsFor(g.id)),
  state: goalState({ ...g, steps: stepsFor(g.id) }),
  overdue: isOverdue(g)
};

export const goalsFor = subject_id => all(
  `SELECT * FROM goals WHERE subject_id = ?
    ORDER BY (status = 'open') DESC, (due_date IS NULL), due_date, id DESC`,
  subject_id).map(hydrate);

export const goalById = id => hydrate(one(`SELECT * FROM goals WHERE id = ?`, id));

export const stepById = id => one(`SELECT * FROM goal_steps WHERE id = ?`, id);

export const unseenGoalCount = subject_id => one(
  `SELECT COUNT(*) n FROM goals WHERE subject_id = ? AND status = 'open' AND seen_at IS NULL`,
  subject_id)?.n ?? 0;

export const markGoalsSeen = subject_id => run(
  `UPDATE goals SET seen_at = ? WHERE subject_id = ? AND status = 'open' AND seen_at IS NULL`,
  now(), subject_id);

/* ---------------- writes ---------------- */

const GOAL_FIELDS = ["title", "detail", "due_date", "status"];

export function saveGoal(g, author) {
  if (g.id) {
    // Merge, never overwrite: a payload that omits a field leaves it alone.
    const patch = GOAL_FIELDS.filter(f => g[f] !== undefined);
    if (patch.length)
      run(`UPDATE goals SET ${patch.map(f => `${f}=?`).join(", ")}, updated_at=?
            WHERE id = ?`, ...patch.map(f => g[f]), now(), g.id);
    return goalById(g.id);
  }
  run(`INSERT INTO goals (subject_id, title, detail, due_date, created_at, created_by)
       VALUES (?,?,?,?,?,?)`,
      g.subject_id, g.title, g.detail ?? null, g.due_date ?? null, now(), author ?? null);
  // The row just inserted, not "the subject's newest goal by some other
  // ordering" — a create that returns a different record's id is how a client
  // ends up editing the wrong thing.
  return goalById(one(`SELECT id FROM goals WHERE subject_id = ? ORDER BY id DESC LIMIT 1`,
                      g.subject_id).id);
}

/**
 * The officer closes a goal, or reopens it.
 *
 * Not derived from the steps. Ten resumes submitted is not a job, and a rule
 * that closed the goal the moment the last box was ticked would be asserting
 * something only a person can know.
 */
export function completeGoal(id, author, complete = true) {
  const g = one(`SELECT * FROM goals WHERE id = ?`, id);
  if (!g) return { error: "no such goal" };
  if (complete)
    run(`UPDATE goals SET status = 'complete', completed_at = ?, completed_by = ?,
                          updated_at = ? WHERE id = ?`, now(), author ?? null, now(), id);
  else
    run(`UPDATE goals SET status = 'open', completed_at = NULL, completed_by = NULL,
                          updated_at = ? WHERE id = ?`, now(), id);
  return { ok: true, goal: goalById(id) };
}

export function deleteGoal(id) {
  run(`DELETE FROM goal_steps WHERE goal_id = ?`, id);
  run(`DELETE FROM goals WHERE id = ?`, id);
  return { ok: true };
}

export function saveStep(st) {
  if (st.id) {
    run(`UPDATE goal_steps SET body = ?, sort_order = ? WHERE id = ?`,
        st.body, st.sort_order ?? 0, st.id);
    return stepById(st.id);
  }
  const next = one(`SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM goal_steps WHERE goal_id = ?`,
                   st.goal_id).n;
  run(`INSERT INTO goal_steps (goal_id, body, sort_order, created_at) VALUES (?,?,?,?)`,
      st.goal_id, st.body, st.sort_order ?? next, now());
  return one(`SELECT * FROM goal_steps WHERE goal_id = ? ORDER BY id DESC LIMIT 1`, st.goal_id);
}

export const deleteStep = id => run(`DELETE FROM goal_steps WHERE id = ?`, id);

/**
 * Tick an action step off, or un-tick it.
 *
 * Either party may: the subject because they are the one doing it, the
 * officer because they are the one who will hear about it at a visit. Who
 * did it is recorded, because "they said they did" and "I saw that they did"
 * are different claims and a case file should not blur them.
 */
export function setStepDone(id, done, role) {
  const st = stepById(id);
  if (!st) return { error: "no such action step" };
  if (done) run(`UPDATE goal_steps SET done_at = ?, done_by = ? WHERE id = ?`,
                now(), role ?? null, id);
  else      run(`UPDATE goal_steps SET done_at = NULL, done_by = NULL WHERE id = ?`, id);
  return { ok: true, step: stepById(id), goal: goalById(st.goal_id) };
}
