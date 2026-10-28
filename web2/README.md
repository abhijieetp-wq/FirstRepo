# ERP 2.0

ERP 2.0 is a third face of the same portal, built screen by screen over ERP 1:

| face | files |
|---|---|
| **2.0** (`v2`) | `web/Stylesheet.html` + **`web2/Theme.html`**, `src/JavaScript.html`, `web/Shell.html` + **`web2/Shell.html`** |
| new design (`web`, the default) | `web/Stylesheet.html`, `src/JavaScript.html`, `web/Shell.html` |
| classic | `src/` only — what Apps Script serves |

Same markup, same behaviour, same server. Every screen, rule, permission, bulk import and
printed or e-mailed quotation is ERP 1's own; 2.0 changes how it looks and, screen by screen
from here, how it is laid out. Nothing in `web2/` can reach Apps Script (`clasp` pushes `src/`).

## Switching it on

- **One browser:** add `?look=2` to any address. That browser keeps 2.0 until `?look=web`
  (back to the new design) or `?look=default` (whatever the server serves everyone). Nobody
  else's screen changes. The menu has a "Back to the current look" link at its foot.
- **Everyone:** `ERP_UI=v2`. Unset it to go back. No deployment of code either way.

## What is in each file

**`Theme.html`** — ERP 2's look as tokens over the new design's: the green rail, the lime
accent, greenish neutrals, Archivo and IBM Plex Sans (self-hosted, `assets/fonts/`), flatter
corners. A handful of rules re-colour the places `web/Stylesheet.html` wrote a colour out in
full. The nineteen custom-property names `JavaScript.html` reads keep their names.

**`Shell.html`** — runs after `web/Shell.html`, through the DOM only, like it. Today: names the
Service Due Calls screen **SDR** (menu, heading, breadcrumb, browser tab, command palette),
marks the app's name "2.0", and adds the way back.

**`src/JavaScript.html`, behind `FACE_V2`** — the few ways of working only 2.0 has, where
going through the DOM alone would not do. The server marks the page `<html data-face="v2">`
(`server/page.js`); Apps Script and the other faces carry no such mark and keep ERP 1's screen.
Today:

- **SDR rows worked in place.** Each open call's row has *What they said* (picking an answer
  logs the call, dated today unless it was already logged), a *Remark* (kept on its own, before
  or after the call) and *Quote…* with what the quotation is for: **Spares, AMC renewal or
  Service**. The call window asks the same. A closed call, or a user who may only look, sees
  text.
- **The enquiry form asks what the quotation will be for**, the same three.
- **The enquiry board** (`src/EnquiryBoard.gs`). Spare Sales and Compressor Sales open on ERP 2's
  ten stages — Enquiry received, Requirement understood, Quotation prepared, Quotation sent,
  In negotiation, Approved by customer, PO received, Sales order (WON), Material procurement,
  Dispatched — plus Rejected / Lost with its reason. A Board / List switch (Spare Sales) or a
  Board tab (Compressor Sales) brings ERP 1's lists back; each browser remembers its choice.
  - Every stage is read off ERP 1's own records: the enquiry or lead, its newest live
    quotation, the order that quotation became (credit hold → PO received; credit check passed →
    Sales order; material short or reserved → Material procurement), and the dispatch.
  - Three stages are set by hand, from the card, and each writes a field ERP 1 already has:
    Enquiry received ⇄ Requirement understood is the enquiry's status (New / Identifying) or the
    lead's (New / Qualified); In negotiation is the quotation's status Negotiating, which ERP 1
    shows as Sent, and needs a note on what is being discussed (kept against the quotation).
  - Cards: spare enquiries, leads, opportunities without a lead, and quotations raised with no
    enquiry behind them. Dispatched and closed cards stay for 90 days.
  - Management and ERP Admin can rename the stages (both desks; stored in ConfigLists as
    `BoardStage`). Stages cannot be added.
- **A dashboard per person** (`src/PersonDashboard.gs`). 2.0 opens everybody on the
  Dashboard, which starts with their own desk; ERP 1's control tower — the nine checks and the
  charts — is unchanged under it.
  - Sales Coordinator: open enquiries (their cards on the board), follow-ups due, offers
    waiting for the customer's answer, drafts to approve for customers they look after, their
    orders this month, SDR calls to make.
  - Sales Engineer: leads they found, follow-ups due, offers out, won this month.
  - Service Coordinator: open jobs, jobs to assign, visits today and tomorrow, breakdowns.
  - Service Engineer: visits today and tomorrow, open jobs, enquiries and leads they raised
    — counts only, no money, as everywhere for service.
  - Management and ERP Admin: the team, one row a person; a name, or the "Dashboard of" list,
    opens that person's desk exactly as they see it.
  - Every figure and line opens the ERP 1 screen or record it is about.

The type is stored on the spare enquiry (`enquiryType`). On the printed offer an AMC renewal or
a service takes its own heading and subject — rows with *Applies to* `AMC` or `SERVICE` in
Settings → Quotation text, default wording PIE can change there — and everything else is the
spares offer's, as before. An enquiry with no type reads as Spares.

## The rule for each screen that moves to 2.0

A screen takes ERP 2's layout only when it keeps everything ERP 1's version of it does — the
ERP 1 column of the gap audit is the checklist. The quotation that is printed or sent stays
`QuotationDocument.gs`'s, unchanged.

## Tests

- `tests/v2-ui-test.js` — what 2.0 adds, and that the bulk imports and every screen survive it.
- `tests/sdr-rows-ui-test.js` — the SDR rows on 2.0, and ERP 1's row unchanged on the others.
- `tests/enquiry-board-ui-test.js`, `tests/enquiry-board-sql-test.js` — the board on 2.0 (and
  the lists unchanged on the others), and every stage read correctly from the records.
- `tests/person-dashboard-ui-test.js`, `tests/person-dashboard-sql-test.js` — each position's
  desk, Management's team and view of anybody's, and ERP 1's Dashboard unchanged elsewhere.
- `tests/service-due-sql-test.js`, `tests/offer-kind-sql-test.js` — the remark, the type, and
  the AMC renewal and service headings on the printed offer.
- `tests/run.sh` runs every screen suite against the 2.0 face as well as the other two.
- `tests/server-test.js` — `ERP_UI=v2`, `?look=`, and the cookie.
