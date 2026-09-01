# Waypoint — user stories

What has been built, described as the work each part exists to do.

**Three actors.** The **officer** is Northwood staff, working from a laptop
console or a phone in the field. The **subject** is the person under
supervision, using a mobile app. The **integrating system** is Northwood
itself, which is a *customer* of Waypoint and talks to it over HTTP — that
boundary is enforced in the module graph, not just described.

The acceptance criteria below are the rules the system actually enforces. Every
one of them has a test behind it; the round brackets at the end of a section
name the ones worth knowing about. Where a rule exists because getting it wrong
is expensive, the criterion says why.

---

## 1. Delivering training (Waypoint, the LMS)

**1.1** As an administrator, I want to upload a SCORM package so that a course
we bought or built can be delivered inside our own apps.
- The manifest is parsed for the entry point and SCORM version (1.2 and 2004).
- Entries whose paths escape the extraction root are rejected; so are oversized
  archives and manifests with external entities.
- Every file is served with an explicit content type from an allowlist, never
  sniffed.

**1.2** As an administrator, I want an updated course to become a new version
so that people mid-progress keep the version they started.
- Uploading again creates a version; it never overwrites.
- A version referenced by a registration cannot be deleted.

**1.3** As the integrating system, I want to assign a course to a person so
that they can take it.
- Assignment uses **our own** identifiers — `subject_id` and `program_id`. No
  Waypoint id is ever stored on our side.
- Unassigning is refused once somebody has started.

**1.4** As a learner, I want to open my course from the app or the web so that
I can do it wherever I am.
- Launch uses a **single-use ticket, expiring in sixty seconds**, bound to one
  person and one course. There is no customer id in a URL anyone could edit.
- The course plays inside our own player. The learner never leaves the app.

**1.5** As a learner, I want to stop halfway and resume where I left off.
- `suspend_data` is stored byte-for-byte and never parsed, trimmed or
  re-encoded.
- SCORM 1.2 caps it at 4,096 characters. Overflow is **detected, logged and
  surfaced** — silent truncation is the worst possible behaviour, because
  "resume stopped working" is then unattributable.

**1.6** As a supervisor, I want completion and pass/fail recorded separately so
that reports can tell a finished course from a passed one.
- Two columns from the first migration. A learner can finish and fail.

**1.7** As the integrating system, I want to be told when someone finishes,
without trusting the learner's device.
- A signed webhook, server to server (`X-Waypoint-Timestamp` +
  `X-Waypoint-Signature`). The phone never reports a completion.
- `GET /api/status` is the pull that reconciles anything missed.

**1.8** As an operator, I want a session that never said goodbye to close
itself.
- A sweeper closes sessions gone silent, keeping whatever the last `Commit`
  gave it. On mobile this is the common case, not the edge case.

---

## 2. Signing in

**2.1** As an officer, I want to sign in to the console so that I see my
caseload.
- Staff credentials belong to Northwood; subjects have none.

**2.2** As a subject, I want one login that works in the app and on the learner
site.
- The login belongs to the **person**, not to any program they were given. It
  is created once, deliberately, and survives every assignment afterwards.
- A password is shown once and never cached anywhere it could outlive its own
  validity.

**2.3** As an officer, I want to create a subject's login without that being a
side effect of anything else.
- Its own button, its own endpoint. Assigning a program does not mint or rotate
  a credential.
- Resetting a password is an explicit, separate act.

**2.4** As a subject, I want to sign out, and to know I am actually signed out.
- The session is a server-side record, so signing out **ends** it. The same
  token stops working immediately rather than remaining valid until it expires.
- Signing out twice, or from a client that has already discarded its token, is
  answered as success. There is nothing useful a client could do about being
  told that signing out failed.

**2.5** As an officer, I want to end every session a subject has, because their
phone has been lost or taken.
- Every device signs out at once, not only the one that asked.
- Staff-operated. It is an officer acting on somebody's behalf, and it is not
  something a subject can do to another subject.
