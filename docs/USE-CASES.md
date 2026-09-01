# Waypoint — use cases

Where [`USER-STORIES.md`](USER-STORIES.md) says what each part must do, this
says how the parts combine into somebody's working day. Each case is a goal
achieved end to end: who starts it, what has to be true first, the steps, what
happens when a step goes wrong, and what is true afterwards.

**Actors.** *Officer* — Northwood staff, on a laptop console or a phone in the
field. *Subject* — the person under supervision, in the mobile app. *Northwood*
— the corrections system itself, which is a customer of Waypoint and talks to
it over HTTP. *Waypoint* — the LMS.

Every step below has been run against the system. Where a step's behaviour is
surprising, the note under it says why it is that way.

---

## UC-1 · Officer schedules a visit and sees what is outstanding

**Actor** Officer · **Where** console or mobile
**Precondition** The subject is on the officer's caseload.

1. Officer opens the subject's **Visits** screen and clicks **Add Visit**.
2. The form opens with the date defaulted to 10am three days out, the officer's
   own name, and the subject's **full address** pre-filled — street, unit, city,
   state and ZIP — with a *Check it on a map* link beside it.
3. Below the form, the **agenda preview** loads: everything currently
   outstanding, before the officer has committed to anything.

   ```
   · Restitution: $1,240.00 outstanding
     Victim restitution · due Nov 1, 2026
   · Court hearing: Sep 14, 2026
     Third District Court, Room 214 · not yet seen by the subject
   · Goal: Obtain employment
     no steps yet · due Oct 15, 2026
   · Course not started: Golf Explained (Rustici sample)
     assigned Aug 28, 2026
   ```

4. Officer picks a date and time, optionally adds a note for the subject, and
   schedules it.
5. The agenda is **written onto the visit** at that moment, and the visit
   appears in the subject's app with an unconfirmed badge.

**Alternate — nothing is outstanding.** The preview reads *"Nothing outstanding
— this visit starts with a clear agenda."* The visit is still scheduled.

**Exception — Waypoint is unreachable.** The four non-program sources still
appear; courses are simply absent. The officer gets the rest of their agenda
rather than none of it.

**Exception — the preview fails entirely.** The form says the visit can still be
scheduled and the agenda refreshed afterwards. Scheduling is never blocked by a
read that is only advisory.

**Postcondition** A scheduled visit exists with its own agenda snapshot. The
subject owes a confirmation.

> **Why a snapshot.** If the restitution is paid next week, the item stays on
> this visit, still reading `$1,240.00`. A live query would quietly lose the
> item the officer actually raised, and *"did you discuss the restitution?"*
> becomes unanswerable.

---

## UC-2 · Subject confirms an appointment

**Actor** Subject · **Where** mobile app
**Precondition** A visit has been scheduled for them.

1. Subject opens the app. The **Visits** tab carries a red badge.
2. The visit shows date, time, officer, location, and any instructions.
3. Subject taps **Accept this appointment**.
4. The officer's console and app now read *Confirmed*.

**Alternate — they open the tab but do not accept.** The visits are marked seen;
**the badge stays**. Seen is not confirmed, and the console distinguishes the
two.

**Alternate — they never confirm.** The officer attends anyway. Acceptance is an
acknowledgment, not permission, and the console reads *Not confirmed* honestly
rather than implying the visit is off.

**Postcondition** `accepted_at` is stamped. The badge clears.

---

## UC-3 · Subject requests a visit

**Actor** Subject · **Where** mobile app

1. Subject taps **Request an appointment** and optionally says why.
2. The request appears in the officer's console **top bar**, visible from every
   screen: `🔴 1 Appointment Request`, and as a badge on the officer app's
   Schedule tab.
3. Officer opens it and sees who asked and their reason.
4. Officer answers it, from **either** surface:
   - **Console** — they land on that subject's Visits screen and set a date.
   - **App** — the request row opens the scheduling sheet directly, with what
     the subject asked for shown above the date picker. They can add
     instructions for the subject while they are there.
