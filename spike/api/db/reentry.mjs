/**
 * The reentry plan — data layer.
 *
 * Its own module rather than more of northwood.mjs, which was already close
 * to the size where a file stops being readable.
 *
 * The load-bearing decision in here is that **readiness is computed, never
 * stored**. A percentage in a column is a second copy of a fact the items
 * already carry, and the two will disagree the first time an item changes
 * through a path that forgot to recalculate. Everything derived — whether an
 * item is satisfied, an area's status, the plan's readiness — is a pure
 * function of the rows, evaluated on read.
 */

import { all, one, run } from "./connect.mjs";
import { REENTRY_TEMPLATE } from "../reentry-template.mjs";

const now = () => new Date().toISOString();

const PLAN_FIELDS = ["status", "target_release_date", "actual_release_date",
                     "facility", "officer_name", "notes"];

/* Terms of the plan. Editing one withdraws the subject's acceptance, for the
   same reason an amended agreement asks for a fresh signature: what they
   accepted was the plan as it read then. `status` is absent deliberately —
   activating a plan is not an amendment of it. */
const PLAN_TERMS = ["target_release_date", "facility", "officer_name", "notes"];

/* ---------------- the derived rules ----------------
   These four functions are the whole readiness model. They are pure, they
   are the only place these questions are answered, and every one of them is
   covered by a test — because a rollup that nobody can point at is exactly
   how a report and a screen start disagreeing. */

/** An N/A item is not incomplete; it is not part of the question at all. */
export const counts = i => i.status !== "not_applicable";

/**
 * Is this checkpoint done?
 *
 * An officer marking an item "ready" is an assessment, not a completion. The
 * checkpoint is only satisfied when BOTH parties have signed it off — which
 * is what makes it a checkpoint rather than a tick box one person controls.
 *
 * An approved exception is satisfied too: it is the documented answer to
 * "this cannot be completed, and here is what we are doing instead."
 */
export const satisfied = i =>
  i.status === "exception" ||
  (i.status === "ready" && !!i.officer_signed_at && !!i.subject_signed_at);

/** Marked ready by the officer, but still waiting on a signature. */
export const awaitingSignature = i =>
  i.status === "ready" && !satisfied(i);

/**
 * An area's status, from its items alone.
 *
 * Ordered by severity so the strongest signal wins: a critical checkpoint
 * nobody has started outranks the fact that three others are underway.
 */
export function areaStatus(items) {
  const live = items.filter(counts);
  if (!live.length) return "not_applicable";
  if (live.every(satisfied)) return "ready";
  const unmet = live.filter(i => !satisfied(i));
  if (unmet.some(i => i.critical && i.status === "not_started")) return "at_risk";
  if (unmet.some(i => i.status === "in_progress" || awaitingSignature(i)))
    return "in_progress";
  return "needs_attention";
}

/**
 * The plan's readiness.
 *
 * `ready_for_reentry` is deliberately not "100%". A person is ready when
 * every critical checkpoint is satisfied or carries an approved exception —
 * the non-critical remainder is real work, but it is not a release gate, and
 * conflating the two would either block releases that should happen or imply
 * a plan is finished when it is not.
 */
export function readiness(items) {
  const live = items.filter(counts);
  const done = live.filter(satisfied);
  const crit = live.filter(i => i.critical);
  const critDone = crit.filter(satisfied);
  return {
    percent: live.length ? Math.round(done.length / live.length * 100) : 0,
    complete: done.length,
    total: live.length,
    critical_complete: critDone.length,
    critical_total: crit.length,
    awaiting_signature: live.filter(awaitingSignature).length,
    not_applicable: items.length - live.length,
    ready_for_reentry: crit.length > 0 && critDone.length === crit.length,
    // Certification is the officer's closing act, and it means what it says:
    // every checkpoint that counts is done. An item that genuinely does not
    // apply is marked not applicable and leaves the calculation; one that
    // cannot be completed carries an approved exception. Both are recorded
    // and auditable. There is no third way to make an item disappear, which
    // is what stops "everything is done" from being a matter of opinion.
    certifiable: live.length > 0 && done.length === live.length,
    outstanding: live.length - done.length
  };
}

/* ---------------- reads ---------------- */

export const itemsFor = plan_id => all(
  `SELECT * FROM reentry_items WHERE plan_id = ? ORDER BY sort_order, id`, plan_id);

export const eventsFor = (plan_id, limit = 200) => all(
  `SELECT * FROM reentry_events WHERE plan_id = ? ORDER BY id DESC LIMIT ?`,
  plan_id, limit);

export const acknowledgmentsFor = plan_id => all(
  `SELECT id, plan_id, subject_id, acknowledged_at FROM reentry_acknowledgments
    WHERE plan_id = ? ORDER BY id DESC`, plan_id);

