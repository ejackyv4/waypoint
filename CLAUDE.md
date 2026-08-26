# CLAUDE.md — Waypoint

Guidance for Claude Code (claude.ai/code) when working in this repository.

**What this file is:** a list of **lessons learned and pitfalls to avoid**. Most come from
scars on previous projects; the rest are traps specific to LMS and SCORM work that are
cheap to avoid now and expensive to discover late.

**What this file is not:** a specification. It does not say what Waypoint does, what is in
scope, or what has been decided. That lives in `docs/` — see the end of this file.

**Two rules about this file itself:**

- **If a rule here is routinely ignored, fix the rule.** A file full of rules nobody
  follows teaches everyone that the whole file is decorative. That is exactly how the
  previous project's guidance became worthless.
- **When a lesson turns out not to apply here, delete it** rather than leaving it to be
  worked around.

---

## 🚨 DATA SAFETY — THE MOST EXPENSIVE LESSON

Data loss is the one failure that cannot be fixed later by writing better code.

### 🛑 Never, without explicit in-the-moment approval

- ❌ Any command that **drops or recreates tables** (`migrate:fresh`, `migrate:refresh`,
  `migrate:reset`, `db:wipe`, `prisma migrate reset`, `DROP TABLE`, `TRUNCATE`, …)
- ❌ **Creating databases or database users** — the database already exists
- ❌ **`DROP DATABASE`**, ever
- ❌ **Restoring a backup** over anything
- ❌ **Running seeders** against a shared database
- ❌ Bulk `DELETE`/`UPDATE` without a `WHERE` clause you have read out loud

### The pattern that caused the damage

On previous projects the sequence was always the same: *see a connection error → panic →
"fix" it by creating a fresh empty database → destroy real data.* It happened more than
once, cost production recoveries, and each time the warnings in `CLAUDE.md` were sitting
right there being ignored.

**A connection error means a connection is misconfigured. It never means the database
should be recreated.** Fix the connection. Touch nothing else.

Related failures worth naming, because they all came from the same instinct:
- Assuming a database was "fresh" without checking — it was a production backup
- Ignoring a filename that said `prod-bak`
- Ignoring the user saying "we have an existing database"

### Before any schema or data operation

1. **Print which database you are connected to** — host and name — and show it
2. **Check migration status** (read-only) first
3. **Describe the change in one sentence**: "this adds column X to table Y"
4. **Ask, and wait for an explicit yes.** Approval for one migration is not approval for
   the next

**If a migration errors, STOP and ask.** Do not improvise a recovery.

### Migration hygiene

The previous project accumulated 200+ migration files that became unrunnable — duplicate
indexes, conflicting foreign keys, dev/prod drift — and had to be replaced wholesale with
a schema snapshot. Avoid earning that debt:

- **Forward-only.** Never edit a migration that has run anywhere but your laptop
- **One concern per migration.** Schema changes and data backfills are separate files
- **Squash to a schema snapshot** once the schema stabilises
- **Every environment builds from the same path.** If local setup and deployment run
  different commands, drift is guaranteed

---

## 🏗️ ARCHITECTURE LESSONS

Each of these cost real weeks somewhere.

### 1. One source of truth per fact

The recurring expensive bug: two subsystems both track the same fact, one gets updated,
the other doesn't, and reports disagree with the UI for months before anyone notices.

If two systems need the same fact, one **owns** it and the other **derives** it. A
denormalised value is written by exactly one code path and is regenerable from source at
any time.

### 2. Never split one concept across two columns

A previous project stored the same field in both `field_value` (text) and `field_values`
(JSON), with records variously in one, the other, both, or neither. Every consumer needed
fallback logic; the ones that forgot returned empty data silently. It was never fully
cleaned up.

**One concept, one column, one type.** If the shape must change, migrate the data and
delete the old column in the same release. A "temporary" second column is permanent.

### 3. Clients send IDs; the server does the lookups

Clients send **record IDs and user intent**. The server resolves them and computes
everything derived.

