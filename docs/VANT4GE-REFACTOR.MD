# VANT4GE Refactor

## Purpose

This document captures the architectural options discussed for evolving Waypoint beyond the current proof-of-concept shape while protecting the working application.

The goal is not to rewrite everything at once. The preferred approach is to keep the current system working, establish clean contracts, and replace or refactor one boundary at a time.

## Target backend direction

Express is now the planned HTTP foundation for the refactor. The current API
intentionally uses Node's built-in `node:http`; it remains the working baseline
until an Express migration is implemented behind tests. When we migrate, keep
controllers responsible for external endpoints, move business rules into
services, keep database access in repositories, and preserve the existing API
contracts during the transition. Do not combine the Express migration with a
mobile rewrite or database replacement.

## Progress

### Completed — 2026-09-16

- [x] Preserved the current working state in Git.
- [x] Created safety branch `safety/pre-vantage-refactor`.
- [x] Created safety tag `pre-vantage-refactor-20260916`.
- [x] Created working branch `refactor/vantage-foundation`.
- [x] Committed the identity audit plan separately before refactoring.
- [x] Added optional Docker packaging and documented its isolated database and
      ports; Docker remains separate from the normal local workflow.
- [x] Added `.local/` to `.gitignore` so private development databases cannot
      be committed accidentally.

### Next — not started

- [ ] Capture the baseline test results for login, visits, action items,
      profiles, assistant queries, and demo resets.
- [x] Inventory every identity-bearing field and route (see
      `docs/IDENTITY-INVENTORY.md`).
- [x] Normalize subject and officer IDs using additive migrations for the
      identity-bearing write paths currently in scope.
- [ ] Add authorization and identity-scope tests.

Migration checkpoint: additive identity columns for goal-step completion and
standalone action assignment/completion were added on 2026-09-16. The focused
identity schema test passes 7/7 checks. Write-path population and authorization
scope tests remain open.

The officer goal-step completion write path now records the authenticated
officer ID, and the subject write path records the authenticated subject ID.
Standalone action creation now records the assigned subject/officer ID, and
subject completion records the authenticated subject ID. The focused identity
test passes 11/11 checks. Officer action decisions and older audit fields remain
open.

Officer decisions for standalone and visit-derived actions now record the
authenticated officer ID as well. The focused identity test passes 12/12
checks. Remaining work is to populate IDs for older audit fields and enforce
scope/authorization tests across every route.

Goal creation and completion now record the authenticated officer ID in
addition to the legacy display value. The focused identity test passes 14/14
checks. Remaining audit fields and authorization coverage are still open.

Visit start and completion now record the authenticated officer ID in additive
columns. The focused identity test passes 15/15 checks. Remaining visit notes,
photos, and other audit fields are still open.

Visit notes, photos, and recordings now have additive officer identity fields,
and their upload/write routes populate the fields from the authenticated
session. The focused identity test passes 16/16 checks. Case notes, agreements,
reentry, and financial audit fields remain open.

Case notes now record the authenticated officer ID, including notes created by
reassignment and profile workflows. The focused identity test passes 17/17
checks. Agreements, reentry, and financial audit fields remain open.

Agreement creation and officer signatures now record authenticated officer IDs
in additive columns. The focused identity test passes 19/19 checks. Reentry
and financial audit fields remain open.

Reentry plan and checkpoint officer signatures now record authenticated officer
IDs in additive columns. The focused identity test passes 21/21 checks.
Financial items now record officer IDs for creation, update, and waiver; payment
rows record the officer who recorded them. The focused identity test passes
24/24 checks. Authorization and identity-scope tests remain open.

Baseline note: the isolated session-sweeper test passed on 2026-09-16,
including the assertion that the default database is `spike/data/waypoint.db`.
The full HTTP smoke suite remains open because it requires a running test
server and seeded content.

## Current stack

- Backend/API: Node.js ES modules.
- Database: SQLite through Node's built-in `node:sqlite`.
- Web applications: HTML, CSS, and vanilla JavaScript.
- Mobile application: React Native with Expo, written in JavaScript.
- Infrastructure: Bash scripts, SQLite files, and optional Docker.

### Runtime version note

The mobile `package-lock.json` locks JavaScript dependencies, but it does not
pin the Node.js runtime. The backend Dockerfile currently specifies
`node:24-bookworm-slim`, which pins the Node major line but not an exact patch
version; Docker resolves the current Node 24 patch release when the image is
built. For reproducible production builds, pin the image by digest (or an exact
`24.x.y-bookworm-slim` tag) and record that choice here.
- Query layer: direct SQL wrapped by shared helpers and domain data-access functions.
- TypeScript: not currently used.
- ORM: not currently used.

The backend and database are independent of the mobile framework. Changing the mobile client does not require changing the API or database.

## Ionic, Capacitor, and Vue option

Ionic + Capacitor + Vue could replace the current React Native/Expo mobile client.

### What would stay the same

- Node API routes and authentication contracts.
- SQLite schema and data.
- Subject and officer identity rules.
- The web applications.
- C# services, if introduced later.

### What would need to be rebuilt

- Mobile screens as Vue components.
- Navigation and application state.
- Styling using Ionic components and CSS.
- Audio recording and playback.
- Microphone permissions.
- Camera and photo selection.
- Secure token storage.
- Date pickers and native dialogs.
- Any push notifications or background behavior.
- iOS signing, Capacitor configuration, and TestFlight build scripts.
- Mobile tests.

This is a mobile-client rewrite, not a switch in a configuration file. It is feasible, but should be treated as a medium-sized project.

### Recommended migration approach

Do not replace the Expo app immediately.

