/**
 * Waypoint PoC — the server.
 *
 *   node spike/api/server.mjs            app on 8080, content on 8081
 *
 * TWO ORIGINS, deliberately. The app API and the course content are served
 * from different ports, which makes them different origins. That is the rule
 * from CLAUDE.md made real from day one rather than retrofitted: an uploaded
 * course's JavaScript must never be same-origin with the application.
 *
 * The player page lives on the CONTENT origin, next to the course, because
 * the ADL API discovery algorithm walks window.parent looking for the adapter
 * and that only works same-origin. The player then talks to the app API over
 * CORS. This is the collision the spike surfaced, resolved.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import {
  upsertPerson, upsertProgram, assign, latestVersion, contentVersion,
  openRegistration, registration, updateRegistration, registrationsFor, contextFor,
  issueTicket, redeemTicket, recordDelivery, deliveries, allRegistrations,
  assignmentsFor, setPassword, credentialByIdentifier, markCredentialUsed,
  personById, catalog, saasReceive, saasInbox, saasPeople, enrollments,
  scheduleVisit, visitsFor, unseenVisitCount, markVisitsSeen, cancelVisit,
  assignmentState, unassign, acceptVisit, completeVisit, visit,
  allSubjects, subjectByKey, seedRoster, requestVisit, scheduleRequested, now
} from "./db.mjs";
import { API_KEY, WEBHOOK_SECRET, requireApiKey, requireSession, mintSession,
         signWebhook, verifyWebhook, hashPassword, verifyPassword,
         mintLearnerSession, requireLearner } from "./auth.mjs";
import { ingestPackage, CONTENT_DIR } from "./ingest.mjs";
import { applyStatus, toSeconds, fromSeconds } from "./scorm.mjs";

const APP_PORT     = +(process.env.APP_PORT     || 8080);
const CONTENT_PORT = +(process.env.CONTENT_PORT || 8081);
// A device cannot reach "localhost" — that is its own loopback. Set HOST to
// the machine's LAN IP when running against a phone or Android emulator.
const HOST = process.env.HOST || "localhost";
const SAAS_PORT      = +(process.env.SAAS_PORT || 8092);
const SAAS_ORIGIN    = `http://${HOST}:${SAAS_PORT}`;
const APP_ORIGIN     = `http://${HOST}:${APP_PORT}`;
const CONTENT_ORIGIN = `http://${HOST}:${CONTENT_PORT}`;

/* ---------------- tiny http helpers ---------------- */
const json = (res, code, body) => {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(s),
    "Cache-Control": "no-store",
    // The player is on the content origin and must call this API.
    // Narrow: one named origin, never "*".
    "Access-Control-Allow-Origin": CONTENT_ORIGIN
  });
  res.end(s);
};

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { return { __bad: true }; }
}

const MIME = {
  ".html": "text/html", ".htm": "text/html", ".js": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".xml": "application/xml",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".mp4": "video/mp4",
  ".mp3": "audio/mpeg", ".woff": "font/woff", ".woff2": "font/woff2"
};

