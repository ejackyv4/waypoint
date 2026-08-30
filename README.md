# Waypoint

A proof-of-concept LMS that plays SCORM content inside our own web and mobile apps,
tracks it server-side, and reports results back to the business system — with no
third-party LMS involved.

**Status: proof of concept.** Deliberately disposable. Single-tenant, SQLite, no admin UI.
See [Limitations](docs/BUILD.md#limitations-be-honest-about-these).

---

## Quick start

```bash
./spike/demo start     # API, content origin and mock SaaS
./spike/demo mobile    # the app in the iOS simulator
./spike/demo reset     # wipe and re-seed for a fresh demo
./spike/demo status    # what's running, plus URLs
./spike/demo stop
```

Then open the mock business system it prints, pick a subject, assign **Golf Explained**,
and take the credentials it gives you to the learner site.

Needs Node 22+ (for built-in SQLite) and, for the app, Xcode with a simulator.

---

## Documentation

| | |
|---|---|
| **[LMS.md](docs/LMS.md)** | How the LMS plays SCORM, and what real content cost us to support |
| **[BUILD.md](docs/BUILD.md)** | What exists, how to run it, what it proves and what it doesn't |
| **[API.md](docs/API.md)** | Endpoints, authentication, the completion webhook |
| **[REQUIREMENTS.md](docs/REQUIREMENTS.md)** | Scope, success criteria, and every SCORM finding |
| **[DISCOVERY-BRIEF.md](docs/DISCOVERY-BRIEF.md)** | How SCORM works, in plain language |
| **[SCHEMA-PLAN.md](docs/SCHEMA-PLAN.md)** | Data model plan for the corrections side |
| **[SQLITE-TO-SQL.md](docs/SQLITE-TO-SQL.md)** | What moving off SQLite would take, and whether to |
| **[SubjectRecording.md](docs/SubjectRecording.md)** | Recording a visit, transcribing it, and what the summary may and may not assert |
| **[DEMO-CONVERSATION.md](docs/DEMO-CONVERSATION.md)** | Two-minute script to record for demonstrating the transcript and summary |
| **[CLAUDE.md](CLAUDE.md)** | Engineering lessons and pitfalls |
| **[TRANSCRIPT.md](docs/session/TRANSCRIPT.md)** | The full build session |

---

## Layout

```
spike/
  demo              start / stop / reset / mobile / status
  api/
    server.mjs      composition root — starts the three listeners, nothing else
    waypoint.mjs    the LMS: content, registrations, runtime, results
    content.mjs     the content origin — uploaded course code, under a CSP
    northwood.mjs   the customer's system — composition only
    northwood/      one module per domain: auth, profile, agreement, visits,
                    officer, me (subject-facing), lms (the integration itself)
    sweeper.mjs     closes sessions the course never terminated
    db/connect.mjs  the connection and the three query helpers
    db/schema.mjs   tables and migrations, marked by owning system
    db/waypoint.mjs the LMS's data
    db/northwood.mjs the corrections system's data — imports no Waypoint
    auth.mjs        five credential types
    config.mjs      ports, origins, flags
    *.html          console, learner site, player, mock SaaS UI
  mobile/           React Native app
  harness.html      standalone fake LMS for inspecting a package's behaviour
  inspect.mjs       package inspector — safety, manifest, runtime detection
docs/               everything above
```

## Tests

```bash
node spike/api/smoke.mjs http://<host>:8090   # 88 end-to-end assertions
node spike/api/test-sweeper.mjs               # abandoned sessions are closed
node spike/api/test-insights.mjs              # transcription and summary, stubbed provider
node spike/api/check-boundary.mjs             # Northwood never reaches into Waypoint
node spike/api/check-docs.mjs                 # every route matches API.md
node spike/api/check-feedback.mjs             # every save confirms it worked
node spike/inspect.mjs spike/corpus           # inspect SCORM packages
```

The three `check-*` scripts enforce claims this project used to only make in
comments. Each one was written after the thing it checks had already gone wrong
once: a customer system reaching into the LMS's tables, a route documented one
way and built another, a save that reported success silently.

The suite covers ingest and rejection, status derivation, `suspend_data` round-tripping,
time normalization, attempt semantics, ticket replay and forgery, cross-registration
writes, learner authorization and webhook delivery.

`check-feedback.mjs` exists because three separate bugs here were "the save worked but
the screen re-rendered identically, so it looked broken". It fails if any write can
complete without telling the user.

**The rest of the UI layer has no automated coverage** — most UI bugs in this project
were found by clicking, not by the suite.

---

## Not committed

SCORM test packages (`spike/corpus/`), runtime state (`spike/data/`) and `node_modules`.
Packages are freely re-downloadable from
[Rustici's golf examples](https://scorm.com/scorm-explained/technical-scorm/golf-examples/);
`./spike/demo reset` recreates everything else.
