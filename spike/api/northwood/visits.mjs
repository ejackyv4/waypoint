/**
 * Visits — the officer's side.
 *
 * The lifecycle is:
 *
 *   Requested → Scheduled → Viewed → Accepted → Complete
 *   (subject)   (officer)   (opened)  (subject)  (officer)
 *
 * Every transition carries a timestamp, and accept and complete are
 * idempotent: a repeated tap returns the original timestamp rather than
 * overwriting it, which matters on a phone with a poor connection.
 *
 * The subject's half — requesting and accepting — is in me.mjs.
 *
 * TWO KINDS OF NOTE, deliberately separate:
 *   · visits.notes  — the instruction given to the subject beforehand
 *   · visit_notes   — what the officer recorded afterwards, append-only
 * Different authors, different audiences. A correction is a new note, never
 * an edit: in this domain the record of what was recorded when is evidence.
 */

import {
  visitsFor, scheduleVisit, startVisit, completeVisit, cancelVisit,
  scheduleRequested, addVisitNote, notesForVisit, subjectByKey,
  VISIT_OBSERVATIONS
} from "../db/northwood.mjs";
import { readJson } from "../http.mjs";
import { saasJson, asProfile } from "./shared.mjs";

export const routes = {

  "GET /api/visits": async (req, res, ctx) => {
    const sid = ctx.url.searchParams.get("subject_id");
    if (!sid) return saasJson(res, 400, { error: "subject_id required" });
    return saasJson(res, 200, { visits: visitsFor(sid) });
  },

  "POST /api/visits": async (req, res) => {
    const b = await readJson(req);
    const subject = asProfile(subjectByKey(b.subject_id));
    if (!subject) return saasJson(res, 404, { error: "unknown subject" });
    if (!b.scheduled_at) return saasJson(res, 400, { error: "a date and time is required" });
    const visit = scheduleVisit({
      subject_id: subject.subject_id, scheduled_at: b.scheduled_at,
      officer: b.officer || subject.officer,
      location: b.location || subject.address.split("\n")[0],
      notes: b.notes || null
    });
    return saasJson(res, 200, { visit });
  },

  /* The officer has arrived and is beginning the visit.

     NOT gated on the subject having accepted. Acceptance is an
     acknowledgment, not permission — an officer may turn up to an appointment
     nobody confirmed, and that is often the visit most worth making. */
  "POST /api/visits/start": async (req, res, ctx) => {
    const b = await readJson(req);
    const r = startVisit(Number(b.id), b.officer || ctx.session?.name || null);
    return saasJson(res, r.error ? 409 : 200, r);
  },

  /* What an officer may record, and the values each accepts. Both clients
     build their form from this, so the two cannot drift apart. */
  "ALL /api/visits/observations": async (req, res) =>
    saasJson(res, 200, { observations: VISIT_OBSERVATIONS }),

  /* The officer records that the visit took place. The timestamp is taken
     here, at the moment of recording — never accepted from the caller. */
  "POST /api/visits/complete": async (req, res, ctx) => {
    const b = await readJson(req);
    const id = Number(b.id);
    // A note recorded at completion is the same as any other note — one
    // append-only log per visit, whoever wrote it and whenever.
    if (b.note && String(b.note).trim())
      addVisitNote({ visit_id: id, body: String(b.note).trim(),
                     author: b.officer || ctx.session?.name || null });
    const r = completeVisit(id, b.officer || ctx.session?.name || null, b.observations);
    return saasJson(res, r.error ? 409 : 200,
      r.error ? r : { ...r, notes: notesForVisit(id) });
  },

  /* Add a note at any point, not only at completion. */
  "POST /api/visits/note": async (req, res, ctx) => {
    const b = await readJson(req);
    if (!b.body || !String(b.body).trim())
      return saasJson(res, 400, { error: "a note cannot be empty" });
    const note = addVisitNote({ visit_id: Number(b.id), body: String(b.body).trim(),
                                author: b.officer || ctx.session?.name || null });
    return saasJson(res, 200, { note, notes: notesForVisit(Number(b.id)) });
  },

  /* The officer gives a subject-requested appointment a date. */
  "POST /api/visits/schedule": async (req, res) => {
    const b = await readJson(req);
    if (!b.scheduled_at) return saasJson(res, 400, { error: "a date and time is required" });
    const r = scheduleRequested(Number(b.id), {
      scheduled_at: b.scheduled_at, officer: b.officer, location: b.location });
    return saasJson(res, r.error ? 409 : 200, r);
  },

  "POST /api/visits/cancel": async (req, res) => {
    const b = await readJson(req);
    cancelVisit(Number(b.id));
    return saasJson(res, 200, { ok: true });
  }
};
