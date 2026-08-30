/**
 * Transcription and summary, against a stand-in for the model.
 *
 * The providers are two HTTP calls, so this stands a server up on a loopback
 * port and points the config at it. That exercises the real client — the
 * multipart body, the tool-use envelope, the error shapes — without a key,
 * without a bill, and without anybody's audio leaving the machine.
 *
 * It runs against a THROWAWAY database in a temp directory. Nothing here
 * touches spike/data. The insights tables are new and it would be easy to
 * write a test that quietly files rows against a real visit.
 */

import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* Both must be set BEFORE anything imports config.mjs or connect.mjs, which
   read them once at module load. */
const DIR = mkdtempSync(join(tmpdir(), "waypoint-insights-"));
process.env.WAYPOINT_DATA_DIR = DIR;

let lastRequest = null;
const fake = createServer((req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    lastRequest = { url: req.url, headers: req.headers, raw };
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    /* The stub branches on what it was SENT, not on which URL was called.
       config.mjs reads the environment once at load, so a test cannot re-point
       the client mid-run without a second process — and bending the production
       code to read env per call, purely so this file can poke at it, would be
       letting the test design the server. */
    if (req.url === "/stt") {
      if (raw.includes("TRIGGER-401"))
        return send(401, { error: { message: "Incorrect API key provided" } });
      return send(200, { text: "  So how is the job going.  It is going fine.  ",
                         language: "english" });
    }

    if (req.url === "/llm") {
      const body = JSON.parse(raw.toString() || "{}");
      if (/TRIGGER-PROSE/.test(JSON.stringify(body.messages)))
        return send(200, { model: "x", content: [{ type: "text", text: "Sure!" }] });
      return send(200, {
        model: body.model,
        content: [{
          type: "tool_use", name: "record_visit_summary",
          input: {
            headline: "Employment confirmed; pay stub outstanding.",
            body: "The subject reported that work is going fine.",
            actions: [
              { body: "Provide the current pay stub", owner: "subject",
                due_hint: "before Friday", quote: "I'll get you the stub" },
              { body: "Ring the supervisor to verify the shift", owner: "officer" },
              { body: "   ", owner: "subject" },              // dropped
              { body: "Something nobody owns", owner: "nonsense" } // -> unclear
            ]
          }
        }]
      });
    }

    /* OpenAI-compatible chat completions: different auth header, different
       tool envelope, and the arguments arrive as a JSON string. */
    if (req.url === "/llm-openai") {
      const body = JSON.parse(raw.toString() || "{}");
      if (/TRIGGER-PROSE/.test(JSON.stringify(body.messages)))
        return send(200, { choices: [{ message: { content: "Sure!" } }] });
      return send(200, { model: body.model, choices: [{ message: { tool_calls: [{
        function: { name: "record_visit_summary", arguments: JSON.stringify({
          headline: "Employment confirmed; pay stub outstanding.",
          body: "The subject reported that work is going fine.",
          actions: [{ body: "Provide the current pay stub", owner: "subject" }]
        }) } }] } }] });
    }

    send(404, { error: { message: "no such stub" } });
  });
});

await new Promise(r => fake.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${fake.address().port}`;
process.env.WAYPOINT_STT_URL = `${BASE}/stt`;
process.env.WAYPOINT_STT_KEY = "test-key";
process.env.WAYPOINT_STT_MODEL = "whisper-test";
process.env.WAYPOINT_LLM_URL = `${BASE}/llm`;
process.env.WAYPOINT_LLM_KEY = "test-key";
/* Stated rather than sniffed: the format is normally inferred from the URL,
   and a loopback stub looks like neither provider. Exactly the case the
   override exists for — a self-hosted endpoint or a proxy. */
process.env.WAYPOINT_LLM_API = "anthropic";

const { run } = await import("./db/connect.mjs");
await import("./db/schema.mjs");
const {
  claimTranscript, transcriptFor, transcriptById, finishTranscript,
  failTranscript, claimSummary, finishSummary, hydrateSummary,
  summariesForVisit, decideAction, staleRunning, summaryInFlight,
  failSummary, setActionOwner, resolveDueHint, setActionDue,
  completeAction, openActionsForSubject, unseenActionCount, markActionsSeen
} = await import("./db/insights.mjs");
const { transcribe, summarise } = await import("./northwood/ai.mjs");

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✕\x1b[0m ${label}`); }
};

