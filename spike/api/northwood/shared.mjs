/**
 * The pieces every Northwood route module needs.
 *
 * Deliberately thin. This is not a place to put things that only one module
 * uses — a shared file that accumulates everything is just the big file again
 * with an extra import.
 */

import { randomInt } from "node:crypto";
import { API_KEY } from "../auth.mjs";
import { APP_ORIGIN } from "../config.mjs";
import { jsonTo } from "../http.mjs";

/** Only the Waypoint app origin may read Northwood's API. Never "*". */
export const saasJson = jsonTo(APP_ORIGIN);

/**
 * Every call Northwood makes to Waypoint goes through here.
 *
 * This function IS the integration. It holds the API key server-side — the
 * browser never sees it, which is the whole reason Northwood is a server and
 * not a page — and it is the only way Northwood may reach the LMS. There is
 * no import that would let it do otherwise; `check-boundary.mjs` proves it.
 */
export const waypoint = (path, init = {}) => fetch(`${APP_ORIGIN}${path}`, {
  ...init,
  headers: { "Content-Type": "application/json",
             Authorization: `Bearer ${API_KEY}`, ...(init.headers || {}) }
}).then(async r => ({ status: r.status, body: await r.json() }));

/** Shape a subject row the way the UI expects it. */
export const asProfile = r => r && ({
  subject_id: r.subject_id, name: r.name, case_number: r.case_number,
  dob: r.dob, phone: r.phone, status: r.status, officer: r.officer,
  intake: r.intake_date, review: r.next_review,
  address: [r.address_line1, [r.city, r.state, r.postal_code].filter(Boolean).join(", ")]
             .filter(Boolean).join("\n")
});

/**
 * Who a Waypoint token belongs to.
 *
 * Token introspection: Northwood asks Waypoint rather than trusting what the
 * app claims. The subject never tells us who they are — that is the whole
 * point, and it is why `subject_id` is never read from a request body on the
 * /api/me routes.
 */
export async function subjectFromToken(req) {
  const who = await fetch(`${APP_ORIGIN}/api/me`, {
    headers: { Authorization: req.headers["authorization"] || "" }
  }).then(r => r.ok ? r.json() : null).catch(() => null);
  return who?.person?.subject_id ? who.person : null;
}

/* Readable, not clever — this gets read aloud during a demo. But it is still a
   credential, so the randomness is cryptographic: Math.random() is a
   predictable PRNG, and a predictable password is not a password. */
export function makePassword() {
  const words = ["fairway", "birdie", "eagle", "putter", "bunker", "caddie", "albatross"];
  const [a, b] = [randomInt(words.length), randomInt(9000)];
  return words[a] + String(b + 1000);
}