5. The request **becomes** the scheduled visit. It does not sit alongside a new
   one.

**Alternate — the officer reads it and does nothing.** The alert **stays**. Only
giving the request a date and time clears it.

**Alternate — a second officer opens the same request.** Answering an
already-answered request is refused rather than silently booking a second
appointment.

**Postcondition** The request becomes a scheduled visit with an agenda, and
UC-2 begins.

> **Why "becomes" is the whole point.** Booking a new visit instead would leave
> the request open beside an appointment nobody had connected to it. The
> officer's own list filters on visits without a date, so it would have emptied
> and the badge would have cleared — while the subject's app, which asks whether
> any visit is still *requested*, went on telling them they were waiting to hear
> back about something already booked. Two surfaces reading one fact two
> different ways.

> **Why the app could not do this until recently.** It listed the requests and
> then said *"Set a date from the web console."* A notification on the device the
> officer is holding, pointing at a laptop they are not sitting at.

---

## UC-4 · Officer conducts a visit in the field

**Actor** Officer · **Where** mobile app
**Precondition** A scheduled visit, today.

1. Officer opens the app. The schedule card shows the subject, the **full
   address**, `4 on the agenda`, and a **Directions** link.
2. Officer taps **Start visit**. The arrival time is stamped **server-side at
   that moment** — a time typed afterwards is a recollection.
3. The in-progress screen opens with the **agenda first**. You have about ten
   seconds at a door to remember why you came.
4. Officer works down it, tapping each item as it is covered.
5. Officer adds notes as things come up, and photographs — a damaged window, a
   room, a document. They can also **record the conversation**, which is UC-16.
6. Officer taps **End visit**, records the observations (is the location safe,
   contraband, demeanour, who else was present, concerns), and saves.

**Alternate — the visit was never formally started.** Completing one still
stamps both times, so a completion entered from the desk is not left with a
null arrival.

**Alternate — the officer taps Start twice.** The original arrival time is kept.
A repeated tap is not a new arrival.

**Exception — no signal.** Notes and photographs fail loudly and are not
reported as saved. Nothing tells the officer a thing was recorded when it was
not.

**Postcondition** The visit carries arrival and end times, structured
observations, an append-only note log, photographs, and an agenda showing what
was discussed and what was said about it.

> **Why notes cannot be edited.** A correction is a new note. What was recorded,
> and when, is itself evidence.

---

## UC-5 · Officer works the case from a laptop instead

**Actor** Officer · **Where** console
**Precondition** A scheduled visit.

1. Officer opens the subject's **Visits** screen and clicks through to the
   visit.
2. The detail shows the schedule, the address with a map link, the agenda, the
   photographs, and the notes.
3. Officer clicks **Refresh** on the agenda to pull in anything raised since the
   visit was booked.
4. Officer marks items discussed and records **what was said** on each —
   *"says he will pay $50 on the 1st."*
5. Officer starts and completes the visit from the same screen.

**Alternate — refresh finds nothing new.** It says so and changes nothing.

**Alternate — an item should not be on this visit.** The officer removes it.
Refreshing later is a new question and may raise it again.

**Postcondition** Identical to UC-4. The desk and the field write the same
record through the same endpoints.

---

## UC-6 · Issuing the conditions of supervision

**Actor** Officer, then Subject
**Precondition** The subject exists and has a Waypoint login.

1. Officer opens **Supervision Agreement** and sets the kind, level, term,
   office and supervising officer.
2. Officer adds conditions from the standard clauses, editing the wording where
   the jurisdiction differs.
3. Officer **signs as the supervising officer**.
4. Officer **issues** it to the subject.
5. Subject opens the app: a to-do banner reads *"You have conditions of
   supervision to review and acknowledge."*
6. Subject reads to the end — the acknowledge control unlocks only then — ticks
   the box and acknowledges.
7. Officer sees *Acknowledged*, with the timestamp.

**Exception — the officer tries to issue without signing.** Refused: *"Sign the
agreement as the supervising officer before activating it."* Otherwise the
signature is decorative.

