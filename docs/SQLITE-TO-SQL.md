# Moving off SQLite

What it would take to put Waypoint on a server database — Postgres assumed
throughout, though almost none of this is Postgres-specific.

**This is a plan, not a recommendation.** Whether to do it at all is the last
section, and the honest answer for today is no.

---

## The headline

The job is **one hard change and a handful of small ones**. The hard change is
not the SQL.

```
251 SQL call sites  —  249 inside db/*.mjs, 2 outside
41 tables, 444 columns, 29 indexes
233 exported functions the rest of the app calls
29 files import from db/
the entire seam is 3 functions: one() all() run()
```

Estimated **3–4 focused days**, most of it mechanical, none of it a rewrite.

---

## Why it is not worse than it is

### The chokepoint held

`CLAUDE.md` rule 9 says route data access through a chokepoint, and it was
followed. Controllers never learned SQL. There is one layer to change instead
of a hundred handlers, and this is the single reason the estimate is days
rather than weeks.

Two queries leaked out, and both are trivial:

| file | what |
|---|---|
| `northwood/route.mjs` | one `SELECT COUNT(*)` |
| `northwood/seed-schedule.mjs` | one `SELECT COUNT(*)` |

Move them into `db/` before starting, so the rule is true again and the
migration has exactly one surface.

### The SQL is already portable

There is no `AUTOINCREMENT`, no `INSERT OR REPLACE`, no `ON CONFLICT`, no
`datetime()`, no SQLite date arithmetic — because the schema stores ISO strings
and uses `INTEGER PRIMARY KEY`. What has to change is small:

| construct | count | becomes |
|---|---|---|
| `PRAGMA table_info` | 4 | `information_schema.columns` |
| `CHAR(34)` | 2 | `'"'` or `chr(34)` |
| `CREATE TABLE IF NOT EXISTS` | 76 | works unchanged in Postgres |
| `INTEGER PRIMARY KEY` | 41 | `GENERATED ALWAYS AS IDENTITY` |
| `GROUP_CONCAT` | few | `string_agg` |

---

## The hard part: synchronous to asynchronous

`node:sqlite` is **synchronous**. Every Postgres driver is asynchronous. That
one difference is most of the work.

```js
// today
const s = subjectByKey(id);

// after
const s = await subjectByKey(id);
```

Which makes that function `async`, which makes its callers `async`, all the way
to the route handlers. Roughly 250 call sites, 233 exported functions, 29
importing files.

**It is mechanical but it fails quietly.** A missed `await` yields a Promise
where a row was expected. In a template string that renders as
`[object Promise]`; in an `if` it is always truthy; in `.map()` it throws
somewhere unrelated. None of that is a compile error.

### Do this step first, on SQLite

Do not change the database and every call site in one move. Instead:

1. Make `one/all/run` return promises while still backed by `node:sqlite`
   ```js
   export const one = async (sql, ...a) => db.prepare(sql).get(...a);
   ```
2. Convert every call site to `await`, and every function that touches the DB
   to `async`.
3. Run the suite. Ship it. Live on it for a week.
4. **Only then** swap the driver — which becomes a one-file change in
   `db/connect.mjs`.

The suite is what makes this survivable: **365 smoke assertions, 53 insight
tests, 6 sweeper tests**, plus four standing checkers. Run them constantly.

### Finding what was missed

A missed `await` is invisible to the tests only if no test covers that path.
Two cheap nets worth adding before starting:

- **A lint rule** — `no-floating-promises` / `require-await` catches most of it
  mechanically.
- **A render-time assertion** — make the JSON serialiser throw on encountering
  a Promise, so `[object Promise]` becomes a loud failure instead of a string
  in somebody's browser.

---

## Transactions

Currently there are none, and on a single-process SQLite connection that has
been fine. With a connection pool it stops being fine: two requests interleave
and a half-written record becomes visible.

Every multi-statement write needs wrapping. The ones that matter:

| function | writes |
|---|---|
| `finishSummary` | updates the summary, inserts N action items, supersedes older ones |
| `createSubject` | inserts the row, then updates it through `saveSubject` |
| `buildAgenda` | inserts many agenda items from several sources |
| `seedRoster` / demo reset | bulk inserts across many tables |
| `promoteProposedActions`, `backfillDueDates` | boot-time migrations |

`finishSummary` is the sharpest: a failure midway leaves a summary marked
`done` with only some of its action items — and the officer has no way to know
the list is short.

---

## Types

SQLite is dynamically typed and let things through that Postgres will reject.
**This is a feature of the migration, not a cost** — every rejection is a bug
that already exists.