/* ================================================================
   APP API  —  port 8080
================================================================ */
const app = createServer(async (req, res) => {
  const url = new URL(req.url, APP_ORIGIN);
  const p = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": CONTENT_ORIGIN,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      // Authorization is NOT a CORS-safelisted header, so it must be named
      // here or every authenticated call fails at preflight.
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    return res.end();
  }

  try {
    /* --- health --- */
    if (p === "/api/health")
      return json(res, 200, { ok: true, app: APP_ORIGIN, content: CONTENT_ORIGIN });

    /* --- ingest a package ------------------------------------------------
       POST { zip, program_id?, title? }                                  */
    if (p === "/api/ingest" && req.method === "POST") {
      const auth = requireApiKey(req);
      if (auth.error) return json(res, auth.status, { error: auth.error });
      const b = await readJson(req);
      if (!b.zip) return json(res, 400, { error: "zip path required" });
      const r = ingestPackage(b.zip, { program_id: b.program_id, title: b.title });
      return json(res, r.error ? 422 : 200, r);
    }

    /* --- the SaaS assigns a program to a subject -------------------------
       POST { subject_id, program_id, name?, email? }                     */
    if (p === "/api/assign" && req.method === "POST") {
      const auth = requireApiKey(req);
      if (auth.error) return json(res, auth.status, { error: auth.error });
      const b = await readJson(req);
      if (!b.subject_id || !b.program_id)
        return json(res, 400, { error: "subject_id and program_id required" });

      const person = upsertPerson(b);
      const program = upsertProgram({ program_id: b.program_id, title: b.title || b.program_id });
      const cv = latestVersion(program.id);
      if (!cv) return json(res, 422, { error: `no content ingested for program "${b.program_id}"` });

      assign({ person_id: person.id, program_pk: program.id });
      const reg = openRegistration({ person_id: person.id, content_version_id: cv.id });
      return json(res, 200, { person, program, content_version: cv, registration: reg });
    }

    /* --- cancel an assignment ---------------------------------------------
       POST { subject_id, program_id }

       Refused once the learner has touched it. The UI hides the button in
       that case, but the rule is enforced here — a hidden button is not a
       constraint. */
    if (p === "/api/unassign" && req.method === "POST") {
      const auth = requireApiKey(req);
      if (auth.error) return json(res, auth.status, { error: auth.error });
      const b = await readJson(req);
      const st = assignmentState(b.subject_id, b.program_id);
      if (!st) return json(res, 404, { error: "no such assignment" });

      const touched = st.last_write_at !== null
                   || (st.completion_status && st.completion_status !== "not attempted");
      if (touched)
        return json(res, 409, {
          error: "This program has already been started and can no longer be cancelled.",
          completion_status: st.completion_status });

      unassign({ person_id: st.person_id, program_pk: st.program_pk });
      return json(res, 200, { cancelled: true });
    }

    /* --- issue a launch ticket -------------------------------------------
       POST { subject_id, program_id }
       Short-lived, single-use, bound to one registration. This is what
       replaces "customer id in the URL".                                  */
    if (p === "/api/launch" && req.method === "POST") {
      const auth = requireApiKey(req);
      if (auth.error) return json(res, auth.status, { error: auth.error });
      const b = await readJson(req);
      const person = upsertPerson({ subject_id: b.subject_id });
      const program = upsertProgram({ program_id: b.program_id, title: b.program_id });
      const cv = latestVersion(program.id);
      if (!cv) return json(res, 422, { error: "no content for that program" });

      const reg = openRegistration({ person_id: person.id, content_version_id: cv.id });
      const t = issueTicket(reg.id);
      return json(res, 200, {
        ...t,
        registration_id: reg.id,
        // The player lives on the CONTENT origin, not this one.
        launch_url: `${CONTENT_ORIGIN}/player?ticket=${t.token}`
      });
    }

    /* --- DEMO CONVENIENCE ONLY -------------------------------------------
       GET /demo?subject=…&program=…  → mint a ticket, redirect to the player.

       A bookmarkable URL for driving the PoC by hand. NOT the real pattern:
       in production the SaaS requests a ticket server-to-server and hands it
       to the client. This route lets a browser mint its own, which is exactly
       what launch tickets exist to prevent. Delete it before anything ships. */
    if (p === "/demo") {
      const subject = url.searchParams.get("subject") || "subject-demo";
      const pid     = url.searchParams.get("program") || "golf-101";
      const person  = upsertPerson({ subject_id: subject });
      const program = upsertProgram({ program_id: pid, title: pid });
      const cv = latestVersion(program.id);
      if (!cv) return json(res, 422, { error: `no content ingested for "${pid}"` });
      const reg = openRegistration({ person_id: person.id, content_version_id: cv.id });
      const t = issueTicket(reg.id);
      res.writeHead(302, {
        Location: `${CONTENT_ORIGIN}/player?ticket=${t.token}`,
        "Cache-Control": "no-store"
      });
      return res.end();
    }

    /* --- the catalog the SaaS pulls ------------------------------------
       GET /api/content — what this platform can offer. The SaaS ingests
       this to build its own assignable list. */
    if (p === "/api/content") {
      const auth = requireApiKey(req);
      if (auth.error) return json(res, auth.status, { error: auth.error });
      return json(res, 200, { content: catalog() });
    }

    /* --- live status, for the SaaS to poll -------------------------------
       GET /api/status — every assignment and where it stands right now.
       The completion webhook is the push; this is the pull. */
    if (p === "/api/status") {
      const auth = requireApiKey(req);
      if (auth.error) return json(res, auth.status, { error: auth.error });
      return json(res, 200, { enrollments: enrollments() });
    }

    /* --- the SaaS provisions a learner and their credentials --------------
       POST { subject_id, name?, email?, identifier?, password? }
       Called by the SaaS when a person is created or given LMS access. */
    if (p === "/api/users" && req.method === "POST") {
      const auth = requireApiKey(req);
      if (auth.error) return json(res, auth.status, { error: auth.error });
      const b = await readJson(req);
      if (!b.subject_id) return json(res, 400, { error: "subject_id required" });

      const person = upsertPerson(b);
      let credential = null;
      if (b.password) {
        const identifier = b.identifier || b.email;
        if (!identifier)
          return json(res, 400, { error: "identifier or email required to set a password" });
        credential = setPassword({
          person_id: person.id, identifier,
          secret_hash: hashPassword(String(b.password)),
          must_change: b.must_change ? 1 : 0
        });
      }
      return json(res, 200, {
        person,
        // Never echo the hash back, even to a trusted caller.
        credential: credential && { identifier: credential.identifier,
                                    must_change: !!credential.must_change }
      });
    }

    /* --- a learner signs in ----------------------------------------------
       POST { identifier, password }  →  a person-scoped session.
       Used by both the website and the mobile app. */
    if (p === "/api/auth/login" && req.method === "POST") {
      const b = await readJson(req);
      const cred = b.identifier ? credentialByIdentifier(String(b.identifier)) : null;

      // Same response whether the account is unknown or the password is
      // wrong — otherwise this endpoint enumerates who has an account.
      const good = cred && verifyPassword(String(b.password || ""), cred.secret_hash);
      if (!good) return json(res, 401, { error: "Incorrect email or password" });

      markCredentialUsed(cred.id);
      const person = personById(cred.person_id);
      return json(res, 200, {
        token: mintLearnerSession(person.id),
        must_change_password: !!cred.must_change,
        person: { subject_id: person.subject_id, name: person.name, email: person.email }
      });
    }

    /* --- the signed-in learner -------------------------------------------
       A learner session gets you YOUR list and YOUR launch tickets. It does
       not let you write to a registration — that still needs a redeemed
       ticket, so the two cannot be conflated. */
    if (p === "/api/me") {
      const who = requireLearner(req);
      if (who.error) return json(res, who.status, { error: who.error });
      const person = personById(who.person_id);
      return json(res, 200, { person: { subject_id: person.subject_id, name: person.name,
                                        email: person.email } });
    }

    if (p === "/api/me/assignments") {
      const who = requireLearner(req);
      if (who.error) return json(res, who.status, { error: who.error });
      const person = personById(who.person_id);
      return json(res, 200, { subject_id: person.subject_id, name: person.name,
                              programs: assignmentsFor(person.subject_id) });
    }

    if (p === "/api/me/launch" && req.method === "POST") {
      const who = requireLearner(req);
      if (who.error) return json(res, who.status, { error: who.error });
      const b = await readJson(req);
      const person = personById(who.person_id);

      // Only programs actually assigned to THIS learner. Without this check
      // a signed-in learner could launch anything by guessing a program_id.
      const assigned = assignmentsFor(person.subject_id)
        .find(a => a.program_id === b.program_id);
      if (!assigned) return json(res, 403, { error: "that program is not assigned to you" });

      const reg = openRegistration({ person_id: person.id,
                                     content_version_id: assigned.content_version_id });
      const t = issueTicket(reg.id);
      return json(res, 200, { launch_url: `${CONTENT_ORIGIN}/player?ticket=${t.token}`,
                              registration_id: reg.id, expires_in: t.expires_in });
    }

    /* --- DEMO: what the SaaS backend would expose to its own app ----------
       The mobile app must never hold Waypoint's API key — an embedded key is
       extractable from any app bundle. In production the app calls its OWN
       backend, which holds the key and brokers these calls. These two routes
       stand in for that backend. Demo only. */
    if (p === "/demo/assignments") {
      const subject = url.searchParams.get("subject") || "subject-demo";
      return json(res, 200, { subject_id: subject, programs: assignmentsFor(subject) });
    }
    if (p === "/demo/launch-url") {
      const subject = url.searchParams.get("subject") || "subject-demo";
      const pid     = url.searchParams.get("program");
      const person  = upsertPerson({ subject_id: subject });
      const program = upsertProgram({ program_id: pid, title: pid });
      const cv = latestVersion(program.id);
      if (!cv) return json(res, 422, { error: `no content for "${pid}"` });
      const reg = openRegistration({ person_id: person.id, content_version_id: cv.id });
      const t = issueTicket(reg.id);
      return json(res, 200, { launch_url: `${CONTENT_ORIGIN}/player?ticket=${t.token}`,
                              registration_id: reg.id, expires_in: t.expires_in });
    }

    /* --- redeem a ticket --------------------------------------------------
       POST { token }  →  the registration state the runtime needs.
       Consumed on first use; a replay gets an error, not a session.      */
    if (p === "/api/runtime/redeem" && req.method === "POST") {
      const b = await readJson(req);
      const r = redeemTicket(String(b.token || ""));
      if (r.error) return json(res, 403, r);

      const reg = registration(r.registration_id);
      const cv = contentVersion(reg.content_version_id);
      updateRegistration(reg.id, { started_at: reg.started_at || now() });
      return json(res, 200, {
        // Scoped to THIS registration only. Without it the runtime endpoints
        // would accept a bare id from anyone — the same bug as an id in a URL.
        session: mintSession(reg.id),
        registration: reg,
        content: {
          scorm_version: cv.scorm_version,
          // Prefer the program's title over the package's internal one —
          // the learner was assigned a program, not a manifest.
          title: contextFor(reg.id)?.title || cv.title || "Course",
          launch_url: `${CONTENT_ORIGIN}/content/${cv.id}/${cv.launch_href}`
        }
      });
    }

    /* --- runtime writes ---------------------------------------------------
       POST /api/runtime/:id/set { key, value }

       Persisted IMMEDIATELY. Courses do not call Commit — observed: five
       bookmarks and zero commits in 244 seconds — so durability cannot be
       delegated to the content.                                          */
    let m;
    if ((m = p.match(/^\/api\/runtime\/(\d+)\/set$/)) && req.method === "POST") {
      const gate = requireSession(req, +m[1]);
      if (gate.error) return json(res, gate.status, { error: gate.error });
      const reg = registration(+m[1]);
      if (!reg) return json(res, 404, { error: "no such registration" });
      const { key, value } = await readJson(req);
      const patch = mapWrite(reg, String(key), String(value ?? ""));
      const updated = updateRegistration(reg.id, patch);
      return json(res, 200, { ok: true, applied: patch, registration: updated });
    }

    /* --- terminate --------------------------------------------------------
       POST /api/runtime/:id/terminate                                    */
    if ((m = p.match(/^\/api\/runtime\/(\d+)\/terminate$/)) && req.method === "POST") {
      // sendBeacon (used on pagehide) cannot set headers, so accept the
      // session in the body as well. Same token, same verification.
      const tb = await readJson(req);
      if (!req.headers.authorization && tb.session)
        req.headers.authorization = `Bearer ${tb.session}`;
      const gate = requireSession(req, +m[1]);
      if (gate.error) return json(res, gate.status, { error: gate.error });
      const reg = registration(+m[1]);
      if (!reg) return json(res, 404, { error: "no such registration" });
      const done = reg.completion_status === "completed";
      const updated = updateRegistration(reg.id, {
        terminated_at: now(),
        completed_at: done ? (reg.completed_at || now()) : reg.completed_at
      });
      const delivery = await deliverCompletion(updated);
      return json(res, 200, { ok: true, registration: updated, webhook: delivery });
    }

    /* --- read state -------------------------------------------------- */
    if ((m = p.match(/^\/api\/runtime\/(\d+)$/)))
      return json(res, 200, { registration: registration(+m[1]) });

    if ((m = p.match(/^\/api\/registrations\/([^/]+)$/)))
      return json(res, 200, { registrations: registrationsFor(decodeURIComponent(m[1])) });

    /* --- console data --- */
    if (p === "/api/console/registrations")
      return json(res, 200, { registrations: allRegistrations() });
    if (p === "/api/console/deliveries")
      return json(res, 200, { deliveries: deliveries() });
    if (p === "/api/console/keys")
      return json(res, 200, { api_key: API_KEY, webhook_secret: WEBHOOK_SECRET });

    /* --- the learner site --- */
    if (p === "/learn" || p === "/learn/") {
      const html = (await readFile(new URL("./learner.html", import.meta.url), "utf8"))
        .replaceAll("__SAAS_ORIGIN__", SAAS_ORIGIN);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      return res.end(html);
    }

    if (p === "/console" || p === "/") {
      const html = await readFile(new URL("./console.html", import.meta.url), "utf8");
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      return res.end(html);
    }

    return json(res, 404, { error: `no route for ${req.method} ${p}` });
  } catch (e) {
    return json(res, 500, { error: String(e && e.stack || e) });
  }
});

