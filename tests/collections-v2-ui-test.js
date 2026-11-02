/**
 * ERP 2.0's Collections, as the 2.0 demo draws it, in a browser against the real client: the
 * six totals, the four tabs in the demo's tables — ageing by customer with how it is spread,
 * open invoices (Overdue only), follow-ups as a timeline, receipts — and each button opening
 * ERP 1's own forms (receipt, follow-up, statement). The other faces keep ERP 1's lists.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --ui=v2
 *   node tests/collections-v2-ui-test.js /tmp/show-v2.html
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
  // The test data is dated October 2026; the clock is held there so "today" and "this month" stay put.
  await page.clock.setFixedTime(new Date('2026-10-29T10:00:00+05:30'));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  const go = async (view) => { await page.evaluate((v) => document.querySelector('#tabs [data-view="' + v + '"]').click(), view); await page.waitForTimeout(900); };
  const shown = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null; }, sel);
  const press = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
  const rows = () => page.$$eval('#cov-tbody tr', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
  const tab = async (t) => { await press('#cov-host [data-cov-tab="' + t + '"]'); await page.waitForTimeout(150); };
  const called = (fn, arg) => page.evaluate((a) => window.__calls.some((c) => c.fn === a[0] && (a[1] === undefined || c.args[0] === a[1])), [fn, arg]);

  if (!v2) {
    console.log('THE OTHER FACES');
    await go('collections');
    ok('ERP 1’s tabs and list', await shown('#subtab-ageing') && await shown('#col-tbody') && !(await page.$('#cov-host')));
  } else {
    console.log('COLLECTIONS');
    await go('collections');
    ok('ERP 1’s tabs and list put away, 2.0’s in their place', await shown('#cov-host') && !(await shown('#subtab-ageing')) && !(await shown('#col-tbody')));
    ok('the demo’s two buttons, in its order', (await page.$$eval('#col-actions button', (b) => b.map((x) => x.id))).join() === 'btn-import-receipts,btn-new-receipt');
    const tiles = await page.$$eval('#cov-host .qv-kpi', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    ok('six totals', tiles.length === 6 && tiles[0] === 'Outstanding ₹13.95 L 6 open invoices' && tiles[1] === 'Overdue ₹6.12 L 44% of outstanding, past the due date' &&
      tiles[2] === 'Over 90 days ₹3.52 L 1 customer' && tiles[3] === 'Received this month ₹2.08 L 2 receipts' &&
      tiles[4] === 'Promised for today 1 Vardhman Precision Tools' && tiles[5] === 'Broken promises 1 Vardhman Precision Tools', tiles);

    console.log('\nAGEING BY CUSTOMER');
    ok('the table, with the spread and the credit', (await page.$$eval('#cov-host th', (t) => t.map((x) => x.textContent))).join('|') ===
      'Customer|Not due|1–30|31–60|61–90|Over 90|Total|Spread|Credit|Last follow-up|');
    const ag = await rows();
    ok('each customer: invoices, buckets, total, credit, last follow-up', ag.length === 3 && /Vardhman Precision Tools/.test(ag[0]) && /Over limit/.test(ag[0]) &&
      /₹3\.52 L/.test(ag[0]) && /₹4\.26 L/.test(ag[0]) && /30 days · ₹3\.00 L/.test(ag[0]) && /27 Oct: Will release/.test(ag[0]) &&
      /no limit/.test(ag[2]), ag);
    ok('the bar is in the buckets’ colours', (await page.$$eval('#cov-tbody tr:first-child .cov-spread i', (i) => i.length)) === 2);
    await page.evaluate(() => { window.__calls = []; window.__failNext = 'getCustomerStatement'; });
    await press('#cov-tbody [data-cov-statement="CU-4"]');
    await page.waitForTimeout(400);
    ok('Statement opens ERP 1’s statement', await called('getCustomerStatement', 'CU-4'));
    await press('#cov-tbody [data-cov-follow="INV-7"]');
    await page.waitForTimeout(400);
    ok('Follow up opens ERP 1’s form on the oldest invoice, naming it', await page.evaluate(() => document.getElementById('followup-modal-backdrop').classList.contains('show')) &&
      await page.inputValue('#fu-invoiceid') === 'INV-7' && /INV\/26-27\/0301 · Vardhman Precision Tools/.test(await page.textContent('#fu-context')));
    await page.evaluate(() => document.querySelectorAll('.modal-backdrop.show').forEach((m) => m.classList.remove('show')));

    console.log('\nOPEN INVOICES');
    await tab('receivables');
    ok('the table', (await page.$$eval('#cov-host th', (t) => t.map((x) => x.textContent))).join('|') === 'Invoice|Date|Customer|Amount|Received|Still owed|Past due|Promise|' &&
      (await rows()).length === 6);
    const op = await rows();
    ok('late ones say how late, a promise shows, the rest are not due', /88 days/.test(op[0]) && /₹1,50,000 by 25 Oct/.test(op[0]) && /Not due/.test(op[3]), op);
    await press('#cov-host [data-cov-overdue]');
    await page.waitForTimeout(150);
    ok('Overdue only', (await rows()).length === 3);
    await press('#cov-host [data-cov-overdue]');
    await page.waitForTimeout(150);
    await press('#cov-tbody [data-cov-receipt="INV-6"]');
    await page.waitForTimeout(500);
    ok('Receipt opens ERP 1’s receipt form on that invoice', await page.evaluate(() => document.getElementById('receipt-modal-backdrop').classList.contains('show')) &&
      await page.inputValue('#rcp-invoice') === 'INV-6');
    await page.evaluate(() => document.querySelectorAll('.modal-backdrop.show').forEach((m) => m.classList.remove('show')));

    console.log('\nFOLLOW-UPS AND RECEIPTS');
    await press('#cov-host [data-cov-tile="followups"]');
    await page.waitForTimeout(150);
    const tl = await page.$$eval('#cov-host .cov-tl', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    ok('Broken promises opens the follow-ups, newest first, each with where it stands', tl.length === 3 && /Promised · 29 Oct · ₹74,800/.test(tl[0]) &&
      /Next follow-up 29 Oct/.test(tl[0]) && /Broken · 25 Oct · ₹1\.50 L/.test(tl[1]) && /Closed/.test(tl[2]), tl);
    await tab('receipts');
    const rc = await rows();
    ok('receipts, with the invoice they pay, the mode and Tally’s voucher', rc.length === 3 && /from Tally/.test(rc[0]) && /Rcpt\/1182/.test(rc[0]) &&
      /Cheque/.test(rc[1]) && /advance/.test(rc[2]) && /Reverse/.test(rc[0]), rc);
    await page.fill('#cov-host [data-cov-q]', 'konkan');
    await page.waitForTimeout(150);
    ok('search, keeping the box', (await rows()).length === 1 && await page.evaluate(() => document.activeElement.matches('[data-cov-q]')));
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
