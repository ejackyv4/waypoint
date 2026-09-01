# Recording a supervision visit

Audio captured at the door, turned into a transcript, turned into a summary with
proposed action items — and the rules that keep each of those from becoming
something it isn't.

This is a **proof of concept**. Everything described here is built and tested;
what is *not* here is listed at the end, and some of it is not small.

---

## The chain, in one line

```
officer presses Record  →  .m4a on disk  →  transcript (text)  →  summary + proposed actions
   evidence                  evidence          a machine's reading      a document, and suggestions
                          ↑ person decides   ↑ automatic
```

The **first** arrow is a deliberate act by a person: audio of a supervision
conversation leaving the building is a decision somebody makes, not a consequence of
pressing stop at a door. Once that decision is taken, the summary follows the
transcript on its own — the conversation has already gone where it was going, and
making an officer press a second button only means the summary sometimes never gets
written.

---

## 1 · Recording

**Where:** the mobile app, on the visit screen, once the visit has been started.
Not before — a recording filed against a visit that hasn't begun is a recording
of a drive. The console also takes an uploaded file, for audio made on a handset.

**A completed visit still accepts audio**, because ending a visit means the officer
left the property, not that the record is sealed. Uploading from a desk an hour later
is transfer time, not a different event. Only a *cancelled* visit refuses audio — it
never took place.

**What it does:** an `Audio` card sits at the top of the screen with a red
*Record this visit* button. While it runs the card turns red and shows a live
`mm:ss` clock. Stopping uploads it; it appears in a list below with a play
button. Closing the screen or ending the visit while recording **stops and saves
first** rather than refusing to work or discarding the audio.

### It announces itself

Whether a conversation may be recorded without telling the other person depends
on where the officer is standing. Utah is one-party consent; several of its
neighbours are not. That is not a judgment to bury in a settings toggle, so the
app is loud about it: the button says what it does, the card is unmistakably red
while it runs, and the hint reads *"Everyone present should know this
conversation is being recorded."*

This is a deliberate product decision, not a technical constraint. Read it as a
question for legal counsel per jurisdiction, not as a solved problem.

### Format

Mono AAC in an `.m4a` container, 22.05 kHz, 32 kbps — roughly **14 MB an hour**.
Legible speech, small enough to finish uploading from a doorstep on bad wifi.

Both platforms are pinned to the same codec deliberately. Expo's stock
`LOW_QUALITY` preset records AMR in `.3gp` on Android and AAC on iOS: one
setting, two formats, and a file that plays on one phone and not the other.

### Silence detection

A muted, covered, or simulated microphone still produces a perfectly valid file
of exactly the right length with nothing in it. The app meters the input while
recording and, if the level never crosses the floor, says so as soon as you
stop:

> **That recording has no sound in it.** It has been saved, but nothing reached
> the microphone for the whole 0:08.

It saves anyway — it is evidence and this app does not discard evidence — but the
officer learns immediately rather than on playback weeks later.

> **The iOS Simulator does not capture audio.** It produces exactly this
> failure. Test recording on a real device.

### Storage

| | |
|---|---|
| Table | `visit_recordings` |
| Files | `spike/data/visit-audio/`, filename generated server-side |
| Upload | base64 in the JSON body — no multipart parser on this server |
| Limits | 25 MB decoded; MIME allowlist, never sniffed |
| Served as | `audio/mp4` with `nosniff` |
| Delete | **there is no delete endpoint** |

The filename is generated, never the one the caller supplied — an uploaded
filename is attacker-controlled and has no business reaching a filesystem.

It is served as `audio/mp4` rather than the `audio/m4a` the phone calls it,
because `audio/m4a` is not a registered type and iOS refuses to play a
progressive download whose declared type it doesn't recognise. The URL has no
extension to fall back on.

Recordings live in their own table rather than beside the photographs. A still of
a doorway and a recording of a conversation are different things with different
retention and disclosure questions, and a column that means "duration" for half
the rows is the shape this codebase already has a rule against.

---

## 2 · Transcription

**Not an agent.** This is one HTTP request: audio in, text out. No reasoning
loop, no tool use, no orchestration. It is a speech-to-text *model* — Whisper or
equivalent — not something that needs to think about the problem.

```
POST /api/visits/recording/transcribe  { recording_id }   →  202 + a row to poll
ALL  /api/visits/transcript/:id                           →  where it got to
ALL  /visit-transcripts/:id                               →  the .txt file
```