**Alternate — the officer amends a term afterwards.** The subject's
acknowledgment is **withdrawn**, the response says so, and the banner returns.
Both acknowledgments stay on the record with a snapshot of the text each
referred to.

**Postcondition** An executed agreement, and an append-only acknowledgment
history. A PDF can be filed against the case at any point.

---

## UC-7 · Assigning training and getting the result back

**Actor** Officer, Subject, Northwood, Waypoint

1. Officer opens **Programs** and clicks **Assign Program**. The catalogue is
   fetched from Waypoint when the modal opens.
2. Officer assigns *Golf Explained*. Northwood sends **its own** identifiers —
   `subject_id`, `program_id`.
3. Subject opens the app. The **Programs** tab carries a red badge.
4. Subject taps the course. Northwood's server asks Waypoint for a **launch
   ticket** — single-use, sixty seconds, bound to that person and that course —
   and the app opens the player.
5. Subject works through it. Progress is committed as they go.
6. Subject exits halfway. The badge turns **amber**.
7. Subject returns later and resumes exactly where they stopped.
8. On completion, Waypoint calls Northwood's **webhook**, server to server,
   signed. The completion appears in the console within seconds.
9. The badge disappears.

**Exception — the subject has no Waypoint login.** The assignment succeeds and
the officer is told plainly that the subject cannot open it and where to create
one.

**Exception — the network drops mid-course.** The player says progress is not
yet saved. It never reports a success that did not happen.

**Exception — the webhook is missed.** `GET /api/status` is the reconciling
pull. A system needs both.

**Postcondition** A completion and a pass/fail — **two separate facts** — with
time on task, recorded against Northwood's own identifiers.

---

## UC-8 · Setting a goal and working it over weeks

**Actor** Officer, then Subject

1. Officer opens **Goals** and clicks **Add a goal**: *Obtain employment*, due
   15 October.
2. The page lands on the new goal with the cursor in its step input.
3. Officer types *"Submit 10 resumes per week"*, presses Enter, types *"Visit
   the career office"*, presses Enter. The cursor stays put throughout.
4. Subject's **Goals** tab turns red — a goal nobody has started.
5. Subject ticks off the first step. The tab turns **amber**; progress reads
   50%.
6. Subject ticks the second. The goal reads **"With your officer"**, and the
   app says: *"Everything here is done. Your officer closes the goal."*
7. At the next visit, the goal is on the agenda. Officer discusses it and marks
   the goal complete.
8. The badge disappears.

**Alternate — the due date passes first.** The goal reads *Overdue* without any
status change, and it is red on both sides.

**Why the goal does not close itself.** Ten resumes submitted is not a job.
Progress is arithmetic; whether the goal is met is a judgement only a person can
make.

**Postcondition** A closed goal naming who closed it, with its step history
intact and `done_by` on each.

---

## UC-9 · Recording money owed, and paying it down

**Actor** Officer, then Subject

1. Officer opens **Financial Balance** and adds *Restitution, $1,240.00, due
   1 November*.
2. The tile and both apps now show `$1,240.00 due`.
3. Subject pays $50 at the office and hands over a money order. The officer
   records the payment against the item, dated the day the money moved.
4. Later, the subject pays $50 themselves and records it in the app, choosing
   *Cash at office*.
5. The payment history shows both, each labelled with **who claimed it** —
   *recorded by the officer* / *recorded by the subject*.
6. At the next visit, the outstanding balance is on the agenda.

**Exception — a payment larger than the balance.** Refused, naming the amount
outstanding. Somebody typing 5000 for 50.00 is told, not given a silent $4,950
credit.

**Exception — an amount that will not parse.** Refused. A fine recorded as $0
because the field said *"twelve hundred"* is a bug nobody notices until the
balance is wrong.

**Alternate — the obligation is waived.** Its own act, requiring a reason. The
item owes nothing but keeps its imposed amount, and totals report `waived`
separately from `paid` — a report that cannot tell *"they paid it"* from *"we
stopped requiring it"* is worth nothing.

