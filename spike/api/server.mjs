/**
 * Waypoint PoC — the composition root.
 *
 *   node spike/api/server.mjs
 *
 * Three listeners, and which is which is the architecture:
 *
 *   waypoint.mjs   :8090   the LMS. Content, registrations, results.
 *   content.mjs    :8091   uploaded course code, on a DIFFERENT ORIGIN.
 *   northwood.mjs  :8092   the customer's system. Talks to Waypoint over HTTP.
 *
 * Two rules this file exists to make visible:
 *
 *   1. Content is a separate origin. An uploaded package is third-party code
 *      we execute; same-origin with the app means a course can read a session.
 *   2. Northwood imports nothing from Waypoint. It is a customer, and it holds
 *      an API key like any other. `npm run check:boundary` proves it.
 */

import { app } from "./waypoint.mjs";
import { content } from "./content.mjs";
import { saas, seedSubjectLogins } from "./northwood.mjs";
import { sweepIdleSessions } from "./sweeper.mjs";
import { API_KEY } from "./auth.mjs";
import { DB_PATH } from "./db/connect.mjs";
import {
  APP_PORT, CONTENT_PORT, SAAS_PORT, BIND_HOST,
  APP_ORIGIN, CONTENT_ORIGIN, SAAS_ORIGIN, SWEEP_EVERY_MS
} from "./config.mjs";

const servers = [
  [app,     APP_PORT,     () => {
    console.log(`  Waypoint API      ${APP_ORIGIN}`);
    // Say which database, out loud, before anything touches it. A silently
    // relocated database looked exactly like a working one for two hours.
    console.log(`  Database          ${DB_PATH}`);
  }],
  [content, CONTENT_PORT, () => {
    console.log(`  Content origin    ${CONTENT_ORIGIN}   (separate origin, by design)`);
    console.log(`  Console           ${APP_ORIGIN}/console`);
    console.log(`  Learner site      ${APP_ORIGIN}/learn`);
    console.log(`  Mock SaaS         ${SAAS_ORIGIN}`);
    console.log(`  API key           ${API_KEY}`);
  }],
  [saas,    SAAS_PORT,    () =>
    console.log(`  (mock SaaS listening — it holds the API key, the browser never sees it)\n`)]
];

/* Bind to BIND_HOST, not to every interface.
 *
 * Behind a reverse proxy these three should only ever be reachable from
 * localhost — the browser talks to Caddy on 443 and Caddy talks to them here.
 * Left on 0.0.0.0 they are exposed the moment a firewall rule is flushed or
 * mistyped, and nothing about the app would look different until it was.
 *
 * Defaults to every interface so a laptop can still be reached from a phone
 * on the same wifi, which is the whole point of HOST in development. */
for (const [server, port, banner] of servers)
  server.listen(port, BIND_HOST, banner);

/* Northwood provisions its subjects' logins the way any customer would: over
   the API, once the servers are up. It cannot reach into Waypoint's tables. */
await seedSubjectLogins();

/* A course that is never exited cleanly leaves its session open. On a phone
   that is the normal case, not the edge — the app gets backgrounded and killed
   and Terminate never arrives. The server notices the silence itself. */
const sweeper = setInterval(sweepIdleSessions, SWEEP_EVERY_MS);
sweeper.unref?.();

/* Stop accepting connections, let in-flight requests finish, then exit. A
   process killed mid-write can leave a registration half-updated. */
let closing = false;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  if (closing) process.exit(1);          // second signal: give up and go
  closing = true;
  clearInterval(sweeper);
  console.log("\n  shutting down…");
  let left = servers.length;
  for (const [server] of servers) server.close(() => { if (--left === 0) process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
});