Per recording, and only when asked. Both jobs answer **202 and a row to poll**
because they take minutes — an HTTP request held open that long dies to the first
proxy, phone lock or lift, and takes the work with it.

The queue runs **one job at a time**. There is a paid API on the other end, and a
caseload submitted at once should form a line rather than a bill.

A job still marked `running` when the process stops is **failed on the next
boot**. A screen showing "failed, try again" asks somebody to do something; a
spinner that never stops does not.

### The output file

`GET /visit-transcripts/:id` builds a `.txt` **from the stored text** rather than
serving a second file written to disk. A second copy is a copy free to drift.

Every file carries a header:

```
Visit transcript
============================================================
Subject      Marcus Oyelaran
Visit        #18 · 2026-08-29
Officer      R. Alvarez
Recording    #2
Transcribed  2026-08-29T14:02:11.902Z by api.openai.com:whisper-1
Language     english

This is a MACHINE transcription of an audio recording. It has not been checked
by a person and will contain errors, particularly in names, numbers, dates and
addresses. The recording is the record; this is a reading of it.
============================================================
```

A transcript that travels without that gets read as though a person wrote it.

### Regenerable, on purpose

There is exactly **one transcript per recording**, and re-running replaces it.
The audio owns the fact; the transcript derives from it. A better model next year
produces a better reading of the same seven seconds, and there is no reason to
keep the worse one alongside it.

This is the opposite of the rule for the recording itself, and the difference is
the point: one is evidence, one is a reading of evidence.

---

## 3 · Summary and action items

```
POST /api/visits/summarise      { id }      →  202
ALL  /api/visits/summary/:id                →  where it got to
POST /api/visits/summary/action { id, status }
```

**This runs automatically once a transcript completes.** An officer should not have
to remember a second button, and a summary nobody asks for is a summary nobody
writes. The endpoint stays for re-runs. A summary is skipped if one is already in
flight for the visit, and a failure here never fails the transcription that produced
it.

One Claude call with a **tool schema** forcing the output shape, so the structure
is enforced by the API rather than by a regex over prose that mostly works.

Takes a **visit**, not a recording. An officer may have stopped and started three
times at one doorstep; three summaries of one conversation is not what belongs in
a case file. Every completed transcript for the visit is read in order, each
labelled, so two separate exchanges are not stitched into one story.

Facts the record already holds — subject, officer, date, location — are passed
in rather than left to be heard from the audio.

### What the model is told

The system prompt is blunt, because the failure that matters here is confident
invention. A transcript of a doorstep conversation is half-audible by nature, and
a summary that smooths over the inaudible parts reads exactly as well as an
accurate one.

> This summary may end up in a case file and may be read by people making
> decisions about someone's liberty.
>
> - Record only what the transcript actually contains. Never infer, fill a gap,
>   or smooth over a passage that is garbled or inaudible.
> - Where the transcript is unclear, say so in the summary in those words.
> - Do not assess, diagnose, or characterise the subject.
> - Do not decide whether anything is a violation. That is the officer's call.
> - If nothing was agreed, return an empty list.

### Summaries append; they are never rewritten

Re-summarising **adds a row**. What an officer read in March is still there in
June rather than quietly rewritten underneath them — because unlike a transcript,
a summary is a document somebody may have relied on.

### Action items are proposals, never obligations

This is the load-bearing rule of the whole feature.

Every action item lands as `proposed`. An officer **accepts** or **dismisses**
each one, recorded with a name and a time. Until then it counts as nothing: it
does not appear on the subject's app, does not become a goal, does not enter the
visit agenda, and does not appear in any total.

A machine reading of a conversation may put something in front of a person. It
may not create work for one.

This is the same rule the rest of the system already runs on — the party that
isn't making the decision doesn't get to assert the outcome — applied to a model
instead of to a client.

Each proposal carries the **passage it came from**, so an officer can check it
against the transcript without hunting.

---

## Three kinds of thing, three lifetimes

Which is why these are three tables and not columns hung off `visit_recordings`:

| | what it is | lifetime |
|---|---|---|
| `visit_recordings` | evidence | append-only; no delete, ever |
| `visit_transcripts` | a machine's reading of evidence | one per recording, **regenerable** |
| `visit_summaries` | a document somebody may rely on | **appends**; earlier ones kept |
| `visit_summary_actions` | proposals awaiting a decision | accepted / dismissed, with who and when |

States are the same three words throughout: `queued`, `running`, then `done` or
`failed`.

---

## Configuration

Both features are **off unless a key is set**, and `/api/insights/capabilities`
reports which, so the console can hide a button that could only fail.

