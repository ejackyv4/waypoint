/**
 * The console itself — one page, served with the Waypoint origin baked in so
 * the browser never has to guess where the LMS lives.
 */

import { readFile } from "node:fs/promises";
import { APP_ORIGIN } from "../config.mjs";

const page = async (req, res) => {
  const html = (await readFile(new URL("../saas.html", import.meta.url), "utf8"))
    .replaceAll("__WAYPOINT_APP__", APP_ORIGIN);
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  return res.end(html);
};

export const routes = { "ALL /": page, "ALL /index.html": page };
