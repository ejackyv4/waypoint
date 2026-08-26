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
| **[BUILD.md](docs/BUILD.md)** | What exists, how to run it, what it proves and what it doesn't |
| **[API.md](docs/API.md)** | Endpoints, authentication, the completion webhook |
| **[REQUIREMENTS.md](docs/REQUIREMENTS.md)** | Scope, success criteria, and every SCORM finding |
| **[DISCOVERY-BRIEF.md](docs/DISCOVERY-BRIEF.md)** | How SCORM works, in plain language |
| **[SCHEMA-PLAN.md](docs/SCHEMA-PLAN.md)** | Data model plan for the corrections side |
| **[CLAUDE.md](CLAUDE.md)** | Engineering lessons and pitfalls |
| **[TRANSCRIPT.md](docs/session/TRANSCRIPT.md)** | The full build session |

---

## Layout

```
spike/
  demo              start / stop / reset / mobile / status
  api/              the platform — server, data layer, auth, ingest, player, UIs
  mobile/           React Native app
  harness.html      standalone fake LMS for inspecting a package's behaviour
  inspect.mjs       package inspector — safety, manifest, runtime detection
docs/               everything above
```

## Tests

```bash
node spike/api/smoke.mjs http://<host>:8090   # 41 end-to-end assertions
node spike/inspect.mjs spike/corpus           # inspect SCORM packages
```

The suite covers ingest and rejection, status derivation, `suspend_data` round-tripping,
time normalization, attempt semantics, ticket replay and forgery, cross-registration
writes, learner authorization and webhook delivery.

**The UI layer has no automated coverage** — every UI bug in this project was found by
clicking, not by the suite.

---

## Not committed

SCORM test packages (`spike/corpus/`), runtime state (`spike/data/`) and `node_modules`.
Packages are freely re-downloadable from
[Rustici's golf examples](https://scorm.com/scorm-explained/technical-scorm/golf-examples/);
`./spike/demo reset` recreates everything else.
