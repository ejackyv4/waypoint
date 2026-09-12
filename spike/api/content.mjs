/**
 * The content origin.
 *
 * Serves unpacked SCORM packages and the player page, on a DIFFERENT ORIGIN
 * from the application. That is the whole point of this file existing
 * separately: uploaded course code is third-party code we execute, and it must
 * never be same-origin with the app, where it could read a session.
 *
 * The player lives here rather than on the app origin because the ADL API
 * discovery algorithm walks window.parent looking for the adapter, and that
 * only works same-origin. The player then calls the app API over CORS.
 *
 * Nothing here reads the database. It serves files.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { CONTENT_DIR } from "./ingest.mjs";
import { APP_ORIGIN, CONTENT_ORIGIN } from "./config.mjs";
import { MIME } from "./http.mjs";

/**
 * What an uploaded package is allowed to do once it is running.
 *
 * The course needs its own scripts, styles and media, and it needs to talk to
 * the player that frames it. It does not need to reach anything else on the
 * network, and it must never be framed by a third party.
 *
 * `frame-ancestors` is why this is a header and not a <meta> tag — the meta
 * form is ignored for that directive.
 */
/* The player frames the course and calls the app API home. It may connect to
   exactly one other origin and frame exactly this one. */
const PLAYER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  `connect-src 'self' ${APP_ORIGIN}`,
  `frame-src 'self' ${CONTENT_ORIGIN}`,
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"          // the player itself is never framed
].join("; ");

const CONTENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",  // authoring tools emit both
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  // xAPI packages send statements and state directly to the app origin. The
  // existing SCORM packages still talk only to their parent player.
  `connect-src 'self' ${APP_ORIGIN}`,
  "form-action 'none'",
  "base-uri 'none'",
  `frame-ancestors 'self' ${CONTENT_ORIGIN}`
].join("; ");

/* ================================================================
   CONTENT ORIGIN  —  port 8081
   Serves unpacked packages and the player. Nothing here can read the
   app's cookies, because it is a different origin.
================================================================ */
export const content = createServer(async (req, res) => {
  const url = new URL(req.url, CONTENT_ORIGIN);

  if (url.pathname === "/player") {
    const html = await readFile(new URL("./player.html", import.meta.url), "utf8");
    const body = html.replace("__APP_ORIGIN__", APP_ORIGIN);
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
      "X-Content-Type-Options": "nosniff",
      // The player is our code, but it is the frame a course runs inside, so
      // it gets its own policy rather than none. It is the ONE page on this
      // origin allowed to talk to the app API — that is its whole job.
      "Content-Security-Policy": PLAYER_CSP,
      "Referrer-Policy": "no-referrer"
    });
    return res.end(body);
  }

  const m = url.pathname.match(/^\/content\/(\d+)\/(.+)$/);
  if (!m) { res.writeHead(404); return res.end("not found"); }

  // Contain the path: normalize, then verify it is still inside the
  // version's directory. Traversal was already rejected at ingest, but
  // serving is a second place it could be attempted.
  const root = join(CONTENT_DIR, m[1]);
  const file = normalize(join(root, decodeURIComponent(m[2]).split("?")[0]));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end("forbidden"); }

  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    const buf = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": buf.length,
      "Cache-Control": "no-store",
      // Uploaded content is third-party code. Never sniffed, never framed
      // by anyone but us.
      "X-Content-Type-Options": "nosniff",
      // Uploaded course code runs under this policy.
      "Content-Security-Policy": CONTENT_CSP,
      "Referrer-Policy": "no-referrer"
    });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});
