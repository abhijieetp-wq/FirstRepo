/**
 * ERP 2.0's dashboard per person, on the server: each position gets its own desk, read from
 * ERP 1's records, and only Management may look at somebody else's.
 *
 * People, customers and records are invented.
 *
 *   DATABASE_URL=postgres://... node tests/person-dashboard-sql-test.js
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

const TENANT = 'person-dash-test';
const P = {
  isha: { email: 'isha@pie.in', name: 'Isha', role: 'Sales Coordinator', businessStream: 'Spare Sales' },
  dev: { email: 'dev@pie.in', name: 'Dev', role: 'Sales Coordinator', businessStream: 'Spare Sales' },
  ravi: { email: 'ravi@pie.in', name: 'Ravi', role: 'Sales Engineer', businessStream: 'Compressor Sales' },
  sona: { email: 'sona@pie.in', name: 'Sona', role: 'Service Coordinator', businessStream: 'All' },
  tej: { email: 'tej@pie.in', name: 'Tej', role: 'Service Engineer', businessStream: 'All' },
  anil: { email: 'anil@pie.in', name: 'Anil', role: 'Management', businessStream: 'All' }
};
const TABLES = ['users', 'customers', 'spare_enquiries', 'quotations', 'sales_orders', 'dispatches', 'credit_checks',
  'invoices', 'leads', 'opportunities', 'service_due_calls', 'service_jobs', 'config_lists', 'audit_log'];

// "Today" is the server's — PIE's day, in India — not this machine's, or the test would
// fail every evening.
let today;
const plus = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  today = loadPortal(db, 'x@pie.in', { quiet: true }).todayIso_();
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  for (const u of Object.values(P)) {
    await db.appendRow('Users', { id: 'U-' + u.name, email: u.email, name: u.name, role: u.role,
      businessStream: u.businessStream, active: 'TRUE' });
  }
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Testwell Foods', assignedSalesperson: P.isha.email, active: 'TRUE' });
  await db.appendRow('Customers', { id: 'CU-2', customerCode: 'C2', name: 'Sample Castings', assignedSalesperson: P.dev.email, active: 'TRUE' });

  const SP = 'Spare Sales';
  const enquiry = (id, owner, extra) => db.appendRow('SpareEnquiries', Object.assign({ id, enquiryNo: 'SE/' + id, date: plus(-3),
    customerId: 'CU-1', productModel: 'EG 99', serialNo: 'FAB-' + id, ownerEmail: owner, status: 'New', businessStream: SP }, extra || {}));
  const quote = (id, by, status, extra) => db.appendRow('Quotations', Object.assign({ id, quoteNo: 'Q/' + id, revision: 'R0',
    date: plus(-2), businessStream: SP, customerId: 'CU-1', preparedBy: by, status, grand: 1000, validUntil: plus(20) }, extra || {}));

  // Isha's desk.
  await enquiry('E1', P.isha.email, { expectedDeliveryDate: plus(-1) });       // past its date
  await enquiry('E2', P.isha.email, { expectedDeliveryDate: plus(1) });        // due tomorrow
  await enquiry('E3', P.isha.email, { expectedDeliveryDate: plus(9) });        // not yet
  await enquiry('E4', P.dev.email, { expectedDeliveryDate: plus(-2) });        // someone else's
  await quote('Q1', P.isha.email, 'Submitted', { spareEnquiryId: 'E3', submittedDate: plus(-1), grand: 5000 });
  await quote('Q2', P.isha.email, 'Negotiating', { grand: 2500, validUntil: plus(-1) });
  await quote('Q3', P.dev.email, 'Draft', { customerId: 'CU-1', grand: 800 });    // Dev drafted, Isha looks after the customer
  await quote('Q4', P.isha.email, 'Draft', { customerId: 'CU-2', grand: 900 });   // Dev looks after this one
  await quote('Q5', P.isha.email, 'Won', { grand: 4000 });
  await db.appendRow('SalesOrders', { id: 'O5', orderNo: 'SO/5', date: today, businessStream: SP, customerId: 'CU-1',
    quotationId: 'Q5', orderStatus: 'Draft', grand: 4720, ownerEmail: P.anil.email });
  await db.appendRow('SalesOrders', { id: 'O6', orderNo: 'SO/6', date: plus(-60), businessStream: SP, customerId: 'CU-1',
    quotationId: 'Q5', orderStatus: 'Closed', grand: 999, ownerEmail: P.isha.email });
  await db.appendRow('ServiceDueCalls', { id: 'C1', fabNo: 'F1', ownerEmail: P.isha.email, callDate: '', outcome: '' });
  await db.appendRow('ServiceDueCalls', { id: 'C2', fabNo: 'F2', ownerEmail: P.isha.email, callDate: plus(-5), nextFollowUpDate: plus(-1), outcome: '' });
  await db.appendRow('ServiceDueCalls', { id: 'C3', fabNo: 'F3', ownerEmail: P.isha.email, callDate: plus(-5), outcome: 'PO received' });

  // Ravi's leads.
  await db.appendRow('Leads', { id: 'L1', leadNo: 'LD/1', date: plus(-4), customerId: 'CU-2', requirementSummary: '2 × 30 kW',
    salesEngineerEmail: P.ravi.email, ownerEmail: P.isha.email, status: 'New', nextActionDate: today, businessStream: 'Compressor Sales' });
  await db.appendRow('Leads', { id: 'L2', leadNo: 'LD/2', date: plus(-4), customerId: 'CU-2', salesEngineerEmail: P.ravi.email,
    status: 'Disqualified', nextActionDate: plus(-9), businessStream: 'Compressor Sales' });

  // Service.
  const job = (id, extra) => db.appendRow('ServiceJobs', Object.assign({ id, jobNo: 'SJ/' + id, date: plus(-1), customerName: 'Testwell Foods',
    machineModel: 'EG 99', serialNo: 'FAB-' + id, status: 'Assigned', jobType: 'Installation', engineerEmail: P.tej.email }, extra || {}));
  await job('J1', { scheduledDate: today });
  await job('J2', { scheduledDate: plus(1) });
  await job('J3', { status: 'Unassigned', engineerEmail: '' });
  await job('J4', { jobType: 'Breakdown', urgency: 'Immediate', engineerEmail: '', status: 'Unassigned' });
  await job('J5', { status: 'Completed', completedDate: today });
  await job('J6', { status: 'In Progress', reportSubmittedAt: today + 'T10:00:00Z' });   // report in, to close
  await job('J7', { status: 'In Progress' });                                            // visited, report to write
  await enquiry('E9', P.isha.email, { serviceEngineerEmail: P.tej.email, date: today });

  const as = (who) => { const p = loadPortal(db, who.email, { quiet: true }); p.CURRENT_USER_ = who; return p; };
  const tile = (d, key) => (d.tiles.find((t) => t.key === key) || {});
  const list = (d, key) => (d.lists.find((l) => l.key === key) || { rows: [] });

  console.log('A SALES COORDINATOR’S DESK');
  let d = await as(P.isha).getPersonDashboard({});
  ok('it is hers, as a coordinator', d.kind === 'coordinator' && d.person.name === 'Isha' && d.self === true);
  ok('her open enquiries, not Dev’s: four enquiries and three offers made without one', tile(d, 'open').value === '7', tile(d, 'open'));
  ok('follow-ups due today and tomorrow, the late one called out', tile(d, 'due').value === '2' && /1 past/.test(tile(d, 'due').sub) && tile(d, 'due').tone === 'bad', tile(d, 'due'));
  ok('in date order, the late one first', list(d, 'due').rows.map((r) => r.sub.split(' · ')[0]).join() === 'SE/E1,SE/E2', list(d, 'due').rows);
  ok('offers out with customers, negotiating ones too', tile(d, 'waiting').value === '2' && tile(d, 'waiting').money === 7500, tile(d, 'waiting'));
  ok('an offer past its validity says so', list(d, 'waiting').rows.find((r) => /Q\/Q2/.test(r.sub)).tone === 'bad');
  ok('drafts for customers she looks after, whoever drafted them', JSON.stringify(list(d, 'approve').rows.map((r) => r.sub.split(' ')[0])) === '["Q/Q3"]', list(d, 'approve').rows);
  ok('her orders this month, from her offers', tile(d, 'orders').value === '1' && tile(d, 'orders').money === 4720, tile(d, 'orders'));
  ok('her SDR calls, with the follow-ups due', tile(d, 'sdr').value === '1' && /1 follow-ups due/.test(tile(d, 'sdr').sub), tile(d, 'sdr'));
  ok('a line opens what it is about', list(d, 'approve').rows[0].open.kind === 'quotation' && list(d, 'due').rows[0].open.kind === 'enquiry');
  ok('she cannot look at Dev’s', await refused(() => as(P.isha).getPersonDashboard({ as: P.dev.email }), /Only Management/));
  ok('and is not offered anyone else', !d.canViewAs && !d.everyone);

  console.log('\nA SALES ENGINEER’S');
  d = await as(P.ravi).getPersonDashboard({});
  ok('the leads he found, still open', d.kind === 'salesEngineer' && tile(d, 'leads').value === '1', tile(d, 'leads'));
  ok('his follow-up due today', tile(d, 'due').value === '1' && list(d, 'due').rows[0].open.kind === 'lead');

  console.log('\nSERVICE');
  d = await as(P.sona).getPersonDashboard({});
  ok('the coordinator: open jobs and the ones to assign', d.kind === 'serviceCoordinator' && tile(d, 'open').value === '6' &&
    tile(d, 'fresh').value === '2', d.tiles);
  ok('and the reports in, waiting for them to close', tile(d, 'reports').value === '1' && list(d, 'reports').rows.length === 1, tile(d, 'reports'));
  ok('visits today and tomorrow, and the breakdown', tile(d, 'soon').value === '2' && tile(d, 'breakdowns').value === '1' && tile(d, 'breakdowns').tone === 'bad');
  ok('an unassigned job says so', list(d, 'fresh').rows.every((r) => r.right === 'Not assigned'));
  d = await as(P.tej).getPersonDashboard({});
  ok('the engineer: today and tomorrow', d.kind === 'serviceEngineer' && list(d, 'today').rows.length === 1 && list(d, 'tomorrow').rows.length === 1);
  ok('what he raised for sales, as counts', tile(d, 'raised').value === '1' && tile(d, 'passed').value === '0');
  ok('and the report he still has to write', tile(d, 'write').value === '1', tile(d, 'write'));
  ok('and no money anywhere on it', !JSON.stringify(d).match(/"money"|grand|₹/));

  console.log('\nMANAGEMENT');
  d = await as(P.anil).getPersonDashboard({});
  ok('the team, one row a person', d.kind === 'boss' && d.team.map((t) => t.name).sort().join() === 'Dev,Isha,Ravi', d.team);
  const isha = d.team.find((t) => t.name === 'Isha');
  ok('each with what is open, late, out and booked', isha.open === 7 && isha.late === 1 && isha.waiting === 2 && isha.booked === 1 && isha.sdr === 1, isha);
  ok('and anybody’s own dashboard to pick', d.canViewAs && d.everyone.length === 6);
  const hers = await as(P.anil).getPersonDashboard({ as: P.isha.email });
  ok('which is exactly what they see', hers.kind === 'coordinator' && hers.self === false && tile(hers, 'open').value === '7' && tile(hers, 'orders').money === 4720);
  ok('somebody not in Users is said so', await refused(() => as(P.anil).getPersonDashboard({ as: 'nobody@pie.in' }), /nobody with that address/));

  if (!process.env.KEEP) await clean();
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
