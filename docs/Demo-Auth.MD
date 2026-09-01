# Demo access and reset replacement plan

**Status:** plan only. No part of the current Door, Caddy configuration, mobile
configuration or hosted demo should be removed until the verification and
rollback steps below are ready.

## Outcome

Replace the IP-based Door with a stable, easy sales-demo workflow:

1. Salespeople open the deployed web app or TestFlight app from any network.
2. They sign in with the application's normal demo credentials.
3. When they need a clean demo, they open a separate Demo Control page.
4. They enter one shared demo-reset password and press **Reset demo**.
5. The page reports **Resetting** and then **Demo ready** or a clear failure.

No salesperson should need to know an IP address, change a configuration file,
use GitHub, connect over SSH or ask a developer to allow their network.

## The three IP concerns are separate

| Concern | Target behavior |
|---|---|
| Each developer's physical phone must reach that developer's Mac | Remains a local-development concern. It is not part of this deployment-auth change. |
| The deployed application currently embeds an `sslip.io` hostname containing the server IP | Replace it with stable domain names. A future server move changes DNS, not TestFlight. |
| Door grants each salesperson's current public IP access for seven days | Remove this completely. Deployed demo access uses normal application authentication. |

Creating a domain name alone does not remove Door. The domain solves the stable
server-address problem; deliberately removing the visitor IP allowlist solves
the Door problem.

## Target architecture

Use four HTTPS hostnames. The names below are examples; select the real domain
before implementation.

```text
app.demo.example.com        Waypoint API, learner site and LMS console
northwood.demo.example.com  Northwood web application and API
content.demo.example.com    SCORM player and package assets
control.demo.example.com    Demo Control reset page
```

All four may point to one server or managed ingress. The content hostname must
remain separate from the application hostname: uploaded SCORM packages are
third-party JavaScript and must never share the application's origin.

```text
Internet
   |
   +-- app.demo... --------> Waypoint :8090
   +-- northwood.demo... ---> Northwood :8092
   +-- content.demo... -----> Content :8091
   +-- control.demo... -----> Demo Control :8099

Demo Control :8099
   |
   +-- fixed reset command --> snapshot --> restore baseline --> restart app
```

Caddy or the managed ingress continues to provide TLS and hostname routing.
It no longer imports a generated IP list or reloads whenever a salesperson
changes networks.

## Security boundary

This design is proportionate only while the hosted environment contains
synthetic demo data.

- Staff and subjects continue to use their existing application logins.
- Session expiry, account scoping and sign-in throttling remain in force.
- The LMS console must continue to require its API key until it has named admin
  accounts. Consider preventing public access to the console path entirely.
- SSH remains key-only and is never exposed through Demo Control.
- Ports 8090–8092 and 8099 remain bound to loopback/private networking. Only the
  HTTPS proxy is public.
- Demo Control accepts only a password and a reset action. It is not a general
  shell, file browser or server-admin page.
- If real subject data is ever introduced, stop and replace the shared reset
  password with named accounts and MFA before continuing.

The shared reset password is not a product login. It authorizes one destructive
operation against synthetic demo data.

## Decisions required before implementation

Record these answers in this document before touching the hosted environment:

- [ ] Domain name and who controls its DNS.
- [ ] Final four hostnames.
- [ ] Hosting target and stable ingress address.
- [ ] Whether the current demo remains online during cutover.
- [ ] Who is allowed to know and rotate the reset password.
- [ ] Exact baseline contents: accounts, subjects, visits, programs and courses.
- [ ] Whether reset removes recordings, transcripts, summaries and action items.
- [ ] Maximum acceptable reset time.
- [ ] Who receives an alert when a reset fails.

Recommended defaults:

- Keep the existing baseline behavior.
- Remove generated recordings, transcripts, summaries and action items.
- Snapshot the current database before every reset.
- End active sessions as part of the reset and say so in the confirmation.
- Keep the reset password outside Git in root-readable server configuration.

## Step-by-step implementation

### Phase 1 — Establish a safe working baseline

1. Create a dedicated feature branch from the latest `main`.
2. Record the current hosted URLs, service status and Caddy configuration.
3. Take and download a verified database snapshot.
4. Confirm the current baseline can still be restored with
   `waypoint-demo reset`.
5. Save a copy of the current Door service, environment and generated Caddy
   snippet for rollback.
6. Confirm the demo contains synthetic data only.

Do not run any reset or database command until the operator has explicitly
confirmed the target environment and database path.

### Phase 2 — Create stable DNS and TLS

