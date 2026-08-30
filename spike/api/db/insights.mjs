/**
 * Transcripts, summaries, and the action items a summary proposes.
 *
 * Nothing in here talks to a model — this is storage and state only. The
 * provider calls live in northwood/ai.mjs, behind a seam, so that swapping who
 * hears the audio never touches the shape of what is stored.
 *
 * The states are the same three words everywhere: `queued`, `running`, then
 * `done` or `failed`. A job that dies mid-flight leaves `running` behind, and
 * `staleRunning()` exists so the server can find those on boot rather than
 * leaving a spinner turning forever on somebody's screen.
 */

import { one, all, run, now } from "./connect.mjs";

const WORDS = t => (String(t || "").trim().match(/\S+/g) || []).length;

/* ------------------------------------------------------------------ *
 * transcripts — one per recording, regenerable                        *
 * ------------------------------------------------------------------ */

export const transcriptFor = recording_id =>
  one(`SELECT * FROM visit_transcripts WHERE recording_id = ?`, recording_id);

export const transcriptById = id =>
  one(`SELECT * FROM visit_transcripts WHERE id = ?`, id);

export const transcriptsForVisit = visit_id =>
  all(`SELECT * FROM visit_transcripts WHERE visit_id = ? ORDER BY id`, visit_id);

/**
 * Claim a recording for transcription.
 *
 * Upsert rather than insert: the audio owns the fact and this is a reading of
 * it, so re-running with a better model replaces the reading instead of
 * accumulating rival versions of the same seven seconds.
 *
 * Returns null if one is already queued or running — the guard against an
 * officer pressing the button twice and paying for the same audio twice.
 */
export function claimTranscript(rec, requested_by) {
  const existing = transcriptFor(rec.id);
  if (existing && (existing.status === "queued" || existing.status === "running"))
    return null;

  if (existing) {
    run(`UPDATE visit_transcripts
            SET status = 'queued', text = NULL, language = NULL, engine = NULL,
                word_count = NULL, error = NULL, requested_by = ?,
                created_at = ?, completed_at = NULL
          WHERE id = ?`, requested_by ?? null, now(), existing.id);
    return transcriptById(existing.id);
  }

  run(`INSERT INTO visit_transcripts
         (recording_id, visit_id, status, requested_by, created_at)
       VALUES (?,?,'queued',?,?)`,
      rec.id, rec.visit_id, requested_by ?? null, now());
  return transcriptFor(rec.id);
}

export const markTranscriptRunning = id =>
  run(`UPDATE visit_transcripts SET status = 'running' WHERE id = ?`, id);

export function finishTranscript(id, { text, language, engine }) {
  run(`UPDATE visit_transcripts
          SET status = 'done', text = ?, language = ?, engine = ?,
              word_count = ?, error = NULL, completed_at = ?
        WHERE id = ?`,
      text ?? "", language ?? null, engine ?? null, WORDS(text), now(), id);
  return transcriptById(id);
}

