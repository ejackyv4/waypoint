#!/usr/bin/env node
/**
 * End-to-end smoke test of the Waypoint PoC API.
 * Replays the exact call sequence observed from a real SCORM 1.2 course,
 * then asserts the server got the right answer.
 *
 *   node spike/api/smoke.mjs [appOrigin]
 */
const API = process.argv[2] || "http://localhost:8090";
const KEY = process.env.WAYPOINT_API_KEY || "wp_demo_key_123";

let pass = 0, fail = 0;
const ok  = (c, m) => (c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${m}`))
                         : (fail++, console.log(`  \x1b[31m✕\x1b[0m ${m}`)));
const call = (p, b, headers = {}) => fetch(API + p, { method:"POST",
  headers:{ "Content-Type":"application/json", ...headers }, body: JSON.stringify(b) })
  .then(async r => ({ status: r.status, body: await r.json() }));

/* SaaS-facing calls carry the API key. */
const post = (p, b) => call(p, b, { Authorization: `Bearer ${KEY}` });
/* Runtime calls carry a session token scoped to one registration. */
const runtime = (p, b, session) => call(p, b, { Authorization: `Bearer ${session}` });

const SUBJECT = "subject-" + Math.floor(Math.random() * 1e6);

console.log(`\n\x1b[1mWaypoint API smoke test\x1b[0m   ${API}   subject ${SUBJECT}\n`);

/* ---- authentication ---- */
let r0 = await call("/api/assign", { subject_id: "x", program_id: "y" });
ok(r0.status === 401, "SaaS endpoint without an API key is refused");
r0 = await call("/api/assign", { subject_id: "x", program_id: "y" }, { Authorization: "Bearer nope" });
ok(r0.status === 403, "SaaS endpoint with a wrong API key is refused");

/* ---- ingest ---- */
let r = await post("/api/ingest", { zip: "spike/corpus/RuntimeBasicCalls_SCORM12.zip",
                                    program_id: "golf-101", title: "Golf Explained" });
ok(r.status === 200 && r.body.ok, "ingest accepts a valid SCORM 1.2 package");
ok(r.body?.manifest?.scorm_version === "1.2", "detects SCORM version 1.2");

/* re-ingest creates a NEW immutable version, never overwriting */
const v1 = r.body.content_version.version;
r = await post("/api/ingest", { zip: "spike/corpus/RuntimeBasicCalls_SCORM12.zip", program_id: "golf-101" });
ok(r.body.content_version.version === v1 + 1, "re-upload creates version N+1, never overwrites");

/* ---- rejection cases ---- */
r = await post("/api/ingest", { zip: "spike/corpus/ContentPackagingOneFilePerSCO_SCORM12.zip",
                                program_id: "asset-only" });
ok(r.status === 422 && /no trackable content/.test(r.body.error || ""),
   "rejects asset-only package with a useful reason, not 'invalid'");

r = await post("/api/ingest", { zip: "spike/corpus/RuntimeMinimumCalls_SCORM12.zip",
                                program_id: "multi-sco" });
ok(r.body.out_of_scope === true, "flags multi-SCO as out of scope rather than failing obscurely");

/* ---- assign ---- */
r = await post("/api/assign", { subject_id: SUBJECT, program_id: "golf-101", name: "Test Learner" });
ok(r.status === 200, "SaaS can assign a program to a subject_id");
ok(r.body.registration.completion_status === "not attempted"
   && r.body.registration.success_status === "unknown",
   "registration starts as two separate columns, not one status");

/* ---- launch ticket ---- */
r = await post("/api/launch", { subject_id: SUBJECT, program_id: "golf-101" });
const ticket = r.body.token;
ok(!!ticket && r.body.expires_in <= 60, "launch ticket issued, short lived");
// Assert the invariant — a DIFFERENT origin — not a literal host, which
// changes the moment the server binds to a LAN address for mobile testing.
const launchOrigin = new URL(r.body.launch_url).origin;
ok(launchOrigin !== new URL(API).origin,
   `player URL is on a separate origin (${launchOrigin}), not the app origin`);

/* ---- security: replay and forgery ---- */
r = await call("/api/runtime/redeem", { token: ticket });
const regId = r.body.registration.id;
const session = r.body.session;
ok(r.status === 200 && regId, "ticket redeems once");
ok(!!session, "redeeming mints a session token scoped to this registration");

r = await call("/api/runtime/redeem", { token: ticket });
ok(r.status === 403 && /already used/.test(r.body.error), "replaying the same ticket is refused");

r = await call("/api/runtime/redeem", { token: "0".repeat(32) });
ok(r.status === 403, "a made-up ticket is refused");

/* ---- the IDOR that runtime endpoints invite ---- */
r = await call(`/api/runtime/${regId}/set`, { key: "cmi.core.score.raw", value: "100" });
ok(r.status === 401, "runtime write with NO session token is refused");

r = await call(`/api/runtime/${regId}/set`, { key: "cmi.core.score.raw", value: "100" },
               { Authorization: "Bearer forged.token" });
ok(r.status === 403, "runtime write with a forged session is refused");

r = await runtime(`/api/runtime/${regId + 9999}/set`,
                  { key: "cmi.core.score.raw", value: "100" }, session);
ok(r.status === 403 && /not valid for this registration/.test(r.body.error || ""),
   "\x1b[1ma valid session cannot write to a DIFFERENT registration\x1b[0m");

/* ---- replay the real course's call sequence ---- */
const set = (key, value) => runtime(`/api/runtime/${regId}/set`, { key, value }, session);

await set("cmi.core.lesson_status", "incomplete");
await set("cmi.core.lesson_location", "0");
for (let i = 1; i <= 14; i++) await set("cmi.core.lesson_location", String(i));

r = await set("cmi.core.lesson_status", "completed");
ok(r.body.registration.completion_status === "completed"
   && r.body.registration.success_status === "unknown",
   'writing "completed" sets completion and leaves success untouched');

await set("cmi.core.score.raw", "80");
await set("cmi.core.score.min", "0");
await set("cmi.core.score.max", "100");

r = await set("cmi.core.lesson_status", "passed");
ok(r.body.registration.completion_status === "completed",
   '\x1b[1mwriting "passed" does NOT destroy the completion fact\x1b[0m');
ok(r.body.registration.success_status === "passed", 'success_status becomes "passed"');
ok(r.body.registration.score_raw === 80, "score persisted as a number");

/* suspend_data stored opaquely, with its length */
const blob = "x".repeat(5000);
r = await set("cmi.suspend_data", blob);
ok(r.body.registration.suspend_data === blob, "suspend_data round-trips byte for byte");
ok(r.body.registration.suspend_data_len === 5000,
   "suspend_data length recorded (5000 > the 4096 cap — queryable, not anecdotal)");

/* time normalized on write — note the missing fractional part */
r = await set("cmi.core.session_time", "0000:07:24");
ok(r.body.registration.total_seconds === 444,
   'session_time "0000:07:24" normalized to 444 seconds despite no fractional part');

/* ---- terminate ---- */
r = await runtime(`/api/runtime/${regId}/terminate`, {}, session);
ok(r.body.registration.terminated_at !== null, "terminate closes the session");
ok(r.body.webhook?.payload?.subject_id === SUBJECT
   && r.body.webhook?.payload?.program_id === "golf-101",
   "webhook payload carries subject_id + program_id — the integration contract");
ok(r.body.webhook?.delivered === true,
   "\x1b[1mcompletion delivered to the SaaS stub, signature verified\x1b[0m");

/* ---- persistence survives, and a new attempt starts clean ---- */
r = await post("/api/launch", { subject_id: SUBJECT, program_id: "golf-101" });
const r2 = await call("/api/runtime/redeem", { token: r.body.token });
ok(r2.body.registration.attempt === 2, "normal exit → next launch is attempt 2, not a resume");
ok(r2.body.registration.location === "", "new attempt starts with a cleared bookmark");
ok(r2.body.registration.total_seconds === 444, "total_time carries across attempts");

/* ---- learner accounts ---- */
const EMAIL = `${SUBJECT}@example.com`;
r = await post("/api/users", { subject_id: SUBJECT, name: "Smoke Learner",
                               email: EMAIL, password: "golf1234" });
ok(r.status === 200 && r.body.person.name === "Smoke Learner",
   "SaaS can provision a learner with credentials");
ok(r.body.credential && !("secret_hash" in r.body.credential),
   "the password hash is never echoed back, even to a trusted caller");

r = await call("/api/auth/login", { identifier: EMAIL, password: "wrong" });
const unknown = await call("/api/auth/login", { identifier: "nobody@example.com", password: "wrong" });
ok(r.status === 401 && unknown.status === 401 && r.body.error === unknown.body.error,
   "wrong password and unknown account return an identical response (no enumeration)");

r = await call("/api/auth/login", { identifier: EMAIL.toUpperCase(), password: "golf1234" });
const learner = r.body.token;
ok(r.status === 200 && !!learner, "learner signs in; email matched case-insensitively");

r = await fetch(`${API}/api/me/assignments`, { headers: { Authorization: `Bearer ${learner}` } })
      .then(async x => ({ status: x.status, body: await x.json() }));
ok(r.status === 200 && r.body.programs.length > 0, "learner sees their own assignments");

r = await call("/api/me/launch", { program_id: "golf-101" }, { Authorization: `Bearer ${learner}` });
ok(r.status === 200 && /\/player\?ticket=/.test(r.body.launch_url || ""),
   "learner can launch a program assigned to them");

r = await call("/api/me/launch", { program_id: "asset-only" }, { Authorization: `Bearer ${learner}` });
ok(r.status === 403, "\x1b[1mlearner cannot launch a program they were not assigned\x1b[0m");

/* the two session types must not be interchangeable */
r = await call(`/api/runtime/${regId}/set`, { key: "cmi.core.score.raw", value: "100" },
               { Authorization: `Bearer ${learner}` });
ok(r.status === 403,
   "\x1b[1ma learner session cannot be used as a runtime session\x1b[0m");

r = await fetch(`${API}/api/me/assignments`, { headers: { Authorization: `Bearer ${session}` } })
      .then(x => ({ status: x.status }));
ok(r.status === 401, "a runtime session cannot be used as a learner session");

r = await call("/api/me/assignments", {}, {});
ok(r.status === 401 || r.status === 404, "learner endpoints reject anonymous callers");

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
