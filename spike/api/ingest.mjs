/**
 * Waypoint PoC — package ingest.
 *
 * Validate, unpack, read the manifest, create an immutable content version.
 * Safety checks run BEFORE anything is written to disk, which is the only
 * order that matters: a zip is hostile until proven otherwise.
 *
 * Manifest reading is regex-based here — spike grade, and immune to XXE by
 * construction. Production needs a real XML parser with DTDs and external
 * entities disabled.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { DATA_DIR } from "./db/connect.mjs";
import { upsertProgram, addContentVersion, setStoragePath } from "./db/waypoint.mjs";

const MAX_ENTRIES      = 10_000;
const MAX_UNCOMPRESSED = 2 * 1024 ** 3;
const MAX_RATIO        = 100;

export const CONTENT_DIR = join(DATA_DIR, "content");
mkdirSync(CONTENT_DIR, { recursive: true });

/* stderr is captured rather than inherited: a file that is not an archive makes
   unzip print four lines about multi-part disks, which is already handled below
   as "not a readable zip" and only obscures the answer when it reaches a log. */
const sh = (cmd, args) => execFileSync(cmd, args,
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/** Everything checked before a single byte is extracted. */
export function validateArchive(zip) {
  const problems = [];
  let entries;
  try { entries = sh("unzip", ["-Z1", zip]).split("\n").filter(Boolean); }
  catch { return { ok: false, problems: ["not a readable zip archive"] }; }

  const t = sh("unzip", ["-Zt", zip])
    .match(/(\d+)\s+files?,\s+(\d+)\s+bytes uncompressed,\s+(\d+)\s+bytes compressed/);
  const uncompressed = t ? +t[2] : 0;
  const ratio = t && +t[3] > 0 ? uncompressed / +t[3] : 0;

  // zip-slip: any path that escapes the extraction root
  const escaping = entries.filter(e =>
    e.startsWith("/") || e.startsWith("\\") ||
    /(^|[\/\\])\.\.([\/\\]|$)/.test(e) || /^[A-Za-z]:/.test(e));
  if (escaping.length) problems.push(`zip-slip: ${escaping.slice(0, 3).join(", ")}`);

  if (entries.length > MAX_ENTRIES)    problems.push(`${entries.length} entries exceeds ${MAX_ENTRIES}`);
  if (uncompressed > MAX_UNCOMPRESSED) problems.push(`${(uncompressed / 1024 ** 3).toFixed(1)} GB uncompressed`);
  if (ratio > MAX_RATIO)               problems.push(`compression ratio ${ratio.toFixed(0)}:1 — possible zip bomb`);

  const exe = entries.filter(e => /\.(php|phtml|jsp|asp|aspx|cgi|pl|py|rb|sh|exe|dll)$/i.test(e));
  if (exe.length) problems.push(`server-executable files: ${exe.slice(0, 3).join(", ")}`);

  return { ok: problems.length === 0, problems, entries, uncompressed, ratio };
}

export function readManifest(dir) {
  const p = join(dir, "imsmanifest.xml");
  if (!existsSync(p)) {
    const tincan = join(dir, "tincan.xml");
    if (existsSync(tincan)) {
      const xml = readFileSync(tincan, "utf8");
      // The course activity is the first activity in an Articulate xAPI
      // export. Regex keeps the spike free of an XML parser and cannot resolve
      // external entities; production should use a hardened parser.
      const activity = xml.match(/<activity\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<name\b[^>]*>([^<]*)<\/name>[\s\S]*?<launch\b[^>]*>([^<]+)<\/launch>/i);
      if (!activity) return { error: "malformed tincan.xml: course activity or launch is missing" };
      return {
        scorm_version: "xAPI",
        family: "xapi",
        activity_id: activity[1].trim(),
        title: activity[2].trim() || null,
        launch_href: activity[3].trim(),
        sco_count: 1
      };
    }
    // The most common import failure anywhere: the folder was zipped
    // instead of the folder's contents.
    const nested = readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .find(d => existsSync(join(dir, d.name, "imsmanifest.xml")));
    return { error: nested
      ? `imsmanifest.xml is not at the top level — found inside "${nested.name}/". Zip the folder's contents, not the folder.`
      : "no imsmanifest.xml or tincan.xml found" };
  }

  const xml = readFileSync(p, "utf8");
  const grab = re => (xml.match(re)?.[1] ?? "").trim();

  // NOTE: 1.2 writes adlcp:scormtype, 2004 writes adlcp:scormType.
  // Same attribute, different case. Match case-insensitively.
  const resources = [...xml.matchAll(/<resource\b([^>]*)>/gi)].map(m => ({
    kind: (m[1].match(/scormType\s*=\s*["']([^"']+)["']/i)?.[1] ?? "").toLowerCase(),
    href: m[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] ?? null
  }));
  const scos = resources.filter(r => r.kind === "sco");
  const assets = resources.filter(r => r.kind === "asset").length;

  if (!scos.length) {
    return { error: assets
      ? `no trackable content: ${assets} resources, all assets, no SCO`
      : "malformed manifest: no resources" };
  }

  const rawVersion = grab(/<schemaversion>([^<]*)<\/schemaversion>/i) || "unknown";
  return {
    scorm_version: rawVersion,
    family: /^1\.2/.test(rawVersion) ? "1.2" : /2004/.test(rawVersion) ? "2004" : "unknown",
    launch_href: scos[0].href,
    sco_count: scos.length,
    title: grab(/<organization[^>]*>[\s\S]*?<title>([^<]*)<\/title>/i) || null
  };
}

/**
 * Ingest a zip into an immutable content version.
 * Never overwrites: a re-upload of the same program creates version N+1,
 * so learners mid-progress keep the version they started on.
 */
export function ingestPackage(zipPath, { program_id, title } = {}) {
  if (!existsSync(zipPath)) return { error: `no such file: ${zipPath}` };

  const check = validateArchive(zipPath);
  if (!check.ok) return { error: `rejected: ${check.problems.join("; ")}`, problems: check.problems };

  const staging = join(CONTENT_DIR, `.staging-${Date.now()}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    sh("unzip", ["-qq", "-o", zipPath, "-d", staging]);
    const man = readManifest(staging);
    if (man.error) return { error: man.error };

    if (!existsSync(join(staging, man.launch_href.split("?")[0])))
      return { error: `launch file missing from package: ${man.launch_href}` };

    if (man.sco_count > 1)
      return { error: `multi-SCO package (${man.sco_count} SCOs) — out of scope for the PoC`,
               out_of_scope: true };

    const pid = program_id || basename(zipPath, ".zip");
    const program = upsertProgram({ program_id: pid, title: title || man.title || pid });

    const cv = addContentVersion({
      program_pk: program.id,
      scorm_version: man.scorm_version,
      launch_href: man.launch_href,
      storage_path: "",              // set below, once we know the version number
      sco_count: man.sco_count,
      title: man.title
    });

    // Storage path is keyed by version id, so versions never collide and
    // an existing version's files are never touched.
    const dest = join(CONTENT_DIR, String(cv.id));
    rmSync(dest, { recursive: true, force: true });
    sh("mv", [staging, dest]);

    setStoragePath(cv.id, dest);

    return {
      ok: true,
      program: { id: program.id, program_id: program.program_id, title: program.title },
      content_version: { ...cv, storage_path: dest },
      manifest: man
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
