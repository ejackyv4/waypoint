/**
 * Northwood Corrections — the customer's own system.
 *
 * Subjects, visits, supervision agreements, and the profile modules. This is
 * NOT part of Waypoint; it is the reference for what a customer builds.
 *
 * THE BOUNDARY IS THE POINT. Northwood reaches Waypoint the same way any
 * integrator would — over HTTP, with an API key held server-side — and imports
 * none of its data functions. If that stops being true, the claim that these
 * are two systems stops being true with it, and the integration contract is no
 * longer exercised by anything. `check-boundary.mjs` fails the build on it.
 *
 * This file is composition only: CORS, who is signed in, the staff gate, and
 * the route table. Every handler lives in northwood/ — one module per domain,
 * so the shape of the system is legible from the directory listing rather than
 * reconstructed by reading a thousand lines top to bottom.
 */

import { createServer } from "node:http";
import { staffSession } from "./db/northwood.mjs";
import { STAFF_COOKIE, hashToken, parseCookies, allow } from "./auth.mjs";
import { APP_ORIGIN, SAAS_ORIGIN } from "./config.mjs";
import { guard, createRouter } from "./http.mjs";
import { saasJson } from "./northwood/shared.mjs";

import { routes as authRoutes }      from "./northwood/auth.mjs";
import { routes as pageRoutes }      from "./northwood/pages.mjs";
import { routes as profileRoutes }   from "./northwood/profile.mjs";
import { routes as agreementRoutes } from "./northwood/agreement.mjs";
import { routes as visitRoutes }     from "./northwood/visits.mjs";
import { routes as officerRoutes }   from "./northwood/officer.mjs";
import { routes as meRoutes }        from "./northwood/me.mjs";
import { routes as lmsRoutes }       from "./northwood/lms.mjs";

import "./northwood/seed.mjs";
export { seedSubjectLogins } from "./northwood/seed.mjs";

/**
 * The whole API, in one place.
 *
 * Built once at module load, so a duplicate route is a startup error rather
 * than a branch that silently never runs — which is what a second `if` for the
 * same path was, with nothing to say so.
 */
const router = createRouter("northwood")
  .mount(authRoutes)        // staff sign-in
  .mount(pageRoutes)        // the console itself
  .mount(profileRoutes)     // the roster and every module on a subject
  .mount(agreementRoutes)   // supervision agreement, officer side
  .mount(visitRoutes)       // visits, officer side
  .mount(officerRoutes)     // an officer's own schedule and caseload
  .mount(meRoutes)          // the subject's own view — Waypoint token, not a session
  .mount(lmsRoutes);        // everything Northwood does WITH the LMS

export const saas = createServer(guard("northwood", saasJson, async (req, res) => {
  const url = new URL(req.url, SAAS_ORIGIN);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": APP_ORIGIN,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      // Authorization is NOT a CORS-safelisted header, so it must be named
      // here or every authenticated call fails at preflight.
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    return res.end();
  }

  /* Who is signed in, if anyone. Cookie first (browser), bearer second
     (native app) — both resolve to the same session row. */
  const cookies = parseCookies(req.headers.cookie);
  const bearer = (req.headers["authorization"] || "").startsWith("Bearer ")
    ? req.headers["authorization"].slice(7) : null;
  const rawToken = cookies[STAFF_COOKIE] || bearer;
  const session = rawToken ? staffSession(hashToken(rawToken)) : null;

  /* ---- the staff gate ---------------------------------------------------
     Everything under /api/ is staff-only EXCEPT /api/me/*, which carries a
     Waypoint token instead, and the webhook, which carries an HMAC signature.

     Gating in one place means a new staff route is protected by default,
     rather than by whoever adds it remembering to protect it. */
  if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/me/")) {
    const gate = allow(session, "officer", "supervisor", "admin");
    if (gate.error) return saasJson(res, gate.status, { error: gate.error });
  }

  if (await router.handle(req, res, { url, session, rawToken })) return;
  return saasJson(res, 404, { error: "not found" });
}));

/** Every route this system answers — used by check-docs.mjs. */
export const routeList = () => router.list();