export function failTranscript(id, message) {
  run(`UPDATE visit_transcripts
          SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
      String(message || "unknown error").slice(0, 500), now(), id);
  return transcriptById(id);
}

/* ------------------------------------------------------------------ *
 * summaries — appended, never rewritten                               *
 * ------------------------------------------------------------------ */

export const summaryById = id =>
  one(`SELECT * FROM visit_summaries WHERE id = ?`, id);

export const actionsFor = summary_id =>
  all(`SELECT * FROM visit_summary_actions WHERE summary_id = ? ORDER BY position`,
      summary_id);

/** A summary with its proposed actions attached. */
export const hydrateSummary = s => s && {
  ...s,
  source_ids: JSON.parse(s.source_ids || "[]"),
  actions: actionsFor(s.id)
};

/**
 * Every summary a visit has, newest first.
 *
 * Plural on purpose. Re-summarising appends, so what an officer read in March
 * is still readable in June — a document somebody may have relied on is not
 * something to quietly rewrite underneath them.
 */
export const summariesForVisit = visit_id =>
  all(`SELECT * FROM visit_summaries WHERE visit_id = ? ORDER BY id DESC`, visit_id)
    .map(hydrateSummary);

/**
 * Is a summary already on its way for this visit?
 *
 * The guard for the automatic path. Two recordings transcribed back to back
 * would otherwise each start a summary of the same visit, and the officer
 * would pay twice for two readings of one conversation.
 */
export const summaryInFlight = visit_id => !!one(
  `SELECT id FROM visit_summaries
    WHERE visit_id = ? AND status IN ('queued','running')`, visit_id);

export function claimSummary(visit_id, source_ids, requested_by) {
  run(`INSERT INTO visit_summaries
         (visit_id, status, source_ids, requested_by, created_at)
       VALUES (?,'queued',?,?,?)`,
      visit_id, JSON.stringify(source_ids || []), requested_by ?? null, now());
  return summaryById(one(`SELECT MAX(id) id FROM visit_summaries
                           WHERE visit_id = ?`, visit_id).id);
}

export const markSummaryRunning = id =>
  run(`UPDATE visit_summaries SET status = 'running' WHERE id = ?`, id);

/**
 * Store what the model produced.
 *
 * Action items land LIVE, not as proposals awaiting a blessing.
 *
 * They were `proposed` at first, on the reasoning that a machine should not
 * create work for a person on its own. In use that was friction, not safety:
 * an officer who has just held the conversation does not need to be asked
 * whether the thing they said out loud exists. What they need is for it to be
 * on the list.
 *
 * The protection that matters is kept and is cheaper — anything wrong can be
 * removed, the owner can be corrected, and the record always says whether a
 * person or a machine put it there and who closed it.
 */
export function finishSummary(id, { headline, body, model, actions }) {
  const s = summaryById(id);
  run(`UPDATE visit_summaries
          SET status = 'done', headline = ?, body = ?, model = ?,
              error = NULL, completed_at = ?
        WHERE id = ?`,
      headline ?? null, body ?? "", model ?? null, now(), id);

  const v = one(`SELECT scheduled_at FROM visits WHERE id = ?`, s.visit_id);

  (actions || []).forEach((a, i) => {
    /* Dated here rather than on acceptance, because there is no acceptance any
       more. Still arithmetic against the visit's own date, never a guess. */
    const due = resolveDueHint(a.due_hint, v?.scheduled_at)
             || resolveDueHint(a.body, v?.scheduled_at);
    const text = String(a.body || "").trim();
    run(`INSERT INTO visit_summary_actions
           (summary_id, visit_id, body, body_proposed, owner, owner_proposed,
            due_hint, due_date, quote, position, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'accepted',?)`,
        id, s.visit_id, text, text,
        a.owner ?? null, a.owner ?? null, a.due_hint ?? null, due ?? null,
        a.quote ?? null, i, now());
  });

  return hydrateSummary(summaryById(id));
}

export function failSummary(id, message) {
  run(`UPDATE visit_summaries
          SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
      String(message || "unknown error").slice(0, 500), now(), id);
  return summaryById(id);
}

/**
 * Accepted action items for one subject that are not done yet.
 *
 * Only ACCEPTED ones. A proposal an officer has not looked at is not work
 * anybody owes, and putting it on a to-do list would quietly undo the rule the
 * whole feature rests on.
 */
export const openActionsForSubject = subject_id => all(
  `SELECT a.*, v.subject_id, v.scheduled_at, v.officer
     FROM visit_summary_actions a
     JOIN visits v ON v.id = a.visit_id
    WHERE v.subject_id = ? AND a.status = 'accepted'
    ORDER BY a.id`, subject_id);

/**
 * Every action item for a subject, whatever state it is in.
 *
 * The module needs the dismissed and done ones too — a list that shows only
 * what is outstanding cannot answer "what came out of that visit", which is
 * the question somebody actually asks six weeks later.
 */
