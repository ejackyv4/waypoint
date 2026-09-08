/** Waypoint health endpoint. */
export const routes = {
  "GET /api/health": async (req, res, ctx) =>
    ctx.json(res, 200, { ok: true, app: ctx.appOrigin, content: ctx.contentOrigin })
};
