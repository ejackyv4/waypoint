/**
 * The officer's own views.
 *
 * Scoped to the signed-in officer, from the session — never from a parameter.
 * An officer cannot ask for somebody else's caseload because there is nowhere
 * to say whose caseload they want.
 */

import { officerSchedule, officerRecent, officerCaseload,
         activeOffices, officerBase } from "../db/northwood.mjs";
import { saasJson } from "./shared.mjs";
import { withLogins } from "./profile.mjs";

export const routes = {

  "ALL /api/officer/schedule": async (req, res, ctx) => {
    const all = officerSchedule(ctx.session.officer_id);
    return saasJson(res, 200, {
      upcoming: all.filter(v => v.scheduled_at),
      requests: all.filter(v => !v.scheduled_at),
      recent:   officerRecent(ctx.session.officer_id)
    });
  },

  /**
   * What is waiting on this officer, small enough to poll.
   *
   * The mobile app has had a badge on its Schedule tab since visits existed;
   * the console had nothing, so an officer on a laptop could only discover a
   * request by opening each subject's Visits screen in turn. A notification
   * nobody can see is not a notification.
   *
   * Deliberately a separate, cheap endpoint rather than polling the whole
   * schedule: this runs every thirty seconds on every console screen.
   */
  "ALL /api/officer/alerts": async (req, res, ctx) => {
    const requests = officerSchedule(ctx.session.officer_id)
      .filter(v => !v.scheduled_at)
      .map(v => ({ id: v.id, subject_id: v.subject_id, subject_name: v.subject_name,
                   requested_at: v.requested_at, request_note: v.request_note }));
    return saasJson(res, 200, { requests });
  },

  /**
   * A week of visits, day by day.
   *
   * A week rather than a day because that is the unit an officer plans in:
   * scrolling a day at a time to find out what Thursday looks like is not
   * planning, it is paging. Each day carries its own stops in appointment
   * order; which of them to actually drive together is the officer's choice,
   * made on the screen and sent to /api/officer/route.
   *
   * Addresses come back for the client to hand to a map application. Nothing
   * about them leaves this server unless the officer asks for a route.
   */
  "ALL /api/officer/week": async (req, res, ctx) => {
    const q = ctx.url.searchParams.get("from");
    // The officer's own week, in their own timezone, which only they know —
    // so the client says which day it starts on rather than the server
    // guessing.
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q || "") ? q
               : new Date().toISOString().slice(0, 10);

    const span = Math.min(31, Math.max(1,
      Number(ctx.url.searchParams.get("days")) || 7));
    const dayKeys = Array.from({ length: span }, (_, i) => {
      const d = new Date(from + "T00:00:00");
      d.setDate(d.getDate() + i);
      return d.toISOString().slice(0, 10);
    });

    const all = officerSchedule(ctx.session.officer_id).filter(v => v.scheduled_at);
    const days = dayKeys.map(date => ({
      date,
      stops: all.filter(v => v.scheduled_at.slice(0, 10) === date)
                .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))
    }));

    /* Anything before this week that was never closed out. It belongs on the
       screen an officer opens, not behind a Previous button they have no
       reason to press. */
    const stale = all.filter(v => v.scheduled_at.slice(0, 10) < from
                              && v.status !== "completed")
                     .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));

    return saasJson(res, 200, {
      from, to: dayKeys[dayKeys.length - 1], today: new Date().toISOString().slice(0, 10),
      days, stale,
      base: officerBase(ctx.session.officer_id),
      offices: activeOffices()
    });
  },

  "ALL /api/officer/caseload": async (req, res, ctx) =>
    saasJson(res, 200, { subjects: await withLogins(officerCaseload(ctx.session.officer_id)) })
};