- Until recently this was impossible: the session was a signed token carrying an
  identifier and an expiry, with nothing to look up and nothing to revoke. The
  only answer to a lost phone was to wait twelve hours.

**2.6** As the system, I want guessing at somebody's password to become
pointless quickly.
- Five wrong answers locks that identifier for fifteen minutes, on **both**
  logins. The subjects' sign-in had no such limit until recently, which meant
  the weaker-protected door was the one in front of a person's supervision
  record.
- Failures are counted against the identifier that was *tried*, whether or not
  it exists. Counting only real accounts would answer *"is this an account?"*
  through behaviour, which is exactly what the identical error message exists to
  prevent.

---

## 3. The caseload

**3.1** As an officer, I want to see the subjects assigned to me.
- A caseload is exactly the subjects whose `officer_id` is mine — derived, never
  a second list to keep in step.

**3.2** As an officer, I want to move a subject onto my caseload, or somebody
else's.
- Its own action, not a field on the demographics form: who supervises someone
  changes accountability, and should not be reachable by a payload aimed at an
  address change.
- Every transfer writes a case note naming both officers.

**3.3** As an officer in the field, I want a subject's whole file in one screen.
- `GET /api/subject/detail` returns everything in **one call** — an officer on a
  doorstep on a phone signal should not make eight round trips and risk holding
  half a case file.
- Every key is always present and sometimes null, so a client can tell "there is
  no permit" from "this endpoint did not mention permits".

**3.4** As an officer, I want the file organised so I can find one thing.
- Twelve collapsible modules; contact and address opens by default because it is
  what you need standing at a door.
- A collapsed card still shows its state chip. Collapsing must never hide that
  there is something to look at.

---

## 4. Demographics and the small modules

**4.1** As an officer, I want to maintain a subject's address, phone, email and
dates.
- Dates are stored ISO and formatted on display. A date typed as prose is
  refused, because a date you cannot compare tells you nothing.
- A date of birth displays with the age beside it.
- A partial save leaves every field it did not mention alone.

**4.2** As an officer, I want the full address wherever I might drive to it.
- Address line 2 is carried everywhere. Dropping the unit number sends an
  officer to a building rather than a door.
- The last line is *City, ST ZIP*, and a map link sits beside it.

**4.3** As an officer or subject, I want family and support contacts on the
record.
- Either party maintains them; `added_by` / `updated_by` records which.

**4.4** As an officer, I want employment recorded, and as a subject I want to
report my own.
- One record, one validator, both routes — neither side is the lenient one.

**4.5** As a subject, I want to maintain my own vehicles.
- A model year is normalised on write, so `"2014"` from a form and `2014` from a
  seed cannot become two different values on disk.

**4.6** As an officer, I want to set a curfew, a travel permit, and community
service requirements.
- An expired travel permit reads as expired, not as the level it used to be.

---

## 5. The supervision agreement

**5.1** As an officer, I want to build the conditions of supervision from
standard clauses I can edit.
- Templates are a starting point; every clause stays editable, because the text
  is the legally operative part.

**5.2** As an officer, I want to sign it, then issue it.
- Activating a document nobody has signed is refused — otherwise the signature
  is decorative.
- A draft is invisible to the subject. They see nothing until it is issued.

**5.3** As a subject, I want to read my conditions in full and acknowledge them.
- The acknowledge control unlocks only after scrolling to the end.
- Acceptance stores a **snapshot of the text as it read at that moment**.
  Without it, what they agreed to is unanswerable after the third edit.

**5.4** As an officer, I want an amendment to ask for a fresh acknowledgment.
- Editing a term withdraws the subject's signature and says so in the response.
- Every acknowledgment is kept. The history is the evidence.

**5.5** As either party, I want a PDF of the agreement filed against the case.
- Rendered from the same code as the acknowledgment snapshot, so the filed
  document and the accepted text can never disagree.

