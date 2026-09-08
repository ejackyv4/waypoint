/** Content catalog and package-ingest routes. */
import { catalog } from "../db/waypoint.mjs";
import { requireApiKey } from "../auth.mjs";
import { ingestPackage } from "../ingest.mjs";

export const routes = {
  "POST /api/ingest": async (req, res, ctx) => {
    const auth = requireApiKey(req);
    if (auth.error) return ctx.json(res, auth.status, { error: auth.error });
    const b = await ctx.readJson(req);
    if (!b.zip) return ctx.json(res, 400, { error: "zip path required" });
    const result = ingestPackage(b.zip, { program_id: b.program_id, title: b.title });
    return ctx.json(res, result.error ? 422 : 200, result);
  },

  "GET /api/content": async (req, res, ctx) => {
    const auth = requireApiKey(req);
    if (auth.error) return ctx.json(res, auth.status, { error: auth.error });
    return ctx.json(res, 200, { content: catalog() });
  }
};