1. Reserve a stable public IP or use a managed ingress whose address is stable.
2. Add DNS records for the four selected hostnames.
3. Use a short DNS TTL, such as 300 seconds, during cutover.
4. Configure Caddy/ingress routes for each hostname.
5. Obtain and verify TLS certificates.
6. Confirm ports 8090–8092 and 8099 are not directly reachable externally.
7. Confirm the content origin is still a different hostname from the app.

Initially, the new hostnames may retain a temporary operator-only restriction
while the application and TestFlight build are verified. Do not recreate the
self-service public-IP grant system.

### Phase 3 — Replace Door with Demo Control

Create a small reset-only service, preferably by reducing the existing Doorman
rather than writing a second overlapping system.

Keep:

- Scrypt-hashed password verification.
- Maximum request-body size.
- Five failed attempts followed by a fifteen-minute lockout.
- A short-lived, single-use confirmation token.
- The existing fixed reset command.
- Snapshot-before-reset behavior.
- Clear server logging.

Remove:

- Reading a visitor IP for admission.
- `grants.json`.
- Seven-day grants and the hourly grant sweeper.
- `DOOR_PERMANENT`.
- Generation of `/etc/caddy/allowed.caddy`.
- `systemctl reload caddy` after a visitor signs in.
- Any message claiming a network has been allowed through.

Rename the concepts so their scope is honest:

```text
doorman service/file/environment  -> demo-control
DOOR_HASH                         -> DEMO_CONTROL_HASH
DOOR_RESET_CMD                    -> DEMO_CONTROL_RESET_CMD
access hostname                   -> control hostname
```

The page should show:

- Environment name, so a salesperson cannot mistake another environment for
  the demo.
- Last successful reset time.
- Whether a reset is currently running.
- A password field.
- A confirmation stating that active demo sessions will end.
- **Reset demo to baseline**.
- A visible success or failure result.

Reset execution requirements:

1. Allow only one reset at a time.
2. Never construct a shell command from request data.
3. Accept only the configured fixed executable and arguments.
4. Return a job identifier immediately if the reset is asynchronous.
5. Let the page poll job status until completion.
6. Apply a sensible timeout.
7. Snapshot before replacing data.
8. Verify the application is healthy after restart.
9. Report failure without claiming the reset succeeded.
10. Log timestamp, requester IP, user agent, duration and result. The IP is for
    an operational audit only; it never grants access.

### Phase 4 — Preserve and verify the reset executor

Reuse `spike/ops/waypoint-demo` initially. It already contains the hard-earned
rules for a safe SQLite reset.

Verify that it:

1. Names the exact database before acting.
2. Refuses to run without the expected baseline.
3. Takes a consistent snapshot rather than copying a live WAL database.
4. Stops the application before replacing the database.
5. Deletes stale `-wal` and `-shm` files.
6. Restores ownership and permissions.
7. Restarts the application and checks its health.
8. Retains a bounded number of recovery snapshots.
9. Produces output Demo Control can turn into an honest status.

The sales page may restore the baseline but may not create or replace the
baseline. Baseline management remains an operator action.

### Phase 5 — Remove deployed-app knowledge of Door

Update the mobile and web behavior only after Demo Control is working.

1. Remove `DOOR_URL` from the deployed mobile configuration.
2. Remove sign-in messages instructing users to open Door after a `403`.
3. Treat `401`/`403` according to the application's actual authentication and
   authorization rules.
4. Replace the IP-bearing `sslip.io` origins in the release configuration with
   the selected stable domains.
5. Keep local development host detection unchanged in this phase.
6. Ensure server-to-server Northwood → Waypoint calls use their internal
   service address, not a trip out through the public proxy.

Likely repository touchpoints:

```text
spike/ops/doorman.mjs
spike/ops/set-passphrase.mjs
spike/ops/waypoint-demo
spike/mobile/config.js
spike/mobile/app.config.js
spike/mobile/App.js
docs/SECURITY.md
docs/BUILD.md
docs/DEMO.md
docs/DEPLOYMENT.md or the private deployment runbook
```

Do not mix the separate local `WRITTEN_HOST` cleanup into this deployment
change unless it is deliberately assigned and tested as its own commit.

### Phase 6 — Build and verify the TestFlight app

1. Confirm the build target prints the hosted demo environment.
2. Inspect the generated Expo configuration and verify all hosted origins.
3. Produce a development/device build first.
4. Test it on Wi-Fi and cellular before creating a TestFlight build.
5. Confirm staff and subject sign-in.
6. Confirm programs launch from the separate content hostname.
7. Confirm recording, upload and playback on a physical phone.
8. Create the TestFlight build only after those checks pass.
9. Keep the old hosted environment available until the TestFlight build is
   proven, if the existing build cannot be repointed remotely.

### Phase 7 — Remove the IP gate