- ❌ Client sends `{ score: 87.5, passed: true }`
- ✅ Client sends `{ registration_id, raw_score, min, max }` → server applies the pass mark

This keeps calculation rules in one testable place, lets rules change without shipping a
new app, and means **the client cannot assert its own outcome** — a data-integrity rule
and a security rule at once.

### 4. Every entity in every response has a real ID

- ✅ `{ "id": 123, "title": "Fire Safety" }`
- ❌ `{ "id": null, "title": "..." }` — corrupts client state and forces extra round trips
- ❌ Display text with no ID, so the client has to look it up again

**Select the primary key in every join query.** Omitting it is the classic cause of
`id: null` reaching a client, and it broke a production feature on the previous project.

### 5. Shared rendering means shared code, not synchronised copies

A previous project maintained three separate form-rendering views with a written rule
that every change be applied to all three. They drifted constantly and were a permanent
bug source. **"Remember to update the other two" is not an architecture.**

**Corollary: never write a custom implementation when a component exists.** If a pattern
works on one screen, use the *exact same component* on the next. Don't duplicate its
rendering logic, don't create a second widget type for the same job, don't override its
internals from outside. If a shared component can't do what a screen needs, extend the
component — everyone benefits.

### 6. Dynamically-loaded components need explicit initialisation

Anything injected into the DOM after page load — modal contents, a lazily-fetched panel,
a player frame — will not auto-initialize. Give shared components an idempotent
`init(root)` and call it after insertion, guarding against double-init. **Do not paper
over the timing with arbitrary delays**, and do not patch the component to accommodate
one caller.

### 7. Route data access through a chokepoint

Scattering raw queries through controllers is what makes later structural change — adding
scoping, adding an audit trail, adding caching — a three-month archaeology project
instead of a one-file change.

This matters here specifically: **Waypoint is single-tenant by decision, and if that ever
changes, the chokepoint is what makes adding scoping survivable.** The insurance is the
layer, not a speculative `tenant_id` column — the column was never the expensive part.

### 8. If it is multi-tenant, scoping is enforced, never remembered

Not currently applicable — recorded because it is the single most expensive lesson from
the previous project, and because the moment tenancy arrives it applies in full:

- Enforce at the framework level — a global scope, base repository, or row-level
  security. Never a convention every author must remember
- One clearly-named, greppable bypass. Never an implicit "this one runs as admin"
- **A missing tenant context is an error, not an empty result.** Silent zero-row returns
  train people to sprinkle the bypass everywhere
- Global reference data does **not** get a tenant id. Adding one creates N copies of a
  table that should have one row per real-world thing, and every later join is wrong

---

## 🔐 SECURITY PITFALLS

### 1. A value the client sends is never proof of identity

The current system passes a customer ID in a URL, so **anyone can change the number and
become a different customer.** The same class of bug as the mobile login bypass on the
previous project.

The fix, everywhere: **short-lived, single-use, server-minted tickets** scoped to one
person and one thing, validated and consumed server-side. Authorisation derives from the
server-side session, never from a parameter — and that applies to the launch URL, the API,
and the mobile app equally.

**On the return leg too:** the phone must never be what reports a completion. That goes
server-to-server, where the learner can't touch it.

### 2. Uploaded course content is third-party code that you execute

A SCORM package is a zip of working web pages and scripts that gets unpacked and run.
Trusting the *uploader* is not the same as trusting the *file* — packages are authoring-tool
exports produced by other people.

**Runtime isolation is non-negotiable:** serve course content from a **different origin**
than the application (`content.…` vs `app.…`). Same-origin means a course's JavaScript can
read the logged-in session and act as the user. Rustici's commercial engine shipped exactly
this bug and it allowed account takeover — this category is real, not theoretical.

- Restrictive CSP and `nosniff` on content responses
- Narrow, validated, origin-checked `postMessage` bridge between the two. Never `*`
- No application cookie scoped to the content origin
- **Never "temporarily" serve content from the app origin to unblock a bug.** That
  temporary fix *is* the vulnerability
- Serving from the app origin now bakes in URLs and assumptions that are painful to
  unpick — this is architectural, not hardening to add later