console.log("\n\x1b[1mTranscripts and summaries\x1b[0m\n");
console.log(`  \x1b[2mdatabase: ${DIR}\x1b[0m`);
console.log(`  \x1b[2mstub provider: ${BASE}\x1b[0m\n`);

/* A visit and a recording to hang everything off. Raw inserts on purpose —
   this file is testing the insight layer, not the visit layer. */
run(`INSERT INTO visits (id, subject_id, status, created_at)
     VALUES (901, 'cust-test', 'completed', ?)`, new Date().toISOString());
run(`INSERT INTO visit_recordings
       (id, visit_id, filename, mime_type, byte_size, duration_ms, created_at)
     VALUES (801, 901, 'visit-901-test.m4a', 'audio/m4a', 4096, 9000, ?)`,
    new Date().toISOString());
const REC = { id: 801, visit_id: 901, filename: "visit-901-test.m4a",
              mime_type: "audio/m4a" };

/* ---- the transcription client ---- */

const out = await transcribe(Buffer.from("fake audio bytes"), REC.filename,
                             REC.mime_type);
ok(out.text === "So how is the job going.  It is going fine.",
   "the transcript comes back trimmed");
ok(out.language === "english" && /whisper-test/.test(out.engine),
   "the language and the engine are recorded with it");

const sent = lastRequest.raw.toString("latin1");
ok(/name="file"/.test(sent) && /filename="visit-901-test.m4a"/.test(sent),
   "\x1b[1mthe audio is sent as a file, with its container name\x1b[0m");
ok(/name="model"[\s\S]*whisper-test/.test(sent),
   "the configured model is the one asked for");
ok(lastRequest.headers.authorization === "Bearer test-key",
   "the key travels in the Authorization header, not the body");

let msg = await transcribe(Buffer.from("TRIGGER-401"), "a.m4a", "audio/m4a")
  .then(() => null, e => e.message);
ok(/Incorrect API key/.test(msg || ""),
   "\x1b[1ma provider's complaint reaches the officer verbatim, not as a 500\x1b[0m");

/* ---- claiming, and not paying twice ---- */

const t1 = claimTranscript(REC, "R. Alvarez");
ok(t1?.status === "queued" && t1.visit_id === 901,
   "a recording can be claimed for transcription");
ok(claimTranscript(REC, "R. Alvarez") === null,
   "\x1b[1mand not claimed twice while it is still running\x1b[0m");

finishTranscript(t1.id, { text: "one two three four", language: "english",
                          engine: "stub" });
let t = transcriptById(t1.id);
ok(t.status === "done" && t.word_count === 4,
   "finishing it stores the text and counts the words");

const t2 = claimTranscript(REC, "R. Alvarez");
ok(t2.id === t1.id && t2.status === "queued" && t2.text === null,
   "\x1b[1mre-transcribing REPLACES the reading — the audio owns the fact\x1b[0m");
ok(transcriptFor(REC.id).id === t1.id,
   "so a recording never has two rival transcripts");

failTranscript(t2.id, "the service was down");
ok(transcriptById(t2.id).status === "failed"
   && /service was down/.test(transcriptById(t2.id).error),
   "a failure is stored where the screen can show it");

/* ---- the summary client ---- */

finishTranscript(t1.id, { text: "So how is the job going. It is going fine.",
                          language: "english", engine: "stub" });

const sum = await summarise("So how is the job going. It is going fine.",
                            { subject_name: "Marcus Oyelaran", officer: "R. Alvarez" });
ok(sum.headline === "Employment confirmed; pay stub outstanding.",
   "the summary comes back with a headline");
ok(sum.actions.length === 3, "an action item with no text is dropped, not stored empty");
ok(sum.actions[0].owner === "subject" && sum.actions[0].due_hint === "before Friday",
   "who owns it and when they said travel with it");
ok(sum.actions[2].owner === "unclear",
   "\x1b[1man owner outside the list becomes 'unclear' rather than being trusted\x1b[0m");

const llmBody = JSON.parse(lastRequest.raw.toString());
ok(llmBody.tool_choice?.name === "record_visit_summary",
   "\x1b[1mthe shape is forced by a tool schema, not requested in prose\x1b[0m");
