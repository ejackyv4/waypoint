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
  "ALL /api/me/case": subjectOnly(async (req, res, ctx, person) => {
    const sid = person.subject_id;
    const subject = asProfile(subjectByKey(sid));
    if (ctx.url.searchParams.get("seen") === "1") markVisitsSeen(sid);

    return saasJson(res, 200, {
      subject: subject || { subject_id: sid, name: person.name },
      visits: visitsFor(sid),
      unseen_visits: unseenVisitCount(sid),
      // Read-only on their side. They need to know their curfew and what
      // service they owe; they do not get to change either.
      curfew: curfewFor(sid),
      community_service: obligationsFor(sid, "community_service"),
      travel_permit: travelPermitFor(sid),
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
