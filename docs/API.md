# Waypoint — API guide

How the API works, what the endpoints are, and how to call them.

Companion to [`BUILD.md`](BUILD.md) (what exists) and
[`../CLAUDE.md`](../CLAUDE.md) (engineering rules).

---

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

Creates or updates the person, and optionally sets a password.

```json
{ "subject_id": "cust-1041",
  "name": "Dana Whitfield",
  "email": "dana@example.com",
  "password": "temporary-pass" }
```

`subject_id` is **your** identifier. Waypoint keys everything off it and hands it back on
every result, so you never have to store a Waypoint id.

The password hash is never returned, even to a trusted caller.

#### `POST /api/assign` — assign a program

```json
{ "subject_id": "cust-1041", "program_id": "golf-101" }
```

Returns the person, the program, the content version and the registration.

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

Called by the player, not by you. Listed for completeness.

```
POST /api/runtime/redeem      { token } → { session, registration, content }
POST /api/runtime/:id/set     { key, value }      persisted immediately
POST /api/runtime/:id/terminate
```

**Every `set` is persisted immediately.** SCORM courses frequently never call `Commit` —
one real course wrote five bookmarks and zero commits in 244 seconds — so durability
cannot be delegated to the content.

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

# 2. provision the person and give them a login
curl -s -X POST $API/api/users -H "$KEY" -H "$J" \
  -d '{"subject_id":"cust-1041","name":"Dana Whitfield",
       "email":"dana@example.com","password":"temp-pass"}'

# 3. assign
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

## Five rules for integrating

1. **The API key never leaves your server.** Your backend brokers every call.
2. **Launch tickets are single-use and expire in ~60 seconds.** Issue one at the moment
   the learner clicks, not in advance.
3. **`subject_id` is your identifier and the contract.** Waypoint stores it and returns it
   on everything, so you never need to hold a Waypoint id.
4. **Take completions from the webhook, never from the client.** A device-reported pass is
   a device-controlled pass.
5. **Use both push and pull.** The webhook is timely; `GET /api/status` catches
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