---

## 6. Visits

**6.1** As an officer, I want to schedule a visit, from the console or the
phone.
- The location pre-fills with the subject's full address and a map link.

**6.2** As a subject, I want to ask for an appointment.
- The request reaches the officer as an alert in the console top bar and a badge
  in the officer's app, visible from every screen.
- **Reading the alert does not clear it.** Only giving the request a date does.

**6.2a** As an officer, I want to answer that request from wherever I am.
- Both the console and the app can schedule it. The app used to list requests
  and then say *"Set a date from the web console"* — a notification on the
  device in the officer's hand, pointing at a laptop they are not sitting at.
- The scheduling sheet shows what the subject said when they asked. Shown, not
  copied into the officer's own note: their reason for wanting to be seen is not
  the officer's instruction to them.
- Answering **converts** the request into the scheduled visit. Booking a new one
  instead would leave the request open beside an appointment nobody had
  connected to it — the officer's list would clear while the subject's app went
  on saying they were waiting to hear back.
- A request that has already been answered cannot be answered again.

**6.3** As a subject, I want to confirm an appointment.
- The badge counts appointments **still awaiting confirmation**, not ones I have
  not looked at. Glancing at the tab does not clear it.
- Acceptance is an acknowledgment, not permission: an officer may attend one
  nobody confirmed, and the console says "Not confirmed" honestly.

**6.4** As an officer, I want to conduct the visit where it happens.
- Starting a visit opens it. Arrival and end times are stamped **server-side at
  the moment the officer acts** — a time typed afterwards is a recollection.
- Starting twice keeps the original time; a repeated tap is not a new arrival.

**6.5** As an officer, I want to take notes and photographs during the visit.
- Notes are append-only. A correction is a new note, never an edit.
- Photographs are capped at 6 MB, restricted to an image allowlist, and stored
  under a **generated filename** — an uploaded name is attacker-controlled.
- There is no delete: a photograph of a broken window is evidence.

**6.6** As an officer, I want to record what I observed.
- Structured fields — is the location safe, contraband, demeanour, who else was
  present — recorded once, when the visit ends.

**6.7** As an officer, I want to record the conversation itself.
- Recording is available while a visit is open, on the phone, and asks for the
  microphone the first time.
- A recording with **no sound in it is refused** rather than filed. If the meter
  never moved, the app says so.
- Before it uploads, the app **names the subject and the visit** and asks the
  officer to confirm. Audio filed against the wrong person is not a mistake that
  announces itself later.
- Capped at 25 MB, roughly half an hour of speech. An unbounded upload is a way
  to fill a disk.
- Playback works in the console **and** in the app, including seeking partway
  through.
- Recordings are never deleted. A recording of a conversation is evidence.

---

## 7. What comes out of a recording

The transcript, the summary, and the action items a summary proposes. This is
the only part of the system where a machine writes something a person may act
on, and most of the rules below exist to keep that honest.

**7.1** As an officer, I want the recording transcribed without asking.
- Transcription starts on upload. Nobody presses a button.
- One transcript per recording. Re-running replaces it, because the audio owns
  the fact and a transcript is a reading of it — a better model next year should
  produce a better reading of the same conversation, not a rival one.

**7.2** As an officer, I want a written summary of what was discussed and what
was agreed.
- Summarising starts by itself when a transcript lands.
- Summaries **append**. Re-summarising adds one and keeps the last, because a
  document somebody may have relied on is not something to quietly rewrite
  underneath them.
- Two recordings transcribed back to back do not each start a summary of the
  same visit. The officer is not billed twice for two readings of one
  conversation.

**7.3** As an officer, I want anything that sounded like a commitment to become
something on a list.
- Action items are created live, not held as proposals awaiting approval. An
  officer who has just had the conversation does not need to be asked whether
  the thing they said out loud exists.
