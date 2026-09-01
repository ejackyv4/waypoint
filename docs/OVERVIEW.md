# Waypoint and Northwood: what the system does

## The short version

There are two halves. Northwood is the corrections system: officers, the people
they supervise, home visits, conditions, goals, payments. Waypoint is the
training system: course files, who has been assigned what, and whether they
finished it.

They are separate systems that talk to each other. Northwood asks Waypoint
about training the same way any outside product would. That sounds like a
technical detail, but it matters commercially, because it means Waypoint can be
sold to someone who has never heard of Northwood.

Three kinds of people use it: an officer, a person under supervision, and
whoever administers the training catalogue.

---

## The officer

An officer works in two places. At a desk they use the web console. On the road
they use the phone app. Both show the same information and both write to the
same records, so there is no reconciling to do afterwards.

### Starting the day

The dashboard opens on what actually needs them. Visits scheduled for today.
Anything overdue. Requests from people asking to be seen. Goals that someone has
finished and are waiting on an officer to close out. Payments that have gone
past due. Reentry checkpoints where the officer's signature is the only thing
left.

Each row says who it is about and takes you straight to the screen that deals
with it, rather than telling you something is wrong and leaving you to find it.

If they are going out, they can tick the visits they intend to drive and get
them ordered into a sensible route. Addresses come from the case files, so there
is nothing to type. The route opens in Google Maps.

### The case file

Opening a person brings up everything about them in one screen. Their details
and address. Vehicles they drive. Family and emergency contacts. Where they
work. Their curfew. Travel permits. Community service hours and how many are
done. Fines and fees, what has been paid and what is late. Court dates and
review dates. Their goals and how far along each one is. Their reentry plan.
The conditions of their supervision and whether they have acknowledged them. A
history of visits, with notes, photographs and recordings. Any training they
have been assigned.

Some of that the officer maintains. Some of it the person under supervision
maintains themselves. A few things, like employment and family contacts, either
side can update, which cuts out a phone call whose only purpose was to pass on
a new address.

### Doing a visit

The officer starts the visit in the app when they arrive. The app has already
built an agenda from the case file, so it prompts them about the things that
were outstanding this week rather than relying on memory. Curfew, employment
changes, an overdue payment, a goal that has stalled.

During the visit they can take notes, photograph what they see, and record the
conversation. Notes are added as they go rather than written up afterwards.

At the end they record observations. Was the person there. Did the location seem
safe. Anything of concern. Who else was present. Then they close the visit out.

### What happens after

This is the part that changes the job rather than just digitising it.

If the visit was recorded, the audio is transcribed automatically. Nobody
presses a button. A minute or so later a written summary appears against the
visit: what was discussed, and what was agreed.

Anything that sounded like a commitment becomes an action item. "I'll book the
written test." "Call your employer about the shift change." Those land on the
person's record, on the officer's dashboard, and in the person's own app, so
both sides are looking at the same list.

Every line of the summary carries the quote from the conversation that produced
it, so an officer can check what was actually said rather than taking the
summary's word for it. The wording, the owner and the due date can all be
edited, because transcription gets things wrong and people phrase things
loosely.

The recording is kept. Notes and photographs are kept. Nothing that was recorded
during a visit gets deleted or rewritten later.

### Scheduling

An officer can book a visit from either the console or the app. If someone has
asked to be seen, answering that request turns it into the scheduled
appointment, so the person is not left waiting on a request that was quietly
already dealt with.

The person under supervision gets told, and is asked to confirm they will
attend. If the officer moves the appointment afterwards, they are asked to
confirm again.

---

## The person under supervision

They get an app, and a website that does the same things for anyone without a
suitable phone.

The point of giving them anything at all is that supervision works better when
it is something two people do rather than something done to one of them. Most of
what is on their side reflects that.

### What they see

Their next appointment. What they owe and when it is due. Their goals and how
close each one is. The action items that came out of their last conversation.
Court dates and review dates. The conditions they are supervised under.

### What they can do

Confirm an appointment. Ask to be seen, and say why, if something has come up
before their next scheduled visit.

Tick off things they have done. Both sides can close an action item, and the
record says which of them did. An officer marking something done and the person
saying they have done it are different facts, and the system keeps them
different.

Acknowledge the conditions of their supervision. If those conditions are later
amended, the acknowledgement is withdrawn and they are asked again, so nobody
ends up bound by a version they never saw.

Sign off reentry plan checkpoints that need their agreement. Some checkpoints
need both signatures. Neither side can complete those alone, which is the
intended point rather than an obstacle.

Keep their own details current. Vehicles, where they work, family contacts.

Record a payment.

Take any training they have been assigned.

---

## Training

Training is Waypoint, and it is a full learning management system rather than a
list of links.

An administrator uploads a course. These are standard e-learning packages, the
sort produced by Articulate, Rise, Captivate and similar tools, so an agency can
use courses it already owns or buys off the shelf. Nothing has to be rebuilt.

An officer assigns a course to someone from their case file. It shows up in that
person's app.

They take it on their phone. It remembers where they got to, so they can stop
partway through and pick it up later, which matters when someone is doing it on
a bus or in a waiting room. When they finish, the result comes back
automatically: completed or not, passed or failed, the score, and how long it
took.

Completing a course and passing it are recorded separately. Someone can finish a
course and fail the test at the end, and the record says so rather than
flattening both into one status.

If a course is updated, anyone partway through keeps the version they started.
Nobody loses their progress because new material was published.

---

## What it does not do

Worth being straight about, because these come up.

It is not a case management system for the whole agency. There is no court
interface, no warrant handling, no billing, no chronological case narrative
beyond the visit record.

There is no supervisor view. Every officer sees their own caseload, and there is
currently no tier above that.

There is no reporting or analytics. Numbers exist on the dashboard for one
officer's own work, and nothing aggregates across a district or an agency.

Officers cannot be added and removed through the interface yet.

The training side handles standard packages and courses that are simply linked
to. For a linked course, all that can ever be recorded is that someone opened
it. That is a limitation of the format rather than something left to build.

Everything in the demonstration environment is invented. No real person's record
has ever been in it.

---

## Where this is going

The current build exists to answer one question: can training be delivered and
tracked inside an agency's own app, without paying for a third-party learning
platform and without sending people off to a separate website. That question is
answered.

The visit recording, transcription and summarising were not part of the original
question. They came out of watching how much of an officer's day goes on writing
up what just happened, and they are the part people react to in demonstrations.
