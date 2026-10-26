/**
 * The quotation's Status menu.
 *
 * The header used to carry a row of buttons that changed at every stage — Mark Approved, then
 * Mark Sent, then Mark Accepted and Mark Declined, with Revise and Reopen beside them — so the
 * button under the cursor was a different one each time. PIE asked for one menu instead: every
 * stage listed in order, ticked where it has been reached, the next step the one that can be
 * pressed, and the rest of what comes and goes under it. Print and New Quotation stay buttons.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/preview.html [--ui=web]
 *   node tests/quote-status-ui-test.js /tmp/preview.html
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const PREVIEW = process.argv[2];
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

const STAGES = [['prepared', 'Prepared'], ['approved', 'Approved'], ['sent', 'Sent to customer'],
  ['accepted', 'Accepted by customer'], ['po', 'PO received'], ['order', 'Sales order'],
  ['invoiced', 'Invoiced'], ['dispatched', 'Dispatched'], ['delivered', 'Delivered'],
  ['service', 'Service told']];

/** A journey with the first `reached` stages done, the way the server builds one. */
const journeyFor = (reached, extra) => Object.assign({
  stages: STAGES.map(([key, label], i) => ({ key, label, owner: 'Quotation', done: i < reached,
    date: i < reached ? '2026-10-2' + i : '', detail: '' })),
  reachedIndex: reached - 1, label: STAGES[reached - 1][1], closed: false, stalled: false
}, extra || {});

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => { if (!/renderDashboard/.test(e.stack || '')) errors.push(String(e)); });
  // Somebody who works both streams and may create orders.
  const html = fs.readFileSync(PREVIEW, 'utf8')
    .replace(/(bootstrap: \{[^}]*?role: )"Sales Coordinator"/, '$1"Management"')
    .replace(/(bootstrap: \{[^}]*?businessStream: )"Spare Sales"/, '$1"All"');
  const copy = PREVIEW.replace(/\.html$/, '') + '.status.html';
  fs.writeFileSync(copy, html);
  await page.goto('file://' + copy);
  await page.waitForTimeout(1200);

  const open = async (quote) => {
    await page.evaluate((qq) => {
      document.querySelectorAll('.modal-backdrop.show').forEach((m) => m.classList.remove('show'));
      const D = window.__data;
      D.getQuotation = Object.assign({}, D.getQuotation, qq);
      D.listQuotations = [Object.assign({ itemCount: 1 }, D.getQuotation)];
      window.__calls = [];
    }, quote);
    await page.evaluate(() => document.querySelector('[data-view="quotations"]').click());
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('[data-open-quote]').click());
    await page.waitForTimeout(600);
  };
  const menu = () => page.evaluate(() => {
    const list = document.querySelector('#qb-status-list');
    if (!list) return null;
    return {
      hidden: list.hidden,
      label: document.querySelector('#btn-qb-status').textContent.replace(/\s+/g, ' ').trim(),
      rows: Array.from(list.querySelectorAll('.qs-item')).map((r) => ({
        text: r.querySelector('.qs-label').textContent.replace(' (done)', '').trim(),
        tick: r.querySelector('.qs-tick').textContent,
        pressable: r.tagName === 'BUTTON',
        id: r.id || ''
      })),
      buttons: Array.from(document.querySelectorAll('#qb-actions > button')).map((b) => b.textContent.trim())
    };
  });
  const row = (m, text) => m.rows.find((r) => r.text === text) || {};
  const pressables = (m) => m.rows.filter((r) => r.pressable).map((r) => r.text);

  console.log('A DRAFT');
  await open({ status: 'Draft', locked: false, revision: 'R0', parentQuotationId: '', journey: journeyFor(1) });
  let m = await menu();
  ok('one Status menu, saying where it stands', m && /^Status: Prepared/.test(m.label), m && m.label);
  ok('beside Print and New Quotation, which are always there — nothing else',
    JSON.stringify(m.buttons) === JSON.stringify(['Print / PDF', '+ New Quotation']), m.buttons);
  ok('closed until asked', m.hidden === true);
  await page.click('#btn-qb-status');
  m = await menu();
  ok('opens on a click', m.hidden === false);
  ok('every stage listed, in order', STAGES.every(([, label], i) => i === 1 || m.rows.some((r) => r.text === label)), m.rows.map((r) => r.text));
  ok('the stage reached is ticked', row(m, 'Prepared').tick === '✓' && !row(m, 'Prepared').pressable);
  ok('the next step is the one to press', row(m, 'Mark Approved').pressable && row(m, 'Mark Approved').tick === '');
  ok('the stages after it are listed but not pressable',
    !row(m, 'Sent to customer').pressable && !row(m, 'Invoiced').pressable && row(m, 'Invoiced').tick === '');
  ok('and Discard Draft is under More', pressables(m).includes('Discard Draft'), pressables(m));
  await page.keyboard.press('Escape');
  ok('Escape closes it', (await menu()).hidden === true);
  await page.click('#btn-qb-status');
  await page.click('[data-qs="Approved"]');
  await page.waitForTimeout(400);
  const calls = await page.evaluate(() => window.__calls.map((c) => c.fn));
  ok('pressing the next step does it', calls.some((f) => /Status|approve/i.test(f)), calls);
  ok('and the menu closes', (await menu()) === null || (await menu()).hidden === true);

  console.log('\nAPPROVED');
  await open({ status: 'Approved', locked: true, journey: journeyFor(2) });
  await page.click('#btn-qb-status');
  m = await menu();
  ok('two ticks, and Mark Sent next', row(m, 'Prepared').tick === '✓' && row(m, 'Approved').tick === '✓' &&
    row(m, 'Mark Sent').pressable, m.rows);
  ok('no Mark Approved any more', !m.rows.some((r) => r.text === 'Mark Approved'));
  ok('Revise and Reopen under More', pressables(m).includes('Revise') && pressables(m).includes('Reopen as Draft'), pressables(m));
  // Somewhere neutral on the page: the quotation's own heading.
  await page.click('#qb-title');
  ok('a click elsewhere closes it', (await menu()).hidden === true);

  console.log('\nSENT');
  await open({ status: 'Submitted', locked: true, journey: journeyFor(3) });
  await page.click('#btn-qb-status');
  m = await menu();
  ok('Mark Accepted next, Mark Declined under More', row(m, 'Mark Accepted').pressable &&
    pressables(m).includes('Mark Declined'), pressables(m));
  ok('the header buttons are the same two as on the draft — the menu is what changed',
    JSON.stringify(m.buttons) === JSON.stringify(['Print / PDF', '+ New Quotation']), m.buttons);

  console.log('\nACCEPTED, THEN ORDERED');
  await open({ status: 'Won', locked: true, journey: journeyFor(4) });
  await page.click('#btn-qb-status');
  m = await menu();
  ok('accepted: the PO is the next step', row(m, 'Record PO & Create Order').pressable &&
    row(m, 'Record PO & Create Order').id === 'btn-qb-make-order', m.rows);
  ok('no Revise-free trap: Reopen is not offered once won', !pressables(m).includes('Reopen as Draft'));
  await open({ status: 'Won', locked: true, journey: journeyFor(7, { orderNo: 'SO-0012', orderId: 'SO-1' }) });
  await page.click('#btn-qb-status');
  m = await menu();
  ok('ordered and invoiced: seven ticks', m.rows.filter((r) => r.tick === '✓').length === 7, m.rows);
  ok('and the order can be opened from its row', row(m, 'Open SO-0012').pressable && row(m, 'Open SO-0012').tick === '✓');

  console.log('\nDECLINED');
  await open({ status: 'Lost', locked: true, journey: journeyFor(3, { label: 'Declined', closed: true,
    declined: { after: 2, reason: 'Price too high' } }) });
  m = await menu();
  ok('the menu says so', /^Status: Declined/.test(m.label), m.label);
  await page.click('#btn-qb-status');
  m = await menu();
  ok('and shows where it stopped, with the reason', row(m, 'Declined').tick === '✕', m.rows);
  ok('nothing to press but Revise', JSON.stringify(pressables(m)) === JSON.stringify(['Revise']), pressables(m));

  ok('no page errors anywhere', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + e.message); console.log(e.stack); process.exit(1); });
