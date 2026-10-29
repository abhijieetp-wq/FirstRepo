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

module.exports = { PAGES, WITH_ID, isPagePath };