### Known instance

A vehicle `year` was stored as `2014.0` — a JS number bound into a `TEXT`
column. It was fixed with a `modelYear()` normaliser, but the class of problem
is general and there will be more.

**Before migrating**, run a type audit over every column: select rows where the
stored value does not match the declared type. Fix at the write path, never by
adding fallback logic at the read path — `CLAUDE.md` has a rule about that
exact temptation.

### Dates: 112 TEXT columns

Every `_at` and `_date` column is an ISO string. Two options:

**Keep them TEXT.** Migration stays trivial, everything keeps working,
ordering and comparison still behave because ISO-8601 sorts lexicographically.
Loses timezone correctness and date arithmetic in SQL.

**Convert to `timestamptz` / `date`.** The right end state. Costs a data
migration and a careful pass over every comparison — several places do
`a.due_date < today` on strings, which becomes a real date comparison and will
behave differently at midnight boundaries.

**Recommendation: keep TEXT for the driver swap, convert afterwards as its own
change.** Two risky things at once is how a migration turns into a fortnight.

### Booleans: 6 INTEGER columns

`active`, `must_change`, `time_fixed`, and friends are `0`/`1`. Postgres has a
real `BOOLEAN`. Straightforward, but every truthiness check that relied on `0`
being falsy needs looking at — `if (row.active)` behaves the same, but
`row.active === 1` does not.

---

## Migrations

Today the schema is built at boot: `CREATE TABLE IF NOT EXISTS` plus
`ensureColumn()` calls, run every start. That is genuinely good for a
single-process PoC — it is idempotent and there is no drift.

It does not survive contact with a real deployment. Two app servers starting at
once both run it; a rollback has nothing to roll back to; and nothing records
which version the database is at.

**Before the driver swap**, take a schema snapshot as migration `0001` and move
to real migration files. `CLAUDE.md` already carries the scar from the previous
project: 200+ accumulated migrations that became unrunnable and had to be
replaced wholesale. Start with the snapshot, not with 41 `CREATE TABLE`
migrations reconstructed from history.

Rules worth keeping from that scar tissue:

- Forward-only. Never edit a migration that has run anywhere but a laptop.
- One concern per file. Schema changes and data backfills are separate.
- Every environment builds from the same path.

The three boot-time data migrations — `promoteProposedActions`,
`backfillDueDates`, `supersedeStaleActions` — should become one-shot migration
files rather than running on every start.

---

## Connection handling

| today | after |
|---|---|
| one connection, opened at import | a pool, sized and configured |
| path from a fixed anchor | a URL from the environment |
| no timeouts | statement and connection timeouts |
| no retry | reconnect on transient failure |

The path anchoring lesson still applies, in a new form: **print which database
you are connected to at startup**, host and name. That single line is what
would have caught the `spike/api/data` incident, and the equivalent mistake
here — pointing at the wrong environment — is considerably more expensive.

---

## Order of work

1. **Move the two leaked queries** into `db/`. Restore the chokepoint.
2. **Type audit.** Find every value that does not match its declared column
   type. Fix at the write path.
3. **Add the nets.** Lint for floating promises; make the serialiser throw on a
   Promise.
4. **Async conversion, still on SQLite.** Ship it. Live on it.
5. **Schema snapshot as migration 0001**, plus migration tooling.
6. **Wrap the multi-statement writes in transactions.**
7. **Swap the driver.** One file.
8. **Then, separately:** dates to `timestamptz`, integers to `boolean`.

Steps 1–4 are the bulk. Step 7 is an afternoon if 1–6 were done properly.

---

## Should we?

**Not for the proof of concept.** SQLite is the right call for what this
currently is, and `CLAUDE.md` is explicit that the PoC is disposable — if it
succeeds, plan to rewrite rather than evolve.

The reasons that would change the answer:

| reason | applies today? |
|---|---|
| More than one app server | no |
| Concurrent writers | no — one process, one officer at a time |
| Real backup and point-in-time recovery | not yet, but the first real pilot needs it |
| Row-level security, if tenancy ever arrives | no — single tenant by decision |
| **`node:sqlite` is experimental** | **yes** |

That last one is the only argument with force today. Node prints the warning on
every start for a reason, and the API may change under us.

**A cheaper answer to that specific risk:** move to `better-sqlite3`, which is
stable, synchronous, and a near drop-in for the three seam functions. It buys
the stability without any of the async conversion. If the reason for moving is
"experimental API" rather than "we need a server database", that is the change
to make instead — an afternoon rather than four days.

Decide which problem is actually being solved before starting.