**Postcondition** A balance computed from rows, and a payment history that
survives every dispute.

---

## UC-10 · A court date, from scheduling to outcome

**Actor** Officer, then Subject

1. Officer opens **Important Dates** and adds a *Court hearing*, 14 September
   9:00am, Third District Court Room 214, with the address.
2. Console reads **Assigned**.
3. Subject opens the app. The card is drawn, and the app **reports that one
   appointment as seen** — per item, not "everything is read because a tab
   opened."
4. Console now reads **Viewed**. The subject knows; they have not agreed.
5. Subject taps **I will be there**. Console reads **Accepted**.
6. The date passes with nothing reported. The app asks *"Did you attend?"*; the
   console still reads **Accepted** but flags *awaiting outcome*, and the item
   appears on the next visit's
   agenda as *"Court hearing: did they attend on Sep 14?"*
7. Subject reports **I attended**. Recorded as their claim.
8. Officer later hears from the court that they did not appear and records it as
   **Missed** with a note. Both claims are on the record, each attributed.

**Alternate — the hearing is moved.** Changing the time or place **withdraws
both the view and the acknowledgment**. They agreed to be somewhere at a time;
change either and they have agreed to nothing.

**Exception — the subject tries to move it.** There is no route. A court date is
not something a subject reschedules.

**Postcondition** An appointment with a full audit of who knew what and when,
and an outcome attributed to whoever claimed it.

---

## UC-11 · Preparing somebody for release

**Actor** Officer, then Subject, then Officer
**Precondition** The subject has a Waypoint login and an active agreement.

1. Officer opens **Reentry Plan** and creates one. The standard template is
   stamped on: 21 areas, 62 checkpoints, 29 of them critical.
2. Officer sets the target release date and facility, signs the plan, and
   **issues** it.
3. Subject opens the app and accepts it — an **acknowledgment of the plan, not
   of a finished one**. The app says so in those words.
4. Over the following weeks the officer works the checkpoints. For each: set the
   detail (*"412 Ridgeway Ave, Apt 3B — mother's address"*), mark it verified,
   sign it off.
5. The subject co-signs each one in the app. **Only then does it count.**
6. Checkpoints that do not apply — no substance-use treatment needed — are
   marked **not applicable** and leave the calculation entirely.
7. One cannot be completed: the DMV will not issue before release. The officer
   records an **exception** with a mitigation plan and a named approver.
8. The dial reaches 100%. **Certify complete** turns from red to green.
9. Officer certifies. The plan reads *Certified complete by R. Alvarez*.

**Exception — certifying too early.** Refused, and each refusal names its own
cause: *"The subject has not accepted this plan yet"* or *"9 checkpoints are
still outstanding."* Nobody hunts for the wrong thing.

**Exception — an exception without a mitigation or an approver.** Refused. Not
complete must never automatically mean cannot release, but it must never mean
nothing either.

**Alternate — a checkpoint is reopened after certification.** The certification
is **withdrawn**. It described a finished plan and cannot outlive one.

**Postcondition** A certified plan; `ready_for_reentry` (every critical
checkpoint) and `certifiable` (every checkpoint) both answerable and separate.

---

## UC-12 · Taking over somebody else's case

**Actor** Officer · **Where** console

1. Officer opens a subject who is not on their caseload. A green **Add to my
   caseload** button sits beside the avatar.
2. Officer clicks it. A confirmation states the consequence: *"They will appear
   in R. Alvarez's app and drop off T. Nakamura's."*
3. Officer confirms. A case note is written naming both officers.
4. The subject appears on the receiving officer's caseload immediately, and on
   their phone the next time the app comes to the foreground.

**Alternate — moving them to a third officer.** The dropdown on the officer row
does the same thing through the same code path.

**Postcondition** One officer of record, and a case note explaining the change —
a subject who moves between caseloads with nothing on the record is how a case
goes quiet.

---

## UC-13 · A subject opens the app with several things outstanding

**Actor** Subject · **Where** mobile app

