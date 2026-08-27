/**
 * The supervision agreement — the officer's side.
 *
 * A full document rather than a small form: a header, conditions grouped by
 * category, the consequences of breaching them, and two signatures. Its own
 * page in the console, and its own module here.
 *
 * The subject's half — reading and acknowledging it — lives in me.mjs, because
 * it authenticates completely differently. The document itself is rendered by
 * agreement-doc.mjs, which both sides share so the PDF and the acknowledgment
 * snapshot can never disagree.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  agreementFor, agreementById, saveAgreement, saveCondition, deleteCondition,
  markAmended, obligationFromCondition, signAgreement,
  acknowledgmentsFor, acknowledgmentSnapshot,
  subjectByKey, addDocument, documentsFor,
  activeOffices, activeOfficers,
  CONDITION_CATEGORIES, SUPERVISION_KINDS, SUPERVISION_LEVELS, OBLIGATION_UNITS,
  EMPLOYMENT_STATUSES, CONTACT_RELATIONSHIPS
} from "../db/northwood.mjs";
import { buildPdf } from "../pdf.mjs";
import { CONDITION_TEMPLATES, DEFAULT_VIOLATION_TEXT } from "../templates.mjs";
import { readJson } from "../http.mjs";
import { saasJson, asProfile } from "./shared.mjs";
import { agreementBlocks } from "./agreement-doc.mjs";
import { DOCS_DIR } from "./documents.mjs";

/**
 * Fields that are TERMS of the agreement.
 *
 * `status` is deliberately absent: activating a signed draft is not an
 * amendment of it, and treating it as one would withdraw an acknowledgment
 * every time the document changed state.
 */
const AGREEMENT_TERMS = ["kind","supervision_level","start_date","end_date",
                         "office","officer_name","violation_text"];

export const routes = {

  /* The agreement plus every dropdown the editor needs, in one call. */
  "ALL /api/agreement": async (req, res, ctx) => {
    const sid = ctx.url.searchParams.get("subject_id");
    if (!sid) return saasJson(res, 400, { error: "subject_id required" });
    return saasJson(res, 200, {
      agreement: agreementFor(sid),
      categories: CONDITION_CATEGORIES,
      supervision_kinds: SUPERVISION_KINDS,
      supervision_levels: SUPERVISION_LEVELS,
      obligation_units: OBLIGATION_UNITS,
      employment_statuses: EMPLOYMENT_STATUSES,
      contact_relationships: CONTACT_RELATIONSHIPS,
      offices: activeOffices(),
      officers: activeOfficers(),
      templates: CONDITION_TEMPLATES,
      default_violation_text: DEFAULT_VIOLATION_TEXT
    });
  },

  "POST /api/agreement/save": async (req, res) => {
    const b = await readJson(req);
    if (!b.id && !b.subject_id) return saasJson(res, 400, { error: "subject_id required" });

    // Amending an executed agreement withdraws the subject's acknowledgment —
    // it referred to the text as it stood.
    const isEdit = b.id && AGREEMENT_TERMS.some(f => b[f] !== undefined);
    let amended = false;
    if (isEdit) amended = markAmended(Number(b.id));

    // Activating a document nobody has signed would make the signature
    // decorative. Refuse it rather than allowing a half-executed record.
    if (b.status === "active") {
      const cur = b.id ? agreementById(b.id) : null;
      if (!cur?.officer_signed_at)
        return saasJson(res, 409, {
          error: "Sign the agreement as the supervising officer before activating it." });
    }
    return saasJson(res, 200, { agreement: saveAgreement(b), amended });
  },

  "POST /api/agreement/condition": async (req, res) => {
    const b = await readJson(req);
    if (!b.body || !String(b.body).trim())
      return saasJson(res, 400, { error: "a condition cannot be empty" });
    saveCondition({ ...b, body: String(b.body).trim() });
    const amended = markAmended(Number(b.agreement_id));
    return saasJson(res, 200, { agreement: agreementById(b.agreement_id), amended });
  },

  "POST /api/agreement/condition/delete": async (req, res) => {
    const b = await readJson(req);
    deleteCondition(Number(b.id));
    const amended = markAmended(Number(b.agreement_id));
    return saasJson(res, 200, { agreement: agreementById(Number(b.agreement_id)), amended });
  },

  /* Condition → Requirement. The clause stays as written; what gets tracked
     is the obligation it produces. */
  "POST /api/agreement/condition/track": async (req, res) => {
    const b = await readJson(req);
    const r = obligationFromCondition(b);
    if (r.error) return saasJson(res, 409, r);
    return saasJson(res, 200, { agreement: agreementById(Number(b.agreement_id)) });
  },

  "POST /api/agreement/sign": async (req, res, ctx) => {
    const b = await readJson(req);
    const r = signAgreement(Number(b.id), "officer", ctx.session?.name);
    return saasJson(res, r.error ? 404 : 200, r);
  },

  /* Render to PDF and file it against the subject. A fresh copy each time —
     the document is a snapshot of the agreement as it stood, so an older one
     stays valid evidence of what was acknowledged then. */
  "POST /api/agreement/pdf": async (req, res, ctx) => {
    const b = await readJson(req);
    const a = agreementById(Number(b.id));
    if (!a) return saasJson(res, 404, { error: "no such agreement" });
    const subject = asProfile(subjectByKey(a.subject_id));
    if (!subject) return saasJson(res, 404, { error: "no such subject" });

    const pdf = buildPdf(agreementBlocks(a, subject, CONDITION_CATEGORIES), {
      title: `Conditions of Supervision — ${subject.name}`,
      footer: `${subject.case_number} · ${a.office || "Northwood Corrections"}`
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `supervision-agreement-${a.subject_id}-${stamp}.pdf`;
    await writeFile(join(DOCS_DIR, filename), pdf);

    const doc = addDocument({
      subject_id: a.subject_id, doc_type: "supervision_agreement",
      title: `Conditions of Supervision (${a.status})`,
      filename, byte_size: pdf.length, source_id: a.id,
      created_by: ctx.session?.name || null
    });
    return saasJson(res, 200, { document: doc, documents: documentsFor(a.subject_id) });
  },

  /* Every acceptance the subject has given, newest first. The snapshots are
     the evidence; this lists them without shipping the full text. */
  "ALL /api/agreement/acknowledgments": async (req, res, ctx) => {
    const id = Number(ctx.url.searchParams.get("agreement_id"));
    if (!id) return saasJson(res, 400, { error: "agreement_id required" });
    return saasJson(res, 200, { acknowledgments: acknowledgmentsFor(id) });
  },

  /* One acceptance in full, exactly as the subject read it. */
  "ALL /api/agreement/acknowledgment": async (req, res, ctx) => {
    const row = acknowledgmentSnapshot(Number(ctx.url.searchParams.get("id")));
    if (!row) return saasJson(res, 404, { error: "no such acknowledgment" });
    return saasJson(res, 200, { acknowledgment: row });
  }
};
