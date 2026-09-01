/**
 * Financial obligations — the officer's side.
 *
 * What somebody owes is imposed by a court or an agency, so raising, editing
 * and waiving an obligation are the officer's alone. Recording a *payment* is
 * not — the subject paid at an office and is entering the transaction, which
 * is a thing they can do about their own case. That half lives in me.mjs, and
 * the payment carries the role of whoever claimed it.
 */

import { financialFor, financialSummary, financialItemById, saveFinancialItem,
         deleteFinancialItem, addPayment, deletePayment, paymentById,
         waiveItem, toCents, money, FINANCIAL_KINDS } from "../db/financial.mjs";
import { subjectByKey } from "../db/northwood.mjs";
import { readJson } from "../http.mjs";
import { saasJson } from "./shared.mjs";

const KINDS = new Set(FINANCIAL_KINDS.map(([k]) => k));
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d);

/**
 * Record a payment against an item, whoever is claiming it.
 *
 * Exported because me.mjs records the subject's side, and the two must not be
 * separate implementations — the same rule as the employment validator, and
 * for the same reason: neither side gets to be the lenient one.
 */
export function recordPayment(item, b, author, role) {
  const amount_cents = toCents(b.amount);
  if (amount_cents === null || amount_cents <= 0)
    return { error: "Enter a payment amount, like 50 or 50.00." };
  if (b.paid_on && !isDate(b.paid_on))
    return { error: "A payment date must be a calendar date." };
  if (b.paid_on && b.paid_on > new Date().toISOString().slice(0, 10))
    return { error: "A payment cannot be dated in the future." };
  /* Refused rather than clamped: somebody typing 5000 for 50.00 should be
     told, not have a $4,950 credit quietly absorbed. */
  if (amount_cents > item.balance_cents)
    return { error: `That is more than the ${money(item.balance_cents)} `
                  + `outstanding on this item.` };

  return { ok: true, item: addPayment({ item_id: item.id, amount_cents,
             paid_on: b.paid_on, method: b.method, note: b.note }, author, role) };
}

export const routes = {

  "ALL /api/financial": async (req, res, ctx) => {
    const sid = ctx.url.searchParams.get("subject_id");
    if (!sid) return saasJson(res, 400, { error: "subject_id required" });
    return saasJson(res, 200, { ...financialSummary(sid), kinds: FINANCIAL_KINDS });
  },

  "POST /api/financial": async (req, res, ctx) => {
    const b = await readJson(req);
    const editing = !!b.id;
    if (!editing && !subjectByKey(b.subject_id))
      return saasJson(res, 404, { error: "no such subject" });
    if (b.kind !== undefined && !KINDS.has(b.kind))
      return saasJson(res, 400, { error: "not a kind of obligation" });
    if (!editing && !b.kind)
      return saasJson(res, 400, { error: "Choose what kind of obligation this is." });

    /* An amount that cannot be parsed is refused rather than guessed. A fine
       silently recorded as $0 because the field said "twelve hundred" is a
       bug nobody notices until the balance is wrong. */
    let amount_cents;
    if (b.amount !== undefined || !editing) {
      amount_cents = toCents(b.amount);
      if (amount_cents === null)
        return saasJson(res, 400, { error: "Enter an amount, like 1240 or 1,240.50." });
      if (amount_cents <= 0)
        return saasJson(res, 400, { error: "An amount must be more than zero." });
    }
    if (b.due_date && !isDate(b.due_date))
      return saasJson(res, 400, { error: "A due date must be a calendar date." });

    const item = saveFinancialItem({
      id: b.id, subject_id: b.subject_id, kind: b.kind,
      description: b.description, due_date: b.due_date, amount_cents
    }, ctx.session?.name || null);
    return saasJson(res, 200, { item, ...financialSummary(item.subject_id) });
  },

  "POST /api/financial/delete": async (req, res) => {
    const b = await readJson(req);
    const item = financialItemById(Number(b.id));
    if (!item) return saasJson(res, 404, { error: "no such obligation" });
    deleteFinancialItem(item.id);
    return saasJson(res, 200, financialSummary(item.subject_id));
  },

  "POST /api/financial/payment": async (req, res, ctx) => {
    const b = await readJson(req);
    const item = financialItemById(Number(b.item_id));
    if (!item) return saasJson(res, 404, { error: "no such obligation" });
    const r = recordPayment(item, b, ctx.session?.name || null, "officer");
    if (r.error) return saasJson(res, 400, r);
    return saasJson(res, 200, { item: r.item, ...financialSummary(item.subject_id) });
  },

  "POST /api/financial/payment/delete": async (req, res) => {
    const b = await readJson(req);
    const pay = paymentById(Number(b.id));
    if (!pay) return saasJson(res, 404, { error: "no such payment" });
    const item = financialItemById(pay.item_id);
    deletePayment(pay.id);
    return saasJson(res, 200, { item: financialItemById(item.id),
                                ...financialSummary(item.subject_id) });
  },

  /* Waiving is not paying. Its own route, its own timestamp, its own author. */
  "POST /api/financial/waive": async (req, res, ctx) => {
    const b = await readJson(req);
    const item = financialItemById(Number(b.id));
    if (!item) return saasJson(res, 404, { error: "no such obligation" });
    const waive = b.waive !== false;
    if (waive && !String(b.note ?? "").trim())
      return saasJson(res, 400, {
        error: "Say why this is being waived — it stays on the record." });
    const updated = waiveItem(item.id, ctx.session?.name || null, b.note, waive);
    return saasJson(res, 200, { item: updated, ...financialSummary(item.subject_id) });
  }
};
