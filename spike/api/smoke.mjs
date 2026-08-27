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
const SAAS = API.replace(/:8090$/, ":8092");
const AGREEMENT_SUBJECT = "cust-2298";

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

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
