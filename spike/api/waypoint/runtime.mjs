/** SCORM runtime session routes.  The SCORM mapping helpers remain shared
 * with the legacy dispatcher until the final cut-over; this module owns the
 * HTTP contract for /api/runtime/* so the route surface is explicit. */
import { contentVersion, registration, redeemTicket, updateRegistration } from "../db/waypoint.mjs";
import { requireSession, mintSession, xapiRegistrationId } from "../auth.mjs";
import { CONTENT_ORIGIN, APP_ORIGIN } from "../config.mjs";
import { readManifest } from "../ingest.mjs";

const gate = (req, id, res, ctx) => {
  const auth = requireSession(req, id);
  if (auth.error) { ctx.json(res, auth.status, { error: auth.error }); return null; }
  return auth;
};

export const routes = {
  "POST /api/runtime/redeem": async (req, res, ctx) => {
    const b = await ctx.readJson(req);
    const r = redeemTicket(String(b.token || ""));
    if (r.error) return ctx.json(res, 403, r);
    const stale = registration(r.registration_id);
    const cv = contentVersion(stale.content_version_id);
    const reg = updateRegistration(stale.id, {
      started_at: stale.started_at || ctx.now(), terminated_at: null, session_seconds: 0,
      entry: stale.exit_mode === "suspend" ? "resume" : "ab-initio"
    });
    const session = mintSession(reg.id);
    let launchUrl = `${CONTENT_ORIGIN}/content/${cv.id}/${cv.launch_href}`;
    let activityId = null;
    if (cv.scorm_version === "xAPI") {
      const manifest = readManifest(cv.storage_path);
      if (manifest.error) return ctx.json(res, 500, { error: "xAPI package metadata is unavailable" });
      activityId = manifest.activity_id;
      const q = new URLSearchParams({ endpoint: `${APP_ORIGIN}/api/xapi/${reg.id}/`, auth: `Bearer ${session}`, actor: JSON.stringify(ctx.xapiActor(reg)), registration: xapiRegistrationId(reg.id), activity_id: activityId });
      launchUrl += `${launchUrl.includes("?") ? "&" : "?"}${q}`;
    }
    return ctx.json(res, 200, { session, registration: reg, content: { scorm_version: cv.scorm_version, title: ctx.contextFor(reg.id)?.title || cv.title || "Course", launch_url: launchUrl, activity_id: activityId } });
  },

  "POST /api/runtime/:id/set": async (req, res, ctx) => {
    const id = +ctx.params.id, auth = gate(req, id, res, ctx); if (!auth) return;
    const reg = registration(id); if (!reg) return ctx.json(res, 404, { error: "no such registration" });
    if (reg.terminated_at) return ctx.json(res, 409, { error: "session already terminated" });
    const { key, value } = await ctx.readJson(req), field = String(key), written = String(value ?? "");
    ctx.traceScormWrite(reg, field, written);
    const cv = contentVersion(reg.content_version_id);
    const patch = ctx.mapWrite(reg, field, written, /2004/.test(cv?.scorm_version || ""));
    const updated = updateRegistration(id, patch);
    return ctx.json(res, 200, { ok: true, applied: patch, registration: ctx.asRegistration(updated) });
  },

  "POST /api/runtime/:id/terminate": async (req, res, ctx) => {
    const tb = await ctx.readJson(req);
    if (!req.headers.authorization && tb.session) req.headers.authorization = `Bearer ${tb.session}`;
    const id = +ctx.params.id, auth = gate(req, id, res, ctx); if (!auth) return;
    const reg = registration(id); if (!reg) return ctx.json(res, 404, { error: "no such registration" });
    if (tb.exit_mode === "suspend") updateRegistration(id, { exit_mode: "suspend" });
    if (Number.isFinite(Number(tb.session_seconds)) && Number(tb.session_seconds) >= 0) updateRegistration(id, { session_seconds: Math.round(Number(tb.session_seconds)) });
    const { registration: updated, delivery } = await ctx.closeSession(registration(id));
    return ctx.json(res, 200, { ok: true, registration: ctx.asRegistration(updated), webhook: delivery });
  },

  "GET /api/runtime/:id": async (req, res, ctx) => {
    const id = +ctx.params.id, auth = gate(req, id, res, ctx); if (!auth) return;
    return ctx.json(res, 200, { registration: ctx.asRegistration(registration(id)) });
  }
};
