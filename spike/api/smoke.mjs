#!/usr/bin/env node
/**
 * End-to-end smoke test of the Waypoint PoC API.
 * Replays the exact call sequence observed from a real SCORM 1.2 course,
 * then asserts the server got the right answer.
 *
 *   node spike/api/smoke.mjs              private server, throwaway database
 *   node spike/api/smoke.mjs <appOrigin>  a server you name, and its data
 *
 * ---------------------------------------------------------------------------
 * WHY IT STARTS ITS OWN SERVER
 *
 * It used to default to http://localhost:8090 — which is exactly where
 * `./spike/demo start` listens, backed by the real `spike/data` database. So
 * the ordinary way to run this ("node spike/api/smoke.mjs", no arguments) wrote
 * a few hundred test subjects, registrations, visits and ingested packages
 * straight into the demo.
 *
 * Nothing failed. The tests passed, because they were testing a real server
 * that really worked. The damage showed up later and somewhere else: a demo
 * with junk subjects in the roster, discovered by whoever opened it next —
 * more than once, in the middle of preparing to show it to somebody.
 *
 * A test that can destroy the thing it is testing is a test people stop
 * running. So the default is now a server of its own, on ports nothing else
 * uses, against a database in a temporary directory that is deleted afterwards.
 *
 * Naming an origin still works and still writes to whatever is behind it —
 * that is the point of naming one — but you have to say it out loud.
 * ---------------------------------------------------------------------------
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIVEN = process.argv[2] || null;

/* Ports well away from anything the project uses: 8080/8081/8092 are the
   defaults, 8090-8092 is `./spike/demo`, 8081 is Metro. */
const PORTS = { app: 8781, content: 8782, saas: 8783 };

let child = null, tmp = null;

/** Tear down whatever we started, once, on every exit path. */
function cleanup() {
  if (child) { try { child.kill("SIGTERM") } catch {} child = null; }
  if (tmp) { try { rmSync(tmp, { recursive: true, force: true }) } catch {} tmp = null; }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });

async function startPrivateServer() {
  tmp = mkdtempSync(join(tmpdir(), "waypoint-smoke-"));
  const env = {
    ...process.env,
    WAYPOINT_DATA_DIR: tmp,
    WAYPOINT_API_KEY: "wp_smoke_key",
    APP_PORT: String(PORTS.app),
    CONTENT_PORT: String(PORTS.content),
    SAAS_PORT: String(PORTS.saas),
    WAYPOINT_APP_ORIGIN: `http://localhost:${PORTS.app}`,
    WAYPOINT_CONTENT_ORIGIN: `http://localhost:${PORTS.content}`,
    WAYPOINT_SAAS_ORIGIN: `http://localhost:${PORTS.saas}`
  };

  /* Started from the repo root, not from wherever the caller happened to be.
     Ingest is given corpus paths like "spike/corpus/…" which the SERVER
     resolves against its own cwd, so running this from spike/ produced a wall
     of ingest failures that looked like a broken parser. Same shape as the
     bug that made test-insights.mjs pass from one directory and fail from
     another, which I called flakiness twice before reading it properly. */
  const repoRoot = new URL("../../", import.meta.url).pathname;

  child = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname],
                { env, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });

  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });
  child.on("exit", code => {
    if (child) {   // exited on its own, before we killed it
      console.error(`\n  the private server exited (${code}). Its output:\n`);
      console.error(log.split("\n").map(l => "    " + l).join("\n"));
      process.exit(1);
    }
  });

  const base = `http://localhost:${PORTS.app}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + "/api/status", { headers: { Authorization: "Bearer wp_smoke_key" } }); return base; }
    catch { await new Promise(r => setTimeout(r, 150)); }
  }
  console.error("\n  the private server never came up. Its output:\n");
  console.error(log.split("\n").map(l => "    " + l).join("\n"));
  process.exit(1);
}

const API = GIVEN || await startPrivateServer();
const KEY = GIVEN ? (process.env.WAYPOINT_API_KEY || "wp_demo_key_123") : "wp_smoke_key";

/* Northwood's origin. Given explicitly as the second argument, or derived the
   old way from a named app origin, or — for the private server — simply known. */
const SAAS_BASE = GIVEN
  ? (process.argv[3] || GIVEN.replace(/:8090$/, ":8092"))
  : `http://localhost:${PORTS.saas}`;

/* Say which database is about to be written to, every time. The same one line
   that would have made the old behaviour obvious on the first run instead of
   the tenth. */
console.log(GIVEN
  ? `\n  \x1b[33mWriting to a server you named: ${API}\x1b[0m`
  + `\n  \x1b[2mIts data will be modified. Run with no argument for a private one.\x1b[0m`
  : `\n  \x1b[2mPrivate server on ${API}, throwaway database in ${tmp}\x1b[0m`);

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
ok(r.body.registration.suspend_data_len === 5000
   && r.body.registration.suspend_data?.length === 5000,
   "\x1b[1mover-cap suspend_data is stored IN FULL — truncating it is the bug\x1b[0m");
ok(!!r.body.registration.suspend_overflow_at,
   "\x1b[1mthe overflow is stamped, so it is discoverable before the learner finds it\x1b[0m");

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
ok(r2.body.registration.entry === "ab-initio",
   "a genuinely new attempt is announced as ab-initio");

/* A resumed registration must SAY it is resuming. We handed courses
   "ab-initio" alongside 1,835 bytes of suspend_data — a contradiction Rise
   tolerated, and a stricter course would answer by discarding the state. */
{
  const rid = r2.body.registration.id, sess2 = r2.body.session;
  await runtime(`/api/runtime/${rid}/set`,
                { key: "cmi.core.lesson_location", value: "page-3" }, sess2);
  await runtime(`/api/runtime/${rid}/set`,
                { key: "cmi.suspend_data", value: "state-here" }, sess2);
  await runtime(`/api/runtime/${rid}/set`,
                { key: "cmi.core.exit", value: "suspend" }, sess2);
  await runtime(`/api/runtime/${rid}/terminate`, {}, sess2);

  const again = await post("/api/launch", { subject_id: SUBJECT, program_id: "golf-101" });
  const back = await call("/api/runtime/redeem", { token: again.body.token });
  ok(back.body.registration.entry === "resume",
     "\x1b[1ma suspended registration is announced as a resume, not a fresh start\x1b[0m");

  /* Rise 360 leaves exit_mode="suspend" on a course the learner FINISHED.
     Resuming that row would drop them back into the attempt that already says
     they passed, and overwrite it. Attempts are rows. */
  const rid2 = back.body.registration.id, sess3 = back.body.session;
  await runtime(`/api/runtime/${rid2}/set`,
                { key: "cmi.core.lesson_status", value: "completed" }, sess3);
  await runtime(`/api/runtime/${rid2}/set`,
                { key: "cmi.core.exit", value: "suspend" }, sess3);
  await runtime(`/api/runtime/${rid2}/terminate`, {}, sess3);

  const retake = await post("/api/launch", { subject_id: SUBJECT, program_id: "golf-101" });
  const fresh = await call("/api/runtime/redeem", { token: retake.body.token });
  ok(fresh.body.registration.attempt === back.body.registration.attempt + 1,
     "\x1b[1ma COMPLETED course starts a new attempt, even when left suspended\x1b[0m");
  ok(fresh.body.registration.completion_status !== "completed",
     "and the retake does not inherit the previous attempt's completion");
  ok(back.body.registration.suspend_data === "state-here"
     && back.body.registration.location === "page-3",
     "and its bookmark and suspend_data come back byte-for-byte");
}
ok(r2.body.registration.total_seconds === 444, "total_time carries across attempts");

/* ---- learner accounts ---- */
const EMAIL = `${SUBJECT}@example.com`;
r = await post("/api/users", { subject_id: SUBJECT, name: "Smoke Learner",
                               email: EMAIL, password: "golf1234" });
ok(r.status === 200 && r.body.person.name === "Smoke Learner",
   "SaaS can provision a learner with credentials");
ok(r.body.credential && !("secret_hash" in r.body.credential),
   "the password hash is never echoed back, even to a trusted caller");
ok(r.body.issued === true, "provisioning a learner with no login issues one");

/* Assigning a second program must not rotate a password already handed over. */
r = await post("/api/users", { subject_id: SUBJECT, name: "Smoke Learner",
                               email: EMAIL, password: "different5678" });
ok(r.body.issued === false, "a second provision does not silently reissue the password");
r = await post("/api/auth/login", { identifier: EMAIL, password: "different5678" });
ok(r.status === 401, "\x1b[1mthe password that was never issued does not work\x1b[0m");
r = await post("/api/auth/login", { identifier: EMAIL, password: "golf1234" });
ok(r.status === 200, "\x1b[1mthe original password still works after re-provisioning\x1b[0m");

/* An explicit reset is still possible — it is silence that was the bug. */
r = await post("/api/users", { subject_id: SUBJECT, name: "Smoke Learner", email: EMAIL,
                               password: "reset9012", reset_password: true });
ok(r.body.issued === true, "an explicit reset_password does replace it");
r = await post("/api/auth/login", { identifier: EMAIL, password: "reset9012" });
ok(r.status === 200, "the reset password works");
r = await post("/api/users", { subject_id: SUBJECT, name: "Smoke Learner",
                               email: EMAIL, password: "golf1234", reset_password: true });

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


/* ---- the subject's side of the supervision agreement -------------------
   Northwood's own surface, so it needs the mock SaaS. Skipped rather than
   failed when only Waypoint is running — a red cross for "not started" is
   noise, and this suite's job is the runtime. Operates on the seeded subject
   who has no agreement, so it never disturbs the demo. */
/**
 * Northwood's origin.
 *
 * Was `API.replace(/:8090$/, ":8092")` — which silently produced the WRONG
 * origin for any API not on port 8090. It did not fail: `SAAS` came out equal
 * to `API`, the staff login 404'd, and the eight `if (staff …)` blocks below
 * skipped themselves. The suite reported 63 passed, 0 failed, having quietly
 * not run about three quarters of itself.
 *
 * A skipped test that announces nothing is worse than a failing one. So this
 * is passed in rather than guessed at, and the count is asserted at the end.
 */
const SAAS = SAAS_BASE;
const AGREEMENT_SUBJECT = "cust-1041";

/* The demo seed populates ONE subject and leaves the other bare. Checks that
   drive a module from empty use the bare one; checks that need "somebody
   else's record" use the populated one. Named here so swapping which is which
   is a two-line change rather than a hunt through hardcoded ids. */
const OTHER_SUBJECT = "cust-2298";

