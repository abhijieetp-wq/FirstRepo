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
  CompanyProfile.gs  the letterhead and the standing quotation text, edited in Settings
  QuotationDocument.gs  the printed quotation: preview HTML and the PDF
  TallyImport.gs     opening balances from Tally: customers, stock, receivables
  CatalogImport.gs   bulk CSV upload with preview-before-commit
  Code.gs            doGet(), include(), bootstrap()
  Index.html         page shell, views, modals
  Stylesheet.html    shared CSS
  JavaScript.html    client bootstrap, tab routing, feature modules
```

## A lead is not a customer

A lead is someone a salesperson has approached who has bought nothing yet. Logging one needs
only the company name — no Customer record, because filling the master with companies that
never buy would also drag them into credit and ageing reports where they do not belong. The
Customer record is created automatically on conversion, which is the moment the prospect
becomes real, along with the contact you have been dealing with. An existing customer asking
for another machine can still be linked, which is what the optional customer link is for.

Leads carry requirement lines rather than one type and one number: PMT sell rotary screw and
reciprocating (piston) machines, and a prospect may want both in different quantities. The
types come from the admin-editable `CompressorType` list, so a third one needs no code change.

## Navigation

The two streams are the two front offices (D2) and sit at the same level as each other —
**Compressor Sales** and **Spare Sales** are separate top-level tabs, never inside a shared
"Sales" heading. A stream and a document are different kinds of thing, and listing them
together is what made the earlier grouping read wrong. Quotations span both streams, so they
are their own group.

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
| Opening-balance imports from Tally | Management, ERP Admin |
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
- [x] **Compressor Sales**: prospect-first lead capture with per-type requirement lines
      (screw / piston, quantity, capacity), conversion that creates the customer record at
      the point the prospect becomes real, activity log, site visits, technical requirement
      sheet (gating the quote, FR-009), compressor selection, 7-stage funnel with weighted
      pipeline (FR-011/012/013)
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
- [x] **The printed quotation**: one template serving both streams, built to the shape of the
      client's own compressor offer — letterhead, covering letter, why ELGi, the technical
      specification of each machine, the scope of supply, the price schedule with package
      pricing, the terms and the installation notes. Previewed on screen and saved as a PDF
      to Drive

## Getting PMT's existing data in

PMT run Tally Prime, and most of the master data already lives there. Nobody re-types any of
it: **Settings → Data Import** takes the standard Tally exports for customers, opening stock
and open receivables, and the Catalog screen takes the item masters. Each shows a preview and
writes nothing until confirmed, and each reports a total to reconcile against Tally.

The full cut-over procedure is in [docs/TALLY-CUTOVER.md](docs/TALLY-CUTOVER.md).

Two design points worth keeping:

- **One owner per fact.** Tally owns the ledger, the item masters and the statutory data; the
  ERP owns everything before the invoice — leads, enquiries, quotations, orders, dispatch,
  reservations, collections. Confirmed with the client: PMT do **not** run inventory in Tally,
  so stock on hand is the ERP's, opened once from a count.
- **Opening receivables are not optional.** Without them the credit check waves through orders
  it should stop and the ageing report is empty, which is worse than an ERP that says it has no
  data.

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

## The printed quotation

**One document, two streams.** The client sent two samples that disagreed in places, and told
us to follow the compressor offer where they do. A spares offer is therefore the same document
with the sections that have no content simply left out — there is no second template to drift
out of step with the first.

**Nothing that reads as boilerplate is written in code.** The letterhead comes from the
`CompanyProfile` tab (Settings → Letterhead) and every standing paragraph from `QuoteTemplates`
(Settings → Quotation Text). Terms change more often than software does, so rewording a clause
is an edit on a screen, not a release.

**Package pricing is how their own offers are priced**: every line is listed at full price and
one percentage is struck off the total, with GST either quoted as extra or added in. Those
three fields live on the quotation (Package Discount %, P&F, GST), and the on-screen totals
box shows the same arithmetic as the printed page — including saying "before GST" when the
total genuinely excludes it.

**The preview is the document.** Print / PDF on a quotation renders the real HTML and shows it
in a frame; the PDF converter is handed exactly the same markup. A wrong price is visible
before it reaches the customer, not after.

**Two things to do on first use.**

1. *Scope of supply is not seeded.* Their compressor offer has one and we did not invent its
   wording. Paste it in at Settings → Quotation Text → **+ Add Section** → Scope of supply. A
   line ending in a colon is printed as a heading for the block beneath it. Until it is added,
   the offer prints without that section and the enclosure list on page one says so honestly.
2. *Saving a PDF needs Drive permission.* `generateQuotationPdf` writes into a Drive folder
   named **ERP Quotations**. That is a new OAuth scope, so after deploying this version each
   user is asked to re-authorise once, and the app must be redeployed as a **new version**
   before anyone sees the button at all. The file lands in the Drive of whoever clicked —
   the app never becomes a place documents get stranded.

**The rupee symbol is worth checking on the first PDF.** The preview is rendered by the
browser and is definitely fine; the PDF goes through Apps Script's own HTML-to-PDF converter,
which is a basic renderer. That converter is also why the document is built from plain tables
and rules rather than flexbox — it silently ignores modern layout. If ₹ comes out as a box in
the PDF, say so and it becomes "Rs." in one edit.

## Who a quotation is addressed to

A quotation stores a pointer to the customer, not their name as text. The printed offer builds
its "To" block from that customer's address and contact records, the GSTIN comes from their
master, and conversion to an order, the credit check, the invoice, the ageing and the statement
all find the customer the same way. A quotation raised against a typed-in name would be an
orphan the moment it was won, and would print with an empty address block — so the customer has
to exist first. That threshold is deliberately higher than a lead's, where no record is needed
at all, because a lead is an approach and a quotation is a priced offer carrying a GST number.

Three things follow from that, and each was a rough edge until it wasn't:

- **A draft can be re-addressed.** Picking the wrong name out of three thousand is an ordinary
  slip, and the alternative used to be abandoning the quotation and re-keying every line.
  Changing it moves the contact and the billing address across too, because both belong to the
  customer being left behind — keeping them would print one company's name above another
  company's address. Once approved or submitted the quotation is locked and the picker becomes
  plain text.
- **The GSTIN stays read-only, with a way in.** It is master data; editing it here would either
  quietly not save or silently rewrite the customer's record from a quotation screen. The
  *edit customer* link beside it opens that record, and the quotation refreshes when it closes.
- **A customer can be added without leaving the screen.** The + New button on the start panel
  opens the customer dialog and selects the new record on save. It deliberately stays open
  afterwards, because the offer needs a billing address and a contact and that is the one moment
  someone has both to hand.

## The standard wording is theirs, not a paraphrase of theirs

The seeded sections carry the client's own text word for word — the five-paragraph covering
letter, the three-heading Why ELGi with its bullets beneath each, the ten terms including the
warranty's four lettered sub-clauses and the force majeure clause in full, and both closings
(their letter ends by inviting questions; their terms end by asking for a meeting, and those are
different paragraphs).

An earlier pass had tightened all of that for readability, which was the wrong instinct for a
document whose job is to match what the business already sends: it carried 38% of their text,
and the shortened force majeure had lost the 120-day threshold and the notice period — a
contractual term, summarised away.

Because `installQuoteTemplates_` only ever adds sections that are absent — so that a reworded
clause is never silently reverted by a later setup run — a correction to the standard text
cannot reach a Sheet that has already been set up. **Settings → Quotation Text → Restore
Standard Wording** is the deliberate way to take it. It touches only the sections that ship with
the system, leaves anything the business wrote alone, and says how many it changed.

## Two streams, two price schedules

Their compressor offer and their spares offer schedule prices differently, and each is right
for what it sells. The rule stands that the compressor document wins where they contradict —
letterhead, structure, terms, sign-off are one template — but the price table itself is not a
contradiction, it is two different jobs:

| | Compressor offer | Spares offer |
|---|---|---|
| Columns | Description, Basic price, Qty, Unit, HSN, Tax rate | **Part Number**, Description, Price Per, Quantity, **Total Amount**, HSN |
| Tax | quoted before tax — "18% GST EXTRA" | added in — "Total Tax 18%", "Total Amount" |
| P&F and freight | always stated, even at nil | omitted; carting is a line |
| Machine | — | **FAB No** and **MODEL No** above the table |

A parts list is checked against a machine, so the part number leads and each line carries its
own extended total; following the compressor layout would drop the one column a storeman
actually reads. The wording differences ride on the Labels section, which now merges the
general row with the stream's own — a spares offer states its four different words without
restating the twenty it shares.

**Carting is taxed.** Their spares offer puts it among the parts with no part number and no
rate, and the tax is charged on a base that includes it: ₹2,83,343 × 18% is exactly the
₹51,001.74 they print. So a charge line carries tax like anything else, defaulting to whatever
the goods on the quotation are charged at. **+ Add Charge** on the quotation raises one.

## Three ways out of a quotation

**Print** goes through the browser — quickest route to paper or a local PDF.
**Save PDF to Drive** is the copy that gets sent.
**Save Word to Drive** is the editable one, for when a line has to change before it goes.

The Word copy is not a real .docx — Apps Script cannot produce one without a conversion step
that may or may not be enabled on a given Sheet. It is the HTML that Word has opened natively
for twenty years: it cannot fail to generate, and it opens editable in Word and in Google Docs
alike. Word gets proper page furniture rather than the table frame the browser uses, because
Word repeats a `thead` across pages but has never repeated a `tfoot`, so the letterhead is
declared as an `mso` header and footer attached to a named page section.

The trade is fidelity: Word re-flows the layout its own way rather than reproducing the PDF
pixel for pixel. That is the right trade for a file whose whole purpose is to be changed —
and the PDF remains the thing you send.

Edits made to that copy stay in that copy. The quotation in the system is unchanged, which is
deliberate: a document someone rewrote by hand is not a record of what the system priced.

## The letterhead is a page frame, not a header

Their document does not put the company details at the top of page one — it puts **the two
logos in a running header and the address block in a running footer**, so every page of a
nine-page offer is identifiable on its own. Ours used to insert a letterhead block by hand
wherever the code started a new section, which meant a page produced by text simply overflowing
got nothing: a real offer came out with the signature marooned on a blank second sheet, no
address, no logo, nothing to say who had sent it.

The whole document is now wrapped in one table with a `thead` carrying the logos and a `tfoot`
carrying the address. That is the portable way to say "repeat this on every page" — the renderer
puts it wherever the text actually breaks, rather than where we guessed it would. Verified
across both streams: every page carries the frame.

The signature block is marked `page-break-inside: avoid`, because a signature split across two
sheets reads as a printing fault. When it will not fit, it moves whole to the next page — which
now has a letterhead on it.

## The logo and the seal

There are **three** images, all **uploaded, not linked**. Settings → Letterhead → Images takes a PNG or JPG, shrinks
it in the browser to something a page actually needs (320×160 for the logo, 300×200 for a
seal), and stores the result in the sheet as a data URI.

Storing the bytes rather than a link is the point. A linked image has to be publicly readable
to survive Apps Script's HTML-to-PDF converter, which means either paying to host it or opening
a Drive file to anyone holding the address — and it can break later because somebody moved a
file. An embedded image needs no hosting, no sharing, and cannot rot.

The cost is a ceiling: one spreadsheet cell holds 50,000 characters. The upload resizes to stay
well under it, falls back to JPEG on a white ground if a transparent PNG is still too big, and
the server refuses anything over 48,000 characters with a message saying so — better than a
silent truncation that turns into a broken picture on every future quotation. The URL fields
still exist for anyone who would rather link.

The **manufacturer's logo** prints top-right, opposite ours. For a channel partner that mark is
half the point of the letterhead — their own offers carry ELGi's beside their own on every page
— so it is a field rather than something only a developer can add.

**Tick "the logo already includes the company name"** when the logo is a wordmark. Most are, and
printing the text name underneath one says the name twice, which reads as a mistake. With it
ticked the letterhead keeps the partner line, address, contacts and GST number and lets the logo
carry the name.

## Setting this up for a different client

The system was written for one company, but nothing about that company is welded into the
code. Everything a second client would need to change is a field on a screen, and this is the
list — in the order you would work through it.

**Settings → Letterhead** holds the seller and how the application presents itself:

| What | Field |
|---|---|
| Name, address, GSTIN, PAN, phone, email, website | the obvious ones |
| The line above the name on the letterhead | Partner Line |
| Logo printed at the top | Images → Logo (upload) |
| Seal printed above the signature | Images → Company Seal — blank means no seal is printed |
| The number under the signature | Sign-off Phone (separate from the letterhead number) |
| "Dear Sir/Madam," and "Yours sincerely," | Salutation, Sign-off Line |
| The make this house sells | Default Brand — drives quotation numbering and every new record |
| Quotation numbering | Quotation Prefix |
| What the header, footer and browser tab say | Application Name, Application Subtitle |

**Settings → Quotation Text** holds every word the document says that isn't a price:

- **Cover letter, Why <brand>, Scope of supply, Terms, Installation guidelines** — the prose.
- **Document title** — the heading and the line beneath it, per stream.
- **Closing** — the paragraph before the signature.
- **Spec note** — the italic line above the specification table.
- **Labels** — every short phrase on the page, one `key = value` per line: `refNo = Ref No.`,
  `packageTotal = Total package price`, `colBasicPrice = Basic price`, and so on. A key you
  leave out falls back to the English default, so you only override what you want to change.

That combination is enough to turn the same code into a different company's document — a
different letterhead, brand, numbering, vocabulary and seal — with no release. It is worth
doing once as a test before promising it to anyone.

**The two things that are still this client's, and what they cost to change:**

1. **The seeded quotation text is ELGi's**, taken word for word from their own offers. A new
   installation starts with it and edits or replaces the nine sections in Settings. That is a
   morning's typing, not a code change, but it is not automatic.
2. **The two price levels are named `PIE` and `ELGI`** — Premier India's buying price and its
   selling price. They are internal, never printed on anything a customer sees, but they are
   this client's initials sitting in a column of the PriceList tab. Renaming them to something
   neutral like `Cost` and `Selling` is a small migration, and it would also change the
   `piePrice` / `elgiPrice` column names on the catalog import file — which is why it hasn't
   been done unasked.
