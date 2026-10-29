/**
 * ERP 2.0's sales visit plans, in a browser against the real client: the week and the month,
 * the figures and the visit report, a visit added from the quick form and from a day, last
 * week's plan copied, a visit's full form saved and made into an enquiry, the areas, and what
 * a sales engineer sees. Only the 2.0 face has it; the others must not offer it at all.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/visit-plans-ui-test.js /tmp/base-v2.html
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
  // A coordinator on both desks, who sees everybody's visits and plans for anybody.
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
    console.log('THE OTHER FACES HAVE NO VISIT PLANS');
    ok('not in the menu', !(await page.$('#tabs [data-view="visits"]')));
    ok('no screen for it', !(await page.$('#view-visits')));
    ok('and no visit window', !(await page.$('#vp-modal-backdrop')));
  } else {
    const W = await page.evaluate(() => {
      const iso = (d) => d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
      const add = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
      const n = new Date();
      const today = n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2) + '-' + ('0' + n.getDate()).slice(-2);
      const monday = add(today, -((new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7));
      const first = today.slice(0, 8) + '01';
      const last = add(add(first, 32).slice(0, 8) + '01', -1);
      window.__W = { today, monday, sunday: add(monday, 6), nextMonday: add(monday, 7), tue: add(monday, 1), wed: add(monday, 2), first, last };
      const D = window.__data;
      const visit = (id, extra) => Object.assign({ id, engineerEmail: 'rohan@pie.in', engineerName: 'Rohan', visitDate: window.__W.monday, customerId: 'CU-1',
        customerName: 'Topworth Urja', area: 'Butibori MIDC', areaType: 'Local', purpose: 'New customer – prospecting', status: 'Planned', contactMet: '',
        phone: '', industry: '', discussion: '', compType: '', brand: '', capacity: '', ageYears: '', considering: '', interest: '', requirement: '',
        timeline: '', potentialValue: '', nextAction: '', nextDate: '', leadId: '', leadNo: '', leadStatus: '', canEdit: true }, extra || {});
      window.__visits = [
        visit('V1', { status: 'Visited', contactMet: 'Mr Rao', discussion: 'Two old machines, air leaks', compType: 'Screw – oil-lubricated, fixed speed',
          brand: 'Atlas Copco', interest: 'Hot', timeline: '1–3 months', potentialValue: 450000, leadId: 'L9', leadNo: 'LD2610-009', leadStatus: 'Qualified' }),
        visit('V2', { visitDate: window.__W.tue, customerName: 'Brightline Mills', customerId: '', area: 'Wardha', areaType: 'Outstation', status: 'Not visited' }),
        visit('V3', { visitDate: window.__W.wed, engineerEmail: 'ravi@pie.in', engineerName: 'Ravi', customerName: 'Sunrise Agro', purpose: 'Payment follow-up' })
      ];
      window.__seeAll = true;
      D.getVisitPlans = (o) => ({ from: o.from, to: o.to, today: window.__W.today, me: window.__seeAll ? 'mona@pie.in' : 'rohan@pie.in', seeAll: window.__seeAll,
        engineer: window.__seeAll ? (o.engineer || '') : 'rohan@pie.in',
        people: [{ email: 'neha@pie.in', name: 'Neha', role: 'Sales Coordinator' }, { email: 'ravi@pie.in', name: 'Ravi', role: 'Sales Engineer' },
          { email: 'rohan@pie.in', name: 'Rohan', role: 'Sales Engineer' }],
        areas: [{ name: 'Butibori MIDC', type: 'Local' }, { name: 'Hingna MIDC', type: 'Local' }, { name: 'Wardha', type: 'Outstation' }],
        lists: { purposes: ['New customer – prospecting', 'Follow-up on quotation', 'Payment follow-up'], compTypes: ['Reciprocating (piston)', 'Screw – oil-lubricated, fixed speed'],
          brands: ['ELGI', 'Atlas Copco'], timelines: ['Immediate (within 1 month)', '1–3 months'], industries: ['Textile', 'Pharma'] },
        statuses: ['Planned', 'Visited', 'Not visited', 'Rescheduled'], interest: ['Hot', 'Warm', 'Cold'],
        customers: [{ id: 'CU-1', name: 'Topworth Urja' }], canEditAreas: window.__seeAll,
        visits: window.__visits.filter((v) => v.visitDate >= o.from && v.visitDate <= o.to && (!window.__seeAll ? v.engineerEmail === 'rohan@pie.in' : !o.engineer || v.engineerEmail === o.engineer)) });
      D.saveVisit = (i) => Object.assign({}, window.__visits.find((v) => v.id === i.id) || window.__visits[1], i, { id: i.id || 'V9' });
      D.createVisitEnquiry = (id) => ({ leadId: 'L10', leadNo: 'LD2610-010', visit: Object.assign({}, window.__visits[1], { id, leadId: 'L10' }) });
      D.deleteVisit = () => ({ deleted: true });
      D.copyLastWeekVisits = () => ({ copied: 3, skipped: 1 });
      D.saveVisitAreas = (l) => l;
      return window.__W;
    });

    console.log('VISIT PLANS IN THE MENU, ON THEIR OWN SCREEN');
    const menu = await page.$$eval('#tabs [data-view]', (b) => b.map((x) => x.dataset.view));
    ok('in the menu, after Service Due Calls', menu.indexOf('visits') === menu.indexOf('servicedue') + 1, menu);
    await reset();
    await go('visits');
    ok('opens on this week, Monday to Sunday', (await active()) === 'view-visits' &&
      JSON.stringify(await lastCall('getVisitPlans')) === JSON.stringify([{ from: W.monday, to: W.sunday }]));
    const days = await page.$$eval('.vp-day', (d) => d.map((x) => ({ today: x.classList.contains('today'), chips: Array.from(x.querySelectorAll('.vp-chip b')).map((b) => b.textContent) })));
    ok('seven days, today marked, each visit on its day', days.length === 7 && days.filter((d) => d.today).length === 1 &&
      days[0].chips.join() === 'Topworth Urja' && days[1].chips.join() === 'Brightline Mills' && days[2].chips.join() === 'Sunrise Agro', days);
    ok('a visit shows how it went, and an enquiry made', await page.$eval('[data-vp-open="V1"]', (e) => e.classList.contains('visited') && /Enquiry/.test(e.textContent)) &&
      await page.$eval('[data-vp-open="V2"]', (e) => e.classList.contains('missed') && /Wardha \(out\)/.test(e.textContent)) &&
      /Ravi/.test(await page.textContent('[data-vp-open="V3"]')));
    const k = await page.$$eval('#vp-kpis .pd-tile', (t) => t.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    ok('the week in figures', /^Planned 3 2 local · 1 outstation/.test(k[0]) && /^Visited 1 33% of the plan/.test(k[1]) && /1 \/ 0/.test(k[2]) &&
      /^Enquiries made 1 100% of visits/.test(k[3]) && /Potential value ₹4\.50 L 1 hot/.test(k[4]), k);
    const rep = await page.$$eval('#vp-report tbody tr', (r) => r.map((x) => Array.from(x.cells).map((c) => c.innerText.trim()).join('|')));
    ok('each engineer’s visits, completion and enquiries', rep.length === 2 && /^Rohan\|2\|1\|1\|0\|50%\|1\|100%\|1\|/.test(rep[0]) && /^Ravi\|1\|0\|0\|0\|0%\|0\|—\|0\|—$/.test(rep[1]), rep);
    ok('and what the customers run and when they will buy', /1–3 months/.test(await page.textContent('.vp-bars')) && /Atlas Copco/.test(await page.textContent('.vp-bars')) &&
      /Screw – oil-lubricated, fixed speed/.test(await page.textContent('.vp-bars')));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-vp-csv')]);
    const csv = require('fs').readFileSync(await dl.path(), 'utf8').replace(/^\ufeff/, '');
    ok('the visits download as a CSV, ERP 2’s form in columns', dl.suggestedFilename() === 'Visits ' + W.monday + ' to ' + W.sunday + '.csv' &&
      csv.split('\r\n')[0].split(',').length === 23 && /"Topworth Urja","Butibori MIDC","Local"/.test(csv) && /"LD2610-009"/.test(csv), csv.split('\r\n').slice(0, 2));

    console.log('\nMOVING ABOUT');
    await reset();
    await page.selectOption('#vp-eng', 'ravi@pie.in');
    await page.waitForTimeout(300);
    ok('one engineer', JSON.stringify(await lastCall('getVisitPlans')) === JSON.stringify([{ from: W.monday, to: W.sunday, engineer: 'ravi@pie.in' }]) &&
      (await page.$$('.vp-chip')).length === 1);
    await page.selectOption('#vp-eng', '');
    await page.waitForTimeout(300);
    await page.click('[data-vp-nav="1"]');
    await page.waitForTimeout(300);
    ok('next week', (await lastCall('getVisitPlans'))[0].from === W.nextMonday);
    await page.click('[data-vp-nav="0"]');
    await page.waitForTimeout(300);
    await page.click('[data-vp-mode="month"]');
    await page.waitForTimeout(300);
    ok('the month', JSON.stringify((await lastCall('getVisitPlans'))[0]) === JSON.stringify({ from: W.first, to: W.last, engineer: '' }) &&
      !(await page.isVisible('#btn-vp-copy')));
    const mrows = await page.$$eval('.vp-table tbody tr', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
    ok('as a list, with the area’s kind and the enquiry', mrows.length >= 1 && mrows.some((r) => /Topworth Urja/.test(r) && /Local/.test(r) && /LD2610-009/.test(r) && /Visited/.test(r)), mrows);
    await page.click('[data-vp-mode="week"]');
    await page.waitForTimeout(300);

    console.log('\nADDING TO THE PLAN');
    await page.click('[data-vp-day="' + W.tue + '"]');
    ok('a day’s + Add sets the date', await page.inputValue('#vp-q-date') === W.tue);
    await page.fill('#vp-q-cust', 'Topworth Urja');
    await page.selectOption('#vp-q-area', 'Hingna MIDC');
    await page.selectOption('#vp-q-purpose', 'Follow-up on quotation');
    await reset();
    await page.click('#btn-vp-add');
    await page.waitForTimeout(300);
    ok('the engineer is asked for when looking at everybody', !(await lastCall('saveVisit')) && /Pick the engineer/.test(await msg()));
    await page.selectOption('#vp-q-eng', 'rohan@pie.in');
    await page.click('#btn-vp-add');
    await page.waitForTimeout(400);
    ok('added', JSON.stringify(await lastCall('saveVisit')) === JSON.stringify([{ visitDate: W.tue, customerName: 'Topworth Urja', area: 'Hingna MIDC',
      purpose: 'Follow-up on quotation', engineerEmail: 'rohan@pie.in' }]) && /Added to the plan/.test(await msg()) && await page.inputValue('#vp-q-cust') === '');
    ok('areas grouped Local and Outstation', (await page.$$eval('#vp-q-area optgroup', (g) => g.map((x) => x.label))).join() === 'Local,Outstation');
    await reset();
    await page.click('#btn-vp-copy');
    await page.waitForTimeout(300);
    ok('last week’s plan copied forward', JSON.stringify(await lastCall('copyLastWeekVisits')) === JSON.stringify([{ weekStart: W.monday, engineer: '' }]) &&
      /3 visits copied to this week\. 1 already on the plan/.test(await msg()));

    console.log('\nWHAT A VISIT FOUND');
    await page.click('[data-vp-open="V2"]');
    await page.waitForTimeout(300);
    ok('the full form', (await page.textContent('#vp-m-title')) === 'Brightline Mills' && (await page.$$('.vp-form .field')).length === 21 &&
      await page.inputValue('#vp-f-area') === 'Wardha' && await page.inputValue('#vp-f-status') === 'Not visited' && await page.isVisible('#btn-vp-enquiry'));
    await page.selectOption('#vp-f-status', 'Visited');
    await page.fill('#vp-f-contactMet', 'Mr Shah');
    await page.fill('#vp-f-discussion', 'Wants a dryer');
    await page.selectOption('#vp-f-compType', 'Reciprocating (piston)');
    await page.selectOption('#vp-f-brand', 'ELGI');
    await page.selectOption('#vp-f-interest', 'Warm');
    await page.fill('#vp-f-potentialValue', '120000');
    await page.fill('#vp-f-nextDate', W.nextMonday);
    await reset();
    await page.click('#btn-vp-save');
    await page.waitForTimeout(400);
    const saved = ((await lastCall('saveVisit')) || [])[0] || {};
    ok('saved, field for field', saved.id === 'V2' && saved.status === 'Visited' && saved.contactMet === 'Mr Shah' && saved.discussion === 'Wants a dryer' &&
      saved.compType === 'Reciprocating (piston)' && saved.brand === 'ELGI' && saved.interest === 'Warm' && saved.potentialValue === '120000' &&
      saved.nextDate === W.nextMonday && saved.engineerEmail === 'rohan@pie.in' && saved.customerName === 'Brightline Mills' && !saved.customerId &&
      /Visit saved/.test(await msg()), saved);
    await page.click('[data-vp-open="V2"]');
    await page.waitForTimeout(300);
    await reset();
    await page.click('#btn-vp-enquiry');
    await page.waitForTimeout(500);
    ok('saved and made into an enquiry', !!(await lastCall('saveVisit')) && JSON.stringify(await lastCall('createVisitEnquiry')) === '["V2"]' &&
      /enquiry LD2610-010 made on the compressor desk/.test(await msg()) && !(await shown('vp-modal-backdrop')));
    await page.click('[data-vp-open="V1"]');
    await page.waitForTimeout(300);
    ok('a visit that made one says which, and makes no second', /Enquiry made: LD2610-009 · Qualified/.test(await page.textContent('#vp-m-body')) &&
      !(await page.isVisible('#btn-vp-enquiry')));
    const saved1 = await (async () => { await reset(); await page.click('#btn-vp-save'); await page.waitForTimeout(300); return ((await lastCall('saveVisit')) || [])[0] || {}; })();
    ok('a customer from the master stays that customer', saved1.customerId === 'CU-1', saved1);
    await page.click('[data-vp-open="V3"]');
    await page.waitForTimeout(300);
    await page.click('#btn-vp-delete');
    await page.waitForTimeout(200);
    await page.click('#ask-ok');
    await page.waitForTimeout(400);
    ok('taken off the plan, after asking', JSON.stringify(await lastCall('deleteVisit')) === '["V3"]' && /taken off the plan/.test(await msg()));

    console.log('\nTHE AREAS');
    ok('Management keeps them', await page.isVisible('#btn-vp-areas'));
    await page.click('#btn-vp-areas');
    await page.waitForTimeout(200);
    ok('each Local or Outstation', (await page.$$('#vp-a-body [data-vp-area]')).length === 3 &&
      await page.$eval('#vp-a-body [data-vp-area="2"] select', (s) => s.value) === 'Outstation');
    await page.click('[data-vp-area-drop="1"]');
    await page.click('#btn-vp-a-add');
    await page.fill('#vp-a-body [data-vp-area="2"] input', 'Kamptee');
    await reset();
    await page.click('#btn-vp-a-save');
    await page.waitForTimeout(400);
    ok('changed and saved', JSON.stringify(await lastCall('saveVisitAreas')) === JSON.stringify([[{ name: 'Butibori MIDC', type: 'Local' },
      { name: 'Wardha', type: 'Outstation' }, { name: 'Kamptee', type: 'Local' }]]) && /3 areas saved/.test(await msg()));

    console.log('\nA SALES ENGINEER');
    await page.evaluate(() => { window.__seeAll = false; });
    await reset();
    await page.click('[data-vp-nav="0"]');
    await page.waitForTimeout(400);
    ok('their own visits, no engineer to pick, no areas to keep', (await page.$$('.vp-chip')).length === 2 && !(await page.isVisible('#vp-eng')) &&
      !(await page.isVisible('#vp-q-eng-wrap')) && !(await page.isVisible('#btn-vp-areas')));
    await page.fill('#vp-q-cust', 'Sunrise Agro');
    await reset();
    await page.click('#btn-vp-add');
    await page.waitForTimeout(400);
    ok('a visit added is theirs', ((await lastCall('saveVisit')) || [{}])[0].engineerEmail === 'rohan@pie.in');
    await page.click('[data-vp-open="V1"]');
    await page.waitForTimeout(300);
    ok('the engineer on a visit is not theirs to change', await page.$eval('#vp-f-engineerEmail', (s) => s.disabled));
    await page.click('#btn-vp-cancel');
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
