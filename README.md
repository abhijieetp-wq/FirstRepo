# ELGI Spares ERP

Internal ERP for the ELGI Spares Sales department. Google Apps Script Web App bound to a
Google Sheet — no separate database or hosting. See `ELGI-Spares-ERP-Handoff-Brief-v2.md`
(shared separately) for the full spec. This build covers **Phase 1** only.

## Architecture

- The Sheet is the database. Every tab is a table; row 1 is the header row.
- `Session.getActiveUser().getEmail()` identifies the caller — the `Users` tab is the
  authorization list (email → name/role/active).
- The frontend (`src/Index.html` + `src/JavaScript.html`) talks to the backend `.gs` files
  only through `google.script.run` — there is no REST API.

## One-time manual setup (you)

1. **Create the Google Sheet** with these tabs (Phase 1 scope — headers exactly as listed,
   row 1). Leave them empty except `Users`:

   - `Users`: `email, name, role, department, active` — pre-fill with real coordinator/
     warehouse/manager emails, their `role` as exactly `Coordinator`, `Warehouse`, `Manager`,
     or `Admin`, `department` as `Spares Sales` (blank/ignored for `Admin` rows), and
     `active` = `TRUE`.
   - `Departments` *(new)*: `id, name, active` — seed with exactly one row: a `Spares Sales`
     department, active = `TRUE`.
   - `Customers`: `id, name, location, contactPerson, phone, email, category, lastOrderDate, notes, billingAddress, creditLimit`
     — **deliberately no `department` column**, a customer can span multiple departments.
   - `Enquiries`: `id, enquiryNo, date, customerName, machine, requirement, owner, status, nextActionDate, source, lostReasonId, department`
   - `LostReasons`: `id, reasonText, active`
   - `Parts`: `id, partNo, description, category, unit, listRate, specialRate, altPartNo, altDescription, altRate, systemStock`
   - `Units` *(separate machine/model catalog, distinct from Parts)*: `id, modelCode, modelName, category, hpRating, workingPressure, fad, listRate, specialRate, leadTimeDays, warrantyPeriod, notes`
   - `Quotations`: `id, quoteNo, date, customer, machine, location, contact, preparedBy, validity, gstPct, subtotal, discountAmt, gstAmt, grand, status, enquiryId, department`
   - `QuotationItems`: `id, quotationId, partNo, description, rateType, rate, discount, qty, lineTotal`
   - `Orders`: `id, orderNo, quotationId, quoteNo, customer, grand, poNo, poDate, dispatchStatus, dispatchDate, paymentStatus, received, dueDate, creditOverrideBy, creditOverrideReason, creditOverrideDate, department`

   Every `department` column defaults to `Spares Sales` for now — it's the only department
   that exists. Parts/Units catalogs deliberately have no `department` column; whether
   catalogs become department-owned later is an open question, not built yet.

2. **Extensions → Apps Script** from that Sheet. This creates the bound script project.
3. In the Apps Script editor: gear icon (Project Settings) → copy the **Script ID** → send
   it over.
4. On your machine:
   ```
   npm install -g @google/clasp
   clasp login
   ```
   `clasp login` opens a browser OAuth flow against your Google account — this has to run
   on your machine, not in this sandbox.
5. Once code has been pushed to this repo's branch:
   ```
   git pull
   cp .clasp.json.example .clasp.json   # then paste your real Script ID into it
   clasp push
   ```
6. In the Apps Script editor: **Deploy → New deployment → Web app**.
   - Execute as: **User accessing the web app**
   - Who has access: **Anyone within [your domain]**
7. For later updates, use **Manage deployments → Edit → New version** so the web app URL
   stays the same.

## Repo layout

```
src/
  appsscript.json     Apps Script manifest (execution/access settings)
  Code.gs             doGet() entry point, include() helper, bootstrap()
  Auth.gs             current-user lookup against the Users tab, role checks
  SheetService.gs      generic read/append/update/delete helpers keyed off tab headers
  Parts.gs            Parts (spares) catalog CRUD — read: everyone, write: Manager-only
  Units.gs            Units (machines) catalog CRUD — read: everyone, write: Manager-only
  Index.html          page shell, tab navigation, catalog view + add/edit modals
  Stylesheet.html      shared CSS (design reused from the reference prototype)
  JavaScript.html      client bootstrap, tab switching, catalog module
```

Feature modules (Customers, Enquiries, Quotations, Orders, Dashboard) are added
incrementally as `<Module>.gs` on the server side and new sections of `Index.html` /
`JavaScript.html` on the client side, per the brief's Phase 1 build order.

## Permissions note

Write access to both the **Parts** and **Units** catalogs (individual add/edit/delete) is
**Manager-only, no exception**. Coordinator and Warehouse get read-only access (including
physical stock counts). This is enforced server-side in `Parts.gs`/`Units.gs` via
`requireRole_`, not just hidden in the UI. **Bulk CSV upload does not live in the Catalog
module at all** — per `ELGI-Settings-Page-Spec.md` it lives under Settings → Master Upload,
Admin-only, built as its own separate task.

## Roles & departments

Four roles: `Coordinator`, `Warehouse`, `Manager`, `Admin`. `Admin` is new — not a rename of
`Manager` — and is cross-department (ignores the `department` field entirely). `Manager` is
scoped to their own `department`: their "All Records" view, Dashboard, and Indent approvals
are meant to only show records whose `department` matches their own (not built into any view
yet since there's only one department — this scoping gets wired in as each of those views is
built, per the brief, so no migration is needed later). A full Settings page (brand
configuration tiles + Admin-only user/role/department management) is specified separately in
`ELGI-Settings-Page-Spec.md` and is its own future task, not part of Phase 1's core build
order.

## Build status

- [x] Users/roles + Workspace SSO shell (now recognizes 4 roles + department)
- [x] Parts + Units Catalog CRUD (Manager-only write) + rate comparison
- [ ] Customers CRUD
- [ ] Enquiries CRUD
- [ ] Quotation builder (with Add Spare Part / Add Unit toggle) + history + Lost Reasons dropdown
- [ ] Orders (dispatch/payment tracking)
- [ ] Credit control on dispatch (department-scoped "All Records" for Manager)
- [ ] Dashboard (department-scoped for Manager, cross-department for Admin)
- [ ] Settings page (brand tiles + Admin Controls: Master Upload, User Management, Role Assignment, Manager Settings) — separate task per `ELGI-Settings-Page-Spec.md`
