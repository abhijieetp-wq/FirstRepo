/**
 * ERP 2.0's AMC, on the server: contracts lay out their visits, a due visit becomes a service
 * job and reads its state from it, a schedule can change without losing work already done,
 * a contract near its end gets an AMC renewal quotation, and service never sees the value.
 *
 * Customers, machines and people are invented.
 *
 *   DATABASE_URL=postgres://... node tests/amc-sql-test.js
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

const TENANT = 'amc-test';
const SONA = { email: 'sona@pie.in', name: 'Sona', role: 'Service Coordinator', businessStream: 'All' };
const TEJ = { email: 'tej@pie.in', name: 'Tej', role: 'Service Engineer', businessStream: 'All' };
const ISHA = { email: 'isha@pie.in', name: 'Isha', role: 'Sales Coordinator', businessStream: 'Spare Sales' };
const TABLES = ['users', 'customers', 'customer_addresses', 'customer_contacts', 'amc_contracts', 'amc_visits',
  'service_jobs', 'service_due_calls', 'spare_enquiries', 'quotations', 'quotation_items', 'quote_templates', 'audit_log'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  for (const u of [SONA, TEJ, ISHA]) {
    await db.appendRow('Users', { id: 'U-' + u.name, email: u.email, name: u.name, role: u.role, businessStream: u.businessStream, active: 'TRUE' });
  }
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Testwell Foods', active: 'TRUE' });
  await db.appendRow('CustomerAddresses', { id: 'AD-1', customerId: 'CU-1', addressType: 'Billing', line1: 'Plot 1',
    city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: 'TRUE' });
  await db.appendRow('ServiceDueCalls', { id: 'SDC-1', customerId: 'CU-1', fabNo: 'FAB-77', productModel: 'EG 37' });
  const as = (who) => { const p = loadPortal(db, who.email, { quiet: true }); p.CURRENT_USER_ = who; return p; };
  const sona = as(SONA);
  const tej = as(TEJ);
  const isha = as(ISHA);
  const today = sona.todayIso_();
  const plus = (n) => sona.addDays_(today, n);

  console.log('THE SCHEDULE');
  ok('a month on keeps the day, or takes the month’s last', sona.amcAddMonths_('2026-01-31', 1) === '2026-02-28' &&
    sona.amcAddMonths_('2026-11-15', 3) === '2027-02-15' && sona.amcAddMonths_('2026-03-10', -3) === '2025-12-10');
  ok('every 3 months from the first visit to the end', JSON.stringify(sona.amcSchedule_('2026-04-14', 3, '2027-01-14')) ===
    '["2026-04-14","2026-07-14","2026-10-14","2027-01-14"]');

  console.log('\nA CONTRACT');
  ok('the customer, the machine and a type are needed', await refused(() => sona.saveAmcContract({ customerId: 'CU-1', amcType: 'Comprehensive' }), /serial/) &&
    await refused(() => sona.saveAmcContract({ customerId: 'CU-1', serialNo: 'F', amcType: 'Gold' }), /must be one of/));
  ok('it cannot end before it starts', await refused(() => sona.saveAmcContract({ customerId: 'CU-1', serialNo: 'F', amcType: 'Comprehensive',
    startDate: '2026-05-01', endDate: '2026-04-01', everyMonths: 3 }), /end before/));
  const start = plus(-200);
  let c = await sona.saveAmcContract({ customerId: 'CU-1', serialNo: 'FAB-77', machineModel: 'EG 37', amcType: 'Comprehensive',
    startDate: start, everyMonths: 3, contractValue: 64000, runningHours: '15230', contactName: 'Mr Rao', contactPhone: '9800000001', area: 'Pune east' });
  ok('numbered, a year long by default', /^AMC\d{4}-001$/.test(c.contractNo) && c.endDate === sona.addDays_(sona.amcAddMonths_(start, 12), -1), [c.contractNo, c.endDate]);
  ok('four quarterly visits, the last on its final day', c.visits.length === 4 && c.visits[3].dueDate === c.endDate, c.visits.map((v) => v.dueDate));
  ok('the first two have passed', c.visits[0].state === 'Overdue' && c.visits[1].state === 'Overdue' && c.visits[2].state === 'Due', c.visits.map((v) => v.state));
  ok('a service coordinator’s save does not set the value', c.contractValue === '' || c.contractValue === null, c.contractValue);
  c = await isha.saveAmcContract({ id: c.id, customerId: 'CU-1', serialNo: 'FAB-77', machineModel: 'EG 37', amcType: 'Comprehensive',
    startDate: start, everyMonths: 3, contractValue: 64000 });
  ok('the sales side sets it', Number(c.contractValue) === 64000);

  console.log('\nA DUE VISIT BECOMES A SERVICE JOB');
  let made = await sona.makeAmcVisitCall(c.visits[0].id);
  const job1 = (await db.q('SELECT job_type, status, scope_text, contact_name FROM service_jobs WHERE tenant_id=$1 AND id=$2', [TENANT, made.jobId])).rows[0];
  ok('an AMC visit job, waiting for an engineer', job1.job_type === 'AMC visit' && job1.status === 'Unassigned' &&
    /^AMC visit 1 of 4 — Comprehensive contract AMC/.test(job1.scope_text) && job1.contact_name === 'Mr Rao', job1);
  c = await sona.getAmcContract(c.id);
  ok('the visit reads Call made, with the job', c.visits[0].state === 'Call made' && c.visits[0].jobNo === made.jobNo);
  ok('a second press is refused', await refused(() => sona.makeAmcVisitCall(c.visits[0].id), /already job/));
  ok('an engineer cannot make one', await refused(() => tej.makeAmcVisitCall(c.visits[1].id), /.+/));
  await sona.cancelServiceJob(made.jobId, 'Customer asked for next week');
  c = await sona.getAmcContract(c.id);
  ok('a cancelled job puts the visit back', c.visits[0].state === 'Overdue' && !c.visits[0].jobId);
  made = await sona.makeAmcVisitCall(c.visits[0].id);
  await db.q("UPDATE service_jobs SET status='Completed', completed_date=$3 WHERE tenant_id=$1 AND id=$2", [TENANT, made.jobId, today]);
  c = await sona.getAmcContract(c.id);
  ok('a closed job makes it Done', c.visits[0].state === 'Done' && c.visits[0].doneDate === today);

  console.log('\nTHE SCREEN');
  let screen = await sona.listAmc({ window: 7 });
  ok('overdue visits always, and those due within the window', screen.dues.map((d) => d.state).join() === 'Overdue', screen.dues.map((d) => [d.dueDate, d.state]));
  screen = await sona.listAmc({ window: 60 });
  ok('a wider window shows more', screen.dues.length >= 1 && screen.window === 60);
  ok('each says which visit of how many', screen.dues[0].visitNo === 2 && screen.dues[0].visitOf === 4, screen.dues[0]);
  ok('the contract: visits done of all, and what is next', screen.contracts[0].visitsDone === 1 && screen.contracts[0].visitsTotal === 4 &&
    screen.contracts[0].nextVisit === c.visits[1].dueDate);
  ok('the counts', screen.kpis.active === 1 && screen.kpis.overdue === 1, screen.kpis);
  ok('the service coordinator sees no money either', screen.money === false && screen.kpis.valueAYear === '');
  ok('the sales side sees the value a year', (await isha.listAmc({})).kpis.valueAYear === 64000);
  const svc = await tej.listAmc({});
  ok('service sees no money', svc.money === false && svc.contracts[0].contractValue === '' && svc.kpis.valueAYear === '' &&
    !JSON.stringify(svc).includes('64000'));
  ok('and cannot edit', svc.canEdit === false && await refused(() => tej.saveAmcContract({ customerId: 'CU-1' }), /.+/));

  console.log('\nCHANGING THE SCHEDULE KEEPS WHAT WAS DONE');
  c = await sona.saveAmcContract({ id: c.id, customerId: 'CU-1', serialNo: 'FAB-77', machineModel: 'EG 37', amcType: 'Comprehensive',
    startDate: start, everyMonths: 6 });
  ok('the done visit stays, the rest are laid out again', c.visits[0].state === 'Done' && c.visits[0].jobId === made.jobId &&
    c.visits.length === 3 && c.visits.map((v) => v.visitNo).join() === '1,2,3', c.visits.map((v) => [v.visitNo, v.dueDate, v.state]));
  ok('and the value and the contact are left as they were', Number((await isha.getAmcContract(c.id)).contractValue) === 64000 &&
    c.contactName === 'Mr Rao');

  console.log('\nRENEWAL');
  const ending = await isha.saveAmcContract({ customerId: 'CU-1', serialNo: 'FAB-88', machineModel: 'EG 22', amcType: 'Labour only',
    startDate: plus(-330), everyMonths: 4, contractValue: 18000 });
  screen = await sona.listAmc({});
  const ren = screen.renewals.find((r) => r.id === ending.id);
  ok('a contract ending within 60 days is up for renewal', !!ren && /Ends in \d+ days/.test(ren.state), screen.renewals);
  ok('the service coordinator cannot raise the offer', screen.canRenew === false && await refused(() => sona.prepareAmcRenewal(ending.id), /.+/));
  const r1 = await isha.prepareAmcRenewal(ending.id);
  const enq = (await db.q("SELECT enquiry_type, source, requirement_text FROM spare_enquiries WHERE tenant_id=$1", [TENANT])).rows[0];
  ok('an AMC renewal enquiry, and its quotation', /^SPARE\//.test(r1.quoteNo) && r1.existing === false && enq.enquiry_type === 'AMC renewal' &&
    enq.source === 'AMC contract' && /Labour only contract AMC/.test(enq.requirement_text), [r1, enq]);
  ok('pressing it twice opens the same', (await isha.prepareAmcRenewal(ending.id)).quotationId === r1.quotationId);
  ok('and the renewal shows on the contract', (await sona.listAmc({})).renewals.find((r) => r.id === ending.id).renewal.quoteNo === r1.quoteNo);
  const reminder = await sona.saveAmcContract({ customerId: 'CU-1', serialNo: 'FAB-99', amcType: 'Service reminder', startDate: plus(-340), everyMonths: 6 });
  ok('a service reminder is not renewed', !(await sona.listAmc({})).renewals.some((r) => r.id === reminder.id) &&
    await refused(() => isha.prepareAmcRenewal(reminder.id), /not a contract/));

  console.log('\nDELETING');
  ok('not once a visit has become a job', await refused(() => sona.deleteAmcContract(c.id), /stays on record/));
  await sona.deleteAmcContract(reminder.id);
  ok('otherwise it leaves the list', !(await sona.listAmc({})).contracts.some((r) => r.id === reminder.id));
  ok('and cannot be opened', await refused(() => sona.getAmcContract(reminder.id), /no longer there/));

  console.log('\nTHE CUSTOMER’S MACHINES');
  const machines = await sona.listAmcMachines('CU-1');
  ok('from ELGi’s list and the service jobs', machines.some((m) => m.serialNo === 'FAB-77' && m.machineModel === 'EG 37'), machines);

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
