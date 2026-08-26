# Waypoint LMS — discovery brief

**Waypoint** is the internal codename (not yet trademark- or domain-checked, so treat
it as a working name until it is). Chosen because a program is a journey with
checkpoints, and the platform's job is to track someone moving through them.

Discovery brief — 2026-08-21. Written for a client whose SaaS CRM assigns "programs"
to customers and shows them in a mobile app. Today those programs just open an
external website. The idea is to replace that with the client's own learning platform.

*Plain-language version. Every technical term is explained where it's used, and there's
a glossary at the end.*

---

## The short answer: yes, this is very possible

Playing a SCORM file is a solved problem. There's a free, well-built, open-source
piece of software that does the hard part, and you can have a real SCORM course
playing in a browser inside of about a week.

**The project is not risky. It's just bigger than it looks.** The risk isn't "can we
do it" — it's that three specific things quietly cost more than people expect:

1. **Old courses are weird.** Every tool that makes courses (Articulate, Adobe
   Captivate, iSpring, etc.) produces slightly different files. Getting *one* course
   to play is easy. Getting *everyone's* courses to play is the actual job.
2. **Offline on mobile.** SCORM was invented in 2001 for desktop computers on a wired
   connection. It has no concept of "no signal." Making it work on a phone in airplane
   mode is real engineering, and it's the single biggest cost swing in the project.
3. **You'd be running other people's code.** A SCORM file is a zip full of web pages
   and scripts that you have to actually run. That has to be handled carefully or it
   becomes a way into the system.

None of those are dealbreakers. They're just the things to budget for honestly up
front rather than discover in month four.

---

## What a SCORM file actually is

This is worth understanding because it drives everything else.

**SCORM is not a video format or a document format.** It's an agreement between a
course and a learning platform about two things:

### 1. How the course is packaged

A SCORM file is a **.zip** containing a bunch of web pages, images, videos and
scripts — plus one special file called `imsmanifest.xml` sitting at the top level.
That file is the table of contents: it lists what's in the course, what order it goes
in, and which page to open first.

*(Common failure: someone zips the folder instead of the folder's contents, which
buries that file one level down and the whole package is rejected. Reportedly the
number-one cause of failed imports everywhere.)*

### 2. How the course talks to your platform

This is the clever/annoying part. When the course starts playing, it goes looking for
a **specific piece of JavaScript your platform has to provide**, with a specific name
and specific functions. Then it talks to it, roughly like this:

> **Course:** "I'm starting."
> **Course:** "Where did this person leave off last time?"
> **Your platform:** "Slide 14."
> **Course:** "OK. …They just scored 80. Save that."
> **Course:** "They finished. Mark it complete. I'm done now."

That's it. **Your platform's entire SCORM responsibility is to answer those messages
and remember the answers.** Everything else you build — the catalog, the assignments,
the reporting, the mobile app — is your own product, not SCORM.

### What you end up storing

Per person, per course, per attempt:

- **Status** — not started / in progress / complete
- **Pass or fail** — separate from complete. A person can *finish* a course and
  *fail* it. Keep these as two different fields; collapsing them into one is a
  mistake that's painful to undo later.
- **Score** — the number, plus what the min and max were
- **Bookmark** — where they left off, so "resume" works
- **Time spent**
- **A blob of the course's own private notes** — the course saves its internal state
  here (which questions they answered, etc.). You don't read it, you just store it and
  hand it back.
- **Question-by-question detail**, if the course reports it

---

## What you'd actually be building

The SCORM part is maybe 20% of this. Here's the rest.

