# Waypoint — what it is

Waypoint lets us deliver and track training courses inside our own web and mobile
apps, instead of sending customers to a third-party learning platform. Courses
arrive as SCORM packages — the standard format every corporate e-learning tool
exports — and Waypoint unpacks them, plays them, and records what the learner
did: whether they completed it, whether they passed, their score, how long they
spent, and where they got to if they quit partway. Those results are pushed back
into our own business system automatically. There is no vendor branding, no
separate login, and no per-learner licence fee.

Architecturally it is three separate pieces. **Waypoint** is the platform: it
stores courses, tracks assignments and records results, and knows nothing about
our specific business. **The content origin** is a deliberately separate web
address that serves the uploaded course files — an uploaded course is somebody
else's code running in our customers' browsers, so it must not share an address
with our application, or that code could read a logged-in session. **Our own
application** holds the actual business logic and talks to Waypoint over a normal
web API using an API key, exactly as an outside customer would; that boundary is
enforced in the code, so the integration is genuinely proven rather than assumed.
Launching a course uses a single-use ticket that expires in sixty seconds and is
tied to one person and one course, so a launch cannot be faked by editing a URL,
and completions travel server-to-server and signed — the learner's device is
never what reports that they passed.

It is a proof of concept, built in plain Node.js with no third-party server
dependencies and a React Native mobile app. It has been proven end to end with a
real 11 MB course exported from Articulate Rise 360: played to completion, quit
and resumed across four sessions, time tracked accurately, and the result
delivered and verified. Testing against that real course rather than sample files
found seven defects in an afternoon — including elapsed time being reported as
fifteen times too long, and a server restart silently ending every course in
progress — none of which were findable with the well-behaved sample packages.
The remaining gap is playing that same large course inside the mobile app, which
is the next test.
