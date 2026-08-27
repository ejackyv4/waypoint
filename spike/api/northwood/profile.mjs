/**
 * The subject's profile — the roster, and every module on it.
 *
 * Vehicles, curfew, community service, travel permits, employment, family
 * contacts and generated documents.
 *
 * WHO WRITES WHAT is a decision, not an accident:
 *
 *   officer writes, subject reads   curfew, travel permit, community service
 *   subject writes, officer reads   vehicles
 *   both write ONE record           employment, family contacts
 *
 * The dual-write pairs are the interesting ones. Their subject-facing halves
 * live in me.mjs and share `validate.mjs` with this file — two copies of the
 * rules would drift, and the lenient copy becomes the way bad data gets in.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  allSubjects, subjectByKey, saveSubject,
  vehiclesFor, saveVehicle, deleteVehicle, vehicleById,
  curfewFor, saveCurfew,
  obligationsFor, saveObligation, deleteObligation,
  travelPermitFor, saveTravelPermit, TRAVEL_LEVELS,
  employmentFor, saveEmployment,
  contactsFor, contactById, saveContact, deleteContact,
  documentsFor, documentById,
  activeOffices, activeOfficers,
  SUPERVISION_KINDS, SUPERVISION_LEVELS, OBLIGATION_UNITS,
  EMPLOYMENT_STATUSES, CONTACT_RELATIONSHIPS, CONDITION_CATEGORIES
} from "../db/northwood.mjs";
import { APP_ORIGIN } from "../config.mjs";
import { readJson } from "../http.mjs";
import { saasJson, asProfile, waypoint } from "./shared.mjs";
import { validEmployment, validContact, cleanContact } from "./validate.mjs";
import { DOCS_DIR } from "./documents.mjs";

/**
 * Mark which subjects can actually sign in.
 *
 * Waypoint owns that fact, so it is asked — but once for the whole roster,
 * not once per row. A failure leaves the flag undefined rather than claiming
 * nobody has a login.
 */
async function withLogins(subjects) {
  const r = await waypoint("/api/logins").catch(() => null);
  if (!r || r.status !== 200) return subjects;
  const has = new Set(r.body.subject_ids || []);
  return subjects.map(s => ({ ...s, has_login: has.has(s.subject_id) }));
}