ok(/Marcus Oyelaran/.test(JSON.stringify(llmBody.messages)),
   "facts the record already holds are given, not left to be heard from the audio");
ok(/liberty/.test(llmBody.system) && /Never infer/.test(llmBody.system),
   "the system prompt names the stakes and forbids filling gaps");

msg = await summarise("TRIGGER-PROSE", {}).then(() => null, e => e.message);
ok(/expected shape/.test(msg || ""),
   "a reply that ignores the tool is an error, not a summary of nothing");

/* ---- storing it, and the line between a proposal and an obligation ---- */

const s1 = claimSummary(901, [t1.id], "R. Alvarez");
const done = finishSummary(s1.id, { ...sum, model: "stub-model" });
ok(done.actions.length === 3 && done.actions.every(a => a.status === "accepted"),
   "\x1b[1maction items land live — assigning one is the decision, not a proposal\x1b[0m");
ok(done.actions[0].position === 0 && done.actions[2].position === 2,
   "and keep the order they were proposed in");

/* Whisper does not diarise, so ownership is inferred and sometimes wrong —
   most often where the officer instructs the subject to do something. */
const mis = done.actions[1];
ok(mis.owner === "officer" && mis.owner_proposed === "officer",
   "an action arrives owned by whoever the model inferred");
ok(mis.status === "accepted" && mis.due_date === null,
   "live on arrival, and dated only when something was actually said");
const fixed = setActionOwner(mis.id, "subject", "R. Alvarez");
ok(fixed.action.owner === "subject" && fixed.action.owner_proposed === "officer",
   "\x1b[1mcorrecting the owner keeps what the model proposed beside it\x1b[0m");
ok(fixed.action.owner_set_by === "R. Alvarez" && fixed.action.owner_set_at,
   "and records who corrected it, and when");
ok(setActionOwner(mis.id, "the dog", "R. Alvarez").error,
   "an owner outside the three is refused");

const dropped = decideAction(done.actions[0].id, "dismissed", "R. Alvarez");
ok(dropped.action.status === "dismissed" && dropped.action.decided_by === "R. Alvarez",
   "\x1b[1man item the recording did not really contain can be removed\x1b[0m");
const back = decideAction(done.actions[0].id, "accepted", "R. Alvarez");
ok(back.action.status === "accepted",
   "and put back, so a mistaken removal is not a loss");
ok(decideAction(done.actions[1].id, "nonsense", "R. Alvarez").error,
   "a status outside the set is refused");
ok(decideAction(999999, "accepted", "x").error, "so is an action that does not exist");

const s2 = claimSummary(901, [t1.id], "R. Alvarez");
finishSummary(s2.id, { headline: "A later reading", body: "…", model: "stub",
                       actions: [] });
const all = summariesForVisit(901);
ok(all.length === 2 && all[0].id === s2.id,
   "\x1b[1mre-summarising APPENDS — what somebody read in March is still there\x1b[0m");
ok(hydrateSummary(all[1]).headline === "Employment confirmed; pay stub outstanding.",
   "and the earlier one is unchanged underneath them");

/* ---- the other wire format ----
   A second process, because config.mjs reads the environment once at load and
   the API format is decided from it. Cheaper than making the server read env
   per call purely so this file can switch providers mid-run. */

/* Async, not execFileSync: the stub provider runs in THIS process, so blocking
   the event loop to wait for the child deadlocks — the child's request can
   never be answered by a server that is frozen waiting for the child. */
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const run_ = promisify(execFile);
/* Resolved from THIS FILE, never from the working directory. Built from
   process.cwd() it passed when run inside spike/api and failed from the repo
   root — the child could not find the module, four assertions went red, and it
   looked like flakiness rather than a path bug. Same lesson as the database
   path that moved when connect.mjs moved: anchor to something fixed. */
const AI_MODULE = new URL("./northwood/ai.mjs", import.meta.url).href;

