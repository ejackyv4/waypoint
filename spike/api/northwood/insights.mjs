/**
 * Transcribing a visit recording, and summarising what it says.
 *
 * Both are slow — minutes, not milliseconds — so neither is done inside the
 * request that asks for it. The handler claims a row, hands the work to a
 * queue, and answers immediately with something the screen can poll. An HTTP
 * request that sits open for four minutes is a request that dies to the first
 * proxy, phone lock or lift, and takes the work with it.
 *
 * The queue runs ONE job at a time on purpose. There is a paid API on the
 * other end of it, and a caseload's worth of recordings submitted at once
 * should form an orderly line rather than a bill.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { visit, recordingById, subjectByKey } from "../db/northwood.mjs";
import { goalsFor } from "../db/goals.mjs";
import {
  claimTranscript, transcriptById, transcriptFor, transcriptsForVisit,
  markTranscriptRunning, finishTranscript, failTranscript,
  claimSummary, summaryById, hydrateSummary, summariesForVisit, summaryInFlight,
  markSummaryRunning, finishSummary, failSummary,
  decideAction, setActionOwner, setActionDue, setActionBody, staleRunning,
  actionsForSubject, backfillDueDates, promoteProposedActions,
  supersedeStaleActions
} from "../db/insights.mjs";
import { transcribe, summarise } from "./ai.mjs";
import { AUDIO_DIR } from "./documents.mjs";
import { STT_READY, LLM_READY } from "../config.mjs";
import { saasJson } from "./shared.mjs";
import { readJson } from "../http.mjs";

/* ------------------------------------------------------------------ *
 * the queue                                                           *
 * ------------------------------------------------------------------ */

const queue = [];
let working = false;

async function drain() {
  if (working) return;
  working = true;
  while (queue.length) {
    const job = queue.shift();
    try { await job(); }
    catch (e) {
      /* A job records its own failure in its own row. Reaching here means the
         recording of the failure failed, which is worth a line in the log but
         must not stop the queue — one bad job should not strand every job
         behind it. */
      console.error("  [insights] job died:", e?.message || e);
    }
  }
  working = false;
}

const enqueue = job => { queue.push(job); drain(); };

/**
 * Anything left mid-flight when the process stopped.
 *
 * Nothing is resumed: the point is to fail them so a screen shows "failed,
 * try again" rather than a spinner that turns until somebody reloads. A job
 * that silently never finishes is the worst of the three outcomes because it
 * never asks anybody to do anything about it.
 */
export function fillMissingDueDates() {
  const tidy = supersedeStaleActions();
  if (tidy.superseded)
    console.log(`  [insights] superseded ${tidy.superseded} action item(s) left by an `
              + `earlier summary of the same visit`);
  if (tidy.unquoted)
    console.log(`  [insights] unquoted ${tidy.unquoted} spoken phrase(s)`);

  const promoted = promoteProposedActions();
  if (promoted)
    console.log(`  [insights] put ${promoted} action item(s) onto the list — the `
              + `acceptance step they were waiting on no longer exists`);
  const n = backfillDueDates();
  if (n) console.log(`  [insights] dated ${n} action item(s) from what was said`);
}

export function failStaleJobs() {
  const { transcripts, summaries } = staleRunning();
  const why = "The server restarted while this was running. Try again.";
  transcripts.forEach(id => failTranscript(id, why));
  summaries.forEach(id => failSummary(id, why));
  if (transcripts.length || summaries.length)
    console.log(`  [insights] failed ${transcripts.length} transcript(s) and `
              + `${summaries.length} summary(ies) left running by a restart`);
}

/* ------------------------------------------------------------------ *
 * the jobs                                                            *
 * ------------------------------------------------------------------ */

const runTranscription = (transcript_id, rec) => async () => {
  markTranscriptRunning(transcript_id);
  try {
    const bytes = await readFile(join(AUDIO_DIR, rec.filename));
    const out = await transcribe(bytes, rec.filename, rec.mime_type);
    finishTranscript(transcript_id, out);
    /* A summary nobody remembers to ask for is a summary that never gets
       written, so it follows the transcript rather than waiting for a second
       button. Failure to summarise must not fail the transcription — the
       transcript is the thing that was asked for and it is already saved. */
    startSummary(rec.visit_id, transcriptById(transcript_id)?.requested_by);
  } catch (e) { failTranscript(transcript_id, e?.message || e); }
};

const runSummary = (summary_id, v, text) => async () => {
  markSummaryRunning(summary_id);
  try {
    const s = subjectByKey(v.subject_id);
    finishSummary(summary_id, await summarise(text, {
      subject_name: s?.name, officer: v.officer,
      scheduled_at: v.scheduled_at, location: v.location
    }));
  } catch (e) { failSummary(summary_id, e?.message || e); }
};

/**
 * Queue a transcription of one recording.
 *
 * Called both by the officer's button and, now, by the upload itself — a step
 * that has to be remembered is a step that gets skipped, and a recording
 * nobody transcribed is a recording nobody reads.
 *
 * The consequence is worth being clear about: attaching audio now sends it to
 * whichever service WAYPOINT_STT_URL names. That is not hidden — the console
 * says so beside the upload control, because the officer should know it at the
 * moment they choose the file rather than discover it afterwards.
 *
 * Returns the row, or a reason it did not start.
 */
