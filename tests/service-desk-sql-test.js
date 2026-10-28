/**
 * ERP 2.0's service desk, on the server: ERP 2's statuses read from ERP 1's, the engineer's
 * report, closing once it is in, cancelling with a reason, and ERP 1's own status left as
 * ERP 1 knows it throughout.
 *
 * Customers, machines and people are invented.
 *
 *   DATABASE_URL=postgres://... node tests/service-desk-sql-test.js
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

const TENANT = 'service-desk-test';
const SONA = { email: 'sona@pie.in', name: 'Sona', role: 'Service Coordinator', businessStream: 'All' };
const TEJ = { email: 'tej@pie.in', name: 'Tej', role: 'Service Engineer', businessStream: 'All' };
const OM = { email: 'om@pie.in', name: 'Om', role: 'Service Engineer', businessStream: 'All' };
const TABLES = ['users', 'customers', 'service_jobs', 'service_job_items', 'service_proofs', 'spare_enquiries', 'audit_log'];

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
  const as = (who) => { const p = loadPortal(db, who.email, { quiet: true }); p.CURRENT_USER_ = who; return p; };
  const sona = as(SONA);
  const tej = as(TEJ);
  const om = as(OM);
  const today = sona.todayIso_();
  const erp1 = async (id) => (await db.q('SELECT status FROM service_jobs WHERE tenant_id=$1 AND id=$2', [TENANT, id])).rows[0].status;

  console.log('THE STATUSES, READ FROM ERP 1’S');
  ok('the six, in ERP 2’s order', sona.SERVICE_DESK_STATUSES.join(' | ') === 'New | Assigned | In progress | Report submitted | Closed | Cancelled');
  const read = (job) => sona.serviceDeskStatus_(job);
  ok('Unassigned is New; Assigned and Scheduled are Assigned', read({ status: 'Unassigned' }) === 'New' &&
    read({ status: 'Assigned', engineerEmail: 'x' }) === 'Assigned' && read({ status: 'Scheduled', engineerEmail: 'x' }) === 'Assigned');
  ok('In Progress is In progress until the report is in', read({ status: 'In Progress' }) === 'In progress' &&
    read({ status: 'In Progress', reportSubmittedAt: '2026-10-28T10:00:00Z' }) === 'Report submitted');
  ok('Completed is Closed; Cancelled is Cancelled', read({ status: 'Completed', reportSubmittedAt: 'x' }) === 'Closed' && read({ status: 'Cancelled' }) === 'Cancelled');

  console.log('\nA BREAKDOWN, FROM CALL TO CLOSED');
  let job = await sona.createServiceJob({ customerId: 'CU-1', scopeText: 'Compressor trips on high temperature', machineModel: 'EG 99', serialNo: 'FAB-1', urgency: 'Urgent' });
  ok('logged as New', job.deskStatus === 'New' && job.status === 'Unassigned', [job.deskStatus, job.status]);
  ok('a report needs an engineer on the job', await refused(() => sona.submitServiceReport(job.id, {}), /Name the engineer/));
  job = await sona.assignServiceJob(job.id, TEJ.email, today);
  ok('assigned', job.deskStatus === 'Assigned' && job.status === 'Assigned');
  ok('only the engineer on it, or the coordinator, writes the report', await refused(() => om.submitServiceReport(job.id, {}), /Only the engineer on this job/));
  ok('the report needs the visit date', await refused(() => tej.submitServiceReport(job.id, { workDone: 'Cleaned cooler' }), /date of the visit/));
  ok('and not one in the future', await refused(() => tej.submitServiceReport(job.id, { visitDate: '2999-01-01', workDone: 'x' }), /cannot be in the future/));
  ok('what was done', await refused(() => tej.submitServiceReport(job.id, { visitDate: today, workDone: '' }), /what work was done/));
  ok('hours spent', await refused(() => tej.submitServiceReport(job.id, { visitDate: today, workDone: 'Cleaned the oil cooler' }), /hours spent/));
  ok('for a breakdown, what caused it', await refused(() => tej.submitServiceReport(job.id, {
    visitDate: today, workDone: 'Cleaned the oil cooler', hoursSpent: 3 }), /caused the breakdown/));
  ok('and whether it was handed over running', await refused(() => tej.submitServiceReport(job.id, {
    visitDate: today, workDone: 'Cleaned the oil cooler', hoursSpent: 3, rootCause: 'Choked cooler fins' }), /handed over running/));
  ok('a negative number is refused', await refused(() => tej.submitServiceReport(job.id, {
    visitDate: today, workDone: 'Cleaned the oil cooler', hoursSpent: -1, rootCause: 'Choked', handedOverRunning: 'Yes' }), /not below zero/));
  job = await tej.submitServiceReport(job.id, { visitDate: today, workDone: 'Cleaned the oil cooler and checked the thermostat', hoursSpent: 3,
    runningHours: 15230, rootCause: 'Choked cooler fins', customerRemarks: 'Running fine now', handedOverRunning: 'Yes' });
  ok('the engineer’s report moves it to Report submitted', job.deskStatus === 'Report submitted' && job.reportSubmittedBy === TEJ.email);
  ok('which ERP 1 reads as In Progress, a status it knows', job.status === 'In Progress' && (await erp1(job.id)) === 'In Progress');
  ok('the engineer cannot close it', await refused(() => tej.closeServiceJob(job.id), /.+/));
  ok('the coordinator can, once the customer’s photograph is in (ERP 1’s rule)', await refused(() => sona.closeServiceJob(job.id), /photograph/));
  await db.appendRow('ServiceProofs', { id: 'PR-1', serviceJobId: job.id, fileName: 'done.jpg', uploadedBy: TEJ.email, uploadedAt: today });
  job = await sona.closeServiceJob(job.id);
  ok('Closed, as ERP 1’s Completed, by whom', job.deskStatus === 'Closed' && job.status === 'Completed' && job.closedBy === SONA.email && job.completedDate === today);
  ok('a closed job’s report no longer changes', await refused(() => tej.submitServiceReport(job.id, {}), /no longer change/));
  ok('and it cannot be cancelled', await refused(() => sona.cancelServiceJob(job.id, 'Customer cancelled'), /cannot be cancelled/));
  const html = await sona.buildServiceReportHtml(job.id);
  ok('the printed report carries the engineer’s report', /Visit date/.test(html) && /Handed over running/.test(html) &&
    /Cleaned the oil cooler and checked the thermostat/.test(html) && /Root cause/.test(html) && /Choked cooler fins/.test(html) &&
    /Running fine now/.test(html) && /15230/.test(html));

  console.log('\nCLOSING ONLY ONCE THE REPORT IS IN');
  let two = await sona.createServiceJob({ customerId: 'CU-1', scopeText: 'Oil leak near the separator' });
  two = await sona.assignServiceJob(two.id, TEJ.email, today);
  await db.appendRow('ServiceProofs', { id: 'PR-2', serviceJobId: two.id, fileName: 'x.jpg', uploadedBy: TEJ.email, uploadedAt: today });
  ok('an assigned job is not closed from the desk', await refused(() => sona.closeServiceJob(two.id), /once the engineer’s report is in/));

  console.log('\nCANCELLING, WITH A REASON');
  ok('a reason is needed', await refused(() => sona.cancelServiceJob(two.id, 'no'), /why the job is cancelled/));
  ok('the engineer cannot cancel', await refused(() => tej.cancelServiceJob(two.id, 'Customer fixed it'), /.+/));
  two = await sona.cancelServiceJob(two.id, 'Customer fixed it themselves');
  ok('Cancelled, with the reason and who', two.deskStatus === 'Cancelled' && two.status === 'Cancelled' &&
    two.cancelReason === 'Customer fixed it themselves' && two.cancelledBy === SONA.email);
  ok('cancelling twice says so', await refused(() => sona.cancelServiceJob(two.id, 'Again, really'), /already cancelled/));

  console.log('\nERP 1’S LIST CARRIES BOTH');
  const rows = await sona.listServiceJobs({ includeClosed: true });
  ok('its own status and 2.0’s name, side by side', rows.length === 2 && rows.every((r) => r.status && r.deskStatus),
    rows.map((r) => [r.status, r.deskStatus]));
  ok('and ERP 1’s status change still works as before', (await sona.setServiceJobStatus(two.id, 'Unassigned')).deskStatus === 'New');

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
