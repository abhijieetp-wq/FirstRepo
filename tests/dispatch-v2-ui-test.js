/**
 * ERP 2.0's Dispatch & Billing, as the 2.0 demo draws it, in a browser against the real client:
 * the five totals (clicking one opens its tab), the orders ready to go with a Dispatch button,
 * the four tabs in the demo's tables — dispatches with their proof of delivery and invoice,
 * invoices with what is still owed and Tally, what went out unbilled, and the Tally queue — and
 * each button and row opening ERP 1's own forms and windows. The other faces keep ERP 1's lists.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --ui=v2
 *   node tests/dispatch-v2-ui-test.js /tmp/show-v2.html
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
  // The test data is dated October 2026; the clock is held there so "this month" stays put.
  await page.clock.setFixedTime(new Date('2026-10-29T10:00:00+05:30'));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  const go = async (view) => { await page.evaluate((v) => document.querySelector('#tabs [data-view="' + v + '"]').click(), view); await page.waitForTimeout(800); };
  const shown = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null; }, sel);
  const rows = () => page.$$eval('#dsv-tbody tr.qv-row', (r) => r.map((x) => x.querySelector('td .mono, td .eb2-kind').textContent));
  const tab = async (t) => { await page.evaluate((x) => document.querySelector('#dsv-host [data-dsv-tab="' + x + '"]').click(), t); await page.waitForTimeout(150); };
  const called = (fn, arg) => page.evaluate((a) => window.__calls.some((c) => c.fn === a[0] && (a[1] === undefined || c.args[0] === a[1])), [fn, arg]);
  const isOpen = (id) => page.evaluate((i) => document.getElementById(i).classList.contains('show'), id);

  if (!v2) {
    console.log('THE OTHER FACES');
    await go('dispatch');
    ok('ERP 1’s tabs and list', await shown('#subtab-dispatches') && await shown('#dsp-tbody') && !(await page.$('#dsv-host')));
  } else {
    await page.evaluate(() => {
      const D = window.__data;
      D.listDispatchableOrders = [{ id: 'SO-1', orderNo: 'SO2610-0042', customerName: 'Bhima Sugar Industries', orderStatus: 'Material Pending', ready: false },
        { id: 'SO-4', orderNo: 'SO2610-0037', customerName: 'Godavari Textile Mills', orderStatus: 'Ready for Dispatch', ready: true }];
      D.getDispatchReadiness = { checks: [], stopsDispatch: [] };
      D.listInvoiceableDispatches = () => D.listDispatchedNotInvoiced;
    });

    console.log('DISPATCH & BILLING');
    await go('dispatch');
    ok('ERP 1’s tabs and list put away, 2.0’s in their place', await shown('#dsv-host') && !(await shown('#subtab-dispatches')) && !(await shown('#dsp-tbody')));
    ok('the heading, and ERP 1’s two buttons', /proof of delivery back/.test(await page.textContent('#view-dispatch .page-head')) &&
      await shown('#btn-new-dispatch') && await shown('#btn-new-invoice'));
    const tiles = await page.$$eval('#dsv-host .qv-kpi', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    ok('five totals', tiles.length === 5 && tiles[0] === 'Ready to dispatch 1 ₹2.43 L' && tiles[1] === 'Waiting for delivery photo 1 oldest 2 days' &&
      tiles[2] === 'Dispatched, not invoiced 2 ₹1.51 L' && tiles[3] === 'Invoiced this month 2 ₹4.45 L' && tiles[4] === 'In the Tally queue 2 1 failed', tiles);
    ok('unbilled goods are a red total, a missing photo amber', await page.$eval('#dsv-host .qv-kpi:nth-child(3)', (e) => e.classList.contains('bad')) &&
      await page.$eval('#dsv-host .qv-kpi:nth-child(2)', (e) => e.classList.contains('sig')));
    const ready = await page.textContent('#dsv-host .dsv-ready');
    ok('the orders ready to go', /Ready to go/.test(ready) && /Godavari Textile Mills/.test(ready) && /SO2610-0037 · Service kit, 4,000 hours · promised 13 Oct/.test(ready), ready);
    ok('four tabs, with what is waiting', (await page.$$eval('#dsv-host [data-dsv-tab]', (b) => b.map((x) => x.textContent.replace(/\s+/g, ' ').trim()))).join('|') ===
      'Dispatches|Invoices|Dispatched, not invoiced 2|Tally queue 2');

    console.log('\nDISPATCHES');
    ok('the table, in the demo’s columns', (await page.$$eval('#dsv-host th', (t) => t.map((x) => x.textContent))).join('|') ===
      'Dispatch|Date|Order|Customer|Through|LR / docket|Proof of delivery|Invoice|');
    ok('newest first', JSON.stringify(await rows()) === '["DSP2610-0019","DSP2610-0018","DSP2610-0016"]', await rows());
    const r = await page.$$eval('#dsv-tbody tr', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ')));
    ok('each with how it went, the photo and the invoice', /VRL Logistics/.test(r[0]) && /MH40 AK 2231/.test(r[0]) && /VRL-882140/.test(r[0]) &&
      /Waiting for photo/.test(r[0]) && /Not invoiced/.test(r[0]) && /Add photo/.test(r[0]) &&
      /Photo · 22 Oct/.test(r[1]) && /Make invoice/.test(r[1]) && /INV\/26-27\/0412/.test(r[2]) && /Override/.test(r[2]), r);
    await page.fill('#dsv-host [data-dsv-q]', 'konkan');
    await page.waitForTimeout(150);
    ok('search, keeping the box', JSON.stringify(await rows()) === '["DSP2610-0018"]' && await page.evaluate(() => document.activeElement.matches('[data-dsv-q]')));
    await page.fill('#dsv-host [data-dsv-q]', '');
    await page.waitForTimeout(150);

    console.log('\nTHE BUTTONS AND ROWS OPEN ERP 1’S FORMS');
    await page.evaluate(() => { window.__calls = []; });
    await page.click('#dsv-host [data-dsv-dispatch="SO-4"]');
    await page.waitForTimeout(500);
    ok('Dispatch opens the new dispatch with that order picked', await isOpen('newdispatch-modal-backdrop') && await page.inputValue('#nd-order') === 'SO-4');
    await page.click('#btn-cancel-newdispatch');
    await page.click('#dsv-host [data-dsv-invoice="DSP-2"]');
    await page.waitForTimeout(500);
    ok('Make invoice opens the invoice with that dispatch picked', await isOpen('newinvoice-modal-backdrop') && await page.inputValue('#ni-dispatch') === 'DSP-2');
    await page.click('#btn-cancel-newinvoice');
    await page.evaluate(() => { window.__calls = []; window.__failNext = 'getDispatch'; });
    await page.click('#dsv-host [data-dsv-open="DSP-3"]');
    await page.waitForTimeout(400);
    ok('Add photo opens the dispatch, where the photo goes', await called('getDispatch', 'DSP-3'));
    await page.evaluate(() => { window.__calls = []; window.__failNext = 'getDispatch'; });
    await page.evaluate(() => document.querySelector('#dsv-tbody tr[data-dsv-dispatch-row="DSP-1"] td:nth-child(4)').click());
    await page.waitForTimeout(400);
    ok('and a row opens its dispatch', await called('getDispatch', 'DSP-1'));

    console.log('\nINVOICES');
    await tab('invoices');
    ok('the table', (await page.$$eval('#dsv-host th', (t) => t.map((x) => x.textContent))).join('|') === 'Invoice|Date|Customer|Order|Amount|Still owed|Due|Status|Tally' &&
      (await rows()).length === 4);
    const inv = await page.$$eval('#dsv-tbody tr', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ')));
    ok('a draft waits for Tally’s number, a paid one says so, a late one is late', /Awaiting Tally no\./.test(inv[0]) && /not issued/.test(inv[0]) &&
      /Failed/.test(inv[1]) && /Paid/.test(inv[2]) && /Synced/.test(inv[2]) && /17 d late/.test(inv[3]), inv);
    await page.evaluate(() => { window.__calls = []; window.__failNext = 'getInvoice'; });
    await page.evaluate(() => document.querySelector('#dsv-tbody tr[data-dsv-invoice-row="INV-2"] td:nth-child(3)').click());
    await page.waitForTimeout(400);
    ok('a row opens the invoice', await called('getInvoice', 'INV-2'));

    console.log('\nDISPATCHED, NOT INVOICED, AND THE TALLY QUEUE');
    await page.evaluate(() => document.querySelector('#dsv-host [data-dsv-tile="uninvoiced"]').click());
    await page.waitForTimeout(150);
    ok('the total opens its tab', await page.$eval('#dsv-host [data-dsv-tab="uninvoiced"]', (b) => b.getAttribute('aria-selected')) === 'true' &&
      JSON.stringify(await rows()) === '["DSP2610-0018","DSP2610-0019"]', await rows());
    ok('the oldest first, late ones marked', await page.$eval('#dsv-tbody tr td:nth-child(3)', (td) => td.classList.contains('qv-late') && /8 days/.test(td.textContent)));
    await tab('tally');
    const tq = await page.$$eval('#dsv-tbody tr', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ')));
    ok('the issued invoices not yet in Tally', tq.length === 2 && /INV\/26-27\/0419/.test(tq[0]) && /Tally not reachable/.test(tq[0]) && /Waiting/.test(tq[1]), tq);
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
