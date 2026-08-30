# Moving to Azure Government

The DigitalOcean box was a weekend solution to a demo problem. This is what a
real environment needs, what carries over, and what has been deliberately left
for this move rather than built twice.

**Read [`SQLITE-TO-SQL.md`](SQLITE-TO-SQL.md) alongside this.** It covers the
data-layer mechanics — the async conversion, transactions, types, migrations —
in detail and is not repeated here.

---

## What is being moved

Three Node processes, no dependencies beyond Node itself, one SQLite file, and
a reverse proxy.

```
Waypoint        the LMS — content, registrations, SCORM runtime      :8090
Content         uploaded course packages, a SEPARATE ORIGIN          :8091
Northwood       the corrections system — a customer of Waypoint      :8092
doorman         the IP allowlist front door                          :8099
Caddy           TLS, per-hostname routing, the allowlist
```

The important structural facts, because they constrain the target:

- **Content must stay on a different hostname.** Not a path, not a port — a
  hostname. Uploaded SCORM packages are third-party code that this system
  executes, and same-origin means a course can read the signed-in session.
  The server refuses to start if the two share a host. This survives the move
  or the move has broken the security model.
- **Northwood reaches Waypoint over HTTP**, never through its tables. Enforced
  in the module graph by `check-boundary.mjs`.
- **Northwood must reach Waypoint internally** — see
  `WAYPOINT_APP_INTERNAL_ORIGIN`. Routing that call to the public hostname sent
  it back through the proxy to be judged by the allowlist, and the server was
  refused entry to itself. In containers this becomes a service name.

---

## The three decisions already made

Your senior engineer has said containers and SQL. Both are right. Neither is
free, and one of them is bigger than it looks.

### Containers

Straightforward. There are no native dependencies, no build step for the API,
and the whole thing is Node plus `unzip`.

What needs deciding:

- **Content and uploads cannot live in the container.** Course packages, visit
  audio and photographs are on disk today under `WAYPOINT_DATA_DIR`. In a
  container that has to be Azure Files or Blob Storage, and the content server
  changes from "read a file" to "read an object". Blob is the better answer and
  the bigger change.
- **One container or three?** Three processes today. Three containers is
  cleaner and makes the content-origin separation structural rather than
  conventional. It also means the internal origin becomes real service
  discovery instead of loopback.
- **`unzip` is a runtime dependency.** `ingest.mjs` shells out to it. Either it
  goes in the image or that code moves to a library.

### SQL

The larger piece, and `SQLITE-TO-SQL.md` covers it properly. The headline: the
work is **one hard change and a handful of small ones**, and the hard change is
not the SQL — it is that `node:sqlite` is synchronous and every SQL driver is
asynchronous. Roughly 250 call sites and 233 exported functions.

**Do the async conversion first, still on SQLite, and ship it.** Then swap the
driver as a one-file change. Two risky things at once is how a migration turns
into a fortnight.

### Azure Government specifically

Worth confirming early rather than discovering late:

- **Which SQL.** Azure SQL Database (SQL Server) and Postgres Flexible Server
  are both available in Gov, and the dialect notes in `SQLITE-TO-SQL.md` assume
  Postgres. If it is SQL Server, the identity columns and `string_agg` notes
  change.
- **Region and data residency.** Gov regions are a subset. Whatever the
  compliance requirement is, it constrains region before it constrains anything
  else.
- **FedRAMP / StateRAMP posture.** Nobody has told us what this system is
  expected to meet. It determines audit retention, encryption requirements and
  whether the AI calls below are permissible at all.
- **Managed identity over connection strings.** Gov supports it and it removes
  the secret we would otherwise have to rotate by hand.

---

## The thing containers and SQL do not solve

**A container does not give you an audit trail, and SQL does not revoke a
token.** Both were named as platform work; neither is. Worth saying explicitly
in the design conversation.

Two were built before this move, deliberately, because they had to exist in the
data layer and would have been rewritten otherwise:

### Done — carries over unchanged

**Revocable subject sessions.** The subjects' session was a stateless HMAC: no
table, and no way to end it. A lost phone meant waiting out twelve hours with
nothing an officer could do. It is now a server-side row with a revoked flag,
`POST /api/auth/logout` for one device and `POST /api/people/end-sessions` for
all of them. Just a table; it migrates with everything else.

**An audit log.** `db/audit.mjs`, one writer, recording who opened whose file
and who listened to which recording. Deliberately not a query log — it records
reads of a *person's* record, the thing with a subject entitled to ask "who has
been looking at my file".

It was written now for one reason: **retrofitting it after real records exist
is archaeology.** There is no way to reconstruct who read what last year. The
table is small and the call sites are few; the value is that they exist before
there is anything worth auditing.

---

## Deferred to this move, on purpose

Each of these is cheaper to do once, against the real data layer, than to build
now and rewrite in a fortnight.

### Persistent rate limiting

Failed sign-ins are counted **in memory** today, so a restart forgives them,
and two app instances would each count separately. Fine on one process. The
moment there is a server database it is a small table and a query.

Both logins are throttled: five attempts, fifteen minutes. The staff side uses
the `officers` table already; only the subject side is in memory.

