/**
 * ERP 2.0's service calls, in a browser against the real client: the log-a-call form with
 * ERP 2's call types, area and instruction; the Local / Outstation filter; the job window's
 * visit part with the instruction, the area set later, and a reschedule with its reason; the
 * day locked behind Reschedule. On the other faces ERP 1's breakdown form and job window stay
 * as they were.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/service-calls-ui-test.js /tmp/base-v2.html
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
  // The service coordinator, who logs, allocates and reschedules.
  await context.addInitScript(() => {
    let data;
    Object.defineProperty(window, '__data', { configurable: true, get() { return data; },
      set(v) {
        if (v && v.bootstrap) v.bootstrap = Object.assign({}, v.bootstrap, { role: 'Service Coordinator', businessStream: 'All', email: 'sona@pie.in', name: 'Sona' });
        if (v && !v.listServiceJobs) v.listServiceJobs = [];
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
  const shown = (id) => page.$eval('#' + id, (e) => e.classList.contains('show'));
  const msg = () => page.textContent('#msg-box');
  const reset = () => page.evaluate(() => { window.__calls = []; });

  await page.evaluate(() => {
    const D = window.__data;
    const job = (id, extra) => Object.assign({ id, jobNo: 'SVJ-' + id, date: '2026-10-27', customerName: 'Testwell Foods', machineModel: 'EG 99',
      serialNo: 'FAB-' + id, jobType: 'Breakdown', urgency: 'Normal', scopeText: 'Trips on high temperature', status: 'Assigned', deskStatus: 'Assigned',
      engineerEmail: 'tej@pie.in', scheduledDate: '2026-10-30', scheduledTime: '10:30', notes: '', items: [], proofs: [], deliveryProofs: [],
      area: '', areaType: '', instruction: '', reschedules: [], rescheduleCount: 0 }, extra || {});
    window.__jobs = {
      J1: job('J1', { jobType: 'Regular service', area: 'Wardha', areaType: 'Outstation', instruction: 'Carry an AOS kit', rescheduleCount: 1,
        reschedules: [{ fromDate: '2026-10-28', toDate: '2026-10-30', reason: 'Customer asked for new date', note: 'Plant shut', byName: 'Sona', day: '2026-10-27' }] }),
      J2: job('J2', { area: 'Hingna MIDC', areaType: 'Local', status: 'Unassigned', deskStatus: 'New', engineerEmail: '', scheduledDate: '' })
    };
    D.listServiceJobs = () => Object.values(window.__jobs);
    D.getServiceJob = (id) => window.__jobs[id];
    D.getServiceCallLists = { callTypes: ['Breakdown', 'AMC visit', 'Regular service', 'Spare change', 'Installation', 'Commissioning'],
      areas: [{ name: 'Hingna MIDC', type: 'Local' }, { name: 'Wardha', type: 'Outstation' }],
      reasons: ['Customer not available', 'Engineer on another breakdown', 'Spares not available', 'Travel / weather', 'Customer asked for new date', 'Other'],
      canAssign: true };
    D.createServiceJob = (i) => Object.assign({}, window.__jobs.J2, { id: 'J9', jobNo: 'SVJ-J9', jobType: i.jobType || 'Breakdown' });
    D.setServiceJobDetails = (id, i) => Object.assign({}, window.__jobs[id], i, { areaType: i.area === 'Wardha' ? 'Outstation' : i.area ? 'Local' : '' });
    D.rescheduleServiceJob = (id, to, why, note) => Object.assign({}, window.__jobs[id], { scheduledDate: to, scheduledTime: '',
      reschedules: window.__jobs[id].reschedules.concat([{ fromDate: window.__jobs[id].scheduledDate, toDate: to, reason: why, note, byName: 'Sona', day: '2026-10-29' }]) });
    D.listPeople = { salesEngineers: [], coordinators: [], serviceCoordinators: [], management: [], serviceEngineers: [{ email: 'tej@pie.in', name: 'Tej' }],
      serviceStatuses: ['Unassigned', 'Assigned', 'Scheduled', 'In Progress', 'Completed', 'Cancelled'], serviceUrgencies: ['Normal', 'Urgent', 'Immediate'] };
  });
  await page.evaluate(() => document.querySelector('#tabs [data-view="service"]').click());
  await page.waitForTimeout(600);

  if (!v2) {
    console.log('THE OTHER FACES KEEP ERP 1’S BREAKDOWN FORM');
    ok('the button still logs a breakdown', /Log Breakdown Call/.test(await page.textContent('#btn-new-breakdown')));
    await page.click('#btn-new-breakdown');
    await page.waitForTimeout(400);
    ok('with no call type, area or instruction', !(await page.$('#bd-type')) && !(await page.$('#bd-area')) && !(await page.$('#bd-instruction')));
    await page.click('#btn-bd-cancel');
    ok('no Local / Outstation filter', !(await page.$('#service-area-type')));
  } else {
    console.log('LOGGING A CALL');
    ok('the button logs any call', /Log Service Call/.test(await page.textContent('#btn-new-breakdown')));
    await page.click('#btn-new-breakdown');
    await page.waitForTimeout(500);
    ok('ERP 2’s call types, breakdown first', (await page.$$eval('#bd-type option', (o) => o.map((x) => x.value))).join() ===
      'Breakdown,Regular service,Spare change,Commissioning,Installation' && await page.inputValue('#bd-type') === 'Breakdown');
    ok('the areas, Local and Outstation', (await page.$$eval('#bd-area optgroup', (g) => g.map((x) => x.label))).join() === 'Local,Outstation');
    await page.selectOption('#bd-customer', { index: 1 });
    await page.selectOption('#bd-type', 'Spare change');
    await page.selectOption('#bd-area', 'Wardha');
    await page.fill('#bd-instruction', 'Take the separator');
    await page.fill('#bd-scope', 'Change the separator element');
    await reset();
    await page.click('#btn-bd-save');
    await page.waitForTimeout(500);
    const sent = ((await lastCall('createServiceJob')) || [])[0] || {};
    ok('logged with its type, area and instruction', sent.jobType === 'Spare change' && sent.area === 'Wardha' && sent.instruction === 'Take the separator' &&
      sent.scopeText === 'Change the separator element' && /logged as Spare change/.test(await msg()), sent);

    console.log('\nTHE LIST');
    ok('each call’s area, and how often it moved', /Wardha · Outstation/.test(await page.textContent('#service-tbody')) && /moved 1×/.test(await page.textContent('#service-tbody')));
    ok('the new call types to filter by', (await page.$$eval('#service-type option', (o) => o.map((x) => x.value))).filter((x) => ['Regular service', 'Spare change', 'Commissioning'].indexOf(x) !== -1).length === 3);
    await page.selectOption('#service-area-type', 'Local');
    await page.waitForTimeout(200);
    const local = await page.$$eval('#service-tbody tr', (r) => r.map((x) => x.textContent));
    ok('only the local calls', local.length === 1 && /SVJ-J2/.test(local[0]), local);
    await page.selectOption('#service-area-type', 'Outstation');
    await page.waitForTimeout(200);
    ok('or the outstation ones', (await page.$$eval('#service-tbody tr', (r) => r.map((x) => x.textContent))).every((t) => /SVJ-J1/.test(t)));
    await page.selectOption('#service-area-type', '');

    console.log('\nTHE JOB WINDOW');
    await page.click('[data-open-job="J1"]');
    await page.waitForTimeout(500);
    const visit = (await page.textContent('.sd-visit')).replace(/\s+/g, ' ');
    ok('the visit: area, day, time and the instruction', /Wardha · Outstation/.test(visit) && /30-10-2026 10:30/.test(visit) && /Instruction to the engineer: Carry an AOS kit/.test(visit), visit);
    ok('and every move, with the reason', /Moved 28-10-2026 → 30-10-2026: Customer asked for new date — Plant shut \(Sona, 27-10-2026\)/.test(visit), visit);
    ok('the day is moved only by Reschedule', await page.$eval('#sj-scheduled', (e) => e.disabled) && /use Reschedule/.test(await page.textContent('#sj-allocation-note')));
    await page.click('[data-sd="details"]');
    await page.waitForTimeout(300);
    ok('area and instruction, filled in', await shown('sd-det-backdrop') && await page.inputValue('#sd-det-area') === 'Wardha' &&
      await page.inputValue('#sd-det-instr') === 'Carry an AOS kit');
    await page.selectOption('#sd-det-area', 'Hingna MIDC');
    await page.fill('#sd-det-instr', 'Carry an AOS kit and a gasket set');
    await reset();
    await page.click('#btn-sd-det-save');
    await page.waitForTimeout(400);
    ok('saved', JSON.stringify(await lastCall('setServiceJobDetails')) === JSON.stringify(['J1', { area: 'Hingna MIDC', instruction: 'Carry an AOS kit and a gasket set' }]) &&
      /Area and instruction saved/.test(await msg()) && /Hingna MIDC · Local/.test(await page.textContent('.sd-visit')));
    await page.click('[data-sd="resched"]');
    await page.waitForTimeout(300);
    ok('reschedule asks for the date and the reason', await shown('sd-rs-backdrop') && /is on 30-10-2026/.test(await page.textContent('#sd-rs-sub')) &&
      (await page.$$eval('#sd-rs-reason option', (o) => o.length)) === 7);
    await page.fill('#sd-rs-date', '2026-11-02');
    await page.selectOption('#sd-rs-reason', 'Spares not available');
    await page.fill('#sd-rs-note', 'Kit arrives Monday');
    await reset();
    await page.click('#btn-sd-rs-save');
    await page.waitForTimeout(400);
    ok('moved, with the reason kept', JSON.stringify(await lastCall('rescheduleServiceJob')) === JSON.stringify(['J1', '2026-11-02', 'Spares not available', 'Kit arrives Monday']) &&
      /moved to 02-11-2026/.test(await msg()) && /Spares not available — Kit arrives Monday/.test(await page.textContent('.sd-visit')));
    await page.evaluate(() => document.getElementById('service-modal-backdrop').classList.remove('show'));
    await page.click('[data-open-job="J2"]');
    await page.waitForTimeout(500);
    ok('a job with no day yet is assigned, not rescheduled', !(await page.$('[data-sd="resched"]')) && !(await page.$eval('#sj-scheduled', (e) => e.disabled)));
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