export function startTranscription(rec, requested_by) {
  if (!STT_READY()) return { skipped: "not configured" };
  const t = claimTranscript(rec, requested_by ?? null);
  if (!t) return { skipped: "already under way" };
  enqueue(runTranscription(t.id, rec));
  return { transcript: t };
}

/**
 * Queue a summary of everything transcribed for a visit.
 *
 * One function for both callers — the automatic one above and the officer's
 * button — so "summarise a visit" means exactly one thing. Returns the row, or
 * a reason it did not start.
 */
function startSummary(visit_id, requested_by) {
  if (!LLM_READY()) return { skipped: "not configured" };
  const v = visit(visit_id);
  if (!v) return { skipped: "no such visit" };

  const done = transcriptsForVisit(visit_id).filter(t => t.status === "done" && t.text);
  if (!done.length) return { skipped: "nothing transcribed yet" };

  /* Two recordings transcribed back to back would otherwise each start a
     summary of the same conversation, and the officer pays twice. */
  if (summaryInFlight(visit_id)) return { skipped: "already under way" };

  /* Several recordings read as one conversation, in the order they were made,
     each labelled so the model does not stitch two separate doorstep exchanges
     into one narrative. */
  const text = done.map((t, i) => done.length > 1
    ? `[Recording ${i + 1} of ${done.length}]\n${t.text}` : t.text).join("\n\n");

  const s = claimSummary(visit_id, done.map(t => t.id), requested_by ?? null);
  enqueue(runSummary(s.id, v, text));
  return { summary: s };
}

/* ------------------------------------------------------------------ */

