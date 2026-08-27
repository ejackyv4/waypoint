/**
 * The supervision agreement as a document.
 *
 * One rendering, two outputs: the PDF filed against the subject, and the
 * plain-text snapshot stored with every acknowledgment. They MUST come from
 * the same blocks — a snapshot that could drift from the document the subject
 * signed is worse than no snapshot, because it would be believed.
 *
 * That is why this is its own module rather than living next to either
 * consumer: neither owns it.
 */

import { CONDITION_CATEGORIES } from "../db/northwood.mjs";

/** Turn an agreement into the blocks the PDF writer understands. */
export function agreementBlocks(a, subject, categories) {
  const d = v => v ? new Date(v + "T00:00:00").toLocaleDateString("en-US") : "—";
  const stamp = v => v ? new Date(v).toLocaleString("en-US") : null;
  const byCat = {};
  (a.conditions || []).forEach(c => (byCat[c.category] ||= []).push(c));

  const blocks = [
    { h1: "Conditions of Supervision" },
    { small: `${a.office || "Northwood Corrections"}` },
    { rule: true },
    { h2: "Supervision Information" },
    { p: `Subject: ${subject.name}` },
    { p: `Case number: ${subject.case_number}` },
    { p: `Supervision type: ${a.kind}` },
    { p: `Supervision level: ${a.supervision_level || "—"}` },
    { p: `Period: ${d(a.start_date)} to ${d(a.end_date)}` },
    { p: `Supervising officer: ${a.officer_name || "—"}` },
    { rule: true }
  ];

  let n = 0;
  for (const [key, label] of categories) {
    const list = byCat[key] || [];
    if (!list.length) continue;
    blocks.push({ h2: label });
    for (const c of list) {
      blocks.push({ p: `${++n}.  ${c.body}`, indent: 0 });
      if (c.obligation_title)
        blocks.push({ small: `Tracked as: ${c.obligation_title}`
          + (c.required_quantity ? ` (${c.required_quantity} ${c.unit || ""})` : ""), indent: 18 });
    }
  }

  if (a.violation_text) {
    blocks.push({ rule: true }, { h2: "Violation Consequences" }, { p: a.violation_text });
  }

  blocks.push({ rule: true }, { h2: "Acknowledgment" },
    { p: "I acknowledge that the conditions of supervision set out above have been "
       + "explained to me, that I have read them or had them read to me, and that I "
       + "understand them." },
    { gap: 10 },
    { p: `Subject: ${subject.name}` },
    { small: a.subject_signed_at
        ? `Acknowledged electronically on ${stamp(a.subject_signed_at)}`
        : "Not yet acknowledged" },
    { gap: 8 },
    { p: `Supervising officer: ${a.officer_signed_by || a.officer_name || "—"}` },
    { small: a.officer_signed_at
        ? `Signed electronically on ${stamp(a.officer_signed_at)}`
        : "Not yet signed" });

  return blocks;
}
/** The same blocks the PDF is built from, flattened to plain text. One
 *  rendering, two outputs — a snapshot that could drift from the document is
 *  worse than no snapshot. */
export const blocksToText = blocks => blocks.map(b =>
  b.rule ? "\n" + "-".repeat(64) :
  b.gap != null ? "" :
  b.h1 ? `\n${b.h1.toUpperCase()}\n` :
  b.h2 ? `\n${b.h2}\n` :
  b.small ? `    ${b.small}` :
  `${" ".repeat(b.indent ? 4 : 0)}${b.p ?? ""}`).join("\n");