/* ------------------------------------------------------------------
   Map a SCORM data-model write onto our columns.

   This is where the two-column split happens. SCORM 1.2 packs completion
   and pass/fail into cmi.core.lesson_status; each write updates ONLY the
   column it carries news about, so "completed" followed by "passed"
   preserves both facts instead of the second destroying the first.
------------------------------------------------------------------ */
function mapWrite(reg, key, value) {
  const patch = {};
  switch (key) {
    case "cmi.core.lesson_status": {
      const d = applyStatus(value, {
        completion: reg.completion_status, success: reg.success_status
      });
      patch.completion_status = d.completion;
      patch.success_status = d.success;
      break;
    }
    case "cmi.completion_status": patch.completion_status = value; break;
    case "cmi.success_status":    patch.success_status = value; break;

    case "cmi.core.lesson_location":
    case "cmi.location":          patch.location = value; break;

    case "cmi.suspend_data":
      // Opaque. Stored byte-for-byte, with its length so overflow is queryable.
      patch.suspend_data = value;
      patch.suspend_data_len = value.length;
      break;

    case "cmi.core.score.raw":
    case "cmi.score.raw":         patch.score_raw = num(value); break;
    case "cmi.core.score.min":
    case "cmi.score.min":         patch.score_min = num(value); break;
    case "cmi.core.score.max":
    case "cmi.score.max":         patch.score_max = num(value); break;
    case "cmi.score.scaled":      patch.score_scaled = num(value); break;

    case "cmi.core.session_time":
    case "cmi.session_time": {
      // Normalize on write. 1.2 and 2004 formats are incompatible; only
      // seconds ever reach the database.
      const s = toSeconds(value);
      if (!Number.isNaN(s)) patch.total_seconds = (reg.total_seconds || 0) + Math.round(s);
      break;
    }
    case "cmi.core.exit":
    case "cmi.exit":              patch.exit_mode = value; break;
  }
  return patch;
}
const num = v => (v === "" || v == null || Number.isNaN(+v) ? null : +v);

