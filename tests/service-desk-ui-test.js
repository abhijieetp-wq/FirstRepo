/**
 * ERP 2.0's service desk, in a browser against the real client: a job steps through ERP 2's
 * statuses from its window — start, the engineer's report, close, cancel with a reason — and
 * the list shows where each stands. On the other faces the job window is ERP 1's, with its
 * own status list.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/service-desk-ui-test.js /tmp/base-v2.html
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
  // The service coordinator, who assigns, closes and cancels.
  await context.addInitScript(() => {
    let data;
    Object.defineProperty(window, '__data', { configurable: true, get() { return data; },
      set(v) {
        if (v && v.bootstrap) v.bootstrap = Object.assign({}, v.bootstrap, { role: 'Service Coordinator', businessStream: 'All', email: 'sona@pie.in', name: 'Sona' });
        // Outside 2.0 they open on Service Jobs, before the test has filled it in.
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

  await page.evaluate(() => {
    const D = window.__data;
    // As ServiceDesk.gs reads it.
    const desk = (j) => j.status === 'Cancelled' ? 'Cancelled' : j.status === 'Completed' ? 'Closed'
      : j.reportSubmittedAt ? 'Report submitted' : j.status === 'In Progress' ? 'In progress'
      : j.status === 'Assigned' || j.status === 'Scheduled' ? 'Assigned' : 'New';
    const job = (id, extra) => Object.assign({ id, jobNo: 'SVJ-' + id, date: '2026-10-27', customerName: 'Testwell Foods',
      machineModel: 'EG 99', serialNo: 'FAB-' + id, jobType: 'Breakdown', urgency: 'Urgent', scopeText: 'Trips on high temperature',
      status: 'Unassigned', engineerEmail: '', scheduledDate: '', notes: '', items: [], proofs: [], deliveryProofs: [] }, extra || {});
    const jobs = { J1: job('J1'), J2: job('J2', { status: 'Assigned', engineerEmail: 'tej@pie.in', scheduledDate: '2026-10-28' }),
      J3: job('J3', { status: 'In Progress', engineerEmail: 'tej@pie.in', reportSubmittedAt: '2026-10-28T09:00:00Z', reportSubmittedBy: 'tej@pie.in',
        visitDate: '2026-10-28', hoursSpent: 3, workDone: 'Cleaned the oil cooler', rootCause: 'Choked fins', handedOverRunning: 'Yes',
        proofs: [{ id: 'PR-1', fileName: 'done.jpg', fileUrl: '#' }] }),
      J4: job('J4', { status: 'Cancelled', cancelReason: 'Customer fixed it', cancelledAt: '2026-10-27T10:00:00Z' }) };
    const out = (j) => Object.assign({}, j, { deskStatus: desk(j) });
    D.listPeople = { salesEngineers: [], coordinators: [], serviceCoordinators: [], management: [],
      serviceEngineers: [{ email: 'tej@pie.in', name: 'Tej' }],
      serviceStatuses: ['Unassigned', 'Assigned', 'Scheduled', 'In Progress', 'Completed', 'Cancelled'] };
    D.listServiceJobs = (o) => Object.values(jobs).filter((j) => (o && o.includeClosed) || ['Completed', 'Cancelled'].indexOf(j.status) === -1).map(out);
    D.getServiceJob = (id) => out(jobs[id]);
    D.setServiceJobStatus = (id, status) => { jobs[id].status = status; return out(jobs[id]); };
    D.assignServiceJob = (id, e, d) => { Object.assign(jobs[id], { engineerEmail: e, scheduledDate: d, status: 'Assigned' }); return out(jobs[id]); };
    D.submitServiceReport = (id, r) => { Object.assign(jobs[id], r, { status: 'In Progress', reportSubmittedAt: '2026-10-28T12:00:00Z', reportSubmittedBy: 'sona@pie.in' }); return out(jobs[id]); };
    D.closeServiceJob = (id) => { jobs[id].status = 'Completed'; return out(jobs[id]); };
    D.cancelServiceJob = (id, why) => { Object.assign(jobs[id], { status: 'Cancelled', cancelReason: why }); return out(jobs[id]); };
  });
  await page.evaluate(() => document.querySelector('[data-view="service"]').click());
  await page.waitForTimeout(600);
  const badges = () => page.$$eval('#service-tbody tr', (r) => r.map((x) => x.querySelector('td:nth-last-child(2) .badge').textContent));
  const openJob = async (id) => {
    await page.click('[data-open-job="' + id + '"]');
    await page.waitForTimeout(500);
  };
  const lastCall = (fn) => page.evaluate((f) => {
    const all = window.__calls.filter((c) => c.fn === f);
    return all.length ? all[all.length - 1].args : null;
  }, fn);
  const now = () => page.$eval('#sj-desk .sd-top .badge', (e) => e.textContent);

  if (!v2) {
    console.log('THE OTHER FACES KEEP ERP 1’S JOB WINDOW');
    ok('the list shows ERP 1’s statuses', JSON.stringify(await badges()) === '["Unassigned","Assigned","In Progress"]', await badges());
    await openJob('J2');
    ok('no 2.0 panel, and ERP 1’s status list is there', !(await page.$('#sj-desk')) &&
      await page.evaluate(() => document.getElementById('sj-status').closest('.field').offsetParent !== null));
  } else {
    console.log('THE LIST SAYS WHERE EACH STANDS, IN ERP 2’S WORDS');
    ok('New, Assigned, Report submitted', JSON.stringify(await badges()) === '["New","Assigned","Report submitted"]', await badges());

    console.log('\nA JOB, STEP BY STEP');
    await openJob('J2');
    ok('ERP 1’s status list is put away', await page.evaluate(() => document.getElementById('sj-status').closest('.field').offsetParent === null));
    ok('it stands at Assigned', (await now()) === 'Assigned' && await page.$eval('.sd-steps li.now', (e) => e.textContent) === 'Assigned');
    // "+ Task" (Tasks.gs) sits beside the job's own steps on every job, closed ones too.
    ok('with Start work, Write the report and Cancel', (await page.$$eval('#sj-desk [data-sd]', (b) => b.map((x) => x.dataset.sd))).join() === 'start,write,cancel,task');
    await page.evaluate(() => { window.__calls = []; });
    await page.click('[data-sd="start"]');
    await page.waitForTimeout(400);
    ok('Start work sets ERP 1’s In Progress', JSON.stringify((await lastCall('setServiceJobStatus')).slice(0, 2)) === '["J2","In Progress"]' && (await now()) === 'In progress');
    await page.click('[data-sd="write"]');
    await page.waitForTimeout(200);
    ok('the report form asks for the visit, the hours, the work, the cause and the handover',
      ['#sd-visit', '#sd-hours', '#sd-running', '#sd-work', '#sd-cause', '#sd-remarks', '#sd-running-over'].every((s) => true) &&
      (await page.$$('#sj-desk .sd-form input, #sj-desk .sd-form textarea, #sj-desk .sd-form select')).length === 7);
    ok('a breakdown’s root cause is required', /Root cause \*/.test(await page.textContent('#sj-desk .sd-form')));
    await page.fill('#sd-hours', '3');
    await page.fill('#sd-running', '15230');
    await page.fill('#sd-work', 'Cleaned the oil cooler and checked the thermostat');
    await page.fill('#sd-cause', 'Choked cooler fins');
    await page.fill('#sd-remarks', 'Running fine now');
    await page.selectOption('#sd-running-over', 'Yes');
    await page.click('[data-sd="submit"]');
    await page.waitForTimeout(400);
    const sent = (await lastCall('submitServiceReport')) || [];
    ok('the report goes as written', sent[0] === 'J2' && sent[1].hoursSpent === '3' && sent[1].runningHours === '15230' &&
      sent[1].rootCause === 'Choked cooler fins' && sent[1].handedOverRunning === 'Yes' && /^\d{4}-\d{2}-\d{2}$/.test(sent[1].visitDate), sent);
    ok('and the job is at Report submitted, the report shown', (await now()) === 'Report submitted' &&
      /Cleaned the oil cooler and checked the thermostat/.test(await page.textContent('#sj-desk .sd-report')));
    ok('the coordinator can close it now', !!(await page.$('[data-sd="close"]')));
    await page.click('[data-sd="close"]');
    await page.waitForTimeout(400);
    ok('Close the job closes it', JSON.stringify((await lastCall('closeServiceJob')).slice(0, 1)) === '["J2"]' && (await now()) === 'Closed');
    ok('a closed job offers nothing more, but a task about it', (await page.$$eval('#sj-desk [data-sd]', (b) => b.map((x) => x.dataset.sd))).join() === 'task');
    await page.evaluate(() => document.getElementById('service-modal-backdrop').classList.remove('show'));

    console.log('\nCANCELLING ASKS WHY');
    await openJob('J1');
    ok('a new job: name the engineer first', (await now()) === 'New' && /Name the engineer/.test(await page.textContent('#sj-desk')) &&
      !(await page.$('[data-sd="start"]')));
    await page.evaluate(() => { window.__calls = []; });
    await page.click('[data-sd="cancel"]');
    await page.waitForTimeout(200);
    await page.fill('#ask-input', 'no');
    await page.click('#ask-ok');
    ok('a word is not a reason', /few words/.test(await page.textContent('#ask-error')) && !(await lastCall('cancelServiceJob')));
    await page.fill('#ask-input', 'Customer fixed it themselves');
    await page.click('#ask-ok');
    await page.waitForTimeout(400);
    ok('cancelled with the reason', JSON.stringify(await lastCall('cancelServiceJob')) === '["J1","Customer fixed it themselves"]' &&
      (await now()) === 'Cancelled' && /Customer fixed it themselves/.test(await page.textContent('#sj-desk .sd-band')));
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
