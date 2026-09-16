# CodeRabbit workflow

CodeRabbit is an automated AI reviewer connected to the Waypoint GitHub
repository. It reviews pull requests, comments inline on the changed lines,
summarizes the change, and can incorporate the results of GitHub Actions and
other checks. It may review new commits incrementally as a pull request is
updated.

## Where it fits

CodeRabbit is one layer in the review process; it does not replace tests,
the project-scoped Codex reviewer, or human approval.

1. Work on a feature or hotfix branch.
2. Run the checks in `CONTRIBUTING.md` locally.
3. Ask the read-only Codex reviewer to inspect the complete diff.
4. Push the branch and open a pull request into `main`.
5. Let CodeRabbit review the pull request and address any blocking findings.
6. Obtain human approval and merge the pull request.
7. Deploy only the reviewed merge commit to the demo host.

The Codex reviewer is an independent pre-push review focused on Waypoint's
identity, authorization, data-safety, and system-boundary rules. CodeRabbit is
the persistent GitHub review layer that comments on the pull request and can
re-review later commits. Tests remain the executable quality gate.

## Useful commands

CodeRabbit reviews pull requests automatically when enabled. These comments can
be used when a review needs to be started or refreshed:

```text
@coderabbitai review
@coderabbitai full review
@coderabbitai summary
```

Use `full review` when a complete review from scratch is genuinely needed;
ordinary updates should use the incremental review. `@coderabbitai pause` and
`@coderabbitai resume` control review activity for a pull request.

CodeRabbit can generate fixes with `@coderabbitai autofix`. Treat that as a
proposal: inspect the resulting commit, rerun the Waypoint checks, and have the
reviewer inspect the updated diff. Prefer `@coderabbitai autofix stacked pr`
when the change is substantial so the generated fix remains separately
reviewable.

## Repository guidance

CodeRabbit detects the repository's `CLAUDE.md` and `AGENTS.md` guidance and can
use those files as review criteria. Keep durable engineering rules there and
keep product behavior and architecture decisions in `docs/`.

If repository-specific tuning becomes necessary, add a root
`.coderabbit.yaml` file and commit it with the change. Useful controls include
whether draft pull requests are reviewed, target branches, ignored labels, and
path-specific review instructions. Keep the configuration narrow and
version-controlled rather than silently relying on personal UI settings.

## Guardrails

- A CodeRabbit approval does not override a failing test or a P0/P1 finding.
- Do not allow automated fixes to bypass human review or branch protection.
- Never use CodeRabbit to run destructive database resets, seed shared data, or
  deploy directly to the demo host.
- Keep its GitHub installation limited to the Waypoint repository where
  possible. Review the requested read/write permissions before granting access.
- Do not put credentials, production data, local databases, or private demo
  deployment files in the repository or in review prompts.

See [`docs/CODE-REVIEW.md`](CODE-REVIEW.md) for the Codex review gate and
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for the required checks and deployment
boundary.
