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
   not the missing half — three bugs here had working error paths and no
   success message at all, and read as dead buttons. So this looks
   specifically for a positive signal.
 *
 * Brackets are matched rather than pattern-matched. Three regexes were tried
 * first and each was wrong in its own way: `.*` in a lookahead read past the
 * call it was inspecting; `[^)]*` stopped at the first bracket, so a toast
 * containing `String(e)` hid its own `"err"` and an error toast counted as a
 * success. A checker that is subtly wrong is worse than none — it is the
 * thing that teaches people to ignore the output — so this one counts
 * brackets, which is not clever and is right. */

/** Every `toast(...)` / `Alert.alert(...)` call in a block, with its arguments. */
function callsTo(name, text) {
  const out = [];
  const needle = name + "(";
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    let depth = 0, j = i + needle.length - 1;
    for (; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")" && --depth === 0) break;
    }
    if (j < text.length) out.push(text.slice(i + needle.length, j));
  }
  return out;
}

/**
 * Does this block tell the user something worked?
 *
 * A toast counts unless it is an error toast. An Alert counts unless it is
 * reporting a failure or asking a question — an "Are you sure?" nearby used to
 * satisfy this check, which meant a genuinely silent save sitting beside one
 * went unreported.
 */
function confirmsSuccess(block) {
  for (const args of callsTo("toast", block))
    if (!/,\s*"err"\s*$/.test(args.trim())) return true;
  for (const args of callsTo("Alert.alert", block)) {
    const a = args.trim();
    if (/^"Couldn/.test(a) || /style:\s*"cancel"/.test(a)) continue;
    if (/^["`']/.test(a)) return true;
  }
  return false;
}

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
    /* Look forward far enough to cover the try/catch this POST sits in.
     *
     * Tested as one joined block, not line by line: a `toast(...)` written
     * across three lines is a perfectly good confirmation and this checker
     * used to call it a missing one. A false alarm in a checker is worse than
     * no checker — it is the thing that teaches people to ignore the output.
     *
     * Newlines are collapsed rather than the regex being made multiline, so
     * `[^)]*` still cannot run away across half a file looking for a bracket. */
    const window = lines.slice(Math.max(0, i - 14), i + 26)
                        .join(" ").replace(/\s+/g, " ");
    if (confirmsSuccess(window)) return;

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
