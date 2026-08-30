# Waypoint — what it is and how it's built

## What it does

Waypoint is a learning platform that plays training courses inside software we
control. Courses arrive as **SCORM packages** — the standard format every
corporate e-learning tool exports, and the format any content we buy or build
will come in. Waypoint unpacks a package, serves it, runs the conversation the
course expects to have with a learning system, and records what the learner did:
whether they completed it, whether they passed, their score, how long they spent,
and exactly where they stopped if they left partway through. A learner can quit
halfway and resume where they left off.

There are two ways a learner reaches a course, and both are ours:

- **The web app** — a browser page listing the courses assigned to them, which
  opens the course in a player we control.
- **The mobile app** — a React Native app for iOS and Android that plays the same
  course inside the app itself. Not a hand-off to the phone's browser: the learner
  never leaves, and the app keeps its own header, progress and exit controls
  outside the course frame, so a broken or hung course can never trap them.

Both use the same server and the same records. A learner can start a course on
their phone and finish it in a browser.

## How the SCORM part actually works

This is the part with no shortcuts, so it is worth understanding.

**A SCORM package is a zip of working web pages.** Inside is a manifest naming
the entry point, and a pile of HTML, JavaScript, images and fonts. When it runs,
the course expects to find a JavaScript object called `API` somewhere above it in
the page, and to talk to that object for the whole of the learner's session:
*here is their score, here is where they got to, save this, I am finished.*
Everything below follows from that one sentence.

**So we provide that object.** Waypoint unpacks the zip and serves it, and frames
it inside a player page of ours that exposes the `API` object the course is
hunting for. The course talks to the player; the player talks to our server. Every
value the course sends is written to the database immediately.

**The awkward part is where that player has to live.** Uploaded course code is
third-party code that we execute in our customers' browsers, so it must be served
from a different web address than the application — otherwise a course's
JavaScript could read a logged-in session and act as the user. But the way a
course *finds* the `API` object only works when the page above it shares the same
address. Those two requirements pull in opposite directions.

The resolution: the player lives on the **content** address, next to the course,
so discovery works — and the player is the only thing allowed to call back to the
application, over a locked-down cross-origin connection with a token scoped to
that one course launch. The course itself can reach nothing.

**What gets recorded**, and four decisions inside it that were cheap to make now
and expensive to retrofit:

- **Completion and pass/fail are separate columns.** A learner can finish a course
  and fail it. Older SCORM blurs the two into one value; collapsing them into a
  single "status" is the most painful mistake available here, because every report
  built afterwards inherits it.
- **Resume data is stored exactly as given, and never read.** The course sends an
  opaque blob describing where the learner is. Our only job is to hand back the
  identical bytes. Parsing it, trimming it, or re-encoding it breaks resume for
  that course, and the learner is who finds out.
- **Time is converted to seconds on the way in.** The two SCORM versions express
  duration in incompatible formats. Both are normalised at the boundary, so only
  one representation ever reaches a report.
- **Course versions are immutable.** Upload an updated course and anyone
  mid-progress keeps the version they started. Re-uploading creates a new version;
  it never overwrites.

**Getting one course to play is a week. Getting everyone's courses to play is the
job.** Real courses from real authoring tools behave nothing like the tidy samples
published by the people who wrote the specification, and testing against a genuine
11 MB export found seven defects in an afternoon that the samples could not have
surfaced. [`LMS.md`](LMS.md) records each one and what it would have cost.

## What it's built in

The server is **plain Node.js (v22) with zero third-party dependencies** — no
framework, no build step, nothing to patch or audit. It uses Node's own built-in
HTTP server, its built-in SQLite database, and its built-in cryptography. The two
web interfaces are plain HTML, CSS and JavaScript. The mobile app is **React
Native** (via Expo) with six dependencies. Around 25,000 lines of our own code,
covered by 108 automated tests.