/* ------------------------------------------------------------------
   Completion goes back to the SaaS server-to-server. The learner's
   device is never the thing that reports a pass.
------------------------------------------------------------------ */
async function deliverCompletion(reg) {
  const target = process.env.SAAS_WEBHOOK || `${SAAS_ORIGIN}/webhook`;
  const cv = contentVersion(reg.content_version_id);
  const ctx = contextFor(reg.id);
  const payload = {
    // The contract: the SaaS knows this person and this program by these ids.
    subject_id: ctx.subject_id,
    program_id: ctx.program_id,
    registration_id: reg.id,
    completion_status: reg.completion_status,
    success_status: reg.success_status,
    score: { raw: reg.score_raw, min: reg.score_min, max: reg.score_max },
    total_seconds: reg.total_seconds,
    total_time_scorm: fromSeconds(reg.total_seconds, /2004/.test(cv.scorm_version)),
    completed_at: reg.completed_at,
    attempt: reg.attempt
  };
  if (!target) {
    recordDelivery({ registration_id: reg.id, payload, status: "skipped" });
    return { skipped: "no webhook endpoint configured", payload };
  }

  // Signed with a timestamp so the receiver can prove it came from us
  // and refuse a replayed delivery.
  const body = JSON.stringify(payload);
  try {
    const r = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signWebhook(body) },
      body
    });
    recordDelivery({ registration_id: reg.id, endpoint: target, payload,
                     status: r.ok ? "delivered" : "failed", http_status: r.status });
    return { delivered: r.ok, status: r.status, payload };
  } catch (e) {
    // Never lose a completion. A real implementation queues and retries;
    // the PoC records the failure so it is visible rather than silent.
    recordDelivery({ registration_id: reg.id, endpoint: target, payload,
                     status: "failed", error: String(e) });
    return { delivered: false, error: String(e), payload };
  }
}