export const routes = {

  "ALL /api/subjects": async (req, res) =>
    saasJson(res, 200, { subjects: await withLogins(allSubjects().map(asProfile)) }),

  /* The subject's own details. Demographics an officer maintains — not the
     assignment decisions (which officer, which programs), which are made
     elsewhere and are not editable from a form. */
  "POST /api/subject": async (req, res) => {
    const b = await readJson(req);
    if (!b.subject_id) return saasJson(res, 400, { error: "subject_id required" });
    if (!subjectByKey(b.subject_id))
      return saasJson(res, 404, { error: "no such subject" });

    if (b.first_name !== undefined && !String(b.first_name).trim())
      return saasJson(res, 400, { error: "A first name is required." });
    if (b.last_name !== undefined && !String(b.last_name).trim())
      return saasJson(res, 400, { error: "A last name is required." });

    /* Dates are stored ISO and formatted on display. Storing "17 April 1991"
       gives you a string you cannot compare, sort, or turn into an age. */
    for (const f of ["dob", "intake_date", "next_review"])
      if (b[f] && !/^\d{4}-\d{2}-\d{2}$/.test(b[f]))
        return saasJson(res, 400, { error: `${f} must be a date (YYYY-MM-DD)` });

    if (b.dob && new Date(b.dob) > new Date())
      return saasJson(res, 400, { error: "A date of birth cannot be in the future." });

    if (b.email && !/^\S+@\S+\.\S+$/.test(String(b.email).trim()))
      return saasJson(res, 400, { error: "That email address doesn't look right." });

    return saasJson(res, 200, { subject: asProfile(saveSubject(b.subject_id, b)) });
  },

  /* Every profile module in one call — the profile paints them together, and
     six round trips to draw one screen is six chances to look half-loaded. */
  "ALL /api/subject/detail": async (req, res, ctx) => {
    const sid = ctx.url.searchParams.get("subject_id");
    if (!sid) return saasJson(res, 400, { error: "subject_id required" });
    return saasJson(res, 200, {
      vehicles: vehiclesFor(sid),
      curfew: curfewFor(sid),
      community_service: obligationsFor(sid, "community_service"),
      travel_permit: travelPermitFor(sid),
      employment: employmentFor(sid),
      contacts: contactsFor(sid)
    });
  },

  /* Every dropdown's options, in one place. A client that hardcodes these
     drifts from the server the first time a list changes. */
  "ALL /api/reference": async (req, res) =>
    saasJson(res, 200, {
      supervision_kinds: SUPERVISION_KINDS,
      supervision_levels: SUPERVISION_LEVELS,
      obligation_units: OBLIGATION_UNITS,
      employment_statuses: EMPLOYMENT_STATUSES,
      contact_relationships: CONTACT_RELATIONSHIPS,
      condition_categories: CONDITION_CATEGORIES,
      offices: activeOffices(),
      officers: activeOfficers()
    }),

  /* ---- vehicles: the subject maintains their own, the officer can correct ---- */
  "POST /api/vehicles": async (req, res) => {
    const b = await readJson(req);
    if (!b.id && !b.subject_id) return saasJson(res, 400, { error: "subject_id required" });
    // Editing a row that is gone used to UPDATE nothing and answer 200 with
    // an empty body — a save reported as successful that saved nothing.
    if (b.id && !vehicleById(Number(b.id)))
      return saasJson(res, 404, { error: "That vehicle has already been removed." });
    const vehicle = saveVehicle({ ...b, id: b.id ? Number(b.id) : undefined });
    return saasJson(res, 200, { vehicle, vehicles: vehiclesFor(vehicle.subject_id) });
  },

  "POST /api/vehicles/delete": async (req, res) => {
    const b = await readJson(req);
    const existing = vehicleById(Number(b.id));
    if (!existing) return saasJson(res, 404, { error: "That vehicle has already been removed." });
    deleteVehicle(Number(b.id));
    return saasJson(res, 200, { ok: true, vehicles: vehiclesFor(existing.subject_id) });
  },

  /* ---- curfew: imposed, so read-only on the subject's side ---- */
  "POST /api/curfew": async (req, res) => {
    const b = await readJson(req);
    if (!b.subject_id) return saasJson(res, 400, { error: "subject_id required" });
    if (b.active && !(b.start_time && b.end_time))
      return saasJson(res, 400, { error: "a curfew needs a start and an end time" });
    return saasJson(res, 200, { curfew: saveCurfew(b) });
  },

  /* ---- travel permit ---- */
  "POST /api/travel-permit": async (req, res, ctx) => {
    const b = await readJson(req);
    if (!b.subject_id) return saasJson(res, 400, { error: "subject_id required" });
    if (!TRAVEL_LEVELS.includes(b.level))
      return saasJson(res, 400, { error: `level must be one of ${TRAVEL_LEVELS.join(", ")}` });
    // "None" is a permission level, not an absence of one — it should not
    // carry an expiry date that implies it lapses into something else.
    const expires_on = b.level === "none" ? null : (b.expires_on || null);
    return saasJson(res, 200, {
      travel_permit: saveTravelPermit({ ...b, expires_on,
                                        issued_by: b.issued_by || ctx.session?.name || null }) });
  },

  /* ---- obligations: one general table, community service is one kind ---- */
  "POST /api/obligations": async (req, res) => {
    const b = await readJson(req);
    if (!b.title || !String(b.title).trim())
      return saasJson(res, 400, { error: "a title is required" });
    if (!b.id && !b.subject_id) return saasJson(res, 400, { error: "subject_id required" });
    const ok = ["todo", "in_progress", "complete"];
    if (b.status && !ok.includes(b.status))
      return saasJson(res, 400, { error: `status must be one of ${ok.join(", ")}` });
    return saasJson(res, 200, { obligation: saveObligation(b) });
  },

  "POST /api/obligations/delete": async (req, res) => {
    const b = await readJson(req);
    deleteObligation(Number(b.id));
    return saasJson(res, 200, { ok: true });
  },

  /* ---- employment: both sides write one record ---- */
  "POST /api/employment": async (req, res) => {
    const b = await readJson(req);
    if (!b.subject_id) return saasJson(res, 400, { error: "subject_id required" });
    const bad = validEmployment(b);
    if (bad) return saasJson(res, 400, { error: bad });
    return saasJson(res, 200, { employment: saveEmployment(b, "officer") });
  },

  /* ---- family contacts: both sides write one list ---- */
  "POST /api/contacts":        contactsHandler,
  "POST /api/contacts/delete": contactsHandler,

  /* ---- documents ---- */
  "ALL /api/documents": async (req, res, ctx) => {
    const sid = ctx.url.searchParams.get("subject_id");
    if (!sid) return saasJson(res, 400, { error: "subject_id required" });
    return saasJson(res, 200, { documents: documentsFor(sid) });
  },

  /* Download. Staff may fetch any document; a subject only their own, proven
     by their Waypoint token rather than by asking nicely. */
  "ALL /documents/:id": async (req, res, ctx) => {
    const doc = documentById(Number(ctx.params.id));
    if (!doc) { res.writeHead(404); return res.end("not found"); }

    let allowed = !!ctx.session;
    if (!allowed) {
      const who = await fetch(`${APP_ORIGIN}/api/me`,
        { headers: { Authorization: req.headers["authorization"] || "" } })
        .then(r => r.ok ? r.json() : null).catch(() => null);
      allowed = who?.person?.subject_id === doc.subject_id;
    }
    if (!allowed) { res.writeHead(403); return res.end("forbidden"); }

    try {
      const buf = await readFile(join(DOCS_DIR, doc.filename));
      res.writeHead(200, {
        "Content-Type": doc.mime_type,
        "Content-Length": buf.length,
        "Cache-Control": "no-store",
        // inline so it opens in the browser's viewer rather than downloading
        "Content-Disposition": `inline; filename="${doc.filename}"`
      });
      return res.end(buf);
    } catch { res.writeHead(404); return res.end("file missing"); }
  }
};

async function contactsHandler(req, res, ctx) {
  const b = await readJson(req);
  if (ctx.url.pathname.endsWith("/delete")) {
    const existing = contactById(Number(b.id));
    if (!existing) return saasJson(res, 404, { error: "no such contact" });
    deleteContact(Number(b.id));
    return saasJson(res, 200, { ok: true, contacts: contactsFor(existing.subject_id) });
  }
  if (!b.subject_id && !b.id) return saasJson(res, 400, { error: "subject_id required" });
  const bad = validContact(b);
  if (bad) return saasJson(res, 400, { error: bad });
  const sid = b.id ? contactById(Number(b.id))?.subject_id : b.subject_id;
  if (!sid) return saasJson(res, 404, { error: "no such contact" });
  const contact = saveContact({ ...b, id: b.id ? Number(b.id) : undefined,
                                subject_id: sid, ...cleanContact(b) }, "officer");
  return saasJson(res, 200, { contact, contacts: contactsFor(sid) });
}

export { withLogins };
