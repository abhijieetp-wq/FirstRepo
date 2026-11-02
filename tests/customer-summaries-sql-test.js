/**
 * ERP 2.0's customer list, on the server (getCustomerSummaries in Customers.gs): for each
 * customer, the machines PIE knows of from the installed base, ELGi's service due list and
 * service jobs (each serial once); what they owe and how late the oldest of it is; and the open
 * enquiries and service calls — another desk's enquiries not counted, and what is owed left out
 * for anybody Collections refuses.
 *
 * Customers and people are invented.
 *
 *   DATABASE_URL=postgres://... node tests/customer-summaries-sql-test.js
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

const TENANT = 'customer-summaries-test';
const ANIL = { email: 'anil@pie.in', name: 'Anil Rao', role: 'Management', businessStream: 'All' };
const KIRAN = { email: 'kiran@pie.in', name: 'Kiran Patil', role: 'Sales Coordinator', businessStream: 'Spare Sales' };
const TEJ = { email: 'tej@pie.in', name: 'Tej Pawar', role: 'Service Engineer', businessStream: 'All' };
const TABLES = ['users', 'customers', 'installed_base', 'service_due_calls', 'service_jobs', 'spare_enquiries', 'leads', 'opportunities',
  'invoices', 'receipts', 'audit_log'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => { for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]); };
  await clean();
  for (const u of [ANIL, KIRAN, TEJ]) {
    await db.appendRow('Users', { id: 'U-' + u.email, email: u.email, name: u.name, role: u.role, businessStream: u.businessStream, active: 'TRUE' });
  }
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Sahyadri Castings', creditDays: 30, active: 'TRUE' });
  await db.appendRow('Customers', { id: 'CU-2', customerCode: 'C2', name: 'Konkan Agro Foods', creditDays: 30, active: 'TRUE' });
  // Three sources of machines; one serial in two of them, counted once.
  await db.appendRow('InstalledBase', { id: 'IB-1', customerId: 'CU-1', serialNo: 'EG37-21874', productModel: 'EG 37' });
  await db.appendRow('ServiceDueCalls', { id: 'SD-1', customerId: 'CU-1', fabNo: 'eg37-21874', productModel: 'EG 37' });
  await db.appendRow('ServiceDueCalls', { id: 'SD-2', customerId: 'CU-1', fabNo: 'EG22-40877', productModel: 'EG 22' });
  await db.appendRow('ServiceJobs', { id: 'SJ-1', jobNo: 'SVJ-1', customerId: 'CU-1', serialNo: 'EN75-11902', status: 'Assigned', jobType: 'Breakdown' });
  await db.appendRow('ServiceJobs', { id: 'SJ-2', jobNo: 'SVJ-2', customerId: 'CU-1', serialNo: 'EG22-40877', status: 'Completed', jobType: 'Breakdown' });
  // Open and closed enquiries on both desks.
  await db.appendRow('SpareEnquiries', { id: 'E1', enquiryNo: 'SE/1', customerId: 'CU-1', status: 'Identifying', businessStream: 'Spare Sales' });
  await db.appendRow('SpareEnquiries', { id: 'E2', enquiryNo: 'SE/2', customerId: 'CU-1', status: 'Won', businessStream: 'Spare Sales' });
  await db.appendRow('Leads', { id: 'L1', leadNo: 'LD/1', customerId: 'CU-1', status: 'Qualified', businessStream: 'Compressor Sales' });
  await db.appendRow('Leads', { id: 'L2', leadNo: 'LD/2', customerId: 'CU-1', status: 'Converted', businessStream: 'Compressor Sales' });
  await db.appendRow('Opportunities', { id: 'O1', opportunityNo: 'OP/1', customerId: 'CU-1', stage: 'Negotiation', businessStream: 'Compressor Sales' });
  await db.appendRow('Opportunities', { id: 'O2', opportunityNo: 'OP/2', customerId: 'CU-1', stage: 'Lost', businessStream: 'Compressor Sales' });
  // What CU-2 owes: one invoice 20 days past due, part paid.
  const as = (who) => { const p = loadPortal(db, who.email, { quiet: true }); p.CURRENT_USER_ = who; return p; };
  const anil = as(ANIL);
  const today = anil.todayIso_();
  await db.appendRow('Invoices', { id: 'IN-1', invoiceNo: 'INV/1', invoiceDate: anil.addDays_(today, -50), dueDate: anil.addDays_(today, -20), customerId: 'CU-2',
    status: 'Issued', grand: 100000, invoiceValue: 100000, amountReceived: 40000, businessStream: 'Spare Sales' });
  await db.appendRow('Receipts', { id: 'RC-1', receiptNo: 'R/1', receiptDate: anil.addDays_(today, -5), customerId: 'CU-2', invoiceId: 'IN-1', amount: 40000, mode: 'Cheque' });

  const logged = async () => (await db.q('SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1', [TENANT])).rows[0].n;
  const before = await logged();

  console.log('MANAGEMENT SEES IT ALL');
  const all = await anil.getCustomerSummaries();
  const of = (d, id) => d.customers.find((c) => c.customerId === id) || {};
  const c1 = of(all, 'CU-1');
  ok('machines from the three sources, each serial once', c1.machines === 3, c1);
  ok('the open service calls', c1.openCalls === 1, c1);
  ok('open enquiries on both desks: a spare enquiry, a lead and an opportunity', c1.openEnquiries === 3, c1);
  const c2 = of(all, 'CU-2');
  ok('what they owe and how late', all.money === true && c2.outstanding === 60000 && c2.oldestOverdueDays === 20, c2);
  ok('nothing owed by the other', c1.outstanding === 0 && c1.oldestOverdueDays === 0, c1);

  console.log('\nA DESK SEES ITS OWN ENQUIRIES');
  const sp = of(await as(KIRAN).getCustomerSummaries(), 'CU-1');
  ok('the spares coordinator counts the spare enquiry only', sp.openEnquiries === 1 && sp.machines === 3, sp);

  console.log('\nAND MONEY ONLY FOR WHOEVER MAY SEE IT');
  const tej = await as(TEJ).getCustomerSummaries();
  ok('a service engineer: no money, machines and calls still', tej.money === false && tej.customers.every((c) => c.outstanding === null) &&
    of(tej, 'CU-1').machines === 3 && of(tej, 'CU-1').openCalls === 1, tej);
  ok('nothing written', (await logged()) === before);

  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