/* ================================================================
   CONTENT ORIGIN  —  port 8081
   Serves unpacked packages and the player. Nothing here can read the
   app's cookies, because it is a different origin.
================================================================ */
const content = createServer(async (req, res) => {
  const url = new URL(req.url, CONTENT_ORIGIN);

  if (url.pathname === "/player") {
    const html = await readFile(new URL("./player.html", import.meta.url), "utf8");
    const body = html.replace("__APP_ORIGIN__", APP_ORIGIN);
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body)
    });
    return res.end(body);
  }

  const m = url.pathname.match(/^\/content\/(\d+)\/(.+)$/);
  if (!m) { res.writeHead(404); return res.end("not found"); }

  // Contain the path: normalize, then verify it is still inside the
  // version's directory. Traversal was already rejected at ingest, but
  // serving is a second place it could be attempted.
  const root = join(CONTENT_DIR, m[1]);
  const file = normalize(join(root, decodeURIComponent(m[2]).split("?")[0]));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end("forbidden"); }

  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    const buf = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": buf.length,
      "Cache-Control": "no-store",
      // Uploaded content is third-party code. Never sniffed, never framed
      // by anyone but us.
      "X-Content-Type-Options": "nosniff"
    });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});

/* ================================================================
   MOCK SaaS  —  port 8092

   Stands in for the customer's own application. It holds the API key,
   pulls Waypoint's catalog, provisions learners, assigns programs,
   and receives completions. Everything here is what THEY would build;
   it lives in this process only because the PoC runs both.
================================================================ */
/* Seed data for an empty database. Real deployments import their roster
   from the case-management system; the demo needs one to exist. */
