# Security

What Waypoint protects, how, and what it does not protect yet.

**Status: proof of concept.** Some of what follows is production-grade because
it was cheaper to do right the first time. Some of it is explicitly not, and is
named as such — the last section is the honest list of what has to change
before this holds real data.

Verified against the running system on 30 August 2026. Every claim here is
asserted by a test; see [Proving it](#proving-it).

---

## What is being protected

Waypoint is an LMS. Northwood is a corrections case-management system that is a
*customer* of it. The data is:

- **Who is under supervision**, their address, employment, vehicles, contacts
- **What was said** in a home visit — audio, transcripts, summaries
- **What they must do** and whether they have done it
- **What training they are enrolled on** and how they scored

The subjects are people under criminal justice supervision. "Who is enrolled on
what" is not a neutral listing, and neither is "where they live". Most of the
decisions below follow from that rather than from a generic threat model.

### Who the actors are

| Actor | Holds | Can reach |
|---|---|---|
| **Officer** | staff session (cookie or bearer) | their own caseload |
| **Subject** | Waypoint token (bearer) | their own record, nobody else's |
| **Northwood** (the server) | API key | Waypoint's API, as an integrator |
| **A course** | a runtime session, scoped to one registration | that registration's data model |
| **Anyone on the internet** | nothing | the sign-in pages, and nothing else |

---

## Three credentials, deliberately separate

Conflating these is how one credential ends up able to do everything.

### 1. The API key — Northwood → Waypoint

Server to server, never in a browser. It provisions people, assigns programmes
and mints launch tickets. Held by the Northwood process; the Northwood *page*
never sees it, which is the reason Northwood is a server and not a static site.

`northwood/shared.mjs` is the only place it is used, and
`check-boundary.mjs` proves Northwood has no import path into Waypoint's
tables — the integration contract is enforced in the module graph, not by
convention.

### 2. The subject's token — the app and learner site

A bearer token, because the app talks to two origins and cannot rely on
cookies. A **server-side row**, and only its SHA-256 hash is stored.

- **12 hours**, and **revocable**.
- `POST /api/auth/logout` ends this device's session. Idempotent — a client
  retrying after a dropped connection must not be told signing out failed.
- `POST /api/people/end-sessions` ends every session a person has, on every
  device. It carries the **API key**, not the subject's own token: this is an
  officer acting after a phone is lost, not a person signing themselves out.

This was a stateless HMAC until 30 August 2026. That needed no table and could
not be ended — a subject who lost their phone had one answer, wait twelve
hours, and an officer had nothing they could do for them meanwhile. Staff
sessions had been revocable rows since they existed; the session that opens a
person's own supervision record, from the device most likely to be lost, was
the weaker of the two.

### 3. The staff session — the officer console and app

An `httpOnly` cookie in the browser, the same token as a bearer for the native
app; both resolve to one server-side row, so signing out kills either.

- **8 hours**, server-side, and therefore **revocable**.
- Only a SHA-256 **hash** of the token is stored, so a database leak does not
  hand over live sessions.
- `Secure` is set from the origin, never configured separately — a `Secure`
  cookie over plain http is silently dropped, and the symptom is "sign-in does
  nothing".
- `SameSite=Lax`.

### And a fourth thing that is not a login: the launch ticket

A course is launched with a **single-use, 60-second, server-minted ticket**
bound to one registration. It replaces the "customer id in the URL" pattern,
where changing a number makes you somebody else. Redeeming validates and
consumes in one step and distinguishes unknown from expired from already-used.

The session it mints is scoped to **one registration**: a valid session for
registration 7 cannot write to 8.

---

## Authentication and authorisation

### Everything is gated in one place

Northwood gates every `/api/` route except `/api/me/*` (which carries a
Waypoint token) and the webhook (which carries an HMAC). One gate, so a new
staff route is protected by default rather than by whoever adds it remembering.

### A subject cannot reach another subject

Verified by test, not by inspection:

- `/api/me/*` resolves the caller from their token. Passing `subject_id` in a
  query or body is **ignored** — the token decides.
- Recordings and photographs check that the visit belongs to the caller.
- Action items, visit acceptance and signatures are all scoped by subject.

Northwood does not trust what the app claims about who it is; it asks Waypoint
over HTTP (`subjectFromToken`), because Northwood has no access to Waypoint's
tables.

### Sign-in is throttled

Five failures, fifteen minutes, on **both** logins. Counted against the
identifier that was *tried*, whether or not it exists — counting only real
accounts would answer "is this an account?" through timing and behaviour, which
is what the identical error message exists to prevent.

Both logins answer the same way for an unknown account and a wrong password.

---

## Uploaded course content is third-party code

A SCORM package is a zip of working web pages and scripts that gets unpacked
and executed. Trusting the uploader is not the same as trusting the file.

### Origin isolation

Course content is served from a **different origin** than the application.
Same-origin would let a course's JavaScript read the signed-in session and act
as the user — Rustici's commercial engine shipped exactly that bug and it
allowed account takeover.

**This is checked at startup: the server refuses to boot if the content origin
shares a host with the app origin.** Written down, it would eventually be
worked around "just for now"; that temporary fix *is* the vulnerability.

### Content Security Policy

Two policies. The player may connect to exactly one other origin and frame
exactly one. Content gets `script-src 'unsafe-inline' 'unsafe-eval'` — real
authoring tools emit both and there is no way around it — but `connect-src
'self'`, so a course cannot call out, and `form-action 'none'`, `base-uri
'none'`.

### Content types are allowlisted, never sniffed

Anything not on the list is served `application/octet-stream` with `nosniff`,
so a package cannot talk the browser into executing something by naming it
cleverly.

### Ingestion, before a byte is extracted

| Check | Limit |
|---|---|
| Paths escaping the root (zip-slip) | rejected — `/`, `\`, `..`, `C:` |
| Entry count | 10,000 |
| Uncompressed size | 2 GB |
| Compression ratio | 100:1 |
| Server-executable extensions | `.php .jsp .asp .cgi .pl .py .rb .sh .exe .dll` rejected |

**No XML parser is involved**, so there is no XXE surface: the manifest is read
with regular expressions.

---

## Transport and network

The demo deployment sits behind Caddy with Let's Encrypt certificates. The
application servers bind to `127.0.0.1` — the proxy is the only way in, so a
flushed firewall rule is not the only thing between the internet and an
unauthenticated port.

**Access is restricted to known addresses**, enforced in Caddy per hostname
rather than in the firewall per port, so the one page that must stay open —
the front door — still gets TLS.

The front door (`spike/ops/doorman.mjs`) takes a scrypt-hashed passphrase and
adds the address the request arrived from. It reads the address rather than
asking for one, because a field to type an IP into is a field to type the wrong
IP into. Grants expire after 7 days and are swept hourly. Five wrong
passphrases locks an address out for fifteen minutes.

### Request limits

Bodies are capped on the declared `Content-Length` **and** while streaming, so
a lying or absent length does not get through. Photographs 6 MB, audio 25 MB,
everything else 1 MB.

### CORS

Pinned to a single named origin on both servers. Never `*`. `Authorization` is
named in `Access-Control-Allow-Headers`, because it is not CORS-safelisted and
every authenticated call fails at preflight without it.

---

## Data at rest

- Passwords: **scrypt**, 64-byte output, per-credential 16-byte salt, compared
  with `timingSafeEqual`.
- Staff session tokens: SHA-256 hashed, never stored raw.
- The session signing secret: `0600`, beside the database.
- `suspend_data` is stored byte-for-byte and never parsed, transformed or
  re-encoded. It is the course's private state and the only job is to hand back
  exactly what was given.
- The database is a SQLite file readable only by the service account, in a
  directory the systemd unit is confined to (`ProtectSystem=strict`).

**Audio, transcripts, summaries and photographs are append-only.** Nothing in
the application deletes evidence.

---

## What was found in the 30 August sweep

Three real findings, all fixed and now asserted by tests.

### 1. Unauthenticated exposure of every training record — high

`/api/console/registrations` and `/api/console/deliveries` answered any caller
with no credential: every registration, subject ids, scores, completion state
and resume data.

Beyond the direct disclosure, it made the gate on every other read decorative —
the data those endpoints protect was available two paths over.

**Fixed:** both require the API key. The console page holds the key in a plain
variable for the tab and asks again on reload. Not `localStorage` or
`sessionStorage`: this project has already been bitten by caching a credential
"so it survives a reload", which meant it also survived becoming invalid and
looked exactly like a working one.

### 2. No brute-force protection on the subjects' sign-in — medium

Staff sign-in has locked out after five wrong answers since it existed. The
subjects' login — the credential that opens a person's supervision record from
a phone — had nothing. The weaker-protected door was the one in front of the
more sensitive room.

**Fixed:** five attempts, fifteen minutes, per identifier.

### 3. The API key was written to the system log on every boot — low

It accumulated in `journalctl`, outlived the key, and survived rotating it.

**Fixed:** printed in full only when it was *generated* — a development run
with nothing configured, where it has to be shown or nothing can call the API.
A key from the environment prints as a six-character prefix.

### Checked and clean

Every other endpoint refuses anonymous callers; no cross-subject access is
possible; CORS is pinned; body limits hold both ways; zip handling covers
slip, bombs, entry counts and executable extensions; there is no XXE surface;
CSP and origin isolation are enforced at boot; no secrets are committed; errors
return no stack traces.

---

## Known limitations

These are deliberate for a proof of concept and must be revisited.

**Login throttling is in memory.** A restart forgives it. The same trade the
front door makes, and it wants a table once there is a server database.

**The Waypoint console authenticates with the API key**, not with a user
account. It is an admin view for the team, and one shared credential means no
audit trail of who looked at what.

**The audit log is young and narrow.** It records case files opened, recordings
played, and sign-in, sign-out and revocation. It does not yet cover writes, and
nothing reads it back — there is no screen and no retention policy. It exists
now because retrofitting one after real records exist is archaeology.

**Single tenant by decision.** There is no tenant scoping because there is one
customer. The data-access chokepoint is what makes adding it survivable; the
column was never the expensive part.

**Access control is network-level, not role-level.** Every officer can see
every subject in their caseload and the roster; there is no supervisor tier, no
need-to-know boundary, and no restriction on which officer may open which file
beyond caseload assignment.

**No secret management.** Keys come from an environment file on the box. There
is no rotation procedure and no vault.

**Demo data only.** The deployed instance holds invented people. Nothing here
has been reviewed for handling real supervision records.

---

## Before this holds real data

In rough order of how much they cost to retrofit:

**Done, ahead of the Azure move**, because both had to live in the data layer
and would otherwise have been built twice:

- ~~An audit log~~ — `db/audit.mjs`, recording reads of a person's record
- ~~Revocable subject sessions~~ — a table with a revoked flag, and two
  endpoints to use it

**Still outstanding**, and deliberately deferred to Azure:

1. **Widen the audit log** to writes, and decide retention.
2. **Persistent rate limiting**, surviving restarts and shared between
   instances.
3. **Secret management and rotation** — the API key, webhook secret and session
   secret live in a file and never change. This is Key Vault, and it does not
   exist until we are in Azure.
4. **Real accounts for the Waypoint console**, so admin actions have a name
   against them.
5. **Role and need-to-know boundaries** within a caseload — a product decision
   before a security one.
6. **Backups with point-in-time recovery**, and a *tested* restore.
7. **Dependency and image scanning**, once this is in a container.

See [`AZURE-MIGRATION.md`](AZURE-MIGRATION.md) for why each waits, and what a
container and a SQL server do **not** solve on their own.

---

## Proving it

Everything asserted here is covered by a test. None of it is checked by hand.

```bash
node spike/api/smoke.mjs          # 391 assertions, end to end
node spike/api/test-ingest.mjs    # 15 hostile packages
node spike/api/check-boundary.mjs # Northwood cannot import Waypoint
node spike/api/check-docs.mjs     # no undocumented routes
node spike/api/check-feedback.mjs # no write completes silently
node spike/api/test-sweeper.mjs   # sessions that never said goodbye
node spike/api/test-insights.mjs
```

Both suites run against throwaway databases of their own, so running them is
safe. Smoke **fails if fewer than 250 assertions run** — a suite that quietly
stops testing most of itself while still reporting "0 failed" is worse than one
that fails, and that had already happened once.

Security coverage:

| Covered by | What |
|---|---|
| `smoke.mjs` | console endpoints refuse anonymous and wrong keys |
| | sign-in lockout fires, and is per-account |
| | API endpoints refuse missing and wrong keys |
| | launch tickets expire, cannot be replayed, cannot be invented |
| | a valid runtime session cannot write to a different registration |
| | recordings and photographs refuse an anonymous caller |
| | signing out ends the session, and doing it twice is not an error |
| | ending a person's sessions signs out every device, and needs the API key |
| | `suspend_data` round-trips byte for byte, and over-cap is stored in full |
| `test-ingest.mjs` | zip-slip: `../`, nested `../../`, absolute, Windows, backslash |
| | zip bomb — 8 MB of zeros at 1025:1 |
| | server-executable content: `.php .jsp .sh .exe .aspx` |
| | more than 10,000 entries |
| | a file that is not an archive at all |
| | and an ordinary package still passing, so the checker is not simply refusing everything |

### A note on how these fixtures exist

The hostile archives are **built at test time, not committed**. A repository is
a bad home for a zip bomb — it is a file whose entire purpose is to be
dangerous when something unpacks it, and every scanner, backup and clone would
carry it. `test-ingest.mjs` writes the zip format directly for the same reason
`zip(1)` cannot be used: it normalises `../` out of entry names, which is the
exact thing under test.

**These tests did not exist before 30 August 2026.** `validateArchive()` — the
only thing between an uploaded package and this server's filesystem — had no
coverage at all. The nine-package corpus is legitimate exports from real
authoring tools, which prove the happy path and say nothing about the
adversarial one. That is the half that matters when the uploader is not the
author.
