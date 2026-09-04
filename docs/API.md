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

#### `GET /api/registrations/:id/responses` — survey responses

Returns the `answered` xAPI interaction statements for one registration as a
staff-facing list of question, response, interaction type, and submission time.
This requires the API key. Waypoint derives the learner from the registration;
an actor or learner identifier supplied by course JavaScript is not trusted as
proof of identity.

#### `POST /api/ingest` — add content

```json
{ "zip": "/path/to/course.zip", "program_id": "golf-101", "title": "Golf Explained" }
```

Validates before unpacking anything (zip-slip, size caps, compression ratio, executable
files, manifest position), accepts SCORM `imsmanifest.xml` or xAPI `tincan.xml`, then creates an **immutable content version**. Re-ingesting the
same program creates version N+1 — learners mid-progress keep the version they started on.

Rejections are specific: `no trackable content: 19 resources, all assets, no SCO` rather
than "invalid package".

---

### Learner endpoints

Used by your web app or mobile app after the learner signs in.

```
POST /api/auth/login          { identifier, password } → { token, person }
POST /api/auth/logout         ends THIS session
GET  /api/me                  the signed-in person
GET  /api/me/assignments      their programs, with status
POST /api/me/launch           { program_id } → { launch_url }
```

**The session is a server-side row, so it can be ended.** It was a signed token
carrying the person id and an expiry — cheap, needing no table, and impossible
to revoke: a subject who lost their phone had one answer, wait twelve hours,
and an officer had nothing they could do for them meanwhile.

`POST /api/auth/logout` is idempotent and always answers 200. A client that has
already discarded its token, or is retrying after a dropped connection, must
not be told that signing out failed — there is nothing useful it could do about
that.

Sign-in is throttled: five wrong passwords for an identifier locks it for
fifteen minutes. Counted against the identifier that was *tried*, whether or
not it exists, because counting only real accounts would answer "is this an
account?" through behaviour — which is what the identical error message exists
to prevent.

### Ending every session a person has

```
POST /api/people/end-sessions  { subject_id } → { ok, subject_id }
```

Carries the **API key**, not a subject's token: this is an officer acting on
somebody's behalf after a phone is lost or taken, not a person signing
themselves out. Every session that subject has, on every device, ends at once.

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

For xAPI content, the launch URL carries a registration-scoped endpoint and
credential plus the server-derived actor, registration UUID, and course activity
ID. The content uses the xAPI endpoints below; they accept normal xAPI HTTP and
the form/method tunnelling used by older Articulate TinCanJS exports.

```
GET|POST|PUT /api/xapi/:id/statements
GET|POST|PUT|DELETE /api/xapi/:id/activities/state
GET /api/xapi/:id/about
```

Statements are append-only and idempotent by statement ID. State documents are
mutable resume data keyed by registration, activity, and state ID. These are
deliberately separate stores: replacing a bookmark must never rewrite the record
of what a learner submitted.

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

#### Case notes

```
GET  /api/case-notes?subject_id=…   newest first
POST /api/case-notes                { subject_id, body, author? }
```

The officer's running record of a case — what was said, decided or noticed
between visits. Distinct from `visit_notes`, which belong to one appointment; a
case note stands on its own.