1. Build a small Ionic/Vue proof of concept.
2. Recreate one profile screen and one API-backed workflow.
3. Recreate the visit recording flow, including permissions and upload.
4. Compare reliability, performance, and TestFlight behavior with Expo.
5. Migrate additional screens only if the prototype is clearly better.
6. Keep the existing app available until the replacement passes the same end-to-end tests.

## C# microservices

The system can connect to C# services without changing the mobile framework.

Recommended shape:

```text
Mobile app
   ↓
Waypoint API
   ↓
C# microservices
```

The mobile app should normally call the Waypoint API rather than calling individual C# services directly. The Waypoint API remains responsible for:

- authentication and authorization;
- subject and officer identity;
- validating IDs and dates;
- enforcing visibility rules;
- combining data from multiple services;
- presenting a stable client-facing contract.

### Integration choices

- REST/JSON over HTTPS: simplest default.
- gRPC: useful for strongly typed internal service-to-service calls.
- Message queues/events: useful for asynchronous processing.
- SignalR/WebSockets: useful for real-time updates.

The important part is a versioned, documented contract. The implementation language of the service is secondary.

## ORM assessment

Waypoint does not currently use an ORM. It uses explicit SQL through:

- `one()`, `all()`, and `run()` helpers in `spike/api/db/connect.mjs`;
- domain data-access functions in `spike/api/db/northwood.mjs`;
- schema creation and additive migrations in `spike/api/db/schema.mjs`.

This keeps dependencies small and makes queries, indexes, and migrations visible.

### Potential ORM choices

- Prisma: mature schema/model workflow, but adds a substantial runtime and migration layer.
- Drizzle: lighter and closer to SQL, with useful TypeScript integration.
- Sequelize: established, but more abstraction than this small SQLite service currently needs.

### Recommendation

Do not adopt an ORM solely to support C# services or a mobile rewrite. An ORM would be worth considering if:

- the schema becomes much larger;
- multiple developers need generated models and stronger typing;
- database portability becomes important;
- query and migration consistency becomes difficult to maintain.

If an ORM is adopted, do it as a separate backend project with a migration plan. Do not mix an ORM introduction with identity normalization, a mobile rewrite, and service extraction in one change.

## MVC assessment

Waypoint uses the ideas behind MVC, but it does not currently implement a
strict MVC framework with explicitly named controller, model, and DTO layers.

### What exists today

- **Controllers:** route modules such as `spike/api/northwood/profile.mjs` and
  `spike/api/northwood/insights.mjs` receive HTTP requests, authenticate them,
  validate inputs, call domain functions, and write responses. These are
  controller-like responsibilities, although route handlers and business
  logic are sometimes close together.
- **Models:** the SQLite schema in `spike/api/db/schema.mjs` is the database
  model, while functions in `spike/api/db/northwood.mjs` are the model/data
  access layer. They are not ORM classes or generated models.
- **Views:** the web HTML files and React Native screens are views. JSON
  response objects serve as the API's view data for web and mobile clients.
- **DTOs:** response objects act as informal DTOs, but there is not yet a
  centralized DTO definition or runtime schema for every endpoint.

### Target boundary

For a more maintainable application, each external endpoint should follow this
shape:

`request → controller → service/use case → model/data access → DTO → response`

Controllers should handle HTTP concerns only. Services should contain workflow
rules. Models/data-access functions should own database queries. DTO builders
should define the stable shape sent to web, mobile, or another service. This
keeps database columns from leaking directly into client contracts and makes a
future C# service or ORM easier to introduce safely.

### Refactor guidance

Do not rewrite the application into a framework solely to obtain MVC labels.
First extract the highest-risk workflows—identity, action-item completion,
visits, and assistant queries—into clear controller/service/data-access/DTO
boundaries. Add validation and contract tests at those boundaries, then apply
the same structure to new modules.

## Refactor principles

1. Preserve the current working demo and local development workflow.
2. Keep subject and officer IDs canonical; names are display values only.
3. Keep API contracts stable and version changes deliberately.
4. Separate domain data access from route handlers.
5. Keep native mobile behavior behind small, testable adapters.
6. Prefer additive migrations and reversible changes.
7. Test web, mobile, API, and reset workflows together.
8. Avoid introducing infrastructure complexity without a concrete benefit.

## Suggested phases

### Phase 0 — Baseline

- Document current API contracts and identity fields.
- Add integration tests for the existing mobile workflows.
- Capture build and deployment instructions.

### Phase 1 — Boundary cleanup

- Complete identity and audit normalization.
- Centralize request validation.
- Keep direct SQL behind domain data-access functions.
- Add API contract tests.

### Phase 2 — Ionic/Vue feasibility prototype

- Create a separate Ionic/Vue/Capacitor client.
- Implement authentication, one profile screen, and one read-only workflow.
- Verify API origin handling in simulator and on a physical device.

### Phase 3 — Native workflow prototype

- Implement recording, permissions, photo selection, and secure storage.
- Compare reliability and TestFlight builds with the Expo app.

### Phase 4 — Service integration

- Define versioned contracts for any C# service.
- Add server-to-server authentication.
- Integrate through the Waypoint API.
- Add contract and failure-mode tests.

### Phase 5 — Selective migration

- Migrate screens incrementally only where the prototype demonstrates value.
- Keep the Expo app as a fallback until feature parity and operational confidence are proven.

### Phase 6 — ORM decision

- Reassess whether direct SQL is still the simpler, safer choice.
- If not, introduce an ORM in its own reviewed migration with generated models and tests.

## Decision

For now, keep the current Node + SQLite + Expo architecture. Store this refactor plan for future work, but do not start a full rewrite before the identity cleanup and current workflow tests are complete.
