/**
 * A minimal PDF writer — enough for a text document, no dependencies.
 *
 * PDF is a text format: a header, a set of numbered objects, a cross-reference
 * table of their byte offsets, and a trailer. Text is drawn inside a stream
 * with BT/ET, a font, a position and Tj operators.
 *
 * Only the base-14 fonts are used (Helvetica, Helvetica-Bold), which every
 * reader has built in, so nothing needs embedding. Character widths come from
 * the standard AFM tables so wrapping is accurate rather than guessed.
 *
 * Deliberately small. If this ever needs images, tables or Unicode beyond
 * Latin-1, use a real library — that is the point at which hand-rolling stops
 * being sensible.
 */

/* Widths per 1000 units of em, for ASCII 32–126. */
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,
  667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
  278,278,278,469,556,333,
  556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,
  334,260,334,584];

const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,
  722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
  333,278,333,584,556,333,
  556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,
  389,280,389,584];

const widthOf = (ch, bold) => {
  const c = ch.charCodeAt(0);
  if (c < 32 || c > 126) return bold ? 556 : 556;      // anything exotic, assume average
  return (bold ? W_BOLD : W_REG)[c - 32];
};

export const textWidth = (str, size, bold = false) =>
  [...String(str)].reduce((a, ch) => a + widthOf(ch, bold), 0) * size / 1000;

/** Greedy wrap on word boundaries, measured in real glyph widths. */
export function wrap(text, size, maxWidth, bold = false) {
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    if (!para.trim()) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= maxWidth) { line = next; continue; }
      if (line) out.push(line);
      // A single word longer than the line has to be broken somewhere.
      if (textWidth(word, size, bold) > maxWidth) {
        let chunk = "";
        for (const ch of word) {
          if (textWidth(chunk + ch, size, bold) > maxWidth) { out.push(chunk); chunk = ch; }
          else chunk += ch;
        }
        line = chunk;
      } else line = word;
    }
    if (line) out.push(line);
  }
  return out;
}

/* PDF strings escape backslash and both parentheses.
   WinAnsiEncoding covers Latin-1, so accented names pass through; anything
   outside it (typographic dashes, quotes, ellipses) is folded to an ASCII
   equivalent rather than replaced with a question mark. */
const esc = s => String(s ?? "")
  .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
  .replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...")
  .replace(/\u2022/g, "\u00B7")                       // bullet → middle dot
  .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?")
  .replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

const PAGE = { w: 612, h: 792, margin: 62 };            // US Letter, 72dpi

/**
 * Build a document from a simple block list:
 *   { h1 } { h2 } { p } { small } { rule } { gap } { keep }
 */
export function buildPdf(blocks, { title = "Document", footer = "" } = {}) {
  const contentW = PAGE.w - PAGE.margin * 2;
  const pages = [];
  let ops = [], y = PAGE.h - PAGE.margin;

  const newPage = () => { pages.push(ops); ops = []; y = PAGE.h - PAGE.margin; };
  const room = need => y - need > PAGE.margin + 28;

  const draw = (str, x, size, bold) =>
    ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)} Tm (${esc(str)}) Tj ET`);

  for (const b of blocks) {
    if (b.rule) {
      if (!room(14)) newPage();
      y -= 8;
      ops.push(`0.85 0.85 0.85 RG 0.7 w ${PAGE.margin} ${y.toFixed(1)} m ${(PAGE.w - PAGE.margin).toFixed(1)} ${y.toFixed(1)} l S`);
      y -= 12;
      continue;
    }
    if (b.gap != null) { y -= b.gap; if (y < PAGE.margin) newPage(); continue; }

    const size = b.h1 ? 17 : b.h2 ? 12 : b.small ? 8.5 : 10.5;
    const bold = !!(b.h1 || b.h2);
    const lead = b.h1 ? 22 : b.h2 ? 16 : b.small ? 11.5 : 14.5;
    const text = b.h1 || b.h2 || b.p || b.small || "";
    const indent = b.indent || 0;
    const lines = wrap(text, size, contentW - indent, bold);

    // Keep a heading with the first line of what follows it.
    if (b.h2 && !room(lead * 2 + 16)) newPage();
    if (b.h1) y -= 6;

    for (const line of lines) {
      if (!room(lead)) newPage();
      y -= lead;
      if (b.small) ops.push("0.42 0.45 0.5 rg");
      else ops.push("0.06 0.09 0.16 rg");
      draw(line, PAGE.margin + indent, size, bold);
    }
    y -= b.h1 ? 10 : b.h2 ? 4 : 3;
  }
  pages.push(ops);

  /* ---- assemble ---- */
  const total = pages.length;
  const streams = pages.map((page, i) => {
    const f = footer ? `BT /F1 8 Tf 0.55 0.58 0.63 rg 1 0 0 1 ${PAGE.margin} ${PAGE.margin - 22} Tm (${esc(footer)}) Tj ET` : "";
    const n = `BT /F1 8 Tf 0.55 0.58 0.63 rg 1 0 0 1 ${(PAGE.w - PAGE.margin - 52)} ${PAGE.margin - 22} Tm (Page ${i + 1} of ${total}) Tj ET`;
    return page.join("\n") + "\n" + f + "\n" + n;
  });

  const objs = [];
  const add = body => { objs.push(body); return objs.length; };      // 1-indexed

  const fontReg = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const fontBold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const pagesId = objs.length + 1 + streams.length * 2;               // reserved below

  const kids = [];
  for (const s of streams) {
    const cid = add(`<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`);
    const pid = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] `
      + `/Resources << /Font << /F1 ${fontReg} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${cid} 0 R >>`);
    kids.push(pid);
  }
  const pagesObj = add(`<< /Type /Pages /Count ${kids.length} /Kids [${kids.map(k => `${k} 0 R`).join(" ")}] >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  const info = add(`<< /Title (${esc(title)}) /Producer (Waypoint) >>`);

  let out = "%PDF-1.4\n";
  const offsets = [0];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
       + offsets.slice(1).map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
       + `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\n`
       + `startxref\n${xref}\n%%EOF\n`;

  return Buffer.from(out, "latin1");
}