**Ingestion hygiene** is cheap and there is no excuse for skipping it: reject entries whose
paths escape the extraction root (zip-slip); cap uncompressed size, entry count and
compression ratio (zip bombs); disable external entities and DTDs in the manifest parser
(XXE); serve every file with an explicit content type from an allowlist, never sniffed.

Heavier work — isolated unpack workers, resource limits, quotas, adversarial scanning —
scales with who can upload. **The moment someone other than the team can upload, it
becomes mandatory.**

---

## 📐 LMS AND SCORM PITFALLS

Domain traps. All are nearly free now and brutal to retrofit.

### Complete ≠ Passed. Two fields. Always.

A learner can **finish** a course and **fail** it. SCORM 1.2 blurs these; 2004 separates
them. Store completion and success as separate columns from the first migration.
Collapsing them into one "status" is the most painful schema mistake available here, and
every report built on top inherits it.

### `suspend_data` is opaque — store it, never read it

It is the course's private notes about where the learner is. The only job is to hand back
exactly what was given.

- **Never parse, transform, trim, or re-encode it.** Byte-for-byte round trip
- **SCORM 1.2 caps it at 4,096 characters**, and Articulate courses routinely exceed it.
  When they do, "resume where I left off" silently stops working — a classic support
  ticket. **Detect the overflow, log it loudly, surface it.** Silent truncation is the
  worst possible behavior
- Store the byte length so overflow is queryable, not anecdotal

### Normalize time on write

SCORM 1.2 (`HHHH:MM:SS.SS`) and 2004 (ISO 8601 durations) record time completely
differently. **Convert to integer seconds at the boundary.** Let two formats reach a
report and every time-based number is wrong, and nobody notices for months.

### Never overwrite a course version in place

If an updated course is uploaded while people are mid-progress, **those people keep seeing
the version they started.** Versions are immutable once a registration references them.
Deleting a referenced version is forbidden.

### Attempts are rows, not overwritten fields

"How many tries did this take" is unanswerable if attempt N clobbers N−1.

### Sessions end without saying goodbye

When someone closes the app, the course never sends `Terminate`. The server must notice
the silence and close the session itself, keeping whatever the last `Commit` gave it.
**On mobile this is the common case, not the edge case.**

### Rollup is computed, never typed in

A multi-lesson package's overall result is derived from its children by an explicit,
tested rule. Let a human set the parent status directly and the two will diverge.

### Link-out content can only ever track "they opened it"

No score, no completion, no resume. Inherent to the type, not a gap to fix. Set the
expectation up front rather than explaining it in month six.

### Old courses are weird — and that is the actual project

Getting *one* course to play is a week. Getting *everyone's* courses to play is the job.
Flash, popups, fixed 1024×768 layouts, multi-SCO packages, four editions of SCORM 2004.

**The highest-value thing available: collect five to ten real course files, plus one export
from each major authoring tool, and test against that set forever.** That collection is
worth more than any amount of up-front design. Every bug found in a real package becomes a
permanent fixture.

---

## 📱 MOBILE AND WEBVIEW PITFALLS

- **No app session cookie in the WebView, ever.** The launch ticket is the only
  credential. iOS and Android share cookie stores across WebViews by default — use a
  non-persistent store and clear between sessions
- **`allowUniversalAccessFromFileURLs`, `allowFileAccessFromFileURLs` and `allowFileAccess`
  off.** Content loads from the remote content origin over HTTPS; a course has no business
  touching the device filesystem
- **Commit on backgrounding.** The app gets backgrounded constantly and killed without
  warning, so `Terminate` never arrives. Hook app state, commit on background, commit on
  unmount, and keep a server-side timeout as backstop
- **Android hardware back routes to the player's exit flow** — never a raw unmount that
  discards uncommitted state
- **Intercept navigation.** External links open in a system browser; the course WebView
  never navigates away from its package
- **Player chrome is ours, outside the frame.** Never depend on the content to provide
  progress or exit — you don't control what's inside
