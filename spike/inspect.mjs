#!/usr/bin/env node
/**
 * Waypoint SCORM package inspector — spike grade.
 *
 *   node spike/inspect.mjs <file.zip | directory> [...]
 *
 * Answers, for each package, the questions ingest will have to answer:
 *   is it safe to unpack · is it well formed · which SCORM version ·
 *   where does it launch · how many SCOs · does it contain a runtime at all
 *
 * Deliberately zero-dependency. Manifest reading is regex-based, which is
 * fine here (and immune to XXE by construction) but is NOT what production
 * should do — that needs a real XML parser with entities and DTDs disabled.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, basename } from "node:path";

/* Limits. Real values belong in config; these are sane spike defaults. */
const MAX_ENTRIES      = 10_000;
const MAX_UNCOMPRESSED = 2 * 1024 ** 3;   // 2 GB
const MAX_RATIO        = 100;             // compressed:uncompressed
const SUSPEND_CAP_12   = 4096;

const C = { r:"\x1b[31m", y:"\x1b[33m", g:"\x1b[32m", b:"\x1b[34m",
            d:"\x1b[2m", B:"\x1b[1m", x:"\x1b[0m" };
const ok   = s => `${C.g}✓${C.x} ${s}`;
const warn = s => `${C.y}⚠${C.x} ${s}`;
const bad  = s => `${C.r}✕${C.x} ${s}`;

const sh = (cmd, args) => execFileSync(cmd, args, { encoding:"utf8", maxBuffer: 64*1024*1024 });

/* ---------- zip safety: everything checked BEFORE anything is unpacked ---------- */
function inspectArchive(zip) {
  const findings = [];
  let entries = [];
  try {
    entries = sh("unzip", ["-Z1", zip]).split("\n").filter(Boolean);
  } catch {
    return { fatal: "not a readable zip archive", findings, entries };
  }

  const totals = sh("unzip", ["-Zt", zip]);
  const m = totals.match(/(\d+)\s+files?,\s+(\d+)\s+bytes uncompressed,\s+(\d+)\s+bytes compressed/);
  const uncompressed = m ? +m[2] : 0;
  const compressed   = m ? +m[3] : 1;
  const ratio        = compressed > 0 ? uncompressed / compressed : 0;

  /* zip-slip: any path escaping the extraction root */
  const escaping = entries.filter(e =>
    e.startsWith("/") || e.startsWith("\\") || /(^|[\/\\])\.\.([\/\\]|$)/.test(e) || /^[A-Za-z]:/.test(e));
  if (escaping.length)
    findings.push(bad(`ZIP-SLIP: ${escaping.length} entr${escaping.length===1?"y":"ies"} escape the root — ${escaping.slice(0,3).join(", ")}`));

  if (entries.length > MAX_ENTRIES)      findings.push(bad(`${entries.length} entries exceeds cap of ${MAX_ENTRIES}`));
  if (uncompressed > MAX_UNCOMPRESSED)   findings.push(bad(`${(uncompressed/1024**3).toFixed(1)} GB uncompressed exceeds cap`));
  if (ratio > MAX_RATIO)                 findings.push(bad(`compression ratio ${ratio.toFixed(0)}:1 — possible zip bomb`));

  /* server-side executables have no business in a content package */
  const exec = entries.filter(e => /\.(php|phtml|jsp|asp|aspx|cgi|pl|py|rb|sh|exe|dll)$/i.test(e));
  if (exec.length) findings.push(warn(`${exec.length} server-executable file(s): ${exec.slice(0,3).join(", ")}`));

  return { findings, entries, uncompressed, ratio, fatal: escaping.length ? "unsafe to unpack" : null };
}

/* ---------- manifest ---------- */
function readManifest(dir) {
  const p = join(dir, "imsmanifest.xml");
  if (!existsSync(p)) {
    /* the single most common import failure: folder zipped instead of its contents */
    const nested = readdirSync(dir, { withFileTypes:true })
      .filter(d => d.isDirectory())
      .find(d => existsSync(join(dir, d.name, "imsmanifest.xml")));
    return { missing: true, nested: nested?.name ?? null };
  }
  const xml = readFileSync(p, "utf8");

  const grab = re => (xml.match(re)?.[1] ?? "").trim();
  const schema   = grab(/<schema>([^<]*)<\/schema>/i);
  const version  = grab(/<schemaversion>([^<]*)<\/schemaversion>/i);
  const title    = grab(/<organization[^>]*>[\s\S]*?<title>([^<]*)<\/title>/i);

  /* Resources carry a scormType: "sco" is trackable, "asset" is just content.
     Note SCORM 1.2 writes `adlcp:scormtype` and 2004 writes `adlcp:scormType`
     — same meaning, different case. Matching is deliberately case-insensitive. */
  const resources = [...xml.matchAll(/<resource\b([^>]*)>/gi)].map(mm => {
    const attrs = mm[1];
    return {
      kind: (attrs.match(/scormType\s*=\s*["']([^"']+)["']/i)?.[1] ?? "").toLowerCase(),
      href: attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] ?? null
    };
  });
  const scos   = resources.filter(r => r.kind === "sco").map(r => r.href);
  const assets = resources.filter(r => r.kind === "asset").length;

  const items = [...xml.matchAll(/<item\b/gi)].length;
  return { missing:false, schema, version, title, scos, assets,
           resources: resources.length, items, bytes: xml.length };
}

