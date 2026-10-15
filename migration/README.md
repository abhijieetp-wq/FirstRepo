# Migration — Apps Script + Sheets → Node + Postgres

Phase 1 of the plan. Everything here is generated from or verified against the live system;
nothing is hand-maintained beside it, because two sources of truth is how a cutover loses
data it cannot get back.

## Why generate the schema rather than write it

`src/Schema.gs` has declared every tab and column since the project started, and `Setup.gs`
reads it to build the spreadsheet — which is why the sheet has never drifted from what the
code expects. The database inherits that property by being generated from the same
declaration. A column added to `Schema.gs` and not to the database then shows up as a
difference at build time, rather than as a missing value six weeks into a parallel run.

## Running it

```bash
node migration/schema.js            # the DDL
node migration/schema.js --report   # every type, and the reason it was chosen
```

52 tables, 788 columns, 160 indexes.

## What the report is for

The sheet has no types — every cell is a string until something reads it. So types are
inferred from the naming conventions documented at the top of `Schema.gs`, and **every
inference is printed with its reason so it can be argued with**.

That is not ceremony. Reading the first report caught two inferences that would have
imported as numbers and silently dropped every row they described:

- `priceLevel` holds `PIE` or `ELGI`. It matched a rule meant for `reorderLevel`.
- The audit log's `oldValue` / `newValue` hold whatever changed — a status, a name, an
  address. They matched a rule meant for money.

Both now sit in `OVERRIDES` with the reason. Conventions are a good default and a bad
authority.

Four columns are in `UNSURE` and stay `TEXT` until the export shows what is actually in
them. `TEXT` cannot lose a value; tightening a column later is a migration, and recovering
values that were coerced away is not possible.

## Decisions already baked in

**`tenant_id` on every table, from the first migration.** PIE is the first client and the
intention is to sell this to others. Adding the column later means touching 52 tables, every
query and every index at a point when real customers' data is in them.

**Indexes on what the code actually filters by.** The sheet reads whole tabs and filters in
memory because that is all it can do — `suggestSpares` reads 13,587 parts to return 50. The
database does not have to, and the indexes here are the filters the existing code applies:
foreign keys, `itemType`, `status`, `partNo`, `productGroup`, `active`, `priceLevel`.

**`snake_case`.** A Postgres identifier that needs quoting is one everybody eventually gets
wrong.

## Not done yet

- The exporter (every tab → JSON, verified row-for-row against the sheet)
- The loader, and a count check per table before anything is believed
- `NOT NULL` and foreign keys — deliberately absent until the real data is loaded and we
  know which columns are genuinely always present

---

## Phase 2 — the data layer

`server/db.js` is what `SheetService.gs` becomes. Twelve functions, same names, same return
shapes, against Postgres.

```bash
cd server && npm install

# a local Postgres to develop against
export PATH=/usr/lib/postgresql/16/bin:$PATH
initdb -D /var/tmp/erp-pg -U erp --auth=trust
pg_ctl -D /var/tmp/erp-pg -o '-p 5433 -k /var/tmp' start
createdb -h /var/tmp -p 5433 -U erp erp_dev
node migration/schema.js | psql -h /var/tmp -p 5433 -U erp -d erp_dev

export DATABASE_URL="postgres://erp@/erp_dev?host=/var/tmp&port=5433"
node tests/db-test.js
```

### Faithful first

Everything returns exactly what the Apps Script version returned, oddities included:

- **blanks are `''`, not null** — a spreadsheet has no null, and the portal is full of
  `String(x).trim()` written against that. null would print as "null" on a quotation.
- **dates are `'yyyy-MM-dd'` strings** — pg builds a `Date` at the server's midnight, which
  can slide the day across time zones. The portal compares these as text throughout.
- **NUMERIC comes back as a number** — pg returns strings to protect precision; the widest
  column here is `NUMERIC(14,2)`, comfortably exact as a double.
- **one audit row per changed field** on update, not one per save. The log exists to answer
  "who changed the price and what was it before".
- **an update that matches no row throws**, rather than succeeding quietly.

Making the queries clever comes after everything works, not during.

### What a tenant is for

Every statement carries `tenant_id`, and `connect()` refuses without one. A missing `WHERE`
on a shared table is how one client reads another's prices, so the tests check it on reads,
lookups, column maps **and** writes.

### Measured, on the real catalogue

13,587 parts and 27,174 prices, loaded in **1.5 seconds** — against an evening of chunked
uploads and HTTP 503s through the portal.

| | |
|---|---|
| `readTable('Spares')` — all 13,587, the deliberately naive port | **76 ms** |
| `findRowById` | **0.4 ms** |
| search by part number, indexed | **0.4 ms** |
| the counter's real search — group + text + price, capped at 50 | **5.2 ms** |

The last line is the one to hold on to. That same search in the live portal takes ten to
fifteen seconds on the first try of the day.

### Still to do in Phase 2

- The exporter: the live sheet's rows into this schema, verified row for row
- The async conversion across the 43 modules — ~630 call sites
- Then replace the faithful `readTable` calls on the hot paths with real queries

---

## How big the async conversion really is

```bash
node migration/async-map.js           # the summary
node migration/async-map.js --files   # per file, worst first
node migration/async-map.js --list    # every function that must change
node migration/async-map.js --clean   # the files that need nothing
```

This parses all 43 files with a real JavaScript parser, builds the call graph, seeds it with
the twelve functions `db.js` makes asynchronous, and propagates until nothing changes.

Worth doing properly, because counting calls to the storage functions gave 630 and that was
wrong in both directions. It overcounted — many of those calls sit in the same few functions.
And it badly undercounted, because `async` is contagious: anything that awaits must itself be
async, and so must everything that calls it, four rounds up to the entry points.