export const acknowledgmentSnapshot = id =>
  one(`SELECT * FROM reentry_acknowledgments WHERE id = ?`, id);

/** A plan is never returned bare: its items and its readiness come with it.
    Materialised rather than a getter, so what the client receives does not
    depend on how a caller happened to copy the object. */
export const withPlan = p => {
  if (!p) return null;
  const items = itemsFor(p.id);
  return { ...p, items, readiness: readiness(items) };
};

export const planFor = subject_id => withPlan(one(
  `SELECT * FROM reentry_plans WHERE subject_id = ?
    ORDER BY (status='active') DESC, id DESC LIMIT 1`, subject_id));

export const planById = id => withPlan(one(
  `SELECT * FROM reentry_plans WHERE id = ?`, id));

/* ---------------- writes ---------------- */

export function logEvent(e) {
  run(`INSERT INTO reentry_events
         (plan_id, item_id, kind, from_status, to_status, body, author, actor_role, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      e.plan_id, e.item_id ?? null, e.kind, e.from_status ?? null, e.to_status ?? null,
      e.body ?? null, e.author ?? null, e.actor_role ?? null, now());
}

/**
 * Create a plan and stamp the template onto it.
 *
 * The items are copied, not referenced. A plan issued in March keeps the
 * checkpoints and the critical flags it was issued under, even if the
 * template changes in April — the same immutability rule a course version
 * gets once somebody has started it.
 */
export function createPlan(p, author) {
  run(`INSERT INTO reentry_plans
         (subject_id, status, target_release_date, facility, officer_name, notes, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      p.subject_id, "draft", p.target_release_date ?? null, p.facility ?? null,
      p.officer_name ?? null, p.notes ?? null, now());
  const plan = one(`SELECT * FROM reentry_plans WHERE subject_id = ? ORDER BY id DESC LIMIT 1`,
                   p.subject_id);
  REENTRY_TEMPLATE.forEach(([area, label, critical], i) => {
    run(`INSERT INTO reentry_items (plan_id, area, label, critical, sort_order, created_at)
         VALUES (?,?,?,?,?,?)`, plan.id, area, label, critical, i, now());
  });
  logEvent({ plan_id: plan.id, kind: "plan", to_status: "draft",
             body: "Plan created", author, actor_role: "officer" });
  return withPlan(plan);
}

/**
 * Amending the terms withdraws the subject's acceptance.
 *
 * Returns whether it actually did, so the caller can say so rather than
 * leaving the officer to discover a signature vanished.
 */
export function markAmended(plan_id, author) {
  const p = one(`SELECT * FROM reentry_plans WHERE id = ?`, plan_id);
  if (!p?.subject_signed_at) return false;
  run(`UPDATE reentry_plans SET subject_signed_at = NULL, amended_at = ? WHERE id = ?`,
      now(), plan_id);
  logEvent({ plan_id, kind: "plan", body: "Plan amended — acceptance withdrawn",
             author, actor_role: "officer" });
  return true;
}

export function savePlan(p) {
  // Merge, never overwrite: a payload that omits a field leaves it alone.
  const patch = PLAN_FIELDS.filter(f => p[f] !== undefined);
  if (patch.length)
    run(`UPDATE reentry_plans SET ${patch.map(f => `${f}=?`).join(", ")}, updated_at=?
          WHERE id = ?`, ...patch.map(f => p[f]), now(), p.id);
  return planById(p.id);
}

export const isTermsEdit = p => PLAN_TERMS.some(f => p[f] !== undefined);

export const itemById = id => one(`SELECT * FROM reentry_items WHERE id = ?`, id);

/**
 * Update a checkpoint.
 *
 * Changing the status clears both signatures. A checkpoint signed off as
 * ready, then moved back to in-progress, is not still signed — leaving the
 * timestamps would let an item return to "ready" already carrying approval
 * nobody gave it a second time.
 */
export function saveItem(patch, author, role = "officer") {
  const cur = itemById(patch.id);
  if (!cur) return { error: "no such checkpoint" };

  const status = patch.status ?? cur.status;
  if (status === "exception" && !String(patch.mitigation ?? cur.mitigation ?? "").trim())
    return { error: "An exception needs a documented mitigation plan." };
  if (status === "exception" && !String(patch.approved_by ?? cur.approved_by ?? "").trim())
    return { error: "An exception needs the name of whoever approved it." };

  const changed = status !== cur.status;
  const sets = { status, detail: patch.detail ?? cur.detail };

  if (status === "exception") {
    sets.mitigation = patch.mitigation ?? cur.mitigation;
    sets.approved_by = patch.approved_by ?? cur.approved_by;
    sets.approved_at = cur.approved_at || now();
  }
  if (changed) {
    sets.officer_signed_at = null; sets.officer_signed_by = null;
    sets.subject_signed_at = null;
  }

  const cols = Object.keys(sets);
  run(`UPDATE reentry_items SET ${cols.map(c => `${c}=?`).join(", ")},
         updated_at=?, updated_by=? WHERE id = ?`,
      ...cols.map(c => sets[c]), now(), author ?? null, patch.id);

  let uncertified = false;
  if (changed) {
    logEvent({ plan_id: cur.plan_id, item_id: cur.id, kind: "status",
               from_status: cur.status, to_status: status,
               body: patch.detail ?? null, author, actor_role: role });
    uncertified = withdrawCertification(cur.plan_id, author);
  }

  return { ok: true, item: itemById(patch.id), uncertified };
}

/**
 * One party signs a checkpoint off.
 *
 * Only a checkpoint the officer has marked ready can be signed: signing
 * something still in progress would make the signature meaningless. Signing
 * twice is idempotent — a repeated tap is not a second approval.
 */
export function signItem(id, role, author) {
  const cur = itemById(id);
  if (!cur) return { error: "no such checkpoint" };
  if (cur.status !== "ready")
    return { error: "Mark the checkpoint verified before signing it off." };

  if (role === "officer") {
    if (!cur.officer_signed_at)
      run(`UPDATE reentry_items SET officer_signed_at = ?, officer_signed_by = ?
            WHERE id = ?`, now(), author ?? null, id);
  } else {
    if (!cur.subject_signed_at)
      run(`UPDATE reentry_items SET subject_signed_at = ? WHERE id = ?`, now(), id);
  }

  const item = itemById(id);
  const wasSigned = role === "officer" ? cur.officer_signed_at : cur.subject_signed_at;
  if (!wasSigned)
    logEvent({ plan_id: cur.plan_id, item_id: id, kind: "sign",
               body: `Signed off by the ${role}`, author, actor_role: role });

  return { ok: true, item, complete: satisfied(item) };
}

/**
 * The officer certifies the plan complete.
 *
 * Refused unless every checkpoint that counts is satisfied — the gate is the
 * same arithmetic the screen shows, so an officer is never told they can
 * certify by one thing and refused by another.
 */
export function certifyPlan(id, author) {
  const p = one(`SELECT * FROM reentry_plans WHERE id = ?`, id);
  if (!p) return { error: "no such plan" };
  if (p.status !== "active")
    return { error: "Issue the plan to the subject before certifying it." };
  if (!p.subject_signed_at)
    return { error: "The subject has not accepted this plan yet." };

  const r = readiness(itemsFor(id));
  if (!r.certifiable)
    return { error: r.outstanding === 1
      ? "One checkpoint is still outstanding. Complete it, or mark it not "
        + "applicable or an approved exception, before certifying the plan."
      : `${r.outstanding} checkpoints are still outstanding. Complete them, or `
        + "mark them not applicable or an approved exception, before certifying "
        + "the plan." };

  if (p.certified_at) return { ok: true, plan: planById(id) };   // idempotent
  run(`UPDATE reentry_plans SET certified_at = ?, certified_by = ? WHERE id = ?`,
      now(), author ?? null, id);
  logEvent({ plan_id: id, kind: "plan", body: "Plan certified complete",
             author, actor_role: "officer" });
  return { ok: true, plan: planById(id) };
}

/**
 * A certification describes a finished plan, so it cannot survive the plan
 * changing. Reopening a checkpoint after certification withdraws it — the
 * same rule, and the same reasoning, as amending the terms withdrawing the
 * subject's acceptance.
 */
function withdrawCertification(plan_id, author) {
  const p = one(`SELECT certified_at FROM reentry_plans WHERE id = ?`, plan_id);
  if (!p?.certified_at) return false;
  run(`UPDATE reentry_plans SET certified_at = NULL, certified_by = NULL WHERE id = ?`,
      plan_id);
  logEvent({ plan_id, kind: "plan",
             body: "Certification withdrawn — a checkpoint was reopened",
             author, actor_role: "officer" });
  return true;
}

export function signPlan(id, role, author, snapshot) {
  const p = one(`SELECT * FROM reentry_plans WHERE id = ?`, id);
  if (!p) return { error: "no such plan" };

  if (role === "officer") {
    run(`UPDATE reentry_plans SET officer_signed_at = ?, officer_signed_by = ? WHERE id = ?`,
        now(), author ?? null, id);
  } else {
    run(`UPDATE reentry_plans SET subject_signed_at = ? WHERE id = ?`, now(), id);
    // The snapshot is the evidence. Without it, what they accepted is
    // unanswerable after the third amendment.
    run(`INSERT INTO reentry_acknowledgments (plan_id, subject_id, acknowledged_at, snapshot)
         VALUES (?,?,?,?)`, id, p.subject_id, now(), snapshot ?? "");
  }
  logEvent({ plan_id: id, kind: "plan", body: `Plan signed by the ${role}`,
             author, actor_role: role });
  return { ok: true, plan: planById(id) };
}