**Append-only. There is deliberately no update and no delete.** A correction is a
new note. In this domain the record of what was recorded, and when, is itself
evidence, and a note that can be rewritten later is worth nothing at a hearing.
The author and timestamp are taken from the session, not the payload.

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
POST /api/visits                 { subject_id, scheduled_at, officer?, location?, notes?, time_fixed? }
POST /api/visits                 …or { id, … } to change one
POST /api/visits/schedule        { id, scheduled_at, … }   give a request a date
POST /api/visits/complete        { id, officer?, note? }   timestamp taken server-side
POST /api/visits/note            { id, body, officer? }    append a note at any time
POST /api/visits/cancel          { id }
```

### Conducting a visit

```
GET  /api/visits/observations   the fields an officer may record, and their values
POST /api/visits/start          { id, officer? }   the officer has arrived
POST /api/visits/complete       { id, officer?, note?, observations }
```

**`start` is not gated on the subject having accepted.** Acceptance is an
acknowledgment, not permission — an officer may turn up to an appointment nobody
confirmed, and that is often the visit most worth making. Acceptance is shown to
the officer so they know what to expect at the door, never used to withhold the
appointment.

**Both timestamps are taken server-side**, at the moment the officer acts. Neither
is accepted from the caller: a time typed in afterwards is a recollection, and this
record may end up supporting a revocation. `scheduled_at` is when the visit was
*meant* to happen; `started_at` and `ended_at` are when it actually did, and reports
need both. Starting twice keeps the original time — a repeated tap is not a second
arrival. Completing a visit that was never started stamps both, so a completion
entered from a desk is not left with a null arrival.

The observations are recorded once, when the visit ends:

| Field | Values |
|---|---|
| `subject_present` | `yes`, `no_contact` |
| `location_safe` | `yes`, `concerns`, `not_assessed` |
| `contraband` | `none_seen`, `observed`, `not_assessed` |
| `contraband_detail` | free text, when contraband was observed |
| `demeanour` | `cooperative`, `guarded`, `agitated`, `distressed`, `impaired` |
| `others_present` | free text |
| `concerns` | free text — anything the fields above do not cover |

`GET /api/visits/observations` returns that table, so both clients build the same
form from one source and cannot drift apart. Only fields actually supplied are
written, so a later correction cannot blank an observation nobody meant to touch.

### The visit agenda

What needs discussing at a visit: an outstanding fine, a court date coming up,
a goal that has stalled.

```
GET  /api/visits/agenda/preview?subject_id=…  what a visit WOULD be about
GET  /api/visits/agenda?visit_id=…            a visit's own agenda
POST /api/visits/agenda/refresh               pull in anything raised since
POST /api/visits/agenda/item                  the officer's own item
POST /api/visits/agenda/item/delete
POST /api/visits/agenda/item/cover            mark discussed { covered, note }
```

Every visit carries its `agenda` inline, so the app and the console read it
from the record they already have.

**It is a snapshot, not a live query — and that is the whole design.** The
obvious implementation asks the case file what is outstanding every time the
visit is opened. But a visit record has to say what was **on the table that
day**: if a fine is paid next week, a derived agenda quietly loses the item the
officer actually raised, and *"did you discuss the restitution"* becomes
unanswerable. So it is materialised when the visit is booked, and each item
keeps the wording it had then. A test pays a fine and asserts the item stays,
still reading `$300.00`.

**Refreshing is an action, never automatic**, and it is purely additive: it
brings in what is new and leaves every existing item — wording, covered state
and note — exactly as it was. An agenda that rewrote itself would not be a
record of anything.

**Five sources**, each answering *what would an officer raise standing in
someone's front room*:

| `source_kind` | raised when |
|---|---|
| `financial` | a balance is still outstanding — settled and waived items are not |
| `date` | an appointment in the next 45 days, or one that passed unreported |
| `goal` | the goal is still open |
| `program` | a course is unstarted, part-way through, or **failed** — a passed course is not an agenda item, it is a thing that went well |
| `custom` | the officer added it; no source can suggest one |

`source_id` points back at the row that raised it, so the live record is one
click away; `body` is what it said at the time, so the row still means something
if the source is later deleted.

**Programs cross the boundary.** They live in Waypoint, and Northwood's data
layer may not import across it — so `suggestedAgenda` takes them as an argument
and the route fetches them from `GET /api/status` over HTTP, exactly as any
integrator would. If Waypoint is unreachable the agenda is built **without**
them rather than failing: an officer should get the rest of their agenda, not
none of it because the LMS is down.

A program has no numeric id on this side, so its key is Waypoint's
`program_id` string, held in its own `source_ref` column — one concept, one
column, one type. An integer column holding `"golf-101"` would break that.

**Covering an item records what was said.** "Covered" alone says somebody
ticked a box; *"covered — says he will pay $50 on the 1st"* is what anyone
actually reads a visit record for. Un-covering keeps the note: what was said
still happened.

### Important dates

Appointments the subject attends somewhere else — a parole board hearing, a
court date, treatment, a drug test. Fourteen kinds, server-owned.

```
GET  /api/important-dates?subject_id=…   appointments, a summary, and the kinds
POST /api/important-dates                create or amend one
POST /api/important-dates/delete
POST /api/important-dates/close          record the outcome { status, note }
```

And the subject's half:

```
GET  /api/me/case                        includes `important_dates`, `unseen_dates`
POST /api/me/important-dates/seen        the app reports which have been shown
POST /api/me/important-dates/acknowledge they confirm they will be there
POST /api/me/important-dates/close       they report attended or missed
```

**Kept apart from visits on purpose.** A visit is something the officer
conducts and records observations against; these are things the subject
attends elsewhere and reports back on. Merging them would produce one table
where half the columns are null for half the rows.

**Three facts, not one.** The subject has *seen* it (`seen_at`), the subject
has *agreed to be there* (`acknowledged_at`), and somebody has recorded *what
happened* (`status` + `completed_role`). `state` derives from all three:

```
Assigned → Viewed → Accepted → Completed / Missed
```

**Whether the day has passed is a separate flag, not a sixth state.**
`awaiting_outcome` is true of any open appointment whose date has gone by. An
earlier version returned `overdue` as a *state*, which replaced the lifecycle
value — so a past appointment could no longer be told apart from one nobody had
ever looked at. "They accepted and then went quiet" and "they never opened it"
are different conversations, and a row now reads `Accepted · awaiting outcome`
or `Assigned · awaiting outcome` accordingly.

**`seen` is reported per appointment, not per screen.** The app posts
`/api/me/important-dates/seen` with the ids it has actually drawn — once each,
batched into one call — rather than marking everything read because a tab
opened. An officer decides whether to ring somebody based on this flag, so it
has to mean what it says. It is idempotent and **keeps the first time**: when
they saw it is the fact worth having, not when they last scrolled past it. A
batch containing one id that is not theirs still records the rest; a batch with
nothing of theirs in it is a 404.

"They have not looked at it" and "they looked at it and did not agree" are
different problems with different answers, which is why both states exist. The
console reads them as **Assigned** and **Viewed**.

**Moving an appointment withdraws both the view and the acknowledgment.** They agreed to be
somewhere at a time; change either and they have not agreed to anything yet.
Same rule as amending an agreement.

**Missed is an outcome, not a deletion**, and it keeps its note. Either party
may report one, and `completed_role` says which — "they say they attended" and
"the court confirmed they attended" are different claims.

**A subject cannot move a court date.** There is no `/api/me/important-dates`
create, save or delete route at all, and the test suite asks for each of them
and expects a 404 — the absence is the guarantee.

### Financial balance

Fines, restitution, court costs, supervision fees — what a subject owes, what
has been paid against it, and what is left.

```
GET  /api/financial?subject_id=…    items, totals, and the kinds available
POST /api/financial                 raise or amend one { kind, amount, due_date }
POST /api/financial/delete
POST /api/financial/payment         record a payment { item_id, amount, paid_on, method }
POST /api/financial/payment/delete
POST /api/financial/waive           stop requiring it — needs a reason
```

And the subject's half:

```
GET  /api/me/case                   includes `financial` with items and totals
POST /api/me/financial/payment      record a payment they made at an office
```

**Amounts are integer cents, never floats.** `"$1,240.50"` is stored as
`124050`. A float balance is how somebody ends up owing `0.009999999999` of a
dollar, and it is not recoverable once written. An amount that cannot be parsed
is **refused**, never guessed — a fine silently recorded as `$0` because the
field said "twelve hundred" is a bug nobody notices until the balance is wrong.

**Payments are rows and the balance is computed.** "How much is left" is easy
either way; "what did they pay, and when" is unanswerable the moment a payment
overwrites a running total — and the payment history is the thing anybody
disputes.

**Either party may record a payment**, and the record says which:
`recorded_role` is `officer` or `subject`. The subject paid at an office and is
entering the transaction; the officer took the money or saw the receipt. Those
are different claims about the same money. Both routes share one validator, so
neither side is the lenient one, and a payment larger than the balance is
refused rather than absorbed as a silent credit.

**What the subject cannot do is change what they owe.** Raising, editing and
waiving an obligation are the officer's alone — there is no route for any of
them under `/api/me/`.

**Waiving is not paying.** Its own act, its own timestamp and author, and it
requires a reason. A waived item owes nothing but keeps its amount on the
record, and the totals report `waived_cents` separately from `paid_cents` — a
report that cannot tell "they paid it" from "we stopped requiring it" is worth
nothing.

### Goals and action steps

A goal is what the officer and the subject are working towards; an action step
is the concrete thing that gets somebody there.

```
GET  /api/goals?subject_id=…   a subject's goals, with steps and progress
POST /api/goals                create or amend one { subject_id, title, detail, due_date }
POST /api/goals/complete       the officer closes it (or reopens it)
POST /api/goals/delete         remove a goal and its steps
POST /api/goals/step           add or edit an action step
POST /api/goals/step/delete
POST /api/goals/step/done      tick one off
```

And the subject's own half:

```
GET  /api/me/case              includes `goals` and `unseen_goals`
POST /api/me/goals/step        the subject ticks off a step
```

**Two rules pull in opposite directions, on purpose.**

*Progress is computed from the steps*, never stored — same rule as the reentry
plan's readiness. *Completion is the officer's decision*, and is a real column
a person sets. Ten resumes submitted is not a job: the steps say how far along
somebody is, and only the officer says the goal is met. A goal with every step
ticked reports `state: "awaiting_officer"` and stays `status: "open"`.

**The subject ticks off the steps**, because they are the ones doing them, and
`done_by` records who ticked each one — "they said they did" and "I saw that
they did" are different claims. `/api/me/goals/step` is scoped to the caller's
own goals: a step id from somebody else's goal is a 404, and a closed goal is a
409.

**Overdue is derived, not a fourth status.** A due date must be a calendar date
(`YYYY-MM-DD`); one typed as prose is refused, because a date you cannot compare
cannot tell you anything is late.

### The reentry plan

A programme of work rather than a document: twenty-one areas of someone's life
that have to be arranged before release, each broken into checkpoints.

```
GET  /api/reentry?subject_id=…      the plan, the areas, the status vocabulary
POST /api/reentry/create            stamp the template onto a new plan
POST /api/reentry/save              plan-level terms, and issuing it
POST /api/reentry/item              a checkpoint's status and detail
POST /api/reentry/item/sign         the officer signs one checkpoint off
POST /api/reentry/sign              the officer signs the plan
POST /api/reentry/certify           the officer signs off the completed plan
GET  /api/reentry/history?plan_id=… every change, append-only
GET  /api/reentry/acknowledgment?id=…  one acceptance, as the subject read it
POST /api/reentry/pdf               render and file the plan
```

And the subject's own half, on their person-scoped token:

```
GET  /api/me/case                   includes `reentry` once the plan is issued
POST /api/me/reentry/sign           the subject accepts the plan
POST /api/me/reentry/item/sign      the subject signs one checkpoint off
```

`GET /api/subject/detail?subject_id=…` returns a subject's **whole case file in
one call** — demographics, contacts, employment, vehicles, curfew, travel
permit, community service, visits, case notes, documents, and summaries of the
supervision agreement and reentry plan. One request rather than eight, because
the officer opening it is frequently on a doorstep on a phone signal, and eight
round trips is eight chances to hold half a case file.

Assigned training is included too, which means this call **crosses the
boundary**: programs live in Waypoint, so the route fetches them over HTTP like
any integrator. An unreachable LMS yields an empty list rather than failing the
whole case file — the other eleven modules are still worth having.

The agreement arrives as a **summary, not its text**, and the reentry plan as
its **readiness, not its sixty checkpoints** — both have their own screens.
Shipping them whole would make a case-file fetch heavier than the thing it
summarises.

**Every key is always present, and sometimes null.** A lookup that finds
nothing returns `undefined`, and `JSON.stringify` drops the key — so a subject
with no travel permit came back with no `travel_permit` field at all, leaving a
client unable to tell "there is no permit" from "this endpoint did not tell me
about permits".

`GET /api/officer/dashboard` is the one read here that is **not about a single
subject**. Every other endpoint answers a question about one person; this
answers "what do I do now", which cannot be. It walks the caseload and asks
each module the same two questions — *what needs me*, and *what falls due
soon* — returning `attention` and `upcoming`.

Each item names who it is about and which screen fixes it, so a row is a
destination rather than a notification. `attention` is sorted by severity
(`overdue` → `action` → `waiting`) rather than by whichever module happened to
be walked first, and `upcoming` by date. The `days` horizon defaults to 14 and
is capped at 90 rather than trusted.

**A visit from earlier today is deliberately not flagged** as unclosed — the
officer may be on their way to it, and it is already in the day planner above.
Something listed twice is something people learn to scroll past.

This is a fan-out across the caseload, which is fine at the size a caseload
actually is. If one ever ran to thousands it would want a different shape, and
the honest place to discover that is here rather than in a cleverness nobody
needed yet.

`GET /api/officer/week` returns seven days, each with its own stops in
appointment order. A week rather than a day because that is the unit an officer
plans in — paging a day at a time to find out what Thursday looks like is not
planning. `days` can ask for a different span, capped at 31.

It also returns `stale`: anything from before the week that was never closed
out. That belongs on the screen an officer opens, not behind a Previous button
they have no reason to press.

Which stops go in one trip is the **officer's choice**, made by ticking them on
the screen and sent to `/api/officer/route`. Nothing decides it for them: a
week is not a trip, and defaulting to "all of it" would propose driving seven
days in one journey.

The client says which day the week starts on rather than the server guessing,
because only the officer's device knows their timezone. A date that will not
parse falls back to today.

The stops come back with their addresses so the client can build a multi-stop
map link, which the officer's own browser or phone opens.

`POST /api/officer/route` answers the *other* question: given these places,
what is the shortest way round them all? The schedule list stays in appointment
order; this is shown beside it, never instead of it.

**Three limitations, stated in the code and on the screen:**

- **Straight-line distance.** No road network, so a river or a freeway between
  two points is invisible. Good enough to beat an arbitrary order across a
  metro area; never presented as driving time. Google works out the actual
  roads once the order is set.
- **Geocoding is an outbound call carrying a home address.** The PoC uses
  OpenStreetMap's Nominatim (no key, rate-limited to one call a second with an
  identifying User-Agent). A real deployment should point it at the agency's
  own GIS — that is a procurement decision, and `geocode()` is the single
  function where it is made.
- **Cached forever**, keyed on the address it came from, so each address is
  looked up once and a changed address re-runs the lookup. A second call for
  the same day is a few milliseconds and makes no outbound request.

**Changing a visit is the same endpoint as creating one**, with an `id`. Same
form, same fields, same rules — a second endpoint would be a second place for
them to drift. Fields not mentioned are left alone.

**Moving it in time or place withdraws the subject's acceptance**, and the
response says so with `reconfirm: true` so the officer is told rather than
finding out later. They agreed to be somewhere at a time; change either and
they have agreed to nothing. Same rule as an amended agreement and a moved
appointment.

**Only a visit that has not started can be changed.** Once an officer has
arrived it is no longer a plan, it is something happening, and rescheduling it
from the doorstep is not a real act. Once it is complete it is a record, and a
correction is a note — the rule everywhere else here. Both are refused with a
409 naming which case it is.

The console hides Edit in both situations, but **hiding a button is not
enforcing a rule**: anything only the interface prevents is something the next
client does by accident, so the server refuses it too and the suite asks for
both.

**Whether the route matters at all depends on the visits.** Every visit carries
`time_fixed`, and `POST /api/officer/route` takes `visit_ids` — not subject
ids, because only the visit knows whether its time is a commitment. The times
come from the record and never from the caller.

| the day | `mode` | what happens |
|---|---|---|
| every visit has a set time | `scheduled` | the order is **already decided**. It opens them in schedule order and says so rather than claiming to have optimised anything |
| no visit has a set time | `optimised` | the shortest drive is the only thing that matters |
| some of each | `anchored` | the firm ones hold their slots in time order; each flexible one drops into whichever gap adds the least driving |

A parole hearing is at 9:00 and nobody is moving it. A home visit is "I'll come
by Thursday" — the day is fixed, the hour is not. Treating both as fixed times
made two things wrong at once: the planner pretended to optimise a day whose
order was already decided, and the subject was shown an hour nobody had
promised. A flexible visit now reads as **"any time"** in both apps.

Existing rows default to `time_fixed = 1`, because every visit booked before
this was booked *as* a time and reinterpreting them would rewrite what people
were told. The scheduling form defaults the other way, where a person can see
and change it.

**There is always a starting point.** The route takes it three ways, in order
of trust:

| given | used | geocoded |
|---|---|---|
| `start_lat` / `start_lon` | the device's own position | no — nothing to get wrong |
| `start` | an address the officer typed | yes |
| neither | **the officer's own office** | yes, then cached |

The response says which via `start_from` (`device` / `address` / `office`) and
`start_label`. Officers have an `office_id`, so the default is a fact the
server owns — the console used to match an office by name and hope, which
works until somebody renames one. Falling back to "the first stop" was worse
still: it made the route depend on which visit happened to be booked first.

Where you start changes the order, which is the whole point — starting from
Ogden rather than the Salt Lake office reverses a two-stop day and saves 36
miles.

**Location is asked for only when a route is planned.** Nothing is watched in
the background and no position is stored on either client. A declined
permission is not a failure: it falls back to the office.

**Failures degrade rather than block.** A geocoder that is down, an address
that cannot be found, a start point that will not resolve — each falls back
(to appointment order, to leaving that stop off, to starting from the first
stop) and the response says which. An officer who cannot optimise their route
should still be able to see their day.

**Addresses are tried from precise to coarse.** `412 Ridgeway Ave, Apt 3B` is
never sent — a unit number helps the officer find the door and actively hinders
a geocoder — and if the street is unknown the town and postcode still place the
stop within a mile or two. Each point records its `precision`, and the screen
says "approximate" rather than implying a pin it does not have.

Exact below nine stops (8! permutations is nothing, and an exact answer beats a
heuristic anybody has to reason about); nearest-neighbour plus 2-opt above,
capped at twelve.

Google's URL API takes nine waypoints plus a destination, so a day longer than
ten stops opens as far as it can and the console says so rather than silently
dropping the rest. On the phone the origin is omitted, which makes the map start
from wherever the officer actually is.

`GET /api/officer/alerts` is what reaches the officer when a subject asks for
an appointment. The mobile app has carried a badge on its Schedule tab since
visits existed; the console had nothing, so a request could sit unnoticed
unless somebody happened to open that subject's Visits screen. It is a
separate, deliberately cheap endpoint because the console polls it every
thirty seconds from every screen.

**Reading it does not clear it.** Only giving the request a date and time
does. Same rule as the subject's visit badge, and for the same reason.

`GET /api/me/case` carries two visit counts, and they are not the same fact:

- `unseen_visits` — appointments the subject has not looked at. Cleared by
  fetching with `?seen=1`, which is what opening the Visits tab does.
- `unconfirmed_visits` — appointments still waiting on their confirmation.
  **This is what the badge counts**, and only accepting one clears it.

The badge used to count the first, so glancing at the tab cleared the
indicator on an appointment nobody had confirmed — while the officer's console
still read "Seen, not confirmed". Seen is not acted on; one indicator cannot
carry both facts, and the one that vanishes is the one somebody needed.

**A checkpoint takes two signatures.** The officer marking an item verified is
an assessment, not a completion — the checkpoint is satisfied only when both the
officer and the subject have signed it. An officer cannot record the subject's
signature, and `/api/me/reentry/item/sign` is scoped to the caller's own plan: an
id belonging to somebody else's plan returns 404 rather than being applied.
Reopening a checkpoint clears both signatures, so an item can never return to
"ready" still carrying approval nobody gave it again.

**Three signatures, three different claims.** They are separate because they
are separate facts, and collapsing any two would lose who said what:

| | who | when | what it means |
|---|---|---|---|
| `officer_signed_at` on the plan | officer | before issue | this is the plan I am giving you |
| `subject_signed_at` on the plan | subject | at issue | I understand what this asks of me |
| both, on each item | officer **and** subject | over weeks | we agree this piece happened |
| `certified_at` | officer | at the end | the whole thing is done |

The subject's acceptance is an **acknowledgment of the plan, not of a finished
one**. They accept it up front, the two of them work the checkpoints together,
and the officer certifies at the end.

`POST /api/reentry/certify` is refused unless the plan is issued, the subject
has accepted it, and **every checkpoint that counts is satisfied** — and each
refusal names its own cause, so an officer is never sent hunting for the wrong
thing. Certification is idempotent, and it does not change the plan's status:
the subject must go on being able to see it.

**A certification cannot outlive the plan it describes.** Reopening any
checkpoint withdraws it and says so in the response (`uncertified: true`) — the
same rule, and the same reasoning, as amending the terms withdrawing the
subject's acceptance.

**Readiness is computed, never stored.** Every response carries a `readiness`
object derived from the items on read:

```json
{ "percent": 82, "complete": 41, "total": 50,
  "critical_complete": 11, "critical_total": 13,
  "awaiting_signature": 3, "not_applicable": 4,
  "outstanding": 9,
  "ready_for_reentry": false, "certifiable": false }
