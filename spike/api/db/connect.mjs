/**
 * The database connection, and nothing else.
 *
 * One file opens the database. Every query in the system runs through the
 * three helpers below, which is what makes adding scoping, auditing or
 * caching later a one-file edit rather than an archaeology project.
 *
 * Zero dependencies — node:sqlite, built in since Node 22.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the database lives.
 *
 * Resolved from `spike/`, NOT relative to this file — moving this module one
 * directory deeper silently relocated the database to `spike/api/data`, which
 * meant `./spike/demo reset` deleted a directory that no longer held anything
 * and reported success. Two hours of "why is stale data still here".
 *
 * That is why the path is printed at startup: CLAUDE.md's first rule about
 * data is to show which database you are connected to before touching it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));           // spike/api/db
export const DATA_DIR = process.env.WAYPOINT_DATA_DIR
  || join(HERE, "..", "..", "data");                            // spike/data
mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = join(DATA_DIR, "waypoint.db");
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");


/* Add a column to a table that already exists. SQLite has no
   ADD COLUMN IF NOT EXISTS, so check first. */
export function ensureColumn(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

export const now = () => new Date().toISOString();
export const one = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);

export { db };
