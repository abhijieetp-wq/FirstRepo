# Architecture: Sheets Now, Database Later

Per decision D1, Phase 1 runs on Apps Script + Google Sheets. This document exists so that
choice stays deliberate: it records what the ceiling actually is, the design rules that keep
a future migration cheap, the signals that say "migrate now", and how the migration would
actually run.

## Why this is a real constraint, not a theoretical one

Google Sheets is a spreadsheet, not a database. Specifically:

| Limit | Consequence for this ERP |
|---|---|
| No transactions | A dispatch that must decrement stock, update order status and write an audit row can half-complete. There is no rollback. |
| Concurrency via `LockService` only | Two users saving the same record serialize at best; without the lock, one silently overwrites the other. |
| 6-minute execution limit per call | Bulk price upload of 7,000+ SKUs, or a control tower reading every tab, can be killed mid-run. |
| ~10M cells per spreadsheet | Invoices, ledger lines, stock movements and audit rows accumulate forever. Audit logging (FR-061) alone is high-volume. |
| No indexes or query engine | `readTable_` pulls a whole tab into memory to answer any question. Credit exposure (FR-033) and the control tower (FR-063) read across everything on each load. |
| No referential integrity | Nothing stops an order pointing at a deleted customer. Enforcement is our code's job. |

Phase 1 workloads that push hardest on these: credit exposure across all open orders, the
management control tower, stock reservation under concurrent dispatch, the audit trail, and
Tally sync volume.

## Design rules that keep migration cheap

These are binding on all new code. Each one exists so a future port is a swap, not a rewrite.

1. **One data seam.** All storage access goes through `SheetService.gs`. No feature module
   calls `SpreadsheetApp` directly. Migration = reimplement that one file against a database.
2. **Surrogate ids everywhere.** Every row has a stable generated `id`. Never address a
   record by row number or by name outside `SheetService`.
3. **Foreign keys by id, never by name.** (Current debt: orders/quotations reference the
   customer by *name*. This must be corrected during the schema freeze — a customer rename
   would silently orphan history, and it will not survive a port to a real schema.)
4. **The Sheet is dumb storage.** No formulas in data tabs. All computation lives in `.gs`
   code, so behavior moves with the code rather than being stranded in cells.
5. **Ledgers, not running totals.** Stock movements, payments and status changes are
   append-only rows; current state is derived. Mutating a single "current stock" cell is how
   Sheets-based systems become unauditable and unrecoverable.
6. **Every write is audited.** Writes go through a wrapper that records table, record id,
   field, old value, new value, user, timestamp and reason (FR-061). Cheap to add now with
   ~6 write paths; painful at 40.
7. **Normalize types at the boundary.** Dates as `yyyy-MM-dd` strings, numbers as numbers,
   booleans as `TRUE`/`FALSE`, at read and write. Sheets' loose typing must not leak upward.
8. **One tab = one table.** No multi-purpose tabs, no side-by-side blocks in a single sheet.
9. **Paginate and project at the seam.** Read only the columns and row ranges needed;
   `readTable_` returning a whole tab is acceptable for masters, not for ledgers.

## Migration trigger signals

Migrate when any of these becomes true — do not wait for a hard failure:

- Any single tab exceeds ~50,000 rows (audit log and stock ledger will hit this first).
- Catalog or list screens take longer than ~3 seconds to load.
- The control tower/dashboard takes longer than ~10 seconds, or any call approaches the
  6-minute limit.
- More than ~10 concurrent users, or `LockService` timeouts start appearing in logs.
- Spreadsheet cell count passes roughly half the 10M limit.
- Tally sync volume makes a scheduled run exceed its window.

## How the migration would actually run

The recommended target keeps the investment in the UI and business logic:

**Option A (recommended) — keep Apps Script UI, move storage to Cloud SQL (Postgres/MySQL).**
Apps Script can talk to Cloud SQL over JDBC. Only `SheetService.gs` is rewritten; every
feature module, all client HTML/JS, the deployment and the user-facing URL stay as they are.
This is the cheapest exit and the reason rule 1 matters most.

**Option B — full web application** (e.g. Node/Next.js + Postgres). Needed only if the UI
itself becomes the constraint (offline use, mobile app, heavy reporting, non-Workspace
users). Business rules port; the UI is rebuilt.

**Option C — a low-code platform** (AppSheet, Retool and similar). Fast, but trades our
control over workflow and approval logic for their conventions. Not recommended given the
approval matrix and Tally requirements.

**Mechanics, in either case:** each tab exports to CSV with its header row and imports to a
table of the same name and columns. Because ids are stable and foreign keys are by id
(rule 3), relationships survive the copy intact. The audit ledger and stock movement ledgers
(rule 5) can be replayed to verify derived state matches after the cut-over. Run both systems
against a copy for one cycle, reconcile, then switch the deployment.

## Tally connectivity (see D3)

Apps Script calls out from Google's infrastructure, not from PMT's network. If the TallyPrime
XML interface is not reachable from the public internet, the integration needs a bridge
process running inside PMT's network — polling the ERP for pending invoices and pushing
ledger/receipt updates back. Confirm reachability before designing the sync. A LAN-only Tally
is the normal case, so assume a bridge until proven otherwise.