```
WAYPOINT_STT_URL        default https://api.openai.com/v1/audio/transcriptions
WAYPOINT_STT_KEY        unset = transcription off
WAYPOINT_STT_MODEL      default whisper-1
WAYPOINT_LLM_URL        default https://api.anthropic.com/v1/messages
WAYPOINT_LLM_KEY        unset = summarising off (falls back to ANTHROPIC_API_KEY)
WAYPOINT_LLM_MODEL      default claude-sonnet-5
WAYPOINT_AI_TIMEOUT_MS  default 300000
```

**Who hears the audio is a URL.** The transcription client speaks the OpenAI
audio API, which Groq and the self-hosted whisper servers also implement, so
pointing it at a machine on the premises is a change of environment variable
rather than a rewrite. For this data that is not a hypothetical nicety — it is
the likely ending.

Both calls live in one small file, `spike/api/northwood/ai.mjs`, precisely
because it is the only place in the system where anything leaves the building.

---

## The thing to decide before this goes anywhere real

Everything above is mechanism. This is the part that isn't a coding question.

**A recording of a supervision conversation is about as sensitive as data gets.**
It contains a person on parole or probation talking about their housing, their
job, their family, their health, and their compliance — often in their own home,
often with relatives audible in the background who never agreed to anything.

Transcription as configured by default sends that audio to a third party. Before
this is used on a real caseload, someone needs answers to:

- **Consent.** Which jurisdictions, and does the subject's consent need to be
  recorded rather than assumed? Does anyone else audible in the room have a say?
- **Where the audio may go.** A hosted API is convenient. A self-hosted Whisper
  instance costs more to run and answers the question completely. The seam is
  built for the second; the default is the first.
- **Retention.** Nothing here expires. Recordings, transcripts and summaries live
  until someone builds a policy, and the deliberate absence of a delete endpoint
  means that policy will need its own considered path rather than a button.
- **Disclosure.** If this ends up in a revocation hearing, is the machine
  transcript discoverable? Is the summary? Both say plainly that they are
  machine-generated, which helps, but does not answer it.
- **Whether the summary should exist at all.** The strongest argument against is
  that a fluent, confident paragraph about someone's liberty is exactly the
  artifact people stop checking. The mitigations here — the banner, the quotes,
  the proposals-not-obligations rule — reduce that. They do not remove it.

---

## What is not built

- **No diarisation.** The transcript does not say who was speaking, so ownership of
  each action is inferred from phrasing. It comes apart where the officer *instructs*
  the subject: the sentence is in the officer's mouth, the work is the subject's. An
  officer can reassign an item on screen and what the model proposed is kept beside
  the correction — but real speaker labels need a different service (AssemblyAI,
  Deepgram, WhisperX), not Whisper.
- **The transcript itself cannot be corrected.** An officer can fix the wording of an
  action item — and what the model wrote is kept beside the correction — but the
  transcript text is not editable. The only remedy there is re-transcribing, which
  will probably mishear the same name again.
- **No redaction.** Everything the microphone caught is in the transcript,
  including anything a bystander said.
- **No retention or expiry policy.** See above.
- **Transcripts and summaries are console-only.** The officer's app shows
  recordings and can play them back while the visit is open, but transcription
  and summarising happen in the Northwood console. After a visit is completed,
  playback is console-only too.
- **Nothing is surfaced to the subject.** They cannot see the transcript, the
  summary, or the action items proposed about them. Whether they should is a real
  question, and the answer is probably not "no".
- **Accepted action items go nowhere yet.** They are marked accepted and sit on
  the summary. Promoting one into a goal, an agenda item for the next visit, or a
  case note is the obvious next step and is not done.
- **No cost controls.** One job at a time is the only throttle. There is no
  budget, no per-officer limit, and no warning before transcribing an hour of
  audio.

---

## Testing

```bash
node spike/api/test-insights.mjs    # 29 assertions, stubbed provider, throwaway database
node spike/api/smoke.mjs            # includes the recording and capability routes
```

`test-insights.mjs` stands a stub provider up on a loopback port and points the
config at it, exercising the real client — the multipart body, the tool-use
envelope, the error shapes — without a key, without a bill, and without any audio
leaving the machine. It runs against a throwaway database in a temp directory and
never touches `spike/data`.

---

## Related

- [`API.md`](API.md) — every endpoint, with the reasoning
- [`CLAUDE.md`](../CLAUDE.md) — the lessons these rules come from
