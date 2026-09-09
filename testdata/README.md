# Test data

Six CSV files that fill the system with enough realistic data to see every screen working.
Every one has been run through the app's own import validators — they all pass with zero
rejected rows.

The catalog uses **real ELGi part numbers, descriptions, prices and HSN codes** taken from
Premier India Enterprises' own quotation, so what you see on screen is recognisable rather
than invented.

## Import them in this order

Order matters — each file refers to the one before it.

| # | File | Where | Rows |
|---|---|---|---|
| 1 | `1-spares.csv` | Catalog → Spares → Bulk Upload | 26 |
| 2 | `2-products.csv` | Catalog → Compressors → Bulk Upload | 8 |
| 3 | `3-customers.csv` | Customers → Bulk Upload | 12 |
| 4 | `4-opening-stock.csv` | Settings → Data Import → Opening Stock | 30 |
| 5 | `5-open-receivables.csv` | Settings → Data Import → Open Receivables | 14 |
| 6 | `6-receipts.csv` | Collections → Import Receipts | 4 |

## What each one is built to prove

**Catalog** — 26 spares across filters, separators, hoses, valves, belts, lubricants,
electricals, kits and coolers, and 8 compressors covering both types PMT sell (5 rotary screw
EG, 3 reciprocating AB). Every row carries an HSN code and both PIE and ELGI prices, so the
cost/selling split and the Management-only visibility can both be checked.

**Opening stock** — every part gets a balance, and **7 of them deliberately sit below their
reorder level**, so the dashboard's "Spares below reorder level" exception has something real
to report instead of always reading zero.

**Open receivables** — 14 invoices spread deliberately across *every* ageing bucket:

| Bucket | Invoices |
|---|---|
| 90+ days | 3 (one part-paid) |
| 61–90 days | 2 |
| 31–60 days | 3 (one part-paid) |
| 1–30 days | 3 (one part-paid) |
| Not due | 3 |

Total outstanding after import: **₹26,41,000**. That number is the one to check against the
Collections screen and the dashboard — if they disagree, something is wrong.

**Receipts** — 4 part payments against existing invoices, so importing them visibly moves the
ageing and the outstanding total (down to ₹21,42,000). Each carries a Tally voucher reference,
so re-importing the same file is refused rather than double-posted — worth trying deliberately.

## What cannot be bulk-loaded

Leads, opportunities, enquiries, quotations, orders, dispatches and invoices have no importer,
and deliberately so: they are the *process*, not master data. Creating one of each by hand is
the end-to-end test, and is the only way to find out whether the chain actually holds together.

Suggested run once the six files are in:

1. Log a lead → add both compressor types → convert it to an opportunity
2. Log a spare enquiry for Topworth Urja → identify parts → raise a quotation
3. Convert the quotation to an order with a PO → watch the credit check run
4. Reserve stock → open a dispatch → post it
5. Raise the invoice from the dispatch → issue it
6. Record a receipt → confirm the ageing moves

If any step refuses when it shouldn't, that is worth reporting — it is the kind of thing no
amount of testing against fake data will find.
