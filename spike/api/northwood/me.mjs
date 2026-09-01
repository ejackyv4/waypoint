/**
 * The subject's own view — everything under /api/me.
 *
 * One rule governs this entire file, and it is the reason the file exists:
 *
 *   THE SUBJECT NEVER TELLS US WHO THEY ARE.
 *
 * These routes carry a Waypoint token, not a Northwood session. Northwood asks
 * Waypoint who that token belongs to — token introspection — and uses the
 * answer. A `subject_id` in a request body is ignored, always.
 *
 * The check used to be four copy-pasted lines at the top of every handler,
 * which is a rule enforced by remembering. `subjectOnly()` now wraps each one,
 * so a handler here cannot be written without it: there is no `req` to read a
 * token from until the wrapper has already resolved and verified it.
 */

import {
  subjectByKey, markVisitsSeen, visitsFor, unseenVisitCount,
  unconfirmedVisitCount,
  vehiclesFor, saveVehicle, deleteVehicle, vehicleById,
  curfewFor, obligationsFor, travelPermitFor, documentsFor,
  employmentFor, saveEmployment,
  contactsFor, contactById, saveContact, deleteContact,
  agreementFor, signAgreement, acceptVisit, requestVisit,
  CONDITION_CATEGORIES
} from "../db/northwood.mjs";
import { readJson } from "../http.mjs";
import { saasJson, asProfile, subjectFromToken } from "./shared.mjs";
import { agreementBlocks, blocksToText } from "./agreement-doc.mjs";
import { reentryBlocks, blocksToText as reentryToText } from "./reentry-doc.mjs";
import { planFor, signItem, signPlan, itemById } from "../db/reentry.mjs";
import { financialSummary, financialItemById } from "../db/financial.mjs";
import { openActionsForSubject, completeAction, unseenActionCount,
         markActionsSeen } from "../db/insights.mjs";
import { recordPayment } from "./financial.mjs";
import { datesSummary, dateById, acknowledgeDate, closeDate,
         unseenDateCount, markDateSeen } from "../db/dates.mjs";
import { goalsFor, goalById, setStepDone, stepById, unseenGoalCount,
         markGoalsSeen, goalSummary } from "../db/goals.mjs";
import { REENTRY_AREAS, REENTRY_STATUSES } from "../reentry-template.mjs";
import { validEmployment, validContact, cleanContact } from "./validate.mjs";

/**
 * Resolve the caller from their Waypoint token, or refuse.
 * The handler receives the person as its fourth argument and never sees a
 * request it has not been authenticated for.
 */
const subjectOnly = handler => async (req, res, ctx) => {
  const person = await subjectFromToken(req);
  if (!person) return saasJson(res, 401, { error: "sign in required" });
  return handler(req, res, ctx, person);
};