export const actionsForSubject = subject_id => all(
  `SELECT a.*, v.subject_id, v.scheduled_at, v.officer,
          (SELECT headline FROM visit_summaries WHERE id = a.summary_id) headline
     FROM visit_summary_actions a
     JOIN visits v ON v.id = a.visit_id
    WHERE v.subject_id = ?
    ORDER BY a.status = 'accepted' DESC, a.visit_id DESC, a.position`, subject_id);

/**
 * Turn "by Friday" into a date, using the day the visit happened.
 *
 * Deterministic on purpose. The visit date is known, so these phrases have one
 * right answer and there is nothing for a model to infer — asking it would
 * introduce a way to be confidently wrong about a deadline, which is the last
 * place to want one. Anything it cannot resolve returns null rather than a
 * guess, and the officer types a date.
 */
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday",
              "friday", "saturday"];

export function resolveDueHint(hint, fromISO) {
  const h = String(hint || "").toLowerCase();
  if (!h || !fromISO) return null;
  const base = new Date(fromISO);
  if (isNaN(base)) return null;
  const iso = d => d.toISOString().slice(0, 10);
  const plus = n => { const d = new Date(base); d.setDate(d.getDate() + n); return iso(d); };

  if (/\btoday\b|\bnow\b/.test(h)) return iso(base);
  if (/\btomorrow\b/.test(h)) return plus(1);

  /* A named day means the next one on or after the visit — "by Friday" said on
     a Tuesday is this Friday, not last. */
  const day = DAYS.findIndex(d => new RegExp(`\\b${d}\\b`).test(h));
  if (day >= 0) {
    const ahead = (day - base.getDay() + 7) % 7;
    return plus(ahead === 0 ? 7 : ahead);
  }

  /* "this week" means by the end of the working week; "next week" a week on. */
  if (/\bthis week\b/.test(h)) {
    const toFriday = (5 - base.getDay() + 7) % 7;
    return plus(toFriday === 0 ? 0 : toFriday);
  }
  if (/\bnext week\b/.test(h)) return plus(7);
  if (/\bthis month\b/.test(h)) {
    const d = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    return iso(d);
  }
  if (/\bnext month\b/.test(h)) return plus(30);

  const days = h.match(/\b(\d{1,2})\s*days?\b/);
  if (days) return plus(Number(days[1]));

  return null;   // "before the shift", "when you can" — no date to be had
}

/**
 * Fill in dates for items accepted before the resolver existed.
 *
 * Run at boot, once per row: only accepted items that have a spoken phrase and
 * no date yet. A date an officer typed is never touched, because a person's
 * answer outranks arithmetic.
 */
export function backfillDueDates() {
  const rows = all(`SELECT a.id, a.due_hint, a.body, v.scheduled_at
                      FROM visit_summary_actions a
                      JOIN visits v ON v.id = a.visit_id
                     WHERE a.status = 'accepted' AND a.due_date IS NULL`);
  let n = 0;
  for (const r of rows) {
    const d = resolveDueHint(r.due_hint, r.scheduled_at)
           || resolveDueHint(r.body, r.scheduled_at);
    if (d) { run(`UPDATE visit_summary_actions SET due_date = ? WHERE id = ?`, d, r.id); n++; }
  }
  return n;
}

/**
 * Items left waiting for an acceptance that no longer exists.
 *
 * Action items used to arrive as `proposed` and needed an officer to accept
 * them. When that gate was removed, everything already sitting in the queue
 * would have become unreachable — no screen lists them any more — and a dozen
 * real commitments would have quietly disappeared. Removing a state means
 * moving the rows that were in it.
 */
