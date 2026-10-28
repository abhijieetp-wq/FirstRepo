/**
 * ERP 2.0's AMC screen, in a browser against the real client: the visits due within a window,
 * a due visit made into a service job, a contract added and changed, and a renewal quotation
 * raised. Only the 2.0 face has it; the others must not offer it at all.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/amc-ui-test.js /tmp/base-v2.html
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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

  if (!v2) {
    console.log('THE OTHER FACES HAVE NO AMC');
    ok('not in the menu', !(await page.$('#tabs [data-view="amc"]')));
    ok('no screen for it', !(await page.$('#view-amc')));
    ok('and Service Jobs has no AMC filter', !(await page.$('#service-type option[value="AMC visit"]')));
  } else {
    await page.evaluate(() => {
      const D = window.__data;
      const contract = { id: 'AMC-1', contractNo: 'AMC2610-001', customerId: 'CU-1', customerName: 'Topworth Urja', machineModel: 'EG 37',
        serialNo: 'FAB-77', amcType: 'Comprehensive', startDate: '2026-01-15', endDate: '2027-01-14', everyMonths: 3,
        firstVisitDate: '2026-04-14', contractValue: 64000, runningHours: '15230', contactName: 'Mr Rao', contactPhone: '9800000001',
        area: 'Pune east', ownerEmail: 'p@pie.in', ownerName: 'Priya', notes: '', visitsDone: 1, visitsTotal: 4, nextVisit: '2026-07-14',
        state: 'Active', daysLeft: 78, renewal: null };
      const ending = Object.assign({}, contract, { id: 'AMC-2', contractNo: 'AMC2610-002', serialNo: 'FAB-88', amcType: 'Labour only',
        endDate: '2026-11-20', contractValue: 18000, state: 'Ends in 23 days', daysLeft: 23 });
      D.listAmc = (o) => ({ window: (o && o.window) || 30, windows: [7, 15, 30, 60], today: '2026-10-28', money: true,
        types: ['Comprehensive', 'Non-comprehensive', 'Labour only', 'Service reminder'], canEdit: true, canRenew: true, canMakeCall: true,
        kpis: { active: 2, valueAYear: 82000, dueThisMonth: 1, overdue: 1, renewals: 1 },
        dues: [
          { id: 'AMV-2', contractId: 'AMC-1', contractNo: 'AMC2610-001', customerName: 'Topworth Urja', machineModel: 'EG 37', serialNo: 'FAB-77',
            amcType: 'Comprehensive', endDate: '2027-01-14', area: 'Pune east', visitNo: 2, visitOf: 4, dueDate: '2026-07-14', state: 'Overdue', jobId: '', jobNo: '', engineer: '' },
          { id: 'AMV-6', contractId: 'AMC-2', contractNo: 'AMC2610-002', customerName: 'Topworth Urja', machineModel: 'EG 22', serialNo: 'FAB-88',
            amcType: 'Labour only', endDate: '2026-11-20', area: '', visitNo: 3, visitOf: 3, dueDate: '2026-11-05', state: 'Call made', jobId: 'SVJ-9', jobNo: 'SVJ2610-009', engineer: 'Tej' }
        ],
        contracts: [contract, ending], renewals: [ending] });
      D.getAmcContract = (id) => Object.assign({}, id === 'AMC-2' ? ending : contract, { visits: [
        { id: 'AMV-1', visitNo: 1, dueDate: '2026-04-14', state: 'Done', jobId: 'SVJ-1', jobNo: 'SVJ2604-001', doneDate: '2026-04-16' },
        { id: 'AMV-2', visitNo: 2, dueDate: '2026-07-14', state: 'Overdue', jobId: '', jobNo: '', doneDate: '' }] });
      D.saveAmcContract = (input) => Object.assign({}, contract, input, { contractNo: input.id ? contract.contractNo : 'AMC2610-003', visits: [1, 2, 3, 4] });
      D.deleteAmcContract = () => ({ deleted: true, contractNo: 'AMC2610-001' });
      D.makeAmcVisitCall = () => ({ jobId: 'SVJ-10', jobNo: 'SVJ2610-010' });
      D.prepareAmcRenewal = () => ({ quotationId: 'QT-1', quoteNo: 'SPARE/26/0099', existing: false });
      D.listAmcMachines = () => [{ serialNo: 'FAB-77', machineModel: 'EG 37', from: 'ELGi’s service due list' }];
    });

    console.log('AMC IN THE MENU, ON ITS OWN SCREEN');
    ok('in the menu', !!(await page.$('#tabs [data-view="amc"]')));
    await page.evaluate(() => document.querySelector('#tabs [data-view="amc"]').click());
    await page.waitForTimeout(500);
    ok('opens', (await active()) === 'view-amc');
    ok('four figures across the top', (await page.$$('#amc-kpis .pd-tile')).length === 4 && /₹82K a year/.test(await page.textContent('#amc-kpis')),
      await page.textContent('#amc-kpis'));
    ok('overdue stands out', await page.$eval('#amc-kpis .pd-tile:nth-child(3)', (e) => e.classList.contains('bad')));

    console.log('\nVISITS DUE');
    const rows = await page.$$eval('#amc-body tbody tr', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ')));
    ok('each with its machine, contract and which visit', rows.length === 2 && /FAB-77/.test(rows[0]) && /2 of 4/.test(rows[0]) && /Overdue/.test(rows[0]), rows);
    ok('a visit already made into a job says which, and who is going', /SVJ2610-009 · Tej/.test(rows[1]) && !!(await page.$('[data-amc-job="SVJ-9"]')));
    await page.evaluate(() => { window.__calls = []; });
    await page.selectOption('#amc-window', '7');
    await page.waitForTimeout(300);
    ok('the window is the server’s to apply', JSON.stringify(await lastCall('listAmc')) === JSON.stringify([{ window: 7 }]));
    await page.click('[data-amc-call="AMV-2"]');
    await page.waitForTimeout(400);
    ok('a due visit becomes a service job with one press', JSON.stringify(await lastCall('makeAmcVisitCall')) === '["AMV-2"]' &&
      /SVJ2610-010 made/.test(await page.textContent('#msg-box')));

    console.log('\nCONTRACTS');
    await page.click('[data-amc-mode="contracts"]');
    await page.waitForTimeout(200);
    ok('the list, with value, visits done and the next', (await page.$$('#amc-body tbody tr')).length === 2 &&
      /₹64,000/.test(await page.textContent('#amc-body')) && /1 of 4/.test(await page.textContent('#amc-body')));
    await page.click('[data-amc-contract="AMC-1"]');
    await page.waitForTimeout(500);
    ok('a contract opens with its details', await page.inputValue('#amc-f-serial') === 'FAB-77' && await page.inputValue('#amc-f-every') === '3' &&
      await page.inputValue('#amc-f-value') === '64000' && await page.inputValue('#amc-f-area') === 'Pune east');
    ok('and its visits, the job each became', /SVJ2604-001/.test(await page.textContent('.amc-visits')) && /Overdue/.test(await page.textContent('.amc-visits')));
    await page.fill('#amc-f-every', '6');
    await page.evaluate(() => { window.__calls = []; });
    await page.click('#btn-amc-save');
    await page.waitForTimeout(400);
    const saved = ((await lastCall('saveAmcContract')) || [])[0] || {};
    ok('a change is saved, schedule and all', saved.id === 'AMC-1' && saved.everyMonths === '6' && saved.contractValue === '64000' &&
      saved.contactName === 'Mr Rao', saved);
    await page.click('[data-amc-contract="AMC-1"]');
    await page.waitForTimeout(500);
    await page.click('#btn-amc-delete');
    await page.waitForTimeout(200);
    await page.click('#ask-ok');
    await page.waitForTimeout(400);
    ok('and can be deleted, after asking', JSON.stringify(await lastCall('deleteAmcContract')) === '["AMC-1"]');

    console.log('\nA NEW CONTRACT');
    await page.click('#btn-new-amc');
    await page.waitForTimeout(500);
    ok('a blank form, three-monthly by default', (await page.textContent('#amc-m-title')) === 'New AMC contract' && await page.inputValue('#amc-f-every') === '3' &&
      !(await page.isVisible('#btn-amc-delete')));
    await page.selectOption('#amc-f-customer', 'CU-1');
    await page.waitForTimeout(300);
    ok('picking the customer offers their machines', JSON.stringify(await lastCall('listAmcMachines')) === '["CU-1"]' &&
      (await page.$$eval('#amc-machines option', (o) => o.map((x) => x.value))).join() === 'FAB-77');
    await page.fill('#amc-f-serial', 'FAB-77');
    await page.dispatchEvent('#amc-f-serial', 'change');
    ok('and a known machine fills its model', await page.inputValue('#amc-f-model') === 'EG 37');
    await page.selectOption('#amc-f-type', 'Service reminder');
    await page.click('#btn-amc-save');
    await page.waitForTimeout(400);
    const made = ((await lastCall('saveAmcContract')) || [])[0] || {};
    ok('saved as typed', made.id === '' && made.customerId === 'CU-1' && made.amcType === 'Service reminder' && made.serialNo === 'FAB-77', made);

    console.log('\nRENEWALS');
    await page.click('[data-amc-mode="renewals"]');
    await page.waitForTimeout(200);
    ok('the contract ending soon', /in 23 days/.test(await page.textContent('#amc-body')));
    await page.click('[data-amc-renew="AMC-2"]');
    await page.waitForTimeout(600);
    ok('a renewal quotation, opened to fill in', JSON.stringify(await lastCall('prepareAmcRenewal')) === '["AMC-2"]' && (await active()) === 'view-quote');

    console.log('\nSERVICE JOBS');
    ok('can be narrowed to AMC visits', !!(await page.$('#service-type option[value="AMC visit"]')));
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
