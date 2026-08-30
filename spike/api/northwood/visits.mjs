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

import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  visitsFor, scheduleVisit, startVisit, completeVisit, cancelVisit,
  scheduleRequested, addVisitNote, notesForVisit, subjectByKey, visit, updateVisit,
  addVisitPhoto, photosForVisit, photoById,
  addVisitRecording, recordingsFor, recordingById,
  VISIT_OBSERVATIONS
} from "../db/northwood.mjs";
import { buildAgenda, agendaFor, addAgendaItem, removeAgendaItem,
         coverAgendaItem, agendaItemById, suggestedAgenda } from "../db/agenda.mjs";
import { readJson } from "../http.mjs";
import { saasJson, asProfile, subjectFromToken, programsForSubject } from "./shared.mjs";
import { PHOTOS_DIR, AUDIO_DIR } from "./documents.mjs";
import { startTranscription } from "./insights.mjs";

/* A phone camera frame, compressed on the device before it is sent. Generous
   enough for a legible photograph of a doorway or a damaged window, small
   enough that a bad connection on a doorstep still completes. */
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

/* Allowlisted, never sniffed — the same rule as served course content. */
const PHOTO_TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

/* A recording is minutes of conversation rather than one frame, so it gets a
   larger ceiling — but a ceiling all the same. Twenty-five megabytes is around
   half an hour of compressed speech; a visit longer than that wants more than
   one file anyway, and an unbounded upload is a way to fill a disk. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/* What the file is SERVED as, which is not always what it was uploaded as.
   "audio/m4a" is what a phone tends to call it and is not a registered type;
   iOS decides whether it can play a progressive download from the declared
   type, and refuses one it does not recognise — on a URL with no extension to
   fall back on. So the stored value is what the device claimed, and this is
   the canonical type it goes back out as. */
const AUDIO_SERVE_AS = {
  "audio/m4a": "audio/mp4", "audio/x-m4a": "audio/mp4", "audio/mp4": "audio/mp4",
  "audio/aac": "audio/aac", "audio/mpeg": "audio/mpeg", "audio/webm": "audio/webm"
};
const AUDIO_TYPES = { "audio/m4a": ".m4a", "audio/mp4": ".m4a", "audio/aac": ".aac",
                      "audio/mpeg": ".mp3", "audio/webm": ".webm",
                      "audio/x-m4a": ".m4a" };

/**
 * Serve bytes, answering a Range request when one is made.
 *
 * **Why this exists: a browser and an iPhone do not fetch media the same way.**
 *
 * A browser's `<audio>` will happily take a plain `200` with the whole file and
 * buffer it. iOS `AVPlayer` — which `expo-audio` is built on — will not. It
 * opens with a probe (`Range: bytes=0-1`), expects a `206 Partial Content` and
 * a `Content-Range` back, and gives up when it gets a `200` with the lot.
 *
 * So a recording played perfectly in the officer console and did nothing at all
 * in the app, off the same URL, with the same credential. The obvious suspects
 * — the token, the file, the audio session, the silent switch — were all fine.
 * Nothing was broken except that nobody had told this endpoint about ranges.
 *
 * Seeking needs it too: a player cannot jump to the middle of a file it is only
 * ever handed from the start.
 *
 * `Accept-Ranges` is sent whether or not a range was asked for — that header is
 * how a client knows it is allowed to ask. Photos go through here as well: they
 * do not need ranges, but two code paths for "send a file with the right
 * headers" is how one of them ends up missing a header the other has.
 */
function serveBytes(req, res, buf, contentType) {
  const base = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (!range) {
    res.writeHead(200, { ...base, "Content-Length": buf.length });
    /* HEAD gets the headers and no body — AVPlayer asks first, and a body here
       makes it treat the response as malformed. */
    return req.method === "HEAD" ? res.end() : res.end(buf);
  }

  /* "bytes=-500" means the LAST 500, not "from 0 to 500". Getting that backwards
     hands the player the wrong end of the file and it fails without saying why. */
  const suffix = range[1] === "";
  let start = suffix ? buf.length - Number(range[2] || 0) : Number(range[1]);
  let end   = suffix || range[2] === "" ? buf.length - 1 : Number(range[2]);

  start = Math.max(0, start);
  end = Math.min(end, buf.length - 1);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    res.writeHead(416, { ...base, "Content-Range": `bytes */${buf.length}` });
    return res.end();
  }

  res.writeHead(206, {
    ...base,
    "Content-Range": `bytes ${start}-${end}/${buf.length}`,
    "Content-Length": end - start + 1
  });
  return req.method === "HEAD" ? res.end() : res.end(buf.subarray(start, end + 1));
}