- Each carries an owner — the officer, the subject, or unclear — and a due date
  where the conversation implied one.
- They appear on the subject's record, in the officer's dashboard, and in the
  subject's own app.

**7.4** As an officer, I want to check what the machine claims against what was
actually said.
- Every line of the summary keeps the **quote from the transcript** that
  produced it, and the transcript is one tap from the audio.
- The system prompt forbids inference word by word. A model will still
  occasionally add one nobody used, which is the reason the quote is there.

**7.5** As an officer, I want to correct it.
- Wording, owner and due date are all editable.
- What the model **originally proposed** is kept beside what a person changed it
  to. Reading the record later, you can tell which is which.
- Items from an older summary that nobody has touched are superseded when a
  newer one lands, so re-summarising does not double the list.

**7.6** As an officer, I want dates that are arithmetic rather than guesses.
- "Next Tuesday" is resolved against the visit's own date, in code. The model is
  never asked for a date.

**7.7** As an operator, I want the feature to be able to be off.
- With no key configured both features report themselves off and the buttons are
  hidden. *Not yet* is a supported state, which matters where sending a
  recording of a supervision conversation anywhere may not be permitted.
- Nothing reaches the network on its own. A recording is transcribed because
  somebody asked, never as a side effect of pressing stop.

**7.8** As an officer, I want a job that died to say so.
- A transcription or summary interrupted by a restart is failed on boot and
  offers *try again*, rather than leaving a spinner turning until somebody
  reloads the page.

---

## 8. Who looked at what

**8.1** As an agency, I want to know who opened a person's record.
- Opening a case file, and playing a recording, are both written down with who
  did it and when.
- Sign-in, sign-out and session revocation are recorded too.
- It is deliberately **not** a query log. It records reads of a *person's*
  record — the thing with a subject entitled to ask who has been looking at
  their file. Logging every read would produce volume nobody looks at and bury
  the entries that matter.
- An audit write that fails does not take down the read it was recording.
  Losing an entry is bad; refusing an officer their caseload because the log is
  full is worse.
- Append-only. Nothing in the application deletes from it.

Written before there was anything worth auditing, because there is no way to
reconstruct afterwards who read what last year.

---

## 9. The visit agenda

**9.1** As an officer, I want a visit to arrive with an agenda so that I know
what it is for.
- Built from the case file when the visit is booked, from five sources: money
  outstanding, appointments coming up or passed unreported, open goals,
  unfinished or failed courses, and my own items.

**9.2** As an officer, I want the agenda to be a record of that day.
- It is a **snapshot, not a live query**. If a fine is paid next week, the item
  stays, still saying what was on the table — otherwise "did you discuss the
  restitution?" becomes unanswerable.
- Refresh is an action, never automatic, and purely additive: it brings in what
  is new and never rewrites what was there.

**9.3** As an officer, I want to record what was said about each item.
- "Covered" alone says somebody ticked a box. The note is what anyone actually
  reads a visit record for.
- Un-covering keeps the note: what was said still happened.

**9.4** As an officer, I want the agenda in front of me at the door.
- It is the first card on the in-progress screen. You have about ten seconds to
  remember why you came.

---

## 10. Important dates

**10.1** As an officer, I want to record appointments the subject attends
elsewhere — parole board, court, treatment, testing.
- Fourteen kinds, server-owned. Free text would give three officers three
  spellings of "court" and a report nobody can group.
- Kept apart from visits: a visit is something the officer conducts.

**10.2** As a subject, I want to be told about an appointment and confirm I will
be there.
- A five-step lifecycle — **Assigned → Viewed → Accepted → Completed /
  Missed** — plus a separate `awaiting_outcome` flag for a date that has gone
  by, because "accepted then went quiet" and "never looked at it" are
  different conversations.
- The app reports each appointment as it is drawn, per item, not "everything is
  read because a tab opened" — an officer decides whether to ring somebody based
  on this flag.
