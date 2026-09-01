# Contributing to Waypoint

The canonical repository is:

```text
git@github.com:ejackyv4/waypoint.git
```

GitHub recognizes this file as the project's contributor guide. Read it before
making changes, then use [`docs/BUILD.md`](docs/BUILD.md) for the detailed local
environment and physical-iPhone setup.

## First checkout

```bash
git clone git@github.com:ejackyv4/waypoint.git
cd waypoint
git remote -v
```

The `origin` fetch and push URLs should both name `ejackyv4/waypoint`. Install
Node 22 or later. Mobile development also requires Xcode, CocoaPods, an Apple
Development signing identity and, for audio recording, a physical iPhone.

## Daily workflow

Start from an up-to-date `main` and do each piece of work on its own branch:

```bash
git switch main
git pull --ff-only
git switch -c <short-description>
```

Keep changes focused, run the relevant checks, push the branch, and open a pull
request into `main`. Do not commit secrets, local runtime data, generated native
projects or machine-specific configuration.

## Running locally

From the repository root:

```bash
./spike/demo start
./spike/demo phone     # physical iPhone development
./spike/demo sim       # simulator; microphone recording is not usable
./spike/demo status
./spike/demo stop
```

`./spike/demo reset` deletes and recreates the local demo database. Do not run
it against data you intend to keep, and never point development or smoke-test
commands at a shared hosted environment.

### The local mobile IP

A physical phone cannot reach the Mac at `localhost`. The demo script detects
the Mac's current LAN address and `./spike/demo phone` or `./spike/demo sim`
rewrites `WRITTEN_HOST` in `spike/mobile/config.js` as a fallback when Expo
cannot supply Metro's host at runtime.

That rewrite is local to the developer's machine and currently appears in
`git status` because `config.js` is tracked. **Do not commit that one-line IP
change.** Before committing, inspect the working tree and leave the file out of
the staged changes:

```bash
git status --short
git diff -- spike/mobile/config.js
git diff --cached --check
```

Production and hosted-demo builds do not use this LAN address; they use their
configured HTTPS origins. The tracked-IP fallback is a known development
workflow issue and should eventually move to ignored local configuration.

## Checks

Run checks in proportion to the change. The main API regression suite currently
contains 393 end-to-end assertions:

```bash
node spike/api/smoke.mjs http://<local-host>:8090
node spike/api/test-sweeper.mjs
node spike/api/test-insights.mjs
node spike/api/check-boundary.mjs
node spike/api/check-docs.mjs
node spike/api/check-feedback.mjs
node spike/inspect.mjs spike/corpus
```

For documentation-only changes, at minimum run:

```bash
git diff --check
```

Mobile UI and physical-device behavior still require manual testing. A native
rebuild is needed only after native dependencies or native configuration change;
ordinary JavaScript changes reload through Metro.

## Documentation and deployment access

- `README.md` is the front door.
- `docs/BUILD.md` explains local development and the system as built.
- `docs/LMS.md` explains SCORM behavior and compatibility decisions.
- `docs/API.md` documents the integration contract.
- `CLAUDE.md` records engineering lessons and traps already encountered.

The environment-specific `docs/DEPLOYMENT.local.md` is deliberately excluded
from GitHub. Only developers responsible for provisioning or operating the demo
environment need it, and it must be shared privately. Each operator must use
their own SSH credentials; private keys are never shared or committed.
