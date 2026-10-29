/**
 * ERP 2.0's escalations, in a browser against the real client: the Escalations screen, an
 * escalation answered with Management's decision, withdrawn, and opened at its record; a
 * board card escalated to a named person, carrying the one waiting and the earlier ones, and
 * answered from the card; and a coordinator's reply. Only the 2.0 face has it; the others must
 * not offer it at all.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/escalations-ui-test.js /tmp/base-v2.html
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
  // Management, who decides.
  await context.addInitScript(() => {
    let data;
    Object.defineProperty(window, '__data', { configurable: true, get() { return data; },
      set(v) {
        if (v && v.bootstrap) v.bootstrap = Object.assign({}, v.bootstrap, { role: 'Management', businessStream: 'All', email: 'mona@pie.in', name: 'Mona' });
        data = v;
      } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + PREVIEW);
  await page.waitForTimeout(1200);
  const v2 = await page.evaluate(() => document.documentElement.getAttribute('data-face') === 'v2');
  const lastCall = (fn) => page.evaluate((f) => {
    const all = window.__calls.filter((c) => c.fn === f);
    return all.length ? all[all.length - 1].args : null;
  }, fn);
  const active = () => page.evaluate(() => document.querySelector('.view.active').id);
  const shown = (id) => page.$eval('#' + id, (e) => e.classList.contains('show'));
  const msg = () => page.textContent('#msg-box');
  const reset = () => page.evaluate(() => { window.__calls = []; });
  const go = async (view) => { await page.evaluate((v) => document.querySelector('#tabs [data-view="' + v + '"]').click(), view); await page.waitForTimeout(500); };

  if (!v2) {
    console.log('THE OTHER FACES HAVE NO ESCALATIONS');
    ok('not in the menu', !(await page.$('#tabs [data-view="escalations"]')));
    ok('no screen for it', !(await page.$('#view-escalations')));
    ok('and no escalation windows', !(await page.$('#esc-modal-backdrop')) && !(await page.$('#esc-raise-backdrop')));
  } else {
    await page.evaluate(() => {
      const D = window.__data;
      const DECIDE = ['Sent back', 'Approved', 'Won', 'Lost'];
      const x = (id, extra) => Object.assign({ id, cardRef: 'SE:E1', kind: 'enquiry', recordId: 'E1', label: 'SE2610-0001', word: 'Spare enquiry',
        stream: 'Spare Sales', desk: 'Spares', customerName: 'Topworth Urja', ownerName: 'Priya', value: 96000, raisedByEmail: 'p@pie.in',
        raisedByName: 'Priya', raisedDay: '2026-10-28', toEmail: 'mona@pie.in', toName: 'Mona', note: 'Customer wants 5% more off. Can we give 4%?',
        status: 'Open', outcome: '', decisionNote: '', decidedByName: '', decidedDay: '', waitingDays: 1, outcomes: DECIDE, canWithdraw: true }, extra || {});
      window.__esc = {
        x1: x('ES-1'),
        x2: x('ES-2', { cardRef: 'LD:L1', kind: 'lead', recordId: 'L1', label: 'LD2610-0001', word: 'Compressor lead', stream: 'Compressor Sales',
          desk: 'Compressor', value: 640000, raisedByName: 'Neha', ownerName: 'Neha', toEmail: 'k@pie.in', toName: 'Kiran', note: 'Customer asks 60 days credit',
          raisedDay: '2026-10-22', waitingDays: 7, canWithdraw: true }),
        r1: x('ES-0', { status: 'Decided', outcome: 'Approved', decisionNote: 'Give 4%, close at 92,000', decidedByName: 'Mona', decidedDay: '2026-10-27',
          outcomes: [], canWithdraw: false, raisedDay: '2026-10-25', waitingDays: 2 })
      };
      D.getEscalations = () => ({ today: '2026-10-29', me: 'mona@pie.in', boss: true, open: [window.__esc.x2, window.__esc.x1], recent: [window.__esc.r1],
        kpis: { waiting: 2, compressor: 1, spares: 1, toMe: 1, decidedThisMonth: 1 } });
      D.decideEscalation = (id, o, t) => Object.assign({}, id === 'ES-2' ? window.__esc.x2 : window.__esc.x1, { status: 'Decided', outcome: o, decisionNote: t, outcomes: [] });
      D.withdrawEscalation = (id) => Object.assign({}, window.__esc.x1, { id, status: 'Withdrawn', outcome: 'Withdrawn', outcomes: [] });
      D.escalateCard = (i) => Object.assign({}, window.__esc.x1, { id: 'ES-9', cardRef: i.ref, note: i.note, toEmail: i.toEmail, toName: i.toEmail === 'mona@pie.in' ? 'Mona' : 'Kiran' });
      const board = D.getEnquiryBoard;
      D.getEnquiryBoard = (o) => {
        const b = board(o);
        b.escalateTo = [{ email: 'mona@pie.in', name: 'Mona', role: 'Management' }, { email: 'k@pie.in', name: 'Kiran', role: 'Sales Coordinator' }];
        b.cards.forEach((c) => { c.escalation = null; c.escalations = []; });
        const e3 = b.cards.find((c) => c.ref === 'SE:E3');
        if (e3) e3.escalation = Object.assign({}, window.__esc.x1, { id: 'ES-3', cardRef: 'SE:E3', recordId: 'E3', label: 'SE2610-0003', note: 'Renewal at last year’s rate?' });
        const e1 = b.cards.find((c) => c.ref === 'SE:E1');
        if (e1) e1.escalations = [window.__esc.r1];
        return b;
      };
    });

    console.log('ESCALATIONS IN THE MENU, ON THEIR OWN SCREEN');
    const menu = await page.$$eval('#tabs [data-view]', (b) => b.map((x) => x.dataset.view));
    ok('in the menu, after Tasks', menu.indexOf('escalations') === menu.indexOf('tasks') + 1, menu);
    await reset();
    await go('escalations');
    ok('opens', (await active()) === 'view-escalations' && !!(await lastCall('getEscalations')));
    const tiles = await page.$$eval('#esc-kpis .pd-tile', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    ok('four figures across the top', tiles.length === 4 && /Waiting for a decision 2 1 for you to answer/.test(tiles[0]) && /Decided this month 1/.test(tiles[3]), tiles);
    const rows = await page.$$eval('#esc-open tbody tr', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
    ok('what waits, oldest first, with who sent it to whom and the value', rows.length === 2 && /LD2610-0001/.test(rows[0]) && /Neha → Kiran/.test(rows[0]) &&
      /7 days/.test(rows[0]) && /₹6,40,000|6.4 L|6,40,000/.test(rows[0]) && /Priya → Mona/.test(rows[1]) && /Customer wants 5% more off/.test(rows[1]), rows);
    ok('a long wait stands out', await page.$eval('#esc-open tbody tr:nth-child(1) td:nth-child(6)', (e) => e.classList.contains('sdc-late')));
    ok('what was answered lately', /Approved/.test(await page.textContent('#esc-recent')) && /Give 4%, close at 92,000/.test(await page.textContent('#esc-recent')));

    console.log('\nMANAGEMENT DECIDES');
    await page.click('#esc-open tbody tr:nth-child(2)');
    await page.waitForTimeout(300);
    ok('the escalation, with what needs deciding', (await page.textContent('#esc-m-title')) === 'SE2610-0001 · Topworth Urja' &&
      /escalated by Priya to Mona on 28-10-2026 · 1 day waiting/.test(await page.textContent('#esc-m-sub')) &&
      /Customer wants 5% more off/.test(await page.textContent('.esc-note')));
    ok('send back, approve, won or lost', (await page.$$eval('[data-esc-outcome]', (b) => b.map((x) => x.textContent))).join() ===
      'Send back to coordinator,Approve,Won,Lost');
    ok('and won or lost is word to the coordinator, not a change to the quotation', /they mark the quotation won or lost themselves/.test(await page.textContent('#esc-m-body')));
    await reset();
    await page.click('[data-esc-outcome="Approved"]');
    await page.waitForTimeout(300);
    ok('not without words', !(await lastCall('decideEscalation')) && /Write your decision or instruction first/.test(await msg()));
    await page.fill('#esc-m-text', 'Give 4%, close at 92,000');
    await page.click('[data-esc-outcome="Approved"]');
    await page.waitForTimeout(400);
    ok('decided, and the list read again', JSON.stringify(await lastCall('decideEscalation')) === '["ES-1","Approved","Give 4%, close at 92,000"]' &&
      /Decision sent to Priya: Approved/.test(await msg()) && !(await shown('esc-modal-backdrop')) && !!(await lastCall('getEscalations')));
    await page.click('#esc-recent tbody tr:nth-child(1)');
    await page.waitForTimeout(300);
    ok('an answered one shows the answer, and nothing to press', /Approved by Mona on 27-10-2026/.test((await page.textContent('.esc-answer')).replace(/\s+/g, ' ')) &&
      !(await page.$('[data-esc-outcome]')) && !(await page.isVisible('#btn-esc-withdraw')));
    await page.click('#btn-esc-close');

    console.log('\nWITHDRAWING, AND THE RECORD');
    await page.click('#esc-open tbody tr:nth-child(2)');
    await page.waitForTimeout(300);
    await page.click('#btn-esc-withdraw');
    await page.waitForTimeout(200);
    await page.click('#ask-ok');
    await page.waitForTimeout(400);
    ok('withdrawn, after asking', JSON.stringify(await lastCall('withdrawEscalation')) === '["ES-1"]' && /Escalation withdrawn/.test(await msg()));
    await page.click('#esc-open tbody tr:nth-child(2)');
    await page.waitForTimeout(300);
    await page.click('#btn-esc-go');
    await page.waitForTimeout(600);
    ok('the record it is about opens', !(await shown('esc-modal-backdrop')) && await shown('enquiry-modal-backdrop'));
    await page.evaluate(() => document.getElementById('enquiry-modal-backdrop').classList.remove('show'));

    console.log('\nFROM THE BOARD');
    await go('enquiries');
    ok('a card waiting on somebody says so', /Escalated/.test(await page.textContent('[data-eb-card="SE:E3"]')) &&
      !/Escalated/.test(await page.textContent('[data-eb-card="SE:E1"]')));
    await page.click('[data-eb-card="SE:E1"]');
    await page.waitForTimeout(300);
    ok('a card carries its earlier escalations', /Escalated before/.test(await page.textContent('#eb-m-body')) &&
      /Priya → Mona: Customer wants 5% more off/.test(await page.textContent('.eb-esc-hist')) && /Give 4%/.test(await page.textContent('.eb-esc-hist')));
    ok('and can be escalated', !!(await page.$('[data-eb-escalate]')));
    await page.click('[data-eb-escalate]');
    await page.waitForTimeout(300);
    ok('to a named person', (await page.textContent('#esc-r-title')) === 'Escalate SE2610-0001 · Topworth Urja' &&
      (await page.$$eval('#esc-r-to option', (o) => o.map((x) => x.textContent))).join() === '— pick —,Mona · Management,Kiran · Sales Coordinator');
    await page.selectOption('#esc-r-to', 'mona@pie.in');
    await page.fill('#esc-r-note', 'Customer came back for 2% more');
    await reset();
    await page.click('#btn-esc-raise');
    await page.waitForTimeout(500);
    ok('sent, and the board read again', JSON.stringify(await lastCall('escalateCard')) ===
      JSON.stringify([{ ref: 'SE:E1', toEmail: 'mona@pie.in', note: 'Customer came back for 2% more' }]) && /Escalated to Mona/.test(await msg()) &&
      !(await shown('esc-raise-backdrop')) && !(await shown('eb-modal-backdrop')) && !!(await lastCall('getEnquiryBoard')));
    await page.click('[data-eb-card="SE:E3"]');
    await page.waitForTimeout(300);
    ok('the card with one waiting shows it, and is not escalated twice', /With Mona for a decision/.test(await page.textContent('.eb-esc')) &&
      /Renewal at last year’s rate/.test(await page.textContent('.eb-esc')) && !(await page.$('[data-eb-escalate]')));
    await page.click('[data-eb-esc-open]');
    await page.waitForTimeout(300);
    ok('answered from the card, above it', await shown('esc-modal-backdrop') && await shown('eb-modal-backdrop'));
    await page.fill('#esc-m-text', 'Not at last year’s rate; hold at this year’s');
    await reset();
    await page.click('[data-esc-outcome="Lost"]');
    await page.waitForTimeout(500);
    ok('and the board reads it again', JSON.stringify(await lastCall('decideEscalation')) === '["ES-3","Lost","Not at last year’s rate; hold at this year’s"]' &&
      !!(await lastCall('getEnquiryBoard')) && !(await shown('eb-modal-backdrop')));

    console.log('\nA COORDINATOR REPLIES');
    await page.evaluate(() => {
      window.__esc.x2.outcomes = ['Replied'];
      window.__esc.x2.canWithdraw = false;
    });
    await go('escalations');
    await page.click('#esc-open tbody tr:nth-child(1)');
    await page.waitForTimeout(300);
    ok('one button: reply and send back', (await page.$$eval('[data-esc-outcome]', (b) => b.map((x) => x.textContent))).join() === 'Reply & send back' &&
      /Your reply/.test(await page.textContent('#esc-m-body')) && !/mark the quotation/.test(await page.textContent('#esc-m-body')) &&
      !(await page.isVisible('#btn-esc-withdraw')));
    await page.fill('#esc-m-text', 'Ok for 45 days, not 60');
    await reset();
    await page.click('[data-esc-outcome="Replied"]');
    await page.waitForTimeout(400);
    ok('sent back to whoever raised it', JSON.stringify(await lastCall('decideEscalation')) === '["ES-2","Replied","Ok for 45 days, not 60"]' &&
      /Reply sent back to Neha/.test(await msg()));
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