- **Exit must always work**, including when the course is blank, broken or hung. A learner
  trapped in a frozen course is the worst bug this product can ship
- **🔴 Exactly one layer owns the chrome for a surface.** This bit three separate
  times: the course's own Exit vs ours, then the native header vs the web player's
  footer, then a results screen rendered in both. On desktop the web player owns
  chrome; in the app the native shell owns it and the web player hides its own
- **🔴 Never render app chrome inside the WebView on iOS.** An iframe there expands to
  its content instead of scrolling, and a legacy fixed-width course widens the whole
  **layout viewport** — after which `100vw`, `max-width:100%` and even `position:fixed`
  all resolve against ~800px, not the 430px screen. No CSS fix works; move the chrome
  to native
- **`originWhitelist` matches the ORIGIN only** (`http://host:port`). Give it a path
  glob and every URL fails the check — and `react-native-webview` then silently hands
  the URL to `Linking`, opening the system browser. You get a blank frame and a warning
  buried in Metro logs
- **No `borderRadius` + `overflow:"hidden"` on a WebView style.** On iOS that clips and
  mis-sizes the contents rather than just rounding corners
- **Name `Authorization` in `Access-Control-Allow-Headers`.** It is not CORS-safelisted,
  so every authenticated call fails at preflight the moment auth is added
- **"Connected" is not "reliable."** Requiring a connection does not mean the network
  behaves — lifts, tunnels, car parks, hotel wifi. Commit early and often rather than at
  the end, retry within the session, and **never show a learner a success that wasn't
  saved.** Losing twenty minutes of someone's work to a tunnel is preventable and
  unforgivable

---

## 🖥️ UI STANDARDS

### No browser dialogs. Anywhere.

- ❌ `alert()` → ✅ one app-wide notification component
- ❌ `confirm()` → ✅ a styled confirmation modal
- ❌ `prompt()` → ✅ a proper form

Enforce it in review: `grep -r "alert(\|confirm(\|prompt("`.

### Messages are specific and contextual

- ✅ "Upload failed — `imsmanifest.xml` must be at the top level of the zip. Try zipping
  the folder's *contents* rather than the folder."
- ❌ "Success" / "Error" / "Something went wrong"

Active voice, name the thing acted on, say what happens next. Confirmations for
destructive actions state the consequence.

### One pattern per interaction type

Multi-step flows use **one** stepper pattern across the app — same component, same
validation-before-advance, same color semantics. Consistency beats any individual
screen's cleverness.

---

## ✅ TESTING LESSONS

**If you write code, you write tests. If you edit code, you update tests.**

This mandate exists because production issues reached customers through untested paths on
the previous project.

### Test-writing standards

Hundreds of tests broke there through poor test hygiene:

1. **Read the actual schema** before writing a test. Never assume a field name
2. **Use factories**, never hardcoded field arrays that drift from the schema
3. **Copy an existing working pattern** rather than inventing one
4. **Test stored values as stored, computed values as computed.** Asserting a derived
   status as if it were a column is a guaranteed false failure
5. **Verify the factory works standalone** before building on it

**When a test fails because of a schema mismatch, the test is wrong.** Production code and
migrations are the source of truth; tests conform to them, not the reverse.

### What must be covered here

- **The real-course corpus** — every package imports, plays, bookmarks, resumes, reports
- **Hostile fixtures** — zip-slip, zip bomb, XXE manifest, manifest nested too deep,
  oversized `suspend_data`, a course that never calls `Terminate`
- **Launch tickets** — expiry, single-use, wrong user, wrong course, replay
- **Runtime conformance** — data model round-trips, both time formats
- **Network resilience** — drop mid-course and recover; drop and stay down; commit fails
  then succeeds. Assert no committed progress is lost and no failed commit is reported as
  success
- **Mobile lifecycle** — background, force-kill, hardware back

---

## 🔎 DEBUGGING PLAYBOOK — check these first

Most "mysterious" bugs on the previous project were one of a small set of causes. Work
this list before theorising:

1. **Missing primary key in a `SELECT`** — `id: null` reaching the client
2. **Written to one place, read from another** — same fact tracked twice, one updated.
   Grep for every writer of the field
