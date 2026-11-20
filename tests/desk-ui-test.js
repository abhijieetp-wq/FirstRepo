/**
 * The desk switch in the top bar (StreamAccess.gs, setMyDesk), checked in a browser against
 * the real client: somebody who works both streams sees Compressor, Spares and Combined; on a
 * desk the menu and the quotation pages are that desk's alone; flipping asks the server and
 * opens the page again. Somebody who works one stream is not offered it.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --title="ELGi Sales ERP"
 *   node tests/desk-ui-test.js /tmp/show-v2.html [screenshot.png]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const PREVIEW = process.argv[2];
const SHOT = process.argv[3];
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};

const html = fs.readFileSync(PREVIEW, 'utf8');
const BOOT = /role: "Management", businessStream: "All",/;
if (!BOOT.test(html)) throw new Error('the showcase user is not where this test expects it');
const variant = (name, user) => {
  const file = PREVIEW.replace(/\.html$/, '') + '.desk-' + name + '.html';
  fs.writeFileSync(file, html.replace(BOOT, user));
  return file;
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const open = async (file) => {
    await page.goto('file://' + file);
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      window.__data.setMyDesk = (d) => { window.name = 'desk:' + d; return {}; };
    });
  };
  const desk = () => page.evaluate(() => {
    const b = document.getElementById('desk-switch');
    if (!b) return null;
    return { inBar: !!b.closest('.ws-tools'), visible: !!b.offsetWidth,
      buttons: Array.from(b.querySelectorAll('button')).map((x) => x.textContent + (x.getAttribute('aria-pressed') === 'true' ? '*' : '')).join('|') };
  });
  const menu = (v) => page.evaluate((x) => !!document.querySelector('#tabs [data-view="' + x + '"]'), v);
  const go = async (v) => { await page.evaluate((x) => document.querySelector('#tabs [data-view="' + x + '"]').click(), v); await page.waitForTimeout(700); };
  const text = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText.replace(/\s+/g, ' ').trim() : ''; }, sel);

  console.log('A COORDINATOR OF BOTH, ON THE SPARES DESK');
  await open(variant('spares', 'role: "Sales Coordinator", businessStream: "Spare Sales", homeStream: "All", desk: "Spare Sales",'));
  let d = await desk();
  ok('the switch is in the top bar: Compressor, Spares, Combined, on Spares', !!d && d.inBar && d.visible && d.buttons === 'Compressor|Spares*|Combined', d);
  ok('the menu is the spares desk’s: Spare Sales and SDR, no Compressor Sales', await menu('enquiries') && await menu('servicedue') && !(await menu('compressor')));
  if (SHOT) {
    const box = await page.$eval('#desk-switch', (e) => { const r = e.closest('.ws-tools').getBoundingClientRect(); return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 }; });
    await page.screenshot({ path: SHOT, clip: box });
  }
  await go('quotations');
  ok('All Quotations says whose they are', /^Every offer from the Spares desk\./.test(await text('#view-quotations .page-head p')), await text('#view-quotations .page-head p'));
  ok('and offers no choosing between desks', !(await page.$('[data-qv-seg="stream"]')));
  await go('progress');
  ok('nor does Quotation Progress', !(await page.$('[data-qv-seg="pStream"]')));
  await page.evaluate(() => document.querySelector('#desk-switch [data-desk="Compressor Sales"]').click());
  await page.waitForTimeout(1500);
  ok('pressing Compressor asks the server for that desk and opens the page again', (await page.evaluate(() => window.name)) === 'desk:Compressor Sales' &&
    (await page.evaluate(() => (window.__calls || []).length)) < 40, await page.evaluate(() => window.name));
  await page.evaluate(() => { window.name = ''; });

  console.log('\nTHE SAME PERSON, COMBINED');
  await open(variant('combined', 'role: "Sales Coordinator", businessStream: "All", homeStream: "All", desk: "",'));
  d = await desk();
  ok('Combined is pressed', !!d && d.buttons === 'Compressor|Spares|Combined*', d);
  ok('both desks in the menu', await menu('compressor') && await menu('enquiries'));
  await go('quotations');
  ok('All Quotations is both desks’, with the choosing between them', /^Every offer from both desks\./.test(await text('#view-quotations .page-head p')) &&
    !!(await page.$('[data-qv-seg="stream"]')));
  await page.evaluate(() => document.querySelector('#desk-switch [data-desk="Spare Sales"]').click());
  await page.waitForTimeout(1500);
  ok('pressing Spares asks for it', (await page.evaluate(() => window.name)) === 'desk:Spare Sales');
  await page.evaluate(() => { window.name = ''; });
  await page.evaluate(() => document.querySelector('#desk-switch [data-desk="Spare Sales"]').click());
  await page.waitForTimeout(300);
  ok('the desk they are on is not asked for again', (await page.evaluate(() => window.name)) === '');

  console.log('\nONE STREAM, OR A SERVER FROM BEFORE');
  await open(variant('one', 'role: "Sales Coordinator", businessStream: "Spare Sales", homeStream: "Spare Sales", desk: "",'));
  ok('somebody who works one stream has no switch', await desk() === null);
  await open(PREVIEW);
  ok('nor does a user the server sent without a home stream', await desk() === null);

  console.log('\nA SPARES QUOTATION WITH A COMPRESSOR ON IT, FROM BEFORE');
  await open(PREVIEW);
  await page.evaluate(() => {
    const D = window.__data;
    const line = (n, type, code, desc) => ({ id: 'QI-' + n, lineNo: n, lineType: 'Item', itemType: type, itemId: code, itemCode: code, description: desc,
      qty: 1, unitPrice: 1000, discountPct: 0, taxPct: 18, lineTotal: 1000 });
    const quote = (stream, items) => () => ({ id: 'QT-9', quoteNo: (stream === 'Spare Sales' ? 'SPARE' : 'UNIT') + '/PIE/ELGI/QUOT/26-27/9', revision: 'R0', status: 'Draft',
      businessStream: stream, customerId: 'CU-1', customerName: 'Sahyadri Castings Pvt Ltd', date: '2026-11-20', validityDays: 30, validUntil: '2026-12-20',
      items, subtotal: 2000, discountAmt: 0, taxAmt: 360, grand: 2000, packageDiscountPct: 0, pfAmount: 0, taxMode: 'Extra', discountPctShown: 'BOTH', locked: false,
      ownership: { preparedBy: 'Anil Mehta', approvedBy: '', coordinatorInCharge: '', coordinatorInChargeName: '', youMayAssign: false },
      journey: { label: 'Prepared', nextLabel: 'Approved', reachedIndex: 0, stages: [{ key: 'Prepared', label: 'Prepared', owner: 'Sales desk', done: true, date: '20-11-2026' }] } });
    window.__mk = { quote, line };
    D.getQuotation = quote('Spare Sales', [line(1, 'Spare', 'B900000001', 'Oil filter'), line(2, 'Product', 'S900100', 'EG 37-7.5')]);
    D.listQuotations = () => [Object.assign({ preparedByName: 'Anil Mehta' }, D.getQuotation())];
    D.sparePickerData = () => ({ rows: [], compat: {}, theirCodes: {} });
    D.quotationAccessories = () => ({ accessories: [], compressors: [] });
  });
  await go('quotations');
  await page.evaluate(() => document.querySelector('[data-qv-open]').click());
  await page.waitForTimeout(1200);
  const warn = await text('#qb-stream-warn');
  ok('it says so above the lines, naming the compressor and the way to the unit offer',
    /^This is a spares quotation, so it prints the spares offer, but it carries a compressor \(EG 37-7\.5\)\. .*Business stream Compressor Sales\.$/.test(warn), warn);
  ok('and the picker offers no compressor to add', await page.$eval('#qi-type option[value="Product"]', (o) => o.hidden && o.disabled) &&
    (await page.inputValue('#qi-type')) !== 'Product');
  await page.evaluate(() => { const D = window.__data; D.getQuotation = window.__mk.quote('Compressor Sales', [window.__mk.line(1, 'Product', 'S900100', 'EG 37-7.5')]); });
  await go('quotations');
  await page.evaluate(() => document.querySelector('[data-qv-open]').click());
  await page.waitForTimeout(1200);
  ok('a compressor quotation: no warning, and the compressor is offered', (await page.$eval('#qb-stream-warn', (e) => e.style.display)) === 'none' &&
    await page.$eval('#qi-type option[value="Product"]', (o) => !o.hidden && !o.disabled));

  console.log('\nNEW QUOTATION SAYS WHICH OFFER EACH CHOICE PRINTS');
  await go('quotations');
  await page.evaluate(() => document.getElementById('btn-qv-new').click());
  await page.waitForTimeout(600);
  ok('Compressor Sales: unit offer, then Spare Sales: spares offer', (await page.$$eval('#qs-stream option', (o) => o.map((x) => x.textContent))).join('|') ===
    'Compressor Sales: unit offer|Spare Sales: spares offer');
  await open(variant('spares', 'role: "Sales Coordinator", businessStream: "Spare Sales", homeStream: "All", desk: "Spare Sales",'));
  await go('quotations');
  await page.evaluate(() => document.getElementById('btn-qv-new').click());
  await page.waitForTimeout(600);
  ok('on the spares desk, told to switch to Compressor for a unit quotation', /For a compressor \(unit\) quotation, switch to Compressor at the top first\./.test(await text('#qs-desk-note')),
    await text('#qs-desk-note'));

  ok('no script errors', errors.length === 0, errors);
  await browser.close();
  for (const f of ['spares', 'combined', 'one']) { try { fs.unlinkSync(PREVIEW.replace(/\.html$/, '') + '.desk-' + f + '.html'); } catch (e) { /* gone */ } }
  console.log('\n' + (failures.length ? failures.length + ' FAILED, ' : 'all ') + pass + ' passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
