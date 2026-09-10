import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { allow } from "../auth.mjs";
import { readJson } from "../http.mjs";
import { saasJson } from "./shared.mjs";

const run = promisify(execFile);
// Production uses the installed control wrapper; local development uses the
// repository helper and its own WAYPOINT_DATA_DIR. Both paths keep the browser
// away from the API key and the shell details.
const privilegedBridge = "/usr/local/bin/waypoint-demo-web";
const command = process.env.DEMO_CONTROL_CMD
  || (existsSync(privilegedBridge) ? "sudo" :
      (existsSync("/usr/local/bin/waypoint-demo") ? "/usr/local/bin/waypoint-demo" : "./spike/demo"));
const commandPrefix = command === "sudo" ? ["-n", privilegedBridge] : [];
const page = async (req, res) => {
  const html = await readFile(new URL("../demo-ops.html", import.meta.url), "utf8");
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  res.end(html);
};
const gate = ctx => allow(ctx.session, "admin");
const execute = async (args, req, res, ctx) => {
  const g = gate(ctx); if (g.error) return saasJson(res, g.status, { error: g.error });
  try {
    const out = await run(command, [...commandPrefix, ...args], { timeout: 120000, maxBuffer: 512 * 1024 });
    return saasJson(res, 200, { ok: true, output: `${out.stdout}${out.stderr}` });
  } catch (e) {
    return saasJson(res, 500, { error: "Demo operation failed", output: `${e.stdout || ""}${e.stderr || e.message}` });
  }
};

export const routes = {
  "GET /demo-ops": page,
  "GET /demo-ops/": page,
  "GET /api/demo-ops/status": (req, res, ctx) => execute(["status"], req, res, ctx),
  "POST /api/demo-ops/reset": (req, res, ctx) => execute(["reset", "--yes"], req, res, ctx),
  "POST /api/demo-ops/clean": async (req, res, ctx) => {
    const b = await readJson(req); const subject = String(b.subject_id || "cust-1041");
    if (!/^cust-\d{4,}$/.test(subject)) return saasJson(res, 400, { error: "invalid subject" });
    // The web request is handled by the same service that the terminal
    // wrapper would stop. Run the subject transaction online so the response
    // is not killed halfway through by systemd restarting its own process.
    return execute(["clean", subject, "--yes", "--online"], req, res, ctx);
  }
};
