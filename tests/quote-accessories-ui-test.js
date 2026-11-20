/**
 * A unit quotation's accessories, in a browser against the real client (Spares.gs,
 * quotationAccessories): under the items, the accessories that suit each compressor (the right
 * size first, per type) to tick and add; the picker's Accessory choice listing the accessories
 * alone; and New quotation offering Compressor Sales and Spare Sales to somebody who works both.
 *
 * Customers, machines and filters are invented.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --title="ELGi Sales ERP"
 *   node tests/quote-accessories-ui-test.js /tmp/show-v2.html [screenshot.png]
 */
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const PREVIEW = process.argv[2];
const SHOT = process.argv[3] || '';
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e) + ' @ ' + String(e.stack).split('\n').slice(1, 3).join(' | ')));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const text = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText.replace(/\s+/g, ' ').trim() : ''; }, sel);

  await page.evaluate(() => {
    const D = window.__data;
    const acc = (id, tpl, type, model, cfm, bar, price) => ({ id, partNo: tpl, type, title: type + ' ' + model, model,
      capacity: cfm + ' cfm', maxPressure: bar + ' bar', workingPressure: '7 bar', weight: '', hsnCode: '', gstPct: '', price, cfm, bar });
    const all = [
      acc('A1', 'B900000001', 'Fine Filter', 'AF 0177F', 177, 20, null), acc('A2', 'B900000002', 'Fine Filter', 'AF 0235F', 235, 20, null),
      acc('A3', 'B900000003', 'Fine Filter', 'AF 0294F', 294, 20, null), acc('A4', 'B900000004', 'Fine Filter', 'AF 0420F', 420, 20, null),
      acc('A5', 'B900000005', 'Pre Filter', 'AF 0177P', 177, 20, 9800), acc('A6', 'B900000006', 'Pre Filter', 'AF 0132P', 132, 20, 7600)
    ];
    window.__quoteLines = [{ id: 'QI-1', lineNo: 1, lineType: 'Item', itemType: 'Product', itemId: 'PR-EG37', itemCode: 'S019400',
      description: 'EG 37-7.5', qty: 1, unitPrice: 1508000, discountPct: 0, taxPct: 18, lineTotal: 1508000, cfm: '', catalogCfm: 160 }];
    const quote = () => ({ id: 'QT-77', quoteNo: 'PIE/ELGI/QUOT/26-27/477', revision: 'R0', status: 'Draft', businessStream: 'Compressor Sales',
      customerId: 'CU-1', customerName: 'Sahyadri Castings Pvt Ltd', date: '2026-11-18', validityDays: 30, validUntil: '2026-12-18',
      machineModel: 'EG 37-7.5', serialNo: '', items: window.__quoteLines.slice(), subtotal: 1508000, discountAmt: 0, taxAmt: 271440, grand: 1508000,
      packageDiscountPct: 0, pfAmount: 0, taxMode: 'Extra', discountPctShown: 'BOTH', locked: false,
      ownership: { preparedBy: 'Anil Mehta', approvedBy: '', coordinatorInCharge: '', coordinatorInChargeName: '', youMayAssign: false },
      journey: { label: 'Prepared', nextLabel: 'Approved', reachedIndex: 0, stages: [{ key: 'Prepared', label: 'Prepared', owner: 'Sales desk', done: true, date: '18-11-2026' }] } });
    D.getQuotation = () => quote();
    D.sparePickerData = () => ({ rows: [], compat: {}, theirCodes: {} });
    D.listQuotations = () => [Object.assign({ preparedByName: 'Anil Mehta' }, quote())];
    window.__accAsked = 0;
    D.quotationAccessories = (id) => { window.__accAsked++; return { accessories: all,
      compressors: [{ itemId: 'PR-EG37', model: 'EG 37-7.5', cfm: 160, bar: 7.5,
        suits: [{ type: 'Fine Filter', items: ['A1', 'A2', 'A3'] }, { type: 'Pre Filter', items: ['A5'] }] }] }; };
    D.saveQuotationItems = (input) => {
      input.lines.forEach((l, i) => { const a = all.find((x) => x.id === l.itemId);
        window.__quoteLines.push({ id: 'QI-A' + i, lineNo: window.__quoteLines.length + 1, lineType: 'Item', itemType: 'Spare', itemId: a.id, itemCode: a.partNo,
          description: a.title, qty: 1, unitPrice: a.price || 0, discountPct: 0, taxPct: 18, lineTotal: a.price || 0 }); });
      return quote();
    };
  });
  await page.evaluate(() => document.querySelector('#tabs [data-view="quotations"]').click());
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelector('[data-qv-open], [data-open-quote]').click());
  await page.waitForTimeout(1200);

  console.log('ACCESSORIES THAT SUIT THE COMPRESSOR');
  const panel = '#qbv-acc';
  ok('a table under the items, on a unit quotation', await page.isVisible(panel) && /Accessories that suit this compressor/.test(await text(panel + ' header')) &&
    await page.evaluate(() => { const a = document.getElementById('qbv-acc'); const i = document.getElementById('qb-items').closest('.card'); return !!a && (i.compareDocumentPosition(a) & 4) !== 0; }));
  ok('saying which machine and what it needs', /For EG 37-7\.5 · needs 160 cfm, 7\.5 bar/.test(await text(panel)), await text(panel));
  const rows = await page.$$eval(panel + ' tbody tr', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
  ok('per type the smallest that fit, the first the right size: TPL, model, capacity, pressure, price', rows.length === 4 &&
    /^Fine Filter right size B900000001 AF 0177F 177 cfm 20 bar no price yet$/.test(rows[0]) && /^Pre Filter right size B900000005 AF 0177P 177 cfm 20 bar ₹9,800/.test(rows[3]) &&
    !rows.some((r) => /AF 0420F|AF 0132P/.test(r)), rows);
  ok('nothing ticked, nothing to add', await page.$eval('#btn-qbacc-add', (b) => b.disabled));
  if (SHOT) { const el = await page.$(panel); if (el) await el.screenshot({ path: SHOT }); }
  await page.check(panel + ' [data-qbacc="A1"]');
  await page.check(panel + ' [data-qbacc="A5"]');
  ok('ticking counts them', (await page.textContent('#btn-qbacc-add')) === 'Add 2 ticked');
  await page.evaluate(() => { window.__calls = []; });
  await page.click('#btn-qbacc-add');
  await page.waitForTimeout(600);
  const sent = await page.evaluate(() => (window.__calls.find((c) => c.fn === 'saveQuotationItems') || {}).args);
  ok('added in one go, as accessories (spares) on this quotation', sent && sent[0].quotationId === 'QT-77' &&
    JSON.stringify(sent[0].lines.map((l) => [l.itemType, l.itemId, l.qty])) === JSON.stringify([['Spare', 'A1', 1], ['Spare', 'A5', 1]]), sent);
  ok('they show as on the offer, and the list is not fetched again', /On the offer/.test(await text(panel + ' tbody tr:nth-child(1)')) &&
    (await page.evaluate(() => window.__accAsked)) === 1);

  console.log('\nTHE ACCESSORY CHOICE WHEN ADDING AN ITEM');
  await page.click('#btn-qb-add-item');
  await page.waitForTimeout(300);
  ok('Accessory beside Spare Part and Compressor', (await page.$$eval('#qi-type option', (o) => o.map((x) => x.textContent))).join('|') === 'Spare Part|Compressor|Accessory');
  await page.selectOption('#qi-type', 'Accessory');
  await page.fill('#qi-search', 'pre filter');
  await page.waitForTimeout(400);
  const found = await page.$$eval('#qi-results tbody tr', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
  ok('only the accessories, searched by type, model or TPL, with what they are rated for', found.length === 2 &&
    found.every((r) => /Pre Filter AF 0(177|132)P/.test(r)) && /132 cfm · 20 bar/.test(found.join(' ')) &&
    !(await page.$$eval('#qi-results thead th', (t) => t.map((x) => x.textContent))).includes('Fit'), found);
  ok('no group filter for accessories', !(await page.isVisible('#qi-group-field')));

  console.log('\nAN ACCESSORY WITH NO PRICE AND NO HSN');
  await page.evaluate(() => {
    const D = window.__data;
    D.completeCatalogDetails = (input) => ({ code: 'B900000003', savedToCatalog: input.price !== '' ? ['selling price'] : [] });
    D.saveQuotationItem = () => ({ id: 'QT-77', quoteNo: 'x', revision: 'R0', status: 'Draft', businessStream: 'Compressor Sales', items: window.__quoteLines.slice(), locked: false,
      ownership: { preparedBy: 'Anil Mehta' }, journey: { stages: [] } });
  });
  await page.selectOption('#qi-type', 'Accessory');
  await page.fill('#qi-search', '0294F');
  await page.waitForTimeout(400);
  await page.click('#qi-results [data-add-line="A3"]');
  await page.waitForTimeout(300);
  ok('it asks for the price, and the HSN only if known', await page.isVisible('#qi-complete') && /HSN Code \(if known\)/.test(await text('#qi-complete-hsn-field')) &&
    /Leave the HSN blank if you do not know it: the line goes on all the same\./.test(await text('#qi-complete-note')), await text('#qi-complete-note'));
  await page.fill('#qi-complete-price', '7600');
  await page.evaluate(() => { window.__calls = []; });
  await page.click('#btn-qi-complete-add');
  await page.waitForTimeout(600);
  const added = await page.evaluate(() => (window.__calls.find((c) => c.fn === 'saveQuotationItem') || {}).args);
  ok('with no HSN it goes on all the same, at the price typed', !!added && added[0].itemId === 'A3' && Number(added[0].unitPrice) === 7600 && added[0].hsnCode === '', added);

  console.log('\nEACH COMPRESSOR’S CFM ON ITS LINE');
  await page.evaluate(() => document.querySelector('#tabs [data-view="quotations"]').click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('[data-qv-open]').click());
  await page.waitForTimeout(1000);
  ok('a CFM column on a unit quotation', (await page.$$eval('#qb-items thead th', (t) => t.map((x) => x.textContent))).includes('CFM'));
  ok('the compressor shows the catalogue’s, ready to change', (await page.inputValue('[data-cfm-line="QI-1"]')) === '160' &&
    !(await page.$eval('[data-cfm-line="QI-1"]', (e) => e.classList.contains('need'))));
  await page.evaluate(() => { window.__calls = []; window.__data.saveQuotationLineCfm = () => window.__data.getQuotation(); });
  await page.fill('[data-cfm-line="QI-1"]', '200');
  await page.dispatchEvent('[data-cfm-line="QI-1"]', 'change');
  await page.waitForTimeout(500);
  const cfmSent = await page.evaluate(() => (window.__calls.find((c) => c.fn === 'saveQuotationLineCfm') || {}).args);
  ok('changed, it is saved for that line', !!cfmSent && cfmSent[0].quotationId === 'QT-77' && cfmSent[0].id === 'QI-1' && cfmSent[0].cfm === '200', cfmSent);
  await page.evaluate(() => {
    window.__quoteLines[0].catalogCfm = null;
    window.__data.quotationAccessories = () => ({ accessories: [], compressors: [{ itemId: 'PR-EG37', lineId: 'QI-1', model: 'EG 37-7.5', cfm: null, bar: 7.5, suits: [] }] });
  });
  await page.evaluate(() => document.querySelector('#tabs [data-view="quotations"]').click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('[data-qv-open]').click());
  await page.waitForTimeout(1000);
  ok('one the catalogue has none for asks for it', (await page.inputValue('[data-cfm-line="QI-1"]')) === '' &&
    await page.$eval('[data-cfm-line="QI-1"]', (e) => e.classList.contains('need') && e.placeholder === 'cfm'));
  ok('and the accessories say to type it, rather than guessing', /Type this compressor’s air flow in the CFM box on its line above/.test(await text('#qbv-acc')), await text('#qbv-acc'));

  console.log('\nNEW QUOTATION: EITHER DESK, FOR SOMEBODY WHO WORKS BOTH');
  await page.evaluate(() => document.querySelector('#tabs [data-view="quotations"]').click());
  await page.waitForTimeout(600);
  await page.click('#btn-qv-new');
  await page.waitForTimeout(500);
  ok('Compressor Sales and Spare Sales to choose from', (await page.$$eval('#qs-stream option', (o) => o.map((x) => x.value))).join('|') === 'Compressor Sales|Spare Sales',
    await page.$$eval('#qs-stream option', (o) => o.map((x) => x.value)));
  await page.selectOption('#qs-stream', 'Spare Sales');
  await page.waitForTimeout(100);
  ok('a spares one does not ask for the machine first', !(await page.isVisible('#qs-model')));

  ok('no page errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
