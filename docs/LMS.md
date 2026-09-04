# The Waypoint LMS

How Waypoint plays SCORM content, what it had to get right to do that, and what
it cost to find out.

Companion to [`API.md`](API.md) (the endpoints), [`BUILD.md`](BUILD.md) (what
exists) and [`DISCOVERY-BRIEF.md`](DISCOVERY-BRIEF.md) (how SCORM works in plain
language).

---

## The short version

A SCORM package is a zip of working web pages that expects to find a JavaScript
object called `API` somewhere above it in the frame hierarchy, and to talk to
that object for the whole of the learner's session. Everything below follows
from that one sentence.

Waypoint unpacks the zip, serves it from an origin the application cannot be
reached from, frames it inside a player that provides the `API` object, and
persists every write immediately. When the learner leaves, the completion goes
to the customer's system server-to-server, signed. The learner's device is
never what reports the result.

It has been proven against a real 11 MB Articulate Rise 360 export: played to
completion, quit and resumed three times, 920 seconds recorded accurately
across four sessions, and the completion delivered and signature-verified.

---

## The three origins

```
:8090   Waypoint          the API, the learner site, the admin console
:8091   Content origin    unpacked packages + the player  ← different origin
:8092   Northwood         the customer's system (the demo stand-in)
```

**Content is served from a different origin than the application, and always
will be.** An uploaded package is third-party code that we execute. Same-origin
means a course's JavaScript can read the logged-in session and act as the user
— Rustici's own commercial engine shipped exactly that bug and it allowed
account takeover.

This is architectural, not hardening to add later. Serving content from the app
origin "temporarily" bakes in URLs and assumptions that are painful to unpick,
and the temporary fix *is* the vulnerability.

### The collision this creates, and how it is resolved

The ADL API discovery algorithm has the course walk `window.parent` looking for
`API`. That walk **only works same-origin** — a cross-origin parent throws.

So the player page lives on the *content* origin, next to the course, and
exposes the `API` object there. The player then talks to the Waypoint API
over CORS, with a token scoped to one registration.

```
  content origin :8091                        app origin :8090
  ┌───────────────────────────────┐
  │ player.html                   │  ──fetch──▶  /api/runtime/:id/set
  │   window.API                  │              (registration-scoped token)
  │   window.API_1484_11          │
  │  ┌─────────────────────────┐  │
  │  │ iframe: the course      │  │
  │  │  walks window.parent ───┼──┘  finds API, same-origin ✓
  │  └─────────────────────────┘
  └───────────────────────────────┘
```

Both `window.API` (SCORM 1.2) and `window.API_1484_11` (2004) are exposed, so a
package finds whichever it was built for.

### What constrains uploaded code

Content responses carry a restrictive CSP and `X-Content-Type-Options: nosniff`.
The player gets its own, tighter policy: it may connect to exactly one other
origin — the Waypoint API — and `frame-ancestors 'none'`, so it can never be
framed by anyone.

Content types are **allowlisted, never sniffed**. A package cannot talk the
browser into executing something by naming a file cleverly.

---

## Launching a course

A launch cannot be spoofed by editing a URL. That was the specific failure in
the system this replaces, where a customer id in a query string was all that
stood between a learner and someone else's record.

```
1. learner clicks Start
2. app asks Waypoint for a launch ticket   (server-to-server, API key)
3. Waypoint mints a ticket: single-use, 60 seconds, bound to ONE registration
4. browser opens the player on the content origin with ?ticket=…
5. player redeems it → gets a session token scoped to that registration alone
6. every runtime write carries that token
```

The ticket is consumed on redemption. Replaying it fails. A token minted for
one registration is useless against another — tested both ways.

| | |
|---|---|
| Launch ticket | 60 seconds, single use |
| Runtime session | 4 hours — a course can sit open all afternoon |
| Idle session sweep | 30 minutes of silence, then the server closes it |

---

## The data model, and the decisions inside it

Waypoint implements the SCORM elements that carry meaning for tracking:

```
completion    cmi.core.lesson_status   cmi.completion_status
success                                cmi.success_status
bookmark      cmi.core.lesson_location cmi.location
resume state  cmi.suspend_data
score         cmi.core.score.raw/min/max        cmi.score.raw/min/max/scaled
time          cmi.core.session_time    cmi.session_time
exit          cmi.core.exit            cmi.exit
```

