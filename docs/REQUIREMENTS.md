# Waypoint — proof of concept scope

**Status:** 2026-08-25. Supersedes an earlier draft that assumed a multi-tenant platform
sold to third parties. That is not what is being built.

Companion docs: [`DISCOVERY-BRIEF.md`](DISCOVERY-BRIEF.md) (how SCORM works) and
[`../CLAUDE.md`](../CLAUDE.md) (engineering lessons and pitfalls).

---

## The problem

We own the whole stack: the SaaS application that manages people and assigns them
programs, the web app, and the React Native mobile app.

**Today, taking a program means leaving our apps for a third-party LMS.** That is the
thing being replaced.

## What the PoC must prove

> **That we can play, track and report on *any* SCORM package — bought or authored —
> inside our own web and mobile apps, without a third-party LMS.**

The emphasis is on **any**. We have no content library today, so the PoC is not
validating our own courses; it is validating that the approach survives contact with
whatever we later buy or build.

### The decision this actually informs

Universality is precisely what the commercial engine sells. So the PoC's real output is a
number:

> **What percentage of a deliberately diverse corpus plays and tracks correctly using the
> free library — and what specifically fails?**

- **High pass rate, failures understood** → build on [`scorm-again`](https://github.com/jcputney/scorm-again) (MIT, free)
- **Low pass rate, or failures we can't diagnose** → get a Rustici Engine quote, with
  evidence in hand rather than a hunch

Either outcome is a success. The PoC is worth running *because* it settles this cheaply.

### ⚠️ "Any" needs an honest bar

No LMS plays every SCORM file. There are non-conformant packages in the wild that Rustici
won't play either. Setting an impossible bar means the PoC can't be passed.

**The realistic bar:** **single-SCO** packages from mainstream authoring tools, SCORM 1.2
or 2004, plus conformant hand-built packages. Anything failing outside that — multi-SCO,
sequencing-dependent, non-conformant — is recorded as a known limitation with its cause
diagnosed, not counted as a failure.

### Success criteria

1. A course plays start to finish in the **web app**
2. The same course plays start to finish in the **mobile app**, in a WebView — not a
   browser hand-off
3. A learner can quit halfway, return, and **resume where they left off**
4. Completion, pass/fail and score are recorded **accurately**
5. Those results reach the **SaaS**, server-to-server
6. The launch **cannot be spoofed** by editing a URL
7. **A measured pass rate across the corpus**, with every failure diagnosed and written
   down

---

## The flow

```
SaaS  ──  assigns program_id to subject_id  ──▶  Waypoint
                                                 creates/finds person + registration

learner opens our web app or mobile app
   │
   ├─ app asks Waypoint for a launch ticket   (server-to-server, short-lived, single-use)
   ├─ player opens on the content domain, redeems the ticket
   ├─ course runs; runtime records status, score, bookmark, suspend_data
   │
   └─ on completion ──▶ Waypoint ──▶ SaaS   (server-to-server webhook)
                                      subject_id + program_id + status, score, dates
```

**`subject_id` + `program_id` is the integration contract.** The SaaS owns the person and
the assignment. Waypoint owns delivery and the record of what happened.

---

## In scope

1. **Ingest** SCORM packages. Manual/CLI is fine — no upload UI
2. **Serve** package content from a separate content domain
3. **Runtime for SCORM 1.2 — the priority.** Most common in the wild, and the format we
   would choose ourselves for anything authored in-house
4. **SCORM 2004 runtime — kept, because it is free.** `scorm-again` implements 1.2, 2004
   2nd–4th edition and AICC out of the box. Deliberately excluding it would cost effort
   rather than save it. **Single-SCO 2004 packages only**
5. **Launch tickets** — short-lived, single-use, scoped to one person and one program
6. **Web player** — plays inside the web app
7. **Mobile player** — plays inside the RN app's WebView
8. **Resume** — bookmark and `suspend_data` round-trip correctly
9. **Completion webhook** back to the SaaS
10. **The corpus run** — the actual deliverable

## Measured, not built

**Detect and record** what a package needs, rather than implementing it. If the corpus
shows real packages depending on these, that is a finding — and a strong argument for the
commercial engine.

- **Multi-SCO packages and rollup** — cut from the PoC *(decided 2026-08-25)*. Real
  implementation work, and single-SCO is the overwhelming majority of authoring-tool
  output. Ingest should still detect a multi-SCO manifest and report it as unsupported
  rather than failing obscurely
- **Full SCORM 2004 sequencing and navigation** — the IMS Simple Sequencing model is
  enormous and mainstream tool output barely uses it
- Exotic manifest features outside mainstream tool output

### Why "2004" was not cut wholesale

The version is not one cost, it is two:

| | Cost |
|---|---|
| 2004 **runtime** — data model, API conversation | **Free.** `scorm-again` ships it |
| 2004 **sequencing and rollup** | **Real work** — and already excluded above |

Cutting 2004 as a block would discard something the library provides for nothing, while
the part that actually costs was already out. The expensive half is gone either way.

**Worth knowing:** for content we *author*, we pick the export format — Storyline, Rise,
Captivate and iSpring all emit SCORM 1.2, so 1.2 could be the house standard. The version
only becomes someone else's choice on content we **buy**.

## Out of scope

Not "later" — **not in the PoC at all**:

- ❌ Multi-tenancy *(single-tenant by decision — see `CLAUDE.md` § architecture 7–8)*
- ❌ Offline. Learners must be connected
- ❌ Upload UI, content authoring, admin console
- ❌ Roles and permissions beyond what the flow needs
- ❌ Libraries, sections, catalog browsing, search
- ❌ Entitlements, licensing, seat counts
- ❌ Third-party/partner API
- ❌ Other content types — video, PDF, quizzes, H5P, link-out
- ❌ Certificates, expiry, reminders, reporting, exports
- ❌ SSO, notifications

## Do properly even in a throwaway

Cheap now, structural later. Cutting these saves days and costs months:

| | Why |
|---|---|
| **Launch tickets** | Replaces the current "customer ID in a URL" bug. Retrofitting auth is how that bug happened |
| **Separate content domain** | Architectural, not hardening. Serving from the app origin bakes in URLs and assumptions that are painful to unpick |
| **Complete ≠ Passed as two fields** | One extra column now; a migration with live data later, and every report inherits the mistake |

---

## Minimal data model

| Table | Holds |
|---|---|
| `people` | `subject_id` (from the SaaS), name, email |
| `programs` | The assignable unit: title, description |
| `content_versions` | An immutable ingested package: program, version, storage path, SCORM version, manifest details |
| `assignments` | `subject_id` + `program_id`, assigned date |
| `registrations` | **The core record.** person + content_version → completion status, success status, score (raw/min/max/scaled), location, `suspend_data`, total seconds, attempt number, timestamps |
| `launch_tickets` | Token, person, content_version, expiry, consumed flag |

Six tables. Multi-SCO is out of the PoC, so there is no per-SCO state table — resist
adding one.

Notes that matter:

- **`completion_status` and `success_status` are separate columns.** Never one field.
  SCORM 2004 supplies both directly. SCORM 1.2 packs them into `cmi.core.lesson_status`,
  so derive — and let each write update **only the column it carries news about**:

  | `lesson_status` written | → `completion_status` | → `success_status` |
  |---|---|---|
  | `passed` | `completed` | `passed` |
  | `failed` | `completed` | `failed` |
  | `completed` | `completed` | *(unchanged)* |
  | `incomplete` | `incomplete` | *(unchanged)* |
  | `browsed` | `incomplete` | *(unchanged)* |
  | `not attempted` | `not attempted` | *(unchanged)* |

  **Leaving success untouched on a completion-only write is the whole trick.** It is what
  makes the observed `completed` → `passed` sequence preserve both facts instead of the
  second write destroying the first. Implemented in `spike/harness.html` as `applyStatus()`
- **`suspend_data` is stored opaquely** and round-tripped byte-for-byte. Store its length —
  SCORM 1.2 caps it at 4,096 chars and overflow silently breaks resume
- **Time is stored as integer seconds**, normalized at the boundary. 1.2 and 2004 use
  incompatible formats
- **`content_versions` are immutable** once a registration references one

---

## 📦 The corpus — the actual deliverable

We have no content of our own, so the corpus is assembled to span **tools and versions**
rather than to reflect one library's habits. For a universality thesis that is better
evidence, not worse.

### Tier 1 — conformance baselines

Proves the runtime is correct before blaming anyone's content.

- ADL SCORM conformance test packages, 1.2 primarily
- Rustici golf examples: the **Runtime** variants
  *(the ContentPackaging variants we already have contain no runtime code at all —
  they render "Not implemented yet" and never call the API)*
- **Two or three 2004 packages, and one multi-SCO** — not to pass, but to record *how*
  they fail. That measures the size of the gap for almost no effort, and a package that
  fails obscurely is itself a finding

### Tier 2 — real authoring tool output ⭐ the highest-value tier

One export from each mainstream tool, all available on free trials:

| Tool | Notes |
|---|---|
| **Articulate Storyline 360** | The most common source of real-world SCORM |
| **Articulate Rise 360** | Different engine from Storyline — test both |
| **Adobe Captivate** | Second most common |
| **iSpring** | PowerPoint-based, very common in corporate training |
| **Lectora** | Less common, meaningfully different output |

A twenty-minute throwaway course from each is enough. **This tier is what the PoC lives or
dies on** — it is the closest thing to the content we will actually serve.

### Tier 3 — deliberate edge cases

- `suspend_data` over 4,096 characters *(the silent resume-breaker)*
- A course that never calls `Terminate`
- Fixed-width layouts, popups
- Hostile packages: zip-slip, zip bomb, XXE manifest, manifest nested one level too deep

### Recording results

Every package gets a row: tool, SCORM version, does it launch, does it track, does it
resume, does it report completion, notes. **That table is the PoC's output.**

Every failure found becomes a permanent regression fixture.

### Findings so far

From the first eight packages, before any backend existed:

- **A valid package can contain nothing trackable.** `ContentPackagingOneFilePerSCO` has 19
  resources, all `scormtype="asset"`, zero SCOs. Ingest must report "no trackable content"
  rather than "invalid package" — real content will hit this
- **SCORM 1.2 writes `adlcp:scormtype`, 2004 writes `adlcp:scormType`.** Same attribute,
  different capitalisation. Match case-insensitively or silently find nothing
- **Launch hrefs can carry query strings** (`launchpage.html?content=playing`). Naive path
  handling breaks on them
- **🔴 Complete ≠ Passed, observed live.** A full run of `RuntimeBasicCalls_SCORM12`
  scoring 80%:
  ```
  315.97s  lesson_status = "completed"    ← reached the last page
  346.73s  score.raw     = "80"
  346.74s  lesson_status = "passed"       ← OVERWRITES "completed"
  ```
  The course destroyed the completion fact 31 seconds after writing it. **Had the learner
  scored 60, the final value would be `failed` and there would be no record they finished
  at all** — indistinguishable from someone who bailed halfway.
  **→ Write `completion_status` and `success_status` to separate columns as each arrives.**
  This is not a preference; the data is unrecoverable otherwise
- **🔴 Per-question detail is usually not reported.** The same run displayed all 15
  questions on screen with the learner's answers and the correct ones, and sent the LMS
  `score.raw = 80` and nothing else. `RuntimeBasicCalls` writes zero `cmi.interactions`
  elements; `RunTimeAdvancedCalls` writes them.
  **→ "Which questions does everyone get wrong" cannot be promised as a feature.** It
  depends entirely on the course author opting in, and many do not
- **🔴 Courses do not commit. Durability is entirely our problem.** In a 244-second run of
  `RuntimeBasicCalls_SCORM12`, the course wrote five bookmarks and called `LMSCommit`
  **zero times** — it only commits on exit, if at all. A dropped connection or a
  backgrounded app mid-session would lose everything since `Initialize`.
  **→ Persist on every `SetValue`. Never wait for `Commit`, and never wait for
  `Terminate`.** Writes must therefore be cheap and idempotent
- **🔴 Fractional seconds are optional in SCORM 1.2 timespans, and get omitted.** The
  sample reported `session_time = "0000:07:24"`, not the canonical `"0000:07:24.00"` —
  it calls its own converter with `includeFraction = false`. **A parser that requires
  `.SS` returns null or throws here, and every such course silently records zero
  duration.** Make the fractional part optional
- **`session_time` is computed by the course from its own clock**, not measured by the LMS.
  If a course miscalculates it or never terminates, the time data is whatever it chose to
  report. Treat it as a claim, not a measurement. It is also **wall-clock, not
  engagement** — the 444s above includes 98 seconds sitting idle on the results page, so
  it will not support a meaningful "time on task" report
- **`exit = ""` means a normal exit, not a suspend.** The next launch is a fresh attempt,
  not a resume. Courses signal this explicitly and we must honour it — treating every
  return as a resume would hand a finished learner their old state back
- **The basic golf samples never use `suspend_data`** — they bookmark with
  `lesson_location` only. The 4,096-char trap will not appear here; it is an
  Articulate-class problem. Another reason Tier 2 matters
- **Courses handle LMS failure badly — including Rustici's own reference sample.** With the
  API unreachable, `RuntimeBasicCalls_SCORM12` returns `undefined` from its GetValue
  wrapper, compares it with `== ""` (false for `undefined`), prompts the learner to resume,
  runs `parseInt(undefined)` → `NaN`, and navigates to a 404. The learner sees a resume
  dialog and then a blank frame.
  **→ The player must never depend on the course to fail gracefully.** Native chrome and a
  working exit belong outside the frame

---

## Sequence

| # | Step | Proves | Status |
|---|---|---|---|
| 1 | **Spike:** fake LMS in a static page, logging every call — `spike/harness.html` | Packages talk to the API at all | ✅ done |
| 2 | **Package inspector** — safety, manifest, version, SCO count, runtime presence — `spike/inspect.mjs` | Ingest is tractable | ✅ done |
| 3 | Assemble the corpus. **Tier 2 especially** | We can answer the real question | 🟡 Tier 1 only |
| 4 | Run the corpus; record what each package does | First read on the pass rate | 🟡 3/8, all Rustici |
| 5 | Backend: six tables, runtime endpoints, launch tickets, auth — `spike/api/` | Server-side persistence, criterion 6 | ✅ done |
| 6 | Browser player on the content origin | Criterion 1 | ✅ done |
| 7 | React Native app with WebView player — `spike/mobile/` | Criterion 2 | ✅ done |
| 8 | Signed completion webhook + stub SaaS receiver + console | Criterion 5 | ✅ done |
| 9 | Full corpus run against the real stack | Criterion 7 — the answer | 🟡 3/8, Rustici only |

### Status: six of seven criteria met

Course played on a phone, recorded server-side, delivered to a stub SaaS:
`subject-demo · attempt 1 · completed/passed · score 93 · 105s → webhook delivered`.

**Only criterion 7 is outstanding** — the corpus is still Rustici's own well-behaved
samples. Real authoring-tool content is the last unknown, and the one that decides
build-vs-buy.

**Proven end to end on SCORM 1.2**, against `RuntimeBasicCalls_SCORM12`:

launch · API discovery · bookmarking · scoring · status derivation into two columns ·
`exit="suspend"` → resume with state intact · normal exit → fresh attempt with bookmark
cleared · `total_time` accumulating across attempts (410s + 35s = `0000:07:25.00`) ·
session-end handover to the player.

**Criteria 3 and 4 met.** Criterion 1 met in a browser, not yet inside the web app.

⚠️ **All of it against Rustici's own well-behaved sample**, which never used
`suspend_data` and never reported interactions. Tier 2 remains the real test.

**Step 3 gives an early read on the whole thesis for almost no cost** — the harness needs
no backend, so a package can be dropped in and its behavior observed in minutes.

---

## Open questions

1. **Stack for the Waypoint backend?** Blocks step 4, not steps 1–3
2. **Can the SaaS call out and receive callbacks?** We own it, so effort not permission —
   but it shapes step 7
3. **Do we embed in the real web and mobile apps for the PoC, or build standalone player
   pages?** Standalone is faster; embedding proves more
4. **Which authoring tool are we most likely to buy from or build in?** Determines which
   Tier 2 export matters most
