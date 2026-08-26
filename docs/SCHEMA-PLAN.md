# Northwood — data model plan

Derived from page 1 of `mytrackRequirementsAnalysis.pdf` (Model::0100 — Analysis Model),
a UML model centered on **Offender Profile**.

**Status: a plan, not built.** Nothing here exists yet. The SaaS currently holds a
hardcoded roster of two subjects plus a `visits` table. This is the map for building the
rest one feature at a time.

**Scope note:** this is the *corrections* system's data. Waypoint (the LMS) stays as it
is — it owns programs, registrations and results, and is reached over its API. Nothing
below belongs in the LMS.

---

## What the diagram says

Twenty-four classes hang off Offender Profile. Read structurally rather than box by box,
they collapse into **seven groups** — and several boxes that look distinct are the same
shape wearing different labels.

| Group | Classes in the diagram |
|---|---|
| **Identity & demographics** | Offender Profile, Photo, Vehicle Information, Location |
| **Scheduling** | Appointment, ECC Calendar ×2, Treatment Schedule, Private Treatment Schedule, Treatment |
| **Case plan (CAP)** | CAP, Goal, Objective, Action Step, Action Step Completion, Imposed Response Assignment, Imposed Response Compliance |
| **Obligations & restrictions** | Curfew, Travel Permit, Community Service Requirement, Community Service Worked |
| **Money** | Financial Info, Payment |
| **Documents & forms** | Document, Medical Record, Medication, Parole/Probation Agreement, Form, PSI Questionnaire |
| **Recognition** | Accomplishment, Earned Incentive |

### Three patterns worth naming before any SQL

**1. Requirement → fulfilment.** The same shape appears four times:

| Requirement | Fulfilment | Cardinality |
|---|---|---|
| Community Service Requirement | Community Service Worked | 1 → many |
| Action Step | Action Step Completion | 1 → 0..1 |
| Imposed Response Assignment | Imposed Response Compliance | 1 → 0..1 |
| Treatment Schedule | Treatment *(participation)* | 1 → many |

**Do not build these four times.** One `obligations` table with a `kind`, plus one
`obligation_events` table for what actually happened, covers all of them — and gives
"what is this person behind on" as a single query rather than four unions.

**2. Generalization (the hollow arrows).**
- `Medical Record` and `Parole/Probation Agreement` are both **Document**
- `PSI Questionnaire` is a **Form**
- `Private Treatment Schedule` is a **Treatment Schedule**

That is a base table plus a type discriminator, not separate tables.

**3. Composition (the filled diamonds).** `CAP` owns its Goals, Objectives, Action Steps
and Imposed Responses — they don't exist without it. Cascade deletes are correct here,
and only here.

---

## Proposed schema

Postgres-flavored. Every table carries `id`, `created_at`, `updated_at` and — for anything
a court might ask about — `created_by`.

### Core

```sql
subjects (                          -- "Offender Profile"
  id, subject_number,               -- the case number shown in the UI
  first_name, middle_name, last_name, dob,
  status,                           -- active supervision | probation | closed …
  officer_id,                       -- supervising officer
  intake_date, next_review_date,
  photo_id                          -- current photo; history lives in subject_photos
)

officers ( id, name, email, phone, badge_number, active )
```

**The diagram's Offender Profile attributes are not columns.** Contact Information,
Address, Employment, Family Information and Education Completed are all *historical* —
people move, change jobs, and a corrections record must show what was true when. Each
becomes its own table with a validity range:

```sql
subject_contacts   ( subject_id, kind, value, is_preferred, verified_at, valid_from, valid_to )
                   -- kind: mobile | home | work | email
                   -- "Preferred Contact Information" is a flag here, not a second field

subject_addresses  ( subject_id, kind, line1, line2, city, state, postal_code,
                     is_primary, verified_at, valid_from, valid_to )
                   -- kind: residence | mailing | employer

subject_employment ( subject_id, employer_name, job_title, employer_phone,
                     employer_address_id, hours_per_week, wage,
                     started_on, ended_on, verified_at )

subject_family     ( subject_id, name, relationship, dob, contact_phone,
                     lives_with, is_emergency_contact, notes )

subject_education  ( subject_id, level, institution, field, completed_on, verified_at )
```

> **Why validity ranges rather than overwriting.** "Where did they live in March" is a
> question this system will be asked. Overwriting an address makes it unanswerable — the
> same class of mistake as collapsing two facts into one column.

### Identity & tracking

```sql
subject_photos   ( subject_id, storage_path, taken_at, kind, captured_by )
                 -- kind: intake | check-in | identifying mark

subject_vehicles ( subject_id, make, model, year, color, plate, state,
                   is_primary, valid_from, valid_to )

subject_locations( subject_id, kind, label, lat, lng, address_id, recorded_at, source )
                 -- ⚠️ ambiguous in the diagram — see open questions
```