- It keeps the **first** time it was seen, not the last.

**10.3** As an officer, I want to know whether they attended.
- After the date passes, an unreported appointment asks the subject "did you
  attend?" and reads as awaiting an outcome on the officer's side.
- Either party may report it, and the record says which — "they say they
  attended" and "the court confirmed it" are different claims.
- **Missed is an outcome, not a deletion**, and it keeps its note.

**10.4** As an officer, I want moving an appointment to withdraw the
acknowledgment.
- They agreed to be somewhere at a time. Change either and they have agreed to
  nothing.

**10.5** As a subject, I must not be able to move a court date.
- There is no create, save or delete route under `/api/me/` at all. The absence
  is the guarantee, and the suite asks for each and expects a 404.

---

## 11. Financial balance

**11.1** As an officer, I want to raise a fine, restitution, court costs or a
fee, with an amount and a due date.
- Amounts are **integer cents**. `"$1,240.50"` is stored as `124050`. A float
  balance is how somebody ends up owing 0.009999999999 of a dollar.
- An amount that cannot be parsed is **refused, never guessed** — a fine
  silently recorded as $0 is a bug nobody notices until the balance is wrong.

**11.2** As either party, I want to record a payment made at an office.
- Payments are **rows**. "How much is left" works either way; "what did they pay
  and when" dies the moment a running total overwrites it — and the payment
  history is what anybody disputes.
- `recorded_role` says who claimed it. Both routes share one validator.
- A payment larger than the balance is refused, not absorbed as a silent credit.

**11.3** As an officer, I want to waive an obligation.
- Waiving is **not paying**: its own act, its own author, and it requires a
  reason.
- A waived item owes nothing but keeps its imposed amount, and totals report
  `waived` separately from `paid`.

**11.4** As a subject, I must not be able to change what I owe.
- Raising, editing and waiving exist only on the officer's routes.

**11.5** As either party, I want to see the total due.
- Computed from the items on read. There is no balance column.

---

## 12. Goals and action steps

**12.1** As an officer, I want to set a goal with the concrete steps that get
somebody there.
- *Obtain employment* → *submit 10 resumes per week*, *visit the career office*.
- A due date must be a calendar date.

**12.2** As a subject, I want to tick off the steps I have done.
- They are the ones doing them. `done_by` records who ticked each one.

**12.3** As an officer, I want to decide when the goal is met.
- Progress is **computed** from the steps; completion is **a decision**. Ten
  resumes submitted is not a job.
- A goal with every step ticked reads as *awaiting the officer* and stays open.
  The subject's app says so rather than leaving them wondering.

**12.4** As an officer, I want to see which goals have run past their date.
- Overdue is derived, not a fourth status.

---

## 13. The reentry plan

**13.1** As an officer, I want a structured plan covering everything that has
to be arranged before release.
- Twenty-one areas, sixty-two checkpoints, copied onto the plan at creation —
  so a plan keeps the rules it was issued under even if the template changes.

**13.2** As a subject, I want to accept the plan up front.
- Acceptance is an **acknowledgment of the plan, not of a finished one**. Both
  apps say so in those words.
- It stores a snapshot of what they read.

**13.3** As officer and subject, we want to sign each checkpoint off together.
- An officer marking an item verified is an assessment, not a completion. A
  checkpoint is satisfied only when **both** have signed.
- An officer cannot record the subject's signature; that route is on the
  subject's own token and scoped to their own plan.
- Reopening a checkpoint clears both signatures, so an item can never return to
  "ready" carrying approval nobody gave again.

**13.4** As an officer, I want an honest readiness figure.
- Computed on read; there is no stored percentage.
- `not_applicable` **leaves the calculation entirely** — requirements vary, and
  counting substance-use treatment somebody does not need would make the score
  dishonest.