export const routes = {

  /* Everything the app shows, in one call. */
  /**
   * The subject reporting that they have done something they agreed to.
   *
   * They may report it; the record says who said so. Same shape as a goal
   * step, which either side can tick — the point of the product is that
   * supervision is something the two of them do together, and a list only the
   * officer can close is a list the subject is merely watched against.
   *
   * They can only touch their OWN items, checked server-side. A subject saying
   * an officer's task is done is not a thing that happens.
   */
  "POST /api/me/actions/done": subjectOnly(async (req, res, ctx, person) => {
    const b = await readJson(req);
    const mine = openActionsForSubject(person.subject_id)
                   .find(a => a.id === Number(b.id) && a.owner === "subject");
    if (!mine) return saasJson(res, 404, { error: "no such action item" });
    const r = completeAction(mine.id, person.name || "the subject");
    if (r.error) return saasJson(res, 409, { error: r.error });
    return saasJson(res, 200, r);
  }),

  "ALL /api/me/case": subjectOnly(async (req, res, ctx, person) => {
    const sid = person.subject_id;
    const subject = asProfile(subjectByKey(sid));
    if (ctx.url.searchParams.get("seen") === "1") markVisitsSeen(sid);
    // Opening the Goals tab is what marks them seen, and only that tab.
    if (ctx.url.searchParams.get("goals_seen") === "1") markGoalsSeen(sid);
    // Opening the Actions tab, and only that, clears the new-item banner.
    if (ctx.url.searchParams.get("actions_seen") === "1") markActionsSeen(sid);

    return saasJson(res, 200, {
      subject: subject || { subject_id: sid, name: person.name },
      visits: visitsFor(sid),
      unseen_visits: unseenVisitCount(sid),
      // What the badge counts: outstanding, not merely new.
      unconfirmed_visits: unconfirmedVisitCount(sid),
      // Read-only on their side. They need to know their curfew and what
      // service they owe; they do not get to change either.
      curfew: curfewFor(sid),
      community_service: obligationsFor(sid, "community_service"),
      travel_permit: travelPermitFor(sid),
      /* What they agreed to at a visit, in their own words.
         Only what the OFFICER ACCEPTED, and only what is theirs to do: a
         proposal nobody has reviewed is not something to put in front of the
         person it would create work for, and the officer's own list is not
         theirs to watch. */
      actions: openActionsForSubject(sid).filter(a => a.owner === "subject"),
      unseen_actions: unseenActionCount(sid),
      // Theirs to maintain.
      vehicles: vehiclesFor(sid),
      contacts: contactsFor(sid),
      employment: employmentFor(sid),
      // Only an executed agreement is shown. A draft is a working document,
      // not something they are bound by.
      agreement: (() => {
        const a = agreementFor(sid);
        return a && a.status === "active" ? a : null;
      })(),
      // So both clients group conditions exactly as the PDF does.
      condition_categories: CONDITION_CATEGORIES,
      // Same rule as the agreement: only an issued plan is theirs to see. A
      // draft is the officer's working document, not something they are
      // being asked to accept.
      reentry: (() => {
        const p = planFor(sid);
        return p && p.status === "active" ? p : null;
      })(),
      goals: goalsFor(sid),
      /* Read-only on their side, and there is no write route at all: what
         somebody owes is imposed by a court, and a payment is recorded by
         whoever took the money. */
      financial: financialSummary(sid),
      /* Appointments they have to keep. Theirs to acknowledge and report on,
         never to move: a court date is not something a subject reschedules. */
      important_dates: datesSummary(sid).dates,
      unseen_dates: unseenDateCount(sid),
      unseen_goals: unseenGoalCount(sid),
      reentry_areas: REENTRY_AREAS,
      reentry_statuses: REENTRY_STATUSES,
      documents: documentsFor(sid)
    });
  }),

  /* The subject acknowledges the agreement. Their signature, from their own
     session — never recorded on their behalf. */
  "POST /api/me/agreement/sign": subjectOnly(async (req, res, ctx, person) => {
    const a = agreementFor(person.subject_id);
    if (!a || a.status !== "active")
      return saasJson(res, 404, { error: "no active agreement" });

    // Record the text as it stood, not a reference to a row that can change.
    const subject = asProfile(subjectByKey(a.subject_id))
                 || { name: person.name, case_number: "" };
    const snapshot = blocksToText(agreementBlocks(a, subject, CONDITION_CATEGORIES));
    const r = signAgreement(a.id, "subject", null, snapshot);
    return saasJson(res, r.error ? 409 : 200, r);
  }),

  /* The subject accepts the reentry plan. Same shape as the agreement, and
     the same reason: their signature, from their own session, with a snapshot
     of what they were actually shown. */
  "POST /api/me/reentry/sign": subjectOnly(async (req, res, ctx, person) => {
    const plan = planFor(person.subject_id);
    if (!plan || plan.status !== "active")
      return saasJson(res, 404, { error: "no active reentry plan" });

    const subject = asProfile(subjectByKey(plan.subject_id))
                 || { name: person.name, case_number: "" };
    const snapshot = reentryToText(reentryBlocks(plan, subject));
    const r = signPlan(plan.id, "subject", null, snapshot);
    return saasJson(res, r.error ? 409 : 200, r);
  }),

  /* The subject signs off one checkpoint.
     This is the half that makes a checkpoint a checkpoint: the officer cannot
     record it, and it is scoped to their own plan — an id belonging to
     somebody else's plan is refused, not silently applied. */
  "POST /api/me/reentry/item/sign": subjectOnly(async (req, res, ctx, person) => {
    const b = await readJson(req);
    const plan = planFor(person.subject_id);
    if (!plan || plan.status !== "active")
      return saasJson(res, 404, { error: "no active reentry plan" });

    const item = itemById(Number(b.id));
    if (!item || item.plan_id !== plan.id)
      return saasJson(res, 404, { error: "no such checkpoint" });

    const r = signItem(item.id, "subject", person.name || null);
    if (r.error) return saasJson(res, 409, r);
    return saasJson(res, 200, { ...r, plan: planFor(person.subject_id) });
  }),

  /* The app tells the SaaS this appointment has been in front of the subject.
     Reported per appointment as it is displayed, never in bulk when a tab
     opens — an officer decides whether to ring somebody based on this flag,
     so it has to mean what it says. Idempotent, and it keeps the first time.

     Distinct from acknowledging: "they have not looked at it" and "they
     looked at it and did not agree" are different problems. */
  "POST /api/me/important-dates/seen": subjectOnly(async (req, res, ctx, person) => {
    const b = await readJson(req);
    const ids = Array.isArray(b.ids) ? b.ids : [b.id];
    let touched = 0;
    for (const raw of ids) {
      const d = dateById(Number(raw));
      // Silently skip anything not theirs rather than failing the batch: the
      // app reports what it drew, and one stale id should not lose the rest.
      if (!d || d.subject_id !== person.subject_id) continue;
      markDateSeen(d.id);
      touched++;
    }
    if (!touched) return saasJson(res, 404, { error: "no such appointment" });
    return saasJson(res, 200, { ok: true, seen: touched,
                                important_dates: datesSummary(person.subject_id).dates });
  }),

  /* The subject confirms they will be at an appointment.
     Not the same as having seen it — "I know about this" and "I will be
     there" are different claims, and the second is what an officer relies on.
     Scoped to their own appointments. */
  "POST /api/me/important-dates/acknowledge": subjectOnly(async (req, res, ctx, person) => {
    const b = await readJson(req);
    const d = dateById(Number(b.id));
    if (!d || d.subject_id !== person.subject_id)
      return saasJson(res, 404, { error: "no such appointment" });
    const r = acknowledgeDate(d.id);
    if (r.error) return saasJson(res, 409, r);
    return saasJson(res, 200, { ...r, important_dates: datesSummary(person.subject_id).dates });
  }),

  /* And afterwards, says whether they made it. Their claim, recorded as
     theirs — the officer confirming with the court is a separate act. */
  "POST /api/me/important-dates/close": subjectOnly(async (req, res, ctx, person) => {
    const b = await readJson(req);
    const d = dateById(Number(b.id));
    if (!d || d.subject_id !== person.subject_id)
      return saasJson(res, 404, { error: "no such appointment" });
    if (!["completed", "missed"].includes(b.status))
      return saasJson(res, 400, { error: "Say whether you attended or missed it." });

    const r = closeDate(d.id, { status: b.status, note: b.note },
                        person.name || null, "subject");
    if (r.error) return saasJson(res, 400, r);
    return saasJson(res, 200, { ...r, important_dates: datesSummary(person.subject_id).dates });
  }),

  /* The subject records a payment they made.
     They paid at an office and are entering the transaction — a thing they can
     legitimately do about their own case. What they cannot do is change what
     they owe: raising, editing and waiving an obligation are the officer's,
     and there is no route here for any of them.

     Scoped to their own obligations, and validated by the same function the
     officer's route uses, so neither side is the lenient one. */
  "POST /api/me/financial/payment": subjectOnly(async (req, res, ctx, person) => {
    const b = await readJson(req);
    const item = financialItemById(Number(b.item_id));
    if (!item || item.subject_id !== person.subject_id)
      return saasJson(res, 404, { error: "no such obligation" });

    const r = recordPayment(item, b, person.name || null, "subject");
    if (r.error) return saasJson(res, 400, r);
    return saasJson(res, 200, { item: r.item, ...financialSummary(person.subject_id) });
  }),

  /* The subject ticks off an action step, because they are the one doing it.
     Scoped to their own goals: a step id belonging to somebody else's goal is
     refused, not silently applied. */
  "POST /api/me/goals/step": subjectOnly(async (req, res, ctx, person) => {
    const b = await readJson(req);
    const st = stepById(Number(b.id));
    const goal = st && goalById(st.goal_id);
    if (!goal || goal.subject_id !== person.subject_id)
      return saasJson(res, 404, { error: "no such action step" });
    if (goal.status !== "open")
      return saasJson(res, 409, { error: "This goal is closed." });

    const r = setStepDone(st.id, b.done !== false, "subject");
    return saasJson(res, 200, { ...r, goals: goalsFor(person.subject_id) });
  }),

  /* Employment is reported by the subject and verified by the officer, so
     both write one record. Same validator as the officer's endpoint —
     neither side gets to be the lenient one. */
  "POST /api/me/employment": subjectOnly(async (req, res, ctx, person) => {
    const b = await readJson(req);
    const bad = validEmployment(b);
    if (bad) return saasJson(res, 400, { error: bad });
    return saasJson(res, 200, {
      employment: saveEmployment({ ...b, subject_id: person.subject_id }, "subject") });
  }),

  /* Their own contacts — the same list the officer edits. An existing row is
     checked for ownership first, or anyone could edit anyone's by guessing
     an id. */
  "POST /api/me/contacts":        subjectOnly(contactsHandler),
  "POST /api/me/contacts/delete": subjectOnly(contactsHandler),

  /* Their own vehicles. Self-reported fact about their own property. */
  "POST /api/me/vehicles":        subjectOnly(vehiclesHandler),
  "POST /api/me/vehicles/delete": subjectOnly(vehiclesHandler),

  /* The subject confirms they will attend — and the visit must be theirs. */
  "POST /api/me/visits/accept": subjectOnly(async (req, res, ctx, person) => {
    const b = await readJson(req);
    const r = acceptVisit(Number(b.id), person.subject_id);
    return saasJson(res, r.error ? 409 : 200, r);
  }),

  /* They supply a reason, not a date — scheduling stays with the officer. */
  "POST /api/me/visits/request": subjectOnly(async (req, res, ctx, person) => {
    const sid = person.subject_id;
    // One open request at a time, so a repeated tap cannot flood the officer.
    const open = visitsFor(sid).find(v => v.status === "requested");
    if (open) return saasJson(res, 409, {
      error: "You already have a request waiting. Your officer will be in touch.",
      visit: open });

    const b = await readJson(req);
    return saasJson(res, 200, { visit: requestVisit({ subject_id: sid, note: b.note || null }) });
  })
};