1. Schedule the cutover when no sales demonstration is running.
2. Take a final server and database snapshot.
3. Validate the Caddy/ingress configuration before applying it.
4. Remove imports of the generated IP-allowlist snippet from the three product
   hostnames.
5. Keep Demo Control password-protected at its own hostname.
6. Reload the proxy once.
7. Test from a network and cellular connection that were never previously
   granted.
8. Verify that the normal sign-in page is reachable but protected data is not.
9. Stop and disable the old Doorman only after the replacement works.
10. Preserve its files through the rollback window; delete them later.

### Phase 8 — Update operations and onboarding

1. Put the Demo Control URL and sales instructions in `DEMO.md`.
2. Document password rotation without writing the password into a file, chat or
   shell history.
3. Document how an operator views reset status and logs.
4. Document baseline creation separately from baseline restoration.
5. Update the private deployment runbook with real hostnames and service names.
6. Remove all current Door and `sslip.io` instructions after cutover.
7. Tell sales that a reset ends active demo sessions.
8. Give sales a two-line runbook: open the control page, reset, wait for green.

## Verification matrix

### Access

- [ ] Web app opens from an unrecognized home Wi-Fi address.
- [ ] Web app opens through a corporate VPN.
- [ ] TestFlight app opens over Wi-Fi.
- [ ] TestFlight app opens over cellular.
- [ ] An unauthenticated caller cannot read subjects, visits, recordings,
      registrations or deliveries.
- [ ] Staff access remains scoped to the permitted caseload.
- [ ] Subject access remains scoped to that subject.
- [ ] The LMS console still requires its API key or is not public.
- [ ] Direct access to ports 8090–8092 and 8099 is blocked.

### Content

- [ ] Course content is served from the separate content hostname.
- [ ] A launch ticket remains short-lived and single-use.
- [ ] SCORM progress, resume, pass/fail and completion still work.
- [ ] The content hostname cannot read application cookies.
- [ ] Licensed-content exposure is reviewed before non-sample packages are
      placed in a publicly reachable content service.

### Demo Control

- [ ] Wrong password shows one generic failure message.
- [ ] Five failures cause a temporary lockout.
- [ ] The confirmation token is single-use and expires.
- [ ] Two simultaneous reset requests result in only one reset.
- [ ] The page clearly shows a reset in progress.
- [ ] A successful reset restores the agreed baseline.
- [ ] A failed reset never displays **Demo ready**.
- [ ] The app returns healthy after reset.
- [ ] The pre-reset snapshot can be restored by an operator.
- [ ] The browser cannot choose a command, path or database.
- [ ] The reset password never appears in Git, logs, HTML or browser history.

### Regression

- [ ] API smoke suite passes against a disposable local database.
- [ ] Boundary, documentation and feedback checks pass.
- [ ] Manual web walkthrough passes.
- [ ] Manual physical-iPhone walkthrough passes.
- [ ] Reset is tested immediately before—not during—the sales handoff.

## Cutover rollback

Prepare rollback before changing DNS or proxy rules.

If the new public hostnames fail:

1. Restore the prior Caddy/ingress configuration.
2. Re-enable the old Doorman service and generated allowlist import if needed.
3. Point DNS back to the former environment, if it remains available.
4. Keep the former TestFlight build available until the new build is proven.

If reset fails:

1. Disable the Demo Control reset action.
2. Inspect the fixed reset command's output and service logs.
3. Restore the automatic pre-reset snapshot.
4. Verify database ownership, remove stale WAL/SHM files and restart the app.
5. Do not retry from the browser until an operator understands the first
   failure.

## Definition of done

This work is complete only when:

- Sales can use web and TestFlight demos from Wi-Fi or cellular without IP
  setup.
- Sales can reset the demo from one bookmarked password-protected page.
- Reset gives an honest, visible result and cannot run twice concurrently.
- Every reset is snapshotted and recoverable.
- The application and content remain on separate origins.
- Product data remains protected by application authentication.
- Operator-only surfaces are not anonymously exposed.
- No deployed mobile configuration contains the server's numeric IP address.
- The old Door grant files, Caddy generation and mobile instructions are no
  longer active.
- Documentation matches the system that is actually running.

## Tomorrow's starting sequence

1. Answer the decisions checklist.
2. Confirm whether this is a brand-new environment or a cutover from the
   existing DigitalOcean demo.
3. Select the domain and four hostnames.
4. Confirm the baseline contents and reset scope.
5. Create the feature branch.
6. Implement Demo Control locally around a disposable database.
7. Test success, failure, concurrency and recovery locally.
8. Only then provision DNS/TLS and begin hosted-environment work.
