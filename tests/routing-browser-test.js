/**
 * Every screen at its own address, in a real browser against the real server.
 *
 * What a person does with an address bar: types one in before signing in, presses Back and
 * Forward, refreshes, opens a quotation from a link, signs out. Each of those used to throw
 * them back to the first screen of the portal, or out of it. This checks each lands where the
 * address says — and where the address says somewhere they may not go, that it does not.
 *
 *   DATABASE_URL=postgres://... node tests/routing-browser-test.js
 */
const path = require('path');

const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.log('no DATABASE_URL — skipping'); process.exit(0); }

let chromium;
try {
  ({ chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright')));
} catch (err) {
  console.log('playwright missing — skipping');
  process.exit(0);
}

const { connect } = require(path.join(__dirname, '..', 'server', 'db.js'));
const { loadPortal } = require(path.join(__dirname, '..', 'server', 'load.js'));
const { build } = require(path.join(__dirname, '..', 'server', 'index.js'));

const TENANT = 'routing-test';
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

(async () => {
  const db = connect({ connectionString: URL_, tenant: TENANT });
  const tables = ['users', 'sessions', 'company_profile', 'customers', 'quotations',
    'quotation_items', 'audit_log', 'config_lists'];
  const clean = async () => {
    for (const t of tables) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();

  await db.appendRow('CompanyProfile', { id: 'CO-1', appName: 'Premier India Enterprise' });
  await db.appendRow('Customers', { id: 'CUS-1', customerCode: 'C0001', name: 'Bharat Forge Ltd', active: 'TRUE' });
  await db.appendRow('Quotations', { id: 'QT-1a2b3c4d', quoteNo: 'PIE/ELGI/QUOT/26-27/401',
    revision: 'R0', date: '2026-10-01', customerId: 'CUS-1', businessStream: 'Spare Sales',
    status: 'Draft', grand: 48500, subtotal: 41101, taxAmt: 7399, preparedBy: 'boss@pie.in',
    validityDays: 30, validUntil: '2026-10-31' });
  await db.appendRow('Users', { id: 'USR-1', username: 'boss', email: 'boss@pie.in',
    name: 'Abhijeet Paunikar', role: 'ERP Admin', businessStream: 'All', active: 'TRUE' });
  await db.appendRow('Users', { id: 'USR-2', username: 'priya', email: 'priya@pie.in',
    name: 'Priya Deshmukh', role: 'Sales Coordinator', businessStream: 'Spare Sales', active: 'TRUE' });

  const setup = loadPortal(db, 'setup', { quiet: true });
  setup.CURRENT_USER_ = { email: 'setup@pie.in', role: 'ERP Admin' };
  const said = String(await setup.createSignInPasswords());
  const pw = (login) => (new RegExp('\\b' + login + '\\s+(\\S+)').exec(said) || [])[1];
  const passwords = { boss: pw('boss'), priya: pw('priya') };
  for (const id of ['USR-1', 'USR-2']) {
    await db.updateRowById('Users', 'id', id, { mustChangePassword: 'FALSE' }, 'test reaches the portal');
  }

  const server = build({ db, tenant: TENANT });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  // ------------------------------------------------------------- the server
  console.log('THE SERVER SERVES THE PORTAL AT EVERY SCREEN’S ADDRESS');
  for (const p of ['/', '/quotations', '/sales-orders/', '/reports/leads-by-engineer',
    '/quotation/QT-1a2b3c4d', '/quotation-progress/QT-1a2b3c4d']) {
    const r = await fetch(base + p);
    const body = await r.text();
    ok(p + ' is the portal', r.status === 200 && /id="signin-screen"/.test(body), r.status);
  }
  const missing = await fetch(base + '/no-such-screen');
  ok('and an address nobody defined is still a 404', missing.status === 404, missing.status);

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const ours = () => errors.filter((e) => !/net::ERR_|ERR_PROXY|ERR_CERT/.test(e));

  const where = () => page.evaluate(() => location.pathname);
  const onScreen = () => page.evaluate(() => {
    const v = document.querySelector('.view.active');
    return v ? v.id.replace('view-', '') : '';
  });
  const settle = async (want) => {
    try {
      await page.waitForFunction((w) => location.pathname === w, want, { timeout: 8000 });
    } catch (e) { /* the assertion after says what it was */ }
    await page.waitForTimeout(400);
  };
  const click = async (sel) => {
    await page.$eval(sel, (el) => el.click());
  };
  const signIn = async (login) => {
    await page.waitForSelector('#signin-screen', { state: 'visible', timeout: 10000 });
    await page.fill('#signin-email', login);
    await page.fill('#signin-password', passwords[login]);
    await page.click('#btn-signin');
    await page.waitForSelector('#signin-screen', { state: 'hidden', timeout: 15000 });
    await page.waitForTimeout(800);
  };

  // ------------------------------------------------------------- typed in before signing in
  console.log('\nAN ADDRESS TYPED IN BEFORE SIGNING IN IS WHERE YOU ARRIVE');
  await page.goto(base + '/quotations', { waitUntil: 'networkidle' });
  await signIn('boss');
  await page.waitForFunction(() => /PIE\/ELGI\/QUOT/.test(document.body.innerText), null, { timeout: 15000 });
  ok('the Quotations screen, not the Dashboard', (await onScreen()) === 'quotations', await onScreen());
  ok('and the address is still /quotations', (await where()) === '/quotations', await where());
  ok('the tab is titled for the screen',
    (await page.title()) === 'All Quotations · Premier India Enterprise', await page.title());

  // ------------------------------------------------------------- moving around
  console.log('\nEACH SCREEN WRITES ITS OWN ADDRESS');
  await click('#tabs [data-view="orders"]');
  await settle('/sales-orders');
  ok('Sales Orders is /sales-orders', (await where()) === '/sales-orders', await where());
  await click('#tabs [data-view="customers"]');
  await settle('/customers');
  ok('Customers is /customers', (await where()) === '/customers', await where());

  console.log('\nBACK AND FORWARD WALK THROUGH THEM');
  await page.goBack();
  await settle('/sales-orders');
  ok('Back goes to Sales Orders', (await where()) === '/sales-orders' && (await onScreen()) === 'orders',
    { at: await where(), screen: await onScreen() });
  await page.goBack();
  await settle('/quotations');
  ok('and again to Quotations', (await onScreen()) === 'quotations', await onScreen());
  await page.goForward();
  await settle('/sales-orders');
  ok('Forward comes back to Sales Orders', (await onScreen()) === 'orders', await onScreen());
  ok('still signed in throughout', !(await page.isVisible('#signin-screen')));

  console.log('\nA REFRESH STAYS WHERE YOU ARE');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  ok('Sales Orders again after the refresh', (await onScreen()) === 'orders' &&
    (await where()) === '/sales-orders', { at: await where(), screen: await onScreen() });

  // ------------------------------------------------------------- one quotation
  console.log('\nA QUOTATION HAS AN ADDRESS OF ITS OWN');
  await click('#tabs [data-view="quotations"]');
  await page.waitForFunction(() => /PIE\/ELGI\/QUOT/.test(document.body.innerText), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const opener = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('#quotations-tbody tr'))
      .filter((tr) => /QUOT\/26-27\/401/.test(tr.textContent))[0];
    const btn = row && Array.from(row.querySelectorAll('button')).filter((b) =>
      /open|edit|✎/i.test(b.textContent + ' ' + (b.title || '')))[0];
    if (btn) { btn.click(); return btn.textContent.trim() || btn.title; }
    return null;
  });
  ok('the quotation can be opened from the list', !!opener, opener);
  await settle('/quotation/QT-1a2b3c4d');
  ok('opening it puts it in the address', (await where()) === '/quotation/QT-1a2b3c4d', await where());
  ok('and in the tab title', /^PIE\/ELGI\/QUOT\/26-27\/401 · /.test(await page.title()), await page.title());

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => /QUOT\/26-27\/401/.test(
    (document.getElementById('qb-title') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
  ok('a refresh reopens that same quotation', (await onScreen()) === 'quote' &&
    /QUOT\/26-27\/401/.test(await page.$eval('#qb-title', (e) => e.textContent)),
    { screen: await onScreen() });
  await page.goBack();
  await settle('/quotations');
  ok('Back from it is the list it was opened from', (await onScreen()) === 'quotations', await onScreen());

  console.log('\nA LINK TO A QUOTATION THAT IS NOT THERE SAYS SO');
  await page.goto(base + '/quotation/QT-gone0000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  ok('the screen says it is not found', /not found/i.test(await page.innerText('#msg-box').catch(() => '')),
    await page.innerText('#msg-box').catch(() => ''));
  ok('and leaves you on a real screen with a real address', (await where()) === '/quotation' &&
    (await onScreen()) === 'quote', { at: await where(), screen: await onScreen() });
  // The server answered that with an error status, which the browser logs. Correct, and
  // cleared here beside its cause so everything after is judged on its own.
  errors.length = 0;

  console.log('\nTHE PROGRESS TRAIL TOO');
  await page.goto(base + '/quotation-progress/QT-1a2b3c4d', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const d = document.getElementById('progress-detail');
    return d && d.style.display !== 'none' && /401/.test(d.textContent);
  }, null, { timeout: 15000 }).catch(() => {});
  ok('the trail opens straight from its address',
    await page.$eval('#progress-detail', (d) => d.style.display !== 'none' && /401/.test(d.textContent)));
  ok('and the address stays on it', (await where()) === '/quotation-progress/QT-1a2b3c4d', await where());
  await click('#btn-progress-back');
  await settle('/quotation-progress');
  ok('Back to the list is /quotation-progress', (await where()) === '/quotation-progress', await where());

  console.log('\nBACK CLOSES A WINDOW LEFT OPEN');
  await click('#tabs [data-view="customers"]');
  await settle('/customers');
  await click('#btn-new-customer');
  await page.waitForTimeout(400);
  ok('a window is open', await page.isVisible('#customer-modal-backdrop'));
  await page.goBack();
  await settle('/quotation-progress');
  ok('Back leaves the screen and takes the window with it',
    !(await page.isVisible('#customer-modal-backdrop')) && (await onScreen()) === 'progress',
    { screen: await onScreen() });

  console.log('\nSIGNING OUT CLEARS THE ADDRESS');
  await page.evaluate(() => document.getElementById('btn-signout').click());
  await page.waitForSelector('#signin-screen', { state: 'visible', timeout: 10000 });
  ok('back to /', (await where()) === '/', await where());

  // ------------------------------------------------------------- somewhere not theirs
  console.log('\nAN ADDRESS FOR A SCREEN SOMEBODY MAY NOT OPEN');
  await page.goto(base + '/compressor-sales', { waitUntil: 'networkidle' });
  await signIn('priya');
  ok('a Spare Sales coordinator is not shown Compressor Sales', (await onScreen()) !== 'compressor',
    await onScreen());
  ok('she lands on her own first screen, and the address says so',
    (await onScreen()) === 'enquiries' && (await where()) === '/spare-sales',
    { at: await where(), screen: await onScreen() });
  await page.goto(base + '/settings', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  ok('nor Settings, by typing it', (await onScreen()) !== 'settings' && (await where()) !== '/settings',
    { at: await where(), screen: await onScreen() });

  ok('no script errors anywhere', ours().length === 0, ours().slice(0, 3));

  await browser.close();
  await new Promise((r) => server.close(r));
  await clean();
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
