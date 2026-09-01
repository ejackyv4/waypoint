/**
 * The pieces every Northwood route module needs.
 *
 * Deliberately thin. This is not a place to put things that only one module
 * uses — a shared file that accumulates everything is just the big file again
 * with an extra import.
 */

import { randomInt } from "node:crypto";
import { API_KEY } from "../auth.mjs";
import { APP_ORIGIN, APP_INTERNAL_ORIGIN } from "../config.mjs";
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
 *
 * Addressed internally: this is one process on the box calling another, and
 * routing it through the public hostname would send it back in through the
 * reverse proxy to be judged by the front-door allowlist. See
 * `APP_INTERNAL_ORIGIN`. In development the two are the same address.
 */
export const waypoint = (path, init = {}) => fetch(`${APP_INTERNAL_ORIGIN}${path}`, {
  ...init,
  headers: { "Content-Type": "application/json",
             Authorization: `Bearer ${API_KEY}`, ...(init.headers || {}) }
}).then(async r => ({ status: r.status, body: await r.json() }));

/** Shape a subject row the way the UI expects it. */
export const asProfile = r => r && ({
  subject_id: r.subject_id, case_number: r.case_number,
  name: r.name || [r.first_name, r.last_name].filter(Boolean).join(" "),
  first_name: r.first_name, last_name: r.last_name,
  dob: r.dob, phone: r.phone, email: r.email,
  status: r.status, officer: r.officer,
  intake: r.intake_date, review: r.next_review,
  // The parts, so a form can edit them...
  address_line1: r.address_line1, address_line2: r.address_line2,
  city: r.city, state: r.state, postal_code: r.postal_code,
  // ...and the assembled version, so a card can print it. City, ST ZIP —
  // the US last line, not three things joined by commas.
  address: [r.address_line1, r.address_line2,
            [[r.city, r.state].filter(Boolean).join(", "), r.postal_code]
              .filter(Boolean).join(" ")]
             .filter(Boolean).join("\n")
});

/**
 * Who a Waypoint token belongs to.
 *
 * Token introspection: Northwood asks Waypoint rather than trusting what the
 * app claims. The subject never tells us who they are — that is the whole
 * point, and it is why `subject_id` is never read from a request body on the
 * /api/me routes.
 *
 * Internally addressed, for the reason given on `waypoint()` above: sending
 * this out to the public hostname put it in front of the IP allowlist, which
 * refused it, which this function could only read as "bad token". Every screen
 * in the app then reported an expired session, on a token that was perfectly
 * valid.
 *
 * A refusal and an unreachable Waypoint are therefore logged rather than
 * swallowed. Both mean nobody can use the app, and neither says so anywhere a
 * person would look — the previous version returned null for any failure and
 * the only visible symptom was in the wrong place entirely.
 */
export async function subjectFromToken(req) {
  let r;
  try {
    r = await fetch(`${APP_INTERNAL_ORIGIN}/api/me`, {
      headers: { Authorization: req.headers["authorization"] || "" }
    });
  } catch (e) {
    console.error(`[northwood] cannot reach Waypoint at ${APP_INTERNAL_ORIGIN} `
                + `to identify the caller: ${e.message}. Every subject will be `
                + `told their session expired until this is fixed.`);
    return null;
  }
  /* 401 is the ordinary answer for a token that really has expired. Anything
     else is an infrastructure problem wearing a token problem's clothes. */
  if (!r.ok && r.status !== 401)
    console.error(`[northwood] Waypoint answered ${r.status} when asked who a `
                + `caller is (${APP_INTERNAL_ORIGIN}/api/me). A 403 here is `
                + `usually the front-door allowlist refusing the server itself.`);
  if (!r.ok) return null;
  const who = await r.json().catch(() => null);
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

/**
 * A subject's training, fetched from Waypoint over its API.
 *
 * Northwood has no access to Waypoint's tables — it is a customer, and asks
 * over HTTP like any other integrator. Returns an empty list if Waypoint is
 * unreachable rather than throwing: a case file should still open, and an
 * agenda should still be built, when the LMS happens to be down.
 *
 * Lives here because both the visit agenda and the case file need it, and two
 * copies of a cross-boundary fetch is two places for its error handling to
 * drift.
 */
export async function programsForSubject(subject_id) {
  try {
    const r = await waypoint("/api/status");
    if (r.status !== 200) return [];
    return (r.body?.enrollments || []).filter(e => e.subject_id === subject_id);
  } catch { return []; }
}