const saas = async (p, b, headers = {}, method = "POST") => {
  const r = await fetch(SAAS + p, { method,
    headers: { "Content-Type": "application/json", ...headers },
    body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const staff = await saas("/auth/login",
  { email: "r.alvarez@northwood.gov", password: "northwood" }).catch(() => null);

if (!staff || staff.status !== 200) {
  console.log(`\n  \x1b[33m—\x1b[0m supervision agreement checks skipped (no mock SaaS at ${SAAS})`);
} else {
  console.log("");
  const SH = { Authorization: `Bearer ${staff.body.token}` };
  const existing = await saas(`/api/agreement?subject_id=${AGREEMENT_SUBJECT}`,
                              undefined, SH, "GET");

  if (existing.body?.agreement) {
    console.log(`  \x1b[33m—\x1b[0m supervision agreement checks skipped `
              + `(${AGREEMENT_SUBJECT} already has one — run ./spike/demo reset)`);
  } else {
    /* Creating a draft must return THE DRAFT. It used to return whatever
       agreement the subject already had, preferring an active one — so the
       console then edited the executed agreement believing it was a new draft. */
    const first = await saas("/api/agreement/save",
      { subject_id: AGREEMENT_SUBJECT, kind: "parole" }, SH);
    ok(first.body.agreement.status === "draft" && !first.body.agreement.officer_signed_at,
       "\x1b[1mcreating an agreement returns the row it created, not an existing one\x1b[0m");

    const premature = await saas("/api/agreement/save",
      { id: first.body.agreement.id, status: "active" }, SH);
    ok(premature.status === 409,
       "a draft nobody has signed cannot be activated");

    let a = (await saas("/api/agreement/save", { subject_id: AGREEMENT_SUBJECT,
      kind: "parole", supervision_level: "standard", start_date: "2026-01-05",
      end_date: "2027-01-04", office: "Northwood Corrections", officer_name: "R. Alvarez",
      violation_text: "Non-compliance may result in revocation proceedings." }, SH)).body.agreement;

    await saas("/api/agreement/condition", { agreement_id: a.id, category: "reporting",
      body: "Report as directed." }, SH);
    await saas("/api/agreement/sign", { id: a.id }, SH);
    await saas("/api/agreement/save", { id: a.id, status: "active" }, SH);

    // The subject reads it with their own Waypoint token; Northwood asks
    // Waypoint who that token belongs to rather than trusting the client.
    // The seed gives them a login; if one is somehow missing, mint it.
    const email = `${AGREEMENT_SUBJECT}@example.com`;
    let login = await call("/api/auth/login", { identifier: email, password: "northwood" });
    if (login.status !== 200) {
      const pw = (await saas("/api/subject/login", { subject_id: AGREEMENT_SUBJECT }, SH))
                   .body?.credentials?.password;
      login = await call("/api/auth/login", { identifier: email, password: pw });
    }
    ok(login.status === 200, "the subject can sign in to read their agreement");
    const LH = { Authorization: `Bearer ${login.body.token}` };

    let me = await saas("/api/me/case", undefined, LH, "GET");
    ok(me.body.agreement?.id === a.id, "the subject sees their active agreement");
    ok(me.body.agreement?.subject_signed_at === null,
       "and it starts unacknowledged");
    ok(Array.isArray(me.body.condition_categories) && me.body.condition_categories.length > 0,
       "category labels travel with it, so both clients group conditions as the PDF does");

    const anon = await saas("/api/me/agreement/sign", {}, {});
    ok(anon.status === 401, "\x1b[1man acknowledgment cannot be recorded without the subject's own token\x1b[0m");

    let sig = await saas("/api/me/agreement/sign", {}, LH);
    ok(sig.status === 200 && sig.body.agreement.subject_signed_at,
       "\x1b[1mthe subject acknowledges the agreement\x1b[0m");

    const acked = sig.body.agreement.subject_signed_at;
    sig = await saas("/api/me/agreement/sign", {}, LH);
    ok(sig.body.agreement.subject_signed_at === acked,
       "acknowledging twice is idempotent — the first timestamp stands");

    // Amending withdraws it: their acknowledgment referred to the old text.
    const amend = await saas("/api/agreement/condition", { agreement_id: a.id,
      category: "special", body: "Complete 40 hours of community service." }, SH);
    ok(amend.body.amended === true, "amending an executed agreement reports the withdrawal");

    me = await saas("/api/me/case", undefined, LH, "GET");
    ok(me.body.agreement.subject_signed_at === null && me.body.agreement.amended_at,
       "\x1b[1man amendment withdraws the acknowledgment and asks the subject again\x1b[0m");

    const status = await saas("/api/agreement/save", { id: a.id, status: "active" }, SH);
    ok(status.body.amended === false,
       "a status change is not an amendment — only the terms are");

    await saas("/api/me/agreement/sign", {}, LH);
    const hist = await saas(`/api/agreement/acknowledgments?agreement_id=${a.id}`,
                            undefined, SH, "GET");
    ok(hist.body.acknowledgments?.length === 2,
       "both acknowledgments are kept — the record is append-only");
    ok(hist.body.acknowledgments[0].snapshot_bytes > hist.body.acknowledgments[1].snapshot_bytes,
       "\x1b[1meach one stores the agreement text as it read at that moment\x1b[0m");
  }
}


/* ---- the seeded demo logins survive a reset ---------------------------
   A demo credential that changes every time the database is rebuilt is a
   credential nobody can write down. These are seeded, so they must work on
   any freshly reset database. */
r = await call("/api/auth/login", { identifier: "cust-1041@example.com", password: "northwood" });
ok(r.status === 200, "\x1b[1mthe seeded subject login works on a fresh database\x1b[0m");
r = await call("/api/auth/login", { identifier: "cust-2298@example.com", password: "northwood" });
ok(r.status === 200, "both seeded subjects can sign in");


/* ---- employment ----------------------------------------------------- */
if (staff && staff.status === 200) {
  console.log("");
  const SH = { Authorization: `Bearer ${staff.body.token}` };
  const SUB = "cust-1041";

  /* Same rule: this is a real demo subject, so whatever was here goes back. */
  const before = (await saas(`/api/subject/detail?subject_id=${SUB}`, undefined, SH, "GET"))
                   .body.employment;

  let e = await saas("/api/employment", { subject_id: SUB, status: "employed",
    company_name: "Ridgeway Fabrication", address: "1180 Industrial Dr, Kingsport, TN",
    phone: "(423) 555-0166", supervisor: "J. Barrett" }, SH);
  ok(e.status === 200 && e.body.employment.company_name === "Ridgeway Fabrication",
     "employment records the employer");

  e = await saas("/api/employment", { subject_id: SUB, status: "employed",
                                      company_name: "   " }, SH);
  ok(e.status === 400, "employed with no company name is refused");

  e = await saas("/api/employment", { subject_id: SUB, status: "self_employed",
    company_name: "Ridgeway Fabrication", supervisor: "J. Barrett" }, SH);
  ok(e.body.employment.company_name === null && e.body.employment.supervisor === null,
     "\x1b[1mleaving employment clears the employer rather than leaving it to read as current\x1b[0m");

  e = await saas("/api/employment", { subject_id: SUB, status: "retired" }, SH);
  ok(e.status === 400, "an unknown employment status is refused");

  // The officer's tiles and the subject's own view both read it.
  /* The subject reports their own employment; both sides write one record. */
  const login0 = await call("/api/auth/login",
    { identifier: `${SUB}@example.com`, password: "northwood" });
  const LH0 = { Authorization: `Bearer ${login0.body.token}` };

  e = await saas("/api/me/employment", { status: "employed",
        company_name: "Cassell Joinery", supervisor: "P. Cassell" }, LH0);
  ok(e.status === 200 && e.body.employment.updated_by === "subject",
     "\x1b[1mthe subject updates their own employment, attributed to them\x1b[0m");

  const asOfficer = await saas(`/api/subject/detail?subject_id=${SUB}`, undefined, SH, "GET");
  ok(asOfficer.body.employment.company_name === "Cassell Joinery",
     "the officer sees the change immediately — one record, not two");

  e = await saas("/api/me/employment", { status: "employed", company_name: " " }, LH0);
  ok(e.status === 400, "the same rules apply on the subject's side");

  const anonEmp = await saas("/api/me/employment", { status: "not_employed" }, {});
  ok(anonEmp.status === 401, "employment cannot be changed without the subject's own token");

  e = await saas("/api/employment", { subject_id: SUB, status: "self_employed" }, SH);
  ok(e.body.employment.updated_by === "officer",
     "and an officer edit is attributed back to the officer");

  const detail = await saas(`/api/subject/detail?subject_id=${SUB}`, undefined, SH, "GET");
  ok(detail.body.employment?.status === "self_employed",
     "employment reaches the officer's profile tiles");

  const login = await call("/api/auth/login",
    { identifier: `${SUB}@example.com`, password: "northwood" });
  const me = await saas("/api/me/case", undefined,
                        { Authorization: `Bearer ${login.body.token}` }, "GET");
  ok(me.body.employment?.status === "self_employed",
     "and the subject sees their own employment record");

  await saas("/api/employment", { subject_id: SUB, ...(before || { status: "not_employed" }) }, SH);
}


/* ---- family contacts: the first module both sides may write ---------- */
if (staff && staff.status === 200) {
  console.log("");
  const SH = { Authorization: `Bearer ${staff.body.token}` };
  const SUB = "cust-1041", OTHER = "cust-2298";

  /* This block writes to a real demo subject, so it cleans up after itself.
     A test suite that leaves rows behind turns every demo into a hunt for
     which records are real. */
  const litter = [];

  let c = await saas("/api/contacts", { subject_id: SUB, name: "Bob Smith",
                     relationship: "Uncle", phone: "333-222-1111" }, SH);
  ok(c.status === 200 && c.body.contact.added_by === "officer",
     "the officer adds a contact, recorded as theirs");
  const officerContact = c.body.contact.id;
  litter.push(officerContact);

  for (const [payload, why] of [
    [{ subject_id: SUB, name: "", relationship: "Uncle", phone: "333-222-1111" }, "a name"],
    [{ subject_id: SUB, name: "X", relationship: "Landlord", phone: "333-222-1111" },
     "a known relationship"],
    [{ subject_id: SUB, name: "X", relationship: "Uncle", phone: "12" }, "a real phone number"]
  ]) {
    const bad = await saas("/api/contacts", payload, SH);
    ok(bad.status === 400, `a contact needs ${why}`);
  }

  const login = await call("/api/auth/login",
    { identifier: `${SUB}@example.com`, password: "northwood" });
  const LH = { Authorization: `Bearer ${login.body.token}` };

  c = await saas("/api/me/contacts", { name: "Marie Whitfield",
                 relationship: "Mother", phone: "(423) 555-0188" }, LH);
  ok(c.status === 200 && c.body.contact.added_by === "subject",
     "the subject adds their own, recorded as theirs");
  litter.push(c.body.contact.id);

  // Both write the same list — two lists would disagree about one person.
  // Asserted by identity, not by count: the count depends on whatever the
  // database already held, which is not what this is testing.
  const ids = c.body.contacts.map(x => x.id);
  ok(ids.includes(officerContact) && ids.includes(c.body.contact.id),
     "\x1b[1mboth sides read and write one list, not two\x1b[0m");

  const edited = await saas("/api/me/contacts", { id: officerContact, name: "Bob Smith",
                            relationship: "Uncle", phone: "333-222-9999" }, LH);
  ok(edited.body.contact.phone === "333-222-9999" && edited.body.contact.updated_by === "subject",
     "the subject can correct a contact the officer added, and the edit is attributed");

  // Identity comes from the token, never the body.
  const theirs = await saas("/api/contacts", { subject_id: OTHER, name: "Someone Else",
                            relationship: "Friend", phone: "555-000-1111" }, SH);
  litter.push(theirs.body.contact.id);
  const hijack = await saas("/api/me/contacts", { id: theirs.body.contact.id,
                            name: "Hijacked", relationship: "Friend",
                            phone: "555-000-1111" }, LH);
  ok(hijack.status === 404,
     "\x1b[1ma subject cannot edit another subject's contact by guessing an id\x1b[0m");
  const hijackDel = await saas("/api/me/contacts/delete",
                               { id: theirs.body.contact.id }, LH);
  ok(hijackDel.status === 404, "nor delete one");

  const spoof = await saas("/api/me/contacts", { subject_id: OTHER, name: "Planted",
                           relationship: "Friend", phone: "555-000-2222" }, LH);
  ok(spoof.body.contact.subject_id === SUB,
     "a subject_id in the body is ignored — the token decides whose list it is");
  litter.push(spoof.body.contact.id);

  const gone = await saas("/api/contacts/delete", { id: officerContact }, SH);
  ok(gone.status === 200 && !gone.body.contacts.some(x => x.id === officerContact),
     "the officer removes a contact");

  for (const id of litter) await saas("/api/contacts/delete", { id }, SH);
}


/* ---- secrets and the demo shim --------------------------------------- */
const keysAnon = await fetch(API + "/api/console/keys").then(r => r.status);
ok(keysAnon === 401,
   "\x1b[1mthe API key and webhook secret are not readable without the API key\x1b[0m");

const demoTicket = await fetch(
  API + "/demo/launch-url?subject=attacker&program=golf-101").then(r => r.status);
ok(demoTicket === 404,
   "\x1b[1ma browser cannot mint a launch ticket for an arbitrary subject\x1b[0m");

/* Passwords must not come from a predictable PRNG. Not proof of CSPRNG use,
   but it catches the obvious regression: a small or repeating range. */
const seen = new Set();
for (let i = 0; i < 12; i++) {
  const r = await fetch(SAAS + "/api/subject/login", {
    method: "POST", headers: { "Content-Type": "application/json", ...(staff?.status === 200
      ? { Authorization: `Bearer ${staff.body.token}` } : {}) },
    body: JSON.stringify({ subject_id: "cust-1041", reset: true })
  }).then(r => r.json()).catch(() => ({}));
  if (r?.credentials?.password) seen.add(r.credentials.password);
}
if (seen.size) {
  ok(seen.size >= 10, "generated passwords do not repeat across 12 draws");
  // Put the seeded demo password back. This test rotates a real demo login
  // twelve times; leaving it rotated locks the subject out of the demo.
  await post("/api/users", { subject_id: "cust-1041", name: "Dana Whitfield",
    email: "cust-1041@example.com", password: "northwood", reset_password: true });
}


/* ---- session_time is not a delta -------------------------------------
   A real Rise 360 course commits periodically, rewriting session_time as it
   grows. Adding each write summed a growing series and reported 155 minutes
   for 10 minutes of work. Rustici's sample hid it by writing the value once,
   at Finish — which is exactly why one well-behaved package is not a corpus. */
{
  const s2 = await post("/api/launch", { subject_id: SUBJECT, program_id: "golf-101" });
  const red = await call("/api/runtime/redeem", { token: s2.body.token });
  const rid = red.body.registration.id, sess = red.body.session;
  const before = red.body.registration.total_seconds || 0;

  const set = (k, v) => runtime(`/api/runtime/${rid}/set`, { key: k, value: v }, sess);
  await set("cmi.core.session_time", "00:01:00");
  await set("cmi.core.session_time", "00:02:00");
  let r3 = await set("cmi.core.session_time", "00:03:00");

  ok(r3.body.registration.total_seconds === before + 180,
     "\x1b[1mrepeated session_time writes report the latest value, not their sum\x1b[0m");

  r3 = await runtime(`/api/runtime/${rid}/terminate`, {}, sess);
  ok(r3.body.registration.total_seconds === before + 180,
     "closing the session accrues that time exactly once");

  /* Rise 360 sent session_time AFTER LMSFinish. Accepting it would have
     counted that time twice on the next exit. */
  const late = await runtime(`/api/runtime/${rid}/set`,
                             { key: "cmi.core.session_time", value: "00:05:00" }, sess);
  ok(late.status === 409,
     "\x1b[1ma write after Terminate is refused, as SCORM requires\x1b[0m");
}


/* ---- a runtime session must outlive a restart ------------------------
   The signing secret used to be regenerated per boot, so every restart
   silently invalidated every course already in flight: writes refused, and
   the Terminate that records the completion never landed. A routine deploy
   would have done that to every learner mid-course. */
{
  const secretFile = new URL("../data/.session-secret", import.meta.url);
  const { existsSync, statSync } = await import("node:fs");
  ok(existsSync(secretFile), "the session secret is persisted, not regenerated per boot");
  if (existsSync(secretFile))
    ok((statSync(secretFile).mode & 0o077) === 0,
       "and it is readable only by its owner");
}


/* ---- a subject's own details ----------------------------------------- */
if (staff && staff.status === 200) {
  console.log("");
  const SH = { Authorization: `Bearer ${staff.body.token}` };
  const before = (await saas("/api/subjects", undefined, SH, "GET"))
                   .body.subjects.find(x => x.subject_id === "cust-1041");

  /* Dates are stored ISO so they can be compared, sorted and aged. Storing
     "17 April 1991" gives you prose you can do none of that with. */
  ok(/^\d{4}-\d{2}-\d{2}$/.test(before.dob),
     "\x1b[1mdates are stored ISO, not as display strings\x1b[0m");

  let r2 = await saas("/api/subject", { subject_id: "cust-1041", dob: "17 April 1991" }, SH);
  ok(r2.status === 400, "a date written as prose is refused");
  r2 = await saas("/api/subject", { subject_id: "cust-1041", dob: "2099-01-01" }, SH);
  ok(r2.status === 400, "a date of birth in the future is refused");
  r2 = await saas("/api/subject", { subject_id: "cust-1041", email: "nope" }, SH);
  ok(r2.status === 400, "a malformed email is refused");
  r2 = await saas("/api/subject", { subject_id: "cust-1041", first_name: "  " }, SH);
  ok(r2.status === 400, "a blank name is refused");

  r2 = await saas("/api/subject", { subject_id: "cust-1041", phone: "(423) 555-0100" }, SH);
  ok(r2.body.subject.phone === "(423) 555-0100", "an officer can edit the details");
  ok(r2.body.subject.dob === before.dob && r2.body.subject.city === before.city,
     "\x1b[1ma partial save leaves every field it did not mention alone\x1b[0m");

  /* officer_id and subject_id are assignment decisions, not demographics. */
  r2 = await saas("/api/subject",
                  { subject_id: "cust-1041", officer_id: 99, status: "Absconded" }, SH);
  const check = (await saas("/api/subjects", undefined, SH, "GET"))
                  .body.subjects.find(x => x.subject_id === "cust-1041");
  ok(check.officer === before.officer,
     "\x1b[1msupervising officer cannot be reassigned through the details form\x1b[0m");

  await saas("/api/subject", { subject_id: "cust-1041", phone: before.phone,
                               status: before.status }, SH);
}


/* ---- conducting a visit ----------------------------------------------- */
if (staff && staff.status === 200) {
  console.log("");
  const SH = { Authorization: `Bearer ${staff.body.token}` };
  /* One concept, one type. `year` is a TEXT column and its two callers
     disagreed: the form posts "2014", the seed passed the number 2014, which
     bound as REAL and stored the text "2014.0". */
  {
    const mk = async year => (await saas("/api/vehicles",
      { subject_id: "cust-1041", make: "Toyota", model: "Corolla", year }, SH))
      .body.vehicle;
    const asString = await mk("2019");
    const asNumber = await mk(2019);
    ok(asString.year === "2019" && asNumber.year === "2019",
       "\x1b[1ma model year stores identically whether it arrives as a string or a number\x1b[0m");
    const blank = await mk("");
    ok(blank.year === null, "and an empty year is null, not an empty string");
    const junk = await mk("nineteen ninety");
    ok(junk.year === null, "a year that is not a year is refused rather than stored");
    for (const v of [asString, asNumber, blank, junk])
      await saas("/api/vehicles/delete", { id: v.id }, SH);
  }

  const when = new Date(Date.now() + 864e5).toISOString();

  const made = await saas("/api/visits",
    { subject_id: "cust-1041", scheduled_at: when, officer: "R. Alvarez" }, SH);
  const vid = made.body.visit.id;
  ok(!made.body.visit.accepted_at, "a new visit starts unaccepted");

  /* ---- a caseload is whoever is assigned, and reassignment is explicit ---- */
  {
    const before = await saas("/api/officer/caseload", undefined, SH, "GET");
    const mine = new Set((before.body.subjects || []).map(x => x.subject_id));
    ok(mine.has("cust-1041") && mine.has("cust-2298"),
       "an officer's caseload is exactly the subjects assigned to them");

    /* An officer is being sent to a door, not a building. The unit number went
       missing in three places at once — the seed, the schedule query and the
       app's formatter — because each listed the address fields by hand. */
    const dana = (before.body.subjects || []).find(x => x.subject_id === "cust-1041");
    ok(dana.address_line1 === "1665 W 3500 S" && dana.address_line2 === "Apt 3B",
       "\x1b[1mthe caseload carries the second address line\x1b[0m");

    /* Two shapes on purpose: the caseload and the schedule carry the raw
       columns so a form can edit them, and /api/subjects carries the
       assembled version so a card can print it. An officer driving to a door
       needs the whole of the second, and its last line is City, ST ZIP — not
       three fields joined by commas. */
    const roster = (await saas("/api/subjects", undefined, SH, "GET")).body.subjects;
    const profile = roster.find(x => x.subject_id === "cust-1041");
    ok(profile.address === "1665 W 3500 S\nApt 3B\nWest Valley City, UT 84119",
       "\x1b[1mthe assembled address is complete and correctly formed\x1b[0m");
    const sched = await saas("/api/officer/schedule", undefined, SH, "GET");
    const onSched = (sched.body.upcoming || []).find(v => v.id === vid);
    ok(onSched?.address_line2 === "Apt 3B",
      "\x1b[1mand so does the visit the officer is being sent to\x1b[0m");

    const nak = (await saas("/api/subjects", undefined, SH, "GET")).body
      .officers.find(o => o.name === "T. Nakamura");
    let mv = await saas("/api/subject/officer",
      { subject_id: "cust-2298", officer_id: 999 }, SH);
    ok(mv.status === 400, "a subject cannot be moved to an officer who does not exist");

    mv = await saas("/api/subject/officer",
      { subject_id: "cust-2298", officer_id: nak.id }, SH);
    ok(mv.status === 200 && mv.body.subject.officer === "T. Nakamura",
       "\x1b[1ma subject can be transferred to another officer\x1b[0m");

    const after = await saas("/api/officer/caseload", undefined, SH, "GET");
    ok((after.body.subjects || []).length === mine.size - 1,
       "\x1b[1mand drops off the caseload they were transferred away from\x1b[0m");

    const notes = await saas(`/api/case-notes?subject_id=cust-2298`, undefined, SH, "GET");
    ok((notes.body.notes || []).some(n => /transferred/i.test(n.body)),
       "\x1b[1mthe transfer is on the record, not just in the column\x1b[0m");

    // put it back, so the rest of the suite sees the seeded roster
    const alv = (await saas("/api/subjects", undefined, SH, "GET")).body
      .officers.find(o => o.name === "R. Alvarez");
    await saas("/api/subject/officer", { subject_id: "cust-2298", officer_id: alv.id }, SH);
  }

  /* Acceptance is an acknowledgment, not permission. An officer may turn up to
     an appointment nobody confirmed — often the visit most worth making. */
  let r2 = await saas("/api/visits/start", { id: vid, officer: "R. Alvarez" }, SH);
  ok(r2.status === 200 && r2.body.visit.started_at,
     "\x1b[1man unaccepted visit can still be started\x1b[0m");

  const startedAt = r2.body.visit.started_at;
  r2 = await saas("/api/visits/start", { id: vid }, SH);
  ok(r2.body.visit.started_at === startedAt,
     "starting twice keeps the original time — a repeated tap is not a new arrival");

  /* ---- important dates ----
     The lifecycle is three facts, not one: seen, agreed to be there, and what
     actually happened. Most of these test that they stay apart. */
  {
    const DS = "cust-1041";
    let r = await saas("/api/important-dates", { subject_id: DS, kind: "court",
                                                 scheduled_at: "next Tuesday" }, SH);
    ok(r.status === 400, "a date and time that cannot be parsed is refused");

    r = await saas("/api/important-dates", { subject_id: DS, kind: "brunch",
                                             scheduled_at: "2026-09-18T09:30:00" }, SH);
    ok(r.status === 400, "an appointment must be a kind the server knows");

    r = await saas("/api/important-dates", { subject_id: DS, kind: "parole_board",
      title: "Parole board review", scheduled_at: "2026-09-18T09:30:00",
      location: "Board of Pardons, Room 3",
      address: "448 E Winchester St, Murray, UT 84107" }, SH);
    const appt = r.body.date;
    ok(r.status === 200 && appt.id, "an appointment can be created");
    ok(appt.state === "assigned",
       "\x1b[1man appointment starts Assigned — the subject does not know yet\x1b[0m");
    ok(appt.kind_label === "Parole board hearing",
       "and carries its label, so no client hard-codes the list");

    const lg = await call("/api/auth/login",
      { identifier: `${DS}@example.com`, password: "northwood" });
    const MH = { Authorization: `Bearer ${lg.body.token}` };

    let s2;
    let mine = await saas("/api/me/case", undefined, MH, "GET");
    ok((mine.body.important_dates || []).some(d => d.id === appt.id),
       "the subject sees it");
    ok(mine.body.unseen_dates >= 1, "and it counts as unseen until they open the tab");

    /* The app reports what it actually put in front of them, per appointment. */
    s2 = await saas("/api/me/important-dates/seen", { ids: [appt.id] }, MH);
    const afterSeen = s2.body.important_dates.find(d => d.id === appt.id);
    ok(s2.status === 200 && afterSeen.state === "viewed" && afterSeen.seen_at,
       "\x1b[1mviewing one appointment moves it to Viewed, on its own\x1b[0m");
    ok(afterSeen.state !== "accepted",
       "\x1b[1mand looking at it is not agreeing to be there\x1b[0m");

    const firstSeen = afterSeen.seen_at;
    s2 = await saas("/api/me/important-dates/seen", { ids: [appt.id] }, MH);
    ok(s2.body.important_dates.find(d => d.id === appt.id).seen_at === firstSeen,
       "\x1b[1mit keeps the first time it was seen, not the last\x1b[0m");

    /* A batch with one stale id still reports the rest. */
    s2 = await saas("/api/me/important-dates/seen", { ids: [appt.id, 999999] }, MH);
    ok(s2.status === 200, "one unknown id does not lose the rest of a batch");
    s2 = await saas("/api/me/important-dates/seen", { ids: [999999] }, MH);
    ok(s2.status === 404, "but a batch with nothing of theirs in it is a 404");

    s2 = await saas("/api/me/important-dates/acknowledge", { id: appt.id }, MH);
    ok(s2.status === 200 && s2.body.date.state === "accepted",
       "\x1b[1maccepting it is a separate act, and clears the flag\x1b[0m");

    s2 = await saas("/api/me/important-dates/acknowledge", { id: appt.id }, MH);
    ok(s2.status === 200, "acknowledging twice is idempotent — not a second promise");

    /* Moving it withdraws the acknowledgment. */
    r = await saas("/api/important-dates", { id: appt.id,
      scheduled_at: "2026-09-25T14:00:00" }, SH);
    ok(!r.body.date.acknowledged_at && r.body.date.state === "assigned",
       "\x1b[1mmoving an appointment withdraws both the acceptance and the view\x1b[0m");

    /* The lifecycle and "the day has passed" are separate facts. An earlier
       version made overdue a state, which meant a past appointment could no
       longer be told apart from one nobody had ever looked at. */
    const past = (await saas("/api/important-dates", { subject_id: DS, kind: "drug_test",
      scheduled_at: "2020-01-01T09:00:00" }, SH)).body.date;
    ok(past.state === "assigned" && past.awaiting_outcome === true,
       "\x1b[1ma past appointment keeps its lifecycle state and flags the outcome separately\x1b[0m");
    await saas("/api/me/important-dates/seen", { ids: [past.id] }, MH);
    await saas("/api/me/important-dates/acknowledge", { id: past.id }, MH);
    const acceptedLate = (await saas(`/api/important-dates?subject_id=${DS}`,
      undefined, SH, "GET")).body.dates.find(d => d.id === past.id);
    ok(acceptedLate.state === "accepted" && acceptedLate.awaiting_outcome === true,
       "\x1b[1mso \"accepted then went quiet\" reads differently from \"never looked at it\"\x1b[0m");
    await saas("/api/important-dates/delete", { id: past.id }, SH);

    await saas("/api/me/important-dates/acknowledge", { id: appt.id }, MH);

    /* Reporting the outcome. */
    s2 = await saas("/api/me/important-dates/close", { id: appt.id, status: "rescheduled" }, MH);
    ok(s2.status === 400, "the subject says attended or missed, not anything else");

    s2 = await saas("/api/me/important-dates/close",
      { id: appt.id, status: "completed", note: "Attended, decision in 30 days." }, MH);
    ok(s2.status === 200 && s2.body.date.status === "completed"
       && s2.body.date.completed_role === "subject",
       "\x1b[1mthe subject reports they attended, recorded as their claim\x1b[0m");

    r = await saas("/api/important-dates/close", { id: appt.id, status: "missed",
      note: "Court confirmed no appearance." }, SH);
    ok(r.body.date.completed_role === "officer" && r.body.date.status === "missed",
       "\x1b[1mthe officer can correct it, and the record says who said what\x1b[0m");

    /* Missed is an outcome, not a deletion. */
    ok(r.body.date.outcome_note === "Court confirmed no appearance.",
       "a missed appointment keeps why it was missed");

    /* Scoped to their own. */
    const foreign = (await saas("/api/important-dates", { subject_id: OTHER_SUBJECT,
      kind: "court", scheduled_at: "2026-10-01T10:00:00" }, SH)).body.date;
    s2 = await saas("/api/me/important-dates/acknowledge", { id: foreign.id }, MH);
    ok(s2.status === 404,
       "\x1b[1ma subject cannot acknowledge somebody else's appointment\x1b[0m");

    /* And cannot move their own. Tested by asking for the route rather than
       by watching a value not change — the absence is the guarantee, and a
       value comparison would only prove that one call did not happen to. */
    for (const path of ["/api/me/important-dates", "/api/me/important-dates/save",
                        "/api/me/important-dates/delete"]) {
      const gone = await saas(path, { id: appt.id,
        scheduled_at: "2027-01-01T10:00:00" }, MH);
      ok(gone.status === 404,
         `\x1b[1mthere is no ${path} — a court date is not something a subject moves\x1b[0m`);
    }

    await saas("/api/important-dates/delete", { id: foreign.id }, SH);
    await saas("/api/important-dates/delete", { id: appt.id }, SH);
  }

  /* ---- money ----
     Amounts are integer cents, a balance is computed, and payments are rows.
     The interesting cases are the ones where a float or a running total
     would have quietly lost something. */
  {
    const FS = "cust-1041";
    /* Measured as a CHANGE, not an absolute. This runs against whatever
       database is in front of it — a demo one has real obligations on it, and
       a test that assumes an empty ledger fails for reasons nothing to do
       with the code it is testing. */
    const base = (await saas(`/api/financial?subject_id=${FS}`, undefined, SH, "GET"))
                   .body.totals;

    let r = await saas("/api/financial", { subject_id: FS, kind: "restitution",
                                           amount: "twelve hundred" }, SH);
    ok(r.status === 400 && /amount/i.test(r.body.error),
       "\x1b[1man amount that cannot be parsed is refused, not recorded as zero\x1b[0m");

    r = await saas("/api/financial", { subject_id: FS, kind: "bribe", amount: "10" }, SH);
    ok(r.status === 400, "an obligation must be a kind the server knows");

    r = await saas("/api/financial", { subject_id: FS, kind: "restitution",
      description: "Victim restitution", amount: "$1,240.50", due_date: "2026-11-01" }, SH);
    const item = r.body.item;
    ok(r.status === 200 && item.amount_cents === 124050,
       "\x1b[1m\"$1,240.50\" is stored as 124050 cents, not a float\x1b[0m");
    ok(item.balance_cents === 124050 && item.state === "outstanding",
       "and its whole balance is outstanding");

    /* Two payments that a float would round wrong. */
    for (const amt of ["0.10", "0.20"])
      r = await saas("/api/financial/payment", { item_id: item.id, amount: amt,
                                                 paid_on: "2026-08-01" }, SH);
    ok(r.body.item.paid_cents === 30,
       "\x1b[1mtwo payments of 0.10 and 0.20 come to exactly 30 cents\x1b[0m");
    ok(r.body.item.balance_cents === 124020, "and the balance is exact");
    ok(r.body.item.payments.length === 2,
       "payments are rows — what was paid and when survives");

    r = await saas("/api/financial/payment", { item_id: item.id, amount: "99999" }, SH);
    ok(r.status === 400 && /more than/.test(r.body.error),
       "\x1b[1ma payment larger than the balance is refused, not absorbed\x1b[0m");

    r = await saas("/api/financial/payment", { item_id: item.id, amount: "10",
                                               paid_on: "2099-01-01" }, SH);
    ok(r.status === 400, "a payment cannot be dated in the future");

    /* ---- the subject records one too ---- */
    const lg = await call("/api/auth/login",
      { identifier: `${FS}@example.com`, password: "northwood" });
    const MH = { Authorization: `Bearer ${lg.body.token}` };

    let s2 = await saas("/api/me/financial/payment",
      { item_id: item.id, amount: "40.00", paid_on: "2026-08-20",
        method: "Cash at office" }, MH);
    ok(s2.status === 200 && s2.body.item.paid_cents === 4030,
       "\x1b[1mthe subject can record a payment they made at an office\x1b[0m");
    const theirs = s2.body.item.payments.find(x => x.amount_cents === 4000);
    ok(theirs.recorded_role === "subject",
       "\x1b[1mand the record says who claimed it — theirs, not the officer's\x1b[0m");

    /* Same validator on both sides. */
    s2 = await saas("/api/me/financial/payment",
      { item_id: item.id, amount: "999999" }, MH);
    ok(s2.status === 400 && /more than/.test(s2.body.error),
       "\x1b[1mneither side is the lenient one — one validator, both routes\x1b[0m");

    /* What they cannot do. */
    s2 = await saas("/api/me/financial/payment", { item_id: 999999, amount: "5" }, MH);
    ok(s2.status === 404, "a subject cannot pay against an obligation that is not theirs");

    const foreign = (await saas("/api/financial", { subject_id: OTHER_SUBJECT,
      kind: "fine", amount: "100" }, SH)).body.item;
    s2 = await saas("/api/me/financial/payment", { item_id: foreign.id, amount: "5" }, MH);
    ok(s2.status === 404,
       "\x1b[1mnor against somebody else's\x1b[0m");

    /* ---- waiving is not paying ---- */
    r = await saas("/api/financial/waive", { id: foreign.id }, SH);
    ok(r.status === 400 && /why/i.test(r.body.error),
       "waiving without a reason is refused — it stays on the record");

    const beforeWaive = (await saas(`/api/financial?subject_id=${OTHER_SUBJECT}`,
                                    undefined, SH, "GET")).body.totals;
    r = await saas("/api/financial/waive", { id: foreign.id,
      note: "Waived by the court on 12 August." }, SH);
    ok(r.body.item.state === "waived" && r.body.item.balance_cents === 0,
       "\x1b[1ma waived obligation owes nothing\x1b[0m");
    ok(r.body.item.amount_cents === 10000,
       "\x1b[1mbut the record still says what was imposed\x1b[0m");
    ok(r.body.totals.waived_cents - beforeWaive.waived_cents === 10000
       && r.body.totals.paid_cents === beforeWaive.paid_cents,
       "\x1b[1mand it is reported as waived, never as paid\x1b[0m");

    /* ---- totals ---- */
    const sum = await saas(`/api/financial?subject_id=${FS}`, undefined, SH, "GET");
    const t = sum.body.totals;
    ok(t.balance_cents - base.balance_cents === 124050 - 4030
       && t.paid_cents - base.paid_cents === 4030,
       "the total due is the sum of what is left on each item");
    ok(t.next_due <= "2026-11-01",
       "and the next date anything falls due is the earliest of them");

    await saas("/api/financial/delete", { id: foreign.id }, SH);
    await saas("/api/financial/delete", { id: item.id }, SH);
    const gone = await saas(`/api/financial?subject_id=${FS}`, undefined, SH, "GET");
    ok(gone.body.totals.balance_cents === base.balance_cents
       && gone.body.totals.paid_cents === base.paid_cents,
       "\x1b[1mdeleting an item takes its payments with it, leaving what was there before\x1b[0m");
  }

  /* ---- goals and action steps ----
     The interesting part is the tension between two rules: progress is
     computed from the steps, and completion is the officer's decision. Both
     have to hold at once. */
  {
    const SGL = "cust-1041";
    let r = await saas("/api/goals", { subject_id: SGL, title: "  ",
                                       due_date: "2026-10-15" }, SH);
    ok(r.status === 400, "a goal needs a title");

    r = await saas("/api/goals", { subject_id: SGL, title: "Obtain employment",
                                   due_date: "15 October" }, SH);
    ok(r.status === 400,
       "\x1b[1ma due date typed as prose is refused — it cannot be compared\x1b[0m");

    r = await saas("/api/goals", { subject_id: SGL, title: "Obtain employment",
      detail: "Secure full-time work before release.", due_date: "2026-10-15" }, SH);
    const goal = r.body.goal;
    ok(r.status === 200 && goal.id, "a goal can be assigned");
    ok(goal.progress.percent === 0 && goal.state === "not_started",
       "\x1b[1ma goal with no steps is 0%, not vacuously complete\x1b[0m");

    for (const body of ["Submit 10 resumes per week", "Visit the career office"])
      r = await saas("/api/goals/step", { goal_id: goal.id, body }, SH);
    ok(r.body.goal.steps.length === 2, "action steps can be added to it");

    r = await saas("/api/goals/step", { goal_id: goal.id, body: "   " }, SH);
    ok(r.status === 400, "an empty action step is refused");

    /* ---- the subject ticks off what they have done ---- */
    const lg = await call("/api/auth/login",
      { identifier: `${SGL}@example.com`, password: "northwood" });
    const MH = { Authorization: `Bearer ${lg.body.token}` };

    let mine = await saas("/api/me/case", undefined, MH, "GET");
    const g0 = (mine.body.goals || []).find(g => g.id === goal.id);
    ok(g0 && g0.steps.length === 2, "the subject sees the goal and its steps");
    ok(mine.body.unseen_goals >= 1, "and it counts as unseen until they open it");

    let s2 = await saas("/api/me/goals/step", { id: g0.steps[0].id }, MH);
    ok(s2.status === 200 && s2.body.step.done_by === "subject",
       "\x1b[1mthe subject ticks off a step, and who ticked it is recorded\x1b[0m");
    ok(s2.body.goal.progress.percent === 50, "progress is computed from the steps");
    ok(s2.body.goal.state === "in_progress", "and the goal reads as under way");

    /* Scoped to their own goals. */
    const other = await saas("/api/goals", { subject_id: OTHER_SUBJECT,
                                             title: "Somebody else's goal" }, SH);
    const foreignStep = (await saas("/api/goals/step",
      { goal_id: other.body.goal.id, body: "Not yours" }, SH)).body.goal.steps[0];
    s2 = await saas("/api/me/goals/step", { id: foreignStep.id }, MH);
    ok(s2.status === 404,
       "\x1b[1ma subject cannot tick off a step on somebody else's goal\x1b[0m");

    /* ---- every step done is still not the officer's decision ---- */
    r = await saas("/api/goals/step/done", { id: g0.steps[1].id }, SH);
    ok(r.body.goal.progress.percent === 100, "all steps done reads as 100%");
    ok(r.body.goal.status === "open",
       "\x1b[1mbut the goal does not close itself — ten resumes is not a job\x1b[0m");
    ok(r.body.goal.state === "awaiting_officer",
       "it reports as waiting on the officer instead");

    r = await saas("/api/goals/complete", { id: goal.id }, SH);
    ok(r.body.goal.status === "complete" && r.body.goal.completed_by,
       "\x1b[1mthe officer is who closes it, and is named on it\x1b[0m");

    r = await saas("/api/goals/complete", { id: goal.id, complete: false }, SH);
    ok(r.body.goal.status === "open" && !r.body.goal.completed_at,
       "and can reopen it, clearing the completion");

    /* A closed goal is not a to-do list any more. */
    await saas("/api/goals/complete", { id: goal.id }, SH);
    s2 = await saas("/api/me/goals/step", { id: g0.steps[0].id, done: false }, MH);
    ok(s2.status === 409, "a subject cannot work steps on a closed goal");

    /* ---- overdue is derived, not a fourth status ---- */
    await saas("/api/goals", { id: goal.id, status: "open",
                               due_date: "2020-01-01" }, SH);
    const late = (await saas(`/api/goals?subject_id=${SGL}`, undefined, SH, "GET"))
                   .body.goals.find(g => g.id === goal.id);
    ok(late.overdue === true && late.state === "overdue",
       "\x1b[1ma goal past its date reads as overdue without a status change\x1b[0m");

    await saas("/api/goals/delete", { id: other.body.goal.id }, SH);
    await saas("/api/goals/delete", { id: goal.id }, SH);
    const gone = await saas(`/api/goals?subject_id=${SGL}`, undefined, SH, "GET");
    ok((gone.body.goals || []).every(g => g.id !== goal.id),
       "deleting a goal takes its steps with it");
  }

  /* ---- the officer's case file arrives in one call ----
     The field app opens this on a doorstep, on a phone signal. Eight round
     trips is eight chances to end up holding half a case file. */
  {
    /* The populated subject: a check that every module comes back cannot be
       run against the one deliberately left empty. */
    const d = await saas(`/api/subject/detail?subject_id=${OTHER_SUBJECT}`,
                         undefined, SH, "GET");
    const want = ["subject", "vehicles", "curfew", "community_service", "travel_permit",
                  "employment", "contacts", "case_notes", "documents", "visits",
                  "agreement", "reentry"];
    const missing = want.filter(k => !(k in d.body));
    ok(missing.length === 0,
       `\x1b[1mone call returns the whole case file\x1b[0m${
         missing.length ? ` — missing ${missing.join(", ")}` : ""}`);

    ok(d.body.subject?.address && d.body.subject.phone,
       "including the demographics an officer needs at a door");

    /* Summaries, not documents. The agreement's text and the plan's sixty
       checkpoints have their own screens; shipping them here would make a
       case-file fetch heavier than the thing it summarises. */
    ok(d.body.agreement && !("conditions" in d.body.agreement)
       && typeof d.body.agreement.condition_count === "number",
       "\x1b[1mthe agreement comes as a summary, not its full text\x1b[0m");
    ok(d.body.reentry && !("items" in d.body.reentry) && d.body.reentry.readiness,
       "and the reentry plan as its readiness, not its checkpoints");

    /* Training crosses the boundary: Northwood asks Waypoint over HTTP. */
    await saas("/api/assign", { subject_id: OTHER_SUBJECT, name: "Marcus Oyelaran",
                                program_id: "golf-101" }, SH);
    const withProg = await saas(`/api/subject/detail?subject_id=${OTHER_SUBJECT}`,
                                undefined, SH, "GET");
    ok(Array.isArray(withProg.body.programs)
       && withProg.body.programs.some(p => p.program_id === "golf-101"),
       "\x1b[1mthe case file carries assigned training, fetched across the boundary\x1b[0m");
    ok(withProg.body.programs.every(p => p.subject_id === OTHER_SUBJECT),
       "and only this subject's");

    const bad = await saas("/api/subject/detail?subject_id=nobody", undefined, SH, "GET");
    ok(bad.status === 404, "a subject that does not exist is a 404, not an empty file");
  }

  /* ---- a request reaches the officer, wherever they are ----
     The mobile app has had a badge since visits existed; the console had
     nothing, so a request could sit unseen unless somebody happened to open
     that subject's Visits screen. */
  {
    const lg = await call("/api/auth/login",
      { identifier: "cust-1041@example.com", password: "northwood" });
    const MH = { Authorization: `Bearer ${lg.body.token}` };

    let a = await saas("/api/officer/alerts", undefined, SH, "GET");
    const before = (a.body.requests || []).length;

    const req = await saas("/api/me/visits/request",
      { note: "Need to move next week's appointment — new shift pattern." }, MH);
    ok(req.status === 200, "a subject can ask for an appointment");

    a = await saas("/api/officer/alerts", undefined, SH, "GET");
    ok((a.body.requests || []).length === before + 1,
       "\x1b[1mit shows up as an alert on the officer's console\x1b[0m");
    const mine = a.body.requests.find(r => r.subject_id === "cust-1041");
    ok(mine.subject_name && /shift pattern/.test(mine.request_note || ""),
       "carrying who asked and why, so the officer can act without digging");

    // Looking at it changes nothing; only scheduling it does.
    a = await saas("/api/officer/alerts", undefined, SH, "GET");
    ok((a.body.requests || []).length === before + 1,
       "\x1b[1mreading the alert does not clear it\x1b[0m");

    await saas("/api/visits/schedule",
      { id: mine.id, scheduled_at: new Date(Date.now() + 6 * 864e5).toISOString(),
        officer: "R. Alvarez" }, SH);
    a = await saas("/api/officer/alerts", undefined, SH, "GET");
    ok((a.body.requests || []).length === before,
       "\x1b[1mgiving it a date and time is what clears it\x1b[0m");
  }

  /* ---- the badge counts work outstanding, not work unseen ----
     These are two different facts and the badge used to show the wrong one:
     glancing at the Visits tab cleared the indicator on an appointment
     nobody had confirmed. */
  {
    const lg = await call("/api/auth/login",
      { identifier: "cust-1041@example.com", password: "northwood" });
    const MH = { Authorization: `Bearer ${lg.body.token}` };

    let mine = await saas("/api/me/case", undefined, MH, "GET");
    const before = mine.body.unconfirmed_visits;
    ok(before >= 1, "a scheduled visit counts as unconfirmed for the subject");

    // Open the Visits tab: everything becomes seen.
    mine = await saas("/api/me/case?seen=1", undefined, MH, "GET");
    mine = await saas("/api/me/case", undefined, MH, "GET");
    ok(mine.body.unseen_visits === 0,
       "opening the tab marks them seen");
    ok(mine.body.unconfirmed_visits === before,
       "\x1b[1mbut the badge stays: seen is not confirmed\x1b[0m");

    await saas("/api/me/visits/accept", { id: vid }, MH);
    mine = await saas("/api/me/case", undefined, MH, "GET");
    ok(mine.body.unconfirmed_visits === before - 1,
       "\x1b[1mconfirming it is what clears the badge\x1b[0m");
  }

  /* ---- ordering a route by distance ----
     The maths is tested directly, with no network: geocoding is an outbound
     call to a service that can be down, and a test that depends on it is a
     test that fails for reasons nothing to do with this code. */
  {
    const { shortestOrder, milesBetween } =
      await import("./northwood/route.mjs");
    const legs = (s0, o) => o.reduce((a, p, i) => a + milesBetween(i ? o[i - 1] : s0, p), 0);

    const office = { lat: 40.7608, lon: -111.8910 };            // Salt Lake City
    const ogden  = { lat: 41.2230, lon: -111.9738 };
    const wvc    = { lat: 40.6916, lon: -112.0011 };
    const provo  = { lat: 40.2338, lon: -111.6585 };

    ok(Math.round(milesBetween(office, provo)) === 38,
       "great-circle miles are right — Salt Lake to Provo is 38");

    /* Every permutation, so "shortest" is proven rather than asserted. */
    const stops = [ogden, provo, wvc];
    const perms = a => a.length <= 1 ? [a]
      : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));
    const best = Math.min(...perms(stops).map(p => legs(office, p)));
    const got = legs(office, shortestOrder(office, stops).map(i => stops[i]));
    ok(Math.abs(got - best) < 0.001,
       "\x1b[1mthe order it picks is the shortest of every possible order\x1b[0m");
    ok(got < legs(office, stops),
       "\x1b[1mand shorter than the order they happened to be booked in\x1b[0m");

    ok(shortestOrder(office, [wvc]).length === 1, "one stop needs no reordering");
    ok(shortestOrder(office, []).length === 0, "and no stops is not an error");

    /* Above eight it switches to a heuristic; it must still terminate and
       still beat the arbitrary order it was handed. */
    const many = Array.from({ length: 11 }, (_, i) =>
      ({ lat: 40.5 + (i * 7 % 11) / 12, lon: -112 + (i * 5 % 11) / 12 }));
    const heur = shortestOrder(office, many);
    ok(heur.length === 11 && new Set(heur).size === 11,
       "\x1b[1meleven stops still returns every stop exactly once\x1b[0m");
    ok(legs(office, heur.map(i => many[i])) <= legs(office, many),
       "and no worse than the order it was given");
  }

  {
    /* Three ways to say where the day starts, and the office is the default —
       there is always a starting point. */
    const day = await saas("/api/officer/week", undefined, SH, "GET");
    ok(day.body.base?.address,
       "\x1b[1mthe officer has a base, chosen by the server rather than matched by name\x1b[0m");

    const routeDay = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const mk = (sid, hh, firm) => saas("/api/visits", { subject_id: sid,
      scheduled_at: `${routeDay}T${hh}:00:00.000Z`, officer: "R. Alvarez",
      time_fixed: firm }, SH).then(r => r.body.visit.id);
    const vA = await mk("cust-1041", "09", false);
    const vB = await mk("cust-2298", "13", false);

    const fromOffice = await saas("/api/officer/route", { visit_ids: [vA, vB] }, SH);
    if (fromOffice.body.optimised) {
      ok(fromOffice.body.start_from === "office" && fromOffice.body.start_located,
         "\x1b[1mno starting point given falls back to their office, never to a stop\x1b[0m");

      const fromDevice = await saas("/api/officer/route",
        { start_lat: 41.2230, start_lon: -111.9738, visit_ids: [vA, vB] }, SH);
      ok(fromDevice.body.start_from === "device",
         "\x1b[1mcoordinates from a device are used as given — nothing to geocode\x1b[0m");
      ok(fromDevice.body.ordered.join() !== fromOffice.body.ordered.join(),
         "\x1b[1mand where you start changes the order, which is the whole point\x1b[0m");
    } else {
      console.log(`  \x1b[33m—\x1b[0m route start checks skipped (${fromOffice.body.note})`);
    }

    const badCoords = await saas("/api/officer/route",
      { start_lat: "north", start_lon: null, visit_ids: [vA] }, SH);
    ok(badCoords.status === 200,
       "coordinates that are not numbers fall through rather than failing");

    /* ---- the rule: set times decide the order, no times means optimise ---- */
    ok(fromOffice.body.mode === "optimised",
       "\x1b[1mno visit has a set time, so the shortest drive is what matters\x1b[0m");

    const firmA = await mk("cust-1041", "09", true);
    const firmB = await mk("cust-2298", "13", true);
    const allFirm = await saas("/api/officer/route", { visit_ids: [firmB, firmA] }, SH);
    ok(allFirm.body.mode === "scheduled" && allFirm.body.optimised === false,
       "\x1b[1mevery visit having a set time means the order is already decided\x1b[0m");
    ok(allFirm.body.ordered[0] === firmA,
       "and it comes back in schedule order, not the order it was asked for");
    ok(/already decided/.test(allFirm.body.note),
       "\x1b[1mand it says so rather than claiming to have optimised anything\x1b[0m");

    const mixed = await saas("/api/officer/route", { visit_ids: [firmA, vB] }, SH);
    ok(mixed.body.mode === "anchored" && mixed.body.fixed_count === 1,
       "\x1b[1ma mixed day anchors what is fixed and fits the rest around it\x1b[0m");
    ok(mixed.body.stops.find(x => x.visit_id === firmA).time_fixed === true,
       "and each stop says which kind it is");

    /* Two visits to one person is not a route. Offering a "shortest way round"
       between a place and itself reads as the tool not understanding the
       question, and costs trust in the rest of the answer. */
    const sameA = await mk("cust-1041", "09", false);
    const sameB = await mk("cust-1041", "15", false);
    const samePlace = await saas("/api/officer/route",
      { visit_ids: [sameA, sameB] }, SH);
    ok(samePlace.body.distinct_places === 1,
       "\x1b[1mtwo visits at one address are reported as one place, not a route\x1b[0m");
    ok(fromOffice.body.distinct_places === 2,
       "and two addresses as two");
    for (const id of [sameA, sameB])
      await saas("/api/visits/cancel", { id }, SH).catch(() => {});

    for (const id of [vA, vB, firmA, firmB])
      await saas("/api/visits/cancel", { id }, SH).catch(() => {});
  }

  {
    const r = await saas("/api/officer/route", { visit_ids: [] }, SH);
    ok(r.status === 400, "a route needs stops");
    const big = await saas("/api/officer/route",
      { visit_ids: Array.from({ length: 13 }, (_, i) => i + 1) }, SH);
    ok(big.status === 400, "and a day of thirteen stops is refused rather than ground through");
    const notMine = await saas("/api/officer/route", { visit_ids: [999999] }, SH);
    ok(notMine.status === 404,
       "\x1b[1mand a visit that is not on this officer's schedule is not routable\x1b[0m");
    const anon = await saas("/api/officer/route", { visit_ids: [1] },
                            { Authorization: "Bearer no" });
    ok(anon.status === 401, "planning a route needs a session");
  }

  /* ---- the officer's dashboard ---- */
  {
    const d = await saas("/api/officer/dashboard", undefined, SH, "GET");
    ok(d.status === 200 && typeof d.body.caseload_count === "number",
       "the dashboard answers for the whole caseload, not one subject");
    for (const k of ["visits_today", "visits_ahead", "requests", "attention", "upcoming"])
      ok(Array.isArray(d.body[k]), `it carries ${k}`);

    ok(d.body.attention.every(a => a.subject_id && a.subject_name && a.link),
       "\x1b[1mevery item names who it is about and where to go to fix it\x1b[0m");

    const ranks = d.body.attention.map(a =>
      ["overdue", "action", "waiting"].indexOf(a.severity));
    ok(ranks.join() === [...ranks].sort().join(),
       "\x1b[1msorted by severity, not by whichever module was walked first\x1b[0m");
    ok(d.body.upcoming.map(u => u.on).join() ===
       [...d.body.upcoming.map(u => u.on)].sort().join(),
       "and what is coming up is in date order");

    /* A visit earlier today is not yet a problem — the officer may be on their
       way, and it is already in the day planner. */
    const day = new Date().toISOString().slice(0, 10);
    ok(!d.body.attention.some(a => a.kind === "visit"
       && (a.detail || "").includes(day)),
       "\x1b[1ma visit from earlier today is not flagged as unclosed\x1b[0m");

    const capped = await saas("/api/officer/dashboard?days=9999", undefined, SH, "GET");
    ok(capped.body.horizon_days === 90, "the horizon is capped rather than trusted");
    const junk = await saas("/api/officer/dashboard?days=abc", undefined, SH, "GET");
    ok(junk.body.horizon_days === 14, "and a horizon that will not parse falls back");

    const anon = await saas("/api/officer/dashboard", undefined,
                            { Authorization: "Bearer nope" }, "GET");
    ok(anon.status === 401,
       "\x1b[1mit is the signed-in officer's own — there is no parameter for anyone else's\x1b[0m");
  }

  /* ---- planning a day ---- */
  {
    const day = new Date(Date.now() + 21 * 864e5).toISOString().slice(0, 10);
    for (const hh of ["14", "09", "11"])          // deliberately out of order
      await saas("/api/visits", { subject_id: "cust-1041",
        scheduled_at: `${day}T${hh}:00:00.000Z`, officer: "R. Alvarez" }, SH);

    let d = await saas(`/api/officer/week?from=${day}`, undefined, SH, "GET");
    ok(d.body.days.length === 7,
       "\x1b[1ma week is seven days, whether or not anything is on them\x1b[0m");
    ok(d.body.from === day && d.body.days[0].date === day,
       "starting on the day asked for");

    const dayOne = d.body.days[0];
    ok(dayOne.stops.length >= 3, "with that day's visits on it");
    const times = dayOne.stops.map(v => v.scheduled_at);
    ok(times.join() === [...times].sort().join(),
       "each day in appointment order");
    ok(d.body.days.every(x => x.stops.every(v => v.scheduled_at.slice(0, 10) === x.date)),
       "\x1b[1mand every visit under the day it actually falls on\x1b[0m");
    ok(dayOne.stops[0].address_line1 && dayOne.stops[0].subject_name,
       "each stop carries the address and who it is");
    ok(Array.isArray(d.body.offices) && d.body.base,
       "with the officer's own base offered as a starting point");
    ok(Array.isArray(d.body.stale),
       "\x1b[1mand anything from before the week that was never closed out\x1b[0m");

    const short = await saas(`/api/officer/week?from=${day}&days=2`, undefined, SH, "GET");
    ok(short.body.days.length === 2, "a shorter span can be asked for");
    const huge = await saas(`/api/officer/week?from=${day}&days=999`, undefined, SH, "GET");
    ok(huge.body.days.length === 31, "and a longer one is capped rather than trusted");

    d = await saas("/api/officer/week?from=not-a-date", undefined, SH, "GET");
    ok(/^\d{4}-\d{2}-\d{2}$/.test(d.body.from),
       "a date that will not parse falls back to today rather than erroring");

    const other = await saas(`/api/officer/week?from=${day}`, undefined,
      { Authorization: "Bearer nonsense" }, "GET");
    ok(other.status === 401,
       "\x1b[1ma week is the signed-in officer's own — there is no way to ask for somebody else's\x1b[0m");
  }

  /* ---- the visit agenda ----
     Built from the case file when the visit is booked, and from then on it is
     the visit's own record. The tests that matter are the ones proving it is
     a snapshot rather than a live query. */
  {
    const AS = "cust-2298";
    const fine = (await saas("/api/financial", { subject_id: AS, kind: "fine",
      description: "Agenda test fine", amount: "300", due_date: "2026-12-01" }, SH)).body.item;
    const hearing = (await saas("/api/important-dates", { subject_id: AS, kind: "court",
      title: "Agenda test hearing", scheduled_at: "2026-09-14T09:00:00" }, SH)).body.date;

    const made = await saas("/api/visits", { subject_id: AS,
      scheduled_at: new Date(Date.now() + 3 * 864e5).toISOString(),
      officer: "R. Alvarez" }, SH);
    const av = made.body.visit;
    ok(Array.isArray(av.agenda) && av.agenda.length > 0,
       "\x1b[1mbooking a visit builds its agenda from the case file\x1b[0m");
    ok(av.agenda.some(a => a.source_kind === "financial" && a.source_id === fine.id),
       "an outstanding fine is on it");
    ok(av.agenda.some(a => a.source_kind === "date" && a.source_id === hearing.id),
       "and an upcoming appointment");

    /* Programs come from Waypoint, over its API — Northwood cannot read its
       tables. They are keyed by program_id, which is a string, so it lives in
       its own column rather than being crammed into an integer source_id. */
    await saas("/api/assign", { subject_id: AS, name: "Dana Whitfield",
                                program_id: "golf-101" }, SH);
    let ar = await saas("/api/visits/agenda/refresh", { id: av.id }, SH);
    const prog = ar.body.agenda.find(a => a.source_kind === "program");
    ok(prog && /golf|Golf/.test(prog.body),
       "\x1b[1man assigned course reaches the agenda, fetched across the boundary\x1b[0m");
    ok(prog.source_id === null && prog.source_ref === "golf-101",
       "\x1b[1mkeyed by its program_id, in a column of the right type\x1b[0m");

    ar = await saas("/api/visits/agenda/refresh", { id: av.id }, SH);
    ok(ar.body.agenda.filter(a => a.source_ref === "golf-101").length === 1,
       "\x1b[1mand refreshing does not add it twice — a string key dedupes too\x1b[0m");

    const goalForAgenda = (await saas("/api/goals", { subject_id: AS,
      title: "Agenda test goal", due_date: "2026-12-01" }, SH)).body.goal;
    ar = await saas("/api/visits/agenda/refresh", { id: av.id }, SH);
    ok(ar.body.agenda.some(a => a.source_kind === "goal"
                             && a.source_id === goalForAgenda.id),
       "an open goal is on it too");
    await saas("/api/goals/delete", { id: goalForAgenda.id }, SH);
    const fineItem = av.agenda.find(a => a.source_id === fine.id);
    ok(/\$300\.00/.test(fineItem.body),
       "\x1b[1mworded as it read when the agenda was built\x1b[0m");

    /* The snapshot rule: pay the fine and the item stays, still saying what
       was on the table that day. */
    await saas("/api/financial/payment", { item_id: fine.id, amount: "300" }, SH);
    let now2 = await saas(`/api/visits/agenda?visit_id=${av.id}`, undefined, SH, "GET");
    const after = now2.body.agenda.find(a => a.source_id === fine.id);
    ok(after && /\$300\.00/.test(after.body),
       "\x1b[1mpaying the fine does not erase it from a visit that already raised it\x1b[0m");

    /* Refreshing is additive and never rewrites. */
    const later = (await saas("/api/financial", { subject_id: AS, kind: "court_costs",
      amount: "75" }, SH)).body.item;
    let r2 = await saas("/api/visits/agenda/refresh", { id: av.id }, SH);
    ok(r2.body.added === 1 && r2.body.agenda.some(a => a.source_id === later.id),
       "\x1b[1mrefreshing pulls in what was raised since\x1b[0m");
    ok(r2.body.agenda.find(a => a.source_id === fine.id).body === fineItem.body,
       "\x1b[1mand leaves every existing item exactly as it was worded\x1b[0m");

    r2 = await saas("/api/visits/agenda/refresh", { id: av.id }, SH);
    ok(r2.body.added === 0, "refreshing twice adds nothing — it is not duplicating");

    /* The officer's own item, and covering things off. */
    r2 = await saas("/api/visits/agenda/item", { visit_id: av.id, body: "  " }, SH);
    ok(r2.status === 400, "an empty agenda item is refused");

    r2 = await saas("/api/visits/agenda/item",
      { visit_id: av.id, body: "Ask about the car insurance" }, SH);
    const own = r2.body.visit.agenda.find(a => a.source_kind === "custom");
    ok(own && own.source_id === null,
       "an officer can add their own item, which no source raised");

    r2 = await saas("/api/visits/agenda/item/cover",
      { id: own.id, note: "Insured through his mother's policy; saw the card." }, SH);
    ok(r2.body.item.covered_at && /mother/.test(r2.body.item.note),
       "\x1b[1mcovering an item records what was said, not just that it was ticked\x1b[0m");
    ok(r2.body.item.covered_by, "and who covered it");

    r2 = await saas("/api/visits/agenda/item/cover", { id: own.id, covered: false }, SH);
    ok(!r2.body.item.covered_at, "and it can be un-covered");
    ok(r2.body.item.note && /mother/.test(r2.body.item.note),
       "\x1b[1mwithout losing the note — what was said still happened\x1b[0m");

    /* A refresh must not resurrect an item the officer deliberately removed
       during the same visit... it will, and that is the honest behaviour:
       removing it says "not today", and the next refresh is a new question. */
    await saas("/api/visits/agenda/item/delete", { id: own.id }, SH);
    r2 = await saas(`/api/visits/agenda?visit_id=${av.id}`, undefined, SH, "GET");
    ok(!r2.body.agenda.some(a => a.id === own.id), "an item can be taken off the agenda");

    await saas("/api/financial/delete", { id: fine.id }, SH);
    await saas("/api/financial/delete", { id: later.id }, SH);
    await saas("/api/important-dates/delete", { id: hearing.id }, SH);
  }

  /* ---- changing a scheduled visit ---- */
  {
    const when = new Date(Date.now() + 4 * 864e5).toISOString();
    const ev = (await saas("/api/visits", { subject_id: "cust-1041",
      scheduled_at: when, officer: "R. Alvarez", notes: "First plan" }, SH)).body.visit;

    let r = await saas("/api/visits", { id: ev.id, notes: "Bring the pay stub" }, SH);
    ok(r.status === 200 && r.body.visit.notes === "Bring the pay stub"
       && r.body.visit.scheduled_at === ev.scheduled_at,
       "\x1b[1mediting one field leaves the rest of the visit alone\x1b[0m");
    ok(r.body.reconfirm === false,
       "and changing a note is not a reason to ask the subject again");

    /* The subject agreed to a time and a place. */
    const lg = await call("/api/auth/login",
      { identifier: "cust-1041@example.com", password: "northwood" });
    const MH = { Authorization: `Bearer ${lg.body.token}` };
    await saas("/api/me/visits/accept", { id: ev.id }, MH);

    const moved = new Date(Date.now() + 6 * 864e5).toISOString();
    r = await saas("/api/visits", { id: ev.id, scheduled_at: moved }, SH);
    ok(r.body.visit.scheduled_at === moved, "a visit can be moved");
    ok(!r.body.visit.accepted_at && r.body.reconfirm === true,
       "\x1b[1mmoving it withdraws the acceptance, and says so\x1b[0m");

    r = await saas("/api/visits", { id: ev.id, scheduled_at: "next Tuesday" }, SH);
    ok(r.status === 400, "a date that will not parse is refused");

    r = await saas("/api/visits", { id: 999999, notes: "x" }, SH);
    ok(r.status === 404, "and a visit that does not exist is a 404");

    /* Only a visit that has not started. The console hides Edit once one is
       under way, but hiding a button is not enforcing a rule — anything only
       the interface prevents is something the next client does by accident. */
    await saas("/api/visits/start", { id: ev.id, officer: "R. Alvarez" }, SH);
    r = await saas("/api/visits", { id: ev.id, scheduled_at: when }, SH);
    ok(r.status === 409 && /under way/.test(r.body.error),
       "\x1b[1ma visit that has started cannot be rescheduled from the server either\x1b[0m");

    /* A completed visit is a record of what happened. */
    await saas("/api/visits/complete", { id: ev.id, officer: "R. Alvarez" }, SH);
    r = await saas("/api/visits", { id: ev.id, scheduled_at: when }, SH);
    ok(r.status === 409 && /already taken place/.test(r.body.error),
       "\x1b[1mand a completed one cannot either — a correction is a note\x1b[0m");
  }

  /* ---- notes and photographs, taken while standing there ---- */

  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  await saas("/api/visits/note", { id: vid, body: "Knocked, no answer at 14:02.",
                                   officer: "R. Alvarez" }, SH);
  let ph = await saas("/api/visits/photo",
    { id: vid, data: PNG, mime_type: "image/png", officer: "R. Alvarez" }, SH);
  ok(ph.status === 200 && ph.body.photo?.id, "a photograph can be attached to a visit");
  const photoId = ph.body.photo.id;

  ok(!ph.body.photo.filename.includes("/") && ph.body.photo.filename.startsWith(`visit-${vid}-`),
     "\x1b[1mthe stored filename is generated, never one the caller supplied\x1b[0m");

  ph = await saas("/api/visits/photo",
    { id: vid, data: PNG, mime_type: "image/gif" }, SH);
  ok(ph.status === 400, "an unlisted image type is refused — the allowlist is not sniffed");

  ph = await saas("/api/visits/photo",
    { id: 99999, data: PNG, mime_type: "image/png" }, SH);
  ok(ph.status === 404, "a photograph cannot be filed against a visit that does not exist");

  let raw = await fetch(`${SAAS}/visit-photos/${photoId}`);
  ok(raw.status === 403,
     "\x1b[1ma visit photograph is not readable without credentials\x1b[0m");
  raw = await fetch(`${SAAS}/visit-photos/${photoId}`, { headers: SH });
  ok(raw.status === 200 && raw.headers.get("content-type") === "image/png",
     "staff can fetch the photograph");

  /* ---- audio recorded at the visit ----
     Not parsed anywhere, so any bytes stand in for a recording; what is being
     tested is the allowlist, the generated name and who may read it back. */
  const M4A = Buffer.from("ftypM4A recorded at the door").toString("base64");

  let rec = await saas("/api/visits/recording",
    { id: vid, data: M4A, mime_type: "audio/m4a", duration_ms: 247000,
      officer: "R. Alvarez" }, SH);
  ok(rec.status === 200 && rec.body.recording?.id,
     "a recording can be attached to a visit in progress");
  const recId = rec.body.recording.id;
  ok(rec.body.recording.duration_ms === 247000
     && rec.body.recording.byte_size === Buffer.from(M4A, "base64").length,
     "its length and size are stored, so a truncated upload is visible");
  ok(!rec.body.recording.filename.includes("/")
     && rec.body.recording.filename.startsWith(`visit-${vid}-`),
     "\x1b[1mthe recording filename is generated too, never the caller's\x1b[0m");

  rec = await saas("/api/visits/recording",
    { id: vid, data: M4A, mime_type: "audio/ogg" }, SH);
  ok(rec.status === 400, "an unlisted audio type is refused");

  rec = await saas("/api/visits/recording",
    { id: 99999, data: M4A, mime_type: "audio/m4a" }, SH);
  ok(rec.status === 404, "a recording cannot be filed against a visit that does not exist");

  let rawAudio = await fetch(`${SAAS}/visit-recordings/${recId}`);
  ok(rawAudio.status === 403,
     "\x1b[1ma visit recording is not readable without credentials\x1b[0m");
  rawAudio = await fetch(`${SAAS}/visit-recordings/${recId}`, { headers: SH });
  ok(rawAudio.status === 200
     && rawAudio.headers.get("x-content-type-options") === "nosniff",
     "staff can play the recording back");
  ok(rawAudio.headers.get("content-type") === "audio/mp4",
     "\x1b[1man .m4a goes back out as audio/mp4 — iOS will not play "
     + "a type it does not recognise\x1b[0m");

  /* ---- byte ranges ----
     iOS AVPlayer, which the app uses, will not play a remote file from a
     server that cannot serve ranges: it probes with `bytes=0-1` and gives up
     on a 200. The recording played fine in the browser console and did nothing
     at all in the app, off the same URL with the same credential — so these
     assertions exist to stop that being rediscovered from the wrong end. */
  ok(rawAudio.headers.get("accept-ranges") === "bytes",
     "\x1b[1mthe recording endpoint advertises byte ranges\x1b[0m");

  const audioLen = Number(rawAudio.headers.get("content-length"));

  let part = await fetch(`${SAAS}/visit-recordings/${recId}`,
                         { headers: { ...SH, Range: "bytes=0-1" } });
  ok(part.status === 206
     && part.headers.get("content-range") === `bytes 0-1/${audioLen}`
     && Number(part.headers.get("content-length")) === 2,
     "\x1b[1mthe probe iOS opens with gets 206 and a Content-Range\x1b[0m");

  part = await fetch(`${SAAS}/visit-recordings/${recId}`,
                     { headers: { ...SH, Range: "bytes=-4" } });
  ok(part.status === 206
     && part.headers.get("content-range") === `bytes ${audioLen - 4}-${audioLen - 1}/${audioLen}`,
     "a suffix range means the LAST n bytes, not the first n");

  part = await fetch(`${SAAS}/visit-recordings/${recId}`,
                     { headers: { ...SH, Range: `bytes=${audioLen - 3}-` } });
  ok(part.status === 206 && Number(part.headers.get("content-length")) === 3,
     "an open-ended range runs to the end of the file");

  part = await fetch(`${SAAS}/visit-recordings/${recId}`,
                     { headers: { ...SH, Range: `bytes=${audioLen + 10}-${audioLen + 20}` } });
  ok(part.status === 416 && part.headers.get("content-range") === `bytes */${audioLen}`,
     "a range past the end is refused with 416, not a wrong slice");

  part = await fetch(`${SAAS}/visit-recordings/${recId}`,
                     { method: "HEAD", headers: SH });
  ok(part.status === 200
     && part.headers.get("accept-ranges") === "bytes"
     && (await part.text()) === "",
     "HEAD answers with the headers and no body");

  r2 = await saas("/api/visits/complete", { id: vid, officer: "R. Alvarez",
    note: "Attended. Window still unrepaired.",
    observations: { subject_present: "yes", location_safe: "concerns",
                    contraband: "none_seen", demeanour: "guarded",
                    others_present: "One adult female",
                    concerns: "Broken kitchen window" } }, SH);
  const v = r2.body.visit;
  ok(v.status === "completed" && v.ended_at, "ending the visit records an end time");
  ok(v.started_at === startedAt,
     "\x1b[1mthe arrival time is not overwritten when the visit ends\x1b[0m");
  ok((v.photos || []).length === 1 && (v.notes_log || []).length >= 1
     && (v.recordings || []).length === 1,
     "\x1b[1mnotes, photographs and recordings travel with the visit record\x1b[0m");

  /* A completed visit still takes audio. Ending a visit means the officer left
     the property, not that the record is sealed — and on a doorstep connection
     the upload finishing after the visit ends is the normal case. */
  rec = await saas("/api/visits/recording",
    { id: vid, data: M4A, mime_type: "audio/m4a", note: "uploaded later" }, SH);
  ok(rec.status === 200,
     "\x1b[1maudio can still be attached after the visit is completed\x1b[0m");
  ok(rec.body.recordings.length === 2,
     "and it joins the one recorded at the door rather than replacing it");

  /* ---- transcription and summary, as this server is actually configured ----
     No key is set in the demo, so what is being tested is that the feature
     says so plainly instead of failing somewhere further in. A button that
     could only ever fail should not be on the screen at all, which is what
     the capabilities route is for. */
  let cap = await saas("/api/insights/capabilities", null, SH);
  ok(cap.status === 200 && typeof cap.body.transcription === "boolean"
     && typeof cap.body.summary === "boolean",
     "the server says whether it can transcribe and summarise at all");

  if (!cap.body.transcription) {
    r = await saas("/api/visits/recording/transcribe", { recording_id: recId }, SH);
    ok(r.status === 503 && /WAYPOINT_STT_KEY/.test(r.body.error),
       "\x1b[1mwith no key it says which one is missing, not \"something went wrong\"\x1b[0m");
  }
  if (!cap.body.summary) {
    r = await saas("/api/visits/summarise", { id: vid }, SH);
    ok(r.status === 503 && /WAYPOINT_LLM_KEY/.test(r.body.error),
       "and the same for summarising");
  }

  r = await fetch(`${SAAS}/api/insights/capabilities`).then(async x =>
    ({ status: x.status }));
  ok(r.status === 401 || r.status === 403,
     "\x1b[1mnone of it is reachable without a staff session\x1b[0m");
  ok(v.location_safe === "concerns" && v.demeanour === "guarded"
     && v.others_present === "One adult female",
     "\x1b[1mwhat the officer observed is stored with the visit\x1b[0m");

  /* A visit that was never started still records both ends, so a completion
     entered from the desk is not left with a null arrival time. */
  const m2 = await saas("/api/visits",
    { subject_id: "cust-1041", scheduled_at: when, officer: "R. Alvarez" }, SH);
  const c2 = await saas("/api/visits/complete", { id: m2.body.visit.id }, SH);
  ok(c2.body.visit.started_at && c2.body.visit.ended_at,
     "completing a visit that was never started still stamps both times");
}

/* ---------------------------------------------------------------
   The reentry plan.

   Most of these test the readiness rules rather than the plumbing, because
   the rules are the feature: a rollup nobody can point at is exactly how a
   screen and a report start disagreeing.
   --------------------------------------------------------------- */
if (staff && staff.status === 200) {
  console.log("");
  const SH = { Authorization: `Bearer ${staff.body.token}` };
  /* Marcus, not Dana: the demo seed leaves Dana's plan worked to the last
     signature, and these checks need one they can drive from creation to
     certification. Dana's seeded plan is what the foreign-checkpoint check
     borrows an id from. */
  /* Dana, not Marcus: the demo seed leaves Marcus's plan worked to the last
     signature, and these checks need one they can drive from creation to
     certification. Marcus's seeded plan is what the foreign-checkpoint check
     borrows an id from. */
  const SID = "cust-1041";
  const OTHER = "cust-2298";

  /* The demo seed's job is to leave exactly the right things undone: two of
     the subject's signatures, so her app opens with a banner, and then the
     officer's certification. Get that wrong and the demo opens on the wrong
     screen — which nobody finds out until they are in front of an audience. */
  {
    const d = await saas(`/api/reentry?subject_id=${OTHER}`, undefined, SH, "GET");
    const seededPlan = d.body.plan;
    const ag = await saas(`/api/agreement?subject_id=${OTHER}`, undefined, SH, "GET");
    const seededAg = ag.body.agreement;

    if (!seededPlan || !seededAg) {
      console.log(`  \x1b[33m—\x1b[0m demo seed checks skipped (${OTHER} is not seeded `
                + `— run ./spike/demo reset)`);
    } else {
      ok(seededAg.status === "active" && seededAg.officer_signed_at
         && seededAg.conditions.length > 10,
         "\x1b[1mthe seeded agreement is signed and issued\x1b[0m");
      ok(!seededAg.subject_signed_at,
         "\x1b[1mand waits on the subject, so it is a to-do in her app too\x1b[0m");

      const sr = seededPlan.readiness;
      ok(seededPlan.status === "active" && seededPlan.subject_signed_at,
         "the seeded demo plan is issued and accepted");
      ok(sr.awaiting_signature === 2 && !sr.certifiable && !seededPlan.certified_at,
         "\x1b[1mand waits on two of the subject's signatures, so their app shows the banner\x1b[0m");
      ok(sr.outstanding === sr.awaiting_signature,
         "with nothing else outstanding — she is the only thing between it and done");
      ok(sr.not_applicable > 0 && seededPlan.items.some(i => i.status === "exception"),
         "and carries an N/A and an approved exception, so both can be shown");

      /* The demo is about the subject having an active part in this, so she
         must open the app owing two distinct things — not one, and not none. */
      const owed = (seededAg.subject_signed_at ? 0 : 1)
                 + (seededPlan.subject_signed_at ? (sr.awaiting_signature ? 1 : 0) : 1);
      ok(owed === 2,
         "\x1b[1mand they open the app owing two things: the conditions, and two checkpoints\x1b[0m");

      /* The rest of the populated demo: without these the seed can quietly
         stop filling a module and nobody notices until a screen is empty in
         front of an audience. */
      const file = (await saas(`/api/subject/detail?subject_id=${OTHER}`,
                               undefined, SH, "GET")).body;
      for (const [what, n] of [["vehicles", file.vehicles.length],
                               ["contacts", file.contacts.length],
                               ["goals", file.goals.length],
                               ["financial items", file.financial.items.length],
                               ["appointments", file.important_dates.dates.length],
                               ["visits", file.visits.length],
                               ["programs", file.programs.length]])
        ok(n > 0, `the seeded case file has ${what}`);
      ok(file.curfew?.active, "and a curfew");

      /* A visit tomorrow, always — a demo whose next visit is in the past
         makes the whole product look abandoned.
       *
       * Built the way the SEED builds it — tomorrow at 10:00 LOCAL, then
       * converted — not as `Date.now() + 24h` in UTC. Those are the same date
       * for most of the day and different after about 20:00 in a western
       * timezone, because UTC has already rolled over. The old version passed
       * every afternoon and failed every evening, which reads as flakiness
       * rather than as the timezone bug it is.
       *
       * The seed is what the product does; the test conforms to it. */
      const t = new Date();
      t.setDate(t.getDate() + 1);
      t.setHours(10, 0, 0, 0);
      const tomorrow = t.toISOString().slice(0, 10);
      ok(file.visits.some(v => (v.scheduled_at || "").slice(0, 10) === tomorrow),
         "\x1b[1mand a visit tomorrow, wherever today happens to fall\x1b[0m");

      /* Appointments on separate days, in more than one state. */
      const days = new Set(file.important_dates.dates
        .map(d => d.scheduled_at.slice(0, 10)));
      ok(days.size === file.important_dates.dates.length,
         "\x1b[1mappointments are on separate days, not stacked on one\x1b[0m");
      ok(new Set(file.important_dates.dates.map(d => d.state)).size > 1,
         "and in more than one state, so the module shows more than one screen");

      /* The seed also leaves cust-1041 bare, so every empty state and Create
         flow can be demonstrated — but this suite cannot assert that, because
         this suite is what fills it in. Every block above uses that subject as
         its scratch space. Checking it here would pass or fail depending on
         which tests had run, which is worse than not checking it: a test whose
         result depends on its neighbours teaches people to re-run until green.

         `./spike/demo reset` prints what it seeded, and that line is the
         check that matters for the bare subject. */
    }
  }

  let r = await saas("/api/reentry/create", { subject_id: SID, facility: "Northwood RC",
                                              officer_name: "R. Alvarez" }, SH);
  const plan = r.body.plan;

  // These checks work a plan from creation to certification, so they need a
  // fresh one. Say so and stop, rather than crashing halfway through on a
  // plan somebody has already half-completed.
  if (r.status === 409) {
    console.log(`  \x1b[33m—\x1b[0m reentry checks skipped (${SID} already has a plan `
              + `— run ./spike/demo reset)`);
  } else {
  ok(r.status === 200 && plan?.id, "a reentry plan can be created");
  ok(plan.items.length > 50,
     "creating a plan stamps the whole template onto it");
  ok(plan.items.every(i => i.status === "not_started"),
     "every checkpoint starts not started");

  r = await saas("/api/reentry/create", { subject_id: SID }, SH);
  ok(r.status === 409, "a subject cannot have two reentry plans");

  const byLabel = l => planNow.items.find(i => i.label === l);
  let planNow = plan;
  const reload = async () => {
    const d = await saas(`/api/reentry?subject_id=${SID}`, undefined, SH, "GET");
    planNow = d.body.plan; return planNow;
  };

  /* ---- a checkpoint takes two signatures, and that is the point ---- */
  const housing = plan.items.find(i => i.label === "Residence identified");
  r = await saas("/api/reentry/item", { id: housing.id, status: "ready",
                                        detail: "412 Ridgeway Ave, Apt 3B" }, SH);
  ok(r.status === 200 && r.body.item.status === "ready", "the officer can mark one ready");
  ok(r.body.plan.readiness.complete === 0,
     "\x1b[1mmarking it ready does not complete it — nobody has signed\x1b[0m");
  ok(r.body.plan.readiness.awaiting_signature === 1,
     "it is reported as awaiting signature rather than done");

  r = await saas("/api/reentry/item/sign", { id: housing.id }, SH);
  ok(r.status === 200, "the officer signs it off");
  ok(r.body.plan.readiness.complete === 0,
     "\x1b[1mone signature is still not a completed checkpoint\x1b[0m");
  ok(r.body.complete === false, "and the response says so plainly");

  /* ---- the subject's half, from their own session ---- */
  await saas("/api/reentry/sign", { id: plan.id }, SH);
  await saas("/api/reentry/save", { id: plan.id, status: "active" }, SH);

  // Same route the agreement checks use: the seeded login, or mint one.
  const remail = `${SID}@example.com`;
  let rlogin = await call("/api/auth/login", { identifier: remail, password: "northwood" });
  if (rlogin.status !== 200) {
    const pw = (await saas("/api/subject/login", { subject_id: SID }, SH))
                 .body?.credentials?.password;
    rlogin = await call("/api/auth/login", { identifier: remail, password: pw });
  }
  ok(rlogin.status === 200, "the subject can sign in to read their reentry plan");
  const me = { token: rlogin.body?.token };

  {
    const MH = { Authorization: `Bearer ${me.token}` };

    let mine = await saas("/api/me/case", undefined, MH, "GET");
    ok(mine.body.reentry?.id === plan.id, "the subject sees their issued plan");
    ok(mine.body.reentry.items.length === plan.items.length,
       "with every checkpoint on it");

    let s2 = await saas("/api/me/reentry/item/sign", { id: housing.id }, MH);
    ok(s2.status === 200 && s2.body.complete === true,
       "\x1b[1mthe subject's signature is what completes the checkpoint\x1b[0m");
    ok(s2.body.plan.readiness.complete === 1, "and it now counts toward readiness");

    // Scoped to their own plan, not to any id they care to send.
    const other = await saas(`/api/reentry?subject_id=${OTHER}`, undefined, SH, "GET");
    const foreign = other.body.plan.items[0];
    s2 = await saas("/api/me/reentry/item/sign", { id: foreign.id }, MH);
    ok(s2.status === 404,
       "\x1b[1ma subject cannot sign a checkpoint on somebody else's plan\x1b[0m");

    s2 = await saas("/api/me/reentry/sign", {}, MH);
    ok(s2.status === 200 && s2.body.plan.subject_signed_at,
       "the subject accepts the plan itself");
    const acks = await saas(`/api/reentry?subject_id=${SID}`, undefined, SH, "GET");
    ok((acks.body.acknowledgments || []).length === 1,
       "\x1b[1mtheir acceptance is recorded with a snapshot of what they read\x1b[0m");
  }

  await reload();

  /* ---- signing something that is not ready is meaningless ---- */
  const notReady = planNow.items.find(i => i.status === "not_started");
  r = await saas("/api/reentry/item/sign", { id: notReady.id }, SH);
  ok(r.status === 409,
     "\x1b[1ma checkpoint cannot be signed off before it is marked ready\x1b[0m");

  /* ---- moving a signed checkpoint backwards clears the signatures ---- */
  r = await saas("/api/reentry/item", { id: housing.id, status: "in_progress" }, SH);
  const back = r.body.item;
  ok(!back.officer_signed_at && !back.subject_signed_at,
     "\x1b[1mreopening a checkpoint clears both signatures\x1b[0m");
  ok(r.body.plan.readiness.complete === 0,
     "so it stops counting as complete");

  /* ---- not applicable leaves the calculation entirely ---- */
  await reload();
  const before = planNow.readiness.total;
  const sub1 = planNow.items.find(i => i.area === "substance");
  r = await saas("/api/reentry/item", { id: sub1.id, status: "not_applicable" }, SH);
  ok(r.body.plan.readiness.total === before - 1,
     "\x1b[1mnot applicable leaves the readiness calculation, rather than counting against it\x1b[0m");
  ok(r.body.plan.readiness.not_applicable === 1, "and is reported separately");

  /* ---- an exception is a documented answer, not a shortcut ---- */
  await reload();
  const idItem = planNow.items.find(i => i.label === "State ID");
  r = await saas("/api/reentry/item", { id: idItem.id, status: "exception" }, SH);
  ok(r.status === 400 && /mitigation/i.test(r.body.error),
     "\x1b[1man exception without a mitigation plan is refused\x1b[0m");

  r = await saas("/api/reentry/item", { id: idItem.id, status: "exception",
    mitigation: "DMV appointment booked for the week after release." }, SH);
  ok(r.status === 400 && /approved/i.test(r.body.error),
     "an exception without a named approver is refused");

  r = await saas("/api/reentry/item", { id: idItem.id, status: "exception",
    mitigation: "DMV appointment booked for the week after release.",
    approved_by: "T. Nakamura" }, SH);
  ok(r.status === 200 && r.body.item.approved_at,
     "\x1b[1man exception with a documented plan and an approver is accepted\x1b[0m");
  ok(r.body.plan.readiness.complete >= 1,
     "and it counts as satisfied — not complete must not mean cannot release");

  /* ---- the release gate is critical items, not 100% ---- */
  await reload();
  const rd = planNow.readiness;
  ok(rd.percent < 100 && rd.ready_for_reentry === false,
     "a partly-worked plan is not ready for reentry");
  ok(rd.critical_total > 0 && rd.critical_total < rd.total,
     "\x1b[1mcritical checkpoints are a subset — the gate is not the whole plan\x1b[0m");

  /* ---- amending the terms withdraws the acceptance ---- */
  if (me.token) {
    r = await saas("/api/reentry/save",
      { id: plan.id, target_release_date: "2026-11-02" }, SH);
    ok(r.body.amended === true && !r.body.plan.subject_signed_at,
       "\x1b[1mamending the plan withdraws the subject's acceptance\x1b[0m");
  }

  /* ---- history is append-only and answers who and when ---- */
  const hist = await saas(`/api/reentry/history?plan_id=${plan.id}`, undefined, SH, "GET");
  ok((hist.body.events || []).length >= 6,
     "\x1b[1mevery change to the plan is on the record\x1b[0m");
  ok((hist.body.events || []).some(e => e.actor_role === "subject"),
     "including the ones the subject made");

  /* ---- the officer's final sign-off ----
     Three signatures on this plan and they mean three different things: the
     subject's acceptance at the start, both parties on each checkpoint, and
     this — the officer alone, certifying the whole thing is done. */
  await reload();

  // The amendment above withdrew the acceptance, so this is the first gate
  // certification meets — and the message has to name that, not the
  // checkpoints, or the officer goes hunting for the wrong thing.
  r = await saas("/api/reentry/certify", { id: plan.id }, SH);
  ok(r.status === 409 && /accepted/.test(r.body.error),
     "\x1b[1ma plan the subject has not accepted cannot be certified\x1b[0m");

  const MH2 = { Authorization: `Bearer ${me.token}` };
  await saas("/api/me/reentry/sign", {}, MH2);

  r = await saas("/api/reentry/certify", { id: plan.id }, SH);
  ok(r.status === 409 && /outstanding/.test(r.body.error),
     "\x1b[1mand neither can one with outstanding checkpoints\x1b[0m");

  // Every single item not applicable: nothing outstanding, but nothing done
  // either. "No work left" is not the same claim as "the work is complete".
  for (const i of planNow.items)
    await saas("/api/reentry/item", { id: i.id, status: "not_applicable" }, SH);
  await reload();
  ok(planNow.readiness.total === 0 && planNow.readiness.certifiable === false,
     "\x1b[1ma plan with nothing left to do is not thereby complete\x1b[0m");

  // One real checkpoint, worked properly through both signatures.
  const last = planNow.items[0];
  await saas("/api/reentry/item", { id: last.id, status: "ready" }, SH);
  await saas("/api/reentry/item/sign", { id: last.id }, SH);
  r = await saas("/api/reentry/certify", { id: plan.id }, SH);
  ok(r.status === 409,
     "and neither is one whose last checkpoint only the officer has signed");

  await saas("/api/me/reentry/item/sign", { id: last.id }, MH2);
  await reload();
  ok(planNow.readiness.certifiable === true, "with both signatures it is certifiable");

  r = await saas("/api/reentry/certify", { id: plan.id }, SH);
  ok(r.status === 200 && r.body.plan.certified_at,
     "\x1b[1mthe officer certifies the completed plan\x1b[0m");
  ok(r.body.plan.status === "active",
     "certifying does not hide the plan from the subject");

  r = await saas("/api/reentry/certify", { id: plan.id }, SH);
  ok(r.status === 200, "certifying twice is idempotent");

  /* A certification describes a finished plan, so it cannot outlive one. */
  r = await saas("/api/reentry/item", { id: last.id, status: "in_progress" }, SH);
  ok(r.body.uncertified === true && !r.body.plan.certified_at,
     "\x1b[1mreopening a checkpoint withdraws the certification\x1b[0m");

  /* ---- the document ---- */
  r = await saas("/api/reentry/pdf", { id: plan.id }, SH);
  ok(r.status === 200 && r.body.document?.byte_size > 1000,
     "the plan renders to a filed PDF");
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);

/**
 * A floor on how much of this suite actually ran.
 *
 * The whole point: "63 passed, 0 failed" looked like success while three
 * quarters of the file had skipped itself over a wrong port. Green is not the
 * same as complete, and nothing here noticed the difference.
 *
 * Deliberately a floor and not an exact count — adding tests must not break
 * the build. Raise it when the suite grows a lot; if it ever trips, something
 * has stopped running rather than started failing, and those have completely
 * different causes.
 */
const FLOOR = 250;
if (!fail && pass < FLOOR) {
  console.log(`  \x1b[31m✕ only ${pass} assertions ran, expected at least ${FLOOR}\x1b[0m`);
  console.log(`  \x1b[2mSections skip themselves when the Northwood origin is wrong`);
  console.log(`  or its staff login fails. Nothing failed — most of it did not run.\x1b[0m\n`);
  process.exit(1);
}

process.exit(fail ? 1 : 0);