seedRoster(
  [ { name: "R. Alvarez",  email: "r.alvarez@northwood.gov",  badge: "NC-114" },
    { name: "T. Nakamura", email: "t.nakamura@northwood.gov", badge: "NC-207" } ],
  [ { subject_id: "cust-1041", case_number: "NC-2026-0418",
      first_name: "Dana", last_name: "Whitfield", dob: "17 April 1991",
      phone: "(423) 555-0142", address_line1: "412 Ridgeway Ave, Apt 3B",
      city: "Kingsport", state: "TN", postal_code: "37660",
      status: "Active supervision", officer: "R. Alvarez",
      intake_date: "3 February 2026", next_review: "15 September 2026" },
    { subject_id: "cust-2298", case_number: "NC-2026-0511",
      first_name: "Marcus", last_name: "Oyelaran", dob: "2 November 1986",
      phone: "(423) 555-0197", address_line1: "77 Beechmont Rd",
      city: "Bristol", state: "TN", postal_code: "37620",
      status: "Probation — Level 2", officer: "T. Nakamura",
      intake_date: "28 March 2026", next_review: "12 October 2026" } ]
);

/** Shape a database row the way the UI expects it. */
const asProfile = r => r && ({
  subject_id: r.subject_id, name: r.name, case_number: r.case_number,
  dob: r.dob, phone: r.phone, status: r.status, officer: r.officer,
  intake: r.intake_date, review: r.next_review,
  address: [r.address_line1, [r.city, r.state, r.postal_code].filter(Boolean).join(", ")]
             .filter(Boolean).join("\n")
});

const saasJson = (res, code, body) => {
  const b = JSON.stringify(body, null, 2);
  res.writeHead(code, { "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(b),
                        "Cache-Control": "no-store",
                        "Access-Control-Allow-Origin": APP_ORIGIN });
  res.end(b);
};

/** The SaaS backend calls Waypoint with its API key. The key never reaches
 *  the browser — that is the whole reason this is a server, not a page. */
const waypoint = (path, init = {}) => fetch(`${APP_ORIGIN}${path}`, {
  ...init,
  headers: { "Content-Type": "application/json",
             Authorization: `Bearer ${API_KEY}`, ...(init.headers || {}) }
}).then(async r => ({ status: r.status, body: await r.json() }));