The zero-dependency choice was deliberate for a proof of concept: it keeps the
effort on the actual problem and means nothing rots while the production stack is
decided. **That decision is still open** — and the API boundary described below
is what keeps it open, since either side could be rebuilt in .NET or anything
else without touching the other.

It runs as three separate services:

- **Waypoint** — the API, the learner web app, and an admin view.
- **The content origin** — a deliberately separate web address serving the
  unpacked course files. An uploaded course is third-party code running in our
  customers' browsers; if it shared an address with the application, that code
  could read a logged-in session. Keeping them apart is a security decision, and
  the course files are served under a restrictive content policy.
- **The business application** — the system that actually owns the customers.

## Connecting a business system: the API

Waypoint knows nothing about any particular business. It knows about *people*,
*programs* and *results*. Everything else — who someone is, why they were assigned
training, what happens when they pass — belongs to the system integrating with it.
That system talks to Waypoint over a plain HTTP/JSON API using a server-held API
key, and the whole integration is about ten calls.

**The key never reaches a browser or a phone.** It is held by the integrating
system's own backend, which brokers every request.

### Identity: you keep yours

Waypoint stores **your** identifier for a person (`subject_id`) and **your**
identifier for a course (`program_id`), and returns both on everything it sends
back. The integrating system never has to store or look up a Waypoint ID.

### Setting up and assigning

```
GET  /api/content    what courses are available to offer
POST /api/users      create the person and, if they need one, a login
POST /api/assign     give that person a course
POST /api/unassign   take it back (refused once they have started it)
GET  /api/logins     which people can actually sign in
```

`POST /api/users` will not overwrite a password someone already has — it reports
whether it issued one, so a caller never displays a credential that was never
stored. A login belongs to the person and outlives every course they are given.

### Launching a course securely

```
POST /api/launch     issue a launch ticket, then send the learner to it
```

The ticket is **single-use, expires in sixty seconds, and is bound to one person
and one course**. It is requested by the business system's server at the moment
the learner clicks, and redeemed immediately. There is no customer ID sitting in a
URL that somebody could edit to become a different customer.

### Getting results back — two ways, and you want both

**Push.** When a learner finishes, Waypoint calls a webhook on the business
system, server to server. The learner's device is never what reports that they
passed. The payload carries your own identifiers:

```json
{ "subject_id": "cust-1041", "program_id": "safety-101",
  "registration_id": 42, "attempt": 1,
  "completion_status": "completed", "success_status": "passed",
  "score": { "raw": 88, "min": 0, "max": 100 },
  "total_seconds": 920, "completed_at": "2026-08-27T01:40:12.902Z" }
```

Each delivery is signed. Waypoint sends an `X-Waypoint-Timestamp` and an
`X-Waypoint-Signature` (an HMAC-SHA256 of the timestamp and body, using a shared
secret). The receiving system verifies both before trusting a word of it — the
timestamp check means a captured delivery cannot be replayed later.

**Pull.**

```
GET /api/status      live state of every assignment
```

A system needs both. The webhook is timely; the poll catches anything in progress,
and reconciles any delivery that was missed.

### What the learner's own app calls

The learner-facing apps use a **person-scoped session token**, not the API key.
That token can list their own courses and request a launch ticket for one — it
cannot write results, assign anything, or see anyone else's record.

```
POST /api/auth/login       learner signs in
GET  /api/me/assignments   their own courses and progress
POST /api/me/launch        a ticket for one of their own courses
```

### Proven, not assumed

The demo includes a full working business application — a corrections supervision
system with subjects, officers, visits and supervision agreements — built on top
of Waypoint. It holds an API key and talks over HTTP exactly as an outside
customer would, and an automated check fails the build if it ever reaches into
Waypoint's data directly. That is what makes the integration contract real rather
than aspirational: the reference implementation is a genuine customer of the API,
not a shortcut around it.

Full endpoint documentation is in [`API.md`](API.md); how the SCORM side works is
in [`LMS.md`](LMS.md).
