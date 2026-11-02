/**
 * ERP 2.0's Sales Orders, as the 2.0 demo draws them, in a browser against the real client: the
 * five totals (clicking one filters), search, status and Only mine, and the table — the order
 * and its desk, the customer and what was ordered, the PO and a variance, the value before GST,
 * the status, how much is in stock and the promised date; a row opening ERP 1's order window.
 * The other faces keep ERP 1's list.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --ui=v2
 *   node tests/orders-v2-ui-test.js /tmp/show-v2.html
 */
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const PREVIEW = process.argv[2];
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e) + ' @ ' + String(e.stack).split('\n').slice(1, 3).join(' | ')));
  // The test data is dated October 2026; the clock is held there so "late" stays put.
  await page.clock.setFixedTime(new Date('2026-10-29T10:00:00+05:30'));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  const go = async (view) => { await page.evaluate((v) => document.querySelector('#tabs [data-view="' + v + '"]').click(), view); await page.waitForTimeout(700); };
  const shown = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null; }, sel);
  const rows = () => page.$$eval('#so-tbody tr[data-open-order]', (r) => r.map((x) => x.querySelector('td .mono').textContent));

  if (!v2) {
    console.log('THE OTHER FACES');
    await go('orders');
    ok('ERP 1’s order list', await shown('#orders-tbody') && !(await page.$('#so-host')));
  } else {
    console.log('SALES ORDERS');
    await go('orders');
    ok('ERP 1’s list put away, 2.0’s in its place', await shown('#so-host') && !(await shown('#orders-tbody')) && !(await shown('#orders-search')));
    ok('the heading and its button', /Values are before GST/.test(await page.textContent('#view-orders .page-head')) &&
      /Create from an accepted quotation/.test(await page.textContent('#btn-new-order')));
    const tiles = await page.$$eval('#so-host .qv-kpi', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    ok('five totals', tiles.length === 5 && tiles[0] === 'Open orders 4 ₹24.86 L' && tiles[1] === 'Credit holds 1 unpaid invoices or advance' &&
      tiles[2] === 'Material pending 1 waiting on ELGi or stock' && tiles[3] === 'Ready for dispatch 1 ₹2.43 L' &&
      tiles[4] === 'Past promised date 1 oldest 16 days late', tiles);
    ok('a credit hold is a red total, a late one amber', await page.$eval('#so-host .qv-kpi:nth-child(2)', (e) => e.classList.contains('bad')) &&
      await page.$eval('#so-host .qv-kpi:nth-child(5)', (e) => e.classList.contains('sig')));
    ok('the table, in the demo’s columns', (await page.$$eval('#so-host th', (t) => t.map((x) => x.textContent))).join('|') ===
      'Order|Date|Customer|PO|Value|Status|Material|Promised');
    ok('the open orders, newest first', JSON.stringify(await rows()) === '["SO2610-0042","SO2610-0041","SO2610-0039","SO2610-0037"]', await rows());
    const first = await page.$eval('#so-tbody tr', (r) => r.innerText.replace(/\s+/g, ' '));
    ok('a row: order and desk, customer and what was ordered, PO, value before GST, status, stock, promised',
      /SO2610-0042/.test(first) && /Spares/.test(first) && /Bhima Sugar Industries/.test(first) && /Air-oil separator kit \+ 3 more/.test(first) &&
      /BSI\/PUR\/2210/.test(first) && /₹3\.50 L/.test(first) && /Material Pending/.test(first) && /1 of 4 lines in stock/.test(first) && /22 Oct/.test(first), first);
    ok('a credit hold stands out', await page.$eval('#so-tbody tr:nth-child(2)', (r) => r.classList.contains('so-hold') && /Compressor/.test(r.innerText) && /Waiting on ELGi or stock/.test(r.innerText)));
    const last = await page.$eval('#so-tbody tr:nth-child(4)', (r) => r.innerText.replace(/\s+/g, ' '));
    ok('a PO variance and a late promise say so', /PO variance/.test(last) && /All in stock/.test(last) &&
      await page.$eval('#so-tbody tr:nth-child(4) td:last-child', (td) => td.classList.contains('qv-late')), last);

    console.log('\nTHE FILTERS');
    await page.click('#so-host [data-so-tile="hold"]');
    await page.waitForTimeout(150);
    ok('a total filters to it', JSON.stringify(await rows()) === '["SO2610-0041"]' && await page.$eval('#so-host [data-so-sel="status"]', (s) => s.value) === 'hold');
    await page.click('#so-host [data-so-tile="hold"]');
    await page.waitForTimeout(150);
    ok('and again goes back', (await rows()).length === 4);
    await page.selectOption('#so-host [data-so-sel="status"]', 'all');
    await page.waitForTimeout(150);
    ok('all, including closed', (await rows()).length === 5);
    await page.selectOption('#so-host [data-so-sel="status"]', 'Invoiced');
    await page.waitForTimeout(150);
    ok('one status', JSON.stringify(await rows()) === '["SO2610-0035"]');
    await page.selectOption('#so-host [data-so-sel="status"]', 'open');
    await page.check('#so-host [data-so-mine]');
    await page.waitForTimeout(150);
    ok('only mine', JSON.stringify(await rows()) === '["SO2610-0037"]', await rows());
    await page.uncheck('#so-host [data-so-mine]');
    await page.fill('#so-host [data-so-q]', 'separator');
    await page.waitForTimeout(150);
    ok('search finds what was ordered too, keeping the box', JSON.stringify(await rows()) === '["SO2610-0042"]' &&
      await page.evaluate(() => document.activeElement.matches('[data-so-q]')));
    await page.fill('#so-host [data-so-q]', '');
    await page.waitForTimeout(150);

    console.log('\nA ROW');
    // The order window itself is ERP 1's and tested elsewhere; here, only that the row asks for it.
    await page.evaluate(() => { window.__calls = []; window.__failNext = 'getSalesOrder'; });
    await page.click('#so-tbody tr[data-open-order="SO-2"]');
    await page.waitForTimeout(400);
    ok('opens the order', await page.evaluate(() => window.__calls.some((c) => c.fn === 'getSalesOrder' && c.args[0] === 'SO-2')));
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
