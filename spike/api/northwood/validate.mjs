/**
 * Validation shared by both sides of a dual-write module.
 *
 * Employment and family contacts are written by the officer AND by the
 * subject. Two copies of these rules would drift, and the lenient copy would
 * quietly become the way bad data gets in. One set, imported by both.
 */

import { CONTACT_RELATIONSHIPS, EMPLOYMENT_STATUSES } from "../db/northwood.mjs";

/** One rule set for employment, applied to both the officer's endpoint and
 *  the subject's. Returns an error string, or null. */
export function validEmployment(b) {
  const valid = EMPLOYMENT_STATUSES.map(([v]) => v);
  if (!valid.includes(b.status))
    return `status must be one of ${valid.join(", ")}`;
  if (b.status === "employed" && !String(b.company_name || "").trim())
    return "A company name is required for employment.";
  return null;
}

/** One rule set for a contact, applied to both the officer's and the
 *  subject's endpoint. Two copies would drift, and the lenient one would
 *  become the way bad data gets in. Returns an error string, or null. */
export function validContact(b) {
  const name = String(b.name ?? "").trim();
  const phone = String(b.phone ?? "").trim();
  const relationship = String(b.relationship ?? "").trim();
  if (!name) return "A name is required.";
  if (!relationship) return "Choose how this person is related.";
  if (!CONTACT_RELATIONSHIPS.includes(relationship))
    return `"${relationship}" is not a relationship we recognize.`;
  // Deliberately loose: formats vary by country and a rejected real number is
  // worse than an odd-looking one. Only obvious non-numbers are refused.
  if (!phone) return "A phone number is required.";
  if ((phone.match(/\d/g) || []).length < 7)
    return "That phone number looks too short.";
  return null;
}

export const cleanContact = b => ({
  name: String(b.name).trim(),
  relationship: String(b.relationship).trim(),
  phone: String(b.phone).trim(),
  notes: String(b.notes ?? "").trim() || null
});