**Do it with the async conversion**, not before.

### Secret management

`WAYPOINT_API_KEY`, `WAYPOINT_WEBHOOK_SECRET`, `WAYPOINT_SESSION_SECRET`, the
STT and LLM keys, and the door passphrase hash all live in `/etc/waypoint.env`
on the box. There is no rotation procedure.

**This is Key Vault and it does not exist until we are in Azure.** Anything done
now against an env file is thrown away. What to plan for:

- The session secret **must survive a restart** — regenerating it signs
  everybody out mid-course. It is currently a file at mode `0600`.
- The API key and webhook secret are the credentials Northwood holds. Rotating
  them means coordinating two systems, which is an argument for managed
  identity where possible.
- **Rotation must not be a deploy.** If changing a key requires a release, it
  will not happen.

### Real accounts for the Waypoint console

The LMS's own admin view authenticates with the shared API key. It reads every
registration in the system, so one shared credential means no answer to "who
looked at this". It wants the same session machinery the officer console
already has — worth writing once, against the new database.

Until then it is behind the API key and the network allowlist, which is
adequate for a demo and not for anything else.

### Roles and need-to-know

Every officer can see the roster and their whole caseload. There is no
supervisor tier and no restriction on which officer may open which file beyond
assignment.

**This is a product decision as much as a security one**, and nobody has told
us what a supervisor may see that an officer may not. Guessing now builds the
wrong thing. It does need answering before real data.

### Backups and recovery

There is no backup of the demo box beyond manual snapshots taken by
`waypoint-demo`. Azure gives point-in-time restore on managed SQL almost for
free, which is most of the answer — but **a restore that has never been tested
is not a backup**, and the content and audio in Blob need their own retention
decision.

---

## What changes operationally

| Today | After |
|---|---|
| IP allowlist in Caddy, self-service front door | Azure networking, or App Gateway / Front Door |
| `rsync` and `systemctl restart` | a pipeline, an image, a rollout |
| SQLite file beside the app | managed SQL, with its own backup story |
| Content and audio on local disk | Blob Storage |
| Secrets in `/etc/waypoint.env` | Key Vault, ideally managed identity |
| Schema built at boot by `CREATE TABLE IF NOT EXISTS` | migration files, applied by the pipeline |
| One process, no concurrency | a pool, transactions, and two instances that can race |

**The schema-at-boot change is not optional.** It is genuinely good for a
single-process PoC — idempotent, no drift — and it does not survive two app
servers starting at once. Take a schema snapshot as migration `0001` rather
than reconstructing forty migrations from history; `CLAUDE.md` carries the scar
from a project that accumulated 200 unrunnable migration files.

---

## The AI calls need a decision before Gov

Transcription and summarising currently leave the building: audio goes to a
speech-to-text endpoint and the transcript goes to a language model.

**In a government environment that is a policy question before it is a
technical one.** The code was built for this: both are a URL and a key, the
client speaks the OpenAI-compatible shape that most self-hosted servers also
speak, and the seam is one module (`northwood/ai.mjs`). Pointing it at Azure
OpenAI in a Gov region, or at something self-hosted, is configuration.

But somebody has to decide whether a recording of a supervision conversation
may be sent anywhere at all, and the answer changes the architecture if it is
no. **Ask early.** With no key set, both features report themselves off and the
console hides the buttons, so "not yet" is a supported state.

---

## Suggested order

1. **Confirm the Gov constraints** — region, which SQL, compliance posture, and
   whether the AI calls are permissible. These change the design, not the
   implementation.
2. **Move the two leaked queries into `db/`** so the chokepoint is whole again.
   Half a day, and it makes everything after it a one-layer change.
3. **Type audit.** Find every value that does not match its declared column
   type. SQLite let them through; SQL will not. Every rejection is a bug that
   already exists.
4. **Async conversion, still on SQLite.** Ship it. Live on it for a week. This
   is the bulk of the work and the only genuinely risky part.
5. **Schema snapshot as migration 0001**, plus migration tooling.
6. **Transactions around the multi-statement writes.** `finishSummary` is the
   sharpest — a failure midway leaves a summary marked done with only some of
   its action items, and the officer cannot tell the list is short.
7. **Containerise**, with content and audio moved to Blob.
8. **Swap the driver.** An afternoon, if 2–6 were done properly.
9. **Then the deferred items above** — persistent rate limiting, Key Vault,
   console accounts, roles.

Steps 2–4 are most of the effort. Step 8 is the one that sounds like the
migration and is the smallest part of it.

---

## What must not be lost in the move

A short list, because these are the things that are cheap now and structural
later, and every one of them exists because getting it wrong cost somebody
something:

- **Content on a separate origin**, enforced at startup
- **Complete ≠ Passed** — two columns, never collapsed into one status
- **`suspend_data` stored byte-for-byte**, never parsed or trimmed, with
  overflow recorded rather than silently truncated
- **Attempts are rows**, not overwritten fields
- **Launch tickets** — short-lived, single-use, server-minted
- **The Northwood boundary**, enforced in the module graph
- **The four standing checkers**, which each exist because the thing they check
  had already gone wrong once

`CLAUDE.md` is the full list and the reasons.
