# Locked Decisions

Decisions confirmed with the client. Changing any of these is a scope change, not a
detail — update this file and say so explicitly rather than drifting.

**Authoritative spec**: `ELGI_PMT_ERP_Detailed_Blueprint.xlsx` (14 sheets). It supersedes
`ELGI-Spares-ERP-Handoff-Brief-v2.md` and `ELGI-Settings-Page-Spec.md` on scope, data model,
roles and process. Those two remain authoritative only for UX patterns already locked in:
rate-comparison chips, bulk-upload preview-before-commit, soft-delete on users, Workspace SSO.

---

## D1 — Platform: Google Sheets now, with a documented exit path

Stay on Apps Script + Google Sheets for Phase 1. Accept the known ceiling, but design so the
move to a real database is a swap of one layer rather than a rewrite. See
`docs/ARCHITECTURE.md` for the design rules this obliges us to follow and the migration
trigger signals.

## D2 — Both business streams are in scope

Compressor Sales **and** Spare Parts Sales. The earlier briefs covered spares only; the
blueprint's compressor front office (leads, site visits, technical requirement, compressor
selection, opportunity funnel) is roughly 40% of Phase 1 and is ours to build.

Quotations, Sales Orders, credit control, inventory, dispatch, billing and collections are
**shared** across both streams — one backbone, two front offices. Transactions carry a
`businessStream` field (`Compressor` / `Spare`).

## D3 — Tally integration is in scope (TallyPrime, server-hosted)

TallyPrime running on a server, used across PMT. Phase 1 requires both directions:
ERP → Tally (sales invoices, I01/FR-050) and Tally → ERP (customer ledger, receipts,
outstanding — I02/FR-055).

**Open technical question**: Apps Script executes on Google's infrastructure, so it reaches
Tally *from the public internet*, not from PMT's LAN. TallyPrime's XML/HTTP interface
(default port 9000) is usually LAN-only. Confirm with whoever administers the Tally server
whether it is reachable externally. If not, the fallback is a small bridge/relay running on a
machine inside PMT's network. Do not design the sync as a direct `UrlFetchApp` call until
this is confirmed.

## D4 — Five roles

`Sales Coordinator`, `Sales Engineer`, `ERP Admin`, `Management`, `Service Engineer`.

This collapses the blueprint's 11-role table (Roles & Access sheet). The blueprint's
Purchase / Stores / Dispatch / Billing / Collection roles are **not** separate users here.

**Working assumption pending confirmation**: Sales Coordinator performs stores, dispatch,
billing and collection operations; Management approves exceptions (discount, credit, dispatch
deviation); ERP Admin has full access plus configuration. FR-062 still applies — permissions
are per-module view/create/edit/approve, and cost/margin fields stay restricted.

**Migration note**: the previous role set (`Coordinator`, `Warehouse`, `Manager`, `Admin`)
is retired. Existing `Users` rows must be remapped — `Manager` → `Management`,
`Coordinator` → `Sales Coordinator`, `Admin` → `ERP Admin`, `Warehouse` → `Sales Coordinator`
unless the client says otherwise.

## D5 — Settings page stays, and brands are a real future axis

The Settings page spec (ELGI / Cumi / Champion brand tiles + Admin Controls) still stands.
The blueprint covers **ELGI only** — it is the first of several brands. Cumi, Champion and
others follow the same pattern once ELGI is live.

Implication: brand is not merely cosmetic. It will eventually need to be a real field on
customers, products/spares, quotations and orders. Phase 1 does not build brand-based data
separation, but **new tables should carry a `brand` column defaulting to `ELGI`** so the
second brand does not force a migration — same reasoning that put `businessStream` on
transactions.
