# The ERP, end to end

Everything that exists today, in one document, in plain terms. If you read nothing else about
this project, read this.

`ARCHITECTURE.md` argues about Sheets versus a database. `DECISIONS.md` records why individual
choices were made. The `README` is a long working log. **This file is the map.**

---

## 1. What it is

An internal ERP for **Premier India Enterprise (PIE)**, an ELGi compressor channel partner.
It covers the commercial side of the business: an enquiry arrives, a quotation goes out, an
order comes back, goods are dispatched, an invoice follows, money is collected.

It is a **Google Apps Script web app bound to a single Google Spreadsheet**. The spreadsheet
is the database. The script is the server. The browser gets one HTML page.

Current size:

| | |
|---|---|
| Tabs in the spreadsheet | **52** |
| Columns across them | **788** |
| Server code files (`.gs`) | **43**, about 17,000 lines |
| Spare parts loaded | **13,587** |
| Price rows behind them | **~27,000** (a cost and a selling price for each) |

---

## 2. The three pieces

```
   BROWSER                    APPS SCRIPT                  SPREADSHEET
   ───────                    ───────────                  ───────────
   Index.html         ──►     Code.gs  doGet()      ──►    52 tabs
   Stylesheet.html            43 .gs modules               one row = one record
   JavaScript.html    ◄──     SheetService.gs       ◄──    no formulas, ever
        │                          │
        └── google.script.run ─────┘
            (the only door)
```

**The browser** holds one page. There are no other URLs — switching from Quotations to Catalog
hides one `div` and shows another. Everything it needs from the server goes through
`google.script.run`, which is Apps Script's one channel between the page and the code.

**The script** runs on Google's servers, as *you* (the deploying owner), not as whoever opens
the portal. Every function that the browser can call is a plain function in a `.gs` file.

**The spreadsheet** is dumb storage. No formulas in any data tab. Every calculation lives in
code, so behaviour travels with the code rather than being stranded in a cell somebody later
drags over.

### Why things are slow

Worth understanding, because it explains most complaints. Each conversation with the
spreadsheet — reading a tab, asking how many rows it has, appending a row — is a round trip
to Google's servers, costing roughly 50–300ms. The spreadsheet also cannot be asked a
question: there is no "find the part numbered 959439". The code must read the whole tab and
look through it. And after a quiet spell, Google has to start the script up again, which takes
ten to fifteen seconds before anything happens at all.

---

## 3. Who uses it

Six roles, set per person on the Users tab:

| Role | What they do |
|---|---|
| **Sales Coordinator** | Logs enquiries, raises quotations, takes orders, arranges dispatch |
| **Sales Engineer** | Compressor side: leads, site visits, technical requirements |
| **Service Coordinator** | Decides which engineer goes to which job |
| **Service Engineer** | Does the job, files the report |
| **Management** | Approves discounts and credit, sees the dashboard and cost prices |
| **ERP Admin** | Everything, plus settings, users and the catalogue |

**Signing in does not use Google.** PIE's staff have no company Google addresses and the
business does not want personal ones holding company data, so the portal checks a username and
password itself. There is an optional second gate that also requires a named Google account —
currently switched off.

### Two streams

Every transaction belongs to one of two business streams:

- **Compressor Sales** — machines. Long cycle: lead → site visit → technical requirement →
  selection → opportunity → quotation.
- **Spare Sales** — parts. Short cycle: enquiry → identify parts → quotation.

They share one backbone — the same customers, the same quotation, order, dispatch and invoice
machinery — and a person who works in one stream only sees that stream's work.

---

## 4. How a job travels through it

### Spares (the short road)

```
SpareEnquiry ──► SpareEnquiryItems ──► Quotation ──► SalesOrder ──► Dispatch ──► Invoice ──► Receipt
  "customer        "these are the        the offer     their PO      goods go      Tally        money
   rang about       parts they need"                                  out          makes it      in
   a filter"
```

1. **Enquiry.** Who rang, which machine, what they need. Logged against a customer.
2. **Identify the parts.** Search the catalogue by part number, description or product group,
   and attach the parts to the enquiry.
3. **Quotation.** Prices come from the price list as of today; the offer is printed and emailed.
4. **Sales order.** The customer's PO arrives and is checked against the quotation.
5. **Dispatch.** Readiness is checked (credit, address, stock), goods are packed and shipped.
6. **Invoice.** Made in Tally, then attached to the record here with its number and value.
7. **Receipt.** Payment, mostly imported from Tally.

### Compressors (the long road)

```
Lead ──► SiteVisit ──► TechnicalRequirement ──► CompressorSelection ──► Opportunity ──► Quotation ──► (same from here)
```

The extra steps exist because a compressor is specified before it is priced: what pressure,
what air quality, what duty cycle. Those answers gate the quotation.

### After delivery

