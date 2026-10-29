/**
 * ERP 2.0's next-day plan, in a browser against the real client: each engineer's visits for
 * the day, the visit's time, the WhatsApp message (one for the group or one per engineer) and
 * the jobs not on the plan yet put on it. Only the 2.0 face has it; the others must not offer
 * it at all.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/next-day-plan-ui-test.js /tmp/base-v2.html
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
  // The service coordinator, who plans the day.
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
  const active = () => page.evaluate(() => document.querySelector('.view.active').id);

  if (!v2) {
    console.log('THE OTHER FACES HAVE NO NEXT-DAY PLAN');
    ok('not in the menu', !(await page.$('#tabs [data-view="plan"]')));
    ok('no screen for it', !(await page.$('#view-plan')));
  } else {
    await page.evaluate(() => {
      const D = window.__data;
      // The browser's tomorrow, as the quick buttons work it out.
      const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n);
        return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); };
      window.__plus = plus;
      const visit = (id, extra) => Object.assign({ id, jobNo: 'SVJ-' + id, jobType: 'Installation', urgency: 'Normal', customerName: 'Testwell Foods',
        city: 'Pune', machineModel: 'EG 99', serialNo: 'FAB-' + id, scopeText: 'Fit the parts', contactName: 'Mr Rao', contactPhone: '9800000001',
        engineerEmail: 'tej@pie.in', engineerName: 'Tej', scheduledDate: plus(1), scheduledTime: '', deskStatus: 'Assigned', date: plus(-1) }, extra || {});
      D.getNextDayPlan = (o) => {
        const date = (o && o.date) || plus(1);
        const busy = date === plus(1);
        return { date, today: plus(0), canAssign: true,
          engineers: [{ email: 'om@pie.in', name: 'Om' }, { email: 'tej@pie.in', name: 'Tej' }],
          plan: [
            { email: 'om@pie.in', name: 'Om', visits: busy ? [visit('J3', { engineerEmail: 'om@pie.in', engineerName: 'Om', customerName: 'Brightline Mills',
              city: 'Nashik', jobType: 'Breakdown', scopeText: 'Trips on high temperature', contactName: '', contactPhone: '' })] : [] },
            { email: 'tej@pie.in', name: 'Tej', visits: busy ? [visit('J2', { scheduledTime: '10:00', jobType: 'AMC visit', scopeText: 'Quarterly service' }),
              visit('J1', { scheduledTime: '14:00' })] : [] }],
          visits: busy ? 3 : 0,
          unassigned: [visit('J5', { engineerEmail: '', engineerName: '', scheduledDate: '', urgency: 'Immediate', jobType: 'Breakdown', scopeText: 'Will not start' })],
          undated: [visit('J6', { scheduledDate: '' })],
          amcDue: [{ id: 'AMV-1', contractId: 'AMC-1', contractNo: 'AMC2610-001', customerName: 'Topworth Urja', visitNo: 2, visitOf: 4,
            amcType: 'Comprehensive', dueDate: plus(1), state: 'Due' }] };
      };
      D.setServiceJobTime = (id, t) => ({ id, scheduledTime: t });
      D.assignServiceJob = (id) => ({ id, jobNo: 'SVJ-' + id });
      D.makeAmcVisitCall = () => ({ jobId: 'SVJ-10', jobNo: 'SVJ2610-010' });
      D.getServiceJob = (id) => Object.assign(visit(id), { status: 'Assigned', notes: '', items: [], proofs: [], deliveryProofs: [] });
      D.listPeople = { salesEngineers: [], coordinators: [], serviceCoordinators: [], management: [],
        serviceEngineers: [{ email: 'tej@pie.in', name: 'Tej' }, { email: 'om@pie.in', name: 'Om' }],
        serviceStatuses: ['Unassigned', 'Assigned', 'Scheduled', 'In Progress', 'Completed', 'Cancelled'] };
    });

    console.log('THE PLAN IN THE MENU, ON ITS OWN SCREEN');
    ok('in the menu', !!(await page.$('#tabs [data-view="plan"]')));
    await page.evaluate(() => { window.__calls = []; document.querySelector('#tabs [data-view="plan"]').click(); });
    await page.waitForTimeout(500);
    ok('opens', (await active()) === 'view-plan');
    ok('on tomorrow, unless another day is asked for', JSON.stringify(await lastCall('getNextDayPlan')) === '[{}]' &&
      await page.inputValue('#np-date') === await page.evaluate(() => window.__plus(1)) &&
      await page.$eval('[data-np-plus="1"]', (b) => b.classList.contains('on')));
    ok('how many are going and how many visits', /2 engineers · 3 visits/.test(await page.textContent('#np-sum')), await page.textContent('#np-sum'));

    console.log('\nEACH ENGINEER’S DAY');
    const engs = await page.$$eval('#np-plan .np-eng', (e) => e.map((x) => x.textContent.replace(/\s+/g, ' ')));
    ok('one block each, with their visits', engs.length === 2 && /Om/.test(engs[0]) && /1 visit/.test(engs[0]) && /Tej/.test(engs[1]) && /2 visits/.test(engs[1]), engs);
    const times = await page.$$eval('#np-plan .np-eng:nth-child(3) .np-time', (t) => t.map((x) => x.value));
    ok('in time order, the time editable', times.join() === '10:00,14:00', times);
    ok('each visit with the customer, town, type and job', /Brightline Mills, Nashik/.test(engs[0]) && /Breakdown · SVJ-J3/.test(engs[0]));
    await page.evaluate(() => { window.__calls = []; });
    // Filling a time box fires its change, as picking a time does; the plan is then drawn again.
    await page.fill('[data-np-time="J3"]', '09:30');
    await page.waitForFunction(() => /Visit time set to 09:30/.test(document.getElementById('msg-box').textContent), null, { timeout: 3000 }).catch(() => {});
    ok('a time set is saved and the plan read again', JSON.stringify(await page.evaluate(() => window.__calls.filter((c) => c.fn === 'setServiceJobTime').map((c) => c.args))) === '[["J3","09:30"]]' &&
      !!(await lastCall('getNextDayPlan')) && /Visit time set to 09:30/.test(await page.textContent('#msg-box')), await page.evaluate(() => window.__calls.filter((c) => c.fn === 'setServiceJobTime')));
    await page.click('[data-np-job="J1"] .np-main');
    await page.waitForTimeout(500);
    ok('a visit opens its service job', JSON.stringify(await lastCall('getServiceJob')) === '["J1"]' &&
      await page.$eval('#service-modal-backdrop', (e) => e.classList.contains('show')));
    await page.evaluate(() => document.getElementById('service-modal-backdrop').classList.remove('show'));

    console.log('\nTHE WHATSAPP MESSAGE');
    const msg = await page.textContent('#np-wa-all');
    ok('headed with the day', /^\*Service plan, \w{3} /.test(msg), msg.slice(0, 60));
    ok('each engineer by name, their visits in order', /\*Om\*\nAny time Brightline Mills, Nashik – Breakdown: Trips on high temperature \(SVJ-J3\)/.test(msg) &&
      /\*Tej\*\n10:00 Testwell Foods, Pune – AMC visit: Quarterly service \(SVJ-J2\)\n {4}Mr Rao 9800000001\n14:00 /.test(msg), msg);
    ok('ending with the report reminder', /Send the report from the ERP after each visit\.$/.test(msg));
    await page.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } } });
    });
    await page.click('[data-np-copy="np-wa-all"]');
    await page.waitForTimeout(200);
    ok('copied with one press', (await page.evaluate(() => window.__copied)) === msg && (await page.textContent('[data-np-copy="np-wa-all"]')) === 'Copied');
    await page.check('#np-per');
    await page.waitForTimeout(200);
    const each = await page.$$eval('#np-msg .np-wa', (p) => p.map((x) => x.textContent));
    ok('or one message per engineer', each.length === 2 && /\*Om\*/.test(each[0]) && !/\*Tej\*/.test(each[0]) && /\*Tej\*/.test(each[1]) &&
      (await page.textContent('[data-np-copy="np-wa-1"]')) === 'Copy for Tej', each);
    await page.click('[data-np-copy="np-wa-1"]');
    await page.waitForTimeout(200);
    ok('each copied on its own', (await page.evaluate(() => window.__copied)) === each[1]);

    console.log('\nWHAT IS NOT ON THE PLAN YET');
    const lists = await page.$$eval('#np-todo .pd-panel', (p) => p.map((x) => x.textContent.replace(/\s+/g, ' ')));
    ok('jobs nobody is going on, jobs with no day, AMC visits due', lists.length === 3 && /Not assigned yet/.test(lists[0]) && /Immediate/.test(lists[0]) &&
      /An engineer, but no day/.test(lists[1]) && /SVJ-J6/.test(lists[1]) && /AMC visit 2 of 4/.test(lists[2]), lists);
    await page.evaluate(() => { window.__calls = []; });
    await page.click('[data-np-assign="J5"]');
    await page.waitForTimeout(300);
    ok('sending somebody needs the engineer', !(await lastCall('assignServiceJob')) && /Pick the engineer/.test(await page.textContent('#msg-box')));
    await page.selectOption('[data-np-eng="J5"]', 'om@pie.in');
    await page.click('[data-np-assign="J5"]');
    await page.waitForTimeout(400);
    const day = await page.evaluate(() => window.__plus(1));
    ok('and puts the job on the day, with them', JSON.stringify(await lastCall('assignServiceJob')) === JSON.stringify(['J5', 'om@pie.in', day]) &&
      /SVJ-J5 is on the plan/.test(await page.textContent('#msg-box')));
    await page.click('[data-np-put="J6"]');
    await page.waitForTimeout(400);
    ok('a job with an engineer but no day goes on the day, same engineer', JSON.stringify(await lastCall('assignServiceJob')) === JSON.stringify(['J6', 'tej@pie.in', day]));
    await page.click('[data-np-amc="AMV-1"]');
    await page.waitForTimeout(400);
    ok('an AMC visit due becomes a service job', JSON.stringify(await lastCall('makeAmcVisitCall')) === '["AMV-1"]' &&
      /SVJ2610-010 made/.test(await page.textContent('#msg-box')));

    console.log('\nANOTHER DAY');
    await page.click('[data-np-plus="2"]');
    await page.waitForTimeout(400);
    ok('the day after, asked of the server', JSON.stringify(await lastCall('getNextDayPlan')) === JSON.stringify([{ date: await page.evaluate(() => window.__plus(2)) }]));
    ok('nothing planned yet says so', /Nothing planned for this day yet/.test(await page.textContent('#np-msg')) &&
      (await page.$$eval('#np-plan .eb-chip', (c) => c.map((x) => x.textContent))).join() === 'Free,Free');
    await page.fill('#np-date', '2026-12-01');
    await page.waitForTimeout(400);
    ok('or any day picked', JSON.stringify(await lastCall('getNextDayPlan')) === '[{"date":"2026-12-01"}]');

    console.log('\nAN ENGINEER SEES THEIR DAY, NOT THE PLANNING');
    await page.evaluate(() => {
      const D = window.__data;
      const was = D.getNextDayPlan;
      D.getNextDayPlan = (o) => Object.assign(was(o), { canAssign: false, unassigned: [], undated: [], amcDue: [] });
    });
    await page.click('[data-np-plus="1"]');
    await page.waitForTimeout(400);
    ok('times read, not set', !(await page.$('#np-plan .np-time')) && (await page.$$('#np-plan .np-time-text')).length === 3);
    ok('and no lists to plan from', (await page.$$('#np-todo .pd-panel')).length === 0);
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
