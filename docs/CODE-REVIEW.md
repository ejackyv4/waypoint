# Codex Code Review Workflow

Waypoint has a project-scoped, read-only Codex reviewer that runs before Codex pushes a
branch. The goal is to add an independent review pass without allowing the reviewer to
modify the code it is judging.

## What is installed

| File | Purpose |
|---|---|
| [`AGENTS.md`](../AGENTS.md) | Tells Codex when review is required, what blocks a push, and which Waypoint-specific risks to check. |
| [`.codex/agents/reviewer.toml`](../.codex/agents/reviewer.toml) | Defines the independent `reviewer` agent and restricts it to read-only access. |
| `CODE-REVIEW.md` | Explains the workflow for maintainers. |

The agent inherits the main Codex session's model unless a model is explicitly selected
for the subagent. Keeping the reviewer read-only is intentional: it reports findings to
the main agent, which remains responsible for any approved changes.

## Normal use

Work with Codex on a feature branch, then say:

> Push this branch.

Before pushing, Codex must:

1. Inspect the complete intended change against the default branch.
2. Run the checks appropriate to the change.
3. Delegate the diff to the independent `reviewer` agent.
4. Stop and report any blocking finding or failed check.
5. Rerun checks and review after corrective edits.
6. Push only the current feature branch after the gate passes.

The final push report should name the branch and commits, list the checks that ran,
summarize the review result, and disclose anything that could not be validated.

## What blocks a push

- P0 or P1 review findings
- Failing tests, lint, type checks, or repository checks applicable to the change
- Credible data-loss or destructive-database risk
- Security or authorization defects
- A violation of the Northwood/Waypoint system boundary
- A direct push to `main`

P2 and P3 findings should still be reported. Codex may proceed only when they are
non-blocking and the final summary makes the remaining risk visible.

## Waypoint checks

Use the exact guidance in `../CONTRIBUTING.md`. The current check set includes:

```bash
node spike/api/smoke.mjs http://<local-host>:8090
node spike/api/test-sweeper.mjs
node spike/api/test-insights.mjs
node spike/api/test-visit-migration.mjs
node spike/api/check-boundary.mjs
node spike/api/check-docs.mjs
node spike/api/check-feedback.mjs
node spike/inspect.mjs spike/corpus
```

For documentation-only changes, run at least:

```bash
git diff --check
```

Do not use `./spike/demo reset` as an automatic validation step. It deletes and
recreates local demo data, and the repository's data-safety rules require destructive
operations to be explicit.

## Run a review without pushing

Use a prompt such as:

> Review this branch against main. Delegate the independent review to the Waypoint
> reviewer agent. Do not change files and do not push.

This is useful before committing or when a change is still in progress.

## GitHub pull-request review

The local workflow above runs when Codex performs the push. It does **not** intercept a
manual `git push` from another terminal, IDE, or Git client.

For a second review after pushing, connect the repository to Codex Cloud and enable
**Code review** and **Automatic reviews** in Codex settings. Codex will use the
`## Code Review Rules` section in `AGENTS.md` when reviewing the pull request. A review
can also be requested manually by commenting `@codex review` on the pull request.

GitHub automatic review is an account/repository setting and cannot be enabled solely by
committing these files. Tests, branch protection, and required human approvals remain
separate controls and should stay enabled.

## Troubleshooting

- Start a new Codex session from the Waypoint repository after changing `AGENTS.md` or
  agent configuration; instruction files are loaded when a session starts.
- If the reviewer is not invoked, explicitly say, “Delegate this to the project-scoped
  reviewer agent,” and confirm `.codex/agents/reviewer.toml` exists on the branch.
- If a check needs running services or a physical iPhone, Codex should report that gap
  rather than claiming the behavior was verified.