```
Dispatch ──► DeliveryProof (photos) ──► ServiceJob ──► ServiceProof ──► InstalledBase
```

---

## 5. The map — which tab connects to which

Links are always by **id**, never by name. A column ending in `Id` points at another tab's `id`.

### The spine

```
Customers
   ├── CustomerContacts        (who to ring)
   ├── CustomerAddresses       (billing / shipping / site)
   └── CustomerItemCodes       (their code for our part)

Customers ──► Leads ──► Opportunities ──► Quotations ──► SalesOrders ──► Dispatches ──► Invoices ──► Receipts
                                              ▲                              │
              SpareEnquiries ─────────────────┘                              └──► ServiceJobs
```

### Every tab, grouped

**Who and what the business is**

| Tab | Holds | Points at |
|---|---|---|
| `Users` | Who can sign in, their role and stream | — |
| `Sessions` | Live sign-ins (token stored hashed) | — |
| `CompanyProfile` | The seller as printed on documents — one row | — |
| `QuoteTemplates` | Standing quotation wording | — |
| `BusinessStreams`, `Brands`, `ConfigLists`, `LostReasons` | Dropdowns admins maintain | — |
| `AuditLog` | Every field change: who, when, old, new | any record |
| `Telemetry` | How long each server call took | — |

**Customers**

| Tab | Holds | Points at |
|---|---|---|
| `Customers` | One customer code across both streams | — |
| `CustomerContacts` | Purchase / accounts / owner contacts | `Customers` |
| `CustomerAddresses` | Several billing and shipping addresses | `Customers` |
| `CustomerItemCodes` | What the customer calls a part | `Customers`, a catalogue item |

**The catalogue**

| Tab | Holds | Points at |
|---|---|---|
| `Spares` | 13,587 ELGi parts | — |
| `Products` | Compressor models | — |
| `PriceList` | Dated prices, two levels per item | a catalogue item |
| `SpareCompatibility` | Which part fits which machine | `Spares`, `Products` |
| `SpareAlternates` | Substitute parts | `Spares` |
| `Warehouses` | Warehouses and bins | itself (bins sit under warehouses) |

> **Two price levels.** `PIE` is what PIE pays — the cost, visible only to Management and ERP
> Admin. `ELGI` is what the customer pays, and the only one a quotation ever shows. Prices are
> dated, so an old quotation keeps the price it was raised at.

**Compressor sales**

| Tab | Points at |
|---|---|
| `Leads` | `Customers`, `LostReasons` |
| `LeadRequirements` | `Leads` |
| `SiteVisits` | `Leads`, `Opportunities`, `Customers` |
| `TechnicalRequirements` | `Opportunities`, `Leads`, `Customers` |
| `CompressorSelections` | `TechnicalRequirements`, `Opportunities`, `Products` |
| `Opportunities` | `Customers`, `Leads`, `LostReasons` |
| `Activities` | any record (follow-ups) |

**Spare sales**

| Tab | Points at |
|---|---|
| `SpareEnquiries` | `Customers`, `CustomerContacts`, `ServiceJobs`, `LostReasons` |
| `SpareEnquiryItems` | `SpareEnquiries`, `Spares` |

**The commercial core** — shared by both streams

| Tab | Points at |
|---|---|
| `Quotations` | `Customers`, `CustomerAddresses` ×2, `Opportunities`, `SpareEnquiries`, itself (revisions) |
| `QuotationItems` | `Quotations`, a catalogue item |
| `SalesOrders` | `Customers`, `Quotations`, `CustomerAddresses` ×2 |
| `SalesOrderItems` | `SalesOrders`, a catalogue item |
| `Approvals` | any record needing a decision |
| `CreditChecks` | `SalesOrders`, `Customers` |

**Stock**

| Tab | Points at |
|---|---|
| `StockMovements` | a catalogue item, `Warehouses` |
| `StockReservations` | `SalesOrders`, `SalesOrderItems`, a catalogue item, `Warehouses` |
| `SerialNumbers` | `Products`, `Warehouses`, `GRNs`, `SalesOrders`, `Dispatches` |
| `GRNs`, `GRNItems` | goods inward; `GRNItems` → `GRNs`, a catalogue item, `Warehouses` |

**Out of the door**

| Tab | Points at |
|---|---|
| `Dispatches` | `SalesOrders` |
| `DispatchItems` | `Dispatches`, `SalesOrderItems`, a catalogue item |
| `DeliveryProofs` | `Dispatches` (photographs on delivery) |
| `Documents` | any record — the customer's own PO, invoice and paperwork |
| `ServiceJobs` | `Dispatches`, `SalesOrders`, `Customers`, `SpareEnquiries` |
| `ServiceJobItems`, `ServiceProofs` | `ServiceJobs` |
| `InstalledBase` | `Customers`, `Products` |

**Money**

