# Tally cut-over — bringing PMT's opening position into the ERP

PMT run Tally Prime and have done for years. The customer ledger, the item masters and the
outstanding invoices already exist there. **Nothing in this document requires anyone to re-type
data.** Every step is a standard Tally report with a built-in export.

## What comes from where

The ERP and Tally hold different things, and each fact has exactly one owner. Two systems both
believing they are authoritative for the same number is how you end up with a credit limit of
₹5 lakh in one place and ₹8 lakh in the other.

| Data | Owner | How it gets in |
|---|---|---|
| Customer ledgers, GSTIN, credit limits | Tally | Export → **Settings → Data Import → Customers** |
| Spare and product masters, HSN, rates | Tally | Export → **Catalog → Bulk Upload** |
| Stock on hand | **The ERP** (confirmed: PMT do not run inventory in Tally) | Stock count → **Settings → Data Import → Opening Stock** |
| Outstanding invoices at go-live | Tally | Export → **Settings → Data Import → Open Receivables** |
| Leads, opportunities, enquiries, quotations, orders, dispatch, reservations, follow-ups | **The ERP** | Nothing to migrate — Tally never held these |
| Invoices raised after go-live | ERP raises, Tally records | Automatic sync, or marked entered by hand |
| Receipts | Tally | **Collections → Import Receipts**, or entered manually |

That last block is the point of the whole project: roughly two thirds of this system holds
data Tally has never stored, because Tally is an accounting package — it starts at the invoice.
Everything before that has been living in people's heads, in WhatsApp and in spreadsheets.

## The order matters

Each import refers to the one before it, so run them in this order:

1. **Spares and Products** (Catalog → Bulk Upload) — the stock import matches on item code
2. **Customers** (Settings → Data Import) — the receivables import matches on customer
3. **Opening Stock**
4. **Open Receivables**

## Step by step

### 1. Catalog

Tally: Stock Summary, exported as CSV. Map its columns onto the template shown on the Catalog
upload screen (`partNo`, `hsnCode`, `description`, `uom`, `gstPct`, `piePrice`, `elgiPrice`, …).

### 2. Customers

Tally: List of Accounts / Sundry Debtors, exported as CSV.

Expected header:

```
name,gstin,creditLimit,creditDays,paymentTerms,industry,territory,pan,notes
```

Matching is on **GSTIN first, then exact name**. A customer already in the ERP is updated, not
duplicated. Contacts, addresses and the assigned salesperson are the ERP's own and are never
cleared by an import — Tally does not have them, so it cannot overwrite them.

### 3. Opening stock

From the physical stock count (or Tally's Stock Summary quantities if they are trusted).

```
itemType,itemCode,qty,warehouseCode,binId,notes
```

`itemType` may be left blank unless a code exists as both a spare and a product, in which case
the row is rejected until you say which.

**An item that already has an opening balance is refused.** Re-running the same file cannot
double the stock. Corrections after go-live are stock adjustments, not a second opening.

### 4. Open receivables

Tally: Bills Receivable / Outstandings, exported as CSV.

```
invoiceNo,invoiceDate,dueDate,customerName,gstin,amount,amountReceived,businessStream,notes
```

Dates are accepted as `2026-07-14`, `14-07-2026`, `14/07/2026` or `14-Jul-2026`. Amounts may
carry Indian grouping and a `Dr`/`Cr` suffix — `4,00,000.00 Dr` reads as 400000. A blank
`dueDate` is derived from the customer's credit days.

These invoices arrive with no order and no dispatch behind them, because the goods went out
before the ERP existed. They are marked as already synced to Tally, which is exactly where they
came from. A receipt against one behaves like a receipt against any other invoice.

**Skipping this step is the expensive mistake.** Without it the ERP believes every customer
owes nothing: the credit check waves through orders it should stop, the ageing report is empty,
and the dashboard reports zero outstanding — all confidently wrong rather than merely missing.

## Reconcile before you go live

Every import shows a **preview first and writes nothing** until you confirm, and each one
reports a total:

- Customers — how many are new and how many matched an existing record
- Opening stock — total units
- Open receivables — **total outstanding**

Check that last figure against Tally's own receivables total. If they disagree, something is
wrong with the export, and it is very much cheaper to find that out on cut-over day than when a
customer disputes a statement three weeks later.

## Go-live

Pick a freeze date — a month end is easiest to reconcile. Run the four imports. Reconcile. From
that date new business goes through the ERP, and Tally keeps receiving the invoices.

Realistically this is an afternoon for one person who knows Tally, not a data-entry project.
