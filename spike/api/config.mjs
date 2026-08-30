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

/* Which interface the three servers actually bind to.
 *
 * In development that is every interface, because a phone on the same wifi has
 * to reach the laptop. Behind a proxy it should be 127.0.0.1 — the browser
 * talks to Caddy, Caddy talks to these. Binding wider there means a flushed
 * firewall rule is the only thing between the internet and an unauthenticated
 * port, and nothing would look wrong until somebody found it. */
export const BIND_HOST = process.env.WAYPOINT_BIND_HOST || "0.0.0.0";

/* Each origin can be stated outright, because behind a reverse proxy it cannot
   be derived: the public URL is https on a hostname, and the port this process
   listens on is an implementation detail the browser never sees.
   Unset, they fall back to the local http://host:port form. */
export const APP_ORIGIN     = process.env.WAYPOINT_APP_ORIGIN
  || `http://${HOST}:${APP_PORT}`;
export const CONTENT_ORIGIN = process.env.WAYPOINT_CONTENT_ORIGIN
  || `http://${HOST}:${CONTENT_PORT}`;
export const SAAS_ORIGIN    = process.env.WAYPOINT_SAAS_ORIGIN
  || `http://${HOST}:${SAAS_PORT}`;

/**
 * Where Northwood reaches Waypoint, server to server.
 *
 * `APP_ORIGIN` is the PUBLIC address — correct for a browser, wrong for one
 * process on this box calling another. Sending an internal call out to the
 * public hostname makes it leave the machine, hit the reverse proxy, and be
 * judged by whatever guards the front door. Behind an IP allowlist that means
 * the server is refused entry to itself.
 *
 * That failure is silent and badly disguised: `subjectFromToken` reads the 403
 * as "this token is no good", answers 401, and the app tells the person their
 * session expired. Nothing in the message points at the proxy, and the staff
 * console keeps working because it never takes this path — so it presents as
 * "the mobile app is broken".
 *
 * Defaults to APP_ORIGIN, which is right for development, where there is no
 * proxy and the two are the same address. Set it to the loopback address of
 * the app port in a deployment.
 *
 * This is still HTTP: Northwood remains a customer of Waypoint's API and
 * `check-boundary.mjs` still holds. Only the route changes, not the contract.
 */
export const APP_INTERNAL_ORIGIN = process.env.WAYPOINT_APP_INTERNAL_ORIGIN
  || APP_ORIGIN;

/* Whether cookies are marked Secure. Derived from the origin rather than set
   separately, so it cannot disagree with reality — a Secure cookie over http
   is silently dropped, and the symptom is "sign-in does nothing". */
export const SECURE_COOKIES = SAAS_ORIGIN.startsWith("https://");

/**
 * The content origin must not be the application origin.
 *
 * A SCORM package is third-party code this server unpacks and executes. Same
 * origin means a course's JavaScript can read the signed-in session and act as
 * the user — Rustici shipped exactly that bug and it allowed account takeover.
 *
 * Checked at startup rather than written down, because "serve content from the
 * app origin, just for now" is precisely the temporary fix that becomes the
 * vulnerability. Local development is exempt: the ports differ, which browsers
 * already treat as separate origins.
 */
for (const [name, value] of [["WAYPOINT_APP_ORIGIN", APP_ORIGIN],
                             ["WAYPOINT_CONTENT_ORIGIN", CONTENT_ORIGIN],
                             ["WAYPOINT_SAAS_ORIGIN", SAAS_ORIGIN]]) {
  try { new URL(value); }
  catch { throw new Error(`${name} must be a full URL, e.g. https://app.example.com — got "${value}"`); }
}
if (new URL(CONTENT_ORIGIN).host === new URL(APP_ORIGIN).host)
  throw new Error(
    "WAYPOINT_CONTENT_ORIGIN must be a different host from WAYPOINT_APP_ORIGIN. "
  + "Uploaded course code runs there; sharing an origin lets it read the "
  + "signed-in session.");

/* The /demo routes let a browser mint a launch ticket for any subject with no
   credential. They exist for the standalone harness and must not survive the
   PoC — off unless explicitly asked for. */
export const DEMO_ROUTES = process.env.WAYPOINT_DEMO_ROUTES === "1";

/* How long a runtime session may stay silent before the server closes it
   itself. A course that is never exited cleanly — the normal case on a
   phone — otherwise leaves the registration open forever. */
export const SESSION_IDLE_MS = +(process.env.WAYPOINT_SESSION_IDLE_MS || 30 * 60 * 1000);
export const SWEEP_EVERY_MS  = +(process.env.WAYPOINT_SWEEP_MS || 60 * 1000);

/* ---- speech-to-text and summarisation ------------------------------------
 *
 * Both are OFF unless a key is set. Nothing here reaches the network on its
 * own: a recording is transcribed when somebody asks for it, never on upload.
 * That is deliberate — a recording of a supervision conversation leaving the
 * building is a decision an officer makes, not a side effect of pressing stop.
 *
 * The transcription endpoint speaks the OpenAI audio API, which is also what
 * Groq and the self-hosted whisper servers implement. One client, and the
 * choice of who hears the audio is a URL — which is the whole point, because
 * for this data that choice may well end up being "a machine we own".
 */
export const STT_URL   = process.env.WAYPOINT_STT_URL
  || "https://api.openai.com/v1/audio/transcriptions";
export const STT_KEY   = process.env.WAYPOINT_STT_KEY || "";
export const STT_MODEL = process.env.WAYPOINT_STT_MODEL || "whisper-1";

export const LLM_URL   = process.env.WAYPOINT_LLM_URL
  || "https://api.anthropic.com/v1/messages";
export const LLM_KEY   = process.env.WAYPOINT_LLM_KEY
  || process.env.ANTHROPIC_API_KEY || "";
export const LLM_MODEL = process.env.WAYPOINT_LLM_MODEL || "claude-sonnet-5";

/* Which wire format the summariser speaks. Anthropic and the OpenAI-compatible
   crowd — OpenAI, Groq, and most self-hosted servers — differ in the auth
   header, the tool envelope and where the answer sits, but not in anything
   that matters here. Sniffed from the URL so the common cases need no
   configuration, and overridable for the ones that are not obvious. */
export const LLM_API = process.env.WAYPOINT_LLM_API
  || (/anthropic/i.test(LLM_URL) ? "anthropic" : "openai");

/* How long either call may take before it is abandoned. A half-hour recording
   is a slow request, but a request with no ceiling is a job that never ends
   and a row stuck on "running" forever. */
export const AI_TIMEOUT_MS = +(process.env.WAYPOINT_AI_TIMEOUT_MS || 5 * 60 * 1000);

export const STT_READY = () => !!STT_KEY;
export const LLM_READY = () => !!LLM_KEY;