- An `exception` counts as satisfied but requires a documented mitigation **and**
  a named approver. Not complete must never automatically mean cannot release.

**13.5** As a supervisor, I want the release gate separate from "the plan is
finished".
- `ready_for_reentry` is every **critical** checkpoint satisfied.
- `certifiable` is every checkpoint satisfied. Someone can be releasable while
  their plan still has work on it.

**13.6** As an officer, I want to certify the plan complete at the end.
- Refused unless it is issued, accepted, and every checkpoint is done — and each
  refusal names its own cause, so nobody hunts for the wrong thing.
- Reopening any checkpoint afterwards **withdraws the certification**: it
  described a finished plan and cannot outlive one.

---

## 14. Case notes and documents

**14.1** As an officer, I want to record a case note.
- Append-only. A note that can be rewritten later is worth nothing at a hearing.

**14.2** As either party, I want documents filed against the case.
- Staff may fetch any; a subject only their own, proven by their token.

---

## 15. What the subject is asked to do

**15.1** As a subject, I want one place that tells me everything I owe.
- A to-do list above the tabs: conditions to acknowledge, a reentry plan to
  accept, checkpoints to co-sign, appointments to confirm or report on, new or
  overdue goals.
- It shows **all** of them. It used to show one at a time, which hid real work
  from anybody who had two things outstanding.

**15.2** As a subject, I want the tabs to tell me where the work is.
- Red while something has not been started, is unacknowledged or has run past
  its date; amber once everything outstanding is under way; nothing when it is
  done. The same three-state rule on every tab, so nobody learns two colour
  vocabularies.

**15.3** As a subject, I want to pull to refresh anywhere that shows my case.
- Nine screens. Not the sign-in form, a modal sheet, a picker or the course
  player — none of them has anything to re-read.

---

## 16. Rules the system enforces by making the alternative impossible

These are the ones worth demonstrating, because each is a class of bug rather
than a feature.

- **Northwood cannot read Waypoint's tables.** It is a customer and talks over
  HTTP. The check is one rule — *Northwood may not import Waypoint* — enforced
  in the module graph, so crossing it is a build error rather than a code-review
  question. An earlier version listed thirty forbidden function names and leaked
  through it twice.
- **A subject cannot assert their own outcome.** No route lets a phone report a
  completion, a payment they did not make against somebody else's obligation, a
  signature on another person's plan, or a change to a court date.
- **Nothing derived is stored.** Readiness, goal progress, financial balance,
  agenda coverage and caseload membership are all computed on read, because a
  stored copy of a fact eventually disagrees with the fact.
- **Every write says whether it worked, and names what it saved.** A silent
  success is indistinguishable from a broken button, and it is the user who pays
  to find out which. A checker fails the build if any write path can complete
  quietly.
- **Every route appears in this documentation, and nothing documented is
  missing.** A checker enforces both directions.

---

## What is not built

Named so nobody demonstrates around a gap and calls it a feature.

- **Multi-tenancy.** Single-tenant by decision. The data-access chokepoint is
  what would make adding scoping survivable; a speculative `tenant_id` column
  was never the expensive part.
- **A real payment gateway.** Payments are recorded transactions, not card
  processing — someone paid at an office and is entering it.
- **Notifications outside the apps.** No email or SMS. Everything surfaces as a
  badge or a to-do when somebody opens the app.
- **Link-out content tracking beyond "they opened it."** Inherent to the type,
  not a gap to close.
- **Officer-to-officer messaging, supervisor approval chains, court
  integrations.** None of these exist.
- **A supervisor tier.** Every officer sees their own caseload and the roster.
  There is no rank above that and no need-to-know boundary within one.
- **Reporting across a district or agency.** The dashboard counts one officer's
  own work. Nothing aggregates.
- **Managing officers through the interface.** Staff accounts are created on the
  server.
- **Anywhere to read the audit log back.** It is written; there is no screen for
  it and no retention policy yet.