### Getting courses into the system
- Upload a zip, check it's safe, unpack it, read the table of contents
- Store it somewhere (these get large — hundreds of megabytes when there's video)
- **Version them properly.** If a client uploads an updated course while 300 people
  are halfway through the old one, those 300 people need to keep seeing the old one.
  Never overwrite a course in place.

### Other content types (the "things I'm not aware of")
SCORM won't be the only thing they want to serve. Realistically:
- Plain video (needs converting/streaming, and its own progress tracking)
- PDFs and documents, with a "they opened it" record
- Quizzes and surveys you build natively
- Links out to external websites — **the thing they do today**, done properly
- YouTube / Vimeo embeds
- Live sessions (Zoom, Teams) with attendance
- Assignments where someone uploads a file and a human grades it
- **H5P** — a free, popular format for interactive content, if they want people to
  author things without buying Articulate

### The learning-platform layer
- Assigning courses, due dates, reminder emails
- Attempts, retakes, and a pass mark
- Prerequisites and multi-course paths
- **Certificates**, and expiry dates for anything that needs renewing annually
- Reporting: who finished, how long they took, which questions everyone gets wrong
- **Multi-tenant handling** — since the CRM is SaaS, each client company needs its own
  course library, plus possibly a shared one, plus seat counting

### Connecting back to the CRM
- The CRM stays in charge of *people* and *who's assigned what*
- The new platform becomes the record of *what they did*
- The platform notifies the CRM when someone completes or scores something, computer
  to computer, with retries if the CRM is down

---

## Build it, or buy the SCORM part?

There are three options and they're all reasonable.

**Option A — free open source.** A library called
[`scorm-again`](https://github.com/jcputney/scorm-again) does the SCORM conversation
described above. It's free to use commercially with no strings attached (an "MIT
license" — the most permissive kind, meaning: use it, sell it, no fees, no obligation
to publish your own code). It handles both major SCORM versions and it's actively
maintained. It does *not* handle uploading, checking, or storing courses — that's
still yours to build.

**Option B — license the commercial engine.**
[Rustici Engine](https://rusticisoftware.com/products/rustici-engine/) is the industry
standard for exactly this: dropping SCORM support into somebody else's platform. It
covers every version and every quirk, and sells an offline-mobile add-on separately.
Pricing isn't public — it's an upfront fee plus an annual one, priced on how many
learners and *whether you're reselling the platform*. Since this client sells their
CRM to other companies, expect the higher tier.

**Option C — use a hosted service to prove it first.** SCORM Cloud is a paid service
that plays SCORM files for you via an API. Good for validating the product with the
client's real courses before committing to a build.

### The recommendation

> **Build the platform, use the free library for SCORM, and get a price from Rustici
> so it's a known escape hatch.**
>
> The bespoke value is in the catalog, the assignments, the reporting and the CRM
> integration — none of which you can buy anyway. The free library covers the SCORM
> conversation genuinely well. If the "everyone's courses are weird" problem starts
> eating the schedule, you switch to the paid engine with a number already on the
> table instead of a panic.

---

## The three hard parts, in more detail

### 1. Old courses are weird

Getting a SCORM course to play is a week. Getting *all* SCORM courses to play is the
project. Specific things that bite:

- There are two major SCORM versions (**1.2** from 2001, and **2004**, which itself has
  four different editions). You need both. 1.2 is simpler and still the most common.
- The older version has a hard **4,096-character limit** on that "course's private
  notes" field. Articulate courses routinely hit it, and when they do, "resume where
  I left off" silently stops working. Classic support ticket.
- The two versions record *time spent* in completely different formats. Mix them up
  and every time-based report is wrong.
- Really old courses use Flash, or open pop-up windows, or are built for a fixed
  1024×768 screen. Those are simply dead on a phone.
- Some courses are made of several sub-lessons that have to be combined into one
  overall pass/fail.

**The single highest-value thing to do about all of this:** collect five to ten of the
client's *real* course files right now, plus one export from each major authoring tool,
and test against that same set forever. That collection is worth more than any amount
of up-front design.

### 2. Mobile, and especially offline

Their main delivery channel is a phone app, and SCORM is genuinely bad at phones.

Online, it works: the course runs inside an embedded browser window in the app, and
that window talks to your server. Fine.

**Offline is the problem. SCORM has no offline concept whatsoever.** If someone loads
a course and then loses signal, everything they did is lost. To fix that you have to
download the whole course to the phone, run it locally, fake the platform's side of
the conversation on the device, save the results locally, and sync them up when signal
returns — including deciding what happens if they did the course on two devices.

Two supporting signals for how hard this is: Rustici sells offline as a **separately
priced add-on** rather than including it, and there's a second wrinkle — when someone
swipes the app closed, the course never gets to say "I'm done," so the server has to
notice the silence and close the session itself.

**This one question — is offline required? — is the biggest single cost swing in the
whole project.** Ask it first.

### 3. Running other people's code safely

You'd be letting customers upload zip files full of working web pages and scripts, and
then running them. Two categories of problem:

**Booby-trapped zips.** A zip file can be crafted to write files *outside* the folder
you unpack it into, overwriting things it shouldn't (nicknamed "zip-slip"). It can also
be a tiny file that expands to hundreds of gigabytes and fills the disk. And the table
of contents file can be rigged to make the server fetch or leak other files while it's
being read. All of these are well understood and defended against — you just have to
know to do it.

**Course scripts reaching into your platform.** Browsers decide what a script is
allowed to touch based on which web address it came from. If you serve the uploaded
course from the *same* address as the platform, the course's scripts can read the
logged-in user's session and act as them. **The fix is to serve course content from a
separate address** (e.g. `content.theirlms.com` vs `app.theirlms.com`), with a
controlled channel between the two. The free library has this built in specifically
because it matters. Worth noting the commercial engine itself had a bug of exactly
this kind that allowed account takeover — this is a real category, not a theoretical one.

---

## One thing to fix regardless: how courses get launched

Today: the app opens a website and passes the customer's ID in the web address.

**That means anyone can change the number in the address and become a different
customer.** The website is trusting the phone to say who the user is, and the phone can
say anything. This is the same class of bug as the mobile login bypass documented in
this repo's `CLAUDE.md` — a value the client sends is not proof of identity.

The standard fix, and what the new platform should do from day one:

1. The server creates a **one-time ticket** that expires in about a minute and is tied
   to one specific person and one specific course
2. The app opens the platform with that ticket
3. The platform checks it, throws it away, and starts a session limited to *that
   course only*

Same principle on the way back: **the phone must never be the thing that tells the CRM
"they passed."** That has to go server-to-server, where the customer can't touch it.

---

## Rough phasing

| Phase | What gets built | Size |
|---|---|---|
| 0 | Discovery — collect real course files, answer the questions below | 1–2 weeks |
| 1 | Core: people/course/attempt records, secure launch tickets, saving progress, SCORM 1.2 playing in a browser | Medium |
| 2 | Upload, safety checks, versioning, isolated content hosting | Medium |
| 3 | SCORM 2004, including multi-lesson courses and ordering rules | Medium–Large |
| 4 | Mobile playback (online) + CRM integration | Medium |
| 5 | Other content types, quizzes, certificates, reporting | Large |
| 6 | **Offline mobile** | **Large — price separately, or buy it** |
| 7 | Modern tracking standards for anything authored in-house | Medium |

---

## Questions for the client — these change the answer

Ordered by how much they move the estimate.

1. **Is offline required on mobile?** Biggest cost swing by far.
2. **What courses do they actually have?** Which SCORM version, made with which tool?
   **Get five real files before anyone designs anything.**
3. **Who uploads courses** — the client themselves, or their customers? If it's their
   customers, all the safety work above becomes mandatory rather than sensible.
4. **Do they need to *create* courses, or only *play* them?** Building an authoring
   tool is a second product. (H5P is the cheap middle ground.)
5. **Certificates, annual renewals, any regulated industry?**
6. **Is there a shared course library across their client companies, or is each one
   separate?** Is content ever sold between them?
7. **How many learners, and how much content?**
8. **Do the existing external-website programs have to keep working during the
   switchover?** (Almost certainly yes — so a secure "link out to a website" content
   type belongs in Phase 1.)
9. **If a client company leaves, what do they get to take with them?**

---

## Glossary

Terms used above and terms that'll come up in any vendor conversation.

| Term | Plain meaning |
|---|---|
| **LMS** | Learning Management System. The platform being built. |
| **SCORM** | The 2001-era standard for packaging a course and letting it talk to a platform. Two versions still in use: 1.2 and 2004. |
| **SCORM 1.2 / 2004** | Older and newer. 1.2 is simpler and more common; 2004 adds ordering rules and separates "finished" from "passed." Support both. |
| **Manifest** (`imsmanifest.xml`) | The table-of-contents file inside a SCORM zip. Must be at the top level. |
| **SCO** | One lesson inside a SCORM package. A package can hold several. |
| **Runtime / runtime library** | The piece of code that has the live back-and-forth conversation with a course while it's playing. `scorm-again` is one. |
| **Initialize / Terminate / Commit** | The actual message names the course sends: "I'm starting," "I'm done," "save this now." |
| **Registration** | One person's enrollment in one course — the record that holds their status, score and bookmark. The core record of any LMS. |
| **Rollup** | Combining several lessons' results into one overall course result. |
| **Suspend data** | The course's own private notes about where the learner is. You store it, you don't read it. Capped at 4,096 characters in SCORM 1.2. |
| **MIT license** | The most permissive open-source license. Free to use commercially, no fees, no obligation to share your code. |
| **Open source** | Code published publicly. Whether you can use it commercially depends on its license — MIT means yes, freely. |
| **xAPI** (a.k.a. Tin Can) | The modern successor to SCORM. Records "person did thing" statements and can track activity outside a course. Needs a separate database called an **LRS**. |
| **cmi5** | xAPI with SCORM-style course structure added back. The sensible target for anything authored in-house going forward. |
| **LRS** | Learning Record Store — the database xAPI statements go into. Free options exist. |
| **LTI** | The standard, secure way to launch a *third-party* tool and get grades back. The proper version of what they're doing today with a customer ID in the URL. |
| **H5P** | A free format for interactive content (drag-and-drop, branching video, quizzes). A cheap way to offer authoring. |
| **iframe** | An embedded window showing one web page inside another. How SCORM courses get displayed. |
| **WebView** | The same idea inside a phone app — an embedded browser window. |
| **Origin** | The web address a page came from. Browsers use it to decide what a script may touch — which is why uploaded course content must be served from a *different* address than the platform. |
| **Zip-slip** | A malicious zip file crafted to write files outside the folder you unpack it into. |
| **Webhook** | One system notifying another automatically over the internet. How the LMS would tell the CRM someone finished. |
| **IDOR** | A bug where changing an ID in a web address lets you see or act as someone else. What the current launch method has. |
| **Rustici** | The company behind the commercial SCORM engine and SCORM Cloud. Effectively the industry authority on this standard. |

---

## Sources

- [scorm-again — the free runtime library](https://github.com/jcputney/scorm-again)
  and its [documentation](https://jcputney.github.io/scorm-again/)
- [SCORM versions explained — Rustici](https://scorm.com/scorm-explained/business-of-scorm/scorm-versions/)
- [Rustici Engine](https://rusticisoftware.com/products/rustici-engine/) and the
  [offline mobile add-on](https://rusticisoftware.com/products/rustici-engine/offline-scorm-player-extension/)
- [SCORM vs xAPI vs cmi5 — CommLab](https://www.commlabindia.com/blog/scorm-vs-xapi-cmi5-elearning-standards)
- [cmi5 vs SCORM — iSpring](https://www.ispringsolutions.com/blog/cmi5-vs-scorm) and
  [SCORM on mobile devices — iSpring](https://www.ispringsolutions.com/blog/scorm-on-mobile)
- [Account-takeover flaw in Rustici's SCORM engine — Tenable](https://www.tenable.com/security/research/tra-2022-21)
  and [Rustici's own take on SCORM security](https://scorm.com/blog/scorm-security-some-perspective/)
- [SCORM package structure and why imports fail](https://toscorm.com/resources/scorm-package-guide/)
  and [Moodle's SCORM FAQ](https://docs.moodle.org/22/en/SCORM_FAQ)
- [TRAX LRS](https://traxlrs.com/) and the
  [ADL registry of conformant record stores](https://adopters.adlnet.gov/products/all/0)