async function contactsHandler(req, res, ctx, person) {
  const sid = person.subject_id;
  const b = await readJson(req);

  if (b.id) {
    const existing = contactById(Number(b.id));
    if (!existing || existing.subject_id !== sid)
      return saasJson(res, 404, { error: "no such contact" });
  }

  if (ctx.url.pathname.endsWith("/delete")) {
    deleteContact(Number(b.id));
    return saasJson(res, 200, { ok: true, contacts: contactsFor(sid) });
  }

  const bad = validContact(b);
  if (bad) return saasJson(res, 400, { error: bad });
  const contact = saveContact({ ...b, id: b.id ? Number(b.id) : undefined,
                                subject_id: sid, ...cleanContact(b) }, "subject");
  return saasJson(res, 200, { contact, contacts: contactsFor(sid) });
}

async function vehiclesHandler(req, res, ctx, person) {
  const sid = person.subject_id;
  const b = await readJson(req);

  if (b.id) {
    const existing = vehicleById(Number(b.id));
    if (!existing || existing.subject_id !== sid)
      return saasJson(res, 404, { error: "no such vehicle" });
  }

  if (ctx.url.pathname.endsWith("/delete")) {
    deleteVehicle(Number(b.id));
    return saasJson(res, 200, { ok: true, vehicles: vehiclesFor(sid) });
  }

  const v = saveVehicle({ ...b, id: b.id ? Number(b.id) : undefined, subject_id: sid });
  return saasJson(res, 200, { vehicle: v, vehicles: vehiclesFor(sid) });
}
