#!/usr/bin/env node
/**
 * Every write must say whether it worked.
 *
 * Three separate bugs on this project were "the save worked but the screen
 * re-rendered identically, so it looked broken". Clicking found all three;
 * nothing caught them automatically. This does.
 *
 * It reads each UI file, finds every POST, and checks the enclosing function
 * reaches some form of user feedback. Crude — it works on text, not an AST —
 * but it fails loudly when someone adds a write and forgets to confirm it.
 *
 *   node spike/api/check-feedback.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = [
  ["spike/api/saas.html",    join(HERE, "saas.html")],
  ["spike/api/learner.html", join(HERE, "learner.html")],
  ["spike/mobile/App.js",    join(HERE, "..", "mobile", "App.js")]
];

/* A save needs to confirm SUCCESS, not just report failure. Error handling is
   the easy half and was never the missing half — every silent-save bug on this
   project had working error handling and no success message. So the check is
   specifically for a positive signal: a toast (or native Alert) that is not
   tagged as an error. */
const SUCCESS = /\btoast\s*\(\s*(?!.*,\s*"err"\s*\))[^)]*\)|Alert\.alert\s*\(\s*"(?!Couldn)/;

/* Writes that are navigations rather than saves: the new screen IS the
   confirmation. Anything else needing an exemption marks itself in the source
   with `no-confirm: <reason>`, so the reason lives next to the code rather
   than in a list here that nobody reading the code will ever see. */
const EXEMPT = [
  "/api/auth/login",      // navigates to the signed-in view
  "/auth/login",
  "/auth/logout",
  "/api/me/launch",       // navigates into the course
  "/api/runtime/",        // the SCORM runtime talks to itself
  "no-confirm:"
];

let problems = 0, checked = 0;

for (const [label, path] of FILES) {
  let src;
  try { src = readFileSync(path, "utf8"); } catch { continue; }
  const lines = src.split("\n");

  lines.forEach((line, i) => {
    if (!/method:\s*"POST"/.test(line)) return;

    // The URL is usually on this line or the one above.
    const context = lines.slice(Math.max(0, i - 6), i + 4).join("\n");
    if (EXEMPT.some(e => context.includes(e))) return;

    checked++;
    // Look forward far enough to cover the try/catch this POST sits in.
    const window = lines.slice(Math.max(0, i - 14), i + 26)
                        .filter(l => SUCCESS.test(l));
    if (window.length) return;

    problems++;
    console.log(`  \x1b[31m✕\x1b[0m ${label}:${i + 1} — saves without confirming it worked`);
    console.log(`      ${(lines[i - 1] || lines[i]).trim().slice(0, 88)}`);
  });
}

if (problems) {
  console.log(`\n  ${problems} of ${checked} writes never tell the user they succeeded. `
            + `A save that looks identical to doing nothing is a bug.\n`);
  process.exit(1);
}
console.log(`\n  \x1b[32m✓\x1b[0m all ${checked} writes confirm success\n`);