const probe = `
  const { summarise } = await import(${JSON.stringify(AI_MODULE)});
  const out = await summarise("job going fine", { subject_name: "Marcus" });
  console.log(JSON.stringify({ h: out.headline, n: out.actions.length,
                               owner: out.actions[0]?.owner }));
  const bad = await summarise("TRIGGER-PROSE", {}).then(() => null, e => e.message);
  console.log(JSON.stringify({ bad }));
`;
let openaiOut = "";
try {
  const { stdout } = await run_(process.execPath,
    ["--input-type=module", "-e", probe], {
      env: { ...process.env, WAYPOINT_LLM_URL: `${BASE}/llm-openai`,
             WAYPOINT_LLM_KEY: "test-key", WAYPOINT_LLM_MODEL: "llama-test",
             WAYPOINT_LLM_API: "openai", WAYPOINT_DATA_DIR: DIR },
      encoding: "utf8", timeout: 30000 });
  openaiOut = stdout;
} catch (e) { openaiOut = String(e.stdout || "") + String(e.stderr || ""); }

const [oneLine, badLine] = openaiOut.trim().split("\n");
let parsed = {}, badParsed = {};
try { parsed = JSON.parse(oneLine); } catch {}
try { badParsed = JSON.parse(badLine); } catch {}

ok(parsed.h === "Employment confirmed; pay stub outstanding.",
   "\x1b[1mthe same summary comes back over the OpenAI-compatible API\x1b[0m");
ok(parsed.n === 1 && parsed.owner === "subject",
   "action items survive the other tool envelope intact");
ok(/expected shape/.test(badParsed.bad || ""),
   "and prose instead of a tool call is still an error, not a summary");
ok(lastRequest.headers.authorization === "Bearer test-key",
   "\x1b[1mOpenAI-compatible auth is a Bearer header, not x-api-key\x1b[0m");

/* ---- the banner, and what clears it ---- */

const subjectItem = done.actions.find(a => a.owner === "subject");
ok(unseenActionCount("cust-test") >= 1,
   "\x1b[1man item off a summary is new to the subject until they look\x1b[0m");
const beforeSeen = openActionsForSubject("cust-test").length;
markActionsSeen("cust-test");
ok(unseenActionCount("cust-test") === 0, "opening the tab clears the banner");
ok(openActionsForSubject("cust-test").length === beforeSeen
   && openActionsForSubject("cust-test").some(a => a.id === subjectItem.id),
   "\x1b[1mbut the items themselves stay — seeing a badge is not doing the thing\x1b[0m");

/* ---- spoken timing into a real date ----
   Arithmetic, not inference: the visit date is known, so these have one right
   answer and a model has no business guessing a deadline. */

const TUE = "2026-09-01T14:00:00.000Z";   // a Tuesday
ok(resolveDueHint("today", TUE) === "2026-09-01", "\"today\" is the day of the visit");
ok(resolveDueHint("tomorrow", TUE) === "2026-09-02", "\"tomorrow\" is the day after");
ok(resolveDueHint("by Friday", TUE) === "2026-09-04",
   "\x1b[1m\"by Friday\" said on a Tuesday is THIS Friday, not last\x1b[0m");
ok(resolveDueHint("this week", TUE) === "2026-09-04",
   "\"this week\" is the end of the working week");
ok(resolveDueHint("next week", TUE) === "2026-09-08", "\"next week\" is a week on");
ok(resolveDueHint("in 3 days", TUE) === "2026-09-04", "a plain count of days works");
ok(resolveDueHint("before the shift", TUE) === null,
   "\x1b[1mand a phrase with no date in it returns nothing rather than a guess\x1b[0m");
ok(resolveDueHint("", TUE) === null && resolveDueHint("Friday", null) === null,
   "missing input is not an error, just no date");

/* ---- the guard the automatic path relies on ---- */

ok(!summaryInFlight(901),
   "with nothing queued, a visit is clear to be summarised");
const inflight = claimSummary(901, [t1.id], "R. Alvarez");
ok(summaryInFlight(901),
   "\x1b[1mtwo transcripts finishing together cannot start two summaries of "
   + "one conversation\x1b[0m");
failSummary(inflight.id, "abandoned by the test");
ok(!summaryInFlight(901), "and the guard clears once it settles");

/* ---- what a restart leaves behind ---- */

const s3 = claimSummary(901, [], "R. Alvarez");
const stale = staleRunning();
ok(stale.summaries.includes(s3.id),
   "\x1b[1ma job still queued when the process stops is findable on boot\x1b[0m");
ok(!stale.summaries.includes(s1.id),
   "and a finished one is not dragged back with it");

fake.close();
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
