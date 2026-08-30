/**
 * The reentry plan as a document.
 *
 * Shared by the PDF and by the acknowledgment snapshot, so the thing the
 * subject accepted and the thing filed against their record can never be two
 * different documents. Same arrangement as agreement-doc.mjs, and for the
 * same reason.
 */

import { REENTRY_AREAS, REENTRY_STATUSES } from "../reentry-template.mjs";
import { satisfied, areaStatus, readiness } from "../db/reentry.mjs";

const STATUS_LABEL = Object.fromEntries(REENTRY_STATUSES);

const AREA_LABEL = {
  ready: "Ready", in_progress: "In progress", needs_attention: "Needs attention",
  at_risk: "At risk", not_applicable: "Not applicable"
};

const longDate = d => {
  if (!d) return "";
  const t = new Date(d);
  return isNaN(t) ? String(d)
    : t.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};

export function reentryBlocks(plan, subject) {
  const b = [];
  const r = plan.readiness || readiness(plan.items || []);

  b.push({ h1: "Reentry Plan" });
  b.push({ small: `${subject.name} · ${subject.case_number || ""}` });
  b.push({ rule: true });

  b.push({ p: `Target release: ${longDate(plan.target_release_date) || "not set"}` });
  if (plan.facility) b.push({ p: `Facility: ${plan.facility}` });
  if (plan.officer_name) b.push({ p: `Supervising officer: ${plan.officer_name}` });

  b.push({ p: `Readiness: ${r.percent}% — ${r.complete} of ${r.total} checkpoints complete. `
            + `Critical items: ${r.critical_complete} of ${r.critical_total}. `
            + (r.ready_for_reentry
               ? "All critical requirements are satisfied."
               : "Critical requirements remain outstanding.") });

  b.push({ gap: 6 });
  b.push({ p: "Each checkpoint below is signed off by both the supervising officer "
            + "and the subject. A checkpoint marked verified is not complete until "
            + "both signatures are recorded. Items marked not applicable are excluded "
            + "from the readiness calculation; an approved exception carries a "
            + "documented mitigation plan in place of completion." });
  b.push({ rule: true });

  for (const [key, title, description] of REENTRY_AREAS) {
    const items = (plan.items || []).filter(i => i.area === key);
    if (!items.length) continue;

    b.push({ h2: `${title} — ${AREA_LABEL[areaStatus(items)]}` });
    b.push({ small: description });

    for (const i of items) {
      const mark = satisfied(i) ? "[x]" : "[ ]";
      const bits = [STATUS_LABEL[i.status] || i.status];
      if (i.critical) bits.push("critical");
      if (i.status === "ready" && !satisfied(i)) {
        const who = i.officer_signed_at ? "the subject" : "the officer";
        bits.push(`awaiting signature from ${who}`);
      }
      b.push({ p: `${mark} ${i.label} — ${bits.join(", ")}`, indent: 12 });
      if (i.detail) b.push({ small: i.detail, indent: 28 });
      if (i.status === "exception")
        b.push({ small: `Mitigation: ${i.mitigation} (approved by ${i.approved_by})`,
                 indent: 28 });
      if (satisfied(i) && i.officer_signed_at)
        b.push({ small: `Signed ${longDate(i.officer_signed_at)} by `
                      + `${i.officer_signed_by || "the officer"}, and by the subject `
                      + `${longDate(i.subject_signed_at)}.`, indent: 28 });
    }
    b.push({ gap: 4 });
  }

  if (plan.notes) {
    b.push({ rule: true });
    b.push({ h2: "Notes" });
    b.push({ p: plan.notes });
  }

  b.push({ rule: true });
  b.push({ h2: "Acceptance" });
  b.push({ p: "I have reviewed this reentry plan, I understand what is required of "
            + "me, and I understand that each checkpoint must be signed off by both "
            + "my supervising officer and myself." });
  b.push({ p: plan.officer_signed_at
    ? `Issued by ${plan.officer_signed_by || "the supervising officer"} on `
      + `${longDate(plan.officer_signed_at)}.`
    : "Not yet issued by the supervising officer." });
  b.push({ p: plan.subject_signed_at
    ? `Accepted by ${subject.name} on ${longDate(plan.subject_signed_at)}.`
    : "Not yet accepted by the subject." });

  return b;
}

/** The same document as plain text, for the acknowledgment snapshot. */
export const blocksToText = blocks => blocks.map(x => {
  if (x.rule) return "\n" + "-".repeat(60);
  if (x.gap != null) return "";
  const t = x.h1 || x.h2 || x.p || x.small || "";
  const pad = " ".repeat(Math.round((x.indent || 0) / 12) * 2);
  return x.h1 ? `\n${t.toUpperCase()}\n` : x.h2 ? `\n${t}\n` : pad + t;
}).join("\n");
