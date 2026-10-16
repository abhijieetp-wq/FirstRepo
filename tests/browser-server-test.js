/**
 * A real browser, the real server, the real portal. Signing in and using it.
 *
 * Everything else has tested one side or the other. This is the first thing that loads the
 * page Chromium would load, types a password into it, and checks that a screen appears with
 * PIE's data on it — which is the only question that matters now and the only one none of
 * the other tests asks.
 *
 * It is also the only check that the transport swap actually worked. `runner` was rewritten
 * to send a fetch where it used to call google.script.run, and nothing but a browser can
 * tell whether the 177 call sites above it still behave: they were never touched, so if the
 * shape is a millimetre off, every screen is blank and every unit test still passes.
 *
 *   DATABASE_URL=postgres://... node tests/browser-server-test.js
 */
const path = require('path');

const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.log('no DATABASE_URL — skipping'); process.exit(0); }

let chromium;
try {
  ({ chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright')));
} catch (err) {
  console.log('playwright missing — PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright');
  process.exit(0);
}

const { connect } = require(path.join(__dirname, '..', 'server', 'db.js'));
const { loadPortal } = require(path.join(__dirname, '..', 'server', 'load.js'));
const { build } = require(path.join(__dirname, '..', 'server', 'index.js'));

const TENANT = 'browser-test';
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

(async () => {
  const db = connect({ connectionString: URL_, tenant: TENANT });
  const tables = ['users', 'sessions', 'company_profile', 'spares', 'price_list',
    'quotations', 'quotation_items', 'customers', 'audit_log', 'config_lists'];
  for (const t of tables) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);

  await db.appendRow('CompanyProfile', { id: 'CO-1', appName: 'Premier India Enterprise',
    appSubtitle: 'ELGi channel partner' });
  await db.appendRow('Customers', { id: 'CUS-1', customerCode: 'C0001',
    name: 'Bharat Forge Ltd', active: 'TRUE' });
  for (let i = 1; i <= 40; i++) {
    await db.appendRow('Spares', { id: 'SP-' + i, partNo: 'ELG-' + (100000 + i),
      description: 'Separator element ' + i, productGroup: 'Separators', uom: 'Nos',
      gstPct: 18, active: 'TRUE', brand: 'ELGI' });
    await db.appendRow('PriceList', { id: 'PRC-' + i, itemType: 'Spare', itemId: 'SP-' + i,
      itemCode: 'ELG-' + (100000 + i), priceLevel: 'ELGI', price: 1200 + i * 25,
      currency: 'INR', effectiveFrom: '2026-01-01', active: 'TRUE' });
  }
  await db.appendRow('Quotations', { id: 'QT-1', quoteNo: 'PIE/ELGI/QUOT/26-27/401',
    revision: 'R0', date: '2026-10-01', customerId: 'CUS-1', businessStream: 'Spare Sales',
    status: 'Sent', grand: 48500, subtotal: 41101, taxAmt: 7399, locked: 'TRUE',
    preparedBy: 'boss@pie.in' });
  await db.appendRow('Users', { id: 'USR-1', username: 'boss', email: 'boss@pie.in',
    name: 'Abhijeet Paunikar', role: 'ERP Admin', businessStream: 'All', active: 'TRUE' });

  const setup = loadPortal(db, 'setup', { quiet: true });
  setup.CURRENT_USER_ = { email: 'setup@pie.in', role: 'ERP Admin' };
  const password = (/boss\s+(\S+)/.exec(String(await setup.createSignInPasswords())) || [])[1];
  // createSignInPasswords marks the password as one an admin set, and the portal rightly
  // puts a "choose your own" screen in front of everything until it is changed. Correct
  // behaviour, and not what this test is about — it needs to reach the real screens.
  await db.updateRowById('Users', 'id', 'USR-1', { mustChangePassword: 'FALSE' },
    'so the test reaches the portal rather than the password screen');

  const server = build({ db, tenant: TENANT });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  const external = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  // Anything the page fetches from somewhere that is not this server. Recorded rather than
  // ignored: a portal that reaches out to a third party on every load is a fact worth
  // knowing, and in this container those requests fail at the proxy, which would otherwise
  // look like a script error.
  page.on('requestfailed', (r) => {
    if (r.url().indexOf(base) !== 0) external.push(r.url());
  });
  const ours = () => errors.filter((e) =>
    !/ERR_CERT_AUTHORITY_INVALID|ERR_PROXY|net::ERR_/.test(e));

  console.log('THE PAGE LOADS IN A BROWSER');
  await page.goto(base, { waitUntil: 'networkidle' });
  ok('with no script errors of our own', ours().length === 0, ours().slice(0, 3));
  ok('and it knows it is not on Apps Script',
    (await page.evaluate(() => window.ON_APPS_SCRIPT)) !== true);

  console.log('\nAND THE SIGN-IN SCREEN APPEARS');
  await page.waitForSelector('#signin-screen', { state: 'visible', timeout: 10000 });
  ok('the sign-in screen is shown', await page.isVisible('#signin-screen'));
  ok('and the loading screen is not', !(await page.isVisible('#boot-screen')));

  console.log('\nAND A WRONG PASSWORD IS REFUSED, IN WORDS');
  await page.fill('#signin-email', 'boss');
  await page.fill('#signin-password', 'not the password');
  await page.click('#btn-signin');
  await page.waitForFunction(
    () => /do not match/.test(document.body.innerText), null, { timeout: 10000 });
  ok('it says so', /do not match/.test(await page.innerText('body')));
  ok('and stays on the sign-in screen', await page.isVisible('#signin-screen'));
  ok('and the button is usable again', !(await page.isDisabled('#btn-signin')));
  // That attempt logged a 401, which is the server behaving correctly. Cleared here, next
  // to the thing that caused it, so everything after is judged on its own.
  errors.length = 0;

  console.log('\nAND THE RIGHT ONE GETS IN');
  await page.fill('#signin-password', password);
  await page.click('#btn-signin');
  await page.waitForSelector('#signin-screen', { state: 'hidden', timeout: 15000 });
  await page.waitForFunction(
    () => /Abhijeet Paunikar/.test(document.body.innerText), null, { timeout: 15000 });
  ok('the portal opens', !(await page.isVisible('#signin-screen')));
  ok('and knows who signed in', /Abhijeet Paunikar/.test(await page.innerText('body')));
  ok('and what the company is called',
    /Premier India Enterprise/.test(await page.innerText('body')));
  ok('with no script errors of our own on the way', ours().length === 0, ours().slice(0, 3));

  console.log('\nAND THE SCREEN IT LANDS ON IS THE DASHBOARD');
  ok('the Control Tower is up', /Control Tower/.test(await page.innerText('body')));
  ok('with the navigation beside it', /Quotations/.test(await page.innerText('body')));

  console.log('\nAND PIE\u2019S OWN DATA IS ON THE SCREEN');
  // Not a fixture rendered by the client: this came out of Postgres, through the converted
  // modules, over the new transport, into the DOM. Navigating there is the point \u2014 it is
  // a second round trip through the swapped transport, after the one that signed in.
  // The button lives inside a collapsed dropdown, so it is clicked directly rather than
  // after opening the menu. What is being tested is that the nav handler reaches the server
  // through the swapped transport and renders what comes back — not the dropdown's CSS,
  // which the existing portal-ui-test already covers.
  await page.$eval('[data-view="quotations"]', (el) => el.click());
  await page.waitForFunction(
    () => /PIE\/ELGI\/QUOT/.test(document.body.innerText), null, { timeout: 15000 });
  const text = await page.innerText('body');
  ok('a real quotation number is shown', /PIE\/ELGI\/QUOT\/26-27\/401/.test(text));
  ok('and the customer on it', /Bharat Forge/.test(text), text.slice(0, 300));

  console.log('\nAND EVERY ONE OF THOSE WENT THROUGH THE NEW TRANSPORT');
  // Nothing here pokes at `srv` directly: it lives inside the file's own closure, as it
  // should, and reaching into it would be testing a thing the browser cannot do either.
  // The proof is already on the screen — the dashboard and the quotations list are both
  // rendered from data that `srv` fetched. What this adds is the count, so a screen that
  // silently rendered from a cache could not pass.
  const calls = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((r) => /\/api\/call$/.test(r.name)).length);
  ok('several calls reached /api/call', calls >= 2, calls);
  const logins = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((r) => /\/api\/login$/.test(r.name)).length);
  ok('and the two sign-in attempts went to /api/login', logins === 2, logins);
  ok('and no script errors doing any of it', ours().length === 0, ours().slice(0, 3));

  console.log('\nAND IT FETCHES NOTHING FROM ANYWHERE ELSE');
  // It used to fetch three font families from fonts.googleapis.com on every load, which is
  // a third party on the critical path of a self-hosted business system. They are served
  // from this origin now. The stylesheet still names Google's copy as a second source for
  // the Apps Script portal, which cannot serve a file — so this asserts the first source is
  // the one actually used, which a check of the stylesheet's text could not tell you.
  const hosts = [...new Set(external.map((u) => { try { return new URL(u).host; }
    catch (e) { return u; } }))];
  if (hosts.length) console.log('  the page reaches out to: ' + hosts.join(', '));
  ok('the page leaves its own origin for nothing at all', hosts.length === 0, hosts);

  // And the type really arrived, rather than the browser quietly falling back to a system
  // font that answers to the same name in a font-family list. This is the one check that
  // ties the file names in the stylesheet to the files on disk; rename one without the
  // other and everything else still passes.
  const faces = await page.evaluate(() => ({
    inter: document.fonts.check('600 14px Inter'),
    plex: document.fonts.check('400 13px \"IBM Plex Mono\"')
  }));
  ok('Inter is loaded, not substituted', faces.inter === true, faces);
  ok('and so is IBM Plex Mono', faces.plex === true, faces);
  const served = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((r) => /\.woff2$/.test(r.name)).map((r) => r.name.replace(/.*\//, '')));
  ok('all three faces came from here', served.length === 3, served);

  console.log('\nAND MOVING AROUND IT STILL CALLS THE SERVER');
  const before = (await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((r) => /\/api\//.test(r.name)).length));
  ok('the browser has been talking to /api/', before > 0, before);

  await new Promise((r) => server.close(r));
  await browser.close();
  for (const t of tables) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  await db.pool.end();

  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.log('CRASHED: ' + e.message);
  console.log(e.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
