/**
 * Waypoint — the LMS.
 *
 * Content, registrations, the SCORM runtime and results. This is the half an
 * integrator talks to, and it knows nothing about probation, visits or
 * supervision agreements.
 *
 * It exports a server rather than starting one; `server.mjs` composes and
 * starts everything, so the wiring is visible in one place.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  upsertPerson, upsertProgram, assign, latestVersion, contentVersion,
  openRegistration, registration, updateRegistration, contextFor,
  issueTicket, redeemTicket, recordDelivery, deliveries, allRegistrations,
  assignmentsFor, setPassword, passwordFor, subjectsWithLogin, personBySubjectId,
  credentialByIdentifier, markCredentialUsed, personById, catalog,
  assignmentState, unassign, enrollments, now
} from "./db/waypoint.mjs";
import { audit, callerIp } from "./db/audit.mjs";
import { API_KEY, WEBHOOK_SECRET, requireApiKey, requireSession, mintSession,
         signWebhook, hashPassword, verifyPassword } from "./auth.mjs";
import { mintLearnerSession, requireLearner, endLearnerSession,
         endAllLearnerSessions, verifyLearnerSession } from "./learner-session.mjs";
import { ingestPackage, CONTENT_DIR } from "./ingest.mjs";
import { applyStatus, toSeconds, fromSeconds, suspendCap } from "./scorm.mjs";
import { APP_ORIGIN, CONTENT_ORIGIN, SAAS_ORIGIN, DEMO_ROUTES } from "./config.mjs";
import { jsonTo, readJson, guard } from "./http.mjs";

/* Only the content origin may read this API — that is the player calling home.
   Never "*". */
const json = jsonTo(CONTENT_ORIGIN);

/**
 * Throttle repeated failed sign-ins, per identifier.
 *
 * In memory, and deliberately: a restart forgiving a few attempts is a much
 * smaller problem than a lockout table somebody has to clear by hand, and this
 * is the same trade the front door makes. A real deployment would persist it.
 *
 * Keyed by identifier rather than by address because a phone's address moves
 * between wifi and cellular mid-guess, and the thing being protected is the
 * account. The cost is that somebody can lock a person out by guessing at
 * their email — which is why the window is fifteen minutes and not a day.
 */
const LOGIN_FAILS = new Map();
const LOGIN_LOCK_AFTER = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

function loginLocked(who) {
  const f = LOGIN_FAILS.get(who);
  if (!f) return false;
  if (Date.now() - f.at > LOGIN_LOCK_MS) { LOGIN_FAILS.delete(who); return false; }
  return f.n >= LOGIN_LOCK_AFTER;
}
function recordLoginFailure(who) {
  const f = LOGIN_FAILS.get(who) || { n: 0 };
  LOGIN_FAILS.set(who, { n: f.n + 1, at: Date.now() });
}
const clearLoginFailures = who => LOGIN_FAILS.delete(who);

