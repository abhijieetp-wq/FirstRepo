/**
 * ERP 2.0's additions to the enquiry board, in a browser against the real client: the totals
 * (won this month), the stage and owner filters, a lead's area on its card, the card's order
 * tab (order date, the lorry, the invoice), and the area on the 2.0 lead form. On the other
 * faces the lead form has no area.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/board-extras-ui-test.js /tmp/base-v2.html
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    let data;
    Object.defineProperty(window, '__data', { configurable: true, get() { return data; },
      set(v) { if (v && v.bootstrap) v.bootstrap = Object.assign({}, v.bootstrap, { businessStream: 'All' }); data = v; } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  const go = async (view) => { await page.evaluate((v) => document.querySelector('#tabs [data-view="' + v + '"]').click(), view); await page.waitForTimeout(600); };
  const lastCall = (fn) => page.evaluate((f) => {
    const all = window.__calls.filter((c) => c.fn === f);
    return all.length ? all[all.length - 1].args : null;
  }, fn);

  await page.evaluate(() => {
    const D = window.__data;
    const n = new Date();
    const month = n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2);
    const board = D.getEnquiryBoard;
    D.getEnquiryBoard = (o) => {
      const b = board(o);
      b.cards.forEach((c) => { c.area = ''; c.areaType = ''; c.invoice = null; });
      const e4 = b.cards.find((c) => c.ref === 'SE:E4');
      if (e4) {
        e4.stage = 'dispatched';
        e4.order = Object.assign({}, e4.order, { status: 'Dispatched', creditHold: false, date: month + '-05' });
        e4.dispatch = { dispatchNo: 'DN-4', date: month + '-07', status: 'Dispatched', transporter: 'Quickline Roadways', vehicleNo: 'MH31AB1234',
          lrNumber: 'LR-77', lrDate: month + '-07' };
        e4.invoice = { invoiceNo: 'INV/26/0004', date: month + '-07' };
      }
      const l2 = b.cards.find((c) => c.ref === 'LD:L2');
      if (l2) { l2.area = 'Wardha'; l2.areaType = 'Outstation'; }
      return b;
    };
    D.getAreas = [{ name: 'Hingna MIDC', type: 'Local' }, { name: 'Wardha', type: 'Outstation' }];
  });

  if (!v2) {
    console.log('THE OTHER FACES: ERP 1’S LEAD FORM');
    ok('no area on the lead form', !(await page.$('#lm-area')));
  } else {
    console.log('THE BOARD’S TOTALS AND FILTERS');
    await go('enquiries');
    const sum = await page.textContent('#eb-spare .eb-sum');
    ok('open, in play, won this month, late follow-ups', /4 open/.test(sum) && /1 won this month \(₹20,060\)/.test(sum) && /follow-ups past their date/.test(sum), sum);
    await page.selectOption('#eb-spare [data-eb-filter="stage"]', 'sent');
    await page.waitForTimeout(200);
    ok('one stage', (await page.$$eval('#eb-spare [data-eb-stage]', (c) => c.map((x) => x.dataset.ebStage))).join() === 'sent');
    await page.selectOption('#eb-spare [data-eb-filter="stage"]', '');
    await page.selectOption('#eb-spare [data-eb-filter="owner"]', 'd@pie.in');
    await page.waitForTimeout(200);
    ok('one owner', (await page.$$eval('#eb-spare [data-eb-card]', (c) => c.map((x) => x.dataset.ebCard))).join() === 'SE:E2');
    await page.selectOption('#eb-spare [data-eb-filter="owner"]', '');
    await page.waitForTimeout(200);

    console.log('\nTHE CARD’S ORDER TAB');
    await page.click('[data-eb-card="SE:E4"]');
    await page.waitForTimeout(300);
    const facts = (await page.textContent('.eb-facts')).replace(/\s+/g, ' ');
    ok('the order with its date, the lorry and the invoice', /SO\/26\/0004 · Dispatched · PO PO-4 · 05-/.test(facts) &&
      /Quickline Roadways · MH31AB1234 · LR LR-77 of 07-/.test(facts) && /INV\/26\/0004 · 07-/.test(facts), facts);
    await page.click('#eb-m-close');

    console.log('\nA LEAD’S AREA');
    await go('compressor');
    await page.waitForTimeout(300);
    ok('on its card, outstation marked', await page.$eval('[data-eb-card="LD:L2"]', (e) => /Wardha/.test(e.textContent) && !!e.querySelector('.eb-chip.warn')));
    await page.click('[data-eb-card="LD:L2"]');
    await page.waitForTimeout(300);
    ok('and in its window', /Area\s+Wardha · Outstation/.test(await page.$eval('.eb-facts', (e) => e.innerText)));
    await page.click('#eb-m-close');
    ok('the 2.0 lead form asks for it', !!(await page.$('#lm-area')));
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
