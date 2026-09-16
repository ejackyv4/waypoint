# AI Officer Assistant

## Purpose

Give an officer a fast, conversational way to find case information and begin
common tasks from the mobile app. The assistant is a guided interface over
Northwood's existing APIs; it is not a second database, an unrestricted chatbot,
or a replacement for the normal screens.

The first example is a question-mark button in the officer mobile app's main
bottom navigation bar. Tapping it opens a prompt sheet whose primary control
is a microphone. The officer asks a question verbally in ordinary language;
typed input remains available as a fallback for accessibility or noisy rooms.

## Example interaction

Officer: “List me all of Dana Whitfield's action items.”

The assistant resolves the display name to a server-authoritative subject ID,
for example `cust-1041`, checks that the officer may access that subject, and
then uses the existing action-item query. The response is rendered as a normal,
structured list with ownership, due date, status, and source visit where
available.

The assistant may offer a useful next step:

> Would you like me to add a new action item?

Officer: “Add an action item for Dana to complete her passport application.”

Before writing anything, it presents a confirmation containing the resolved
subject, action text, due date (if supplied), and owner:

> Add “Complete passport application” for Dana Whitfield, due date not set.
> Assign to subject?

Only an explicit confirmation invokes the existing create-action API.

## ID and identity rules

- Names are for display and natural-language matching only.
- The server resolves a name to `subject_id` and `officer_id`; the model never
  invents or persists a name as an identity.
- If a name matches more than one subject, the assistant must ask the officer
  to choose from a short, ID-backed list.
- Every read and write is authorized against the officer's current caseload or
  care-group visibility on the server.
- The model does not receive authority to choose a different subject by
  changing an ID in its response.

## Read/write boundary

Read requests may execute immediately after authorization and intent validation.
Examples include:

- list open, overdue, or completed action items;
- show today's or upcoming visits;
- summarize goals, financial obligations, or recent contact history;
- show the agenda for a selected visit.

Writes require a preview and explicit confirmation. Examples include adding,
reassigning, completing, reopening, archiving, or changing the due date of an
action item; scheduling a visit; or editing a profile field. The assistant must
call the same validated API routes used by the existing web and mobile screens,
never write SQL, and never bypass audit logging.

## Proposed architecture

```text
Officer mobile assistant sheet
          |
          v
POST /api/assistant/query  (authenticated officer session)
          |
          +-- intent/schema validation
          +-- subject/officer name resolution to IDs
          +-- caseload/care-group authorization
          +-- read service OR write preview
          |
          v
Existing Northwood API routes and database queries
```

The model should return a constrained intent object, not prose instructions or
SQL. A representative read intent is:

```json
{
  "intent": "list_action_items",
  "subject_id": "cust-1041",
  "scope": "open"
}
```

A write intent is held in a pending confirmation record until the officer
confirms it. The server re-checks authorization and current data at confirmation
time because a subject's assignment or an action's status may have changed.

## Phased implementation

### Phase 0 — foundation and safety

- Inventory the existing API routes and query functions the assistant may use.
- Define the intent schema, response schema, and error/ambiguity states.
- Define authorization rules for caseloads, care groups, and officer sessions.
- Add structured audit events for assistant reads, previews, confirmations, and
  rejected requests.
- Add feature flags and a provider capability check so the assistant can be
  disabled without affecting normal app operation.

### Phase 1 — read-only voice-first mobile assistant

- Add the question-mark button to the officer mobile bottom bar.
- Add a voice-first prompt sheet with recording, transcription, loading, retry,
  cancellation, and empty states. Keep a text field as a fallback.
- Send a short question recording through a dedicated assistant endpoint; do not
  attach it to a visit or mix it into the visit recording history.
- Support subject resolution and read-only intents for action items, visits,
  goals, financials, and contact history.
- Render results using existing mobile components rather than model-generated
  HTML.
- Require a subject selection when a name is ambiguous.

### Phase 2 — confirmed action-item writes

- Support add-action-item previews with body, due date, owner, and subject ID.
- Default the owner to the subject while allowing the officer to choose the
  officer or another authorized person where the existing model permits it.
- Require explicit confirmation, then call the existing action endpoint.
- Return the saved row and refresh the relevant screen.
- Add reassign, due-date change, report/confirm completion, and archive flows
  only after add-item behavior is stable.

### Phase 3 — visit and workflow assistance

- Add visit agenda previews, “what should I review before this visit?”, and
  overdue/open-work summaries.
- Allow confirmed visit scheduling and reassignment through existing APIs.
- Support follow-up questions that retain a server-validated subject context,
  without trusting conversational memory as identity.

### Phase 4 — production hardening

- Add rate limits, provider timeouts, retry policy, and graceful degradation.
- Redact unnecessary personal information from model prompts and logs.
- Add evaluation fixtures for name ambiguity, unauthorized subjects, stale
  actions, duplicate confirmations, and prompt-injection text in case notes.
- Measure intent accuracy, confirmation abandonment, latency, and failed writes.
- Complete an independent code/security review before enabling the feature for
  all officers.

## Testing requirements

- Unit tests for intent validation, ID resolution, ambiguity, authorization,
  and confirmation expiry.
- API tests proving assistant reads match the normal action/visit endpoints.
- API tests proving writes use IDs and preserve existing audit behavior.
- Mobile tests for opening the sheet, displaying results, confirming writes,
  cancellation, retries, and offline/network errors.
- Regression tests that a model response cannot select an unauthorized subject,
  issue a write without confirmation, or create duplicate action items.
- End-to-end demo test: ask for Dana's open actions, add a confirmed item, and
  verify it in SaaS, officer mobile, and subject mobile views.

## Non-goals for the first release

- No unrestricted “ask anything about the database” interface.
- No model-generated UI or direct SQL.
- No autonomous changes without an officer confirmation.
- No replacement of existing pages, filters, or detailed case-file views.

## Delivery estimate

A read-only demo version is a small, bounded feature once the intent and
authorization seam is in place. A production-ready version with confirmed
writes, auditability, ambiguity handling, privacy controls, and the test suite
should be treated as a multi-phase feature rather than a single UI change.