### Scheduling

Appointment and ECC Calendar are the **same shape**: a scheduled event with a date, time
and location. One table, one `kind`:

```sql
calendar_events (
  subject_id, kind,                 -- office_visit | home_visit | court | ecc | treatment
  starts_at, ends_at, timezone,
  location_label, address_id,
  officer_id, external_ref,         -- ECC events come from another system
  status,                           -- scheduled | confirmed | completed | missed | cancelled
  requested_by,                     -- officer | subject   ← subject-requested appointments
  notes, seen_at, created_by
)

calendar_event_responses (          -- accept / decline / reschedule requests
  event_id, actor,                  -- subject | officer
  response, proposed_starts_at, message, responded_at
)

calendar_event_reminders (
  event_id, send_at, channel,       -- push | sms | email
  sent_at, delivery_status
)
```

**This is the group already half-built.** The existing `visits` table is
`calendar_events` with `kind = 'office_visit'`, and `seen_at` is already there.
The full appointments page in the PDF (accept invite, reminders, subject-requested
appointments) maps onto the two child tables above — see
[Appointments, next](#appointments-the-obvious-next-feature).

### Treatment

```sql
treatment_programs  ( name, provider_name, provider_contact, modality, is_private )
                    -- "Private Treatment Schedule" = is_private, restricting who may view

treatment_enrollments ( subject_id, program_id, referred_on, started_on, ended_on,
                        status, is_private )

treatment_sessions  ( enrollment_id, scheduled_at, attended,      -- "+participation"
                      participation_rating, provider_notes, recorded_by )
```

### Case Action Plan

```sql
caps        ( subject_id, title, opened_on, closed_on, status, created_by )
cap_goals   ( cap_id, title, description, target_date, status, sort_order )
cap_objectives ( goal_id, title, description, target_date, status, sort_order )
                 -- ⚠️ the diagram asks "Does this exist?" — see open questions
```

Action Steps and Imposed Responses are both **obligations**, so they live in the shared
tables below rather than getting their own.

### Obligations — the shape that repeats four times

```sql
obligations (
  subject_id, cap_id,               -- null when not part of a case plan
  kind,                             -- action_step | imposed_response |
                                    -- community_service | treatment | curfew | travel_permit
  parent_id,                        -- objective or goal, when it hangs off a CAP
  title, description,
  required_quantity, unit,          -- e.g. 40 hours community service
  due_at, starts_at, ends_at,       -- ranges cover curfew and travel permits
  status,                           -- assigned | in_progress | met | missed | waived
  imposed_by, imposed_on, authority,
  metadata                          -- jsonb: kind-specific extras
)

obligation_events (                 -- what actually happened. Append-only.
  obligation_id, occurred_at, kind, -- worked | completed | verified | missed | waived
  quantity, unit,                   -- 6 hours worked
  location_label, verified_by, verification_method,
  notes, evidence_document_id, recorded_by
)
```

**One query answers "what is this person behind on"** across community service, action
steps, imposed responses and treatment — instead of four different queries that must be
kept in step. This is the single highest-value decision in the plan.

`obligation_events` is **append-only**. A correction is a new row, never an edit — the
record of what was recorded when is itself evidence.

### Money

```sql
financial_accounts ( subject_id, kind, balance_cents, currency )
                   -- kind: restitution | fees | fines | supervision
ledger_entries     ( account_id, occurred_at, kind,   -- assessment | payment | adjustment | waiver
                     amount_cents, method, reference, receipt_number, recorded_by )
```

> **`balance` is a derived value, not a source of truth.** The diagram shows it as an
> attribute of Financial Info; store it if you like for speed, but compute it from the
> ledger and be able to regenerate it. Two places holding the same number is how they
> drift.

### Documents & forms

```sql
documents ( subject_id, doc_type,          -- medical_record | parole_agreement | court_order | id | other
            title, storage_path, mime_type, byte_size, checksum,
            effective_from, effective_to, uploaded_by, is_confidential )

medical_record_details ( document_id, provider, condition_summary, restrictions )
medications ( subject_id, medical_record_id, name, dosage, frequency,
              prescriber, started_on, ended_on, is_active )

agreement_details ( document_id, agreement_type, signed_on,
                    signed_by_subject_at, signed_by_officer_at, terms_summary )

forms ( subject_id, form_type,             -- psi_questionnaire | intake | risk_assessment
        template_version, status,          -- draft | submitted | reviewed
        submitted_at, reviewed_by, reviewed_at )
form_responses ( form_id, question_key, question_text, answer, answer_type, sort_order )
```

Storing responses as rows rather than one blob is what makes "how did everyone answer
question 12" possible at all.

### Recognition

```sql
accomplishments   ( subject_id, kind,      -- education | employment | program_completion | milestone
                    title, description, achieved_on, evidence_document_id, recorded_by )

incentives        ( subject_id, incentive_type, description,
                    earned_on, awarded_by, redeemed_on, notes )
```

Waypoint program completions arriving by webhook should **write an accomplishment row** —
that is how LMS results surface in the case file rather than sitting in a separate silo.

### Audit

```sql
audit_log ( actor_id, actor_role, action, entity_table, entity_id,
            before, after, occurred_at, ip, user_agent )
```

Not in the diagram, and non-negotiable in this domain. "Who changed this, and when"
gets asked, and reconstructing it later is impossible.

---

## Appointments — the obvious next feature

Already ~60% built. The current `visits` table becomes `calendar_events`, and the PDF's
appointments page adds:

| Feature | What it needs |
|---|---|
| **Accept / decline an invite** | `calendar_event_responses` + a status transition |
| **Reminders** | `calendar_event_reminders` + a scheduled job |
| **Subject requests an appointment** | `requested_by = 'subject'`, `status = 'requested'`, officer approves |
| **Reschedule** | a response carrying `proposed_starts_at` |
| **Missed / no-show** | a status, and optionally an `obligation_event` |

**A day's work, and it makes the demo materially better** — it turns visits from a
one-way notification into a two-way conversation between officer and subject.

I have not read the appointments page yet — see the note at the end.

---

## Suggested build order

Each step is independently useful and does not require the next.

| # | Feature | Tables | Why here |
|---|---|---|---|
| 1 | **Real subjects** | `subjects`, `officers`, contacts, addresses | Everything hangs off this; the roster is currently hardcoded |
| 2 | **Appointments in full** | `calendar_events` + responses + reminders | Already started, biggest demo gain |
| 3 | **Obligations** | `obligations`, `obligation_events` | Unlocks community service, action steps, imposed responses and curfew at once |
| 4 | **Case Action Plan** | `caps`, `cap_goals`, `cap_objectives` | Sits on top of obligations |
| 5 | **Documents** | `documents` + subtype tables | Self-contained |
| 6 | **Money** | `financial_accounts`, `ledger_entries` | Self-contained |
| 7 | **Treatment** | programs, enrollments, sessions | Depends on nothing above |
| 8 | **Forms** | `forms`, `form_responses` | Depends on nothing above |
| 9 | **Recognition** | `accomplishments`, `incentives` | Wire the Waypoint webhook into it |

**Do 1 and 3 before anything else that touches them.** Both are foundations that are
expensive to retrofit; the rest are genuinely independent and can be picked off in any
order.

---

## Open questions from the diagram

1. **"ECC Calendar" appears twice**, on both sides of the profile. Same thing drawn
   twice, or two different calendars? What does ECC stand for?
2. **"Objective — Does this exist?"** is annotated in the diagram itself. Do CAP goals
   have an intermediate objective layer, or do action steps hang directly off goals?
3. **`Location 0..*`** — what is this? GPS check-ins, approved locations the subject may
   visit, or exclusion zones? These are three very different features, and if it is
   ongoing location tracking there are retention and consent questions attached.
4. **`Photo 0..*`** — intake photos, or check-in photos as proof of presence?
5. **What makes a treatment schedule "private"?** Restricted to certain staff, or excluded
   from the subject's own view? That changes where the check lives.
6. **`Curfew 0..1`** — one active curfew at a time is clear, but is history kept? The
   plan assumes yes, via date ranges.
7. **`Travel Permit`** — does it need an approval workflow, or is it a record of a
   decision made elsewhere?
8. **Who can see what?** Medical records, private treatment and family information all
   need a visibility rule. Worth deciding once, centrally, rather than per feature.

---

## Two carry-over rules from the LMS build

**Never collapse two facts into one column.** This cost real time on the SCORM side, where
a course wrote "completed" and then "passed" into a single field and destroyed the first.
The same trap here: an obligation's *requirement* and its *fulfilment* are separate facts,
as are a document's *existence* and its *approval*.

**All data access through one layer.** The LMS routes every query through `db.mjs`, which
is what would make adding tenancy or auditing a one-file change. This schema is much larger
and needs that discipline more, not less.

---

## Note

I have only read **page 1** of the 22-page document. The appointments page and the other
twenty are unread — this machine has no PDF renderer beyond `sips`, which only converts
the first page.

To read the rest: `brew install poppler`. Then I can work through the whole document and
extend this plan.
