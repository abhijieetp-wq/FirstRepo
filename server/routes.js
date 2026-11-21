/**
 * The addresses the portal's screens live at.
 *
 * Every screen has its own address now — /quotations, /sales-orders — so the browser's Back
 * button, a refresh and a bookmark all land on the screen somebody was looking at, instead of
 * on the first screen of the portal. The browser moves between them without reloading (see
 * ROUTES in src/JavaScript.html); this list is what the server answers when one of them is
 * typed in, refreshed or opened from a link: the same page, which then opens that screen.
 *
 * A list rather than "anything that is not /api": an address nobody defined is a 404, the way
 * it was before, not the sign-in page under a made-up name.
 *
 * Kept in step with ROUTES in src/JavaScript.html by tests/routing-test.js.
 */
'use strict';

/** One per screen. The browser's list maps each to the screen's internal name. */
const PAGES = [
  '/dashboard',
  '/tasks',
  '/escalations',
  '/compressor-sales',
  '/spare-sales',
  '/service-due-calls',
  '/visit-plans',
  '/quotation',
  '/quotations',
  '/quotation-progress',
  '/reports/leads-by-engineer',
  '/reports/service-engineers',
  '/sales-orders',
  '/dispatch-billing',
  '/service-jobs',
  '/amc',
  '/next-day-plan',
  '/collections',
  '/inventory',
  '/customers',
  '/catalog',
  '/form-fields',
  '/settings'
];

/** Screens that show one record, whose address can carry which: /quotation/QT-123. */
const WITH_ID = ['/quotation', '/quotation-progress'];

/** Whether this address is one of the portal's screens, and so gets the portal's page. */
function isPagePath(pathname) {
  const p = String(pathname || '');
  if (p === '/' || p === '/index.html') return true;
  const clean = p.replace(/\/+$/, '');
  if (PAGES.indexOf(clean) !== -1) return true;
  const m = /^(\/[a-z-]+)\/([A-Za-z0-9_-]{1,64})$/.exec(clean);
  return !!(m && WITH_ID.indexOf(m[1]) !== -1);
}

/**
 * The Tender Desk's addresses: a page of its own (tender/TenderDesk.html), not the portal's.
 * /tender-desk, and its screens below it — a tender or a PO by its id.
 */
function isTenderDeskPath(pathname) {
  const p = String(pathname || '').replace(/\/+$/, '');
  return /^\/tender-desk(\/(shortlisting|approvals|tenders|po|tasks|masters)(\/[A-Za-z0-9_-]{1,64})?)?$/.test(p) &&
    !/^\/tender-desk\/(shortlisting|approvals|tasks|masters)\//.test(p);
}

/**
 * Where an address on the host's own domain should send somebody, or null to serve it.
 *
 * The portal moved from the hosting service's *.up.railway.app address to a domain of its own.
 * ERP_BASE_URL names that domain (https://...), and nothing else is configured: no domain is
 * written here. A page, a Tender Desk page or a file link opened on the old address goes to the
 * same path and query there. Calls a page makes in the background (/api/..., its scripts and
 * typefaces) are left alone, so a tab that was open across the move goes on working until it is
 * reloaded, and a POST is never turned into anything else.
 *
 * Only *.up.railway.app is moved: localhost, the host's health check and the new domain itself
 * never are, and without an https ERP_BASE_URL nothing is.
 */
function canonicalRedirect(method, host, pathname, search, baseUrl) {
  if (method !== 'GET' && method !== 'HEAD') return null;
  let base;
  try { base = new URL(String(baseUrl || '')); } catch (e) { return null; }
  if (base.protocol !== 'https:' || /\.up\.railway\.app$/i.test(base.hostname)) return null;
  const h = String(host || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
  if (!/\.up\.railway\.app$/.test(h) || h === base.hostname.toLowerCase()) return null;
  const p = String(pathname || '');
  if (!(isPagePath(p) || isTenderDeskPath(p) || /^\/files\/[^/]+$/.test(p))) return null;
  return base.origin + p + String(search || '');
}

module.exports = { PAGES, WITH_ID, isPagePath, isTenderDeskPath, canonicalRedirect };
