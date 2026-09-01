/**
 * Important dates — the officer's side.
 *
 * The subject's half lives in me.mjs: they acknowledge an appointment and
 * report whether they made it. They do not create or move one — an appointment
 * is set by a court, a board or a provider, and there is no route here for
 * them to change when or where it is.
 */

import { datesFor, datesSummary, dateById, saveDate, deleteDate,
         closeDate, DATE_KINDS } from "../db/dates.mjs";
import { subjectByKey } from "../db/northwood.mjs";
import { readJson } from "../http.mjs";
import { saasJson } from "./shared.mjs";

const KINDS = new Set(DATE_KINDS.map(([k]) => k));

/** ISO datetime, and it must parse. A time nobody can sort is not a time. */
const validWhen = v => {
  if (!v) return "An appointment needs a date and time.";
  return isNaN(new Date(v)) ? "That is not a date and time." : null;
};

export const routes = {

  "ALL /api/important-dates": async (req, res, ctx) => {
    const sid = ctx.url.searchParams.get("subject_id");
    if (!sid) return saasJson(res, 400, { error: "subject_id required" });
    return saasJson(res, 200, { ...datesSummary(sid), kinds: DATE_KINDS });
  },

  "POST /api/important-dates": async (req, res, ctx) => {
    const b = await readJson(req);
    const editing = !!b.id;
    if (!editing && !subjectByKey(b.subject_id))
      return saasJson(res, 404, { error: "no such subject" });
    if (b.kind !== undefined && !KINDS.has(b.kind))
      return saasJson(res, 400, { error: "not a kind of appointment" });
    if (!editing && !b.kind)
      return saasJson(res, 400, { error: "Choose what kind of appointment this is." });
    if (!editing || b.scheduled_at !== undefined) {
      const bad = validWhen(b.scheduled_at);
      if (bad) return saasJson(res, 400, { error: bad });
    }

    const date = saveDate({
      id: b.id, subject_id: b.subject_id, kind: b.kind, title: b.title,
      detail: b.detail, location: b.location, address: b.address,
      scheduled_at: b.scheduled_at === undefined
        ? undefined : new Date(b.scheduled_at).toISOString()
    }, ctx.session?.name || null);
    return saasJson(res, 200, { date, ...datesSummary(date.subject_id) });
  },

  "POST /api/important-dates/delete": async (req, res) => {
    const b = await readJson(req);
    const d = dateById(Number(b.id));
    if (!d) return saasJson(res, 404, { error: "no such appointment" });
    deleteDate(d.id);
    return saasJson(res, 200, datesSummary(d.subject_id));
  },

  /* The officer records the outcome — they heard from the court, or the
     subject told them at a visit. Marking one missed is the point of the
     module, so it is a first-class outcome rather than a deletion. */
  "POST /api/important-dates/close": async (req, res, ctx) => {
    const b = await readJson(req);
    const r = closeDate(Number(b.id), { status: b.status, note: b.note },
                        ctx.session?.name || null, "officer");
    if (r.error) return saasJson(res, r.error === "no such appointment" ? 404 : 400, r);
    return saasJson(res, 200, { ...r, ...datesSummary(r.date.subject_id) });
  }
};
