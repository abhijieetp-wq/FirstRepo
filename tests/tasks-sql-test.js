/**
 * ERP 2.0's tasks with a scorecard, on the server: giving a task, who sees and changes what,
 * ERP 2's scoring (on time, late, overdue, by priority), the rules Management can change, the
 * periods, and the tile on each person's dashboard.
 *
 * Customers, machines and people are invented.
 *
 *   DATABASE_URL=postgres://... node tests/tasks-sql-test.js
 */
const path = require('path');

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.log('no DATABASE_URL — skipping (set it to run these against a real Postgres)');
  process.exit(0);
}

const { connect } = require(path.join(__dirname, '..', 'server', 'db.js'));
const { loadPortal } = require(path.join(__dirname, '..', 'server', 'load.js'));
const { syncSchema } = require(path.join(__dirname, '..', 'server', 'schema-sync.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 500) : ''));
};
const refused = async (fn, re) => {
  try { await fn(); return 'not refused'; } catch (e) { return re.test(e.message) ? true : e.message; }
};

const TENANT = 'tasks-test';
const SONA = { email: 'sona@pie.in', name: 'Sona', role: 'Service Coordinator', businessStream: 'All' };
const TEJ = { email: 'tej@pie.in', name: 'Tej', role: 'Service Engineer', businessStream: 'All' };
const OM = { email: 'om@pie.in', name: 'Om', role: 'Service Engineer', businessStream: 'All' };
const MONA = { email: 'mona@pie.in', name: 'Mona', role: 'Management', businessStream: 'All' };
const GONE = { email: 'gone@pie.in', name: 'Gone', role: 'Sales Coordinator', businessStream: 'All' };
const TABLES = ['users', 'customers', 'service_jobs', 'tasks', 'config_lists', 'audit_log'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  for (const u of [SONA, TEJ, OM, MONA, GONE]) {
    await db.appendRow('Users', { id: 'U-' + u.name, email: u.email, name: u.name, role: u.role, businessStream: u.businessStream,
      active: u === GONE ? 'FALSE' : 'TRUE' });
  }
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Testwell Foods', active: 'TRUE' });
  const as = (who) => { const p = loadPortal(db, who.email, { quiet: true }); p.CURRENT_USER_ = who; return p; };
  const sona = as(SONA);
  const tej = as(TEJ);
  const om = as(OM);
  const mona = as(MONA);
  const today = sona.todayIso_();
  const day = (n) => sona.addDays_(today, n);
  await db.appendRow('ServiceJobs', { id: 'J1', jobNo: 'SVJ-J1', date: today, customerId: 'CU-1', customerName: 'Testwell Foods',
    status: 'Assigned', jobType: 'Breakdown', engineerEmail: TEJ.email });

  console.log('GIVING A TASK');
  const t1 = await sona.saveTask({ title: 'Send the breakdown report to Testwell', details: 'With the photographs',
    assigneeEmail: 'TEJ@pie.in', dueDate: day(1), priority: 'High', linkKind: 'service', linkId: 'J1' });
  ok('given, open, by whoever gave it', t1.status === 'Open' && t1.assigneeName === 'Tej' && t1.byName === 'Sona' && t1.priority === 'High' &&
    t1.dueDate === day(1), t1);
  ok('about the record it names', t1.link && t1.link.kind === 'service' && t1.link.label === 'SVJ-J1 · Testwell Foods' && t1.link.id === 'J1', t1.link);
  ok('Normal unless a priority is given', (await sona.saveTask({ title: 'Check the oil stock', assigneeEmail: TEJ.email, dueDate: day(2), priority: 'Urgent' })).priority === 'Normal');
  ok('it needs saying what', await refused(() => sona.saveTask({ title: ' ', assigneeEmail: TEJ.email, dueDate: day(1) }), /Say what needs doing/));
  ok('and who', await refused(() => sona.saveTask({ title: 'X', assigneeEmail: '', dueDate: day(1) }), /Pick who/));
  ok('somebody still here', await refused(() => sona.saveTask({ title: 'X', assigneeEmail: GONE.email, dueDate: day(1) }), /nobody active/));
  ok('and when', await refused(() => sona.saveTask({ title: 'X', assigneeEmail: TEJ.email, dueDate: '' }), /date it is due/));
  ok('not already overdue', await refused(() => sona.saveTask({ title: 'X', assigneeEmail: TEJ.email, dueDate: day(-1) }), /cannot be due before today/));
  ok('about a record that exists', await refused(() => sona.saveTask({ title: 'X', assigneeEmail: TEJ.email, dueDate: day(1), linkKind: 'service', linkId: 'NOPE' }), /no longer there/) &&
    await refused(() => sona.saveTask({ title: 'X', assigneeEmail: TEJ.email, dueDate: day(1), linkKind: 'invoice', linkId: 'J1' }), /can be about/));
  ok('anybody can give one, to anybody', (await tej.saveTask({ title: 'Ask Sona for the gasket kit', assigneeEmail: SONA.email, dueDate: day(1) })).byName === 'Tej');

  console.log('\nWHO SEES WHAT');
  let tl = await tej.getTasks({});
  ok('the person doing it, and whoever gave it', tl.tasks.some((t) => t.id === t1.id) && (await sona.getTasks({})).tasks.some((t) => t.id === t1.id));
  ok('nobody else', !(await om.getTasks({})).tasks.length && await refused(() => om.getTask(t1.id), /no longer there/));
  ok('Management sees every task', (await mona.getTasks({})).tasks.length === 3);
  ok('the people a task can go to are the ones still here', tl.people.map((p) => p.name).join() === 'Mona,Om,Sona,Tej', tl.people);

  console.log('\nWHO CHANGES WHAT');
  ok('the person doing it cannot change what it says or when it is due',
    await refused(() => tej.saveTask({ id: t1.id, title: 'Easier', assigneeEmail: TEJ.email, dueDate: day(9) }), /Only whoever gave this task/));
  let s = await tej.setTaskStatus(t1.id, 'In progress');
  ok('but marks it in progress', s.status === 'In progress' && s.state === 'progress' && s.label === 'In progress');
  s = await tej.setTaskStatus(t1.id, 'Done');
  ok('and done — on time, before its day', s.status === 'Done' && s.state === 'ontime' && s.doneDay === today && s.earned === 15 && s.doneByName === 'Tej', s);
  s = await tej.setTaskStatus(t1.id, 'Open');
  ok('and open again', s.status === 'Open' && !s.doneDay && s.state === 'open');
  ok('not cancel it', await refused(() => tej.setTaskStatus(t1.id, 'Cancelled'), /can cancel it/));
  ok('nor delete it', await refused(() => tej.deleteTask(t1.id), /can delete it/));
  ok('somebody else cannot even tick it', await refused(() => om.setTaskStatus(t1.id, 'Done'), /no longer there/));
  s = await sona.saveTask({ id: t1.id, title: 'Send the breakdown report', details: '', assigneeEmail: OM.email, dueDate: day(3), priority: 'Low' });
  ok('whoever gave it changes it, link kept', s.title === 'Send the breakdown report' && s.assigneeName === 'Om' && s.dueDate === day(3) &&
    s.priority === 'Low' && s.link.label === 'SVJ-J1 · Testwell Foods');
  ok('but not into the past', await refused(() => sona.saveTask({ id: t1.id, title: 'X', assigneeEmail: OM.email, dueDate: day(-2) }), /today or later/));
  ok('only a real status', await refused(() => sona.setTaskStatus(t1.id, 'Parked'), /Open, In progress, Done or Cancelled/));
  s = await sona.setTaskStatus(t1.id, 'Cancelled');
  ok('cancelled by whoever gave it', s.status === 'Cancelled' && s.state === 'cancelled' && s.cancelledDay === today);
  ok('and brought back only by them', await refused(() => om.setTaskStatus(t1.id, 'Open'), /bring it back/) &&
    (await sona.setTaskStatus(t1.id, 'Open')).status === 'Open');
  ok('Management changes anybody’s', (await mona.saveTask({ id: t1.id, title: 'Send the report', assigneeEmail: OM.email, dueDate: day(3) })).title === 'Send the report');
  await sona.deleteTask(t1.id);
  ok('deleted, it leaves the list but stays on record', !(await sona.getTasks({})).tasks.some((t) => t.id === t1.id) &&
    (await db.q("SELECT active FROM tasks WHERE tenant_id=$1 AND id=$2", [TENANT, t1.id])).rows[0].active === false);

  console.log('\nTHE SCORE');
  await clean();
  for (const u of [SONA, TEJ, OM, MONA]) {
    await db.appendRow('Users', { id: 'U-' + u.name, email: u.email, name: u.name, role: u.role, businessStream: u.businessStream, active: 'TRUE' });
  }
  const task = (id, extra) => db.appendRow('Tasks', Object.assign({ id, title: 'Task ' + id, assigneeEmail: TEJ.email, priority: 'Normal',
    status: 'Open', active: 'TRUE', createdBy: SONA.email, createdAt: day(-20) + 'T05:00:00Z' }, extra));
  await task('A', { priority: 'High', dueDate: day(-3), status: 'Done', doneAt: day(-4) + 'T06:00:00Z' });
  await task('B', { dueDate: day(-5), status: 'Done', doneAt: day(-2) + 'T06:00:00Z' });
  await task('C', { priority: 'Low', dueDate: day(-2) });
  await task('D', { dueDate: day(1) });
  await task('E', { dueDate: day(-1), status: 'Cancelled', cancelledAt: day(-1) + 'T06:00:00Z' });
  // Done at 00:30 the next morning in India, though it is still the due day in UTC.
  await task('F', { priority: 'Low', dueDate: day(-6), status: 'Done', doneAt: day(-6) + 'T19:00:00Z' });
  await task('G', { assigneeEmail: OM.email, dueDate: day(-1), status: 'Done', doneAt: day(-1) + 'T10:00:00Z' });
  await task('H', { dueDate: day(-40), status: 'Done', doneAt: day(-41) + 'T10:00:00Z' });
  const range = { period: 'custom', from: day(-10), to: day(10) };
  let all = await mona.getTasks(range);
  const st = (id) => all.tasks.find((t) => t.id === id);
  ok('done by its day: all the points', st('A').state === 'ontime' && st('A').earned === 15 && st('A').possible === 15);
  ok('done after it: half', st('B').state === 'late' && st('B').earned === 5 && st('B').daysLate === 3 && st('B').label === 'Done late');
  ok('not done after it: half lost', st('C').state === 'overdue' && st('C').earned === -2.5 && st('C').daysOver === 2);
  ok('not yet due: nothing either way', st('D').state === 'open' && st('D').earned === 0 && st('D').possible === 0);
  ok('the day is India’s', st('F').state === 'late' && st('F').doneDay === day(-5), st('F'));
  const row = (who) => all.scorecard.find((r) => r.name === who);
  const tejRow = row('Tej');
  ok('one line a person, cancelled tasks left out, other periods too', tejRow.tasks === 5 && tejRow.onTime === 1 && tejRow.late === 2 &&
    tejRow.overdue === 1 && tejRow.open === 1, tejRow);
  ok('points earned over points possible', tejRow.earned === 15 + 5 + 2.5 - 2.5 && tejRow.possible === 15 + 10 + 5 + 5 && tejRow.score === 57, tejRow);
  ok('best first', all.scorecard.map((r) => r.name).join() === 'Om,Tej' && row('Om').score === 100);
  ok('the rules as they stand', JSON.stringify(all.scoring) === JSON.stringify({ High: 15, Normal: 10, Low: 5, latePct: 50, overduePct: 50 }));
  tl = await tej.getTasks(range);
  ok('everybody else sees their own line only', tl.scorecard.length === 1 && tl.scorecard[0].name === 'Tej' && tl.canScore === false);
  await task('I', { priority: 'High', dueDate: day(-1), assigneeEmail: OM.email });
  all = await mona.getTasks(range);
  ok('nothing earned and something lost is 0%, not below', all.scorecard.find((r) => r.name === 'Om').score === 10 &&
    (await (async () => {
      await db.q("UPDATE tasks SET status='Open', done_at=NULL WHERE tenant_id=$1 AND id='G'", [TENANT]);
      return (await mona.getTasks(range)).scorecard.find((r) => r.name === 'Om').score;
    })()) === 0);

  console.log('\nCHANGING THE RULES');
  ok('Management only', await refused(() => sona.saveTaskScoring({ High: 20, Normal: 10, Low: 5, latePct: 0, overduePct: 100 }), /.+/));
  ok('whole numbers in range', await refused(() => mona.saveTaskScoring({ High: 0, Normal: 10, Low: 5, latePct: 0, overduePct: 100 }), /High priority points/) &&
    await refused(() => mona.saveTaskScoring({ High: 20, Normal: 10, Low: 5, latePct: 150, overduePct: 100 }), /finishing late/) &&
    await refused(() => mona.saveTaskScoring({ High: 20, Normal: 10.5, Low: 5, latePct: 0, overduePct: 100 }), /Normal priority/));
  await mona.saveTaskScoring({ High: 20, Normal: 10, Low: 5, latePct: 0, overduePct: 100 });
  all = await mona.getTasks(range);
  ok('and every score follows', st('A').earned === 20 && st('B').earned === 0 && st('C').earned === -5 &&
    JSON.stringify(all.scoring) === JSON.stringify({ High: 20, Normal: 10, Low: 5, latePct: 0, overduePct: 100 }));
  await mona.saveTaskScoring({ High: 15, Normal: 10, Low: 5, latePct: 50, overduePct: 50 });
  ok('saved again, not added again', (await db.q("SELECT count(*)::int AS n FROM config_lists WHERE tenant_id=$1 AND category='TaskScore'", [TENANT])).rows[0].n === 5);

  console.log('\nTHE PERIODS');
  const per = (o, t) => { const p = sona.taskPeriod_(o, t); return p.from + '..' + p.to; };
  ok('this month', per({}, '2026-11-15') === '2026-11-01..2026-11-30');
  ok('last month, over the new year', per({ period: 'lastmonth' }, '2026-01-15') === '2025-12-01..2025-12-31');
  ok('the quarter is April’s', per({ period: 'quarter' }, '2026-11-15') === '2026-10-01..2026-12-31' &&
    per({ period: 'quarter' }, '2027-02-10') === '2027-01-01..2027-03-31' && per({ period: 'quarter' }, '2026-04-01') === '2026-04-01..2026-06-30');
  ok('and the financial year', per({ period: 'fy' }, '2027-02-10') === '2026-04-01..2027-03-31' && per({ period: 'fy' }, '2026-04-01') === '2026-04-01..2027-03-31');
  ok('a range must run forwards', await refused(() => mona.getTasks({ period: 'custom', from: day(5), to: day(1) }), /ends before it starts/));
  ok('the period is the tasks due in it', (await mona.getTasks({ period: 'custom', from: day(-45), to: day(-35) })).scorecard.map((r) => r.tasks).join() === '1');

  console.log('\nON THE DASHBOARD');
  const tile = (d) => d.tiles.find((t) => t.key === 'tasks') || {};
  const td = tile(await tej.getPersonDashboard({}));
  ok('the person’s open tasks and how many are overdue', td.label === 'My tasks' && td.value === '2' && /^1 overdue · (score \d+%|no score yet) this month$/.test(td.sub) &&
    td.tone === 'bad' && td.go === 'tasks', td);
  const md = tile(await mona.getPersonDashboard({}));
  ok('Management: everybody’s overdue, the team’s score', md.label === 'Tasks overdue' && md.value === '3' && /^4 open · team (score \d+%|no score yet) this month$/.test(md.sub), md);

  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.log('CRASHED: ' + e.message);
  console.log(e.stack.split('\n').slice(1, 8).join('\n'));
  process.exit(1);
});
