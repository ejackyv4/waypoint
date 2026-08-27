/**
 * The officer's own views.
 *
 * Scoped to the signed-in officer, from the session — never from a parameter.
 * An officer cannot ask for somebody else's caseload because there is nowhere
 * to say whose caseload they want.
 */

import { officerSchedule, officerRecent, officerCaseload } from "../db/northwood.mjs";
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

  "ALL /api/officer/caseload": async (req, res, ctx) =>
    saasJson(res, 200, { subjects: await withLogins(officerCaseload(ctx.session.officer_id)) })
};
