#!/usr/bin/env node
/**
 * Northwood is a customer of Waypoint, not a part of it.
 *
 * The whole PoC rests on that: if the corrections system can reach into the
 * LMS's tables, then the integration contract is not being exercised by
 * anything, and "you could build this against our API" is unproven.
 *
 * This used to be a hand-maintained list of thirty function names, and it
 * leaked twice — once through a module-level seed writing straight into
 * `people` and `credentials`, once through a query called `saasPeople` whose
 * name read as Northwood's but which joined four Waypoint tables. A list of
 * names cannot catch what nobody thought to add to it.
 *
 * Splitting the data layer turned it into one rule: Northwood may not import
 * Waypoint. An import edge is not a matter of opinion, and it cannot hide
 * inside a function.
 *
 *   node spike/api/check-boundary.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/* Modules that belong to the LMS. Nothing on the Northwood side may import
   any of them — not the server, not its data layer. */
const WAYPOINT_MODULES = ["./waypoint.mjs", "./db/waypoint.mjs", "../waypoint.mjs"];

/* Every file that makes up Northwood, including its route modules. Read from
   disk rather than listed by hand — a list would miss the next module added,
   which is precisely how the last two leaks got in. */
const NORTHWOOD = ["northwood.mjs", "db/northwood.mjs",
  ...readdirSync(join(HERE, "northwood")).filter(f => f.endsWith(".mjs"))
      .map(f => join("northwood", f))];

const problems = [];
let httpCalls = 0;

for (const file of NORTHWOOD) {
  const src = readFileSync(join(HERE, file), "utf8");
  httpCalls += (src.match(/\bwaypoint\(/g) || []).length;

  for (const m of src.matchAll(/from\s*["']([^"']+)["']/g)) {
    const spec = m[1];
    if (WAYPOINT_MODULES.includes(spec) || /(^|\/)waypoint\.mjs$/.test(spec))
      problems.push(`${file} imports ${spec}`);
  }
}

if (problems.length) {
  console.log("\n  \x1b[31m✕ Northwood reaches into Waypoint directly:\x1b[0m");
  problems.forEach(p => console.log("      " + p));
  console.log("\n  Northwood is a customer. It has an API — use it, or these are not");
  console.log("  two systems, they are one system with extra ceremony.\n");
  process.exit(1);
}

console.log(`\n  \x1b[32m✓\x1b[0m Northwood imports nothing from Waypoint `
          + `— ${httpCalls} calls, all over HTTP\n`);
