/**
 * New customers waiting for approval, in a browser against the real client (CustomerApproval.gs
 * on the server): the approver's dashboard and Customers list them with tick boxes, Approve
 * ticked and Reject ticked; Management who do not approve see a notice; the e-mail's link
 * (/customers?approve=<batch>) opens that batch; Settings chooses the approver.
 *
 * The answers are put into the showcase here, so its other screens are as they were.
 * Customers and people are invented.
 *
 *   node tests/build-preview.js tests/fixtures/showcase.html /tmp/show-v2.html --title="ELGi Sales ERP"
 *   node tests/customer-approval-ui-test.js /tmp/show-v2.html [screenshot-dir]
 */
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const PREVIEW = process.argv[2];
const SHOTS = process.argv[3] || '';
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};

/** Puts the approvals into the showcase: three waiting, two of them from one upload. */
const seed = (mode) => {
  const W = [
    { id: 'CU-N1', customerCode: 'C2611-001', name: 'Pravara Paper Mills', gstin: '27AAACG1111B1Z2', industry: 'Paper', place: 'Ahilyanagar',
      createdAt: '2026-11-04', createdBy: 'kiran@pie.in', createdByName: 'Kiran Patil', batch: 'CUB-1' },
    { id: 'CU-N2', customerCode: 'C2611-002', name: 'Bhusawal Foundry Works', gstin: '', industry: 'Engineering', place: 'Jalgaon',
      createdAt: '2026-11-04', createdBy: 'kiran@pie.in', createdByName: 'Kiran Patil', batch: 'CUB-1' },
    { id: 'CU-N3', customerCode: 'C2611-003', name: 'Warna Dairy Co-operative', gstin: '27AAACW3333D1Z4', industry: 'Food', place: 'Kolhapur',
      createdAt: '2026-11-03', createdBy: 'neha@pie.in', createdByName: 'Neha Rao', batch: 'CU-N3' }
  ];
  const decider = mode === 'decide';
  window.__ca = { waiting: W.slice(), decided: [] };
  const state = (batch) => ({ visible: true, canDecide: decider,
    approver: decider ? { email: 'anil@pie.in', name: 'Anil Mehta' } : { email: 'meera@pie.in', name: 'Meera Joshi' },
    waiting: window.__ca.waiting.slice(), count: window.__ca.waiting.length,
    batch: batch ? { id: batch, count: window.__ca.waiting.filter((r) => r.batch === batch).length } : null });
  window.__data.listCustomerApprovals = (o) => state(o && o.batch);
  window.__data.decideCustomers = (input) => {
    window.__ca.decided.push(input);
    const before = window.__ca.waiting.length;
    window.__ca.waiting = window.__ca.waiting.filter((r) => input.ids.indexOf(r.id) === -1);
    return Object.assign(state(input.batch), { decided: before - window.__ca.waiting.length, skipped: 0, outcome: input.outcome });
  };
  const dash = window.__data.getPersonDashboard;
  window.__data.getPersonDashboard = function (o) {
    const d = dash.apply(null, arguments);
    if (!(o && o.as)) d.approvals = state('');
    return d;
  };
  const list = window.__data.listCustomers;
  window.__data.listCustomers = function () {
    const rows = (typeof list === 'function' ? list.apply(null, arguments) : list).slice();
    return rows.concat(window.__ca.waiting.map((w) => ({ id: w.id, customerCode: w.customerCode, name: w.name, gstin: w.gstin,
      industry: w.industry, addresses: [], contacts: [], active: 'TRUE', approvalStatus: 'Pending' })));
  };
  const settings = window.__data.getSettings;
  window.__data.getSettings = function () {
    const s = Object.assign({}, typeof settings === 'function' ? settings.apply(null, arguments) : settings);
    s.customerApproval = { approver: 'anil@pie.in', mailTo: '' };
    return s;
  };
  window.__data.saveCustomerApprover = (input) => ({ approver: input.email, mailTo: input.mailTo });
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (query, mode, viewport) => {
    const page = await browser.newPage({ viewport: viewport || { width: 1440, height: 900 } });
    page.on('pageerror', (e) => errors.push(String(e) + ' @ ' + String(e.stack).split('\n').slice(1, 3).join(' | ')));
    await page.addInitScript(() => {
      // Sets the answers the moment the fixture has made window.__data, before the portal asks.
      let d;
      Object.defineProperty(window, '__data', { configurable: true, get: () => d,
        set: (v) => { d = v; if (window.__seedCa) window.__seedCa(); } });
    });
    await page.addInitScript('window.__seedCa = function () { (' + seed.toString() + ')(' + JSON.stringify(mode) + '); };');
    await page.goto('file://' + PREVIEW + (query || ''));
    await page.waitForTimeout(1300);
    return page;
  };
  const go = async (page, view) => { await page.evaluate((v) => document.querySelector('#tabs [data-view="' + v + '"]').click(), view); await page.waitForTimeout(900); };
  const shot = async (page, name, sel) => {
    if (!SHOTS) return;
    const el = sel ? await page.$(sel) : null;
    if (el) await el.screenshot({ path: path.join(SHOTS, name + '.png') });
    else await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  };
  const rows = (page, host) => page.$$eval('[data-ca-host="' + host + '"] .ca-row b', (b) => b.map((x) => x.textContent));
  const text = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText.replace(/\s+/g, ' ').trim() : ''; }, sel);

  console.log('THE APPROVER’S DASHBOARD');
  let page = await open('', 'decide');
  await go(page, 'dashboard');
  const panel = '#pd-host [data-ca-host="dash"] .ca-panel';
  ok('the panel is on the dashboard, above the others', !!(await page.$(panel)) &&
    await page.evaluate(() => { const p = document.querySelector('#pd-host .ca-dash'); const c = document.querySelector('#pd-host .dv-cols'); return !!p && !!c && (p.compareDocumentPosition(c) & 4) !== 0; }));
  ok('titled for the one who decides, with the count', /^New customers to approve 3/.test(await text(page, panel + ' header')), await text(page, panel + ' header'));
  ok('every customer waiting, each with a tick box', (await rows(page, 'dash')).length === 3 &&
    (await page.$$(panel + ' input[data-ca-pick]')).length === 3, await rows(page, 'dash'));
  const g = await text(page, panel + ' .ca-row');
  ok('a row: name, code, place, segment, GSTIN, who added it and when', /Pravara Paper Mills C2611-001/.test(g) && /Ahilyanagar · Paper · GSTIN 27AAACG1111B1Z2 · added by Kiran Patil on 04-11-2026/.test(g), g);
  ok('one with no GSTIN says so', /Bhusawal Foundry Works.*no GSTIN/.test(await text(page, panel)));
  ok('nothing ticked: the buttons wait', await page.$eval(panel + ' [data-ca-decide="Approved"]', (b) => b.disabled) &&
    await page.$eval(panel + ' [data-ca-decide="Rejected"]', (b) => b.disabled));
  await page.check(panel + ' input[data-ca-pick="CU-N1"]');
  ok('ticking one counts it and wakes the buttons', /1 ticked/.test(await text(page, panel + ' .ca-acts')) &&
    !(await page.$eval(panel + ' [data-ca-decide="Approved"]', (b) => b.disabled)) && !!(await page.$(panel + ' .ca-row.ca-on')));
  await page.click(panel + ' [data-ca-tick]');
  ok('Tick all ticks the rest', /3 ticked/.test(await text(page, panel + ' .ca-acts')) && /Untick all/.test(await text(page, panel + ' [data-ca-tick]')));
  await page.click(panel + ' [data-ca-tick]');
  ok('and Untick all clears them', /0 ticked/.test(await text(page, panel + ' .ca-acts')));
  await page.check(panel + ' input[data-ca-pick="CU-N1"]');
  await page.check(panel + ' input[data-ca-pick="CU-N3"]');
  await shot(page, 'approvals-dashboard', panel);
  await page.click(panel + ' [data-ca-decide="Approved"]');
  await page.waitForTimeout(200);
  ok('approving asks first, naming how many', /Approve 2 customers\?/.test(await text(page, '#ask-title')));
  await page.click('#ask-ok');
  await page.waitForTimeout(400);
  let calls = await page.evaluate(() => window.__ca.decided);
  ok('the two ticked go to the server as approved', calls.length === 1 && calls[0].outcome === 'Approved' && calls[0].ids.join() === 'CU-N1,CU-N3', calls);
  ok('and leave the list', (await rows(page, 'dash')).join() === 'Bhusawal Foundry Works' && /approve 1/i.test(await text(page, panel + ' header')), await rows(page, 'dash'));
  await page.check(panel + ' input[data-ca-pick="CU-N2"]');
  await page.click(panel + ' [data-ca-decide="Rejected"]');
  await page.waitForTimeout(200);
  ok('rejecting asks why, and says what it does', /Reject 1 customer\?/.test(await text(page, '#ask-title')) && /deactivated/.test(await text(page, '#ask-message')) &&
    await page.isVisible('#ask-input'));
  await page.fill('#ask-input', 'Duplicate of an existing account');
  await page.click('#ask-ok');
  await page.waitForTimeout(400);
  calls = await page.evaluate(() => window.__ca.decided);
  ok('rejected, with the reason', calls.length === 2 && calls[1].outcome === 'Rejected' && calls[1].ids.join() === 'CU-N2' && calls[1].note === 'Duplicate of an existing account', calls);
  ok('nothing left: the panel goes', !(await page.$(panel)));
  await page.close();

  console.log('\nANOTHER ADMIN’S DASHBOARD: A NOTICE');
  page = await open('', 'notice');
  await go(page, 'dashboard');
  ok('titled for who approves', /^New customers waiting for Meera Joshi 3/.test(await text(page, panel + ' header')), await text(page, panel + ' header'));
  ok('and says nothing is blocked', /Waiting for Meera’s approval\. Nothing is blocked meanwhile\./.test(await text(page, panel)));
  ok('no tick boxes, no buttons', !(await page.$(panel + ' input[data-ca-pick]')) && !(await page.$(panel + ' [data-ca-decide]')));
  await shot(page, 'approvals-notice', panel);
  await page.close();

  console.log('\nFROM THE E-MAIL: THE BATCH, ON CUSTOMERS');
  page = await open('?approve=CUB-1', 'decide');
  await go(page, 'customers');
  const cp = '#cuv-host [data-ca-host="customers"] .ca-panel';
  ok('the panel heads Customers', !!(await page.$(cp)));
  ok('the e-mail’s two, and a way to see all three', (await rows(page, 'customers')).join() === 'Pravara Paper Mills,Bhusawal Foundry Works' &&
    /The 2 customers from the e-mail\./.test(await text(page, cp + ' .ca-batch')) && /Show all 3 waiting/.test(await text(page, cp + ' .ca-batch')), await rows(page, 'customers'));
  await shot(page, 'approvals-from-email', cp);
  await page.click(cp + ' [data-ca-scope="all"]');
  ok('Show all: everybody waiting', (await rows(page, 'customers')).length === 3);
  await page.click(cp + ' [data-ca-scope="mail"]');
  ok('and back to the e-mail’s', (await rows(page, 'customers')).length === 2);
  ok('the customer list marks the ones waiting', await page.evaluate(() => {
    const r = Array.from(document.querySelectorAll('#cuv-tbody tr')).filter((x) => /Pravara Paper Mills/.test(x.textContent))[0];
    const plain = Array.from(document.querySelectorAll('#cuv-tbody tr')).filter((x) => /Deccan Polymers/.test(x.textContent))[0];
    return !!r && /Pending approval/.test(r.textContent) && !!plain && !/Pending approval/.test(plain.textContent);
  }));
  await page.click(cp + ' [data-ca-open="CU-N1"]');
  await page.waitForTimeout(500);
  ok('a name opens the customer', await page.isVisible('#customer-modal-backdrop.show') && (await page.inputValue('#cm-name')) === 'Pravara Paper Mills');
  await page.evaluate(() => document.getElementById('customer-modal-backdrop').classList.remove('show'));
  await page.click(cp + ' [data-ca-tick]');
  await page.click(cp + ' [data-ca-decide="Approved"]');
  await page.waitForTimeout(200);
  await page.click('#ask-ok');
  await page.waitForTimeout(500);
  calls = await page.evaluate(() => window.__ca.decided);
  ok('Tick all here ticks the e-mail’s two only, and says which batch', calls[0] && calls[0].ids.join() === 'CU-N1,CU-N2' && calls[0].batch === 'CUB-1', calls);
  ok('then: all from that e-mail decided, one still waiting elsewhere', /Everybody from that e-mail has been decided\./.test(await text(page, cp)) &&
    /Show all 1 waiting/.test(await text(page, cp)));

  console.log('\nON A PHONE');
  const phone = await open('?approve=CUB-1', 'decide', { width: 390, height: 844 });
  await go(phone, 'customers');
  ok('the panel fits, with no sideways scroll', await phone.evaluate(() => {
    const p = document.querySelector('[data-ca-host="customers"] .ca-panel');
    return !!p && p.getBoundingClientRect().right <= window.innerWidth + 1;
  }));
  await shot(phone, 'approvals-phone', '[data-ca-host="customers"] .ca-panel');
  await phone.close();

  console.log('\nSETTINGS CHOOSES THE APPROVER');
  await go(page, 'settings');
  const sub = await page.$('#subtab-users');
  if (sub) { await sub.click(); await page.waitForTimeout(400); }
  ok('the card is under Users', /New customer approvals/.test(await text(page, '#set-approver')));
  ok('the approver chosen is shown, and everybody active can be picked', (await page.inputValue('#ca-approver')) === 'anil@pie.in' &&
    (await page.$$eval('#ca-approver option', (o) => o.map((x) => x.textContent))).some((t) => /Nobody chosen/.test(t)));
  await page.selectOption('#ca-approver', 'kiran@pie.in');
  await page.fill('#ca-mailto', 'kiran.ops@example.com');
  await page.click('#btn-save-approver');
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => window.__calls.filter((c) => c.fn === 'saveCustomerApprover').map((c) => c.args[0]));
  ok('saved: who, and where the e-mail goes', saved.length === 1 && saved[0].email === 'kiran@pie.in' && saved[0].mailTo === 'kiran.ops@example.com', saved);
  await shot(page, 'approvals-settings', '#set-approver');

  console.log('\nIN THE DARK');
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); });
  await go(page, 'customers');
  ok('the panel draws in the dark too', await page.evaluate(() => {
    const p = document.querySelector('[data-ca-host="customers"] .ca-panel');
    return !!p && getComputedStyle(p).backgroundColor !== 'rgb(255, 255, 255)';
  }));
  await page.close();

  ok('no page errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