export const app = createServer(guard("waypoint", json, async (req, res) => {
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
    /* --- the /demo shim ----------------------------------------------------
       These let a browser mint a launch ticket for ANY subject, with no
       credential — precisely what launch tickets exist to prevent. They exist
       for the standalone harness only, and are off unless asked for.
       They must not survive the PoC. */
    if (p.startsWith("/demo") && !DEMO_ROUTES)
      return json(res, 404, { error: "not enabled — set WAYPOINT_DEMO_ROUTES=1" });

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
    /* --- which subjects have a login ---------------------------------------
       GET /api/logins            → every subject_id with a password
       GET /api/logins?subject_id → that one, with its identifier

       A login belongs to the person, not to any program they were given. */
    if (p === "/api/logins" && req.method === "GET") {
      const auth = requireApiKey(req);
      if (auth.error) return json(res, auth.status, { error: auth.error });
      const sid = url.searchParams.get("subject_id");
      if (!sid) return json(res, 200, { subject_ids: subjectsWithLogin() });
      const person = personBySubjectId(sid);
      const cred = person && passwordFor(person.id);
      return json(res, 200, {
        has_login: !!cred,
        login: cred ? cred.identifier : null,
        last_used_at: cred ? cred.last_used_at : null
      });
    }

    if (p === "/api/users" && req.method === "POST") {
      const auth = requireApiKey(req);
      if (auth.error) return json(res, auth.status, { error: auth.error });
      const b = await readJson(req);
      if (!b.subject_id) return json(res, 400, { error: "subject_id required" });

      const person = upsertPerson(b);
      let credential = passwordFor(person.id), issued = false;

      // A password already in use is not replaced unless the caller explicitly
      // asks. Rotating it silently would kill a login the person already has —
      // which is exactly what assigning a second program used to do.
      if (b.password && (!credential || b.reset_password)) {
        const identifier = b.identifier || b.email;
        if (!identifier)
          return json(res, 400, { error: "identifier or email required to set a password" });
        credential = setPassword({
          person_id: person.id, identifier,
          secret_hash: hashPassword(String(b.password)),
          must_change: b.must_change ? 1 : 0
        });
        issued = true;
      }
      return json(res, 200, {
        person,
        issued,
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
      const who = String(b.identifier || "").toLowerCase();

      /* Staff sign-in has locked out after five wrong answers since it existed.
         This one — the subjects' own sign-in, the credential that opens a
         person's supervision record from a phone — had nothing at all, and a
         password guesser could work through it at whatever rate the network
         allowed. The weaker-protected door was the one in front of the more
         sensitive room. */
      if (loginLocked(who))
        return json(res, 429, { error: "Too many attempts. Try again in a few minutes." });

      // Same response whether the account is unknown or the password is
      // wrong — otherwise this endpoint enumerates who has an account.
      const cred = who ? credentialByIdentifier(String(b.identifier)) : null;
      const good = cred && verifyPassword(String(b.password || ""), cred.secret_hash);
      if (!good) {
        /* Counted against the identifier that was TRIED, whether or not it
           exists — counting only real accounts would answer "is this an
           account?" by how the endpoint behaves, which is the enumeration the
           identical error message above exists to prevent. */
        recordLoginFailure(who);
        return json(res, 401, { error: "Incorrect email or password" });
      }
      clearLoginFailures(who);

      markCredentialUsed(cred.id);
      const person = personById(cred.person_id);
      /* Address and device are recorded against the session so that "end every
         session this person has" can be followed by "and here is where they
         were" — a lost phone is the case this exists for. */
      const token = mintLearnerSession(person.id, {
        ip: req.socket.remoteAddress,
        user_agent: req.headers["user-agent"] });
      audit({ actor: `subject:${person.subject_id}`, action: "signin",
              entity: "person", entity_id: person.subject_id,
              ip: req.socket.remoteAddress });
      return json(res, 200, {
        token,
        must_change_password: !!cred.must_change,
        person: { subject_id: person.subject_id, name: person.name, email: person.email }
      });
    }

    /* Signing out, which a stateless token could not do.
     *
     * Idempotent and always 200: a client that has already thrown its token
     * away, or is retrying after a dropped connection, must not be told that
     * signing out failed. There is nothing it could usefully do about it. */
    if (p === "/api/auth/logout" && req.method === "POST") {
      const h = req.headers["authorization"] || "";
      const token = h.startsWith("Bearer ") ? h.slice(7) : null;
      if (token) {
        const personId = verifyLearnerSession(token);
        endLearnerSession(token);
        if (personId) {
          const person = personById(personId);
          audit({ actor: `subject:${person?.subject_id ?? personId}`, action: "signout",
                  entity: "person", entity_id: person?.subject_id ?? String(personId),
                  ip: req.socket.remoteAddress });
        }
      }
      return json(res, 200, { ok: true });
    }

    /* Every session this person has, ended at once — the answer to a lost
       phone. Staff-operated, so it carries the API key: Northwood asks on the
       officer's behalf rather than the subject asking for themselves. */
    if (p === "/api/people/end-sessions" && req.method === "POST") {
      const auth = requireApiKey(req);
      if (auth.error) return json(res, auth.status, { error: auth.error });
      const b = await readJson(req);
      const person = b.subject_id ? personBySubjectId(String(b.subject_id)) : null;
      if (!person) return json(res, 404, { error: "unknown subject" });
      endAllLearnerSessions(person.id);
      audit({ actor: "api-key", action: "revoke", entity: "person",
              entity_id: person.subject_id, detail: "all sessions ended",
              ip: req.socket.remoteAddress });
      return json(res, 200, { ok: true, subject_id: person.subject_id });
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

      const stale = registration(r.registration_id);
      const cv = contentVersion(stale.content_version_id);

      /* Opening a suspended registration starts a NEW session on the same
         attempt: clear the terminated flag and zero the session clock, so
         this visit's time is counted from zero and accrues on its own exit. */
      const reg = updateRegistration(stale.id, {
        started_at: stale.started_at || now(),
        terminated_at: null,
        session_seconds: 0,
        /* cmi.core.entry tells the course whether to expect its own state
           back. We were saying "ab-initio" — this learner has never been
           here — while handing over 1,835 bytes of suspend_data. Rise
           resumed anyway off lesson_location, but a stricter course reads
           ab-initio, concludes the learner is new, and DISCARDS the suspend
           data. That is a total, silent loss of resume for that package. */
        entry: stale.exit_mode === "suspend" ? "resume" : "ab-initio"
      });
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

      /* SCORM makes the API unusable after Terminate, and courses do call it
         anyway: Rise 360 sent a session_time of 200s AFTER LMSFinish had
         already accrued 180s, which would have been counted a second time on
         the next exit. Refusing the write is both the spec's behaviour and
         the thing that keeps the total honest. */
      if (reg.terminated_at)
        return json(res, 409, { error: "session already terminated" });

      const { key, value } = await readJson(req);
      const cv = contentVersion(reg.content_version_id);
      const patch = mapWrite(reg, String(key), String(value ?? ""),
                             /2004/.test(cv?.scorm_version || ""));
      const updated = updateRegistration(reg.id, patch);
      return json(res, 200, { ok: true, applied: patch,
                              registration: asRegistration(updated) });
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
      const { registration: updated, delivery } = await closeSession(reg);
      return json(res, 200, { ok: true, registration: asRegistration(updated),
                              webhook: delivery });
    }

    /* --- read state -------------------------------------------------- */
    if ((m = p.match(/^\/api\/runtime\/(\d+)$/)))
      return json(res, 200, { registration: asRegistration(registration(+m[1])) });

    if ((m = p.match(/^\/api\/registrations\/([^/]+)$/)))
      return json(res, 200, { registrations: registrationsFor(decodeURIComponent(m[1])) });

    /* --- console data ---
       Every registration in the system: who is enrolled on what, their scores,
       their completion state and their resume data. These answered any caller
       at all, with no credential.
     *
     * "Who is enrolled on which programme" is not something to hand to the
     * internet, and least of all here — the subjects are people under
     * supervision. It also made the gate on every other read decorative: the
     * data those endpoints protect was available two paths over.
     *
     * Behind the API key now, like /api/console/keys below. The console is
     * Waypoint's own admin view and holds the key for the length of a session;
     * nothing else reads these. */
    if (p === "/api/console/registrations" || p === "/api/console/deliveries") {
      const auth = requireApiKey(req);
      if (auth.error) return json(res, auth.status, { error: auth.error });
      return p.endsWith("registrations")
        ? json(res, 200, { registrations: allRegistrations() })
        : json(res, 200, { deliveries: deliveries() });
    }
    /* The API key provisions users, assigns programs and mints launch tickets;
       the webhook secret forges completions. Handing both to any unauthenticated
       caller made every other control here decorative. Reading them now costs
       the key you are trying to learn — which is only useful to the console,
       which already has it. */
    if (p === "/api/console/keys") {
      const auth = requireApiKey(req);
      if (auth.error) return json(res, auth.status, { error: auth.error });
      return json(res, 200, { api_key: API_KEY, webhook_secret: WEBHOOK_SECRET });
    }

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
    // The stack goes to the log, not to the caller — it names internal paths
    // and library versions, which is free reconnaissance.
    console.error("app 500:", e);
    return json(res, 500, { error: "internal error" });
  }
}));

/**
 * Time spent, including a session that is still open.
 *
 * `total_seconds` is what has accrued from CLOSED sessions; `session_seconds`
 * is the one in progress. Every consumer wants the sum, so it is computed
 * here and nowhere else — a caller that reads the raw column reports the time
 * the learner had when they last exited, which is the older, quieter version
 * of the bug this replaced.
 */
export const elapsed = reg => (reg?.total_seconds || 0) + (reg?.session_seconds || 0);

/** A registration as a client should see it: one derived duration, not two. */
const asRegistration = reg => reg && ({ ...reg, total_seconds: elapsed(reg) });

/**
 * Close a runtime session and report it.
 *
 * Exported because the sweeper needs to do exactly this to a session that
 * never said goodbye. Two code paths that both "end a session" would be two
 * definitions of what ending one means, and they would drift.
 *
 * Whatever the last Commit left is kept — that is the learner's real progress,
 * and nothing about closing the session should alter it.
 */
export async function closeSession(reg) {
  const done = reg.completion_status === "completed";
  const registration = updateRegistration(reg.id, {
    terminated_at: now(),
    // SCORM adds session_time to total_time when the session ends. Doing it
    // here — rather than on every write — is what keeps the total honest.
    total_seconds: (reg.total_seconds || 0) + (reg.session_seconds || 0),
    session_seconds: 0,
    completed_at: done ? (reg.completed_at || now()) : reg.completed_at
  });
  const delivery = await deliverCompletion(registration);
  return { registration, delivery };
}

/* ------------------------------------------------------------------
   Map a SCORM data-model write onto our columns.

   This is where the two-column split happens. SCORM 1.2 packs completion
   and pass/fail into cmi.core.lesson_status; each write updates ONLY the
   column it carries news about, so "completed" followed by "passed"
   preserves both facts instead of the second destroying the first.
------------------------------------------------------------------ */
function mapWrite(reg, key, value, is2004 = false) {
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

    case "cmi.suspend_data": {
      /* Opaque: stored byte-for-byte, never parsed, never re-encoded.
         And never TRUNCATED — cutting it to fit is what silently destroys
         resume, and the learner is the one who finds out. Store the whole
         thing, record the length, and shout when it exceeds what this SCORM
         version allows. */
      patch.suspend_data = value;
      patch.suspend_data_len = value.length;

      const cap = suspendCap(is2004);
      if (value.length > cap && !reg.suspend_overflow_at) {
        patch.suspend_overflow_at = now();
        console.warn(
          `  [suspend_data OVERFLOW] registration ${reg.id}: ${value.length} chars ` +
          `exceeds the SCORM ${is2004 ? "2004" : "1.2"} limit of ${cap}. ` +
          `Stored in full — but this course's resume will break on any LMS that ` +
          `honours the cap, and may already be truncating it upstream.`);
      }
      break;
    }

    case "cmi.core.score.raw":
    case "cmi.score.raw":         patch.score_raw = num(value); break;
    case "cmi.core.score.min":
    case "cmi.score.min":         patch.score_min = num(value); break;
    case "cmi.core.score.max":
    case "cmi.score.max":         patch.score_max = num(value); break;
    case "cmi.score.scaled":      patch.score_scaled = num(value); break;

    case "cmi.core.session_time":
    case "cmi.session_time": {
      // Normalize on write: 1.2 and 2004 formats are incompatible, so only
      // seconds ever reach the database.
      //
      // REPLACE, never accumulate. session_time is the elapsed time of the
      // CURRENT session, rewritten as it grows — it is not a delta. Adding
      // each write summed a growing series: a real Rise 360 course that
      // commits periodically reported 155 minutes for 10 minutes of work,
      // while Rustici's sample hid the bug by only writing it once, at
      // Finish. The session total is folded into total_seconds by
      // closeSession(), which is the moment SCORM says it accrues.
      const s = toSeconds(value);
      if (!Number.isNaN(s)) patch.session_seconds = Math.round(s);
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
    // Includes the open session, which has not accrued yet — otherwise a
    // course in progress reports the time it had when it last finished.
    total_seconds: elapsed(reg),
    total_time_scorm: fromSeconds(elapsed(reg), /2004/.test(cv.scorm_version)),
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