Four decisions in that list are load-bearing.

### Complete ≠ Passed. Two columns, always.

A learner can finish a course and fail it. SCORM 1.2 blurs this by packing both
into `cmi.core.lesson_status`; 2004 separates them properly.

Waypoint stores `completion_status` and `success_status` as **separate columns
from the first migration**. Writing `passed` does not destroy the fact that the
course was completed, and writing `completed` does not invent a pass.

That separation also matters while a learner is taking an assessment. Some
packages write `completion_status = completed` as soon as the learner reaches
the quiz, before the quiz is submitted and before a result exists. Waypoint
therefore treats `completed + unknown + suspend` as **effectively incomplete**:
the attempt is still in progress and must be resumable. A `passed` or `failed`
result definitively finishes the attempt even if the package leaves `suspend`
behind; without `suspend`, the course's `completed` declaration remains final.

Collapsing these into one "status" is the most expensive schema mistake
available here, and every report built on top inherits it.

### `suspend_data` is opaque — stored, never read

It is the course's private notes about where the learner is. The only job is to
hand back exactly what was given: **byte-for-byte, never parsed, never trimmed,
never re-encoded.**

SCORM 1.2 caps it at 4,096 characters. Articulate courses routinely exceed it,
and when they do, "resume where I left off" silently stops working.

Waypoint **never truncates** — truncating is the bug, and the learner is the one
who discovers it. Instead it stores the whole thing, records the byte length so
overflow is queryable rather than anecdotal, stamps the moment it first
overflowed, warns loudly in the log, and flags it in the admin console.

### Time is normalised on write

SCORM 1.2 uses `HHHH:MM:SS.SS`; 2004 uses ISO 8601 durations. They are
incompatible. Both are converted to **integer seconds at the boundary**, so only
one representation ever reaches the database and no report can mix them.

### Attempts are rows, not overwritten fields

"How many tries did this take" is unanswerable if attempt 2 clobbers attempt 1.
Each attempt is its own row. Accrued time carries forward; completion does not.

The resume decision uses all three signals rather than trusting any one field:

| Stored state | Learner-facing meaning | Next launch |
|---|---|---|
| Incomplete + suspend | Course underway | Resume the same attempt |
| Completed + unknown + suspend | Assessment not yet submitted | Resume the same attempt |
| Completed + unknown, no suspend | Course-declared completion | Retake as a new attempt |
| Completed + passed/failed | Finished | Retake as a new attempt |

The learner-facing **Save & Exit** action is an explicit suspend. The web player
sends `exit_mode: "suspend"` in the same request that closes the runtime session,
so the bookmark and the resume decision cannot be separated by a request race.
Backgrounding or closing the browser uses the same suspend-safe path. A normal
course completion still follows the table above and a later launch is a new
attempt.

Save & Exit also carries the final session duration in its close request. This
prevents the summary from showing `0s` when the separate bookmark/time write is
still in flight as the session closes.

---

## Durability

**Every write is persisted immediately.** Courses do not reliably call `Commit`
— one observed run made five bookmark writes and zero commits in 244 seconds —
so durability cannot be delegated to the content.

**Sessions end without saying goodbye.** A course is supposed to call
`Terminate` when the learner leaves. On a phone that almost never happens: the
app is backgrounded and killed. A background sweeper notices sessions that have
gone silent for 30 minutes and closes them itself, keeping whatever the last
write gave it. Closing a session never alters what the learner did — only
records that it ended.

**The signing secret survives a restart.** It is persisted, owner-readable only.
Regenerating it per boot silently invalidated every session already in flight:
the learner kept clicking, every write was refused, and the `Terminate` that
records their completion never landed. In production a routine deploy would have
done that to everyone mid-course.

---

## Reporting results

The completion goes to the customer's system **server-to-server, HMAC-signed**.
The learner's device is never what reports a pass — that is a data-integrity
rule and a security rule at once.

The customer verifies the signature before trusting a word of it, and the
payload carries their own `subject_id` and `program_id`, so they never have to
store a Waypoint identifier.

Reporting uses the same effective-status rule as the learner experience. A raw
`completed + unknown + suspend` state is reported as incomplete until the
course supplies a pass/fail result, preventing a visit to the quiz page from
being announced to the customer's system as a finished course.

