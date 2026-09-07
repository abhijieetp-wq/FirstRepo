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
  Inventory.gs       stock position, reservations, serials, GRN and verification (M12/M13)
  Dispatch.gs        readiness checklist, dispatch docs, posting stock out (M14)
  Billing.gs         invoice from actual dispatch, Tally handoff (M15, FR-048/049/050)
  Collections.gs     ageing, follow-ups, commitments, receipts, Tally pull (M16, FR-051..055)
  Dashboard.gs       control tower + stream dashboards in one payload (M17/M18, FR-057)
  Settings.gs        brand tiles, users, lists, warehouses, Tally config (D5, FR-062/074)
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
| Stock reservations, GRN, serials | Sales Coordinator, Management, ERP Admin |
| Dispatch, posting stock out, invoicing | Sales Coordinator, Management, ERP Admin |
| Receipts, follow-ups, receipt import | Sales Coordinator, Management, ERP Admin |
| Reversing a receipt | Management, ERP Admin |
| Settings: users, lists, lost reasons, warehouses, brands, Tally config | Management, ERP Admin |
| Running setup from the UI | ERP Admin |
| Overriding the dispatch checklist, cancelling an invoice | Management, ERP Admin |

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
- [x] **Inventory & Inward**: live stock position, order reservations that cannot double-promise
      stock (FR-037), compressor serial tracking (FR-038), bins, and GRN where stock posts only
      on verification (FR-043)
- [x] **Dispatch & Billing**: readiness checklist evaluated from the data with a recorded
      Management override (FR-045), dispatch documents and POD (FR-046/047), posting that moves
      stock, reservations, serials and order status together, invoice raised from what actually
      shipped (FR-048), dispatched-not-invoiced control (FR-049), Tally sync status (FR-050)
- [x] **Collections & Tally**: ageing derived from issued invoices minus receipts, never
      stored (FR-051), follow-ups with commitments judged against what actually arrived
      (FR-052), append-only receipts with reversal rather than edit, idempotent CSV import of
      the Tally receipt ledger and a Tally pull that reuses the same reviewed path (FR-055)
- [x] **Management Dashboards**: control tower of exceptions ranked by severity with
      click-through, order pipeline, ageing, six-month invoiced-vs-collected trend, both
      funnels and the customers holding the most money — combined / compressor / spare as one
      dashboard with a stream filter (FR-057)
- [x] **Settings page**: brand tiles (ELGI live, Cumi/Champion planned — D5) plus Admin
      Controls: users with lockout guards (FR-062), dropdown lists (FR-074), lost reasons,
      warehouses and bins, the Tally connection stored in Script Properties with a Test
      Connection action (D3), and a system panel that can re-run the schema migrator and read
      the audit log (FR-061)

## Tally handover note (decision D3)

The invoice push to Tally is **built and documented, but not verified by us** — and it cannot
be. Apps Script sends HTTP requests from Google's servers, not from a machine on the office
LAN, so the Tally endpoint has to be reachable from the internet before the sync can be tested.
That is the client's IT decision, not ours.

What this means in practice:

- Set `TALLY_ENDPOINT` in **Project Settings → Script Properties** to the Tally Prime XML/HTTP
  endpoint (usually port 9000). Until it is set, `pushInvoiceToTally()` refuses politely and
  says so rather than failing silently.
- `buildTallyInvoiceXml(invoiceId)` returns the exact Sales-voucher XML that would be sent, so
  the client's IT can inspect and test the payload before anything is posted.
- Ledger and stock-item names in the payload come from our customer name and item code. If
  Tally's masters are named differently, the voucher is rejected and the reason is stored on
  the invoice in `tallySyncError` — nothing is lost.

`testTallyConnection()` asks Tally for its company list and returns a readable result instead
of throwing, so PMT's IT can check their own progress without reading logs.

**Nothing else depends on Tally being reachable.** Invoices generate and sit at
`tallySyncStatus = Pending`; anyone can mark one entered manually with its Tally reference; and
the ageing, collections and dispatched-not-invoiced controls all work with zero connectivity.

Receipts come in three ways, in descending order of how much the connection is trusted:
pulled from Tally, imported from a CSV export of the Tally ledger, or typed in. The import is
idempotent — a row whose Tally voucher reference is already in the ledger is rejected, not
posted twice — so re-running the same export is safe, and the CSV path needs no connectivity
at all.

## Dashboard notes

**One call, not eight.** Every figure on the dashboard comes from the same seventeen tables,
so eight endpoints would re-read the same sheets eight times. `getDashboard()` reads each
table once, derives everything in memory, and returns a single payload cached for two minutes.
The Refresh button bypasses the cache.

**Three dashboards, one screen.** The blueprint asks for compressor, spare and combined
dashboards. They are the same dashboard with a stream filter rather than three screens to keep
in step — a metric that means one thing on the combined page and something subtly different on
the spare page is how dashboards start lying.

**No margin figure, deliberately.** Margin needs cost-at-the-time-of-sale, and the only honest
source is the effective-dated PIE price on the day the line was quoted. Approximating it from
today's cost would produce a number that looks precise and is not, so it is absent rather than
wrong. It can be added properly once there is quoted-line cost history to read.

**Chart colours are validated, not chosen by eye.** The ordinal blue ramp and the two trend
series were run through a contrast/CVD validator against the surface they actually sit on.
Exception severities use a reserved status palette that is never reused as a series colour,
and every bar carries a visible label, so nothing on the screen depends on colour alone.

## Settings notes

**Role gating is the real control, not the hidden tab.** The web app runs as the *user
accessing it*, so any signed-in person could call a settings function directly from the
browser console. Hiding the tab stops the honest; `requireRole_` on every server function is
what actually stops the rest.

**Two guards keep the Settings page from locking everyone out of the Settings page**: you
cannot deactivate your own account or drop your own ERP Admin role, and the last active ERP
Admin cannot be demoted or switched off. Both are recoverable by editing the Users tab in the
Sheet by hand — but recovering from the Sheet is a bad afternoon, so the app refuses first.

**Tally connection details live in Script Properties**, never in the spreadsheet and never in
the repo, so they cannot ride along in an export or a commit. A stored credential is never
read back out: the screen can report that one exists and replace or clear it, nothing more,
and the audit entry records the endpoint but not the credential.
