/**
 * ERP 2.0's quotation page, laid out as the 2.0 demo has it, in a browser against the real
 * client: the kind of offer over its number, the progress strip in its own panel, who prepared
 * and approved it, Customer and Offer details side by side with ERP 1's own fields in them,
 * the items, and the totals beside what the customer receives. Saving still goes through ERP 1's
 * own button; a locked offer says so. The other faces keep ERP 1's page as it was.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/quote-builder-v2-ui-test.js /tmp/base-v2.html
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
  const shown = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null; }, sel);
  const inside = (panel, ids) => page.evaluate((a) => a[1].every((id) => { const el = document.getElementById(id); return !!el && !!el.closest('#' + a[0]); }), [panel, ids]);

  // One spares offer with lines, a journey and owners; the base fixture's own is empty.
  await page.evaluate(() => {
    const D = window.__data;
    const stages = ['Prepared', 'Approved', 'Sent to customer', 'Accepted by customer', 'PO received', 'Sales order', 'Invoiced', 'Dispatched', 'Delivered', 'Service told'];
    const base = D.getQuotation;
    window.__quote = (extra) => Object.assign({}, base, {
      machineModel: 'EG 37', serialNo: 'FAB-77', subtotal: 33100, discountAmt: 0, taxAmt: 5958, grand: 33100,
      items: [{ id: 'QI-1', lineNo: 1, itemCode: '2205190474', description: 'Air-oil separator element', qty: 1, unitPrice: 18400, discountPct: 0, taxPct: 18, lineTotal: 18400, lineType: 'Item' },
        { id: 'QI-2', lineNo: 2, itemCode: '', description: 'Carting', qty: 1, unitPrice: 1500, discountPct: 0, taxPct: 18, lineTotal: 1500, lineType: 'Charge' }],
      ownership: { preparedBy: 'Priya Deshmukh', approvedBy: '', coordinatorInCharge: 'p@pie.in', coordinatorInChargeName: 'Priya Deshmukh', youMayAssign: false },
      journey: { label: 'Prepared', nextLabel: 'Approved', reachedIndex: 0,
        stages: stages.map((l, i) => ({ key: l, label: l, owner: 'Sales desk', done: i === 0, date: i === 0 ? '06-10-2026' : '' })) }
    }, extra || {});
    D.getQuotation = () => window.__quote();
    D.saveQuotationHeader = () => window.__quote();
    D.listQuotations = () => [Object.assign({ preparedByName: 'Priya' }, window.__quote())];
  });
  await page.evaluate(() => document.querySelector('#tabs [data-view="quotations"]').click());
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelector('[data-qv-open], [data-open-quote]').click());
  await page.waitForTimeout(900);

  if (!v2) {
    console.log('THE OTHER FACES');
    ok('ERP 1’s quotation page as it was', await shown('#qb-body') && !(await page.$('#qbv-customer')) &&
      await page.evaluate(() => document.getElementById('qb-customer').closest('.card').offsetParent !== null));
  } else {
    console.log('THE HEADING');
    ok('the kind of offer over its number, and the customer, date and machine', (await page.textContent('#qbv-eyebrow')) === 'Spares offer' &&
      await page.$eval('#qb-title', (e) => e.classList.contains('qbv-no')) && (await page.textContent('#qb-subtitle')) === 'Topworth Urja · 6 Oct 2026 · EG 37 · FAB-77');
    ok('the breadcrumb names the quotation, and All Quotations stays lit', /PIE\/ELGI\/QUOT\/26-27\/401/.test(await page.textContent('#ws-crumb-page')) &&
      await page.$eval('#tabs [data-view].active', (b) => b.dataset.view) === 'quotations');

    console.log('\nTHE PANELS, IN THE DEMO’S ORDER');
    const order = await page.$$eval('#qb-body > *', (els) => els.filter((e) => e.offsetParent !== null).map((e) => e.id || e.className.split(' ')[0]));
    ok('progress, owners, customer and offer, items, totals and what they receive', order.join('|') ===
      'qbv-progress|qb-ownership|qbv-split|card|qbv-split', order);
    ok('the progress strip, with where it is and what is next', await inside('qbv-progress', ['qb-journey']) &&
      (await page.$eval('#qbv-progress .qbv-note', (e) => e.textContent)) === 'Prepared · next: Approved' &&
      (await page.$$('#qbv-progress .jstep')).length === 10);
    ok('who prepared it and who approves', /Prepared by\s*Priya Deshmukh/.test(await page.textContent('#qb-ownership')) && /not yet approved/.test(await page.textContent('#qb-ownership')));
    ok('the customer, with ERP 1’s own fields', await inside('qbv-customer', ['qb-customer', 'qb-gstin', 'qb-model', 'qb-serial', 'qb-contact', 'qb-billaddr', 'qb-shipaddr']) &&
      await page.inputValue('#qb-serial') === 'FAB-77');
    ok('the offer’s terms beside it, printed on the offer', await inside('qbv-offer', ['qb-date', 'qb-validity', 'qb-validuntil', 'qb-paymentterms', 'qb-deliveryterms',
      'qb-deliveryperiod', 'qb-warrantyterms', 'qb-taxmode', 'qb-notes', 'btn-qb-save-header']) && /Printed on the offer/.test(await page.textContent('#qbv-offer header')));
    ok('the items, ERP 1’s table and buttons', (await page.$$('.qbv-items #qb-items tbody tr')).length === 2 && await shown('#btn-qb-add-item') && await shown('#btn-qb-add-charge'));
    ok('the totals: package discount, P&F, the sums and GST', await inside('qbv-totals', ['qb-pkgdisc', 'qb-pf', 'qb-totals']) &&
      /Grand Total/.test(await page.textContent('#qb-totals')) && /GST extra/.test(await page.textContent('#qbv-totals header')));
    ok('what a spares customer receives', (await page.$$eval('#qbv-receives li', (l) => l.map((x) => x.textContent))).join('|') ===
      'Offer letter on PIE letterhead|Price schedule with part numbers|Terms');
    ok('ERP 1’s long card is put away, empty', await page.evaluate(() => { const c = document.querySelector('#qb-body > .card:not(.qbv-items)'); return !!c && c.style.display === 'none' && !c.querySelector('input'); }));

    console.log('\nSAVING, AND A LOCKED OFFER');
    await page.fill('#qb-pf', '750');
    await page.evaluate(() => { window.__calls = []; });
    await page.click('#btn-qbv-save-totals');
    await page.waitForTimeout(400);
    const saved = await page.evaluate(() => { const c = window.__calls.filter((x) => x.fn === 'saveQuotationHeader'); return c.length ? c[c.length - 1].args : null; });
    ok('Save under the totals saves the offer’s details through ERP 1’s button', !!saved && JSON.stringify(saved).indexOf('750') !== -1, saved);
    await page.evaluate(() => {
      window.__data.getQuotation = () => window.__quote({ status: 'Approved', locked: true, businessStream: 'Compressor Sales' });
    });
    await page.evaluate(() => document.querySelector('#tabs [data-view="quotations"]').click());
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('[data-qv-open], [data-open-quote]').click());
    await page.waitForTimeout(900);
    ok('a locked offer says so, and nothing offers to save', /Locked\. Revise to change\./.test(await page.textContent('#qbv-offer header')) &&
      !(await shown('#btn-qb-save-header')) && !(await shown('#btn-qbv-save-totals')));
    ok('a compressor offer is named so, with its four documents', (await page.textContent('#qbv-eyebrow')) === 'Compressor offer' &&
      (await page.$$('#qbv-receives li')).length === 4);
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
