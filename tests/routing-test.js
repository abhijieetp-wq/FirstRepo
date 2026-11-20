/**
 * The screens' addresses: the browser's list and the server's list are the same list, and the
 * server answers exactly those.
 *
 * The browser writes /sales-orders into the address bar; the server has to serve the portal
 * when somebody refreshes on it. If the two lists drift, a screen opens fine by clicking and
 * then 404s on refresh — a bug nobody sees until a customer's quotation link is opened from an
 * email. So they are compared here, both ways.
 *
 *   node tests/routing-test.js
 */
const fs = require('fs');
const path = require('path');
const { PAGES, WITH_ID, isPagePath } = require(path.join(__dirname, '..', 'server', 'routes.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

const client = fs.readFileSync(path.join(__dirname, '..', 'src', 'JavaScript.html'), 'utf8');
const block = /var ROUTES = (\{[\s\S]*?\});/.exec(client);
if (!block) { console.log('CRASHED: no ROUTES in src/JavaScript.html'); process.exit(1); }
// eslint-disable-next-line no-new-func
const ROUTES = new Function('return ' + block[1])();
const navViews = [];
const nav = /var NAV = \[([\s\S]*?)\n {2}\];/.exec(client);
(nav ? nav[1] : '').replace(/view: "([a-z]+)"/g, (_, v) => { navViews.push(v); return _; });

console.log('THE BROWSER AND THE SERVER KNOW THE SAME ADDRESSES');
const clientPaths = Object.keys(ROUTES).map((k) => ROUTES[k]).sort();
ok('every address the browser writes, the server serves',
  clientPaths.every((p) => PAGES.indexOf(p) !== -1), clientPaths.filter((p) => PAGES.indexOf(p) === -1));
ok('and the server serves none the browser does not write',
  PAGES.every((p) => clientPaths.indexOf(p) !== -1), PAGES.filter((p) => clientPaths.indexOf(p) === -1));
ok('every screen on the menu has an address', navViews.length > 10 &&
  navViews.every((v) => ROUTES[v]), navViews.filter((v) => !ROUTES[v]));
ok('no two screens share one', new Set(clientPaths).size === clientPaths.length);
ok('the screens that carry a record are screens', WITH_ID.every((p) => PAGES.indexOf(p) !== -1));
ok('and the browser reads the same two: a quotation and its progress', /\(quotation\|quotation-progress\)/.test(client) && WITH_ID.length === 2);

console.log('\nTHE TENDER DESK IS A PAGE OF ITS OWN');
const { isTenderDeskPath } = require(path.join(__dirname, '..', 'server', 'routes.js'));
ok('its screens and records are its addresses', ['/tender-desk', '/tender-desk/', '/tender-desk/shortlisting', '/tender-desk/tenders', '/tender-desk/tenders/TN-ab12',
  '/tender-desk/po', '/tender-desk/po/TPO-9', '/tender-desk/tasks', '/tender-desk/masters'].every(isTenderDeskPath));
ok('and nothing else is', !['/tender-desk/tasks/x', '/tender-desk/../etc', '/tender-deskx', '/tenders', '/tender/TN-1'].some(isTenderDeskPath));
ok('none of them is the portal\'s page', !isPagePath('/tender-desk') && !isPagePath('/tenders'));
// The page is a file of its own, so the image has to carry it: the Dockerfile copies only the
// folders it names, and the first deploy without this line answered "not installed".
const docker = require('fs').readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
ok('the deployed image carries the Tender Desk\'s page', /^COPY tender\/ \.\/tender\/$/m.test(docker) &&
  !/^tender\/?$/m.test(require('fs').readFileSync(path.join(__dirname, '..', '.dockerignore'), 'utf8')));

console.log('\nTHE SERVER ANSWERS THOSE, AND NOTHING ELSE');
for (const p of ['/', '/index.html', '/quotations', '/quotations/', '/sales-orders',
  '/reports/leads-by-engineer', '/quotation', '/quotation/QT-1a2b3c4d',
  '/quotation-progress/QT-9', '/settings']) {
  ok(p + ' is a screen', isPagePath(p) === true);
}
for (const p of ['/nope', '/wp-admin', '/quotations/QT-1', '/reports', '/reports/other',
  '/quotation/../../etc/passwd', '/quotation/a/b', '/quotation/' + 'x'.repeat(65),
  '/api/call', '/health', '/files/abc', '/QUOTATIONS']) {
  ok(p + ' is not', isPagePath(p) === false);
}

console.log('\n' + (failures.length
  ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
  : 'all ' + pass + ' passed'));
process.exit(failures.length ? 1 : 0);
