/**
 * The officer's dashboard — everything across their caseload, in one call.
 *
 * Every other read here is per-subject, because every other screen is about
 * one person. This is the one screen that is not: it answers "what do I do
 * now", which cannot be answered by looking at anybody in particular.
 *
 * It walks the caseload and asks each module what is outstanding. That is a
 * fan-out, and it is fine at the size a caseload actually is — a few dozen
 * people. If a caseload ever ran to thousands this would want a different
 * shape, and the honest place to find that out is here rather than in a
 * cleverness nobody needed yet.
 */

import { officerCaseload, officerSchedule, agreementFor } from "../db/northwood.mjs";
import { goalsFor } from "../db/goals.mjs";
import { financialFor, totals as financialTotals } from "../db/financial.mjs";
import { datesFor } from "../db/dates.mjs";
import { planFor } from "../db/reentry.mjs";
import { openActionsForSubject } from "../db/insights.mjs";
import { saasJson } from "./shared.mjs";

const today = () => new Date().toISOString().slice(0, 10);
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

/* Severity, so one list can be sorted honestly rather than by whichever
   module happened to be walked first. */
const RANK = { overdue: 0, action: 1, waiting: 2 };

export const routes = {

  /**
   * @param horizon  how many days ahead "coming up" reaches. The default is a
   *                 fortnight: far enough to plan a week and see the next one,
   *                 near enough that the list stays a list.
   */
  "ALL /api/officer/dashboard": async (req, res, ctx) => {
    const horizonDays = Math.min(90, Math.max(1,
      Number(ctx.url.searchParams.get("days")) || 14));
    const horizon = inDays(horizonDays);
    const day = today();

    const caseload = officerCaseload(ctx.session.officer_id);
    const schedule = officerSchedule(ctx.session.officer_id);

    /* ---- visits ---- */
    const dated = schedule.filter(v => v.scheduled_at);
    const visitsToday = dated.filter(v => v.scheduled_at.slice(0, 10) === day)
                             .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
    const visitsAhead = dated
      .filter(v => v.scheduled_at.slice(0, 10) > day
                && v.scheduled_at.slice(0, 10) <= horizon)
      .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
    const requests = schedule.filter(v => !v.scheduled_at);

    /* ---- what is outstanding, per subject ----
       One pass per person, asking each module the same two questions: what
       needs me now, and what falls due soon. */
    const attention = [];
    const upcoming = [];
    const push = (list, item) => list.push(item);

    for (const s of caseload) {
      const who = { subject_id: s.subject_id, subject_name: s.name,
                    case_number: s.case_number };

      /* A visit from a PREVIOUS day with no outcome. Deliberately not one from
         earlier today: that officer may be on their way to it, and it is
         already sitting in the day planner above. Flagging it in both places
         would make the attention list something people learn to scroll past. */
      for (const v of dated) {
        if (v.subject_id !== s.subject_id) continue;
        if (v.scheduled_at.slice(0, 10) < day && v.status !== "completed")
          push(attention, { ...who, kind: "visit", severity: "overdue",
            body: "Visit not closed out",
            detail: `Scheduled ${v.scheduled_at.slice(0, 10)}`, link: "visits" });
      }

      /* The agreement is issued and they have not acknowledged it. Not the
         officer's signature to give — but theirs to chase. */
      const ag = agreementFor(s.subject_id);
      if (ag && ag.status === "active" && !ag.subject_signed_at)
        push(attention, { ...who, kind: "agreement", severity: "waiting",
          body: "Conditions not acknowledged",
          detail: ag.amended_at ? "Amended; acknowledgment withdrawn" : "Issued, awaiting the subject",
          link: "agreement" });

      /* A reentry plan finished and waiting on a signature only the officer
         can give. */
      const plan = planFor(s.subject_id);
      if (plan?.status === "active" && !plan.certified_at) {
        if (plan.readiness.certifiable)
          push(attention, { ...who, kind: "reentry", severity: "action",
            body: "Reentry plan ready to certify",
            detail: `${plan.readiness.complete} of ${plan.readiness.total} complete`,
            link: "reentry" });
        else if (plan.readiness.awaiting_signature)
          push(attention, { ...who, kind: "reentry", severity: "waiting",
            body: `${plan.readiness.awaiting_signature} checkpoint`
                + `${plan.readiness.awaiting_signature === 1 ? "" : "s"} awaiting a signature`,
            detail: `${plan.readiness.percent}% ready`, link: "reentry" });
        if (plan.target_release_date && plan.target_release_date <= horizon)
          push(upcoming, { ...who, kind: "reentry", on: plan.target_release_date,
            body: "Target release", detail: `${plan.readiness.percent}% ready`,
            link: "reentry" });
      }

      /* Goals: every step ticked, waiting on the officer to close it. */
      for (const g of goalsFor(s.subject_id)) {
        if (g.status !== "open") continue;
        if (g.state === "awaiting_officer")
          push(attention, { ...who, kind: "goal", severity: "action",
            body: `Goal ready to close: ${g.title}`,
            detail: "Every step is done", link: "goals" });
        else if (g.overdue)
          push(attention, { ...who, kind: "goal", severity: "overdue",
            body: `Goal overdue: ${g.title}`,
            detail: `Was due ${g.due_date}`, link: "goals" });
        else if (g.due_date && g.due_date <= horizon)
          push(upcoming, { ...who, kind: "goal", on: g.due_date,
            body: g.title, detail: `${g.progress.done} of ${g.progress.total} steps`,
            link: "goals" });
      }

      /* Action items an officer has accepted off a visit summary.
         Only accepted ones reach here — a proposal nobody has looked at is not
         work anybody owes, and listing it would quietly undo the rule the whole
         feature rests on.

         Split by who owns it, because they are different jobs: one is on the
         officer's own list, the other is somebody to chase. */
      for (const a of openActionsForSubject(s.subject_id)) {
        const mine = a.owner === "officer" || a.owner === "unclear";
        push(attention, { ...who, kind: "action", id: a.id,
          severity: mine ? "action" : "waiting",
          body: a.body,
          detail: [mine ? "Yours to do" : "Waiting on the subject",
                   a.due_hint,
                   a.scheduled_at ? `from the visit on ${a.scheduled_at.slice(0, 10)}` : ""]
                  .filter(Boolean).join(" · "),
          link: "visits" });
      }

      /* Money: what is late, and what falls due soon. */
      const fin = financialFor(s.subject_id);
      const ft = financialTotals(fin);
      if (ft.overdue_cents)
        push(attention, { ...who, kind: "financial", severity: "overdue",
          body: "Payment overdue",
          detail: `${ft.overdue_count} item${ft.overdue_count === 1 ? "" : "s"}`,
          link: "financial" });
      for (const f of fin) {
        if (f.balance_cents <= 0 || !f.due_date) continue;
        if (f.due_date > day && f.due_date <= horizon)
          push(upcoming, { ...who, kind: "financial", on: f.due_date,
            body: `${f.kind_label} due`, detail: f.description || "",
            link: "financial" });
      }

      /* Appointments: unreported ones need chasing; upcoming ones need
         watching, especially any they have not accepted. */
      for (const d of datesFor(s.subject_id)) {
        if (d.status !== "scheduled") continue;
        if (d.awaiting_outcome)
          push(attention, { ...who, kind: "date", severity: "overdue",
            body: `${d.kind_label}: no outcome recorded`,
            detail: `Was ${d.scheduled_at.slice(0, 10)} · ${
              d.state === "assigned" ? "never seen by the subject"
              : d.state === "viewed" ? "seen, never accepted" : "accepted"}`,
            link: "dates" });
        else if (d.scheduled_at.slice(0, 10) <= horizon)
          push(upcoming, { ...who, kind: "date", on: d.scheduled_at.slice(0, 10),
            body: d.title || d.kind_label,
            detail: d.state === "accepted" ? "Accepted" : "Not accepted yet",
            link: "dates" });
      }
    }

    attention.sort((a, b) => (RANK[a.severity] - RANK[b.severity])
                          || a.subject_name.localeCompare(b.subject_name));
    upcoming.sort((a, b) => a.on.localeCompare(b.on)
                         || a.subject_name.localeCompare(b.subject_name));

    return saasJson(res, 200, {
      officer: ctx.session.name || null,
      today: day,
      horizon_days: horizonDays,
      caseload_count: caseload.length,
      visits_today: visitsToday,
      visits_ahead: visitsAhead,
      requests,
      attention,
      upcoming
    });
  }
};