The webhook is the push; `GET /api/status` is the pull. A system needs both:
the push for timeliness, the pull for reconciling anything missed.

---

## Reviewable responses inside a course

The follow-on design for lesson-aware analysis and officer-reviewed completion
summaries is documented in [LMS-AI.MD](LMS-AI.MD).

**Decision record — 2026-09-03.** The Anger Management course introduced a
different kind of LMS data from completion and quiz scores: reflective survey
answers that a subject enters while reading the lesson and that staff need to
review later in the business system.

### The experience is part of the requirement

The response must remain in the course, immediately after the material that
prompted it. Sending the learner out of the course to find a separate form and
then return would break the learning flow and is not an acceptable design.

That does **not** require the response data to be owned by the course. An
inline activity can look and behave like part of the lesson while Waypoint
owns its authentication, structured storage and delivery to the business
system.

### What the first inspection found

The Rise 360 package contains 24 survey blocks with 29 questions: 26 long-text
responses and three linear scales. These are treatment reflections such as
identifying personal anger cues, not merely scored quiz questions.

Waypoint does not currently capture them in a reviewable form:

- A registration belongs to a Waypoint person and therefore joins back to the
  customer's `subject_id`. Completion, success, score, time, bookmark and
  `suspend_data` are correctly stored against that registration.
- `suspend_data` may contain some internal course state, but it is deliberately
  opaque. It exists only so the package can resume. It must never be parsed or
  turned into business data.
- The player accepts any `SetValue` key, but the server maps only the runtime
  fields listed above. A `cmi.interactions.*` write currently produces an empty
  database patch, so even ordinary question detail is not persisted.
- The Northwood Programs screen shows assignment state, completion, score and
  time. It has no response-detail API or view.

Rise quiz lessons can report interaction data such as the question identifier,
learner response, correct response, result and latency. Survey Blocks are a
newer, separate Rise feature. Articulate describes them as beta and says LMS
survey reporting may involve its Connected Packages feature; a standard
package depends on support from the LMS provider. The package's static code
shows normal interaction reporting for multiple choice, multiple response,
fill-in and matching quiz questions, but it does not prove where its
`LONG_RESPONSE` and `LINEAR_SCALE` survey values go.

References:

- [Rise 360: Using Survey Blocks](https://www.articulatesupport.com/article/Rise-360-Using-Survey-Blocks-Beta)
- [Rise 360: Quiz Data Sent to an LMS](https://www.articulatesupport.com/article/Rise-Quiz-Data-Sent-to-an-LMS)

### Two viable data paths

**A. Keep the native Rise Survey Blocks.** First determine whether the package
sends responses through SCORM interactions, a documented Articulate service,
or some other supported channel. If that channel provides exact, subject-level
responses with stable identifiers, Waypoint can ingest it and expose it to
Northwood. This is the least authoring work, but it may create an Articulate
dependency and may provide anonymous or aggregate data rather than a case
record.

**B. Put a Waypoint-owned response activity inline in Rise.** Rise supports
embedded web content in a lesson. A reusable response block could therefore
appear exactly where each Survey Block appears now, save directly to Waypoint,
and tell the course when the required response is complete. The learner would
read, respond, save and continue without leaving the course.

For option B, the activity must not receive an application cookie or a
client-supplied `subject_id`. The player gives it a short-lived token scoped to
one registration and one question. A narrowly validated, origin-checked
`postMessage` bridge performs that handoff. The response endpoint derives the
person and `subject_id` from the registration server-side.

Reference: [Rise 360 embedded web content](https://www.articulatesupport.com/article/Rise-360-Manage-Course-Media).

### Provisional direction

Run the evidence-gathering test before selecting a path. If Rise exposes exact,
stable, subject-level Survey Block responses through a supported channel, use
it. If it does not, use inline Waypoint-owned response activities. Do **not**
decode `suspend_data`, scrape the course DOM, or patch minified Rise internals;
all three are package-specific implementations that will break on republish.

Whichever path is selected, the durable model is structured and auditable:

```text
registration + attempt
question id + question text snapshot + response type
response value + submitted_at + revision
```

The client never asserts who answered. The registration owns that fact. If an
answer is editable, revisions are append-only so an official treatment or case
record cannot be silently rewritten.

Northwood should pull the sensitive detail on demand through an authenticated
server-to-server endpoint. A completion webhook may say that responses are
available and give a count, but should not carry the answers themselves. Its
Programs screen can then offer **Review responses**, grouped by course section
and attempt, with unanswered items visible.

### First test — prove the response channel

Use a private server and throwaway database, never the shared demo database.

1. Create a disposable subject, assign Anger Management and launch attempt 1.
2. Enter unmistakable non-personal values in one long-response survey and one
   linear-scale survey.
3. Capture every SCORM `GetValue`, `SetValue` and commit, plus outbound network
   requests made at submission.
4. Check separately for `cmi.interactions.*`, `cmi.suspend_data`, and calls to
   an Articulate service. Do not infer one from the presence of another.
5. Inspect the throwaway database read-only and verify whether either exact
   value exists, what identifier accompanies it and whether it can be joined
   unambiguously to the disposable subject.
6. Save and exit, resume the same attempt, and confirm whether the course itself
   restores both responses.
7. Record the result before implementing storage. The test must distinguish
   "the learner can resume it," "Waypoint can review it," and "Articulate can
   review it"—those are three different claims.

Before implementation, decide who may review responses, whether they are an
official case record, how long they are retained and whether subjects may edit
an answer after submitting it.

### Diagnostic mode for the response-channel test

Waypoint has an opt-in, program-scoped trace at the SCORM write boundary.
Set `WAYPOINT_SCORM_DIAGNOSTICS` to a comma-separated list of program IDs; the
local demo enables it for `anger-management`. Each trace line contains the
registration, program and SCORM field name. Values are retained only for
`cmi.interactions.<n>.id` and `.type`, which are needed to identify the
reporting channel. Learner responses, correct responses, comments and
`suspend_data` are always replaced with a character count.

This trace is evidence gathering, not response storage. It must not be changed
to print answers, and it should not be enabled broadly in a deployed
environment. After restarting the local server, reproduce one disposable
response and inspect `/tmp/waypoint-demo.log` for `[SCORM diagnostic]` lines.
The presence of a response field proves that Rise uses the interaction
channel; it does not by itself make the response reviewable or durable.

### First live result — inconclusive by itself

On 2026-09-03, Dana resumed Anger Management attempt 1, submitted three native
Rise Survey Block responses, then saved and exited. The program-scoped trace
observed 86 SCORM writes:

| Field | Writes |
|---|---:|
| `cmi.suspend_data` | 79 |
| `cmi.core.lesson_location` | 4 |
| `cmi.core.session_time` | 2 |
| `cmi.core.exit` | 1 |
| `cmi.interactions.*` | **0** |

The course's opaque resume state changed repeatedly and finished at 978
characters. The attempt remained `incomplete`, exited as `suspend`, retained
its bookmark and accrued 60 seconds, so course progress and resume worked.
No `cmi.interactions.*` **writes** were observed. That result does not rule out
the standard SCORM interaction channel, because Waypoint's adapter did not
implement or advertise the interaction collection: in particular,
`cmi.interactions._count` returned an undefined-element error. The trace also
captured only `SetValue`, not `GetValue`, so it could not show whether Rise
queried the collection and then declined to report responses when the LMS said
the collection was unavailable.

Articulate's Survey Blocks guidance distinguishes two LMS export paths:

- A **Connected Package** requires the Labs feature to make responses visible
  in Rise 360 through **View LMS engagement**.
- With a **standard package**, the customer is told to contact the third-party
  LMS provider to access Survey Block data. Waypoint is that provider.

Therefore Connected Packages are not a prerequisite for Waypoint's standard
package path. At this point, implementing the applicable SCORM interaction
data model and tracing both reads and writes was one hypothesis—not yet a
decision—because the article does not identify the exact wire format. Static
inspection of the package resolved that hypothesis in the next section.

The article also notes that LMS exports may associate survey responses with a
user ID. Waypoint must derive that identity from the server-owned registration
and attempt; the course-provided learner ID is never accepted as proof of who
answered.

### Package inspection — the SCORM 1.2 export has no survey reporting hook

Static inspection of the exact Anger Management package explains the zero
interaction writes. When a learner submits a Survey Block, Rise builds a
structured array containing the question id, question title, response type and
response, then conditionally calls:

```js
window.Runtime?.reportUngradedAnswers
  && await window.Runtime.reportUngradedAnswers(answers)
```

The package's standard SCORM runtime never defines or exports
`reportUngradedAnswers`. It exports `reportAnswer` for ordinary quiz answers,
but Survey Blocks deliberately use the separate, missing hook. Optional
chaining makes the missing integration silent: the course shows its submitted
confirmation and updates local resume state, but sends no survey response to
the SCORM adapter. This means adding `cmi.interactions._count` support alone
cannot make this SCORM 1.2 export report Survey Block responses.

Articulate's documented xAPI contract is the next supported path to test. It
defines `cmi.interaction` as a scored **or survey** question and uses the
`answered` verb with a response, registration and learner actor. That matches
Waypoint's need for exact response data tied server-side to a registration.
That decision gate was satisfied by inspecting the xAPI export of this same
course. Do not patch the generated SCORM package or inject a package-specific
hook from the player; either would silently break when the course is
republished.

### xAPI export inspection — supported path confirmed

The Anger Management xAPI export received on 2026-09-03 passes that decision
gate. Its generated runtime defines and exports `reportUngradedAnswers`, then
maps every Survey Block response to an xAPI interaction recorder:

| Survey Block response | xAPI interaction |
|---|---|
| Short or long response | fill-in |
| Rating | likert |
| Linear scale | numeric |
| Multiple choice or response | choice |

The recorder carries the stable survey and question ids, question title,
response, neutral result and latency. The package also contains `tincan.xml`
with the course activity id and launch file. At launch, Waypoint must supply a
registration-scoped xAPI endpoint, authorization credential and learner actor.
The endpoint—not the actor sent by the browser—owns the registration identity.

The minimal supported implementation therefore needs two durable stores:

1. Append-only xAPI statements, stored once by statement id and owned by the
   server-authenticated registration. Survey review is derived from `answered`
   interaction statements rather than copied into a second response store.
2. xAPI state documents, keyed by registration, activity and state id, so the
   course can save and resume its progress.

The existing registration remains the source of completion, success and total
time. Those values are derived from accepted course statements at the xAPI
boundary; the browser cannot assert ownership by changing its actor or
registration fields.

### Implemented xAPI path

Waypoint now ingests either a SCORM package with `imsmanifest.xml` or an xAPI
package with `tincan.xml`. An xAPI launch receives a registration-scoped
endpoint and credential plus a server-derived actor, opaque registration UUID,
and course activity ID. The endpoint accepts Articulate's direct xAPI requests
and its older form/method-tunnel request shape.

`answered` statements are stored append-only and idempotently by statement ID.
Their actor and registration are replaced at the boundary with the values from
the authenticated Waypoint registration, so changing browser-supplied identity
cannot file an answer against somebody else. Completion, pass/fail, score and
duration statements update the same registration model already used by SCORM.

Course state is stored separately by registration, activity and state ID. It
may be replaced or removed as the course's bookmark changes; doing so never
alters the immutable answer statements.

Northwood exposes **Review responses** for a started xAPI enrollment on the
subject's Programs screen. It calls Waypoint over the existing server-to-server
API-key boundary and shows the section, lesson, question, response and
submission time in the existing read-only modal. A long response is kept whole
up to Rise's 5,000-character limit; the PDF writer wraps it over as many pages
as needed rather than truncating it. **Export PDF** creates a snapshot filed
against the subject's documents, with the course/attempt header and the same
section/lesson/question/response fields. The browser never receives the
Waypoint API key, and SCORM enrollments keep their existing appearance and
behavior.

For Rise exports, the xAPI question object identifies the survey block and
question, while the lesson hierarchy is carried in the package's encoded
`runtime-data.js`. Waypoint resolves that immutable package metadata by the
block/question IDs, so a response such as the Anger Myths survey is reported as
**Section: Overview of Anger Management** and **Lesson: Myths About Anger**—not
as the overall course title or an internal grouping URI. If a future exporter
does not include that hierarchy, the response remains reviewable with the
available fields rather than inventing a section or lesson.

### Package compatibility boundary

Waypoint supports both SCORM and xAPI as standards, but the guarantees differ:

- **SCORM:** completion, success, scores, bookmarks, suspend data and time use
  the existing SCORM runtime adapter. The original Anger Management SCORM 1.2
  export does not expose Rise Survey Blocks through that adapter, so its survey
  answers are not available through the SCORM path.
- **xAPI:** any conformant package that sends an `answered` statement with its
  response in `result.response` and question metadata in the activity
  definition can use the same statement/state endpoints without custom code.

Rise packages are additionally understood through their encoded
`runtime-data.js`, which maps the survey block ID to the correct lesson and
section. That mapping is reusable across Rise exports; it is not a hard-coded
map of individual questions.

Other authoring tools may organize section and lesson metadata differently. In
that case the response itself still works and remains tied to the authenticated
registration, but section/lesson labels may be unavailable until a small
metadata adapter is added. A new package should therefore be tested once for
standard xAPI statements and its hierarchy metadata before being treated as
fully labeled. Do not customize every package by default, and do not patch a
generated package's minified JavaScript.

---

## Ingesting a package

Uploaded zips are treated as hostile input, because they are third-party code.

| Check | Limit |
|---|---|
| Zip-slip — entries escaping the extraction root | rejected outright |
| Entry count | 10,000 |
| Uncompressed size | 2 GB |
| Compression ratio | 100:1 — a zip bomb |
| Server-executable extensions (`.php`, `.jsp`, `.asp`…) | rejected |
| Manifest parsing | regex-based, so immune to XXE by construction |

**Content versions are immutable once referenced.** If an updated course is
uploaded while people are mid-progress, those people keep seeing the version
they started. Re-uploading creates version N+1; it never overwrites.

Deliberately out of scope for the PoC: multi-SCO packages and SCORM 2004
sequencing. Both are rejected at ingest with a clear reason rather than
half-supported.

---

## What it took to actually play real content

Getting *one* course to play is a week. Getting *everyone's* courses to play is
the job.

For most of this project the corpus was Rustici's own reference samples —
genuine SCORM packages, but written by the people who wrote the spec:
hand-authored, minimal, well-behaved. `RuntimeBasicCalls_SCORM12` is 352 KB
across 49 files and touches seven data-model elements. It never writes
`suspend_data` at all.

Then we published a real course from Articulate Rise 360 and ran it through the
same stack.

```
                        Rustici "Golf"        Rise 360 export
size                    352 KB                11 MB
files                   49                    124
suspend_data            never written         3,451 chars (84% of the cap)
session_time            written once, at end  rewritten continuously
fonts                   none                  TrueType
writes after Terminate  none                  yes
```

**It found seven bugs in one sitting.** None of them were findable with the
reference samples, because every one depended on behaviour Rustici's packages
do not exhibit.

### 1. `session_time` was summed instead of replaced

`cmi.core.session_time` is the elapsed time of the *current session*, rewritten
as it grows. It is **not a delta**. Waypoint added every write to a running
total, so a course that commits periodically summed a growing series.

**Ten minutes of work was recorded as 155 minutes**, and climbing.

Golf hid this completely by writing the value once, at `LMSFinish`. Fixed:
the session clock is its own column, replaced on each write; the total accrues
only when the session closes, which is the moment SCORM says it does.

### 2. Writes were accepted after `Terminate`

SCORM makes the API unusable after `LMSFinish`. Rise calls it anyway — it sent
a `session_time` of 200 seconds *after* termination had already accrued 180.
Those seconds sat waiting to be counted a second time on the next exit.

Fixed: post-termination writes are refused, as the spec requires. Redeeming a
suspended registration reopens the session and zeroes the session clock.

### 3. `.ttf` was missing from the MIME allowlist

Rise ships a TrueType font. It would have been served as
`application/octet-stream`, ignored by the browser, and the course would have
rendered in fallback fonts **with nothing in any log to say why**.

Golf ships no fonts. Fixed, along with captions (`.vtt`) and modern media
(`.webm`, `.webp`, `.m4a`) — the things real authoring tools emit.

### 4. A resume was announced as a fresh start

`cmi.core.entry` tells the course whether to expect its own state back.
Waypoint said **`ab-initio`** — *"this learner has never been here"* — while
simultaneously handing over 1,835 bytes of `suspend_data`. Two contradictory
statements in one payload.

Rise tolerated it and resumed off the bookmark. **A stricter course reads
`ab-initio`, concludes the learner is new, and discards the state** — a total,
silent loss of resume for that package. Fixed: a suspended registration is
announced as `resume`.

### 5. Overflow detection existed but was never called

`suspendCap()` was written, documented, and **wired to nothing**. The byte
length was recorded — so it was queryable — but nothing detected the overflow,
nothing logged, nothing surfaced. A third of the job, believed to be all of it.

Fixed and tested: stored in full, stamped, logged loudly, flagged in the
console.

### 6. `completed` and `suspend` can both be true

Rise leaves `exit_mode = "suspend"` on a course the learner **finished**.
Waypoint checked the suspend flag before the completion flag, so a finished
course showed *Resume course*.

The label was the harmless half. Clicking it **resumed the attempt that already
said they passed** — and anything done next would have overwritten that
completion record instead of starting attempt 2.

A later run with Rustici's Golf course exposed the opposite edge case. Golf
writes `completion_status = completed` when the learner reaches its final page,
which is the quiz, before the quiz has been submitted. Saving and exiting there
leaves `success_status = unknown` and `exit_mode = suspend`. Treating every
`completed` value as final made that unfinished attempt appear complete and
offered *Retake course* instead of *Resume course*.

Fixed in the API and mobile client: `completed + unknown + suspend` resumes the
same attempt, while `completed + passed/failed` remains finished even if the
package also left `suspend` behind. The mobile app now shows *In progress* and
*Resume course* for the pending-quiz state, preserving the learner's bookmark
and original attempt.

### 7. The player lied about failures

Three separate honesty bugs, all found by looking at one screenshot:

- A refused post-termination write was counted as a failed save, so the player
  showed *"your recent progress isn't saved"* directly above *"Progress saved"*.
  One of them was wrong and the learner had no way to know which.
- *"You can close this window"* was a dead end dressed as a button.
- An expired session was reported as *"we can't reach the server — we'll keep
  trying"*, which was false: retrying could never succeed.

All three now distinguish what actually happened and give the learner somewhere
to go.

---

## What the Rise package proved

Against the PoC's success criteria, with real authoring-tool content:

| | |
|---|---|
| Plays start to finish in the web app | ✅ |
| Quit halfway and resume where you left off | ✅ three times |
| Completion, pass/fail and time recorded accurately | ✅ 920s across four sessions |
| Results reach the customer's system server-to-server | ✅ signature verified |
| Launch cannot be spoofed | ✅ |
| Plays in the mobile app, in a WebView | ⏳ **not yet tested with Rise** |

The final numbers from that run:

```
completion    completed
success       passed
time          920s  (15m 20s — matched the learner's screen exactly)
attempt       1
suspend_data  3,451 chars — stored byte-for-byte, 84% of the 1.2 cap
webhook       delivered to Northwood, signature verified
```

---

## Testing

```bash
node spike/api/smoke.mjs http://<host>:8090   # 393 end-to-end assertions
node spike/api/test-sweeper.mjs               # abandoned sessions are closed
node spike/api/test-insights.mjs              # transcription and summary, stubbed provider
node spike/inspect.mjs spike/corpus           # inspect every package
```

Every bug above has a regression test. The suite covers ingest and rejection,
status derivation, `suspend_data` round-tripping and overflow, both time
formats, pending-assessment resume and completed-attempt retake semantics,
ticket replay and forgery, cross-registration
writes, learner authorisation, session survival across restart, and webhook
delivery.

**The corpus is the fixture that matters.** Nine packages: eight Rustici
reference samples and one real Rise 360 export. The Rise one found seven bugs
the other eight could not. Every real course file added to it is worth more
than any amount of up-front design — and every bug found in a real package
becomes a permanent fixture.

---

## Known limits

- **Multi-SCO packages are rejected**, not half-supported. So is SCORM 2004
  sequencing and rollup.
- **Link-out content can only ever track "they opened it"** — no score, no
  completion, no resume. That is inherent to the type, not a gap to fix.
- **The content origin is a different port, not a different host.** Cookies
  ignore ports, so port separation does not isolate them the way a separate
  hostname would. Production needs `content.example.com`.
- **A nine-section Rise course reaches 84% of the SCORM 1.2 `suspend_data`
  cap.** A longer one will exceed it. The detection is wired and tested, but no
  package has yet tripped it in anger.
- **One real authoring tool tested.** Storyline 360, Captivate and Lectora are
  different engines and will behave differently. On this evidence, each will
  find its own bugs.