export function promoteProposedActions() {
  const rows = all(`SELECT a.id, a.due_hint, a.body, v.scheduled_at
                      FROM visit_summary_actions a
                      JOIN visits v ON v.id = a.visit_id
                     WHERE a.status = 'proposed'`);
  for (const r of rows) {
    const d = resolveDueHint(r.due_hint, r.scheduled_at)
           || resolveDueHint(r.body, r.scheduled_at);
    run(`UPDATE visit_summary_actions
            SET status = 'accepted', due_date = COALESCE(due_date, ?)
          WHERE id = ?`, d ?? null, r.id);
  }
  return rows.length;
}

/**
 * Tidy what the old append-everything rule left behind.
 *
 * Runs once per row at boot: on any visit with more than one summary, the
 * untouched items from every summary but the newest are superseded. Also
 * strips the quote marks models like to wrap the spoken phrase in, which the
 * screen then quoted again, giving ""today"".
 */
export function supersedeStaleActions() {
  const dupes = run(
    `UPDATE visit_summary_actions
        SET status = 'superseded'
      WHERE status = 'accepted' AND owner_set_by IS NULL AND done_at IS NULL
        AND summary_id < (SELECT MAX(s.id) FROM visit_summaries s
                           WHERE s.visit_id = visit_summary_actions.visit_id
                             AND s.status = 'done')`);
  const quoted = run(
    `UPDATE visit_summary_actions
        SET due_hint = TRIM(TRIM(due_hint), CHAR(34))
      WHERE due_hint LIKE CHAR(34) || '%' OR due_hint LIKE '%' || CHAR(34)`);
  return { superseded: dupes?.changes || 0, unquoted: quoted?.changes || 0 };
}

/**
 * Correcting the wording.
 *
 * A transcript hears "reinstatement" as "read statement", and the summary
 * carries that through faithfully. An officer has to be able to fix it — and
 * what the machine wrote is kept beside the correction rather than replaced,
 * so the row can still answer how good the reading was.
 */
export function setActionBody(id, body, who) {
  const text = String(body || "").trim();
  if (!text) return { error: "An action item cannot be empty." };
  const a = one(`SELECT * FROM visit_summary_actions WHERE id = ?`, id);
  if (!a) return { error: "no such action item" };
  run(`UPDATE visit_summary_actions
          SET body = ?, body_set_by = ?, body_set_at = ? WHERE id = ?`,
      text, who ?? null, now(), id);
  return { ok: true, action: one(`SELECT * FROM visit_summary_actions WHERE id = ?`, id) };
}

/** An officer setting or clearing the date an action is due. */
export function setActionDue(id, due_date, who) {
  const a = one(`SELECT * FROM visit_summary_actions WHERE id = ?`, id);
  if (!a) return { error: "no such action item" };
  const d = due_date ? String(due_date).slice(0, 10) : null;
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d))
    return { error: "A due date looks like 2026-09-04." };
  run(`UPDATE visit_summary_actions SET due_date = ? WHERE id = ?`, d, id);
  void who;
  return { ok: true, action: one(`SELECT * FROM visit_summary_actions WHERE id = ?`, id) };
}

/** Accepted items the subject has not yet laid eyes on. Drives the banner. */
export const unseenActionCount = subject_id => one(
  `SELECT COUNT(*) n
     FROM visit_summary_actions a
     JOIN visits v ON v.id = a.visit_id
    WHERE v.subject_id = ? AND a.owner = 'subject'
      AND a.status = 'accepted' AND a.subject_seen_at IS NULL`, subject_id)?.n ?? 0;

/* Opening the Actions tab is what marks them seen, and only that tab — the
   same rule as goals. Seeing a badge is not seeing the thing. */
export const markActionsSeen = subject_id => run(
  `UPDATE visit_summary_actions
      SET subject_seen_at = ?
    WHERE subject_seen_at IS NULL AND status = 'accepted' AND owner = 'subject'
      AND visit_id IN (SELECT id FROM visits WHERE subject_id = ?)`,
  now(), subject_id);