1. Subject signs in.
2. Above the tabs, a **to-do list** shows everything owed, in the order it
   should be done:

   ```
   ⚠  You have conditions of supervision to review and acknowledge.   Review
   ⚫  2 appointments to confirm.                                      Open
   ⚑  2 reentry steps need your signature.                            Open
   ◎  1 new goal to look at.                                          Open
   ```

3. Tabs carry counts: **Programs** red, **Goals** red, **Visits** red.
4. Subject works through them. Each item disappears as it is dealt with.

> **Why all of them.** This used to show one banner at a time, with the
> agreement outranking everything else. Somebody with conditions to acknowledge
> *and* checkpoints to co-sign saw only the first, and had no way to know the
> second existed. Supervision is something the two of them do together, and a
> list of one is a poor way to say so.

**Postcondition** The subject knows everything that is waiting on them, from one
screen.

---

## UC-14 · Northwood integrates with Waypoint

**Actor** Northwood (a system) · **Where** server to server

1. Northwood holds an API key. It never reaches a browser or a phone.
2. `GET /api/content` — what is available to offer.
3. `POST /api/users` — create the person and, if they need one, a login. It will
   **not** overwrite a password that already exists, and reports whether it
   issued one, so a console never displays a credential that was never stored.
4. `POST /api/assign` — give that person a course, using Northwood's own ids.
5. `POST /api/launch` — at the moment the learner clicks, mint a ticket and
   redirect. Redeemed immediately.
6. Waypoint calls Northwood's webhook on completion, signed and timestamped.
7. Northwood verifies both before trusting a word of it.
8. `GET /api/status` reconciles anything missed.

**Constraint proven, not asserted.** Northwood's demo application is a genuine
customer of this API. A build check enforces one rule — *Northwood may not
import Waypoint* — so crossing the boundary is a build error rather than a
code-review question. An earlier version of that check listed thirty forbidden
function names and leaked through it twice.

**Postcondition** Two systems, one contract, and neither able to reach into the
other's data.

---

## UC-15 · Preparing the demo

**Actor** Whoever is presenting

1. `./spike/demo reset` wipes and re-seeds. It prints what it left:

   ```
   Case file     vehicle, 3 contacts, curfew, employment
   Agreement     20 conditions, signed and issued — awaiting Dana's acknowledgment
   Reentry plan  51/53 complete, 9 n/a — 2 awaiting Dana's signature
   ```

2. `./spike/demo script` prints the walkthrough.
3. Dana Whitfield is set up with everything tedious already done, and exactly
   the interesting things left undone.
4. Marcus Oyelaran is deliberately bare, so the empty states and Create flows
   can be shown.
5. Nothing is assigned and no visits exist — those are performed live.

**Postcondition** The demo opens on a populated case with three acts left to
perform, and six tests assert that seeded state so a broken seed fails the suite
rather than the demo.

---

## UC-16 · Recording a visit, and what comes out of it

**Actor** Officer · **Where** mobile app
**Precondition** A visit is under way (UC-4, step 2).

1. Officer taps **Record**. The app asks for the microphone the first time and
   records the conversation.
2. Officer taps stop. The app shows how long it captured, and **refuses to
   upload silence** — if the meter never moved, it says the recording has no
   sound in it rather than filing an empty file.
3. Before uploading, the app **names the subject and the visit** and asks the
   officer to confirm. Audio filed against the wrong person is not a mistake
   that announces itself.
4. The audio uploads and is attached to the visit. Nothing further is pressed.
5. **Transcription starts by itself.** A minute or so later the transcript is on
   the visit.
6. **Summarising starts by itself** when the transcript lands. A written summary
   appears under *Visit Summary*: what was discussed, and what was agreed.
7. Anything that sounded like a commitment becomes an **action item** — "book
   the written test", "call the employer" — with an owner and, where the
   conversation implied one, a due date.
8. Those items appear on the subject's record, in the officer's dashboard, and
   in the subject's own app.

**Alternate — the officer wants to hear it back.** Playing the recording works
in the console and in the app, including seeking to a point partway through.

