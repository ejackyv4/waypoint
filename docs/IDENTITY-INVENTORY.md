# Identity field inventory

This inventory is the starting point for identity normalization on
`refactor/vantage-foundation`. It records current storage and the intended
canonical identity before any migration changes are made.

## Canonical identities

- Subject: `subjects.subject_id` (for example, `cust-1041`).
- Officer: `officers.id`.
- Display names are presentation values and must not be the only audit value.

## Priority findings

| Area | Current field(s) | Problem | Target |
| --- | --- | --- | --- |
| Goal steps | `goal_steps.done_by` | Stores `subject` or `officer` role text, not the person | Add `done_by_subject_id` / `done_by_officer_id`; retain role as classification |
| Standalone action items | `subject_action_items.owner`, `done_by` | Owner and completer are role text | Add assigned and completed subject/officer IDs |
| Visit action decisions | `visit_summary_actions.owner`, `decided_by` | Owner is a role label; decision actor is often a name | Add assigned IDs and `decided_by_officer_id` |
| Visits | `visits.officer` alongside `officer_id` | Legacy display name remains writable | Make `officer_id` authoritative; derive name |
| Goals and financial records | `created_by`, `completed_by` | Several routes write the authenticated officer's name | Add officer ID audit columns and derive display names |
| Agreements/reentry | `officer_signed_by`, `created_by` | Historical actor is represented as text | Add officer ID audit columns |
| Notes/recordings/photos | `author`, `created_by`, uploader fields | Names can be supplied or persisted without stable identity | Add actor officer/subject IDs and accept actor from session only |

## Authentication fact

Northwood staff sessions already contain `officer_id`. The normalization work
should use that session value server-side rather than accepting an officer name
from the browser. Subject sessions already identify the subject through the
authenticated token.

## Migration rules

1. Add nullable ID columns beside existing text columns.
2. Populate new writes from the authenticated session or validated assignment.
3. Do not trust browser-supplied names for identity or audit.
4. Preserve legacy text during the transition for display and investigation.
5. For demo data, wipe and reseed after the migration instead of guessing at
   ambiguous historical identities.
6. Add scope tests before making new columns authoritative.
7. Remove legacy columns only in a later migration.

## Immediate test cases

- An officer completion stores that officer's ID, regardless of a forged name in
  the request body.
- A subject completion stores the authenticated subject ID.
- Reassigning an action item stores exactly one valid assigned subject or officer
  ID.
- An officer cannot complete or read another officer's unrelated caseload.
- A subject cannot read another subject's action items.
- API responses may include names, but the underlying record retains IDs.
- Existing records without IDs remain readable during the migration.

## Out of scope for the first migration

- Replacing SQLite with another database.
- Introducing an ORM.
- Rewriting the mobile client.
- Splitting every large HTML or JavaScript file.