| Tab | Points at |
|---|---|
| `Invoices` | `SalesOrders`, `Dispatches`, `Customers` |
| `InvoiceItems` | `Invoices`, a catalogue item |
| `Receipts` | `Customers`, `Invoices` |
| `CollectionFollowups` | `Invoices`, `Customers` |

### One pattern worth knowing: `itemId` + `itemType`

Several tabs refer to "a catalogue item" rather than specifically a spare or a product. They
carry two columns: `itemType` says `Spare` or `Product`, and `itemId` is the id in whichever
tab that names. `PriceList`, `QuotationItems`, `SalesOrderItems`, `StockMovements` and the rest
all work this way, which is why a quotation can carry a compressor and a filter on the same
document.

The same trick appears as `recordType` + `recordId` on `AuditLog` and `Documents`, and
`relatedType` + `relatedId` on `Activities` and `Approvals`.

---

## 6. The code — which file does what

**The spine (touch these carefully)**

| File | What it is |
|---|---|
| `Schema.gs` | **The single source of truth.** Every tab, every column, declared once. `Setup.gs` builds the spreadsheet from it, so the sheet can never drift from the code. |
| `SheetService.gs` | **The only file that talks to the spreadsheet.** Every read and write in the whole system goes through it. This is what makes a database migration a swap rather than a rewrite. |
| `Code.gs` | Serves the page; holds the build stamp. |
| `Session.gs`, `Auth.gs` | Signing in; who may do what. |
| `Setup.gs` | Creates or upgrades the spreadsheet from `Schema.gs`. Adds missing tabs and columns; never removes anything. |

**Masters** — `Customers`, `Spares`, `Products`, `Pricing`, `CatalogImport`, `CatalogComplete`,
`CatalogDelete`, `CustomerItemCodes`, `ItemReferences`, `Config`, `CompanyProfile`

**Selling** — `CompressorSales` (leads, visits, requirements), `SpareEnquiries` (enquiries and
part search), `Quotations`, `QuotationDocument` (the printed offer), `QuotationEmail`,
`QuotationJourney`, `QuotationProgress`, `SalesPolicy` (who may approve what)

**Fulfilling** — `Orders`, `Inventory`, `Stock`, `Dispatch`, `Documents`, `Service`,
`ServiceReport`

**Money** — `Billing`, `Collections`, `TallyImport`

**Admin and plumbing** — `Settings`, `Dashboard`, `StreamAccess`, `UserEmail`, `GoogleGate`,
`Sha256`, `Telemetry`, `KeepWarm`

**The browser** — `Index.html` (every screen's markup), `Stylesheet.html`,
`JavaScript.html` (~11,000 lines: the whole client)

---

## 7. The five rules that hold it together

These are not style preferences. Each one is load-bearing.

1. **One data seam.** Nothing outside `SheetService.gs` touches `SpreadsheetApp`. Moving to a
   real database means reimplementing one file.

2. **Every row has an id.** Generated, stable, never a row number and never a name. A customer
   renaming themselves must not orphan their history.

3. **The sheet is dumb.** No formulas in data tabs. If a number is calculated, code calculates
   it.

4. **Ledgers, not totals.** There is no "current stock" cell. Stock on hand is the sum of
   `StockMovements`; a correction is a new row, never an edit. Same for payments and status
   changes. This is why any number can be explained by the rows that produced it.

5. **Everything important is audited.** `AuditLog` records who changed what, from what, to
   what, and why. An audit write can never block or undo the thing it is recording.

---

## 8. How it gets deployed

This catches everyone, so it is worth stating plainly:

```
clasp push        →  saves the code to the Apps Script project
                     the live portal does NOT change
Deploy → Manage deployments → pencil → New version
                  →  NOW the live portal changes
```

The `/exec` URL serves a **pinned version**. Pushing code and seeing no change is normal, not a
fault. Every screen's footer shows the build stamp from `Code.gs` so you can tell a stale
deployment from a broken feature.

That split is also the safety net: if a bad version goes out, pointing the deployment at an
earlier version puts the old one back in thirty seconds.

---

## 9. Where it is going

The portal works, and it is slower than it should be. Measurement says the cost is not the
code — it is the platform. A first interaction after a quiet spell takes ten to fifteen seconds
while Google starts the script; everything after that is quick.

Nothing in this codebase can fix that, so the system is being rebuilt:

- **Front end:** React, served as static files
- **Back end:** Node, staying up rather than starting per request
- **Database:** Postgres, which can be asked questions instead of handing over whole tabs

The existing server functions already behave like an API — they take arguments and return
JSON — so the business logic largely ports rather than being rewritten. `migration/schema.js`
already generates the Postgres schema from `Schema.gs`, so the database and the spreadsheet
cannot disagree while both are live during the cutover.

Expect five to seven weeks, phased, with a parallel run before anyone is asked to trust it.