**Alternate — the officer disagrees with an item.** Wording, owner and due date
are all editable. What the model originally proposed is kept beside what a
person changed it to.

**Alternate — the visit is re-summarised.** A new summary is added; the previous
one stays. Items from the older summary that nobody has touched are superseded
so the list does not double.

**Exception — no key configured.** Both features report themselves off and the
buttons are hidden. "Not yet" is a supported state, which matters where sending
audio anywhere may not be permitted.

**Exception — transcription or summarising fails.** The row says *failed* with a
*try again*, rather than a spinner that turns until somebody reloads. A job
interrupted by a restart is failed on boot for the same reason.

**Postcondition** The visit carries the audio, a transcript, one or more
summaries, and a live list of action items that both sides can see and either
side can close.

> **Every claim carries its quote.** Each line of the summary keeps the words
> from the transcript that produced it, and the transcript is one tap from the
> audio. An officer can check what was actually said rather than taking the
> summary's word for it — and they should, because a model will occasionally
> add a word nobody used.

> **Due dates are arithmetic, never a guess.** "Next Tuesday" is resolved
> against the visit's own date by code. The model is never asked for a date.

> **The recording is evidence and is never deleted.** The transcript is a
> reading of it and can be replaced by a better one. Summaries append, because
> a document somebody may have relied on is not something to quietly rewrite
> underneath them.

---

## UC-17 · A subject loses their phone

**Actor** Officer · **Where** console

1. Subject reports the phone lost or taken.
2. Officer ends every session that person has, on every device.
3. Any app still holding a session stops working immediately. The next screen it
   loads returns them to sign-in.
4. The subject signs in again on a replacement device, with the same
   credentials, and picks up where they were.

**Alternate — the subject still has the phone and simply wants to sign out.**
Signing out ends that one session and leaves any others alone.

**Alternate — signing out twice**, or from a client that already discarded its
token. Answered as success. There is nothing useful a client could do about
being told that signing out failed.

**Postcondition** No session exists for that person until they sign in again.
The revocation is on the audit log with who did it and when.

> **This was not possible until recently.** The subject's session was a signed
> token carrying an identifier and an expiry: nothing to look up, and nothing to
> revoke. The only answer to a lost phone was to wait twelve hours. Staff
> sessions had been revocable from the start, which meant the weaker of the two
> was the one guarding a person's own supervision record, on the device far more
> likely to go missing.

---

## Coverage

| Use case | Modules it exercises |
|---|---|
| UC-1 Schedule a visit | visits · agenda · financial · dates · goals · programs · demographics |
| UC-2 Confirm an appointment | visits · badges |
| UC-3 Request a visit | visits · officer alerts |
| UC-4 Conduct in the field | visits · agenda · notes · photos · observations · audio |
| UC-5 Conduct from the desk | as UC-4, through the console |
| UC-6 Conditions of supervision | agreement · acknowledgments · documents |
| UC-7 Training | programs · Waypoint · launch tickets · webhooks · SCORM runtime |
| UC-8 Goals | goals · action steps · agenda |
| UC-9 Money | financial · payments · agenda |
| UC-10 Court date | important dates · agenda |
| UC-11 Reentry | reentry plan · checkpoints · readiness · certification |
| UC-12 Caseload transfer | caseload · case notes |
| UC-13 Subject's to-dos | every subject-facing module |
| UC-14 Integration | the API boundary |
| UC-15 Demo | the seed |
| UC-16 Recording a visit | audio · transcription · summaries · action items · the audit log |
| UC-17 A lost phone | sessions · revocation · the audit log |

Two modules appear only inside others and have no case of their own: **case
notes** (written from UC-12 and by hand) and **documents** (filed by UC-6 and
UC-11). That is honest — neither is a goal somebody sets out to achieve.

**The audit log has no case of its own either, and that is the point.** Nobody
sets out to write an audit entry; it happens because somebody opened a file or
played a recording. It appears in UC-16 and UC-17 as a consequence rather than
a step.
