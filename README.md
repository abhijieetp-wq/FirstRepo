# ELGI PMT ERP

Internal ERP for Punjab Machine Tools' ELGi department, covering **both** business streams —
compressor sales and spare parts sales — over a shared backbone of customers, quotations,
orders, credit control, inventory, dispatch, billing and collections.

Google Apps Script Web App bound to a Google Sheet. No separate database or hosting.

## Authoritative specification

`ELGI_PMT_ERP_Detailed_Blueprint.xlsx` (14 sheets) is the spec. It supersedes the earlier
`ELGI-Spares-ERP-Handoff-Brief-v2.md` and `ELGI-Settings-Page-Spec.md` on scope, data model,
roles and process; those two remain useful only for UX patterns already locked in.

- `docs/DECISIONS.md` — the five locked decisions (platform, scope, Tally, roles, brands)
- `docs/ARCHITECTURE.md` — why Sheets for now, the rules that keep a database migration
  cheap, and the signals that say it's time to move

## Architecture

- The Sheet is the database. Every tab is a table; row 1 is the header row.
- `Session.getActiveUser().getEmail()` identifies the caller; the `Users` tab is the
  authorization list (email → name/role/businessStream/active).
- The frontend (`Index.html` + `JavaScript.html`) reaches the backend only through
  `google.script.run` — there is no REST API.
- All storage access goes through `SheetService.gs`. Nothing else touches `SpreadsheetApp`.
  That single seam is what makes a later move to a real database a swap rather than a rewrite.
- Prices are effective-dated and stock is an append-only ledger, so history is never
  overwritten and any current number can be explained by the rows that produced it.
- Two price levels: **PIE** is the buying price, **ELGI** the selling price. Quotations use
  the ELGI price and label it simply "Price". PIE is cost data and is returned only to
  Management and ERP Admin (FR-062).

## Setting up the Sheet

`src/Schema.gs` declares every tab and column. **Do not create tabs or type header rows by
hand.** Run `setupSheet()` once from the Apps Script editor and it creates everything, seeds
the reference data and migrates legacy rows. It only ever adds tabs and appends columns —
never reorders, renames or deletes — so it is safe to re-run at any time.

## Working routine

After any change to this repo:

```
git pull
clasp push
```

then, **if the schema changed**, run `setupSheet()` from the Apps Script editor, and finally
publish it to the live URL:

**Deploy → Manage deployments → ✎ edit → Version: New version → Deploy**

That last step is the one that's easy to miss: `clasp push` updates the saved code, but the
deployed web app keeps serving its pinned version until a new one is published.

First-time setup only: `npm install -g @google/clasp` then `clasp login`.

## Repo layout

```
src/
  appsscript.json    Apps Script manifest (execute-as-user, domain access)
  Schema.gs          single source of truth for every tab and column
  Setup.gs           setupSheet(): idempotent create/upgrade/migrate
  SheetService.gs    generic read/append/update/delete + audit logging
  Auth.gs            current-user lookup, the five roles, role gates
  Config.gs          admin-maintainable dropdown lists (FR-074)
  Customers.gs       customer master + contacts + addresses
  Products.gs        compressor product master
  Spares.gs          spare parts master, alternates, compatibility
  Pricing.gs         effective-dated price lists (FR-016/017)
  Stock.gs           append-only stock ledger, availability (FR-036/037)
  SpareEnquiries.gs  spare enquiry capture and part identification (FR-022/023/025)
  Quotations.gs      quotations for both streams, revision control (FR-018/019/020)
  CompressorSales.gs leads, opportunities, site visits, technical selection (M02/M03/M04)
  Orders.gs          sales orders, PO validation, credit control, approvals (M09/M10/M20)
  CatalogImport.gs   bulk CSV upload with preview-before-commit
  Code.gs            doGet(), include(), bootstrap()
  Index.html         page shell, views, modals
  Stylesheet.html    shared CSS
  JavaScript.html    client bootstrap, tab routing, feature modules
```

## Roles

Five roles (decision D4): `Sales Coordinator`, `Sales Engineer`, `Service Engineer`,
`Management`, `ERP Admin`.

Sales Coordinator also performs stores, dispatch, billing and collection work. Management
approves exceptions and owns commercial terms. ERP Admin adds configuration and user
management on top.

Enforced server-side via `requireRole_`, never only hidden in the UI:

| Area | Who can write |
|---|---|
| Product / Spare masters, pricing | Management, ERP Admin |
| Customer records | Sales Coordinator, Sales Engineer, Management, ERP Admin |
| Customer commercial terms (credit limit, days, payment terms, risk) | Management, ERP Admin |
| Customer deactivation | Management, ERP Admin |
| Stock movements | Sales Coordinator, Management, ERP Admin |
| Bulk catalog upload | Management, ERP Admin |
| Sales orders and status changes | Sales Coordinator, Management, ERP Admin |
| Releasing a credit hold | Management, ERP Admin |

PIE (cost) prices and margin are visible only to Management and ERP Admin — the server omits
those fields for everyone else rather than merely hiding the column.

## Build status

Target is the blueprint's own Phase 1 workstreams (Development Roadmap sheet).

- [x] **Stage 0a — schema freeze**: schema declared in code, `setupSheet()` migrator, audit
      logging on every write (FR-061), five-role model
- [x] **Stage 0b — catalog cut-over**: Spares/Products masters, effective-dated PriceList,
      stock derived from the movement ledger, alternates split from model compatibility
- [x] **Foundation**: customer master with contacts, addresses and commercial terms
      (FR-001/002/003), duplicate detection, admin config lists (FR-074)
- [x] **Spare Sales**: enquiry → part identification (compatibility + live availability) →
      priced quotation with revision control (FR-018/019/020/026)
- [x] **Compressor Sales**: lead capture and conversion, activity log, site visits, technical
      requirement sheet (gating the quote, FR-009), compressor selection, 7-stage funnel with
      weighted pipeline (FR-011/012/013)
- [x] **Order & Commercial**: PO validation against the quote (FR-030), 8-state order
      lifecycle as a validated state machine (FR-031), credit exposure across invoices and
      open orders with automatic hold and logged Management release (FR-032/033/034/035)
- [ ] **Inventory & Inward**: stock states, reservations, serial tracking, bins, GRN
- [ ] **Dispatch & Billing**: readiness checklist, dispatch docs, invoice from dispatch,
      dispatched-not-invoiced control
- [ ] **Collections & Tally**: ageing, follow-ups, commitments, Tally sync both ways
- [ ] **Management Dashboards**: control tower, compressor / spare / combined dashboards
- [ ] **Settings page**: brand tiles + Admin Controls (per `ELGI-Settings-Page-Spec.md`)