export const routes = {

  "GET /api/visits": async (req, res, ctx) => {
    const sid = ctx.url.searchParams.get("subject_id");
    if (!sid) return saasJson(res, 400, { error: "subject_id required" });
    return saasJson(res, 200, { visits: visitsFor(sid) });
  },

  "POST /api/visits": async (req, res) => {
    const b = await readJson(req);

    /* An id means "change this one". Same route as creating, because it is
       the same form and the same fields — a second endpoint would be a second
       place for the rules to drift. */
    if (b.id) {
      if (b.scheduled_at !== undefined && isNaN(new Date(b.scheduled_at)))
        return saasJson(res, 400, { error: "That is not a date and time." });
      const r = updateVisit(Number(b.id), b);
      if (r.error)
        return saasJson(res, r.error === "no such visit" ? 404 : 409, r);
      return saasJson(res, 200, r);
    }

    const subject = asProfile(subjectByKey(b.subject_id));
    if (!subject) return saasJson(res, 404, { error: "unknown subject" });
    if (!b.scheduled_at) return saasJson(res, 400, { error: "a date and time is required" });
    const booked = scheduleVisit({
      subject_id: subject.subject_id, scheduled_at: b.scheduled_at,
      officer: b.officer || subject.officer,
      location: b.location || subject.address.split("\n")[0],
      notes: b.notes || null,
      /* Absent means flexible: a home visit is a day, not an hour, and the
         caller has to say otherwise. */
      time_fixed: b.time_fixed === true || b.time_fixed === 1
    });
    /* Build the agenda now, from the case file as it stands. The officer sees
       what this visit is for the moment it is booked, rather than arriving and
       working it out. */
    buildAgenda(booked.id, subject.subject_id, b.officer || subject.officer,
                { programs: await programsForSubject(subject.subject_id) });
    return saasJson(res, 200, { visit: visit(booked.id) });
  },

  /* What a visit WOULD be about, before one exists. Lets the scheduling form
     show the officer what is outstanding while they are picking a date. */
  "ALL /api/visits/agenda/preview": async (req, res, ctx) => {
    const sid = ctx.url.searchParams.get("subject_id");
    if (!sid) return saasJson(res, 400, { error: "subject_id required" });
    return saasJson(res, 200, {
      items: suggestedAgenda(sid, { programs: await programsForSubject(sid) }) });
  },

  "ALL /api/visits/agenda": async (req, res, ctx) => {
    const id = Number(ctx.url.searchParams.get("visit_id"));
    if (!id) return saasJson(res, 400, { error: "visit_id required" });
    return saasJson(res, 200, { agenda: agendaFor(id) });
  },

  /* Pull in anything raised since the visit was booked. Deliberately an
     action rather than something that happens on read: an agenda that
     rewrites itself is not a record of what was on the table. */
  "POST /api/visits/agenda/refresh": async (req, res, ctx) => {
    const b = await readJson(req);
    const v = visit(Number(b.id));
    if (!v) return saasJson(res, 404, { error: "no such visit" });
    const r = buildAgenda(v.id, v.subject_id, ctx.session?.name || null,
                          { programs: await programsForSubject(v.subject_id) });
    return saasJson(res, 200, { ...r, visit: visit(v.id) });
  },

  /* An officer's own item — something the case file cannot know to suggest. */
  "POST /api/visits/agenda/item": async (req, res, ctx) => {
    const b = await readJson(req);
    const v = visit(Number(b.visit_id));
    if (!v) return saasJson(res, 404, { error: "no such visit" });
    const body = String(b.body ?? "").trim();
    if (!body) return saasJson(res, 400, { error: "An agenda item cannot be empty." });
    addAgendaItem({ visit_id: v.id, body, detail: b.detail },
                  ctx.session?.name || null);
    return saasJson(res, 200, { visit: visit(v.id) });
  },

  "POST /api/visits/agenda/item/delete": async (req, res) => {
    const b = await readJson(req);
    const it = agendaItemById(Number(b.id));
    if (!it) return saasJson(res, 404, { error: "no such agenda item" });
    removeAgendaItem(it.id);
    return saasJson(res, 200, { visit: visit(it.visit_id) });
  },

  /* Marked discussed, with what was said — which is the part anybody reads a
     visit record for. */
  "POST /api/visits/agenda/item/cover": async (req, res, ctx) => {
    const b = await readJson(req);
    const it = agendaItemById(Number(b.id));
    if (!it) return saasJson(res, 404, { error: "no such agenda item" });
    const r = coverAgendaItem(it.id, { covered: b.covered !== false, note: b.note },
                              ctx.session?.name || null);
    return saasJson(res, 200, { ...r, visit: visit(it.visit_id) });
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

  /* A photograph taken during the visit.
     Sent as base64 because the officer is on a phone and this server has no
     multipart parser; the device compresses before sending. Append-only, like
     the notes beside it — see the table comment. */
  "POST /api/visits/photo": async (req, res, ctx) => {
    // base64 inflates by about a third, so the body ceiling sits above the
    // image ceiling; the real check is on the decoded bytes below.
    const b = await readJson(req, Math.ceil(MAX_PHOTO_BYTES * 1.4));
    if (b.__tooBig) return saasJson(res, 413, {
      error: `That photo is too large. The limit is ${MAX_PHOTO_BYTES / 1048576} MB.` });
    const v = visit(Number(b.id));
    if (!v) return saasJson(res, 404, { error: "no such visit" });

    const ext = PHOTO_TYPES[b.mime_type];
    if (!ext) return saasJson(res, 400, {
      error: `Unsupported image type. Send ${Object.keys(PHOTO_TYPES).join(", ")}.` });

    let bytes;
    try { bytes = Buffer.from(String(b.data || ""), "base64"); }
    catch { return saasJson(res, 400, { error: "That image could not be read." }); }
    if (!bytes.length) return saasJson(res, 400, { error: "That image was empty." });
    if (bytes.length > MAX_PHOTO_BYTES)
      return saasJson(res, 413, {
        error: `That photo is ${(bytes.length / 1048576).toFixed(1)} MB. The limit is `
             + `${MAX_PHOTO_BYTES / 1048576} MB — retake it at a lower quality.` });

    /* A generated name, never one the caller supplied: an uploaded filename is
       attacker-controlled and has no business reaching the filesystem. */
    const filename = `visit-${v.id}-${randomUUID()}${ext}`;
    await writeFile(join(PHOTOS_DIR, filename), bytes);

    const photo = addVisitPhoto({
      visit_id: v.id, filename, mime_type: b.mime_type, byte_size: bytes.length,
      caption: String(b.caption || "").trim() || null,
      author: b.officer || ctx.session?.name || null
    });
    return saasJson(res, 200, { photo, photos: photosForVisit(v.id) });
  },

  /**
   * Audio recorded during the visit.
   *
   * Append-only, like the photographs and the notes: there is no delete route,
   * because a recording that can be quietly removed is not evidence and the
   * one somebody wants gone is the one that mattered.
   *
   * Only while the visit is open. A recording filed against a visit that ended
   * an hour ago is a recording of something else.
   */
  "POST /api/visits/recording": async (req, res, ctx) => {
    // base64 inflates by about a third, so the body ceiling sits above the
    // audio ceiling; the real check is on the decoded bytes below.
    const b = await readJson(req, Math.ceil(MAX_AUDIO_BYTES * 1.4));
    if (b.__tooBig) return saasJson(res, 413, {
      error: `That recording is too long to send in one piece. The limit is `
           + `${MAX_AUDIO_BYTES / 1048576} MB — stop and start a new one.` });
    const v = visit(Number(b.id));
    if (!v) return saasJson(res, 404, { error: "no such visit" });
    /* A COMPLETED visit still accepts audio.
     *
     * Ending a visit means the officer left the property; it does not seal the
     * record. The audio was captured at the door — uploading it from a desk an
     * hour later is transfer latency, not a different event, and on a bad
     * connection that gap is the normal case rather than the exception.
     *
     * An earlier version refused this, on a rule that sounded right and was
     * not: it confused WHEN the audio was made with WHEN it arrived. It also
     * bought no integrity, because nothing stops the wrong file being attached
     * to an open visit either.
     *
     * A CANCELLED visit is different in kind: it never took place, so audio
     * from it is a contradiction rather than a late arrival. */
    if (v.status === "cancelled")
      return saasJson(res, 409, {
        error: "This visit was cancelled, so it never took place. A recording "
             + "cannot belong to it." });

    const ext = AUDIO_TYPES[b.mime_type];
    if (!ext) return saasJson(res, 400, {
      error: `Unsupported audio type. Send ${Object.keys(AUDIO_TYPES).join(", ")}.` });

    let bytes;
    try { bytes = Buffer.from(String(b.data || ""), "base64"); }
    catch { return saasJson(res, 400, { error: "That recording could not be read." }); }
    if (!bytes.length) return saasJson(res, 400, { error: "That recording was empty." });
    if (bytes.length > MAX_AUDIO_BYTES)
      return saasJson(res, 413, {
        error: `That recording is ${(bytes.length / 1048576).toFixed(1)} MB. The limit `
             + `is ${MAX_AUDIO_BYTES / 1048576} MB.` });

    /* A generated name, never one the caller supplied. */
    const filename = `visit-${v.id}-${randomUUID()}${ext}`;
    await writeFile(join(AUDIO_DIR, filename), bytes);

    const duration = Number(b.duration_ms);
    const recording = addVisitRecording({
      visit_id: v.id, filename, mime_type: b.mime_type, byte_size: bytes.length,
      duration_ms: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
      note: String(b.note || "").trim() || null,
      author: b.officer || ctx.session?.name || null
    });
    /* Transcribing follows the upload rather than waiting for a button. A step
       that has to be remembered is a step that gets skipped, and audio nobody
       transcribed is audio nobody reads.

       It is fire-and-forget on purpose: the recording is saved and that is what
       the caller asked for. If transcription is unconfigured or fails, the
       recording is still safely stored and the screen offers a Transcribe
       button — the upload must not fail because a downstream service did. */
    startTranscription(recording, recording.author);

    return saasJson(res, 200, { recording, recordings: recordingsFor(v.id) });
  },

  /* The audio itself. Same rule as a photograph: staff may fetch any, a
     subject only one from their own visit. */
  "ALL /visit-recordings/:id": async (req, res, ctx) => {
    const rec = recordingById(Number(ctx.params.id));
    if (!rec) { res.writeHead(404); return res.end("not found"); }

    let allowed = !!ctx.session;
    if (!allowed) {
      const person = await subjectFromToken(req);
      allowed = person && visit(rec.visit_id)?.subject_id === person.subject_id;
    }
    if (!allowed) { res.writeHead(403); return res.end("forbidden"); }

    try {
      const buf = await readFile(join(AUDIO_DIR, rec.filename));
      return serveBytes(req, res, buf,
        AUDIO_SERVE_AS[rec.mime_type] || "application/octet-stream");
    } catch { res.writeHead(404); return res.end("file missing"); }
  },

  /* The image itself. Staff may fetch any; a subject only one from their own
     visit, proven by their Waypoint token rather than by asking nicely. */
  "ALL /visit-photos/:id": async (req, res, ctx) => {
    const photo = photoById(Number(ctx.params.id));
    if (!photo) { res.writeHead(404); return res.end("not found"); }

    let allowed = !!ctx.session;
    if (!allowed) {
      const person = await subjectFromToken(req);
      allowed = person && visit(photo.visit_id)?.subject_id === person.subject_id;
    }
    if (!allowed) { res.writeHead(403); return res.end("forbidden"); }

    try {
      const buf = await readFile(join(PHOTOS_DIR, photo.filename));
      return serveBytes(req, res, buf, photo.mime_type);
    } catch { res.writeHead(404); return res.end("file missing"); }
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
      scheduled_at: b.scheduled_at, officer: b.officer, location: b.location,
      notes: b.notes });
    return saasJson(res, r.error ? 409 : 200, r);
  },

  "POST /api/visits/cancel": async (req, res) => {
    const b = await readJson(req);
    cancelVisit(Number(b.id));
    return saasJson(res, 200, { ok: true });
  }
};
