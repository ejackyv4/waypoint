/**
 * Every environment-dependent value, in one place.
 *
 * Origins are computed once and shared, because the security model depends on
 * them being consistent: CORS names one of them, the player is served from
 * another, and the cookie is scoped to a third. Recomputing them per module is
 * how they drift apart.
 */

export const APP_PORT     = +(process.env.APP_PORT     || 8080);
export const CONTENT_PORT = +(process.env.CONTENT_PORT || 8081);
export const SAAS_PORT    = +(process.env.SAAS_PORT    || 8092);

// A device cannot reach "localhost" — that is its own loopback. Set HOST to
// the machine's LAN IP when running against a phone or Android emulator.
export const HOST = process.env.HOST || "localhost";

export const APP_ORIGIN     = `http://${HOST}:${APP_PORT}`;
export const CONTENT_ORIGIN = `http://${HOST}:${CONTENT_PORT}`;
export const SAAS_ORIGIN    = `http://${HOST}:${SAAS_PORT}`;

/* The /demo routes let a browser mint a launch ticket for any subject with no
   credential. They exist for the standalone harness and must not survive the
   PoC — off unless explicitly asked for. */
export const DEMO_ROUTES = process.env.WAYPOINT_DEMO_ROUTES === "1";

/* How long a runtime session may stay silent before the server closes it
   itself. A course that is never exited cleanly — the normal case on a
   phone — otherwise leaves the registration open forever. */
export const SESSION_IDLE_MS = +(process.env.WAYPOINT_SESSION_IDLE_MS || 30 * 60 * 1000);
export const SWEEP_EVERY_MS  = +(process.env.WAYPOINT_SWEEP_MS || 60 * 1000);