```

There is no readiness column. A stored percentage is a second copy of a fact the
items already carry, and the two disagree the first time an item changes through
a path that forgot to recalculate.

`ready_for_reentry` and `certifiable` answer different questions and are both
needed: the first is the release gate (every *critical* checkpoint satisfied),
the second is whether the plan is finished (every checkpoint satisfied). A
person can be releasable while their plan still has work on it.

**`ready_for_reentry` is not 100%.** It is true when every *critical* checkpoint
is satisfied. The non-critical remainder is real work but not a release gate;
conflating the two would either block releases that should happen or imply a plan
is finished when it is not.

**Two statuses exist so that "not complete" never automatically means "cannot
release":**

- `not_applicable` leaves the calculation entirely — it is not counted as
  incomplete, because requirements vary enormously between people. Someone may
  need no substance-use treatment; employment may be inappropriate for someone
  on disability. Counting those against a score would make the score dishonest.
- `exception` counts as satisfied, and the server refuses one without **both** a
  documented mitigation plan and the name of whoever approved it.

Amending the plan's terms withdraws the subject's acceptance and says so in the
response, exactly as with the supervision agreement — what they accepted was the
plan as it read then.

#### Who supervises a subject

```
GET  /api/subjects           the roster, plus the officers available
POST /api/subject/officer    { subject_id, officer_id }
GET  /api/officer/caseload   the signed-in officer's own subjects
GET  /api/officer/alerts     what is waiting on them, cheap enough to poll
GET  /api/officer/week?from= a week of visits, day by day
GET  /api/officer/dashboard  everything outstanding across the caseload
POST /api/officer/route      order a day's stops for the shortest drive
```

#### An officer's own profile

```
ALL  /auth/me                  now also returns phone, badge, office_id
POST /api/officer/profile      { name, email, phone?, badge?, office_id? }
POST /api/officer/password     { current, password }
```

**Whose profile comes from the session, never from the payload.** There is no id in
the request body to change — an id a client chose is not proof of identity, which is
the same bug as a customer id in a URL.

**`role` and `active` are not editable here at all.** They are absent from the list of
columns this route may write, so letting somebody change their own role would take a
code change rather than a crafted request. A profile screen edits the person who is
signed in; the two fields that decide what they may do do not belong on it.

Email is checked against the other officers before it is written. Sign-in is by email,
so a duplicate would make one of the two accounts unreachable — a silent lockout
rather than an error.

**Changing a password requires the current one**, even though the session already
proves who they are. A session is a device left unlocked, and "knows the old password"
is what stops somebody at an unattended desk locking the real officer out of their own
account. The session survives the change, so they are not signed out of the device
they are working on.

An officer's caseload is **derived**, never stored twice: it is exactly the subjects
whose `officer_id` is theirs. The mobile app and the console read the same column, so
they cannot disagree about whose case it is.

**Creating a subject is its own endpoint too** — `POST /api/subjects`, distinct from
the `POST /api/subject` that edits one. Creating a person and editing one are
different acts with different blast radii, and the console drives both from the same
form so the two cannot drift apart in what they validate or which fields they know
about.

The **`subject_id` is minted server-side**, never accepted from the caller. It is the
key every other table hangs off and it appears in URLs, so a caller that could choose
it could collide with an existing record or overwrite one — the same reason an
uploaded recording's filename is generated rather than supplied. The new subject lands
on the **creating officer's** caseload; moving them is `reassignSubject`, which writes
a case note naming both officers.

`case_number` is `NOT NULL`, so when one is not supplied a provisional
`NC-<year>-<four digits>` is minted and shown in the form to be replaced. An obviously
provisional number an officer will overwrite beats an empty string that reads like a
real value.

**Reassignment is its own endpoint**, not a field on the details form. Who supervises
someone changes whose caseload they appear on and who is accountable for their visits;
that decision should not be reachable by a payload aimed at an address change — and
`POST /api/subject` will silently ignore an `officer_id` it is sent.

Every transfer writes a case note naming both officers. A subject who moves between
caseloads with nothing on the record is how a case goes quiet.

#### Notes and photographs during a visit

```
POST /api/visits/note    { id, body, officer? }
POST /api/visits/photo   { id, data, mime_type, caption?, officer? }
GET  /visit-photos/:id   the image itself
```

**Notes start when the officer arrives, not when they leave.** Writing a visit up
afterwards means writing it from memory; this record may end up supporting a
revocation, so it is captured where the thing happened.

The image is sent **base64 in the JSON body** — the officer is on a phone and this
server has no multipart parser — and the device compresses before sending. Limits:
**6 MB decoded**, and `image/jpeg`, `image/png` or `image/webp` only, allowlisted
rather than sniffed. An oversized body is refused on its declared length before a
byte is read, so the caller gets a `413` rather than a dropped connection.

The stored filename is **generated, never the one supplied** — an uploaded filename
is attacker-controlled and has no business reaching the filesystem.

`GET /visit-photos/:id` follows the same rule as documents: staff may fetch any, a
subject only one from their own visit, proven by their Waypoint token.

**Photographs are append-only, like the notes beside them.** There is no delete
endpoint. A photograph of a doorway, a damaged window or an empty room is evidence,
and evidence that can be quietly removed is not evidence.

#### Recording the visit

```
POST /api/visits/recording    { id, data, mime_type, duration_ms?, note?, officer? }
GET  /visit-recordings/:id    the audio itself
```

Audio only — no video. The officer starts the recorder from the visit screen in the
app **after the visit has been started**.

**The console confirms who it is for before uploading.** A recording attached to the
wrong person is quiet and expensive: it is append-only so it cannot be taken back, and
every commitment found in it lands on that person's list as work they never agreed to.
A file picker gives no clue whose visit is open behind it, so the name, the visit date
and the consequence are stated before the file is sent. The console also accepts a file, for audio
made on a handset rather than in the app; both go through this one endpoint, so there
is a single path into the table and a single set of rules on it.

**A completed visit still accepts audio.** Ending a visit means the officer left the
property; it does not seal the record. The recording was captured at the door, and
uploading it from a desk an hour later is transfer latency rather than a different
event — on a doorstep connection, that gap is the normal case. An earlier version
refused this on a rule that sounded right and was not: it confused *when* the audio
was made with *when it arrived*, and bought no integrity, since nothing stops the
wrong file being attached to an open visit either.

A **cancelled** visit is refused, and differs in kind: it never took place, so audio
from it is a contradiction rather than a late arrival.

Sent the same way as a photograph — **base64 in the JSON body**, no multipart — and
subject to the same two checks in the same order: **25 MB decoded**, and a MIME
allowlist of `audio/m4a`, `audio/mp4`, `audio/x-m4a`, `audio/aac`, `audio/mpeg` and
`audio/webm`. The filename is generated, never the one supplied. Twenty-five megabytes
is around half an hour of the app's own encoding — mono AAC at 32 kbps — which is
also small enough to finish uploading from a doorstep.

The app pins both platforms to **AAC in an `.m4a` container**. The stock low-quality
preset records AMR in `.3gp` on Android and AAC on iOS, which is how one setting
produces a file that plays on one phone and not the other.

`duration_ms` is what the recorder measured, read **before** it is stopped: the
polled recording state drops to zero the moment it does, and a recording filed as
zero seconds long is a recording nobody trusts.

`GET /visit-recordings/:id` follows the photograph's rule exactly: staff may fetch
any, a subject only one from their own visit.

**It is served as a canonical type, not the one it arrived as.** A phone calls the
file `audio/m4a`, which is not a registered type; iOS decides whether it can play a
progressive download from the declared `Content-Type`, and refuses one it does not
recognise — on a URL with no extension to fall back on. So the upload is stored with
what the device claimed and goes back out as `audio/mp4`, with `nosniff`.

**Recordings are append-only and there is no delete endpoint** — the strongest case
of the rule, because the recording somebody wants removed is the one that mattered.
They are kept in their own table rather than beside the photographs: a still of a
doorway and a recording of a conversation are different things, with different
retention and disclosure questions attached.

Whether a conversation may be recorded without telling the other person depends on
where the officer is standing — Utah is one-party consent, several of its neighbours
are not. That is not a judgment to bury in a preference, so **the app announces it**:
the button says what it does, the card turns red while it runs, and the hint says
plainly that everyone present should know.

#### Transcribing a recording, and summarising the visit

```
POST /api/visits/recording/transcribe  { recording_id, officer? }   -> 202
ALL  /api/visits/transcript/:id        where that got to
ALL  /visit-transcripts/:id            the transcript as a .txt file
POST /api/visits/summarise             { id, officer? }             -> 202
ALL  /api/visits/summary/:id           where that got to
POST /api/visits/summary/action        { id, status, officer? }
ALL  /api/insights/capabilities        what this server can actually do
```

**Neither happens on its own.** A recording is transcribed when an officer asks for
it, never on upload — audio of a supervision conversation leaving the building is a
decision somebody makes, not a side effect of pressing stop at a door. Both are also
**off unless a key is set**; `/api/insights/capabilities` reports which, so a screen
can hide a button that could only fail.

Both take minutes, so both are **202 and a row to poll**. An HTTP request held open
for four minutes dies to the first proxy, phone lock or lift and takes the work with
it. The queue runs **one job at a time**: there is a paid API on the other end, and a
caseload submitted at once should form a line rather than a bill. A job still marked
`running` when the process stops is **failed on the next boot** — a screen showing
"failed, try again" asks somebody to do something; a spinner that never stops does not.

States are the same three words throughout: `queued`, `running`, then `done` or
`failed`.

**Three kinds of thing, three lifetimes** — which is why these are three tables and
not columns on `visit_recordings`:

| | what it is | lifetime |
|---|---|---|
| recording | evidence | append-only; no delete, ever |
| transcript | a machine's reading of that evidence | one per recording, **regenerable** — re-running replaces it |
| summary | a document somebody may rely on | **appends** — re-summarising adds a row |

The audio owns the fact and the transcript derives from it, so a better model next
year produces a better transcript from the same seven seconds and there is no reason
to keep the worse one. A summary is different: what an officer read in March must
still be there in June, not quietly rewritten underneath them.

`GET /visit-transcripts/:id` builds the `.txt` **from the stored text** rather than
serving a file written to disk beside the audio. A second copy is a copy free to
drift. The file carries a header naming the subject, the visit, the engine and the
date — and says in as many words that it is machine-generated, unchecked, and will be
wrong about names, numbers, dates and addresses. A transcript that does not say that
gets read as though a person wrote it.

**Action items arrive live.** They were `proposed` at first, awaiting an officer's
acceptance, on the reasoning that a machine should not create work for a person on
its own. In use that was friction rather than safety: an officer who has just held
the conversation does not need to be asked whether the thing they said out loud
exists. Assigning it *is* the decision.

What replaces the gate is cheaper and does the same job. Anything the recording did
not really contain can be **removed** (`status: "dismissed"`) and put back again, the
**owner can be corrected**, and the record always says who closed an item. Nothing is
lost by a mistake and nothing waits on a click.

`POST /api/visits/summary/action` takes `status`, and optionally `owner`, `due_date`
and `body`.

**The wording is editable**, because a transcript mishears — "reinstatement" comes back
as "read statement" and the summary repeats it faithfully. `body_proposed` keeps what
the model wrote, with `body_set_by` and `body_set_at` recording the correction. Same
shape as `owner_proposed`, and for the same reason: overwriting would erase the
evidence of what the machine actually produced, which is exactly what you want when
asking how far to trust it. The owner is applied first: closing an item and then correcting its owner
would record the outcome against the wrong person for an instant, and that instant is
what an audit log would show.

**Ownership is inferred, and sometimes wrong.** Whisper does not diarise, so the
transcript has no speaker labels and the model reads ownership out of phrasing. That
comes apart exactly where an officer *instructs* the subject — the sentence is in the
officer's mouth, the work is the subject's. So `owner_proposed` keeps what the model
said beside the `owner` a person decided, with `owner_set_by` and `owner_set_at`.
Two different facts, not one concept in two columns: a machine's reading, and a named
officer's correction of it. Keeping both is what lets the screen say "corrected from
officer", and what would let anyone later ask how often the inference is wrong. Until then an action item counts as
nothing. This is the same rule as everywhere else here — the party that is not making
the decision does not get to assert the outcome — applied to a model instead of to a
client.

**The summary follows the transcript on its own.** When a transcription finishes,
the server queues a summary of that visit without being asked — a summary an officer
has to remember to request is one that does not get written. `POST /api/visits/summarise`
remains, but it is now a re-run for when the transcript has been redone.

Two guards make the automatic path safe. A summary is only queued if one is not
already `queued` or `running` for that visit, so two recordings transcribed back to
back cannot start two readings of one conversation and bill for both. And a summary
that fails never fails the transcription: the transcript is what was asked for and it
is already saved.

#### The subject's own list

```
ALL  /api/me/case              now carries `actions`
POST /api/me/actions/done      { id }
```

A subject sees **only accepted items that are theirs** — filtered server-side, not
by the client. A proposal nobody has reviewed is not something to put in front of
the person it would create work for, and the officer's own list is not theirs to
watch. `POST /api/me/actions/done` re-checks ownership against their token: a
subject closing an officer's task is not a thing that happens, and it answers 404
rather than 403 so the attempt reveals nothing about what exists.

`/api/me/case` also returns **`unseen_actions`**, and `?actions_seen=1` clears it —
the same shape as `goals_seen=1`. Both clients raise a banner while it is above zero
and mark them seen when the tab is opened, so someone who reads them on a library
computer is not chased again on their phone.

**Seeing is not doing.** Marking them seen clears the banner and nothing else: the
items stay outstanding until somebody reports them done. A badge that cleared when
glanced at is the bug this project already fixed once, on visits — an unconfirmed
appointment lost its indicator the moment the subject opened the screen, while the
officer's console still read "Seen, not confirmed".

**They report, they do not decide.** Ticking records `done_by` as the subject, the
same shape as a goal step either side can tick. A list only the officer can close is
a list the subject is merely watched against, which is the opposite of what this
product argues.

Nothing waits on the officer — the tick is immediate and real. But the module keeps
**"Reported by the subject"** apart from **"Closed by you"**, because "they told me
they dropped the pay stub off" and "I have it" are two different facts, and a list
that cannot tell them apart cannot answer the question an officer actually asks.

Both clients carry it: the app's Goals tab and the learner website's *What I agreed
to*. Someone on supervision may have a library computer and a phone out of credit,
and a list of what they owe that only one of those can show fails the person most
likely to need it.

#### Where accepted action items go

```
ALL  /api/subject/actions?subject_id=…   every action item for one subject
POST /api/visits/summary/action          { id, status?, owner?, due_date? }
```

`GET /api/subject/actions` returns **everything the subject has to do**, from both
things that produce work: a step written into a goal (`kind: "goal_step"`) and a
commitment picked out of a visit recording (`kind: "visit_item"`). Each carries a
`source` naming what produced it.

**Merged for reading only.** They stay in separate tables with separate parents and
separate lifetimes, and each still writes through its own endpoint — a goal step ticks
via `/api/goals/step/done`, a visit item via `/api/visits/summary/action`. What is
shared is the question being asked. An officer wanting to know what somebody owes them
does not care which machinery produced the row, and a screen answering only half of
that is worse than none: it looks complete and is not.

The controls differ because the records do. A goal step has no owner to correct — a
goal is assigned *to* the subject — and its date belongs to the goal, so it is shown
and not editable here. A visit item can be reassigned, dated, and removed.

An accepted item is work somebody owes, so it surfaces in two places: the
**Action Items** module on the subject, and the officer's **dashboard**, split by
owner — the officer's own read *"Yours to do"*, the subject's read *"Waiting on the
subject"*. Only `accepted` items reach either. A proposal nobody has looked at is not
work anybody owes, and listing it would quietly undo the rule the feature rests on.

`status: "done"` completes one, recorded in `done_by` / `done_at` rather than
overwriting `decided_by`. When an officer accepted an item and when they did it are
two facts; a to-do list that cannot tell them apart cannot say how long anything took.

**Due dates are arithmetic, not inference.** `due_hint` is the phrase quoted as
spoken — *"by Friday"*, *"this week"*. `due_date` is a real date derived from it
against the visit's own date, by a deterministic resolver, at the moment an officer
accepts the item. The visit date is known, so "Friday" has exactly one right answer
and a language model has no business guessing a deadline — that is a way to be
confidently wrong about something that matters. A phrase with no date in it
("before the shift") resolves to nothing rather than a guess, and any date an
officer types always wins. Passing `due_date: null` clears it, which is distinct
from omitting the field.

`POST /api/visits/summarise` takes a **visit**, not a recording. An officer may have
stopped and started three times at one doorstep; three summaries of one conversation
is not what belongs in a case file. Every completed transcript for the visit is read
in order, each labelled, so two separate exchanges are not stitched into one story.

**Who hears the audio is a URL.** Transcription speaks the OpenAI audio API — which
Groq and the self-hosted whisper servers also implement — so pointing it at a machine
on the premises is `WAYPOINT_STT_URL`, not a rewrite. For this data that is not a
hypothetical nicety.

```
WAYPOINT_STT_URL    default https://api.openai.com/v1/audio/transcriptions
WAYPOINT_STT_KEY    unset = transcription off
WAYPOINT_STT_MODEL  default whisper-1
WAYPOINT_LLM_URL    default https://api.anthropic.com/v1/messages
WAYPOINT_LLM_KEY    unset = summarising off (falls back to ANTHROPIC_API_KEY)
WAYPOINT_LLM_MODEL  default claude-sonnet-5
WAYPOINT_AI_TIMEOUT_MS  default 300000
```

**Every word of an action item must be findable in its quote.** The model was told
only not to invent *facts*, and it read that as licence to tidy: "book the test
anyway" came back as "Book the written driving test" when nobody said driving. A
qualifier the speaker did not use is a detail nobody agreed to, and it reads exactly
as authoritative as one they did. The rule is now word-level and stated against the
`body` field itself, with the quote required to contain everything the action claims.

That is a mitigation, not a guarantee. The officer can edit the wording of any item in
place — in the visit summary where they first read it, and in the Action Items module
— and what the model wrote is kept in `body_proposed`.

The summary is asked for through a **tool schema**, so the shape is enforced by the
API rather than by a regex over prose that mostly works. The system prompt is blunt
about the failure that matters: a summary may end up in a case file and be read by
people making decisions about someone's liberty, so it records only what the
transcript contains, says "unclear" where the audio was, does not characterise the
subject, and does not decide whether anything is a violation.

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
GET /api/program-responses?registration_id=…   xAPI survey answers for staff review
POST /api/program-responses/pdf                 create a filed PDF of those answers
POST /api/program-analysis { registration_id }  snapshot evidence and queue Phase 2 analysis
GET  /api/program-analysis/:id                  read analysis job status and result
POST /api/program-analysis/review               record officer disposition and notes
POST /api/program-analysis/pdf                  export a reviewed completion summary PDF
POST /api/program-analysis/compare              snapshot current vs previous completed attempt
GET  /api/program-analysis/comparison/:id       read longitudinal comparison snapshot
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