3. **An empty array or absent key overwriting good data** — a partial update treated as a
   full replace. Distinguish "not provided" from "explicitly cleared"
4. **JSON stored as a string, or double-encoded** — check the encode/decode boundary at
   both ends
5. **The value is in the other column** — legacy and current storage both populated. Fix
   the storage; don't add fallback logic
6. **Type mismatch across the client boundary** — integer where a string was validated.
   Normalize at the boundary, once
7. **A cache** — application, HTTP, or browser. Confirm the underlying data first

Domain-specific:

8. **`suspend_data` over 4,096 chars** on SCORM 1.2 — resume "randomly" breaks for one
   course and works for others
9. **Two time formats mixed** — a duration report wrong by orders of magnitude
10. **Session never terminated** — the record reflects the last `Commit`, not the last
    thing the learner actually did
11. **Origin/CSP blocking the bridge** — the course loads but never talks back. Check the
    console on the *content* origin
12. **App was backgrounded** — "lost" progress is progress never committed. Check the last
    commit timestamp before suspecting the runtime
13. **Works in a desktop browser, fails in the WebView** — blocked navigation, CORS/CSP
    difference, autoplay policy, or an assumed viewport. Remote-debug it; don't guess
14. **A commit that failed silently** — the learner insists they finished and the record
    disagrees. Check the commit log before doubting them. They are usually right

---

## 🔄 HOW WE WORK

- **Always work on a feature branch. Never commit to `main`**
- **Do what has been asked — nothing more, nothing less**
- **Never create a file unless necessary.** Prefer editing an existing one
- **Never proactively create `.md` documentation.** Only when explicitly requested
- Commit and push only when asked

### Read the docs before changing anything

1. `ls docs/` — see what exists
2. `grep -r "<keyword>" docs/`
3. **Read it fully** before writing code
4. **Follow the documented pattern exactly**

**If documentation exists for a system, it is authoritative.** Don't invent a new pattern
when an approved one is written down. If the documented pattern is genuinely wrong, say so
and propose changing the doc — don't quietly diverge.

### Proof-of-concept discipline

Waypoint is currently a **proof of concept**. Its job is to answer whether content can be
delivered and tracked inside our own apps without a third-party LMS. That means:

- **Cut scope aggressively.** Anything that doesn't help answer that question is out
- **Treat it as disposable.** If it succeeds, plan to rewrite rather than evolve. PoCs
  promoted straight to production without that reckoning are how a codebase ends up with
  200 unrunnable migrations
- **The exceptions worth doing properly even now**: secure launch, content-origin
  isolation, and Complete ≠ Passed. Each is cheap today and structural later

---

## 🧹 TECHNICAL DEBT

**Priority: delivery > debt reduction.** But improve what you are already touching.

- **Opportunistic only.** Refactor the file you're in, for the change you're making
- **Never start a large refactor mid-feature**
- **Lowest risk first**: extract template partials and pure helpers before restructuring
  business logic
- **Test coverage does not drop.** A refactor that loses tests is a regression
- A file crossing ~800 lines is a signal to split it next time you open it

---

## 🧱 STACK — TO BE FILLED IN

Not chosen yet, except that mobile is **React Native**. When it is, record here: build and
test commands; database and the read-only command that prints which one you're connected
to; migration tooling and its forbidden-command list; object storage and the content-origin
arrangement; queue/worker system; test framework and where the course corpus lives.

For the SCORM runtime, [`scorm-again`](https://github.com/jcputney/scorm-again) (MIT) is
the recommended start; Rustici Engine is the priced escape hatch.

---

## WHERE THE ACTUAL DECISIONS LIVE

This file is lessons and pitfalls. What Waypoint *is*, what's in scope, and what's been
decided lives in:

- [`docs/DISCOVERY-BRIEF.md`](docs/DISCOVERY-BRIEF.md) — how SCORM works, the three hard
  parts, glossary
- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) — PoC scope, success criteria, the
  minimal data model, and the build sequence
