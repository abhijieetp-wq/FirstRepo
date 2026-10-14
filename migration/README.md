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