/** Marking one done. Only something already accepted can be finished. */
export function completeAction(id, who) {
  const a = one(`SELECT * FROM visit_summary_actions WHERE id = ?`, id);
  if (!a) return { error: "no such action item" };
  if (a.status !== "accepted")
    return { error: "Only an accepted action item can be marked done." };
  run(`UPDATE visit_summary_actions
          SET status = 'done', done_by = ?, done_at = ? WHERE id = ?`,
      who ?? null, now(), id);
  return { ok: true, action: one(`SELECT * FROM visit_summary_actions WHERE id = ?`, id) };
}

/**
 * Correct who an action belongs to.
 *
 * The transcript has no speaker labels — Whisper does not diarise — so the
 * owner is inferred from phrasing, and phrasing comes apart from ownership
 * exactly where an officer INSTRUCTS the subject to do something. The sentence
 * is in the officer's mouth; the work is the subject's.
 *
 * So this is a correction an officer will genuinely need, and what the model
 * proposed is kept beside it rather than overwritten.
 */
export function setActionOwner(id, owner, who) {
  if (!["officer", "subject", "unclear"].includes(owner))
    return { error: "An action belongs to the officer, the subject, or is unclear." };
  const a = one(`SELECT * FROM visit_summary_actions WHERE id = ?`, id);
  if (!a) return { error: "no such action item" };
  run(`UPDATE visit_summary_actions
          SET owner = ?, owner_set_by = ?, owner_set_at = ? WHERE id = ?`,
      owner, who ?? null, now(), id);
  return { ok: true, action: one(`SELECT * FROM visit_summary_actions WHERE id = ?`, id) };
}

/**
 * An officer's decision on one proposed action.
 *
 * Recorded with a name and a time, because "who decided this did not need
 * doing" is exactly the question asked afterwards.
 */
export function decideAction(id, status, who) {
  if (status === "done") return completeAction(id, who);
  /* `proposed` is gone as a gate but stays reachable, so an item dismissed by
     mistake can be put back on the list rather than lost. */
  if (!["accepted", "dismissed", "proposed"].includes(status))
    return { error: "An action item is open, dismissed, or done." };
  const a = one(`SELECT * FROM visit_summary_actions WHERE id = ?`, id);
  if (!a) return { error: "no such action item" };
  run(`UPDATE visit_summary_actions
          SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
      status, status === "proposed" ? null : (who ?? null),
      status === "proposed" ? null : now(), id);

  /* Accepting is the moment it becomes work somebody owes, so that is when the
     spoken phrase is turned into a date. Derived, not guessed — and only if
     nobody has typed one, which always wins. */
  if (status === "accepted" && !a.due_date) {
    const v = one(`SELECT scheduled_at FROM visits WHERE id = ?`, a.visit_id);
    /* The hint first, then the action text itself. A model that folds the
       timing into the sentence — "drop the stub off by Friday" — has still
       said Friday, and refusing to read it because it landed in the wrong
       field would be losing information we already have. Same resolver, same
       arithmetic, just a second place to look. */
    const d = resolveDueHint(a.due_hint, v?.scheduled_at)
           || resolveDueHint(a.body, v?.scheduled_at);
    if (d) run(`UPDATE visit_summary_actions SET due_date = ? WHERE id = ?`, d, id);
  }
  return { ok: true, action: one(`SELECT * FROM visit_summary_actions WHERE id = ?`, id) };
}

/* Jobs the process was in the middle of when it stopped. Nothing resumes them
   — the point is to fail them loudly on boot so a screen shows "failed, try
   again" instead of a spinner that turns until somebody reloads. */
export const staleRunning = () => ({
  transcripts: all(`SELECT id FROM visit_transcripts
                     WHERE status IN ('queued','running')`).map(r => r.id),
  summaries: all(`SELECT id FROM visit_summaries
                   WHERE status IN ('queued','running')`).map(r => r.id)
});

