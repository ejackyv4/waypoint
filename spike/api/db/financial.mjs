/**
 * Financial obligations — data layer.
 *
 * Everything derived is computed on read. Nothing here stores a balance.
 */

import { all, one, run } from "./connect.mjs";

const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

/**
 * The kinds an officer can raise. Server-owned, like every other vocabulary
 * here — a client that hard-codes this list drifts the first time it changes.
 */
export const FINANCIAL_KINDS = [
  ["fine",             "Fine"],
  ["restitution",      "Restitution"],
  ["court_costs",      "Court costs"],
  ["supervision_fee",  "Supervision fee"],
  ["program_fee",      "Program fee"],
  ["testing_fee",      "Drug testing fee"],
  ["other",            "Other"]
];

/* ---------------- money ----------------
   Integer cents everywhere. A float balance is how somebody ends up owing
   0.009999999999 of a dollar, and it is not recoverable once it is stored. */

/**
 * Parse what a person typed into cents.
 *
 * Accepts "1240", "1,240", "$1,240.50", 1240.5. Rejects anything else rather
 * than guessing — a fine recorded as zero because the input was unparseable
 * is worse than a refused form.
 */
export function toCents(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number")
    return Number.isFinite(v) ? Math.round(v * 100) : null;
  const cleaned = String(v).replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

/** Cents back to something a person reads. Formatting lives in one place. */
export const money = c =>
  (c < 0 ? "-" : "") + "$" + (Math.abs(c) / 100).toLocaleString("en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ---------------- the derived rules ---------------- */

export const paidOn = item =>
  (item.payments || []).reduce((a, p) => a + p.amount_cents, 0);

/**
 * What is left on one item.
 *
 * A waived item owes nothing, but its amount stays on the record — the case
 * file should still say what was originally imposed. Overpayment is clamped
 * at zero so a credit on one item cannot quietly cancel a debt on another.
 */
export const balanceOf = item =>
  item.waived_at ? 0 : Math.max(0, item.amount_cents - paidOn(item));

export const itemState = item => {
  if (item.waived_at) return "waived";
  if (balanceOf(item) === 0) return "paid";
  if (item.due_date && item.due_date < today()) return "overdue";
  return paidOn(item) > 0 ? "part_paid" : "outstanding";
};

/** The whole picture for a subject, which is what both apps display. */
export function totals(items) {
  const owed = items.reduce((a, i) => a + (i.waived_at ? 0 : i.amount_cents), 0);
  const paid = items.reduce((a, i) => a + paidOn(i), 0);
  const balance = items.reduce((a, i) => a + balanceOf(i), 0);
  const overdue = items.filter(i => itemState(i) === "overdue");
  const due = items.filter(i => balanceOf(i) > 0 && i.due_date)
                   .map(i => i.due_date).sort();
  return {
    owed_cents: owed,
    paid_cents: paid,
    balance_cents: balance,
    waived_cents: items.reduce((a, i) => a + (i.waived_at ? i.amount_cents : 0), 0),
    overdue_cents: overdue.reduce((a, i) => a + balanceOf(i), 0),
    overdue_count: overdue.length,
    open_count: items.filter(i => balanceOf(i) > 0).length,
    next_due: due[0] || null
  };
}

const KIND_LABEL = Object.fromEntries(FINANCIAL_KINDS);

/* ---------------- reads ---------------- */

export const paymentsFor = item_id => all(
  `SELECT * FROM financial_payments WHERE item_id = ? ORDER BY paid_on, id`, item_id);

const hydrate = i => {
  if (!i) return null;
  const payments = paymentsFor(i.id);
  const withPayments = { ...i, payments };
  return { ...withPayments,
           // Carried on the row, as the dates module does, so no client has to
           // hold a copy of the vocabulary to render one line.
           kind_label: KIND_LABEL[i.kind] || i.kind,
           paid_cents: paidOn(withPayments),
           balance_cents: balanceOf(withPayments),
           state: itemState(withPayments) };
};

export const financialFor = subject_id => all(
  `SELECT * FROM financial_items WHERE subject_id = ?
    ORDER BY (due_date IS NULL), due_date, id`, subject_id).map(hydrate);

export const financialItemById = id =>
  hydrate(one(`SELECT * FROM financial_items WHERE id = ?`, id));

/** Items plus the totals, which is what every caller actually wants. */
export const financialSummary = subject_id => {
  const items = financialFor(subject_id);
  return { items, totals: totals(items) };
};

/* ---------------- writes ---------------- */

const FIELDS = ["kind", "description", "amount_cents", "due_date"];

export function saveFinancialItem(f, author) {
  if (f.id) {
    // Merge, never overwrite: a payload that omits a field leaves it alone.
    const patch = FIELDS.filter(k => f[k] !== undefined);
    if (patch.length)
      run(`UPDATE financial_items SET ${patch.map(k => `${k}=?`).join(", ")}, updated_at=?
            WHERE id = ?`, ...patch.map(k => f[k]), now(), f.id);
    return financialItemById(f.id);
  }
  run(`INSERT INTO financial_items
         (subject_id, kind, description, amount_cents, due_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?)`,
      f.subject_id, f.kind, f.description ?? null, f.amount_cents,
      f.due_date ?? null, now(), author ?? null);
  return financialItemById(
    one(`SELECT id FROM financial_items WHERE subject_id = ? ORDER BY id DESC LIMIT 1`,
        f.subject_id).id);
}

export function deleteFinancialItem(id) {
  run(`DELETE FROM financial_payments WHERE item_id = ?`, id);
  run(`DELETE FROM financial_items WHERE id = ?`, id);
}

/**
 * Record a payment.
 *
 * `paid_on` is the day the money moved, not the day somebody typed it in —
 * they are frequently not the same day, and a report built on the second one
 * is wrong about every late payment.
 *
 * `role` is who is making the claim. Either party may record a payment: the
 * subject paid at an office and is entering the transaction, or the officer
 * took the money. Those are different claims and the record keeps both apart.
 */
export function addPayment(p, author, role = "officer") {
  run(`INSERT INTO financial_payments
         (item_id, amount_cents, paid_on, method, note,
          recorded_by, recorded_role, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      p.item_id, p.amount_cents, p.paid_on || today(),
      p.method ?? null, p.note ?? null, author ?? null, role, now());
  return financialItemById(p.item_id);
}

/* Append-only in spirit, but a payment entered against the wrong item is a
   typing mistake rather than a fact, and there has to be a way back. */
export const deletePayment = id =>
  run(`DELETE FROM financial_payments WHERE id = ?`, id);

export const paymentById = id =>
  one(`SELECT * FROM financial_payments WHERE id = ?`, id);

/**
 * Waive an obligation, or un-waive it.
 *
 * Its own act with its own author, never a payment of the full amount:
 * "they paid it" and "we stopped requiring it" are different facts about a
 * case, and a report that cannot tell them apart is worth nothing.
 */
export function waiveItem(id, author, note, waive = true) {
  if (waive)
    run(`UPDATE financial_items SET waived_at = ?, waived_by = ?, waived_note = ?,
                                    updated_at = ? WHERE id = ?`,
        now(), author ?? null, note ?? null, now(), id);
  else
    run(`UPDATE financial_items SET waived_at = NULL, waived_by = NULL,
                                    waived_note = NULL, updated_at = ? WHERE id = ?`,
        now(), id);
  return financialItemById(id);
}
