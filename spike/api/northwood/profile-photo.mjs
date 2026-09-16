import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, now, one, run } from "../db/connect.mjs";
import { subjectByKey } from "../db/northwood.mjs";
import { readJson } from "../http.mjs";
import { saasJson, subjectFromToken } from "./shared.mjs";
import { APP_ORIGIN } from "../config.mjs";

export const PROFILE_PHOTOS_DIR = join(DATA_DIR, "subject-profile-photos");
const MAX_BYTES = 6 * 1024 * 1024;
const TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

export const profilePhotoFor = subject_id => one(
  `SELECT * FROM subject_profile_photos WHERE subject_id = ?`, subject_id);

export const profilePhotoUrl = subject_id =>
  profilePhotoFor(subject_id) ? `/subject-profile-photos/${encodeURIComponent(subject_id)}` : null;

function payloadError(b) {
  if (!TYPES[b.mime_type]) return "mime_type must be image/jpeg, image/png, or image/webp";
  if (typeof b.data !== "string" || !b.data) return "data (base64) is required";
  let bytes;
  try { bytes = Buffer.from(b.data.replace(/^data:[^;]+;base64,/, ""), "base64"); }
  catch { return "data must be base64"; }
  if (!bytes.length || bytes.length > MAX_BYTES) return `photo must be between 1 byte and ${MAX_BYTES} bytes`;
  return bytes;
}

export async function saveProfilePhoto(subject_id, body, updated_by, sourceDefault = "manual") {
  const bytes = payloadError(body);
  if (typeof bytes === "string") return { error: bytes };
  if (!subjectByKey(subject_id)) return { error: "no such subject" };
  await mkdir(PROFILE_PHOTOS_DIR, { recursive: true });
  const old = profilePhotoFor(subject_id);
  const filename = `${subject_id}-${randomUUID()}${TYPES[body.mime_type]}`;
  const tmp = join(PROFILE_PHOTOS_DIR, `.${filename}.tmp`);
  const target = join(PROFILE_PHOTOS_DIR, filename);
  await writeFile(tmp, bytes, { flag: "wx", mode: 0o640 });
  await rename(tmp, target);
  run(`INSERT INTO subject_profile_photos
       (subject_id, filename, mime_type, byte_size, source, source_id, updated_by, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(subject_id) DO UPDATE SET filename=excluded.filename,
       mime_type=excluded.mime_type, byte_size=excluded.byte_size, source=excluded.source,
       source_id=excluded.source_id, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      subject_id, filename, body.mime_type, bytes.length, body.source || sourceDefault,
      body.source_id || null, updated_by || null, now());
  if (old?.filename && old.filename !== filename) unlink(join(PROFILE_PHOTOS_DIR, old.filename)).catch(() => {});
  return { ok: true, profile_photo_url: profilePhotoUrl(subject_id), byte_size: bytes.length };
}

export const routes = {
  "POST /api/subject/profile-photo": async (req, res, ctx) => {
    /* Base64 expands binary data by roughly one third. Allow the JSON wrapper
       to carry a photo up to the decoded 6 MB limit instead of falling through
       as an empty body and misleadingly reporting a missing MIME type. */
    const b = await readJson(req, Math.ceil(MAX_BYTES * 1.4));
    /* Accept the query fallback for native clients as well as JSON. The body
       remains the documented contract; the URL makes diagnosis resilient when
       a platform drops a JSON field while uploading a large base64 payload. */
    const sid = String(b.subject_id || b.subjectId
      || new URL(req.url, "http://localhost").searchParams.get("subject_id") || "").trim();
    if (!sid) return saasJson(res, 400, { error: "subject_id required" });
    const result = await saveProfilePhoto(sid, b, ctx.session?.name || "officer");
    return saasJson(res, result.error ? 400 : 200, result);
  },

  "POST /api/me/profile-photo": async (req, res) => {
    const person = await subjectFromToken(req);
    if (!person) return saasJson(res, 401, { error: "sign in required" });
    const b = await readJson(req, Math.ceil(MAX_BYTES * 1.4));
    const result = await saveProfilePhoto(person.subject_id, b, person.name || "subject");
    return saasJson(res, result.error ? 400 : 200, result);
  },

  "GET /api/me/profile-photo": async (req, res) => {
    const person = await subjectFromToken(req);
    if (!person) return saasJson(res, 401, { error: "sign in required" });
    const photo = profilePhotoFor(person.subject_id);
    if (!photo) { res.writeHead(404); return res.end("not found"); }
    try {
      const bytes = await readFile(join(PROFILE_PHOTOS_DIR, photo.filename));
      res.writeHead(200, { "Content-Type": photo.mime_type, "Content-Length": bytes.length,
        "Access-Control-Allow-Origin": APP_ORIGIN,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return res.end(bytes);
    } catch { res.writeHead(404); return res.end("file missing"); }
  },

  "ALL /subject-profile-photos/:subject_id": async (req, res, ctx) => {
    const sid = ctx.params.subject_id;
    const photo = profilePhotoFor(sid);
    if (!photo) { res.writeHead(404); return res.end("not found"); }
    let allowed = !!ctx.session;
    if (!allowed) {
      const person = await subjectFromToken(req);
      allowed = person?.subject_id === sid;
    }
    if (!allowed) { res.writeHead(403); return res.end("forbidden"); }
    try {
      const bytes = await readFile(join(PROFILE_PHOTOS_DIR, photo.filename));
      res.writeHead(200, { "Content-Type": photo.mime_type, "Content-Length": bytes.length,
        "Access-Control-Allow-Origin": APP_ORIGIN,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return res.end(bytes);
    } catch { res.writeHead(404); return res.end("file missing"); }
  }
};
