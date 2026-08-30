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

The webhook is the push; `GET /api/status` is the pull. A system needs both:
the push for timeliness, the pull for reconciling anything missed.

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

### 6. A completed course offered "Resume", and meant it

Rise leaves `exit_mode = "suspend"` on a course the learner **finished**.
Waypoint checked the suspend flag before the completion flag, so a finished
course showed *Resume course*.

The label was the harmless half. Clicking it **resumed the attempt that already
said they passed** — and anything done next would have overwritten that
completion record instead of starting attempt 2. Fixed in the resume decision
and in both clients.

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
node spike/api/smoke.mjs http://<host>:8090   # 86 end-to-end assertions
node spike/api/test-sweeper.mjs               # abandoned sessions are closed
node spike/api/test-insights.mjs              # transcription and summary, stubbed provider
node spike/inspect.mjs spike/corpus           # inspect every package
```

Every bug above has a regression test. The suite covers ingest and rejection,
status derivation, `suspend_data` round-tripping and overflow, both time
formats, attempt semantics, ticket replay and forgery, cross-registration
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
