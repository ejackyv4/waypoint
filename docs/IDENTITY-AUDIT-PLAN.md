# Identity and audit cleanup plan

## Demo freeze

Do not change identity columns or migrate existing audit rows before the demo.
The current application is usable, and changing these fields now would create
unnecessary database and reset risk.

Because this is development/demo data rather than a production case record, we
do not need to preserve ambiguous historical audit rows. After the demo, the
preferred cleanup path is to wipe the local database and reseed the defined
subjects/officers from current code (`./spike/demo reset`). Recreate Dana's
partial fixture separately if it is still needed. This avoids a risky, mostly
meaningless backfill of legacy names and role strings.

## Target convention

- `subject_id` is the canonical subject identity.
- `officer_id` is the canonical officer identity.
- `actor_role`/`owner` are classifications, not identities.
- Display names may be returned by the API, but are never the only audit value.

## Staged implementation

1. Add nullable ID columns beside legacy text fields. Do not remove legacy
   columns yet.
2. Update write paths to populate IDs from the authenticated session. Never
   trust a display name supplied by the browser.
3. Update API responses and screens to resolve/display IDs consistently.
4. For demo databases, wipe and reseed instead of backfilling historical rows.
   For any future retained environment, backfill only where the identity can be
   resolved unambiguously and mark unknown history explicitly as legacy.
5. Add tests proving subject/officer scope and stable audit identity.
6. After a migration and reset rehearsal, make the ID columns authoritative.
7. Remove legacy text columns only in a later, separately reviewed migration.

## Priority order

1. Goal-step reports and confirmations
2. Visit assignment and completion
3. Visit action-item decisions
4. Notes, recordings, photos, and case notes
5. Financial, date, document, and reentry history

### Action-item assignment follow-up

Action items currently use `owner` values such as `subject` and `officer` as
responsibility labels. This is usable for the demo, but it is not a durable
identity model when several officers can share a subject. The cleanup must add
canonical `assigned_subject_id` and `assigned_officer_id` fields, validate
those IDs in every create/reassign route, and make the name-only role labels
derived compatibility data. Dropdowns may display names, but must submit IDs.

## Before merging

- Run the full smoke suite and mobile bundle build.
- Test full and partial demo resets against a copy of the database.
- Verify existing passwords, sessions, photos, visits, and action items.
- Have the read-only code-review agent inspect the complete migration diff.