const saas = createServer(async (req, res) => {
  const url = new URL(req.url, SAAS_ORIGIN);
  const p = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": APP_ORIGIN,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    return res.end();
  }

  try {
    if (p === "/" || p === "/index.html") {
      const html = (await readFile(new URL("./saas.html", import.meta.url), "utf8"))
        .replaceAll("__WAYPOINT_APP__", APP_ORIGIN);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      return res.end(html);
    }

    /* what we can offer — pulled live from Waypoint */
    if (p === "/api/catalog") {
      const r = await waypoint("/api/content");
      return saasJson(res, r.status, r.body);
    }

    /* the roster this system manages */
    if (p === "/api/subjects")
      return saasJson(res, 200, { subjects: allSubjects().map(asProfile) });

    /* ---- visits ---- */
    if (p === "/api/visits" && req.method === "GET") {
      const sid = url.searchParams.get("subject_id");
      if (!sid) return saasJson(res, 400, { error: "subject_id required" });
      return saasJson(res, 200, { visits: visitsFor(sid) });
    }

    if (p === "/api/visits" && req.method === "POST") {
      const b = await readJson(req);
      const subject = asProfile(subjectByKey(b.subject_id));
      if (!subject) return saasJson(res, 404, { error: "unknown subject" });
      if (!b.scheduled_at) return saasJson(res, 400, { error: "a date and time is required" });
      const visit = scheduleVisit({
        subject_id: subject.subject_id, scheduled_at: b.scheduled_at,
        officer: b.officer || subject.officer,
        location: b.location || subject.address.split("\n")[0],
        notes: b.notes || null
      });
      return saasJson(res, 200, { visit });
    }

    /* The officer records that the visit took place. The timestamp is taken
       here, at the moment of recording — never accepted from the caller. */
    if (p === "/api/visits/complete" && req.method === "POST") {
      const b = await readJson(req);
      const r = completeVisit(Number(b.id), b.officer || null);
      return saasJson(res, r.error ? 409 : 200, r);
    }

    /* The officer gives a requested appointment a date. */
    if (p === "/api/visits/schedule" && req.method === "POST") {
      const b = await readJson(req);
      if (!b.scheduled_at) return saasJson(res, 400, { error: "a date and time is required" });
      const r = scheduleRequested(Number(b.id), {
        scheduled_at: b.scheduled_at, officer: b.officer, location: b.location });
      return saasJson(res, r.error ? 409 : 200, r);
    }

    if (p === "/api/visits/cancel" && req.method === "POST") {
      const b = await readJson(req);
      cancelVisit(Number(b.id));
      return saasJson(res, 200, { ok: true });
    }

    /* ---- the subject's own case view, for the mobile app ----------------
       The app holds a Waypoint learner token, not a Northwood one. Rather
       than inventing a second login, we ask Waypoint who the token belongs
       to and answer for that subject. Token introspection — the app never
       tells us who it is. */
    if (p === "/api/me/case") {
      const authHeader = req.headers["authorization"] || "";
      const who = await fetch(`${APP_ORIGIN}/api/me`, { headers: { Authorization: authHeader } })
        .then(r => r.ok ? r.json() : null).catch(() => null);
      if (!who?.person?.subject_id)
        return saasJson(res, 401, { error: "sign in required" });

      const sid = who.person.subject_id;
      const subject = asProfile(subjectByKey(sid));
      if (url.searchParams.get("seen") === "1") markVisitsSeen(sid);

      return saasJson(res, 200, {
        subject: subject || { subject_id: sid, name: who.person.name },
        visits: visitsFor(sid),
        unseen_visits: unseenVisitCount(sid)
      });
    }

    /* The subject confirms they will attend. Identity comes from the token,
       never from the request body — and the visit must be theirs. */
    if (p === "/api/me/visits/accept" && req.method === "POST") {
      const authHeader = req.headers["authorization"] || "";
      const who = await fetch(`${APP_ORIGIN}/api/me`, { headers: { Authorization: authHeader } })
        .then(r => r.ok ? r.json() : null).catch(() => null);
      if (!who?.person?.subject_id)
        return saasJson(res, 401, { error: "sign in required" });

      const b = await readJson(req);
      const r = acceptVisit(Number(b.id), who.person.subject_id);
      return saasJson(res, r.error ? 409 : 200, r);
    }

    /* The subject asks for an appointment. They supply a reason, not a date —
       scheduling stays with the officer. */
    if (p === "/api/me/visits/request" && req.method === "POST") {
      const authHeader = req.headers["authorization"] || "";
      const who = await fetch(`${APP_ORIGIN}/api/me`, { headers: { Authorization: authHeader } })
        .then(r => r.ok ? r.json() : null).catch(() => null);
      if (!who?.person?.subject_id)
        return saasJson(res, 401, { error: "sign in required" });

      const sid = who.person.subject_id;
      // One open request at a time, so a repeated tap cannot flood the officer.
      const open = visitsFor(sid).find(v => v.status === "requested");
      if (open) return saasJson(res, 409, {
        error: "You already have a request waiting. Your officer will be in touch.",
        visit: open });

      const b = await readJson(req);
      return saasJson(res, 200, { visit: requestVisit({ subject_id: sid, note: b.note || null }) });
    }

    /* our own subject list, plus whatever LMS state came back */
    if (p === "/api/customers")
      return saasJson(res, 200, { customers: saasPeople() });

    /* assign a program: provision the learner, set credentials, assign */
    if (p === "/api/assign" && req.method === "POST") {
      const b = await readJson(req);
      if (!b.subject_id || !b.program_id)
        return saasJson(res, 400, { error: "customer and program required" });

      // The SaaS generates the credentials it hands to its customer.
      const password = b.password || makePassword();
      const email = b.email || `${b.subject_id}@example.com`;

      const u = await waypoint("/api/users", { method: "POST", body: JSON.stringify({
        subject_id: b.subject_id, name: b.name, email, password }) });
      if (u.status !== 200) return saasJson(res, u.status, u.body);

      const a = await waypoint("/api/assign", { method: "POST", body: JSON.stringify({
        subject_id: b.subject_id, program_id: b.program_id, name: b.name, email }) });
      if (a.status !== 200) return saasJson(res, a.status, a.body);

      return saasJson(res, 200, {
        assigned: true,
        credentials: { login: email, password },   // shown once, as a real system would
        learner_url: `${APP_ORIGIN}/learn`
      });
    }

    /* live status, pulled from Waypoint */
    if (p === "/api/enrollments") {
      const r = await waypoint("/api/status");
      return saasJson(res, r.status, r.body);
    }

    /* cancel an assignment */
    if (p === "/api/unassign" && req.method === "POST") {
      const b = await readJson(req);
      const r = await waypoint("/api/unassign", { method: "POST", body: JSON.stringify(b) });
      return saasJson(res, r.status, r.body);
    }

    /* what Waypoint has told us */
    if (p === "/api/results")
      return saasJson(res, 200, { results: saasInbox() });

    /* ---- the webhook Waypoint calls when someone finishes ---- */
    if (p === "/webhook" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();

      // Verify before trusting a word of it. This is the check the real
      // SaaS implements; auth.mjs exports it so they can copy it.
      const check = verifyWebhook(raw, req.headers, WEBHOOK_SECRET);
      if (!check.ok) {
        console.log(`  [SaaS] REJECTED delivery — ${check.reason}`);
        return saasJson(res, 401, { accepted: false, reason: check.reason });
      }
      const d = JSON.parse(raw);
      saasReceive({ subject_id: d.subject_id, program_id: d.program_id,
                    payload: d, verified: 1 });
      console.log(`  [SaaS] ✓ ${d.subject_id} — ${d.completion_status}/${d.success_status}`
                + (d.score?.raw != null ? ` score ${d.score.raw}` : ""));
      return saasJson(res, 200, { accepted: true });
    }

    return saasJson(res, 404, { error: "not found" });
  } catch (e) {
    return saasJson(res, 500, { error: String(e?.stack || e) });
  }
});

