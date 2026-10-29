/**
 * ERP 2.0's next-day plan, on the server: each engineer's visits for the day in time order,
 * what is not on the plan yet, an engineer seeing only their own day, and the visit's time.
 *
 * Customers, machines and people are invented.
 *
 *   DATABASE_URL=postgres://... node tests/next-day-plan-sql-test.js
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

const TENANT = 'next-day-test';
const SONA = { email: 'sona@pie.in', name: 'Sona', role: 'Service Coordinator', businessStream: 'All' };
const TEJ = { email: 'tej@pie.in', name: 'Tej', role: 'Service Engineer', businessStream: 'All' };
const OM = { email: 'om@pie.in', name: 'Om', role: 'Service Engineer', businessStream: 'All' };
const TABLES = ['users', 'customers', 'customer_addresses', 'service_jobs', 'amc_contracts', 'amc_visits', 'audit_log'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  for (const u of [SONA, TEJ, OM]) {
    await db.appendRow('Users', { id: 'U-' + u.name, email: u.email, name: u.name, role: u.role, businessStream: u.businessStream, active: 'TRUE' });
  }
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Testwell Foods', active: 'TRUE' });
  await db.appendRow('CustomerAddresses', { id: 'AD-1', customerId: 'CU-1', addressType: 'Billing', line1: 'Plot 1', city: 'Pune', isDefault: 'TRUE' });
  const as = (who) => { const p = loadPortal(db, who.email, { quiet: true }); p.CURRENT_USER_ = who; return p; };
  const sona = as(SONA);
  const tej = as(TEJ);
  const today = sona.todayIso_();
  const day = sona.addDays_(today, 1);
  const job = (id, extra) => db.appendRow('ServiceJobs', Object.assign({ id, jobNo: 'SVJ-' + id, date: today, customerId: 'CU-1',
    customerName: 'Testwell Foods', machineModel: 'EG 99', serialNo: 'FAB-' + id, status: 'Assigned', jobType: 'Installation',
    urgency: 'Normal', scopeText: 'Fit the parts' }, extra || {}));
  await job('J1', { engineerEmail: TEJ.email, scheduledDate: day, scheduledTime: '14:00' });
  await job('J2', { engineerEmail: TEJ.email, scheduledDate: day, scheduledTime: '10:00', jobType: 'AMC visit' });
  await job('J3', { engineerEmail: OM.email, scheduledDate: day });
  await job('J4', { status: 'Unassigned', urgency: 'Urgent', jobType: 'Breakdown', date: sona.addDays_(today, -1) });
  await job('J5', { status: 'Unassigned', urgency: 'Immediate', jobType: 'Breakdown' });
  await job('J6', { engineerEmail: TEJ.email });
  await job('J7', { engineerEmail: TEJ.email, scheduledDate: day, status: 'Completed' });
  await job('J8', { engineerEmail: OM.email, scheduledDate: sona.addDays_(today, 2) });
  await db.appendRow('AmcContracts', { id: 'AMC-1', contractNo: 'AMC-1', customerId: 'CU-1', customerName: 'Testwell Foods',
    serialNo: 'FAB-A', amcType: 'Comprehensive', startDate: sona.addDays_(today, -100), endDate: sona.addDays_(today, 200),
    everyMonths: 3, active: 'TRUE' });
  await db.appendRow('AmcVisits', { id: 'AMV-1', contractId: 'AMC-1', visitNo: 1, dueDate: day });
  await db.appendRow('AmcVisits', { id: 'AMV-2', contractId: 'AMC-1', visitNo: 2, dueDate: sona.addDays_(today, 90) });

  console.log('THE DAY’S PLAN');
  let plan = await sona.getNextDayPlan({});
  ok('tomorrow, unless another day is asked for', plan.date === day);
  const tejDay = plan.plan.find((p) => p.name === 'Tej');
  ok('each engineer, with their visits in time order', tejDay.visits.map((v) => v.jobNo).join() === 'SVJ-J2,SVJ-J1', tejDay.visits);
  ok('a visit with no time comes after the timed ones', plan.plan.find((p) => p.name === 'Om').visits.map((v) => v.jobNo).join() === 'SVJ-J3');
  ok('closed jobs and other days are not on it', plan.visits === 3, plan.visits);
  ok('each visit with its town', tejDay.visits[0].city === 'Pune' && tejDay.visits[0].jobType === 'AMC visit' && tejDay.visits[0].scheduledTime === '10:00');

  console.log('\nWHAT IS NOT ON THE PLAN YET');
  ok('jobs nobody has been sent on, the stopped machines first', plan.unassigned.map((j) => j.jobNo).join() === 'SVJ-J5,SVJ-J4', plan.unassigned.map((j) => j.jobNo));
  ok('jobs with an engineer but no day', plan.undated.map((j) => j.jobNo).join() === 'SVJ-J6');
  ok('AMC visits due by then with no job made', plan.amcDue.map((v) => v.id).join() === 'AMV-1', plan.amcDue);
  await sona.assignServiceJob('J5', OM.email, day);
  plan = await sona.getNextDayPlan({ date: day });
  ok('assigning one for the day puts it on the plan', plan.plan.find((p) => p.name === 'Om').visits.some((v) => v.jobNo === 'SVJ-J5') &&
    !plan.unassigned.some((j) => j.jobNo === 'SVJ-J5'));
  plan = await sona.getNextDayPlan({ date: sona.addDays_(today, 2) });
  ok('any day can be planned', plan.visits === 1 && plan.plan.find((p) => p.name === 'Om').visits[0].jobNo === 'SVJ-J8');

  console.log('\nAN ENGINEER SEES THEIR OWN DAY');
  plan = await tej.getNextDayPlan({ date: day });
  ok('only theirs', plan.plan.length === 1 && plan.plan[0].name === 'Tej' && plan.visits === 2);
  ok('and none of the planning lists', !plan.unassigned.length && !plan.undated.length && !plan.amcDue.length && plan.canAssign === false);

  console.log('\nTHE VISIT’S TIME');
  ok('hours and minutes only', await refused(() => sona.setServiceJobTime('J3', '25:00'), /hours and minutes/) &&
    await refused(() => sona.setServiceJobTime('J3', '9am'), /hours and minutes/));
  ok('not by the engineer', await refused(() => tej.setServiceJobTime('J3', '09:00'), /.+/));
  await sona.setServiceJobTime('J3', '09:30');
  plan = await sona.getNextDayPlan({ date: day });
  ok('set, and the day reorders', plan.plan.find((p) => p.name === 'Om').visits[0].jobNo === 'SVJ-J3' &&
    plan.plan.find((p) => p.name === 'Om').visits[0].scheduledTime === '09:30');
  await sona.setServiceJobTime('J3', '');
  ok('and can be taken off', !(await db.q("SELECT scheduled_time FROM service_jobs WHERE tenant_id=$1 AND id='J3'", [TENANT])).rows[0].scheduled_time);

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
