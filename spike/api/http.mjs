/**
 * The HTTP plumbing both servers share.
 *
 * Kept deliberately small. Each server has its own `json` writer because they
 * name *different* CORS origins, and getting that wrong is a security bug
 * rather than a formatting one — so the origin is a required argument, not a
 * default someone can forget.
 */

/** Write a JSON response. `origin` is the single origin allowed to read it. */
export const jsonTo = origin => (res, code, body) => {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(s),
    "Cache-Control": "no-store",
    // Narrow: one named origin, never "*".
    "Access-Control-Allow-Origin": origin
  });
  res.end(s);
};

/**
 * Body parser, with a ceiling.
 *
 * The whole body is buffered in memory, so an unbounded read is a way to
 * exhaust the process with one request. A megabyte is far more than any JSON
 * payload here needs; the routes that accept an image pass their own limit.
 *
 * A malformed or oversized body is MARKED rather than thrown, so a handler can
 * answer 400 or 413 instead of the process answering 500.
 */
export async function readJson(req, maxBytes = 1024 * 1024) {
  /* Reject on the declared length before reading a byte. Destroying the socket
     mid-request instead leaves the client with no answer at all — curl reports
     a bare "100 Continue" — and a caller that cannot tell "too large" from
     "the network died" will retry the same doomed upload. */
  const declared = Number(req.headers["content-length"]);
  if (declared > maxBytes) { req.resume(); return { __tooBig: true, maxBytes }; }

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    // Backstop for a chunked body that declared no length. Stop keeping the
    // bytes, but let the request finish so the response can be delivered.
    if (size > maxBytes) { req.resume(); return { __tooBig: true, maxBytes }; }
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { return { __bad: true }; }
}

/** Read a body without interpreting it. xAPI State documents may be JSON,
 * text, or binary, so forcing them through the JSON parser would corrupt
 * valid course resume data. */
export async function readBody(req, maxBytes = 4 * 1024 * 1024) {
  const declared = Number(req.headers["content-length"]);
  if (declared > maxBytes) { req.resume(); return { __tooBig: true, maxBytes }; }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) { req.resume(); return { __tooBig: true, maxBytes }; }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/**
 * Served content types are allowlisted, never sniffed from the file.
 *
 * The list is short on purpose — anything not named here is served as
 * octet-stream, so an uploaded package cannot talk the browser into executing
 * something by naming it cleverly.
 *
 * But a type that is MISSING fails silently and confusingly: the first real
 * Rise 360 export shipped a .ttf, which browsers ignore when it arrives as
 * octet-stream, so the course would have rendered in fallback fonts with
 * nothing in any log to say why. Fonts, captions and modern media are here
 * because real authoring tools emit them.
 */
export const MIME = {
  ".html": "text/html", ".htm": "text/html", ".js": "text/javascript",
  ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain",

  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".ico": "image/x-icon", ".bmp": "image/bmp",

  ".mp4": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".vtt": "text/vtt", ".srt": "application/x-subrip",

  ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject",

  ".pdf": "application/pdf"
};

/**
 * Wrap a request handler so a thrown error becomes a 500 with no detail, and
 * the detail goes to the log instead. A stack trace in a response body is free
 * reconnaissance: internal paths, library versions, the shape of the code.
 */
export const guard = (name, write, handler) => async (req, res) => {
  try { await handler(req, res); }
  catch (e) {
    console.error(`[${name}] ${req.method} ${req.url}`, e);
    if (!res.headersSent) write(res, 500, { error: "internal error" });
  }
};

/**
 * A route table.
 *
 * Replaces a chain of sequential `if (p === "...")` comparisons. Three things
 * that buys, in order of how much they matter:
 *
 *   1. The whole API is visible in one place, instead of being reconstructed
 *      by reading a thousand lines top to bottom.
 *   2. Handlers can live in domain files without the dispatch order becoming
 *      load-bearing.
 *   3. A duplicate route is an error at startup rather than a branch that
 *      silently never runs — in an if-ladder the second one is unreachable
 *      and nothing says so.
 *
 * Specs are `"METHOD /path"`. `ALL` matches any method, which is what a bare
 * `if (p === ...)` did. `:name` captures a segment into `ctx.params`.
 */
export function createRouter(name = "router") {
  const exact = new Map();      // "GET /api/health" -> handler
  const patterns = [];          // { method, re, keys, handler, spec }

  const add = (spec, handler) => {
    const [method, path] = spec.split(" ");
    if (!path) throw new Error(`${name}: bad route spec "${spec}"`);

    if (path.includes(":")) {
      const keys = [];
      const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => {
        keys.push(k); return "([^/]+)";
      }) + "$");
      patterns.push({ method, re, keys, handler, spec });
      return;
    }
    const key = `${method} ${path}`;
    // Two handlers for one route is always a mistake; in an if-ladder it is a
    // silent one.
    if (exact.has(key)) throw new Error(`${name}: duplicate route "${spec}"`);
    exact.set(key, handler);
  };

  return {
    on(spec, handler) { add(spec, handler); return this; },

    /** Register many at once: { "GET /a": fn, "POST /b": fn }. */
    mount(table) { for (const [spec, fn] of Object.entries(table)) add(spec, fn); return this; },

    /** Returns true if a route ran. */
    async handle(req, res, ctx) {
      const p = ctx.url.pathname;
      const hit = exact.get(`${req.method} ${p}`) || exact.get(`ALL ${p}`);
      if (hit) { await hit(req, res, ctx); return true; }

      for (const r of patterns) {
        if (r.method !== "ALL" && r.method !== req.method) continue;
        const m = p.match(r.re);
        if (!m) continue;
        ctx.params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        await r.handler(req, res, ctx);
        return true;
      }
      return false;
    },

    /** Every registered route — used by the docs checker and by tests. */
    list() {
      return [...exact.keys(), ...patterns.map(r => r.spec)].sort();
    }
  };
}