/* Readable, not clever — this gets read aloud during a demo. */
function makePassword() {
  const words = ["fairway", "birdie", "eagle", "putter", "bunker", "caddie", "albatross"];
  return words[Math.floor(Math.random() * words.length)]
       + String(Math.floor(Math.random() * 9000) + 1000);
}

app.listen(APP_PORT, () =>
  console.log(`  Waypoint API      ${APP_ORIGIN}`));
content.listen(CONTENT_PORT, () => {
  console.log(`  Content origin    ${CONTENT_ORIGIN}   (separate origin, by design)`);
  console.log(`  Console           ${APP_ORIGIN}/console`);
  console.log(`  Learner site      ${APP_ORIGIN}/learn`);
  console.log(`  Mock SaaS         ${SAAS_ORIGIN}`);
  console.log(`  API key           ${API_KEY}`);
  console.log(`\n  ingest:  curl -sX POST ${APP_ORIGIN}/api/ingest -d '{"zip":"spike/corpus/RuntimeBasicCalls_SCORM12.zip"}'`);
  console.log(`  launch:  curl -sX POST ${APP_ORIGIN}/api/launch -d '{"subject_id":"subj-1","program_id":"RuntimeBasicCalls_SCORM12"}'\n`);
});

saas.listen(SAAS_PORT, () =>
  console.log(`  (mock SaaS listening — it holds the API key, the browser never sees it)\n`));
