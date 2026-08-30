/**
 * The reentry plan — the officer's side.
 *
 * Follows the supervision agreement exactly: its own page in the console, its
 * own module here, the subject's half in me.mjs because it authenticates
 * completely differently, and one shared document renderer so the PDF and the
 * acknowledgment snapshot cannot disagree.
 *
 * What it does NOT share with the agreement is the shape of the work. An
 * agreement is signed once. A plan is worked through over weeks, one
 * checkpoint at a time, each signed off by both parties — so most of the
 * endpoints here act on a single item rather than the document.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  planFor, planById, createPlan, savePlan, saveItem, signItem, signPlan,
  markAmended, isTermsEdit, eventsFor, certifyPlan,
  acknowledgmentsFor, acknowledgmentSnapshot
} from "../db/reentry.mjs";
import { subjectByKey, addDocument, documentsFor, activeOfficers } from "../db/northwood.mjs";
import { REENTRY_AREAS, REENTRY_STATUSES } from "../reentry-template.mjs";
import { buildPdf } from "../pdf.mjs";
import { readJson } from "../http.mjs";
import { saasJson, asProfile } from "./shared.mjs";
import { reentryBlocks } from "./reentry-doc.mjs";
import { DOCS_DIR } from "./documents.mjs";

const VALID_STATUS = new Set(REENTRY_STATUSES.map(([k]) => k));

export const routes = {

  /* The plan plus everything the editor needs to render it, in one call —
     the areas in order, their descriptions, and the status vocabulary. The
     client never hard-codes any of it, so adding an area is a server change. */
  "ALL /api/reentry": async (req, res, ctx) => {
    const sid = ctx.url.searchParams.get("subject_id");
    if (!sid) return saasJson(res, 400, { error: "subject_id required" });
    const plan = planFor(sid);
    return saasJson(res, 200, {
      plan,
      areas: REENTRY_AREAS,
      statuses: REENTRY_STATUSES,
      officers: activeOfficers(),
      events: plan ? eventsFor(plan.id) : [],
      acknowledgments: plan ? acknowledgmentsFor(plan.id) : []
    });
  },

  /* Creating a plan stamps the whole template onto it. There is deliberately
     no "add your own checkpoint" — the template is policy, and a plan whose
     items vary case by case cannot be compared with any other plan. */
  "POST /api/reentry/create": async (req, res, ctx) => {
    const b = await readJson(req);
    if (!b.subject_id) return saasJson(res, 400, { error: "subject_id required" });
    const subject = subjectByKey(b.subject_id);
    if (!subject) return saasJson(res, 404, { error: "no such subject" });
    if (planFor(b.subject_id))
      return saasJson(res, 409, { error: "This subject already has a reentry plan." });
    return saasJson(res, 200, {
      plan: createPlan({ ...b, officer_name: b.officer_name || null },
                       ctx.session?.name || null) });
  },

  "POST /api/reentry/save": async (req, res, ctx) => {
    const b = await readJson(req);
    const cur = planById(Number(b.id));
    if (!cur) return saasJson(res, 404, { error: "no such plan" });

    // Issuing a plan nobody has signed would make the signature decorative,
    // exactly as with the agreement.
    if (b.status === "active" && !cur.officer_signed_at)
      return saasJson(res, 409, {
        error: "Sign the plan as the supervising officer before issuing it." });

    // Amending the terms withdraws the subject's acceptance — what they
    // accepted was the plan as it read then.
    const amended = isTermsEdit(b) ? markAmended(cur.id, ctx.session?.name) : false;
    return saasJson(res, 200, { plan: savePlan(b), amended });
  },

  /* One checkpoint. The officer's assessment of where it stands, plus the
     detail that makes it real — the address, the provider, the appointment. */
  "POST /api/reentry/item": async (req, res, ctx) => {
    const b = await readJson(req);
    if (b.status !== undefined && !VALID_STATUS.has(b.status))
      return saasJson(res, 400, { error: "not a checkpoint status" });
    const r = saveItem(b, ctx.session?.name || null, "officer");
    if (r.error) return saasJson(res, r.error === "no such checkpoint" ? 404 : 400, r);
    return saasJson(res, 200, { ...r, plan: planById(r.item.plan_id) });
  },

  /* The officer signs a checkpoint off. The subject signs the same checkpoint
     from their own session in me.mjs — never here, and never on their
     behalf. */
  "POST /api/reentry/item/sign": async (req, res, ctx) => {
    const b = await readJson(req);
    const r = signItem(Number(b.id), "officer", ctx.session?.name || null);
    if (r.error) return saasJson(res, r.error === "no such checkpoint" ? 404 : 409, r);
    return saasJson(res, 200, { ...r, plan: planById(r.item.plan_id) });
  },

  /* The officer's closing act: everything is done.
     A third signature, and a different one from the two already on the plan —
     the subject's acceptance said "I understand what this asks of me", the
     per-checkpoint signatures said "we agree this piece happened", and this
     says "the whole thing is complete". Only the officer gives it. */
  "POST /api/reentry/certify": async (req, res, ctx) => {
    const b = await readJson(req);
    const r = certifyPlan(Number(b.id), ctx.session?.name || null);
    return saasJson(res, r.error ? 409 : 200, r);
  },

  "POST /api/reentry/sign": async (req, res, ctx) => {
    const b = await readJson(req);
    const r = signPlan(Number(b.id), "officer", ctx.session?.name || null);
    return saasJson(res, r.error ? 404 : 200, r);
  },

  /* Everything that has happened to this plan, newest first. The plan's own
     history is the answer to "how long did housing take" and "who marked this
     ready" — questions no amount of current state can answer. */
  "ALL /api/reentry/history": async (req, res, ctx) => {
    const id = Number(ctx.url.searchParams.get("plan_id"));
    if (!id) return saasJson(res, 400, { error: "plan_id required" });
    return saasJson(res, 200, { events: eventsFor(id) });
  },

  "ALL /api/reentry/acknowledgment": async (req, res, ctx) => {
    const row = acknowledgmentSnapshot(Number(ctx.url.searchParams.get("id")));
    if (!row) return saasJson(res, 404, { error: "no such acknowledgment" });
    return saasJson(res, 200, { acknowledgment: row });
  },

  /* Render to PDF and file it. A fresh copy each time: the document is the
     plan as it stood, so an older one stays valid evidence of what was
     accepted then. */
  "POST /api/reentry/pdf": async (req, res, ctx) => {
    const b = await readJson(req);
    const plan = planById(Number(b.id));
    if (!plan) return saasJson(res, 404, { error: "no such plan" });
    const subject = asProfile(subjectByKey(plan.subject_id));
    if (!subject) return saasJson(res, 404, { error: "no such subject" });

    const pdf = buildPdf(reentryBlocks(plan, subject), {
      title: `Reentry Plan — ${subject.name}`,
      footer: `${subject.case_number} · ${plan.readiness.percent}% ready`
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `reentry-plan-${plan.subject_id}-${stamp}.pdf`;
    await writeFile(join(DOCS_DIR, filename), pdf);

    const doc = addDocument({
      subject_id: plan.subject_id, doc_type: "reentry_plan",
      title: `Reentry Plan (${plan.readiness.percent}% ready)`,
      filename, byte_size: pdf.length, source_id: plan.id,
      created_by: ctx.session?.name || null
    });
    return saasJson(res, 200, { document: doc, documents: documentsFor(plan.subject_id) });
  }
};
