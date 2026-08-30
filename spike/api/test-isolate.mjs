/**
 * Point a test at a throwaway database.
 *
 * **Import this FIRST, before anything that touches `db/`.**
 *
 * `db/connect.mjs` opens the database at import time, so by the time any other
 * module has been evaluated the choice has already been made. ES modules are
 * evaluated in import order, which is the whole reason this works: setting the
 * variable here happens before `connect.mjs` reads it.
 *
 * Why it exists: `test-sweeper.mjs` imports the data layer directly and writes
 * real rows through it. Against the default path that is `spike/data` — the
 * demo. Every run left a `sweep-…` and a `fresh-…` subject behind with a
 * registration each, and running the checkers four times in an evening put
 * eight of them in the roster. Nothing failed; the junk was found later by
 * whoever opened the demo.
 *
 * A test that quietly damages the demo is a test people stop running, and this
 * one guards the sweeper — the thing that closes sessions a phone never ended,
 * which is the normal case on mobile rather than the edge case.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* Already set means somebody chose a database deliberately — a caller pointing
   at a fixture, or the private server a suite started for itself. Leave it. */
if (!process.env.WAYPOINT_DATA_DIR) {
  const dir = mkdtempSync(join(tmpdir(), "waypoint-test-"));
  process.env.WAYPOINT_DATA_DIR = dir;

  const clean = () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} };
  process.on("exit", clean);
  for (const sig of ["SIGINT", "SIGTERM"])
    process.on(sig, () => { clean(); process.exit(130); });

  console.log(`  \x1b[2mthrowaway database in ${dir}\x1b[0m`);
}
