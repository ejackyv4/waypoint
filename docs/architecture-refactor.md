# Architecture Refactor Plan

This is a planning document. It records the risks found in the September 2026
read-only architecture review and the order in which they should be addressed.
It does not authorize implementation by itself.

## Priority order

### P0 — protect correctness and availability

These items can cause lost work, outages, or a visibly broken demo.

1. **Stream uploaded course assets.**
   `spike/api/content.mjs` currently reads every requested asset into memory before
   sending it. Replace whole-file `readFile` responses with streaming responses and
   add HTTP range support for large audio/video assets. Preserve the separate content
   origin and security headers. Verify concurrent media requests and interrupted
   downloads.

2. **Make completion delivery asynchronous and retryable.**
   Session close currently waits for the SaaS webhook request. Persist the completion
   event first, return the learner's Save & Exit response promptly, and deliver from a
   durable queue with bounded retries, backoff, and visible failure state. Completion
   must remain idempotent.

3. **Make the demo baseline self-verifying.**
   A reset must verify that the restored database contains the expected program catalog,
   content versions, and agreed assignments before reporting success. Keep a pre-reset
   snapshot and fail closed if the baseline is missing or incomplete.

4. **Finish the route migration without dual implementations.**
   Complete the xAPI extraction, move shared runtime lifecycle functions to the owning
   runtime module, update the sweeper, remove the old `waypoint.mjs` branches, and keep
   `check-docs`, `check-boundary`, and smoke tests mandatory in CI. There must be one
   live handler for each URL.

5. **Fix the existing save-feedback failures.**
   `check-feedback.mjs` currently identifies two SaaS save flows that do not confirm a
   successful write. Resolve these before adding more UI work; silent success/failure
   makes operators repeat actions and can create duplicate records.

### P1 — scale the current design safely

These are unlikely to hurt a small demo, but become material with a real caseload.

6. **Remove dashboard N+1 reads.**
   The officer dashboard loops through subjects and asks each domain for its data.
   Replace this with batched queries or a purpose-built dashboard read model. Preserve
   the existing response contract and measure query count/latency before and after.

7. **Index idle-session cleanup.**
   Add and verify an index supporting the sweeper's `terminated_at`, `last_write_at`,
   and `started_at` predicates. Use `EXPLAIN QUERY PLAN` and a representative data set
   to confirm the index is selected.

8. **Bound and persist the AI queue.**
   The one-at-a-time queue controls vendor cost but is currently in memory. Persist
   queued/running jobs, cap intake, expose queue depth, and make restart recovery
   explicit. Never lose a submitted recording because the process restarted.

9. **Measure synchronous database blocking.**
   `node:sqlite` synchronous calls block the event loop. Add timing/slow-query
   instrumentation first. Move expensive work to an async database driver only when
   measurements justify the complexity.

### P2 — maintainability and operational maturity

10. Add request IDs, structured logs, and latency/error metrics around content serving,
    runtime writes, webhook delivery, and AI jobs.
11. Add integration tests for concurrent launches, duplicate webhooks, interrupted
    downloads, large media, sweeper races, and dashboard query volume.
12. Define retention and archival rules for xAPI statements, recordings, transcripts,
    generated PDFs, and failed delivery records.
13. Document the supported deployment topology, backup/restore procedure, and the
    maximum expected demo/caseload size for the SQLite deployment.

## Database migration plan

The SQLite-to-Microsoft-SQL-Server migration plan lives in
[`SQLITE-TO-SQL.md`](SQLITE-TO-SQL.md). Keep database-driver work separate from the
application architecture refactor so each change has a small, testable blast radius.
