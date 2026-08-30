# Demo conversation — home visit script

A two-minute mock exchange to record and run through the pipeline. Every fact in
it matches the seeded demo data for **Marcus Oyelaran** — his employer, his
supervisor's name, his curfew hours, the overdue fee, the clinic appointment with
no outcome — so the transcript and summary line up with what's already on screen
in the console.

## How to record it

- **Voice Memos** on a phone. Export the `.m4a` and attach it in the console:
  *Marcus → Visits → open a visit → Audio recorded at the visit → Choose File.*
- **Two voices is better than one.** If you're on your own, drop your register a
  little for Marcus and leave a beat between speakers.
- **Don't over-enunciate.** A clean studio read isn't what this system will meet
  in the field, and the summary is more convincing when it has survived a normal
  speaking voice.
- Roughly **two minutes** at a natural pace. Don't rush the numbers.

## What it should produce

Seven commitments are spoken aloud, with owners and timing, so the summary has
real material to extract:

| # | action | owner | timing said aloud |
|---|---|---|---|
| 1 | Ring D. Kovacs to confirm the late-shift roster | officer | today |
| 2 | Call the officer *before* any late shift | subject | this week |
| 3 | Bring the pay stub to the office | subject | Friday |
| 4 | Ring the clinic and reschedule, get it in writing | subject | this week |
| 5 | Pay the $45 supervision fee | subject | Friday |
| 6 | Book the written driving test | subject | — |
| 7 | Check whether a hardship waiver covers the reinstatement fee | officer | — |

There's also a deliberate **disputed fact** — Marcus says he attended the clinic,
the officer has no record of it. Watch what the summary does with that. It should
report both accounts without deciding which is true, because deciding is the
officer's job, not the model's.

---

## The script

**ALVAREZ:** Morning, Marcus. Got a few minutes?

**MARCUS:** Yeah, come in. Sorry about the mess — I just got off shift.

**ALVAREZ:** Still on the early one? Six to half two?

**MARCUS:** Mostly. They've had me on lates twice this month, though. Thursday, and the Thursday before.

**ALVAREZ:** That's what I wanted to ask about. Your curfew is ten at night, with an extension to half twelve when you're rostered late. Were those two cleared?

**MARCUS:** I thought Kovacs called it in.

**ALVAREZ:** I've got nothing on file. I'll ring D. Kovacs today and confirm the roster. But don't assume you're covered — if you're rostered late again this week, you call me before the shift, not after.

**MARCUS:** Understood.

**ALVAREZ:** Pay stub. I asked for it last month.

**MARCUS:** I've got it. It's out in the truck. I can drop it at the office.

**ALVAREZ:** Friday at the latest. That's part of your employment goal, and it's the second month running.

**MARCUS:** I'll bring it Friday.

**ALVAREZ:** The clinic. Midtown Community Health, that was the fifteenth. I've got nothing back from them.

**MARCUS:** I went. Nobody wrote it down?

**ALVAREZ:** Not on my end. So either it didn't happen or it wasn't reported. Ring them, get it rescheduled this week, and get me something in writing either way.

**MARCUS:** This week. Okay.

**ALVAREZ:** Money. The supervision fee is forty-five dollars and it's four days late.

**MARCUS:** I know. I'll pay it when I drop the stub.

**ALVAREZ:** Friday, then. The restitution's on schedule — you've been steady on that, I'm not worried there.

**MARCUS:** How much is left on it?

**ALVAREZ:** Sixteen hundred, give or take. Don't worry about the number today.

**MARCUS:** Alright.

**ALVAREZ:** Anything you need from me?

**MARCUS:** The licence. I need to book the written test, but I can't cover the reinstatement fee till next month.

**ALVAREZ:** Book the test anyway — the date's usually weeks out. And I'll check whether there's a hardship waiver on that fee. I'll find out and let you know.

**MARCUS:** Appreciate it.

**ALVAREZ:** Same time next week. Keep your phone on.

---

## A note on what you're demonstrating

The interesting moment isn't that a machine wrote a summary. It's the two places
it **declines** to:

- **The disputed clinic visit.** The summary should record that Marcus says he
  attended and the officer has no report, without adjudicating.
- **Every action item arrives as a proposal.** Nothing on that list becomes an
  obligation until the officer accepts it, with their name and the time recorded.
  A machine reading of a conversation can put something in front of a person; it
  can't create work for one.

That's the argument worth making to an audience — not the transcription, which
everybody has seen, but the discipline around what the system is allowed to
assert.
