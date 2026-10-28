/**
 * ERP 2.0's enquiry board, in a browser against the real client: the Spare Sales and
 * Compressor Sales screens open on ERP 2's ten stages, a card opens to where it stands and the
 * ERP 1 records behind it, and the stages set by hand move from there.
 *
 * Only the 2.0 face has it. Run against the current design or the classic face, the same file
 * checks that those screens are exactly ERP 1's lists.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/enquiry-board-ui-test.js /tmp/base-v2.html
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
  // The fixture's coordinator works the spares desk only; this one works both, so Compressor
  // Sales is in the menu too.
  await context.addInitScript(() => {
    let data;
    Object.defineProperty(window, '__data', {
      configurable: true,
      get() { return data; },
      set(v) { if (v && v.bootstrap) v.bootstrap = Object.assign({}, v.bootstrap, { businessStream: 'All' }); data = v; }
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  const go = async (view) => {
    await page.evaluate((v) => document.querySelector('[data-view="' + v + '"]').click(), view);
    await page.waitForTimeout(500);
  };
  const lastCall = (fn) => page.evaluate((f) => {
    const all = window.__calls.filter((c) => c.fn === f);
    return all.length ? all[all.length - 1].args : null;
  }, fn);
  const column = (ref) => page.evaluate((r) => {
    const c = document.querySelector('[data-eb-card="' + r + '"]');
    return c ? c.closest('[data-eb-stage]').dataset.ebStage : null;
  }, ref);
  const shown = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null; }, sel);

  if (!v2) {
    console.log('THE OTHER FACES KEEP ERP 1’S LISTS');
    await go('enquiries');
    ok('no board on Spare Sales', !(await page.$('#eb-spare')) && !(await page.$('#eb-switch-spare')));
    ok('the list is there as before', await shown('#enquiries-tbody'));
    ok('and the board was never asked for', !(await page.evaluate(() => window.__calls.some((c) => c.fn === 'getEnquiryBoard'))));
    await go('compressor');
    ok('no Board tab on Compressor Sales', !(await page.$('#subtab-board')) && !(await page.$('#eb-compressor')));
    ok('Leads is still where it opens', await page.evaluate(() => /btn-primary/.test(document.getElementById('subtab-leads').className)));
  } else {
    console.log('SPARE SALES OPENS ON THE BOARD');
    await go('enquiries');
    const cols = await page.$$eval('#eb-spare [data-eb-stage]', (c) => c.map((x) => x.querySelector('.eb-name').textContent));
    ok('ERP 2’s ten stages, in order', cols.join(' | ') === 'Enquiry received | Requirement understood | Quotation prepared | ' +
      'Quotation sent | In negotiation | Approved by customer | PO received | Sales order (WON) | Material procurement | Dispatched', cols);
    ok('the list is put away meanwhile', !(await shown('#enquiries-tbody')));
    ok('each card in its stage', (await column('SE:E1')) === 'enquiry' && (await column('SE:E3')) === 'sent' &&
      (await column('SE:E4')) === 'po' && (await column('QT:Q6')) === 'quoted');
    ok('a closed card only when closed ones are asked for', (await column('SE:E5')) === null);
    ok('which stages are set by hand', await page.$eval('#eb-spare [data-eb-stage="enquiry"] .eb-chip', (e) => e.textContent) === 'Set by hand' &&
      await page.$eval('#eb-spare [data-eb-stage="sent"] .eb-chip', (e) => e.textContent) === 'Moves by itself');
    ok('a column adds up what is in it', await page.$eval('#eb-spare [data-eb-stage="sent"] .eb-total', (e) => e.textContent) === '₹12,500');
    ok('an AMC renewal says so on its card', /AMC renewal/.test(await page.textContent('[data-eb-card="SE:E3"]')));
    ok('a held order shows on its card', await page.$eval('[data-eb-card="SE:E4"]', (e) => e.classList.contains('hold')) &&
      /credit hold/.test(await page.textContent('[data-eb-card="SE:E4"]')));
    ok('a quotation with no enquiry says so', /No enquiry/.test(await page.textContent('[data-eb-card="QT:Q6"]')));
    ok('a date gone by stands out', await page.$eval('[data-eb-card="SE:E1"] .eb-fu', (e) => e.classList.contains('late')));
    await page.check('#enquiry-closed');
    await page.waitForTimeout(300);
    ok('Include closed adds the closed column, with the reason', (await column('SE:E5')) === 'lost' &&
      /Price too high/.test(await page.textContent('[data-eb-card="SE:E5"]')));
    await page.uncheck('#enquiry-closed');
    await page.waitForTimeout(300);
    await page.check('#enquiry-mine');
    await page.waitForTimeout(300);
    ok('Only mine leaves my cards', (await column('SE:E2')) === null && (await column('SE:E1')) === 'enquiry');
    await page.uncheck('#enquiry-mine');
    await page.waitForTimeout(300);
    await page.fill('#enquiry-search', 'SPARE/26/0006');
    await page.waitForTimeout(150);
    ok('the search finds by quotation number too', (await page.$$('#eb-spare [data-eb-card]')).length === 1 && (await column('QT:Q6')) === 'quoted');
    await page.fill('#enquiry-search', '');
    await page.waitForTimeout(150);

    console.log('\nBOARD OR LIST, REMEMBERED');
    await page.click('#eb-switch-spare [data-eb-mode="list"]');
    await page.waitForTimeout(400);
    ok('List brings ERP 1’s table back', await shown('#enquiries-tbody') && !(await shown('#eb-spare')));
    await page.reload();
    await page.waitForTimeout(1200);
    await go('enquiries');
    ok('and this browser keeps the list next time', await shown('#enquiries-tbody') && !(await shown('#eb-spare')));
    await page.click('#eb-switch-spare [data-eb-mode="board"]');
    await page.waitForTimeout(500);
    ok('Board brings it back', await shown('#eb-spare') && (await column('SE:E1')) === 'enquiry');

    console.log('\nA CARD, OPENED');
    await page.click('[data-eb-card="SE:E1"]');
    await page.waitForTimeout(300);
    ok('opens where it stands', await page.evaluate(() => document.getElementById('eb-modal-backdrop').classList.contains('show')) &&
      await page.$eval('.eb-steps li.now', (e) => e.textContent) === 'Enquiry received');
    ok('with the customer and what it is', (await page.textContent('#eb-m-title')) === 'Topworth Urja' &&
      /Spare enquiry · SE2610-0001/.test(await page.textContent('#eb-m-kind')));
    await page.evaluate(() => { window.__calls = []; });
    await page.click('[data-eb-move="requirement"]');
    await page.waitForTimeout(300);
    ok('a hand-set stage moves on from the card', JSON.stringify(await lastCall('moveBoardCard')) ===
      JSON.stringify([{ ref: 'SE:E1', to: 'requirement', note: '' }]), await lastCall('moveBoardCard'));
    ok('the card goes to its new column', (await column('SE:E1')) === 'requirement');
    ok('and the window follows', await page.$eval('.eb-steps li.now', (e) => e.textContent) === 'Requirement understood' &&
      !!(await page.$('[data-eb-move="enquiry"]')));
    await page.click('#eb-m-close');
    await page.click('[data-eb-card="SE:E3"]');
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.__calls = []; });
    await page.click('[data-eb-move="negotiation"]');
    await page.waitForTimeout(200);
    ok('negotiation asks what is being discussed', await page.evaluate(() => document.getElementById('ask-modal-backdrop').classList.contains('show')));
    await page.click('#ask-cancel');
    await page.waitForTimeout(200);
    ok('and cancelling moves nothing', !(await lastCall('moveBoardCard')));
    await page.click('[data-eb-move="negotiation"]');
    await page.waitForTimeout(200);
    await page.fill('#ask-input', 'no');
    await page.click('#ask-ok');
    ok('a word or two is not enough', /few words/.test(await page.textContent('#ask-error')) && !(await lastCall('moveBoardCard')));
    await page.fill('#ask-input', 'Wants 5% off the AMC');
    await page.click('#ask-ok');
    await page.waitForTimeout(300);
    ok('the note goes with the move', JSON.stringify(await lastCall('moveBoardCard')) ===
      JSON.stringify([{ ref: 'SE:E3', to: 'negotiation', note: 'Wants 5% off the AMC' }]) && (await column('SE:E3')) === 'negotiation');
    ok('the stage after it is not offered by hand', !(await page.$('[data-eb-move="approved"]')));
    await page.click('[data-eb-go="quotation"]');
    await page.waitForTimeout(600);
    ok('Open quotation goes to ERP 1’s quotation', await page.evaluate(() => document.querySelector('.view.active').id) === 'view-quote' &&
      !(await page.evaluate(() => document.getElementById('eb-modal-backdrop').classList.contains('show'))));

    console.log('\nCOMPRESSOR SALES TOO');
    await go('compressor');
    ok('opens on its Board tab', await page.evaluate(() => /btn-primary/.test(document.getElementById('subtab-board').className)) &&
      await shown('#eb-compressor') && !(await shown('#cs-tbody')));
    ok('with its own cards', (await column('LD:L1')) === 'enquiry' && (await column('LD:L2')) === 'negotiation' &&
      !(await page.$('#eb-compressor [data-eb-card="SE:E1"]')));
    await page.click('#subtab-leads');
    await page.waitForTimeout(400);
    ok('Leads is ERP 1’s list, as it was', await shown('#cs-tbody') && !(await shown('#eb-compressor')));
    await page.click('#subtab-board');
    await page.waitForTimeout(400);
    ok('and Board comes back', await shown('#eb-compressor') && (await column('LD:L1')) === 'enquiry');
  }
  ok('with no script errors', errors.length === 0, errors);

  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
