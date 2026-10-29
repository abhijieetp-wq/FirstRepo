/**
 * ERP 2.0's service calls, on the server: ERP 2's call types through ERP 1's log-a-call, each
 * call's area as Local or Outstation, the instruction to the engineer, and rescheduling with a
 * reason kept as history — and the next-day plan carrying the area and the instruction.
 *
 * Customers, machines and people are invented.
 *
 *   DATABASE_URL=postgres://... node tests/service-calls-sql-test.js
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

const TENANT = 'service-calls-test';
const SONA = { email: 'sona@pie.in', name: 'Sona', role: 'Service Coordinator', businessStream: 'All' };
const TEJ = { email: 'tej@pie.in', name: 'Tej', role: 'Service Engineer', businessStream: 'All' };
const TABLES = ['users', 'customers', 'customer_addresses', 'service_jobs', 'service_job_reschedules', 'config_lists', 'audit_log'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  for (const u of [SONA, TEJ]) {
    await db.appendRow('Users', { id: 'U-' + u.name, email: u.email, name: u.name, role: u.role, businessStream: u.businessStream, active: 'TRUE' });
  }
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Testwell Foods', active: 'TRUE' });
  const as = (who) => { const p = loadPortal(db, who.email, { quiet: true }); p.CURRENT_USER_ = who; return p; };
  const sona = as(SONA);
  const tej = as(TEJ);
  const today = sona.todayIso_();
  const day = (n) => sona.addDays_(today, n);

  console.log('LOGGING A CALL');
  const lists = await sona.getServiceCallLists();
  ok('ERP 2’s call types, the areas and the reasons', lists.callTypes.join() === 'Breakdown,AMC visit,Regular service,Spare change,Installation,Commissioning' &&
    lists.areas.length === 17 && lists.reasons.length === 6 && lists.canAssign === true);
  const j1 = await sona.createServiceJob({ customerId: 'CU-1', scopeText: 'Six-monthly service', jobType: 'Regular service', area: 'Wardha',
    instruction: 'Carry an AOS kit' });
  ok('a regular service, with its area and instruction', j1.jobType === 'Regular service' && j1.area === 'Wardha' && j1.areaType === 'Outstation' &&
    j1.instruction === 'Carry an AOS kit' && j1.status === 'Unassigned', j1);
  const j2 = await sona.createServiceJob({ customerId: 'CU-1', scopeText: 'Trips on high temperature' });
  ok('ERP 1’s form, sending no type, still logs a breakdown', j2.jobType === 'Breakdown' && j2.area === '' && j2.areaType === '');
  ok('only ERP 2’s types', await refused(() => sona.createServiceJob({ customerId: 'CU-1', scopeText: 'x', jobType: 'Picnic' }), /A call is one of/));
  ok('an area from the list', await refused(() => sona.createServiceJob({ customerId: 'CU-1', scopeText: 'x', area: 'Atlantis' }), /area from the list/));
  ok('the audit says what kind of call', (await db.q("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id=$1 AND reason='Regular service call logged'", [TENANT])).rows[0].n === 1);

  console.log('\nLOCAL OR OUTSTATION, ON THE LIST');
  let list = await sona.listServiceJobs({});
  ok('each call with its kind of area', list.find((j) => j.id === j1.id).areaType === 'Outstation' && list.find((j) => j.id === j2.id).areaType === '');
  await sona.setServiceJobDetails(j2.id, { area: 'Hingna MIDC', instruction: 'Ring Mr Rao first' });
  list = await sona.listServiceJobs({});
  ok('set later by the coordinator', list.find((j) => j.id === j2.id).areaType === 'Local' && list.find((j) => j.id === j2.id).instruction === 'Ring Mr Rao first');
  ok('not by the engineer', await refused(() => tej.setServiceJobDetails(j2.id, { area: 'Wardha' }), /.+/));
  ok('nor to an area not on the list', await refused(() => sona.setServiceJobDetails(j2.id, { area: 'Atlantis' }), /area from the list/));

  console.log('\nRESCHEDULING, WITH A REASON');
  ok('a job with no day is assigned, not rescheduled', await refused(() => sona.rescheduleServiceJob(j1.id, day(2), 'Customer not available', ''), /no day yet/));
  await sona.assignServiceJob(j1.id, TEJ.email, day(1));
  await sona.setServiceJobTime(j1.id, '10:30');
  ok('a new date', await refused(() => sona.rescheduleServiceJob(j1.id, '', 'Customer not available', ''), /new date/) &&
    await refused(() => sona.rescheduleServiceJob(j1.id, day(1), 'Customer not available', ''), /already on/) &&
    await refused(() => sona.rescheduleServiceJob(j1.id, day(-1), 'Customer not available', ''), /today or later/));
  ok('one of ERP 2’s reasons', await refused(() => sona.rescheduleServiceJob(j1.id, day(3), 'Felt like it', ''), /reason it is moving/));
  ok('and words for “Other”', await refused(() => sona.rescheduleServiceJob(j1.id, day(3), 'Other', ''), /other reason/));
  ok('by whoever allocates the work', await refused(() => tej.rescheduleServiceJob(j1.id, day(3), 'Customer not available', ''), /.+/));
  let job = await sona.rescheduleServiceJob(j1.id, day(3), 'Customer asked for new date', 'Plant shut on Friday');
  ok('moved, the old time cleared', job.scheduledDate === day(3) && !job.scheduledTime && job.engineerEmail === TEJ.email && job.status === 'Assigned', job);
  job = await sona.rescheduleServiceJob(j1.id, day(4), 'Spares not available', '');
  ok('every move kept, in order, with who and why', job.reschedules.length === 2 && job.reschedules[0].fromDate === day(1) && job.reschedules[0].toDate === day(3) &&
    job.reschedules[0].reason === 'Customer asked for new date' && job.reschedules[0].note === 'Plant shut on Friday' && job.reschedules[0].byName === 'Sona' &&
    job.reschedules[1].fromDate === day(3) && job.reschedules[1].reason === 'Spares not available', job.reschedules);
  ok('and counted on the list', (await sona.listServiceJobs({})).find((j) => j.id === j1.id).rescheduleCount === 2);
  await sona.cancelServiceJob(j2.id, 'Customer fixed it themselves');
  await sona.assignServiceJob(j2.id, TEJ.email, day(1)).catch(() => {});
  ok('a cancelled job is not rescheduled', await refused(() => sona.rescheduleServiceJob(j2.id, day(5), 'Customer not available', ''), /closed or cancelled/));

  console.log('\nTHE NEXT-DAY PLAN');
  const plan = await sona.getNextDayPlan({ date: day(4) });
  const v = plan.plan.find((p) => p.name === 'Tej').visits[0];
  ok('carries the area and the instruction', v && v.area === 'Wardha' && v.areaType === 'Outstation' && v.instruction === 'Carry an AOS kit', v);

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
