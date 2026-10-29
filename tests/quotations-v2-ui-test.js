/**
 * ERP 2.0's All Quotations and Quotation Progress, as the 2.0 demo draws them, in a browser
 * against the real client: the six totals (clicking one filters), Both desks / Compressor /
 * Spares, search, status, who prepared it, the table with the ten-step progress; a row opening
 * the quotation; Progress with how far the offers got step by step, each one's ten steps, where
 * it is, what is next and how long it has waited, a row opening ERP 1's trail and Back to the
 * list. The other faces keep ERP 1's lists.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --ui=v2
 *   node tests/quotations-v2-ui-test.js /tmp/show-v2.html
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
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  const go = async (view) => { await page.evaluate((v) => document.querySelector('#tabs [data-view="' + v + '"]').click(), view); await page.waitForTimeout(700); };
  const shown = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null; }, sel);
  const rows = (host) => page.$$eval(host + ' tbody tr[data-qv-open], ' + host + ' tbody tr[data-qv-trail]', (r) => r.length);

  if (!v2) {
    console.log('THE OTHER FACES');
    await go('quotations');
    ok('ERP 1’s quotation list, no 2.0 page', await shown('#quotations-tbody') && !(await page.$('#qv-quotes')));
    await go('progress');
    ok('ERP 1’s progress list', await shown('#progress-tbody') && !(await page.$('#qv-progress')));
    ok('and New Quotation stays in the menu', !!(await page.$('#tabs [data-view="quote"]')) && !(await page.$('#btn-qv-new')));
  } else {
    console.log('ALL QUOTATIONS');
    await go('quotations');
    ok('the 2.0 page, ERP 1’s list put away', await shown('#qv-quotes') && !(await shown('#quotations-tbody')) && !(await shown('#quotations-search')));
    ok('its heading and button', /Values are before GST/.test(await page.textContent('#view-quotations .page-head')) && await shown('#btn-qv-new'));
    const tiles = await page.$$eval('#qv-quotes .qv-kpi', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    ok('six totals', tiles.length === 6 && /^Drafts 1 /.test(tiles[0]) && /^Approved, not sent yet 1 /.test(tiles[1]) && /^Sent, no answer yet 2 /.test(tiles[2]) &&
      /^Accepted \(won\) this month/.test(tiles[3]) && /^Declined \(lost\) this month 0/.test(tiles[4]) && /^Past validity 1 .*revise to renew$/.test(tiles[5]), tiles);
    const all = await rows('#qv-quotes');
    ok('the table, in the demo’s columns', (await page.$$eval('#qv-quotes th', (t) => t.map((x) => x.textContent))).join('|') ===
      'Quotation|Date|Prepared by|Customer|Main item|Value|Status|Progress|Valid until' && all >= 7);
    const first = await page.$eval('#qv-quotes tbody tr', (r) => r.innerText.replace(/\s+/g, ' '));
    ok('a row: short number, desk, who, customer, item, value before GST, status, steps', /PIE\/…\/26-27\/418 R0/.test(first) && /Spares/.test(first) && /Neha Rao/.test(first) &&
      /EG 37 service kit/.test(first) && /Draft/.test(first) && /Prepared 1\/10/.test(first), first);
    await page.click('#qv-quotes [data-qv-tile="Sent"]');
    await page.waitForTimeout(200);
    ok('a total filters to it', (await rows('#qv-quotes')) === 2 && await page.$eval('#qv-quotes [data-qv-sel="status"]', (s) => s.value) === 'Sent');
    await page.click('#qv-quotes [data-qv-tile="Sent"]');
    await page.waitForTimeout(200);
    await page.click('#qv-quotes [data-qv-seg="stream"][data-v="Compressor Sales"]');
    await page.waitForTimeout(200);
    ok('one desk', (await page.$$eval('#qv-quotes tbody .qv-desk', (d) => d.map((x) => x.textContent))).every((t) => t === 'Compressor') && (await rows('#qv-quotes')) >= 1);
    await page.click('#qv-quotes [data-qv-seg="stream"][data-v=""]');
    await page.fill('#qv-quotes [data-qv-q]', 'Godavari');
    await page.waitForTimeout(200);
    ok('search, keeping the box', (await rows('#qv-quotes')) === 1 && await page.evaluate(() => document.activeElement.matches('[data-qv-q]')));
    await page.fill('#qv-quotes [data-qv-q]', '');
    await page.selectOption('#qv-quotes [data-qv-sel="who"]', 'kiran@pie.in');
    await page.waitForTimeout(200);
    ok('who prepared it', (await page.$$eval('#qv-quotes tbody tr', (r) => r.map((x) => x.children[2].textContent))).every((t) => t === 'Kiran Patil'));
    await page.selectOption('#qv-quotes [data-qv-sel="who"]', '');
    await page.evaluate(() => { window.__calls = []; });
    await page.click('#qv-quotes tbody tr[data-qv-open]');
    await page.waitForTimeout(500);
    ok('a row opens the quotation', await page.evaluate(() => window.__calls.some((c) => c.fn === 'getQuotation')));

    console.log('\nNEW QUOTATION, IN A WINDOW');
    ok('no New Quotation screen in the menu', !(await page.$('#tabs [data-view="quote"]')));
    await page.evaluate(() => document.querySelectorAll('.modal-backdrop.show').forEach((m) => m.classList.remove('show')));
    await go('quotations');
    await page.click('#btn-qv-new');
    await page.waitForTimeout(400);
    ok('the button opens a window over All Quotations', await page.evaluate(() => document.getElementById('qv-new-backdrop').classList.contains('show')) &&
      await page.evaluate(() => document.getElementById('view-quotations').classList.contains('active')));
    ok('with every field the screen had', await shown('#qv-new-body #qs-customer') && await shown('#qv-new-body #btn-qs-new-customer') &&
      await shown('#qv-new-body #qs-stream') && await shown('#qv-new-body #qs-model') && await shown('#qv-new-body #qs-serial') &&
      await shown('#qv-new-body #qs-validity') && await shown('#qv-new-body #btn-qs-create'));
    ok('customers and desks filled in', (await page.$$eval('#qs-customer option', (o) => o.length)) >= 1 &&
      (await page.$$eval('#qs-stream option', (o) => o.map((x) => x.value))).indexOf('Spare Sales') === -1);
    await page.click('#btn-qv-new-cancel');
    await page.waitForTimeout(200);
    ok('Cancel closes it', !(await page.evaluate(() => document.getElementById('qv-new-backdrop').classList.contains('show'))));
    await page.click('#btn-qv-new');
    await page.waitForTimeout(300);
    await page.click('#btn-qs-new-customer');
    await page.waitForTimeout(300);
    ok('+ New customer opens above it', await page.evaluate(() => {
      const z = (el) => Number(getComputedStyle(el).zIndex) || 0;
      const c = document.getElementById('customer-modal-backdrop');
      return c.classList.contains('show') && z(c) > z(document.getElementById('qv-new-backdrop'));
    }));
    await page.evaluate(() => document.getElementById('customer-modal-backdrop').classList.remove('show'));
    await page.evaluate(() => {
      window.__calls = [];
      window.__data.createBlankQuotation = (o) => ({ date: '2026-10-29', customerName: 'Sahyadri Castings Pvt Ltd', validityDays: 30, validUntil: '2026-11-28', paymentTerms: '', deliveryTerms: '',
        deliveryPeriod: '', warrantyTerms: '', notes: '', packageDiscountPct: 0, pfAmount: 0, taxMode: 'Extra', items: [], subTotal: 0, grand: 0, taxAmt: 0,
        machineModel: o.machineModel, serialNo: '', id: 'Q-NEW', quoteNo: 'PIE/ELGI/QUOT/26-27/499', revision: 'R0', status: 'Draft', locked: false,
        customerId: o.customerId, businessStream: o.businessStream });
    });
    await page.fill('#qs-model', 'EG 37');
    await page.click('#btn-qs-create');
    await page.waitForTimeout(600);
    const made = await page.evaluate(() => { const c = window.__calls.filter((x) => x.fn === 'createBlankQuotation'); return c.length ? c[0].args[0] : null; });
    ok('Create Quotation starts it with what was filled', !!made && made.machineModel === 'EG 37' && made.validityDays === '30' && !!made.customerId, made);
    ok('and opens the new quotation, the window closed', await page.evaluate(() => document.getElementById('view-quote').classList.contains('active')) &&
      !(await page.evaluate(() => document.getElementById('qv-new-backdrop').classList.contains('show'))) && /499/.test(await page.textContent('#qb-title')));

    console.log('\nQUOTATION PROGRESS');
    // ERP 1's trail for one offer, as getQuotationProgress returns it, kept small.
    await page.evaluate(() => {
      window.__data.getQuotationProgress = (id) => {
        const q = window.__data.listQuotations().find((x) => x.id === id) || {};
        return { quotationId: id, quoteNo: q.quoteNo, businessStream: q.businessStream, customerName: q.customerName, journey: q.journey,
          preparedBy: 'Neha Rao', preparedAt: '2026-10-17', approved: false, approvedBy: '', approvedAt: '', lostReason: '', origin: null,
          revisionCount: 0, revisions: [], order: null, dispatches: [], invoices: [], receipts: [], documents: [] };
      };
    });
    await go('progress');
    ok('the 2.0 page, ERP 1’s picker put away', await shown('#qv-progress') && !(await shown('#progress-picker-card')) && await shown('#btn-progress-download'));
    await page.click('#qv-progress [data-qv-seg="pPer"][data-v="all"]');
    await page.waitForTimeout(200);
    const bars = await page.$$eval('#qv-progress .qv-hbar', (b) => b.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    ok('how far they got, step by step', bars.length === 10 && bars[0] === 'Prepared 8' && bars[1] === 'Approved 7' && bars[5] === 'Sales order 3' && bars[9] === 'Service told 0', bars);
    ok('with the declined and past validity', /0 quotations declined and 1 past validity/.test(await page.textContent('#qv-progress .qv-panel')));
    const r1 = await page.$eval('#qv-progress tbody tr', (r) => r.innerText.replace(/\s+/g, ' '));
    ok('each one’s ten steps, where it is, next, waiting', (await page.$$eval('#qv-progress tbody tr:first-child .qv-strip li', (l) => l.length)) === 10 &&
      /Prepared 1\/10/.test(r1) && /next: Approved/.test(r1) && /\d+ days?/.test(r1), r1);
    await page.click('#qv-progress [data-qv-seg="pStream"][data-v="Spare Sales"]');
    await page.waitForTimeout(200);
    ok('one desk', (await page.$$eval('#qv-progress tbody .qv-desk', (d) => d.map((x) => x.textContent))).every((t) => t !== 'Compressor'));
    await page.click('#qv-progress tbody tr[data-qv-trail]');
    await page.waitForTimeout(600);
    ok('a row opens ERP 1’s trail', await shown('#progress-detail') && !(await shown('#qv-progress')));
    if (await page.$('#btn-progress-back')) {
      await page.click('#btn-progress-back');
      await page.waitForTimeout(300);
      ok('and Back returns to the 2.0 page', await shown('#qv-progress') && !(await shown('#progress-picker-card')));
    }
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
