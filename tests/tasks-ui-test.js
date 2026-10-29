/**
 * ERP 2.0's tasks with the scorecard, in a browser against the real client: the scorecard, the
 * list and its filters, ticking a task done, a task opened, changed and deleted, a new task,
 * a task about a service job and about an enquiry board card, the scoring rules, the period,
 * and what somebody who is not Management may touch. Only the 2.0 face has it; the others must
 * not offer it at all.
 *
 *   node tests/build-preview.js tests/fixtures/base.html /tmp/base-v2.html --ui=v2
 *   node tests/tasks-ui-test.js /tmp/base-v2.html
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
  // Management, who sees everybody's tasks and sets the scoring.
  await context.addInitScript(() => {
    let data;
    Object.defineProperty(window, '__data', { configurable: true, get() { return data; },
      set(v) {
        if (v && v.bootstrap) v.bootstrap = Object.assign({}, v.bootstrap, { role: 'Management', businessStream: 'All', email: 'mona@pie.in', name: 'Mona' });
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
  const calls = (fn) => page.evaluate((f) => window.__calls.filter((c) => c.fn === f).map((c) => c.args), fn);
  const active = () => page.evaluate(() => document.querySelector('.view.active').id);
  const rows = () => page.$$eval('#tk-body tbody tr[data-tk-row]', (r) => r.map((x) => x.dataset.tkRow)).catch(() => []);
  const msg = () => page.textContent('#msg-box');
  const reset = () => page.evaluate(() => { window.__calls = []; });

  if (!v2) {
    console.log('THE OTHER FACES HAVE NO TASKS');
    ok('not in the menu', !(await page.$('#tabs [data-view="tasks"]')));
    ok('no screen for it', !(await page.$('#view-tasks')));
    ok('and no task window', !(await page.$('#tk-modal-backdrop')));
  } else {
    await page.evaluate(() => {
      const D = window.__data;
      const task = (id, extra) => Object.assign({ id, title: 'Task ' + id, details: '', assigneeEmail: 'tej@pie.in', assigneeName: 'Tej',
        byEmail: 'sona@pie.in', byName: 'Sona', dueDate: '2026-10-30', priority: 'Normal', status: 'Open', link: null, doneDay: '', doneByName: '',
        cancelledDay: '', createdDay: '2026-10-20', state: 'open', label: 'Open', earned: 0, possible: 0, points: 10, daysLate: 0, daysOver: 0,
        canEdit: true, canTick: true }, extra || {});
      window.__tasks = [
        task('T1', { title: 'Send the breakdown report to Testwell', details: 'With the photographs', priority: 'High', dueDate: '2026-10-27',
          state: 'overdue', label: 'Overdue', earned: -7.5, possible: 15, points: 15, daysOver: 2,
          link: { kind: 'service', id: 'J1', label: 'SVJ-J1 · Testwell Foods', word: 'Service job' } }),
        task('T2', { title: 'Check the oil stock' }),
        task('T3', { title: 'Call Brightline about the renewal', assigneeEmail: 'p@pie.in', assigneeName: 'Priya', priority: 'Low', status: 'Done',
          state: 'ontime', label: 'Done on time', doneDay: '2026-10-20', earned: 5, possible: 5, points: 5,
          link: { kind: 'lead', id: 'L1', label: 'LD2610-001 · Brightline Mills', word: 'Compressor lead' } }),
        task('T4', { title: 'Update the price list from the circular', assigneeEmail: 'k@pie.in', assigneeName: 'Kiran', status: 'Done', state: 'late',
          label: 'Done late', doneDay: '2026-10-25', daysLate: 3, earned: 5, possible: 10 }),
        task('T5', { title: 'Visit the old site', status: 'Cancelled', state: 'cancelled', label: 'Cancelled' })
      ];
      window.__boss = true;
      D.getTasks = (o) => {
        const custom = o && o.period === 'custom';
        return { today: '2026-10-29', me: 'mona@pie.in', boss: window.__boss, canScore: window.__boss,
          period: { key: (o && o.period) || 'month', from: custom ? o.from : '2026-10-01', to: custom ? o.to : '2026-10-31' },
          periods: [{ key: 'month', label: 'This month' }, { key: 'lastmonth', label: 'Last month' }, { key: 'quarter', label: 'This quarter' },
            { key: 'fy', label: 'This financial year' }, { key: 'custom', label: 'Custom range' }],
          scoring: { High: 15, Normal: 10, Low: 5, latePct: 50, overduePct: 50 }, priorities: ['High', 'Normal', 'Low'],
          statuses: ['Open', 'In progress', 'Done', 'Cancelled'],
          people: [{ email: 'k@pie.in', name: 'Kiran', role: 'Sales Coordinator' }, { email: 'mona@pie.in', name: 'Mona', role: 'Management' },
            { email: 'p@pie.in', name: 'Priya', role: 'Sales Coordinator' }, { email: 'tej@pie.in', name: 'Tej', role: 'Service Engineer' }],
          scorecard: window.__boss ? [
            { email: 'p@pie.in', name: 'Priya', role: 'Sales Coordinator', tasks: 1, onTime: 1, late: 0, overdue: 0, open: 0, earned: 5, possible: 5, score: 100 },
            { email: 'k@pie.in', name: 'Kiran', role: 'Sales Coordinator', tasks: 1, onTime: 0, late: 1, overdue: 0, open: 0, earned: 5, possible: 10, score: 50 },
            { email: 'tej@pie.in', name: 'Tej', role: 'Service Engineer', tasks: 3, onTime: 0, late: 0, overdue: 1, open: 2, earned: -7.5, possible: 15, score: 0 }]
            : [{ email: 'tej@pie.in', name: 'Tej', role: 'Service Engineer', tasks: 3, onTime: 0, late: 0, overdue: 1, open: 2, earned: -7.5, possible: 15, score: 0 }],
          tasks: window.__tasks };
      };
      D.getTask = (id) => window.__tasks.find((t) => t.id === id);
      D.saveTask = (i) => Object.assign({}, window.__tasks[0], i, { id: i.id || 'T9', assigneeName: i.assigneeEmail === 'tej@pie.in' ? 'Tej' : 'Priya' });
      D.setTaskStatus = (id, s) => Object.assign({}, window.__tasks.find((t) => t.id === id), { status: s,
        state: s === 'Done' ? 'ontime' : s === 'In progress' ? 'progress' : 'open' });
      D.deleteTask = () => ({ deleted: true });
      D.saveTaskScoring = (s) => s;
      D.getServiceJob = (id) => ({ id, jobNo: 'SVJ-' + id, date: '2026-10-27', customerName: 'Testwell Foods', machineModel: 'EG 99', serialNo: 'FAB-1',
        jobType: 'Breakdown', urgency: 'Urgent', status: 'Assigned', deskStatus: 'Assigned', engineerEmail: 'tej@pie.in', scheduledDate: '2026-10-28',
        notes: '', items: [], proofs: [], deliveryProofs: [] });
      D.listPeople = { salesEngineers: [], coordinators: [], serviceCoordinators: [], management: [],
        serviceEngineers: [{ email: 'tej@pie.in', name: 'Tej' }],
        serviceStatuses: ['Unassigned', 'Assigned', 'Scheduled', 'In Progress', 'Completed', 'Cancelled'] };
    });

    console.log('TASKS IN THE MENU, ON THEIR OWN SCREEN');
    const menu = await page.$$eval('#tabs [data-view]', (b) => b.map((x) => x.dataset.view));
    ok('in the menu, next to the Dashboard', menu.indexOf('tasks') === menu.indexOf('dashboard') + 1, menu);
    await reset();
    await page.evaluate(() => document.querySelector('#tabs [data-view="tasks"]').click());
    await page.waitForTimeout(500);
    ok('opens, on this month', (await active()) === 'view-tasks' && JSON.stringify(await lastCall('getTasks')) === '[{"period":"month"}]' &&
      await page.inputValue('#tk-period') === 'month' && /01-10-2026 to 31-10-2026/.test(await page.textContent('#tk-range')));

    console.log('\nTHE SCORECARD');
    const sc = await page.$$eval('#tk-score tbody tr', (r) => r.map((x) => Array.from(x.cells).map((c) => c.innerText.replace(/\s+/g, ' ').trim()).join('|')));
    ok('one line a person, best first', sc.length === 3 && /^Priya/.test(sc[0]) && /^Kiran/.test(sc[1]) && /^Tej/.test(sc[2]), sc);
    ok('their counts, points and score', sc[0] === 'Priya Sales Coordinator|1|1|0|0|0|5 / 5|100%' && sc[1] === 'Kiran Sales Coordinator|1|0|1|0|0|5 / 10|50%' &&
      sc[2] === 'Tej Service Engineer|3|0|0|1|2|-7.5 / 15|0%', sc);
    ok('the rules beside it', /On time = all the points · late = 50% · overdue = −50% · High 15, Normal 10, Low 5/.test(await page.textContent('#tk-score')));
    ok('overdue stands out', await page.$eval('#tk-score tbody tr:nth-child(3) td:nth-child(5)', (e) => e.classList.contains('sdc-late')));

    console.log('\nTHE LIST');
    ok('open tasks first', (await rows()).join() === 'T1,T2', await rows());
    const t1 = await page.textContent('[data-tk-row="T1"]');
    ok('each with who, by whom, when, priority, where it stands and the points', /Send the breakdown report to Testwell/.test(t1) &&
      /SVJ-J1 · Testwell Foods/.test(t1) && /With the photographs/.test(t1) && /Tej/.test(t1) && /Sona/.test(t1) && /27-10-2026/.test(t1) &&
      /2 days overdue/.test(t1) && /High/.test(t1) && /Overdue/.test(t1) && /-7\.5$/.test(t1.trim()), t1);
    const show = async (k) => { await page.click('[data-tk-show="' + k + '"]'); await page.waitForTimeout(100); return (await rows()).join(); };
    ok('overdue', (await show('overdue')) === 'T1');
    ok('done, on time and late', (await show('done')) === 'T3,T4' && /3 days late/.test(await page.textContent('[data-tk-row="T4"]')));
    ok('everything', (await show('all')) === 'T1,T2,T3,T4,T5');
    await page.fill('#tk-search', 'price');
    await page.waitForTimeout(100);
    ok('searched', (await rows()).join() === 'T4');
    await page.fill('#tk-search', '');
    await page.selectOption('#tk-who', 'tej@pie.in');
    await page.waitForTimeout(100);
    ok('by who is doing it', (await rows()).join() === 'T1,T2,T5');
    await page.selectOption('#tk-who', '');
    await page.check('#tk-mine');
    await page.waitForTimeout(100);
    ok('or only mine', (await rows()).length === 0 && /No tasks here/.test(await page.textContent('#tk-body')));
    await page.uncheck('#tk-mine');
    await page.click('#tk-score tbody tr:nth-child(2)');
    await page.waitForTimeout(100);
    ok('a scorecard line shows that person’s tasks in the period', (await rows()).join() === 'T4' && await page.inputValue('#tk-who') === 'k@pie.in');
    await page.selectOption('#tk-who', '');
    await show('open');

    console.log('\nTICKING');
    await reset();
    await page.check('[data-tk-done="T2"]');
    await page.waitForTimeout(300);
    ok('ticked is done', JSON.stringify(await lastCall('setTaskStatus')) === '["T2","Done"]' && /Done on time/.test(await msg()) && !!(await lastCall('getTasks')));
    await show('done');
    await page.uncheck('[data-tk-done="T3"]');
    await page.waitForTimeout(300);
    ok('unticked is open again', JSON.stringify(await lastCall('setTaskStatus')) === '["T3","Open"]' && /Opened again/.test(await msg()));
    await show('all');
    ok('a cancelled task cannot be ticked', await page.$eval('[data-tk-done="T5"]', (e) => e.disabled));
    await show('open');

    console.log('\nA TASK OPENED');
    await page.click('[data-tk-open="T1"]');
    await page.waitForTimeout(300);
    ok('with what it says', (await page.textContent('#tk-m-title')) === 'Send the breakdown report to Testwell' &&
      await page.inputValue('#tk-f-title') === 'Send the breakdown report to Testwell' && await page.inputValue('#tk-f-who') === 'tej@pie.in' &&
      await page.inputValue('#tk-f-due') === '2026-10-27' && await page.inputValue('#tk-f-pr') === 'High' && await page.inputValue('#tk-f-status') === 'Open');
    ok('who gave it, where it stands, and what it is about', /Given by Sona on 20-10-2026/.test(await page.textContent('#tk-m-sub')) &&
      /Overdue -7\.5 of 15 points/.test((await page.textContent('.tk-stand')).replace(/\s+/g, ' ')) && /About SVJ-J1 · Testwell Foods/.test(await page.textContent('.tk-about')));
    ok('priorities with their points', (await page.$$eval('#tk-f-pr option', (o) => o.map((x) => x.textContent))).join() === 'High · 15 points,Normal · 10 points,Low · 5 points');
    await page.fill('#tk-f-due', '2026-11-02');
    await page.selectOption('#tk-f-pr', 'Normal');
    await page.selectOption('#tk-f-status', 'In progress');
    await reset();
    await page.click('#btn-tk-save');
    await page.waitForTimeout(400);
    const saved = ((await lastCall('saveTask')) || [])[0] || {};
    ok('changes saved', saved.id === 'T1' && saved.dueDate === '2026-11-02' && saved.priority === 'Normal' && saved.assigneeEmail === 'tej@pie.in' &&
      saved.title === 'Send the breakdown report to Testwell' && !saved.linkKind, saved);
    ok('then the status', JSON.stringify(await lastCall('setTaskStatus')) === '["T1","In progress"]' && /Marked in progress/.test(await msg()) &&
      !(await page.$eval('#tk-modal-backdrop', (e) => e.classList.contains('show'))));
    await page.click('[data-tk-open="T2"]');
    await page.waitForTimeout(300);
    await page.selectOption('#tk-f-status', 'Done');
    await reset();
    await page.click('#btn-tk-save');
    await page.waitForTimeout(400);
    ok('only the status changed, only the status sent', !(await lastCall('saveTask')) && JSON.stringify(await lastCall('setTaskStatus')) === '["T2","Done"]');
    await page.click('[data-tk-open="T1"]');
    await page.waitForTimeout(300);
    await page.click('.tk-about [data-tk-link]');
    await page.waitForTimeout(500);
    ok('the record it is about opens', JSON.stringify(await lastCall('getServiceJob')) === '["J1"]' &&
      await page.$eval('#service-modal-backdrop', (e) => e.classList.contains('show')) && !(await page.$eval('#tk-modal-backdrop', (e) => e.classList.contains('show'))));

    console.log('\nA TASK ABOUT A SERVICE JOB');
    ok('+ Task on the job', !!(await page.$('[data-sd="task"]')));
    await page.click('[data-sd="task"]');
    await page.waitForTimeout(300);
    ok('a new task about it', (await page.textContent('#tk-m-title')) === 'New task' && /About SVJ-J1 · Testwell Foods/.test(await page.textContent('.tk-about')) &&
      !(await page.isVisible('#btn-tk-delete')) && !(await page.$('#tk-f-status')));
    await page.fill('#tk-f-title', 'Order the gasket kit');
    await page.selectOption('#tk-f-who', 'tej@pie.in');
    await page.fill('#tk-f-due', '2026-11-05');
    await page.selectOption('#tk-f-pr', 'High');
    await reset();
    await page.click('#btn-tk-save');
    await page.waitForTimeout(400);
    const made = ((await lastCall('saveTask')) || [])[0] || {};
    ok('given, with the job it is about', made.id === '' && made.title === 'Order the gasket kit' && made.assigneeEmail === 'tej@pie.in' &&
      made.dueDate === '2026-11-05' && made.priority === 'High' && made.linkKind === 'service' && made.linkId === 'J1' && /Task given to Tej/.test(await msg()), made);
    await page.evaluate(() => document.getElementById('service-modal-backdrop').classList.remove('show'));

    console.log('\nA NEW TASK');
    await page.click('#btn-new-task');
    await page.waitForTimeout(300);
    ok('a blank form, about nothing', (await page.inputValue('#tk-f-title')) === '' && !(await page.$('.tk-about')) && await page.inputValue('#tk-f-pr') === 'Normal' &&
      (await page.textContent('#btn-tk-save')) === 'Give the task');
    await page.evaluate(() => { window.__failNext = 'saveTask'; });
    await page.click('#btn-tk-save');
    await page.waitForTimeout(400);
    ok('the server’s refusal is shown and the form stays', /deliberate failure/.test(await msg()) &&
      await page.$eval('#tk-modal-backdrop', (e) => e.classList.contains('show')) && !(await page.$eval('#btn-tk-save', (b) => b.disabled)));
    await page.click('#btn-tk-cancel');

    console.log('\nDELETING');
    await page.click('[data-tk-open="T1"]');
    await page.waitForTimeout(300);
    await page.click('#btn-tk-delete');
    await page.waitForTimeout(200);
    await page.click('#ask-ok');
    await page.waitForTimeout(400);
    ok('after asking', JSON.stringify(await lastCall('deleteTask')) === '["T1"]' && /Task deleted/.test(await msg()));

    console.log('\nTHE SCORING');
    await page.click('#btn-tk-scoring');
    await page.waitForTimeout(200);
    ok('the rules as they stand', await page.inputValue('#tk-s-High') === '15' && await page.inputValue('#tk-s-latePct') === '50' &&
      await page.inputValue('#tk-s-overduePct') === '50');
    await page.fill('#tk-s-latePct', '25');
    await reset();
    await page.click('#btn-tk-s-save');
    await page.waitForTimeout(400);
    ok('changed by Management', JSON.stringify(await lastCall('saveTaskScoring')) ===
      JSON.stringify([{ High: '15', Normal: '10', Low: '5', latePct: '25', overduePct: '50' }]) && /Scoring saved/.test(await msg()));

    console.log('\nTHE PERIOD');
    await reset();
    await page.selectOption('#tk-period', 'quarter');
    await page.waitForTimeout(300);
    ok('asked of the server', JSON.stringify(await lastCall('getTasks')) === '[{"period":"quarter"}]');
    await page.selectOption('#tk-period', 'custom');
    await page.waitForTimeout(300);
    ok('a custom range shows its dates', await page.isVisible('#tk-from') && await page.isVisible('#tk-to'));
    await page.fill('#tk-from', '2026-09-15');
    await page.waitForTimeout(300);
    ok('and asks for them', JSON.stringify(await lastCall('getTasks')) === '[{"period":"custom","from":"2026-09-15","to":"2026-10-31"}]', await lastCall('getTasks'));

    console.log('\nA TASK ABOUT AN ENQUIRY');
    await page.evaluate(() => document.querySelector('#tabs [data-view="enquiries"]').click());
    await page.waitForTimeout(600);
    await page.click('[data-eb-card="SE:E1"]');
    await page.waitForTimeout(300);
    ok('+ Task on the board card', !!(await page.$('[data-eb-task]')));
    await page.click('[data-eb-task]');
    await page.waitForTimeout(300);
    const about = await page.textContent('.tk-about');
    await page.fill('#tk-f-title', 'Ring the customer about the offer');
    await page.selectOption('#tk-f-who', 'p@pie.in');
    await reset();
    await page.click('#btn-tk-save');
    await page.waitForTimeout(400);
    const e1 = ((await lastCall('saveTask')) || [])[0] || {};
    ok('given, with the enquiry it is about', e1.linkKind === 'enquiry' && e1.linkId === 'E1' && /^About .+/.test(about), [e1, about]);
    ok('and the card is still open behind it', await page.$eval('#eb-modal-backdrop', (e) => e.classList.contains('show')));
    await page.click('#eb-m-close');

    console.log('\nSOMEBODY WHO IS NOT MANAGEMENT');
    await page.evaluate(() => {
      window.__boss = false;
      window.__tasks.forEach((t) => { t.canEdit = false; });
    });
    await page.evaluate(() => document.querySelector('#tabs [data-view="tasks"]').click());
    await page.waitForTimeout(500);
    ok('their own line of the scorecard, no scoring', (await page.$$('#tk-score tbody tr')).length === 1 && !(await page.$('#btn-tk-scoring')));
    await page.click('[data-tk-open="T2"]');
    await page.waitForTimeout(300);
    ok('a task they were given: what it says is not theirs to change', await page.$eval('#tk-f-title', (e) => e.disabled) &&
      await page.$eval('#tk-f-due', (e) => e.disabled) && await page.$eval('#tk-f-who', (e) => e.disabled) && !(await page.isVisible('#btn-tk-delete')));
    ok('where it stands is, short of cancelling', !(await page.$eval('#tk-f-status', (e) => e.disabled)) &&
      (await page.$$eval('#tk-f-status option', (o) => o.map((x) => x.value))).join() === 'Open,In progress,Done' &&
      /whoever gave it changes the rest/.test(await page.textContent('#tk-m-sub')));
    await page.click('#btn-tk-cancel');
  }
  ok('with no script errors', errors.length === 0, errors);
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