/* ---------- does this package actually contain a runtime? ---------- */
const API_RE = /API_1484_11|LMSInitialize|LMSSetValue|LMSGetValue|LMSFinish|LMSCommit|\bInitialize\s*\(|\bSetValue\s*\(|\bTerminate\s*\(/;

function scanForRuntime(dir) {
  const hits = [];
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes:true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(html?|js)$/i.test(e.name)) continue;
      if (statSync(p).size > 4 * 1024 * 1024) continue;
      if (API_RE.test(readFileSync(p, "utf8"))) hits.push(p.slice(dir.length + 1));
    }
  };
  walk(dir);
  return hits;
}

/* ---------- per package ---------- */
function inspect(zip) {
  const name = basename(zip);
  console.log(`\n${C.B}${name}${C.x}`);
  console.log(C.d + "─".repeat(Math.max(name.length, 40)) + C.x);

  const arc = inspectArchive(zip);
  const row = { name, safe:"?", version:"?", scos:"?", runtime:"?", verdict:"?" };

  arc.findings.forEach(f => console.log("  " + f));
  if (arc.fatal) {
    console.log("  " + bad(`REJECTED: ${arc.fatal}`));
    return { ...row, safe:"NO", verdict:"rejected" };
  }
  if (!arc.findings.length) console.log("  " + ok(`archive clean — ${arc.entries.length} entries, ratio ${arc.ratio.toFixed(1)}:1`));
  row.safe = "yes";

  const tmp = mkdtempSync(join(tmpdir(), "wp-scorm-"));
  try {
    sh("unzip", ["-qq", "-o", zip, "-d", tmp]);
    const man = readManifest(tmp);

    if (man.missing) {
      console.log("  " + bad(man.nested
        ? `imsmanifest.xml is not at the root — found inside "${man.nested}/". The folder was zipped instead of its contents.`
        : "no imsmanifest.xml found anywhere"));
      return { ...row, verdict:"rejected" };
    }

    const ver = man.version || man.schema || "unknown";
    row.version = ver.replace(/^ADL SCORM\s*/i, "");
    console.log("  " + ok(`manifest OK — ${man.schema || "?"} ${C.B}${ver}${C.x}`));
    if (man.title) console.log(`    ${C.d}title:${C.x} ${man.title}`);

    row.scos = String(man.scos.length);
    console.log(`    ${C.d}${man.resources} resources (${man.scos.length} sco, ${man.assets} asset) · ${man.items} items${C.x}`);

    if (man.scos.length === 0) {
      /* Valid package, nothing trackable. NOT the same as malformed — ingest must
         say so plainly rather than rejecting it as broken. */
      if (man.assets > 0) {
        console.log("  " + warn(`ASSET-ONLY — ${man.assets} resources, none marked as a SCO.`));
        console.log(`    ${C.d}A valid content package with nothing trackable in it. It can be${C.x}`);
        console.log(`    ${C.d}displayed, but it will never report status, score or completion.${C.x}`);
        return { ...row, verdict:"asset only" };
      }
      console.log("  " + bad("no resources at all — malformed manifest"));
      return { ...row, verdict:"rejected" };
    }
    if (man.scos.length > 1) {
      console.log("  " + warn(`${man.scos.length} SCOs — multi-SCO is OUT OF SCOPE for the PoC (rollup not implemented)`));
      row.verdict = "out of scope";
    }

    const launch = man.scos[0];
    const launchOK = launch && existsSync(join(tmp, launch.split("?")[0]));
    console.log("  " + (launchOK ? ok(`launch: ${launch}`) : bad(`launch file missing from package: ${launch}`)));
    if (!launchOK) return { ...row, verdict:"rejected" };

    /* the check that mattered on the packages we were given */
    const hits = scanForRuntime(tmp);
    if (hits.length) {
      row.runtime = "yes";
      console.log("  " + ok(`runtime present — API calls in ${hits.length} file(s): ${hits.slice(0,3).join(", ")}${hits.length>3?" …":""}`));
      if (row.verdict === "?") row.verdict = "playable";
    } else {
      row.runtime = "NO";
      row.verdict = "no runtime";
      console.log("  " + bad("NO RUNTIME — nothing in this package ever calls the SCORM API."));
      console.log(`    ${C.d}It will render and then sit there. Useful for testing ingest,${C.x}`);
      console.log(`    ${C.d}useless for testing tracking. Packaging sample, not a course.${C.x}`);
    }
    return row;
  } finally {
    rmSync(tmp, { recursive:true, force:true });
  }
}

/* ---------- main ---------- */
const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: node spike/inspect.mjs <file.zip | directory> [...]");
  process.exit(1);
}
const zips = args.flatMap(a =>
  statSync(a).isDirectory()
    ? readdirSync(a).filter(f => extname(f).toLowerCase() === ".zip").sort().map(f => join(a, f))
    : [a]);

if (!zips.length) { console.error("no .zip files found"); process.exit(1); }

const rows = zips.map(inspect);

/* corpus table — this is the PoC's actual output */
console.log(`\n${C.B}Corpus summary${C.x}`);
const w = { name:    Math.max(7, ...rows.map(r => r.name.length)),
            version: Math.max(7, ...rows.map(r => r.version.length)),
            scos: 4, runtime: 7 };
const pad = (s, n) => String(s).padEnd(n);
console.log(C.d + [pad("package", w.name), pad("version", w.version), pad("SCOs", w.scos),
                   pad("runtime", w.runtime), "verdict"].join("  ") + C.x);
for (const r of rows) {
  const color = r.verdict === "playable" ? C.g : r.verdict === "rejected" ? C.r : C.y;
  console.log([pad(r.name, w.name), pad(r.version, w.version), pad(r.scos, w.scos),
               pad(r.runtime, w.runtime), color + r.verdict + C.x].join("  "));
}
const playable = rows.filter(r => r.verdict === "playable").length;
console.log(`\n${playable}/${rows.length} playable\n`);
