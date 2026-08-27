#!/usr/bin/env node
/**
 * A route documented one way and built another is worse than no documentation,
 * because it gets believed.
 *
 * Compares every route in the servers against docs/API.md, both directions:
 * routes that exist but are undocumented, and routes documented that no longer
 * exist. It found a stale claim once already — that is the whole justification.
 *
 *   node spike/api/check-docs.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const doc = readFileSync(join(HERE, "..", "..", "docs", "API.md"), "utf8");

const routes = new Set();

/* Waypoint and the content origin still dispatch with string comparisons. */
for (const f of ["waypoint.mjs", "content.mjs"])
  for (const m of readFileSync(join(HERE, f), "utf8").matchAll(/p === "(\/[^"]*)"/g))
    routes.add(m[1]);

/* Northwood has a route table, so ask it rather than grepping for strings —
   the table IS the list, and reading it cannot go stale. */
const { routeList } = await import("./northwood.mjs");
for (const spec of routeList()) routes.add(spec.split(" ")[1]);

/* Pages and the deliberately-undocumented demo shim. */
const SKIP = /^(\/$|\/learn|\/console|\/demo|\/index\.html|\/player|\/content|\/api\/console\/|\/api\/customers)/;

/* A route with a :param is documented by its prefix, not its literal spec. */
const documentedAs = r => doc.includes(r) || doc.includes(r.replace(/\/:\w+$/, "/"));
const undocumented = [...routes].filter(r => !SKIP.test(r) && !documentedAs(r)).sort();
const documented   = [...new Set([...doc.matchAll(/(?:GET|POST)\s+(\/api\/[a-z0-9/_-]+)/gi)]
                       .map(m => m[1]))];
/* A route ending in "/" in the source is a prefix match, not a literal path. */
const ghosts = documented.filter(r => ![...routes].some(x =>
  r === x || r.startsWith(x.endsWith("/") ? x : x + "/")));

console.log(`
  ${routes.size} routes across the three servers
`);
let bad = 0;

if (undocumented.length) {
  bad += undocumented.length;
  console.log("  \x1b[31mNOT IN API.md:\x1b[0m");
  undocumented.forEach(r => console.log("    ✕ " + r));
} else console.log("  \x1b[32m✓\x1b[0m every route appears in API.md");

if (ghosts.length) {
  bad += ghosts.length;
  console.log("\n  \x1b[31mDOCUMENTED BUT GONE:\x1b[0m");
  ghosts.forEach(r => console.log("    ✕ " + r));
} else console.log("  \x1b[32m✓\x1b[0m nothing documented that does not exist");

console.log("");
process.exit(bad ? 1 : 0);
