/**
 * ERP 2.0's service engineer report, on the server: each engineer's assigned, attended,
 * closed, rescheduled and pending jobs, local and outstation, hours, days to attend, AMC
 * visits and the enquiries they passed on, for a period — and who sees what, money included.
 *
 * Customers, machines and people are invented.
 *
 *   DATABASE_URL=postgres://... node tests/service-engineer-report-sql-test.js
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

const TENANT = 'engineer-report-test';
const SONA = { email: 'sona@pie.in', name: 'Sona', role: 'Service Coordinator', businessStream: 'All' };
const TEJ = { email: 'tej@pie.in', name: 'Tej', role: 'Service Engineer', businessStream: 'All' };
const OM = { email: 'om@pie.in', name: 'Om', role: 'Service Engineer', businessStream: 'All' };
const MONA = { email: 'mona@pie.in', name: 'Mona', role: 'Management', businessStream: 'All' };
const PRIYA = { email: 'priya@pie.in', name: 'Priya', role: 'Sales Coordinator', businessStream: 'All' };
const TABLES = ['users', 'service_jobs', 'service_job_reschedules', 'spare_enquiries', 'leads', 'quotations', 'config_lists', 'audit_log'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  for (const u of [SONA, TEJ, OM, MONA, PRIYA]) {
    await db.appendRow('Users', { id: 'U-' + u.name, email: u.email, name: u.name, role: u.role, businessStream: u.businessStream, active: 'TRUE' });
  }
  const as = (who) => { const p = loadPortal(db, who.email, { quiet: true }); p.CURRENT_USER_ = who; return p; };
  const sona = as(SONA);
  const tej = as(TEJ);
  const mona = as(MONA);
  const today = sona.todayIso_();
  const day = (n) => sona.addDays_(today, n);
  const P = { period: 'custom', from: day(-10), to: day(10) };
  const job = (id, extra) => db.appendRow('ServiceJobs', Object.assign({ id, jobNo: 'SVJ-' + id, date: day(-6), customerName: 'Testwell Foods',
    status: 'Assigned', jobType: 'Breakdown', engineerEmail: TEJ.email }, extra || {}));
  await job('J1', { area: 'Hingna MIDC', scheduledDate: day(-4), reportSubmittedAt: day(-3) + 'T06:00:00Z', hoursSpent: 3, status: 'Completed',
    completedDate: day(-2), jobType: 'AMC visit', date: day(-5) });
  await job('J2', { area: 'Wardha', scheduledDate: day(-1), reportSubmittedAt: day(-1) + 'T06:00:00Z', hoursSpent: 5, status: 'In Progress', date: day(-4) });
  await job('J3', { date: day(-2), status: 'Assigned' });
  await job('J4', { area: 'Wardha', scheduledDate: day(-40), date: day(-41), status: 'Completed', completedDate: day(-39) });
  await job('J5', { engineerEmail: OM.email, area: 'Kamptee', scheduledDate: day(1) });
  await job('J6', { status: 'Cancelled', scheduledDate: day(2) });
  await db.appendRow('ServiceJobReschedules', { id: 'R1', serviceJobId: 'J2', fromDate: day(-3), toDate: day(-2), reason: 'Customer not available', createdAt: day(-4) + 'T06:00:00Z' });
  await db.appendRow('ServiceJobReschedules', { id: 'R2', serviceJobId: 'J2', fromDate: day(-2), toDate: day(-1), reason: 'Spares not available', createdAt: day(-3) + 'T06:00:00Z' });
  await db.appendRow('ServiceJobReschedules', { id: 'R3', serviceJobId: 'J4', fromDate: day(-41), toDate: day(-40), reason: 'Travel / weather', createdAt: day(-42) + 'T06:00:00Z' });
  await db.appendRow('SpareEnquiries', { id: 'E1', enquiryNo: 'SE/1', date: day(-2), customerName: 'Testwell Foods', status: 'Quoted', serviceEngineerEmail: TEJ.email, businessStream: 'Spare Sales' });
  await db.appendRow('SpareEnquiries', { id: 'E2', enquiryNo: 'SE/2', date: day(-30), customerName: 'Testwell Foods', status: 'New', serviceEngineerEmail: TEJ.email, businessStream: 'Spare Sales' });
  await db.appendRow('Quotations', { id: 'Q1', quoteNo: 'Q/1', date: day(-1), businessStream: 'Spare Sales', spareEnquiryId: 'E1', status: 'Submitted', grand: 18000 });
  await db.appendRow('Leads', { id: 'L1', leadNo: 'LD/1', date: day(-1), customerName: 'Testwell Foods', status: 'New', serviceEngineerEmail: TEJ.email, businessStream: 'Compressor Sales' });

  console.log('EACH ENGINEER’S PERIOD');
  let r = await sona.getServiceEngineerReport(P);
  const tejRow = r.rows.find((x) => x.name === 'Tej');
  ok('one line an engineer', r.rows.map((x) => x.name).join() === 'Om,Tej');
  ok('assigned in the period, by the visit day or the day the call came in', tejRow.assigned === 4, tejRow);
  ok('attended: the report in; closed: completed', tejRow.attended === 2 && tejRow.closed === 1);
  ok('rescheduled in the period, and on how many jobs', tejRow.rescheduled === 2 && tejRow.rescheduledJobs === 1);
  ok('pending now: open, report not in', tejRow.pending === 1, tejRow.pending);
  ok('local, outstation, and no area apart', tejRow.local === 1 && tejRow.outstation === 1 && tejRow.noArea === 2, tejRow);
  ok('hours on site by the kind of area', tejRow.hoursLocal === 3 && tejRow.hoursOutstation === 5 && tejRow.hoursNoArea === 0);
  ok('days from the call to the report, on average', tejRow.daysToAttend === 2.5, tejRow.daysToAttend);
  ok('AMC visits done', tejRow.amcVisits === 1);
  ok('enquiries passed on in the period', tejRow.spareEnquiries === 1 && tejRow.leads === 1);
  ok('totals across the engineers', r.totals.assigned === 5 && r.totals.local === 2 && r.totals.attended === 2);

  console.log('\nWHO SEES WHAT');
  ok('service sees no money', r.money === false && tejRow.spareValue === undefined && r.totals.spareValue === undefined);
  r = await mona.getServiceEngineerReport(P);
  ok('Management sees the value of the enquiries passed on', r.money === true && r.rows.find((x) => x.name === 'Tej').spareValue === 18000);
  r = await tej.getServiceEngineerReport(P);
  ok('an engineer sees their own line', r.own === true && r.rows.map((x) => x.name).join() === 'Tej');
  ok('sales does not', await refused(() => as(PRIYA).getServiceEngineerReport(P), /.+/));

  console.log('\nTHE PERIOD');
  r = await sona.getServiceEngineerReport({ period: 'custom', from: day(-45), to: day(-35) });
  const old = r.rows.find((x) => x.name === 'Tej');
  ok('another period, another count', old.assigned === 1 && old.closed === 1 && old.rescheduled === 1 && old.spareEnquiries === 0, old);
  ok('this month unless asked', (await sona.getServiceEngineerReport({})).period.key === 'month');

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