| | |
|---|---|
| Functions that must become async | **281** |
| `await`s to type in | **967** |
| Files touched | **37 of 43** |
| Files needing nothing at all | **6** |
| **Of those awaits, inside a callback** | **71** |

**That last row is the only part that is not mechanical**, and it is why the estimate still
holds. 896 of the 967 are "put `await` in front of this call and `async` on the function
around it" — scriptable, and the test suite catches what is missed. The other 71 sit inside
`rows.forEach(function (r) { ... })`, which cannot simply be awaited because `forEach` returns
before the work finishes. Each becomes a `for...of` loop, read individually, by hand.

Seventy-one considered edits is a week's careful work, not a month's.

### Where it is concentrated

`Quotations` is the heaviest at 141 awaits and 11 callbacks, then `Billing`, `CompressorSales`
and `Dispatch`. The order to convert in is the reverse: `GoogleGate` (1 await),
`CatalogComplete` (3), `Config` (4), `SalesPolicy` (4) first, to prove the method on
something small enough to read in full before touching the quotation engine.

### The six files that need nothing

`Auth`, `Schema`, `Sha256`, `StreamAccess` are pure logic with no storage in them.
`KeepWarm` goes away with Apps Script. `SheetService` is replaced wholesale by `db.js`
rather than edited.

---

## The codemod

```bash
bash migration/dev-db.sh                          # a local Postgres, idempotent
eval "$(bash migration/dev-db.sh)"                # ...and DATABASE_URL set

node migration/to-async.js GoogleGate             # what would change
node migration/to-async.js GoogleGate --write     # do it
node migration/to-async.js --all                  # survey every module
```

It does two things and refuses to do a third:

1. a function the call graph says must be async gets `async` in front of it
2. a call to something asynchronous gets `await` in front of it
3. **a call inside a callback is reported, not edited** — and the file is not written until
   those are gone

That third rule is the important one. `rows.forEach(function (r) { ... audit_(r) })` cannot
be fixed by inserting `await`: the callback becomes an async function returning a promise
that `forEach` throws away, so the loop finishes while the writes are still in flight and the
save reports success. Silent, intermittent, and only under load — the worst kind. Each one
becomes a `for...of`, by hand.

**24 of 43 files convert mechanically. 19 need hand work first.**

### Two decisions worth knowing

**Nothing is renamed.** `readTable_('Spares')` stays exactly that; `server/shim.js` defines
the twelve old names as async functions forwarding to `db.js`. So the diff is purely `async`
and `await` — reviewable line by line — rather than 967 renames tangled into the same change.

**Edits are spliced by position, never reprinted from the AST.** Regenerating code from the
tree would be functionally identical and would strip every comment in the file. In this
project the comments are the part that took longest and are worth most.

**The originals are not touched.** `src/X.gs` stays frozen and the live portal keeps running
on it; converted copies go to `server/modules/X.js`. PIE cannot stop working for the weeks
this takes.

### Proved end to end

`tests/converted-test.js` loads the real converted `GoogleGate.js` into a vm with the shim,
calls `setGoogleGate`, and checks the audit row is in Postgres **the instant the call
resolves** — no sleep, deliberately, because a sleep would let a missing `await` pass.

It also checks the module's own guards still work: switching the Google requirement on from
a session with no Google account still refuses, which is the logic that stops an
administrator locking themselves out.

---

## Converted so far

**18 of 43 modules** — every file that needed no hand work:

`CatalogComplete` `Code` `Config` `CustomerItemCodes` `Dashboard` `Documents` `GoogleGate`
`QuotationDocument` `QuotationEmail` `QuotationJourney` `QuotationProgress` `SalesPolicy`
`Service` `ServiceReport` `SpareEnquiries` `Stock` `Telemetry` `UserEmail`

Checked by `tests/codemod-test.js`, five ways per file:

1. **The logic is unchanged** — both files parsed, positions dropped, every `async` flag
   cleared and every `await` unwrapped; the two trees must be identical.
2. **Every comment survives** — compared in order. An AST comparison would not notice them
   disappearing, and here they are the part that took longest.
3. It parses.
4. Exactly the functions the call graph named are async, and no others.
5. Nothing asynchronous is called without being awaited.

### What check 5 found on its first run

A bug in the codemod, in eighteen files, of the worst available kind.

`await` is a prefix operator over the *whole* expression that follows. So inserting it at the
front of a call whose result is then indexed into is wrong in a way that parses perfectly:

```js
// generated, wrong
var row    = await readTable_(tab).filter(fn);            // awaits promise.filter -> TypeError
var onHand = await stockOnHandMap_(t)[id] || 0;           // awaits promise[id] -> undefined -> 0

// generated, right
var row    = (await readTable_(tab)).filter(fn);
var onHand = (await stockOnHandMap_(t))[id] || 0;
```

The first throws. **The second does not** — it quietly evaluates to zero, and on-hand stock
reads as nil on every screen that asks. No error, no log line, nothing to trace.

That is precisely the failure this migration has to rule out, it was in the output of a tool
that looked like it worked, and the only reason it is not in the code now is that something
checked rather than assuming.

It also broke the first version of the verifier, which compared text and flagged the added
parentheses as a difference. Comparing trees instead is both more correct and simpler —
parentheses do not exist in an AST.

### Still to do

19 modules with callbacks to unpick by hand, heaviest first: `Quotations` (11),
`Dispatch` (8), `Spares` (6), `Billing` (6), `Session` (6), `TallyImport` (6).
