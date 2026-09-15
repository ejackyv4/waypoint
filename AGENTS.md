# AGENTS.md — Waypoint

This file contains durable guidance for Codex. Read `CONTRIBUTING.md` before making
changes and read the relevant sections of `CLAUDE.md` for the engineering lessons and
data-safety rules that apply to the task. Treat `docs/` as the source of truth for
product behavior and architecture.

## Verification

- Run checks in proportion to the change, using the commands in `CONTRIBUTING.md`.
- For documentation-only changes, run at least `git diff --check`.
- For API changes, run the relevant focused checks and the smoke suite when the local
  services are available. Report any check that could not be run and why.
- Never run `./spike/demo reset`, seed shared data, recreate a database, or perform a
  destructive schema/data operation as an automatic test step.

## Push Workflow

Whenever the user asks Codex to push, publish, or send changes to Git:

1. Inspect `git status`, the commits and full diff against the repository's default
   branch, and any intended staged or unstaged changes. Do not include unrelated work.
2. Confirm the current branch is a feature branch. Do not push directly to `main` and
   never force-push unless the user explicitly requests it.
3. Run the applicable checks from `CONTRIBUTING.md`.
4. Delegate an independent review of the complete intended change to the project-scoped
   `reviewer` agent in `.codex/agents/reviewer.toml`.
5. Treat P0 and P1 findings, test failures, data-loss risks, security defects,
   authorization defects, and boundary violations as blocking. Do not push while a
   blocking issue remains. Fix it only when that work is within the user's request;
   otherwise report it and stop.
6. After any corrective edits, rerun the affected checks and ask the reviewer to examine
   the updated diff before pushing.
7. When the review and checks pass, push only the current feature branch. Report the
   branch, commits, checks run, review result, and any validation gaps.

These instructions apply when Codex performs the push. A manual `git push` from another
terminal or Git client does not invoke this agent workflow.

## Code Review Rules

### Data safety and storage

- Flag destructive schema/data behavior, implicit reset or seeding behavior, and any
  database path derived from a movable module location. Data paths must resolve from a
  fixed anchor, and destructive operations require explicit in-the-moment approval.

### System boundaries

- Northwood is a customer of Waypoint and must communicate through the HTTP integration.
  Flag imports of Waypoint internals, direct access to Waypoint-owned tables, or any
  bypass of that boundary.

### Identity, authorization, and derived state

- Flag code that trusts client-supplied identity, authorization, completion status, or
  other derived outcomes. The server must authenticate, authorize, resolve identifiers,
  and compute derived state.

### Course-content isolation

- Flag changes that weaken the separate-origin, CSP, ticket, or CORS controls around
  uploaded SCORM content. Uploaded packages are untrusted executable code.

### Regression coverage

- Flag consequential behavior changes without focused coverage when an automated check
  is practical. Keep formatting and other deterministic style checks in tooling rather
  than review comments.
