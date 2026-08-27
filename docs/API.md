# API guide

Two APIs, and it matters which is which.

| | | |
|---|---|---|
| **[Waypoint](#waypoint-the-lms)** | the LMS | content, registrations, results. What an integrator calls |
| **[Northwood](#northwood-the-corrections-system)** | the corrections system | subjects, visits, profile data. Internal to that app |

The Waypoint half is the integration contract and is stable. The Northwood half is the
demo application's own API, documented because it is the reference for building the real
one.

Companion to [`BUILD.md`](BUILD.md) (what exists) and
[`../CLAUDE.md`](../CLAUDE.md) (engineering rules).

---

# Waypoint (the LMS)

## What kind of API is this

**Plain REST over HTTPS, JSON in and JSON out.** No GraphQL, no SOAP, no SDK required.
Anything that can make an HTTP request can integrate — `HttpClient` in .NET, `curl`,
`fetch` in a browser.

| | |
|---|---|
| **Protocol** | HTTP/1.1, JSON bodies |
| **Auth** | Bearer tokens in the `Authorization` header |
| **Errors** | Standard status codes with `{ "error": "..." }` |
| **Versioning** | Not yet. Add `/v1/` before anything ships |
| **Content type** | `application/json` on every request with a body |

**Two origins, deliberately.** The application API and the course content are served from
**different hosts** — `app.…` and `content.…`. That is a security boundary, not a
deployment detail: an uploaded SCORM package is third-party JavaScript that we execute,
and same-origin would let it read the signed-in user's session. See
[BUILD.md § Why the content origin is separate](BUILD.md#why-the-content-origin-is-separate).

In the PoC those are ports 8090 and 8091.

---

## Authentication — four kinds, on purpose

Different callers get different credentials. Conflating them is how one credential ends up
able to do everything.

| # | Caller | Credential | Can do | Cannot do |
|---|---|---|---|---|
| 1 | **Your system → Waypoint** | **API key** | provision users, assign programs, issue launch tickets, read status, ingest content | — |
| 2 | **A learner → Waypoint** | **Person session**, 12h | see their own assignments, request a launch ticket for something assigned to them | write to any registration |
| 3 | **The player → Waypoint** | **Registration session**, 4h | read and write the runtime for **one** registration | touch any other record |
| 4 | **Waypoint → your system** | **HMAC signature** | deliver a completion | be replayed |

All four use the same header shape:

```http
Authorization: Bearer <token>
```

**Why 2 and 3 are separate.** Signing in gets you your list. It does **not** get you the
right to write results. That requires redeeming a single-use launch ticket, which mints a
session scoped to exactly one registration. A learner cannot write to their own record
directly, let alone anyone else's.

### API keys

Issued per integrating system. In the PoC it is set by environment variable:

```bash
WAYPOINT_API_KEY=wp_demo_key_123
```

**Server-side only.** Never put it in a browser or a mobile app — an embedded key is
extractable from any bundle. Your backend holds it and brokers the calls. The mock SaaS
demonstrates exactly this: it is a server, not a page, precisely so the key never reaches
the browser.

---

## Endpoints

### Your system → Waypoint

Every call here needs the API key.

#### `GET /api/health` — liveness

```
GET /api/health → { ok: true, ... }
```

Unauthenticated on purpose: a load balancer has no credentials.

#### `GET /api/content` — the catalog

What Waypoint can offer. Ingest this to build your own assignable list.

```bash
curl https://app.waypoint.example/api/content \
  -H "Authorization: Bearer $WAYPOINT_API_KEY"
```

```json
{ "content": [
  { "program_id": "golf-101", "title": "Golf Explained",
    "scorm_version": "1.2", "version": 1, "content_version_id": 3 } ] }
```

#### `POST /api/users` — provision a learner

Creates or updates the person, and issues a password **only if they do not already have
one**.

```json
{ "subject_id": "cust-1041",
  "name": "Dana Whitfield",
  "email": "dana@example.com",
  "password": "temporary-pass" }
```

`subject_id` is **your** identifier. Waypoint keys everything off it and hands it back on
every result, so you never have to store a Waypoint id.

The response carries `issued: true|false`. **A password you send is ignored when the
person already has one** — otherwise calling this again would silently invalidate a
login already in someone's hands. Show your generated password only when `issued` is
true; otherwise you never stored it and it does not work.

To deliberately replace an existing password, send `reset_password: true`. The old one
stops working immediately.

The password hash is never returned, even to a trusted caller.

#### `GET /api/logins` — who can sign in

```
GET /api/logins                      → { "subject_ids": ["cust-1041", ...] }
GET /api/logins?subject_id=cust-1041 → { "has_login": true,
                                         "login": "dana@example.com",
                                         "last_used_at": "..." }
```

One call for a whole roster, so marking who has an account costs the same at any size.

**A login belongs to the person, not to a program.** It is created once and survives
every assignment after it.

#### `POST /api/assign` — assign a program

```json
{ "subject_id": "cust-1041", "program_id": "golf-101" }
```

Returns the person, the program, the content version and the registration, plus
`needs_login: true` when the subject has no way to sign in yet.

**Relaunching a completed course starts a new attempt.** Some authoring tools leave
a finished course marked as suspended; resuming that record would return the attempt
that already says the learner passed, and the next write would overwrite it. Attempts
are separate rows. Accrued time carries forward; completion does not.

Assigning does **not** create a login. If the subject has none they cannot open what you
assigned — check `GET /api/logins?subject_id=` and provision them separately.

#### `POST /api/unassign` — cancel an assignment

```json
{ "subject_id": "cust-1041", "program_id": "golf-101" }
```

**Refused with `409` once the learner has started it** — at that point there is a record
of what they did, and deleting it would destroy evidence.

#### `POST /api/launch` — issue a launch ticket

```json
{ "subject_id": "cust-1041", "program_id": "golf-101" }
```

```json
{ "token": "9f35e6e8…", "expires_in": 60,
  "registration_id": 12,
  "launch_url": "https://content.waypoint.example/player?ticket=9f35e6e8…" }
```

**Open `launch_url` immediately.** The ticket is single-use and expires in ~60 seconds.

#### `GET /api/status` — live state of every assignment

The *pull* half of the integration. The completion webhook is the push; this catches
anything before a completion, and reconciles a delivery that was missed.

```json
{ "enrollments": [
  { "subject_id": "cust-1041", "program_id": "golf-101",
    "completion_status": "incomplete", "success_status": "unknown",
    "score_raw": null, "total_seconds": 135, "attempt": 1,
    "exit_mode": "suspend", "last_write_at": "2026-08-26T12:44:07.000Z" } ] }
```

**A real integration needs both.** Push for timeliness, pull for everything else.

#### `POST /api/ingest` — add content

```json
{ "zip": "/path/to/course.zip", "program_id": "golf-101", "title": "Golf Explained" }
```

Validates before unpacking anything (zip-slip, size caps, compression ratio, executable
files, manifest position), then creates an **immutable content version**. Re-ingesting the
same program creates version N+1 — learners mid-progress keep the version they started on.

Rejections are specific: `no trackable content: 19 resources, all assets, no SCO` rather
than "invalid package".

---

### Learner endpoints

Used by your web app or mobile app after the learner signs in.

```
POST /api/auth/login          { identifier, password } → { token, person }
GET  /api/me                  the signed-in person
GET  /api/me/assignments      their programs, with status
POST /api/me/launch           { program_id } → { launch_url }
```

Two properties worth knowing:

- **A learner can only launch a program actually assigned to them.** Guessing a
  `program_id` returns `403`.
- **Wrong password and unknown account return an identical response**, so the endpoint
  cannot be used to discover who has an account.

---

### Runtime endpoints

`POST /api/runtime/redeem`, then `/api/runtime/:id/set`, `/api/runtime/:id/terminate`
and `GET /api/runtime/:id`. Called by the player on the content origin, carrying a
registration-scoped session token — never the learner's session.

Called by the player, not by you. Listed for completeness.

```
POST /api/runtime/redeem      { token } → { session, registration, content }
POST /api/runtime/:id/set     { key, value }      persisted immediately
POST /api/runtime/:id/terminate
```

**Every `set` is persisted immediately.** SCORM courses frequently never call `Commit` —
one real course wrote five bookmarks and zero commits in 244 seconds — so durability
cannot be delegated to the content.

Four behaviours here are contracts, not implementation details. Each one is the
answer to something a real authoring-tool export actually does:

**`session_time` is replaced, never accumulated.** `cmi.core.session_time` is the
elapsed time of the *current session*, rewritten as it grows — it is not a delta. A
course that commits periodically sends an increasing value many times. Adding them
would sum a growing series. The session clock is held separately and folded into the
total when the session closes, which is the moment SCORM says time accrues.

**Writes after `terminate` are refused with `409`.** SCORM makes the API unusable
after `LMSFinish`, and courses call it anyway. Accepting those writes would let the
same seconds be counted again on the next exit.

**`cmi.core.entry` tells the course what kind of visit this is.** A registration left
suspended is announced as `resume`; anything else is `ab-initio`. Announcing
`ab-initio` while returning `suspend_data` is a contradiction, and a strict course
answers it by discarding the saved state.

**`suspend_data` is stored whole, never truncated.** SCORM 1.2 caps it at 4,096
characters and real courses exceed it. Truncating to fit is what silently destroys
resume, and the learner is who discovers it. Waypoint stores the full value, records
its length, stamps `suspend_overflow_at` the first time it exceeds the cap for that
SCORM version, and warns in the log.

---

## The completion webhook

When a learner finishes, Waypoint calls **your** endpoint, server to server. The learner's
device is never involved — otherwise anyone with a proxy could report their own pass.

```http
POST https://your-system.example/waypoint/webhook
Content-Type: application/json
X-Waypoint-Timestamp: 1787733780612
X-Waypoint-Signature: v1=aG1hYy1zaGEyNTY…
```

```json
{
  "subject_id": "cust-1041",
  "program_id": "golf-101",
  "registration_id": 12,
  "attempt": 1,
  "completion_status": "completed",
  "success_status": "passed",
  "score": { "raw": 93, "min": 0, "max": 100 },
  "total_seconds": 442,
  "total_time_scorm": "0000:07:22.00",
  "completed_at": "2026-08-25T20:19:47.451Z"
}
```

### Verifying it

The signature is `HMAC-SHA256` over `"{timestamp}.{raw body}"` using the shared secret.

**Verify against the raw body**, before any JSON parsing or re-serialising — re-encoding
changes the bytes and the signature will not match.

```csharp
public bool VerifyWaypointWebhook(string rawBody, string timestamp,
                                  string signature, string secret)
{
    // Reject anything outside a few minutes, so an intercepted delivery
    // cannot be replayed later.
    var sent = DateTimeOffset.FromUnixTimeMilliseconds(long.Parse(timestamp));
    if (Math.Abs((DateTimeOffset.UtcNow - sent).TotalMinutes) > 5) return false;

    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
    var expected = Convert.ToBase64String(
        hmac.ComputeHash(Encoding.UTF8.GetBytes($"{timestamp}.{rawBody}")))
        .TrimEnd('=').Replace('+','-').Replace('/','_');   // base64url

    return CryptographicOperations.FixedTimeEquals(
        Encoding.UTF8.GetBytes(expected),
        Encoding.UTF8.GetBytes(signature.Replace("v1=", "")));
}
```

`spike/api/auth.mjs` exports `verifyWebhook()` — the working reference implementation.

### Rules for the receiving end

- **Be idempotent.** A retry must not issue a second certificate or double-count anything.
  Key on `registration_id` + `attempt`.
- **Return 2xx quickly.** Do the work afterwards; a slow endpoint looks like a failure.
- **Never trust an unsigned delivery.** Verify first, act second.
- **Expect retries.** A non-2xx is treated as a failure and recorded for redelivery.

---

## Errors

| Code | Means | Typical cause |
|---|---|---|
| `400` | Malformed request | missing a required field |
| `401` | Not authenticated | missing key or token |
| `403` | Authenticated, not allowed | wrong key, expired ticket, session for a different registration |
| `404` | No such thing | unknown assignment |
| `409` | Conflict with current state | cancelling a started program, replaying a ticket |
| `422` | Understood, cannot process | package rejected, no content for that program |

Always with a readable reason:

```json
{ "error": "This program has already been started and can no longer be cancelled." }
```

---

## A full integration, end to end

```bash
API=https://app.waypoint.example
KEY="Authorization: Bearer $WAYPOINT_API_KEY"
J="Content-Type: application/json"

# 1. what can we offer
curl -s $API/api/content -H "$KEY"

# 2. provision the person, and give them a login IF they do not have one.
#    Check `issued` — a password you send is ignored when one already exists,
#    so showing it unconditionally shows a password that does not work.
curl -s -X POST $API/api/users -H "$KEY" -H "$J" \
  -d '{"subject_id":"cust-1041","name":"Dana Whitfield",
       "email":"dana@example.com","password":"temp-pass"}'

# 3. assign. This does NOT create a login — they are separate acts, because a
#    login outlives every program the person is given.
curl -s -X POST $API/api/assign -H "$KEY" -H "$J" \
  -d '{"subject_id":"cust-1041","program_id":"golf-101"}'

# 4. when they click "start", issue a ticket and redirect to launch_url
curl -s -X POST $API/api/launch -H "$KEY" -H "$J" \
  -d '{"subject_id":"cust-1041","program_id":"golf-101"}'

# 5. poll status whenever you like
curl -s $API/api/status -H "$KEY"

# 6. the completion arrives at your webhook, signed
```

**Steps 1–5 are yours to call. Step 6 calls you.**

---

## Six rules for integrating

1. **The API key never leaves your server.** Your backend brokers every call.
2. **Launch tickets are single-use and expire in ~60 seconds.** Issue one at the moment
   the learner clicks, not in advance.
3. **`subject_id` is your identifier and the contract.** Waypoint stores it and returns it
   on everything, so you never need to hold a Waypoint id.
4. **A login belongs to the person, not the assignment.** Create it once, check
   `GET /api/logins` before minting another, and never persist a password you were told
   is shown once — it will outlive the password itself and look exactly like a working
   one.
5. **Take completions from the webhook, never from the client.** A device-reported pass is
   a device-controlled pass.
6. **Use both push and pull.** The webhook is timely; `GET /api/status` catches
   in-progress state and reconciles anything missed.

---

## PoC specifics

Running locally, the origins are:

| | |
|---|---|
| Application API | `http://<host>:8090` |
| Content origin | `http://<host>:8091` |
| Mock SaaS | `http://<host>:8092` |
| API key | `wp_demo_key_123` |

`GET /api/console/keys` shows the current key and webhook secret. The mock SaaS
(`spike/api/server.mjs`, the `saas` listener) is a **worked example of a correct
integration** — it holds the key server-side, pulls the catalog, provisions learners,
assigns programs and verifies signed webhooks. Reading it is faster than reading this
document.

**Not yet present, and needed before production:** URL versioning, rate limiting, key
rotation, automatic webhook retry with backoff, and per-key scopes. The `/demo` route —
which lets a browser mint its own launch ticket — must be deleted; it is precisely what
launch tickets exist to prevent.

---

# Northwood (the corrections system)

The demo application's own API, on port **8092**. Not part of the Waypoint integration
contract — documented because it is the reference for the real build.

## Authentication — three ways in

| Caller | Credential | Notes |
|---|---|---|
| **Staff, in a browser** | httpOnly session cookie | Set by `POST /auth/login`. JavaScript cannot read it, so an XSS bug on an admin page cannot steal a staff session |
| **Staff, in the mobile app** | Bearer token | Returned by the same login. **The same session row**, so signing out kills both |
| **A subject** | Their Waypoint token | Northwood asks Waypoint who the token belongs to rather than trusting the app — token introspection |

**Subjects have no Northwood account.** They never sign in to this system.

```
POST /auth/login     { email, password } → { user, token } + Set-Cookie
POST /auth/logout    revokes the session server-side
GET  /auth/me        the signed-in staff member
```

Sessions are stored server-side and only a **SHA-256 hash of the token** is kept — a
database leak yields hashes, not live sessions. Five failed attempts locks an account for
fifteen minutes. Wrong password and unknown account return an identical response.

Everything under `/api/` requires a staff session **except** `/api/me/*`, which is
subject-facing. Gating in one place means a new staff route is protected by default.

## Roles

`officers` carries a `role` — `officer`, `supervisor` or `admin` — and routes check
`allow(session, ...roles)`. An officer *is* a staff member, so it is one table with a
role rather than two kept in step.

## Endpoints

### Who writes what

Three patterns, and which one a module uses is a deliberate decision rather than
an accident of what got built first:

| Pattern | Modules | Why |
|---|---|---|
| **Officer writes, subject reads** | curfew, travel permit, community service, supervision agreement | Imposed on the subject. Letting them edit it would be letting them set their own conditions |
| **Subject writes, officer reads** | vehicles | Self-reported fact about their own property |
| **Both write one record** | employment, family contacts | Reported by the subject, verified by the officer |

Where both write, there is **one row, not one each**. Two copies would immediately
disagree about the same person's phone number with no way to tell which was right. The
row records who touched it last (`added_by` / `updated_by`), so the officer can see what
came from the subject without the list being split in two.

The subject's half of a dual-write module lives under `/api/me/*` and takes the
`subject_id` **from the token, never the body**. Both halves share one validator, so
neither side can be the lenient one that lets bad data in.

### Subjects and their profile

```
GET  /api/subjects                          the roster, each with has_login
GET  /api/subject/detail?subject_id=…       every profile module in one call
GET  /api/reference                         every dropdown's options, in one place
```

`/api/subject/detail` returns `vehicles`, `curfew`, `community_service`,
`travel_permit`, `employment` and `contacts` together, because the profile paints them
together. `/api/reference` returns supervision kinds and levels, obligation units,
condition categories, employment statuses, contact relationships, offices and officers —
one call rather than a copy of each list in each client.

#### The subject's own details

```
POST /api/subject   { subject_id, first_name, last_name, case_number, dob,
                      phone, email, address_line1, address_line2, city,
                      state, postal_code, intake_date, next_review }
```

**Merges** — only fields actually present are written, so a partial save cannot
blank the rest of the record.

**Demographics only.** `officer_id` is an allowlist omission, not an oversight:
which officer supervises someone is an assignment decision, not a form field,
and a payload that names it is ignored rather than obeyed.

**Dates are stored ISO (`YYYY-MM-DD`) and formatted on display.** Prose is
refused. A date stored as "17 April 1991" cannot be compared, sorted or turned
into an age — the same rule as normalising SCORM time at the boundary. The
console shows a birth date as *April 17, 1991 (35)*, because the age is what an
officer is actually checking.

#### Waypoint logins

```
POST /api/subject/login    { subject_id, reset? } → { credentials: { login, password } }
GET  /api/logins           proxied from Waypoint; adds has_login to the roster
```

**A login belongs to the person, not to a program.** Creating one is its own action,
separate from assigning work: assigning used to mint a password every time, which
silently invalidated the one already in the subject's hands.

Calling it twice is refused with `409` rather than quietly rotating the password.
`reset: true` replaces it deliberately; the old one stops working immediately. The
password is returned exactly once and is never stored client-side.

#### Vehicles — the subject maintains their own

```
POST /api/vehicles           { subject_id, id?, year, make, model, color, plate, state }
POST /api/vehicles/delete    { id }

POST /api/me/vehicles        the subject's own; subject_id comes from the token
POST /api/me/vehicles/delete { id }   404 unless the vehicle is theirs
```

Editing or deleting a row that is already gone returns `404`, not `200`. An `UPDATE`
matching zero rows used to answer `200` with an empty body, and both clients reported
"Vehicle saved".

`make` and `state` come from fixed lists in both clients — free text on one side means
"Chevrolet", "Chevy" and "chev" become three different makes in any report built later.
The make list ends in **Other**, which reveals a text box: a list that cannot express
someone's car is worse than free text.

#### Employment — both sides write

```
POST /api/employment      { subject_id, status, company_name?, address?, phone?, supervisor? }
POST /api/me/employment   the same record, written by the subject
```

`status` is `employed`, `self_employed` or `not_employed`. `employed` requires a
company name.

**Moving away from `employed` clears the employer fields server-side**, whatever the
client sends. A "not employed" row still naming last year's company reads as current
employment to anything that looks at the columns rather than the status.

`updated_by` records which side wrote it last, and the officer's console says so
outright: *"Last updated by Dana in their app. Verify before relying on it."*

#### Family contacts — both sides write

```
GET  (part of /api/subject/detail and /api/me/case)
POST /api/contacts           { subject_id, id?, name, relationship, phone, notes? }
POST /api/contacts/delete    { id }

POST /api/me/contacts        the same list, written by the subject
POST /api/me/contacts/delete { id }   404 unless the contact is theirs
```

`relationship` must be one of the 28 in `/api/reference` — family, partners, household
and support, ending in `Other`.

Phone validation is deliberately loose (seven digits or more). Formats vary by country,
and rejecting someone's real number is worse than storing an odd-looking one.

#### Obligations

```
POST /api/obligations        { subject_id, id?, kind, title, required_quantity, unit, status }
POST /api/obligations/delete { id }
```

**`obligations` is deliberately general.** Community service is `kind="community_service"`,
and action steps, imposed responses and treatment attendance are the same shape — a
requirement plus a status. They become rows here rather than three more tables. See
[SCHEMA-PLAN.md](SCHEMA-PLAN.md).

`status` is one of `todo`, `in_progress`, `complete`; anything else is rejected.

#### Curfew and travel permit

```
POST /api/curfew          { subject_id, active, start_time, end_time, notes? }
                          active with no times → 400
POST /api/travel-permit   { subject_id, level, expires_on?, notes? }
                          level: none | local | interstate | international
```

`level: "none"` never carries an expiry — "none" is a permission level, not one that
lapses into something else.

#### Downloading a document

```
GET /documents/:id     the PDF itself
```

Staff may fetch any document. **A subject may fetch only their own**, proven by their
Waypoint token rather than by asking nicely — the route resolves who the token belongs
to and compares it to the document's owner. Served `inline`, so it opens in the
browser's viewer rather than downloading.

### The supervision agreement

The conditions of supervision: a header, conditions grouped by category, the consequences
of breaching them, and two signatures.

```
GET  /api/agreement?subject_id=…       the agreement plus every dropdown it needs
POST /api/agreement/save               { id?, subject_id?, kind, supervision_level,
                                         start_date, end_date, office, officer_name,
                                         status?, violation_text? }
POST /api/agreement/condition          { agreement_id, id?, category, body }
POST /api/agreement/condition/delete   { id, agreement_id }
POST /api/agreement/condition/track    turn a condition into a tracked obligation
POST /api/agreement/sign               { id }   the officer signs
POST /api/agreement/pdf                { id }   render and file it to their documents
GET  /api/agreement/acknowledgments?agreement_id=…   every acceptance, newest first
GET  /api/agreement/acknowledgment?id=…              one, with the exact text accepted
```

**`save` merges.** Only fields actually present in the payload are written. A partial
save that blanked every omitted column is how an agreement lost its dates, level, office
and officer in one call.

**A draft cannot be activated unsigned** — activating a document nobody signed makes the
signature decorative.

#### Amendment withdraws the acknowledgment

The subject's acknowledgment referred to the text **as it stood**. So changing any term
or condition of an executed agreement clears `subject_signed_at`, stamps `amended_at`,
and asks them again. The response carries `amended: true` and the officer is told:
*"Saved — the subject must acknowledge the change."*

Changing `status` alone is **not** an amendment. Only the terms count: `kind`,
`supervision_level`, `start_date`, `end_date`, `office`, `officer_name`,
`violation_text`, and the conditions themselves.

#### What was acknowledged, not just that it was

```
POST /api/me/agreement/sign     the subject accepts; no body, identity from the token
```

Each acceptance writes an **append-only** row holding the full agreement text as it read
at that moment. Without it, "what did they actually agree to" is unanswerable after the
second amendment — and that is the question a revocation hearing turns on.

The snapshot is generated from the same blocks the PDF is built from. One rendering, two
outputs: a snapshot that could drift from the document would be worse than none.

Acknowledging twice is idempotent — the first timestamp stands.

### Visits

```
GET  /api/visits?subject_id=…    with each visit's note log attached
POST /api/visits                 { subject_id, scheduled_at, officer?, location?, notes? }
POST /api/visits/schedule        { id, scheduled_at, … }   give a request a date
POST /api/visits/complete        { id, officer?, note? }   timestamp taken server-side
POST /api/visits/note            { id, body, officer? }    append a note at any time
POST /api/visits/cancel          { id }
```

**Two different kinds of note, deliberately separate:**

- `visits.notes` — the instruction given to the subject beforehand
  *("bring proof of employment")*
- `visit_notes` — what the officer recorded afterwards

Different authors, different audiences. `visit_notes` is **append-only**: a correction is
a new note, never an edit, because the record of what was recorded when is itself
evidence.

### Northwood's own reads

```
GET /api/catalog       what Waypoint offers, proxied
GET /api/enrollments   live assignment state, proxied from Waypoint
GET /api/results       completions Waypoint has pushed to this system's inbox
GET /api/documents?subject_id=…   generated PDFs filed against a subject
```

The first two are proxies: the browser never holds the API key, so the console
asks Northwood and Northwood asks Waypoint. That indirection is the point —
it is what an integrator's own backend does.

### Officer views

```
GET /api/officer/schedule    { upcoming, requests, recent } for the signed-in officer
GET /api/officer/caseload    their subjects, with visit counts
```

Scoped to the session — an officer cannot ask for somebody else's caseload.

### Subject-facing — a Waypoint token, no staff session

```
GET  /api/me/case?seen=1          everything they can see. seen=1 clears the visit badge
POST /api/me/visits/accept        { id }   scoped to their own visits
POST /api/me/visits/request       { note } one open request at a time
POST /api/me/agreement/sign       acknowledge the conditions of supervision
POST /api/me/employment           report a change of employment
POST /api/me/contacts             add or edit one of their own contacts
POST /api/me/contacts/delete      { id }
POST /api/me/vehicles             add or edit one of their own vehicles
POST /api/me/vehicles/delete      { id }
```

`/api/me/case` returns the subject, their visits and unseen count, curfew, community
service, travel permit, employment, contacts, vehicles, documents, the condition
category labels, and their agreement **only if it is active** — a draft is a working
document, not something they are bound by.

Identity comes from the token, never the request body. A subject attempting another
subject's record gets `no such visit` / `no such contact` — the lookup is scoped, so it
does not even leak that the row exists. A `subject_id` planted in the body is ignored:
the token decides whose list it is.

**A 401 here means the session is over.** Clients must end it and return to sign-in
rather than keeping what they last fetched. The mobile app used to hold stale data
through an expired session, showing records that had since been deleted, with every
write failing "sign in required" beside them.

### The visit lifecycle

```
Subject Requested → Scheduled → Viewed → Accepted → Complete
  (subject asks)     (officer     (opened   (subject    (officer
                      sets date)   the tab)  confirms)   records it)
```

Every transition carries a timestamp. Accept and complete are **idempotent** — a repeated
tap returns the original timestamp rather than overwriting it, which matters on a phone
with a poor connection.

### Keeping this document honest

```bash
node spike/api/smoke.mjs http://<host>:8090   # 85 assertions, both APIs
node spike/api/check-feedback.mjs             # every write confirms it worked
```

Two claims in this document were verified against a running server and one of them was
false — `POST /api/agreement/save` was returning an existing agreement rather than the
draft it had just created, so activating "the new draft" silently activated the old one.
Both behaviours are now covered by the suite.

**If you change an endpoint, change this file in the same commit.** A route documented
one way and built another is worse than no documentation, because it is believed.
