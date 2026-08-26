# Waypoint LMS — proof of concept

**Built 2026-08-21 → 2026-08-25.** A working SCORM delivery platform: courses play inside
our own web and mobile apps, progress is tracked server-side, and results are reported
back to the business system — with no third-party LMS involved.

This document is the complete record of what exists, how to run it, and what it does and
does not prove.

| | |
|---|---|
| **Run the demo** | [Running it](#running-it) · [Demo script](#the-demo-script) |
| **Understand it** | [Architecture](#architecture) · [Data model](#data-model) · [Security](#security-model) |
| **Judge it** | [What's proven](#whats-proven) · [Limitations](#limitations-be-honest-about-these) · [Findings](#what-we-learned-about-scorm) |
| **Companion docs** | [`DISCOVERY-BRIEF.md`](DISCOVERY-BRIEF.md) · [`REQUIREMENTS.md`](REQUIREMENTS.md) · [`../CLAUDE.md`](../CLAUDE.md) · [`session/TRANSCRIPT.md`](session/TRANSCRIPT.md) |

---

## The problem this solves

The business system assigns programs to customers. Today, taking one means leaving our
apps for a third-party LMS. That is the thing being replaced.

**What the PoC set out to prove:** that we can play, track and report on SCORM content
inside our own web and mobile apps, securely, without a third-party LMS.

---

## Running it

Everything is driven by one script. From the repo root:

```bash
cd /Users/ericjacky/Documents/GitHub/WaypointLMS
```

| Command | What it does |
|---|---|
| `./spike/demo start` | Start the three servers. Seeds content if the database is empty. |
| `./spike/demo mobile` | Open the app in the iOS simulator. Starts Metro if needed. Non-blocking; safe to re-run. |
| `./spike/demo reset` | **Wipe everything and re-seed.** Run this before a demo. |
| `./spike/demo status` | What is running, the URLs, and current record counts. |
| `./spike/demo stop` | Stop the servers and Metro. |

**Before demoing, run `./spike/demo reset`.** It clears every learner, registration and
completion, restarts, re-ingests the course, and prints the URLs.

### URLs

| Surface | URL | What it is |
|---|---|---|
| **Mock SaaS** | `http://<host>:8092` | Stands in for the business system. Assigns programs, receives results. |
| **Learner site** | `http://<host>:8090/learn` | Where a customer signs in and takes their course. |
| **Admin console** | `http://<host>:8090/console` | Waypoint's own view: every record, every delivery. |
| Content origin | `http://<host>:8091` | Serves the player and course files. Not browsed directly. |

`<host>` is your machine's LAN IP, detected automatically and printed by the script.
`localhost` also works from this machine.

### Notes

- The database lives at **`spike/data`** — not `spike/api/data`.
- Metro runs on **8082**, avoiding a conflict with the `pp-VetteCruise2027` project on 8081.
- The demo script rewrites `spike/mobile/config.js` with your current LAN IP each run, so
  the app keeps working when your network changes. A device cannot reach `localhost`.
- Server logs: `/tmp/waypoint-demo.log`. Metro logs: `/tmp/waypoint-metro.log`.
- If a port is stuck: `pgrep -f server.mjs | xargs kill -9`.

---

## The demo script

**1. The business system** — `http://<host>:8092`

"Northwood Corrections — Case Management", deliberately teal so it is obvious which system
is on screen.

It opens on the **subject roster**. Pick **Dana Whitfield** or **Marcus Oyelaran** to open
their **Subject Profile** — photo, demographics, supervision details. From there, click
**Programs**.

The Programs page is scoped to that subject: assign one, see their status, see completions
received. Its program list is pulled live from Waypoint's API. Click **Assign & create
login** and it returns credentials, shown once, as a real system would.

**2. The learner** — `http://<host>:8090/learn`, or the mobile app

Sign in with those credentials. The learner sees only what they were assigned. Start the
course, work through it, take the Knowledge Check.

Mid-course, **Save & Exit** suspends properly — sign back in and it resumes where they
left off.

**3. Back to the business system**

Two panels tell the story:

- **Assigned programs** moves *Not started → In progress → Completed · Passed*, polled
  live from Waypoint
- **Completions pushed from Waypoint** shows the signed webhook arriving, with its full
  payload

**What makes it real rather than a mock-up:** the SaaS holds the API key server-side and
the browser never sees it; a learner can only launch what they were actually assigned;
launch tickets are single-use and expire in 60 seconds; and the completion travels
server-to-server, HMAC-signed with a timestamp. The learner's browser is never trusted to
report a pass.

---

## Architecture

Three origins, three surfaces, one deliberate separation.

```
┌──────────────────────┐        API key (server-side)        ┌──────────────────────┐
│   MOCK SaaS  :8092   │ ──────────────────────────────────▶ │   WAYPOINT   :8090   │
│  (their system)      │                                     │   API + learner site │
│                      │ ◀────────────────────────────────── │   + admin console    │
└──────────────────────┘   signed webhook on completion      └──────────┬───────────┘
                                                                        │ launch ticket
                                                                        │ (60s, single use)
        ┌───────────────────────────────────────────────────────────────┘
        ▼
┌────────────────────────────────────────┐
│        CONTENT ORIGIN   :8091          │   ← separate origin, deliberately
│  ┌──────────────────────────────────┐  │
│  │  player  (SCORM API adapter)     │  │   talks to :8090 over CORS
│  │   ┌────────────────────────────┐ │  │
│  │   │  the course  (3rd-party)   │ │  │   finds the adapter via window.parent
│  │   └────────────────────────────┘ │  │
│  └──────────────────────────────────┘  │
└────────────────────────────────────────┘
        ▲
        │ WebView
┌───────┴──────────────┐
│  REACT NATIVE APP    │   native chrome, exit, lifecycle
└──────────────────────┘
```

### Why the content origin is separate

A SCORM package is a zip of working web pages and JavaScript that we unpack and **execute**.
If it were served from the application's origin, an uploaded course's scripts could read
the logged-in session and act as that user. Rustici's commercial engine shipped exactly
this bug and it allowed account takeover.

This forces a structural decision that is easy to get wrong:

> **The SCORM API adapter cannot live on the app origin.** The ADL discovery algorithm
> walks `window.parent` looking for it, which only works same-origin. So the player page —
> which hosts the adapter — sits on the **content** origin next to the course, and talks
> back to the app API over a narrowly-scoped CORS policy.

Course JavaScript can reach the adapter, by design. It can never reach the application's
session, also by design.

---

## Data model

Six tables, plus credentials and two demo-support tables. SQLite via `node:sqlite`, no
dependencies. All access goes through `db.mjs` — nothing else opens the database or writes
SQL, which is what makes a later change (adding tenancy, auditing, caching) a one-file
edit rather than an archaeology project.

| Table | Holds |
|---|---|
| `people` | `subject_id` (the business system's identifier), name, email |
| `credentials` | Login rows — `kind`, `identifier`, scrypt hash. **Rows, not columns**, so SSO is an insert later |
| `programs` | The assignable unit |
| `content_versions` | An ingested package. **Immutable once referenced** |
| `assignments` | Who was assigned what |
| `registrations` | **The core record** — everything else exists to produce rows here |
| `launch_tickets` | Short-lived, single-use, bound to one registration |
| `webhook_deliveries` | Every delivery attempt, successful or not |
| `saas_inbox` | The mock SaaS's own record of what it received |

### The registration, field by field

```
person_id · content_version_id · attempt

completion_status      not attempted | incomplete | completed
success_status         unknown | passed | failed
score_raw/min/max/scaled
location               the bookmark
suspend_data           opaque, byte-for-byte
suspend_data_len       so overflow is queryable, not anecdotal
total_seconds          integer, normalized at the boundary
entry                  ab-initio | resume
exit_mode              '' | suspend | logout
started_at · last_write_at · terminated_at · completed_at
```

### Three rules that are cheap now and brutal to retrofit

**1. Complete ≠ Passed — two columns, always.**

SCORM 2004 separates them. SCORM 1.2 crams both into `cmi.core.lesson_status`, so a course
that writes `completed` and then `passed` **destroys the first fact.** We watched this
happen 31 seconds apart in a real run. Had the learner scored 60, the final value would be
`failed` and there would be no record they finished at all.

The fix is a mapping where each write updates **only the column it carries news about**:

| `lesson_status` written | → `completion_status` | → `success_status` |
|---|---|---|
| `passed` | `completed` | `passed` |
| `failed` | `completed` | `failed` |
| `completed` | `completed` | *(unchanged)* |
| `incomplete` | `incomplete` | *(unchanged)* |
| `browsed` | `incomplete` | *(unchanged)* |
| `not attempted` | `not attempted` | *(unchanged)* |

Leaving success untouched on a completion-only write is the whole trick.
Implemented in `spike/api/scorm.mjs` as `applyStatus()`.

**2. `suspend_data` is opaque.** Stored byte-for-byte, never parsed. Its length is stored
too, because SCORM 1.2 caps it at 4,096 characters and overflow silently breaks resume.

**3. Time is normalized on write.** SCORM 1.2 (`HHHH:MM:SS.SS`) and 2004 (ISO 8601) are
incompatible. Only integer seconds reach the database.

---

## Security model

**Four credential types, deliberately distinct.** Conflating them is how you end up with
one credential that can do everything.

| Caller | Credential | Grants | Cannot |
|---|---|---|---|
| Business system → Waypoint | **API key** | provision users, assign, ingest, read status | — |
| Learner → Waypoint | **person session** (12h) | their own list, their own launch tickets | write to any registration |
| Player → Waypoint | **registration session** (4h) | the runtime for **one** registration | touch any other record |
| Waypoint → business system | **HMAC signature + timestamp** | outbound delivery | be replayed |

### Launch tickets

The behavior being replaced passes a customer ID in a URL — anyone can edit the number and
become someone else. Instead:

1. The business system requests a ticket **server-to-server** with its API key
2. The ticket is bound to one learner and one content version, expires in **60 seconds**,
   and is **single-use**
3. Redeeming it consumes it and mints a registration-scoped session

Replaying a spent ticket, forging one, or using a session against a different registration
are all refused — with tests for each.

### Package ingest

Every check runs **before** anything is written to disk:

- **zip-slip** — any entry escaping the extraction root is rejected
- **zip bombs** — caps on entry count, uncompressed size, compression ratio
- **XXE** — manifest reading is regex-based, immune by construction *(production needs a
  real parser with DTDs and external entities disabled)*
- **executables** — server-side script extensions rejected
- Content is served with `X-Content-Type-Options: nosniff` and an allowlisted content type

### Other properties worth knowing

- Passwords are **scrypt**-hashed with per-credential salts. The hash is never returned,
  even to a trusted caller.
- Login returns an **identical response** for wrong-password and unknown-account, so the
  endpoint cannot enumerate who has an account.
- A learner can only launch a program **actually assigned to them**.
- Completions are **never** reported by the learner's device.

---

## The surfaces

### Learner site — `:8090/learn`

Sign in, see assigned programs with live status, launch. Session held in `sessionStorage`,
so a refresh doesn't sign you out.

### Player — `:8091/player?ticket=…`

The SCORM host. Provides everything the course cannot be trusted with:

- **A working exit**, outside the frame — including when the course is blank, broken or hung
- **A live save indicator** — *Saving / Saved / N unsaved* — and a red banner if writes fail.
  A failed write must never look like a success
- **A results screen** after `Terminate`, because SCORM makes removing the content the
  LMS's job and a finished course otherwise just sits there
- Light and dark, responsive

**On mobile it hides its own chrome entirely** and lets the native shell provide it —
because on iOS an iframe expands to its content, and a legacy fixed-width course widens the
whole layout viewport. No CSS fix survives that; the chrome has to be native.

### Mobile app — `spike/mobile`

Expo + React Native. Sign in, see programs, take the course in a `WebView`.

- **Native header and Save & Exit**, outside the frame
- **`AppState` flush on backgrounding** — iOS kills backgrounded apps without warning and
  `Terminate` usually never arrives
- **Android hardware back** routed to the exit flow, never a raw unmount
- **WebView locked down**: no shared cookies, no filesystem access, navigation confined to
  the content origin
- **Native results screen**

### Admin console — `:8090/console`

Every registration with both status columns, score, time, attempts and `suspend_data`
length (flagged red over the cap). Every webhook delivery with its payload. The integration
credentials.

### Mock SaaS — `:8092`

Stands in for the business system. Pulls the catalog, provisions learners, assigns,
receives completions. **Holds the API key server-side** — that is why it is a server and
not just a page.

Shows both integration directions, which real systems need:
- **Assigned programs** — *pull*, polled live. Catches everything before a completion
- **Completions pushed** — *push*, the signed webhook. Timely

---

## API reference

Base: `http://<host>:8090`

### Business system → Waypoint  *(API key)*

```
GET  /api/content                      the catalog
GET  /api/status                       live state of every assignment
POST /api/users                        { subject_id, name?, email?, password? }
POST /api/assign                       { subject_id, program_id }
POST /api/launch                       { subject_id, program_id } → ticket
POST /api/ingest                       { zip, program_id?, title? }
```

### Learner  *(person session)*

```
POST /api/auth/login                   { identifier, password } → token
GET  /api/me                           profile
GET  /api/me/assignments               their programs, with status
POST /api/me/launch                    { program_id } → launch_url
```

### Runtime  *(registration session)*

```
POST /api/runtime/redeem               { token } → registration + session
POST /api/runtime/:id/set              { key, value }   persisted immediately
POST /api/runtime/:id/terminate
```

### Waypoint → business system  *(HMAC signed)*

```
POST <their endpoint>
X-Waypoint-Timestamp: <ms>
X-Waypoint-Signature: v1=<hmac-sha256 of "timestamp.body">

{ subject_id, program_id, registration_id, attempt,
  completion_status, success_status,
  score: { raw, min, max },
  total_seconds, total_time_scorm, completed_at }
```

`spike/api/auth.mjs` exports **`verifyWebhook()`** — the exact check the receiving side
implements, so the integration can point at working code rather than prose.

---

## File map

```
spike/
  demo                    ← start / stop / reset / mobile / status
  harness.html            standalone fake LMS for inspecting a package's behavior
  inspect.mjs             package inspector — safety, manifest, version, runtime detection
  corpus/                 test packages (gitignored)
  data/                   the database and unpacked content (gitignored)

  api/
    server.mjs            three listeners: app :8090, content :8091, mock SaaS :8092
    db.mjs                every query in the system
    auth.mjs              four credential types, password hashing, webhook signing
    ingest.mjs            zip validation, manifest parsing, immutable versioning
    scorm.mjs             status derivation, time normalization
    smoke.mjs             41 end-to-end tests
    player.html           the SCORM host
    learner.html          learner site
    console.html          admin console
    saas.html             mock business system

  mobile/
    App.js                sign-in, program list, WebView player, native results
    config.js             API base — rewritten by ./spike/demo

docs/
  BUILD.md                this document
  DISCOVERY-BRIEF.md      how SCORM works, the three hard parts, glossary
  REQUIREMENTS.md         PoC scope, success criteria, findings
  session/TRANSCRIPT.md   the full build session, readable
  session/transcript-raw.jsonl   every tool call, complete record
CLAUDE.md                 engineering lessons and pitfalls
```

### Tests

```bash
node spike/api/smoke.mjs http://<host>:8090     # 41 assertions
node spike/inspect.mjs spike/corpus             # inspect every package
```

The suite covers ingest and rejection, the two-column derivation, `suspend_data`
round-tripping and overflow, time normalization, attempt semantics, ticket replay and
forgery, cross-registration writes, learner authorization, session-type confusion, and
webhook delivery.

---

## What's proven

Six of the seven success criteria from [`REQUIREMENTS.md`](REQUIREMENTS.md):

| | |
|---|---|
| 1 · plays in web | ✅ |
| 2 · plays in the mobile app, not a browser hand-off | ✅ |
| 3 · resume where they left off | ✅ |
| 4 · completion, pass/fail and score recorded accurately | ✅ |
| 5 · results reach the business system, server-to-server | ✅ |
| 6 · launch cannot be spoofed | ✅ |
| 7 · **measured pass rate across a diverse corpus** | 🟡 **the one outstanding** |

Verified in a real run: four attempts by one learner, scores 93 / 87 / 100 / 100, time
accumulating 105 → 352 → 396 → 442 seconds, every webhook payload matching its stored
record exactly.

---

## Limitations — be honest about these

**The corpus is Rustici's own reference samples.** They never use `suspend_data`, never
report interactions, and never misbehave. Real authoring-tool output — a Rise or Storyline
export — is where `suspend_data` grows past 4,096 characters and where the interesting
failures live. **This is the single most valuable next step**, and until it is done, "we
can handle any SCORM file" is not a claim the PoC supports.

**Deliberate PoC scoping, not oversights:**

- Single-tenant. Multi-tenancy was cut as unnecessary complexity for a PoC
- SQLite, not Postgres
- No upload UI — content is ingested by API call
- No admin UI for managing users, programs or assignments
- Multi-SCO packages and SCORM 2004 sequencing detected and reported as unsupported
- Offline is out of scope by decision; learners must be connected
- The `/demo` route lets a browser mint its own launch ticket. **Delete it before anything
  ships** — it is exactly what launch tickets exist to prevent

**Known gaps:**

- **The UI layer has no automated coverage.** All 41 tests exercise the API. Every UI bug
  found during the build was found by clicking, not by the suite
- Webhook retry is recorded but not yet automatic
- No rate limiting, no account lockout
- Passwords have no reset flow

**If this succeeds, plan to rewrite rather than evolve it.** That was decided at the
outset, and it is what kept it cheap.

---

## What we learned about SCORM

Every one of these came from watching real content misbehave. They are recorded in
[`REQUIREMENTS.md`](REQUIREMENTS.md) and the engineering lessons in
[`../CLAUDE.md`](../CLAUDE.md).

**The course is an unreliable narrator.** This is the single organizing insight:

- **Courses do not commit.** Five bookmarks and **zero** `LMSCommit` calls in 244 seconds.
  A dropped connection would have lost everything. → *Persist on every write*
- **Courses overwrite their own completion.** `completed` clobbered by `passed`. → *Two
  columns*
- **Courses rarely report per-question detail.** One sample displayed all 15 questions on
  screen and sent only a score. → *"Which questions do people get wrong" cannot be promised*
- **`session_time` is a claim, not a measurement**, computed by the course from its own
  clock — and it is wall-clock, not engagement
- **Courses handle LMS failure badly**, including Rustici's own reference sample: with the
  API unreachable it prompts to resume, runs `parseInt(undefined)`, and navigates to a 404
- **Courses keep rendering after `Terminate`.** Removing the content is the LMS's job

**Format traps:**

- SCORM 1.2 writes `adlcp:scormtype`, 2004 writes `adlcp:scormType` — same attribute,
  different case
- Fractional seconds are **optional** in 1.2 timespans and get omitted. A parser requiring
  `.SS` records zero duration for every such course
- A valid package can contain **nothing trackable** — all assets, no SCO
- Launch hrefs can carry query strings

**Platform traps:**

- `originWhitelist` in `react-native-webview` matches the **origin only**. A path glob makes
  every URL fail, and the library then silently opens it in the system browser
- On iOS an **iframe expands to its content** rather than scrolling, widening the layout
  viewport — after which `100vw`, `max-width` and `position:fixed` all resolve against the
  wrong number. Chrome must be native
- `Authorization` is not CORS-safelisted and must be named in `Access-Control-Allow-Headers`
- **Exactly one layer owns the chrome for a surface.** This bit three times

---

## Where it came from

The full build session is preserved:

- [`session/TRANSCRIPT.md`](session/TRANSCRIPT.md) — readable narrative, 83 exchanges
- `session/transcript-raw.jsonl` — the complete record including every tool call

Worth knowing: the SCORM runtime — the part everyone assumes is hardest — took an
afternoon in about 250 lines of throwaway JavaScript, with no library. The discovery brief
predicted roughly a week. That is a real signal for the build-vs-buy question: if
`scorm-again` (MIT, free) turns out to be insufficient and Rustici is worth buying, it will
be for the long tail of badly-behaved content, **not for the protocol**.