export const routes = {

  /**
   * Turn one recording into text.
   *
   * Deliberately per-recording and deliberately explicit: the audio leaves the
   * building when an officer decides it should, not as a side effect of
   * pressing stop at the door.
   */
  "POST /api/visits/recording/transcribe": async (req, res, ctx) => {
    if (!STT_READY()) return saasJson(res, 503, {
      error: "Transcription is not configured on this server. Set "
           + "WAYPOINT_STT_KEY, and WAYPOINT_STT_URL if the service is not "
           + "OpenAI's." });

    const b = await readJson(req);
    const rec = recordingById(Number(b.recording_id));
    if (!rec) return saasJson(res, 404, { error: "no such recording" });

    const r = startTranscription(rec, b.officer || ctx.session?.name || null);
    if (r.skipped === "already under way") return saasJson(res, 409, {
      error: "This recording is already being transcribed.",
      transcript: transcriptFor(rec.id) });
    if (r.skipped) return saasJson(res, 503, { error: r.skipped });
    return saasJson(res, 202, { transcript: r.transcript });
  },

  /** Where that got to. Polled by the screen that asked for it. */
  "ALL /api/visits/transcript/:id": async (req, res, ctx) => {
    const t = transcriptById(Number(ctx.params.id));
    if (!t) return saasJson(res, 404, { error: "no such transcript" });
    return saasJson(res, 200, { transcript: t });
  },

  /**
   * The transcript as a file.
   *
   * Generated from the stored text rather than written to disk beside the
   * audio: the text is the record and a file on disk would be a second copy of
   * it, free to drift. One fact, one place — the download is a view of it.
   */
  "ALL /visit-transcripts/:id": async (req, res, ctx) => {
    const t = transcriptById(Number(ctx.params.id));
    if (!t) { res.writeHead(404); return res.end("not found"); }
    if (t.status !== "done") { res.writeHead(409); return res.end("not ready"); }

    const v = visit(t.visit_id);
    const s = v && subjectByKey(v.subject_id);
    /* A header on the file itself, because a transcript that travels without
       one is a page of dialogue nobody can place — and one that does not say
       it was made by a machine will eventually be read as though it was not. */
    const file =
`Visit transcript
${"=".repeat(60)}
Subject      ${s?.name || v?.subject_id || "—"}
Visit        #${t.visit_id}${v?.scheduled_at ? ` · ${v.scheduled_at.slice(0, 10)}` : ""}
Officer      ${v?.officer || "—"}
Recording    #${t.recording_id}
Transcribed  ${t.completed_at || "—"} by ${t.engine || "—"}
Language     ${t.language || "not reported"}

This is a MACHINE transcription of an audio recording. It has not been checked
by a person and will contain errors, particularly in names, numbers, dates and
addresses. The recording is the record; this is a reading of it.
${"=".repeat(60)}

${t.text || ""}
`;
    const name = `visit-${t.visit_id}-recording-${t.recording_id}-transcript.txt`;
    const buf = Buffer.from(file, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": buf.length,
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    return res.end(buf);
  },

  /**
   * Summarise a visit from everything transcribed for it.
   *
   * A visit, not a recording: an officer may have stopped and started three
   * times at one doorstep, and three summaries of one conversation is not what
   * anybody wants in a case file.
   */
  "POST /api/visits/summarise": async (req, res, ctx) => {
    if (!LLM_READY()) return saasJson(res, 503, {
      error: "Summarising is not configured on this server. Set "
           + "WAYPOINT_LLM_KEY." });

    const b = await readJson(req);
    const v = visit(Number(b.id));
    if (!v) return saasJson(res, 404, { error: "no such visit" });

    const r = startSummary(v.id, b.officer || ctx.session?.name || null);
    if (r.skipped === "nothing transcribed yet") return saasJson(res, 409, {
      error: "There is nothing to summarise yet — transcribe a recording first." });
    if (r.skipped === "already under way") return saasJson(res, 409, {
      error: "A summary of this visit is already being written." });
    if (r.skipped) return saasJson(res, 409, { error: r.skipped });
    return saasJson(res, 202, { summary: hydrateSummary(r.summary) });
  },

  "ALL /api/visits/summary/:id": async (req, res, ctx) => {
    const s = summaryById(Number(ctx.params.id));
    if (!s) return saasJson(res, 404, { error: "no such summary" });
    return saasJson(res, 200, { summary: hydrateSummary(s) });
  },

  /**
   * An officer's decision on one proposed action item.
   *
   * This is the line between a machine reading and a person's obligation.
   * Until an officer accepts it, an action item proposed from a recording is a
   * suggestion on a screen and nothing more.
   */
  "POST /api/visits/summary/action": async (req, res, ctx) => {
    const b = await readJson(req);
    if (!Number(b.id)) return saasJson(res, 400, { error: "id is required" });
    const who = b.officer || ctx.session?.name || null;
    const bad = e => saasJson(res, e === "no such action item" ? 404 : 400,
                              { error: e });

    /* Correcting the owner and deciding the item are one gesture on the screen
       — an officer reassigns it on the way to accepting — so they are one
       request. The owner is set first: accepting an item and then correcting
       it would record the decision against the wrong person for an instant,
       and that instant is what an audit log would show. */
    if (b.owner) {
      const r = setActionOwner(Number(b.id), String(b.owner), who);
      if (r.error) return bad(r.error);
      if (!b.status && b.due_date === undefined) return saasJson(res, 200, r);
    }

    /* Fixing the words. A transcript mishears, and the summary repeats the
       mishearing faithfully — "reinstatement" comes back as "read statement". */
    if (b.body !== undefined) {
      const r = setActionBody(Number(b.id), b.body, who);
      if (r.error) return bad(r.error);
      if (!b.status && b.due_date === undefined && !b.owner)
        return saasJson(res, 200, r);
    }

    /* An officer overriding the derived date. `null` clears it — distinguished
       from "not provided" so clearing a date is possible at all, which is the
       partial-update trap this codebase has a rule about. */
    if (b.due_date !== undefined) {
      const r = setActionDue(Number(b.id), b.due_date, who);
      if (r.error) return bad(r.error);
      if (!b.status) return saasJson(res, 200, r);
    }

    const r = decideAction(Number(b.id), String(b.status || ""), who);
    if (r.error) return bad(r.error);
    return saasJson(res, 200, r);
  },

  /**
   * Every action item a subject has, across all their visits.
   *
   * The module's list. Whatever state they are in — a list showing only what is
   * outstanding cannot answer "what came out of that visit", which is the
   * question somebody actually asks six weeks later.
   */
  "ALL /api/subject/actions": async (req, res, ctx) => {
    const subject_id = ctx.url.searchParams.get("subject_id");
    if (!subject_id) return saasJson(res, 400, { error: "subject_id is required" });

    /* Everything this person has to do, wherever it came from.
     *
     * Two things produce work here: a step typed into a goal, and a commitment
     * pulled out of a visit recording. They are stored apart — different
     * tables, different parents, different lifetimes — and that is right. But
     * an officer asking "what does Dana owe me" does not care which machinery
     * produced the row, and a screen that answers only half the question is
     * worse than no screen: it looks complete and is not.
     *
     * Merged for reading only. Each still writes through its own endpoint. */
    const steps = goalsFor(subject_id).flatMap(g =>
      (g.steps || []).map(st => ({
        kind: "goal_step",
        id: st.id,
        body: st.body,
        /* A goal is assigned TO the subject, so its steps are theirs. Either
           side may tick one, which is why done_by exists. */
        owner: "subject",
        due_date: g.due_date || null,
        due_hint: null,
        quote: null,
        status: st.done_at ? "done" : (g.status === "open" ? "accepted" : "closed"),
        done_by: st.done_by || null,
        done_at: st.done_at || null,
        subject_id,
        source: { type: "goal", id: g.id, title: g.title, status: g.status }
      })));

    const fromVisits = actionsForSubject(subject_id).map(a => ({
      ...a, kind: "visit_item",
      source: { type: "visit", id: a.visit_id, on: a.scheduled_at }
    }));

    return saasJson(res, 200, { actions: [...fromVisits, ...steps] });
  },

  /** What this server can actually do, so a screen can hide what it cannot. */
  "ALL /api/insights/capabilities": async (req, res) =>
    saasJson(res, 200, { transcription: STT_READY(), summary: LLM_READY() })
};

export { summariesForVisit, transcriptsForVisit };
