/**
 * The service engineer behind each enquiry and lead, against a real Postgres, through the
 * portal's own code.
 *
 * What it proves: the engineer is stored only when it is somebody who is a service engineer;
 * an edit that does not mention the field leaves it alone; raising an enquiry from a service
 * job credits the engineer; and the Leads by Engineer report counts each enquiry and lead
 * once, the live revision of each offer once, orders at their total and invoices only when
 * issued, inside the dates asked for and inside the streams the reader works in.
 *
 *   DATABASE_URL=postgres://... node tests/engineer-leads-sql-test.js
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
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};
const refuses = async (label, fn, pattern) => {
  let msg = null;
  try { await fn(); } catch (e) { msg = e.message; }
  ok(label, msg !== null && pattern.test(msg), msg);
};

const TENANT = 'engineer-test';
const BOSS = { email: 'boss@pie.in', name: 'Anil Shah', role: 'ERP Admin', businessStream: 'All' };
const PRIYA = { email: 'priya@pie.in', name: 'Priya Deshmukh', role: 'Sales Coordinator',
  businessStream: 'Spare Sales' };
const RAVI = { email: 'ravi@pie.in', name: 'Ravi Kumar', role: 'Service Engineer',
  businessStream: 'All' };
const TABLES = ['users', 'customers', 'customer_contacts', 'spare_enquiries',
  'spare_enquiry_items', 'leads', 'lead_requirements', 'opportunities', 'quotations',
  'quotation_items', 'sales_orders', 'invoices', 'service_jobs', 'audit_log', 'engineers'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();

  console.log('THE COLUMN IS THERE ON BOTH TABLES');
  const cols = await db.q("SELECT table_name FROM information_schema.columns WHERE " +
    "table_schema = 'public' AND column_name = 'service_engineer_email' AND " +
    "table_name IN ('spare_enquiries', 'leads') ORDER BY table_name");
  ok('spare_enquiries and leads both carry service_engineer_email',
    cols.rows.map((r) => r.table_name).join(',') === 'leads,spare_enquiries',
    cols.rows.map((r) => r.table_name));

  const add = (tab, row) => db.appendRow(tab, row);
  await add('Users', { id: 'U-1', email: BOSS.email, name: BOSS.name, role: BOSS.role, active: 'TRUE', businessStream: 'All' });
  await add('Users', { id: 'U-2', email: PRIYA.email, name: PRIYA.name, role: PRIYA.role, active: 'TRUE', businessStream: 'Spare Sales' });
  await add('Users', { id: 'U-3', email: RAVI.email, name: RAVI.name, role: RAVI.role, active: 'TRUE' });
  await add('Users', { id: 'U-4', email: 'suresh@pie.in', name: 'Suresh Patil', role: 'Service Engineer', active: 'TRUE' });
  await add('Users', { id: 'U-5', email: 'deepak@pie.in', name: 'Deepak Rao', role: 'Service Engineer', active: 'FALSE' });
  await add('Users', { id: 'U-6', email: 'kiran@pie.in', name: 'Kiran Joshi', role: 'Sales Engineer', active: 'TRUE' });
  await add('Customers', { id: 'CU-1', customerCode: 'C0001', name: 'Topworth Urja', active: 'TRUE' });
  await add('Customers', { id: 'CU-2', customerCode: 'C0002', name: 'Kalyani Steels', active: 'TRUE' });

  // ---------------------------------------------------------------- the report's data
  const enq = (o) => Object.assign({ businessStream: 'Spare Sales', status: 'New',
    customerId: 'CU-1', urgency: 'Normal', createdBy: PRIYA.email, brand: 'ELGI' }, o);
  await add('SpareEnquiries', enq({ id: 'E1', enquiryNo: 'SE/1', date: '2026-10-02',
    serviceEngineerEmail: RAVI.email, requirementText: 'Air filter', status: 'Won' }));
  await add('SpareEnquiries', enq({ id: 'E2', enquiryNo: 'SE/2', date: '2026-10-05',
    serviceEngineerEmail: RAVI.email }));
  await add('SpareEnquiries', enq({ id: 'E3', enquiryNo: 'SE/3', date: '2026-10-06',
    customerId: 'CU-2', serviceEngineerEmail: '', status: 'Lost' }));
  await add('SpareEnquiries', enq({ id: 'E4', enquiryNo: 'SE/4', date: '2026-09-15',
    serviceEngineerEmail: 'suresh@pie.in' }));
  await add('SpareEnquiries', enq({ id: 'E5', enquiryNo: 'SE/5', date: '2026-10-07',
    serviceEngineerEmail: 'deepak@pie.in' }));

  const lead = (o) => Object.assign({ businessStream: 'Compressor Sales', status: 'New',
    customerName: 'Kalyani Steels', createdBy: BOSS.email, nextActionDate: '2026-11-01' }, o);
  await add('Leads', lead({ id: 'L1', leadNo: 'LD/1', date: '2026-10-03', customerId: 'CU-2',
    serviceEngineerEmail: 'suresh@pie.in', status: 'Converted', requirementSummary: '2 × 30 HP' }));
  await add('Leads', lead({ id: 'L2', leadNo: 'LD/2', date: '2026-10-04',
    serviceEngineerEmail: RAVI.email }));
  await add('Opportunities', { id: 'O1', opportunityNo: 'OP/1', leadId: 'L1', customerId: 'CU-2',
    stage: 'Won', businessStream: 'Compressor Sales', title: 'Two screw compressors' });

  const quote = (o) => Object.assign({ revision: 'R0', date: '2026-10-03', validityDays: 30,
    status: 'Submitted', taxAmt: 0, taxMode: 'Inclusive', preparedBy: PRIYA.email,
    createdBy: PRIYA.email }, o);
  // E1: offered, revised once, ordered on the revision. Only the revision's value counts.
  await add('Quotations', quote({ id: 'QA0', quoteNo: 'Q/501', customerId: 'CU-1',
    businessStream: 'Spare Sales', spareEnquiryId: 'E1', grand: 10000, status: 'Revised' }));
  await add('Quotations', quote({ id: 'QA1', quoteNo: 'Q/501', revision: 'R1',
    parentQuotationId: 'QA0', customerId: 'CU-1', businessStream: 'Spare Sales',
    spareEnquiryId: 'E1', grand: 9000, status: 'Won' }));
  // E3: offered and declined.
  await add('Quotations', quote({ id: 'QC0', quoteNo: 'Q/503', customerId: 'CU-2',
    businessStream: 'Spare Sales', spareEnquiryId: 'E3', grand: 2000, status: 'Lost' }));
  // L1 → O1: GST quoted as extra, so the offer is worth grand plus tax.
  await add('Quotations', quote({ id: 'QU0', quoteNo: 'Q/601', customerId: 'CU-2',
    businessStream: 'Compressor Sales', opportunityId: 'O1', grand: 500000, taxAmt: 90000,
    taxMode: 'Extra', status: 'Won' }));

  await add('SalesOrders', { id: 'SO1', orderNo: 'SO/1', quotationId: 'QA1', customerId: 'CU-1',
    businessStream: 'Spare Sales', orderStatus: 'Invoiced', grand: 9000 });
  await add('SalesOrders', { id: 'SO2', orderNo: 'SO/2', quotationId: 'QU0', customerId: 'CU-2',
    businessStream: 'Compressor Sales', orderStatus: 'Material Pending', grand: 590000 });
  // Billed at what Tally says; the draft is not a bill yet.
  await add('Invoices', { id: 'IN1', invoiceNo: 'INV/1', salesOrderId: 'SO1', customerId: 'CU-1',
    businessStream: 'Spare Sales', grand: 9000, invoiceValue: 9010, status: 'Issued' });
  await add('Invoices', { id: 'IN2', invoiceNo: 'INV/2', salesOrderId: 'SO1', customerId: 'CU-1',
    businessStream: 'Spare Sales', grand: 5000, status: 'Draft' });

  const portal = loadPortal(db, BOSS.email, { quiet: true });
  portal.CURRENT_USER_ = BOSS;

  console.log('\nTHE REPORT, 1–10 OCTOBER, FOR SOMEBODY WHO SEES BOTH STREAMS');
  const r = await portal.getEngineerLeadsReport({ from: '2026-10-01', to: '2026-10-10' });
  const line = (email) => r.engineers.filter((e) => e.email.toLowerCase() === email)[0];
  const ravi = line(RAVI.email);
  const suresh = line('suresh@pie.in');
  const deepak = line('deepak@pie.in');
  ok('both streams are shown', r.showSpare && r.showUnits);
  ok('the engineers are named, not addressed', ravi && ravi.name === 'Ravi Kumar', ravi && ravi.name);
  ok('the busiest engineer comes first', r.engineers[0] && r.engineers[0].email === RAVI.email,
    r.engineers.map((e) => e.name));
  ok('Ravi: two spare enquiries', ravi.spare.logged === 2, ravi.spare);
  ok('one of them quoted', ravi.spare.quoted === 1, ravi.spare);
  ok('quoted value is the live revision only — 9,000, not 19,000', ravi.spare.quotedValue === 9000,
    ravi.spare.quotedValue);
  ok('one ordered, at 9,000', ravi.spare.won === 1 && ravi.spare.orderValue === 9000, ravi.spare);
  ok('invoiced at the Tally value, draft left out — 9,010', ravi.spare.invoiced === 9010,
    ravi.spare.invoiced);
  ok('Ravi: one compressor lead, not converted', ravi.units.logged === 1 &&
    ravi.units.converted === 0 && ravi.units.quoted === 0, ravi.units);
  ok('Suresh: his September enquiry is outside the dates', suresh && suresh.spare.logged === 0,
    suresh && suresh.spare);
  ok('Suresh: one lead, converted, quoted with GST extra at 5,90,000',
    suresh.units.logged === 1 && suresh.units.converted === 1 && suresh.units.quoted === 1 &&
    suresh.units.quotedValue === 590000, suresh.units);
  ok('and ordered at 5,90,000, nothing invoiced yet',
    suresh.units.won === 1 && suresh.units.orderValue === 590000 && suresh.units.invoiced === 0,
    suresh.units);
  ok('an engineer who has left still gets the enquiry he generated', deepak &&
    deepak.name === 'Deepak Rao' && deepak.spare.logged === 1, deepak);
  ok('enquiries with nobody named have their own line', r.none.spare.logged === 1 &&
    r.none.spare.quoted === 1 && r.none.spare.quotedValue === 2000 && r.none.spare.won === 0,
    r.none.spare);
  ok('spare totals add up', r.totals.spare.logged === 4 && r.totals.spare.quoted === 2 &&
    r.totals.spare.quotedValue === 11000 && r.totals.spare.won === 1 &&
    r.totals.spare.orderValue === 9000 && r.totals.spare.invoiced === 9010, r.totals.spare);
  ok('compressor totals add up', r.totals.units.logged === 2 && r.totals.units.converted === 1 &&
    r.totals.units.orderValue === 590000, r.totals.units);

  const refs = r.rows.map((x) => x.ref).sort().join(',');
  ok('one row per enquiry and lead in the dates', refs === 'LD/1,LD/2,SE/1,SE/2,SE/3,SE/5', refs);
  const e1 = r.rows.filter((x) => x.ref === 'SE/1')[0];
  ok('a row names the live revision and the order', e1.quotes === 'Q/501 R1' && e1.orders === 'SO/1',
    e1);
  ok('and the customer and the engineer by name', e1.customer === 'Topworth Urja' &&
    e1.engineer === 'Ravi Kumar', e1);
  const l1 = r.rows.filter((x) => x.ref === 'LD/1')[0];
  ok('a converted lead shows its opportunity\'s stage', l1.progress === 'Opportunity: Won', l1.progress);
  const e3 = r.rows.filter((x) => x.ref === 'SE/3')[0];
  ok('no engineer is blank on the row, not an address', e3.engineer === '' && e3.engineerEmail === '', e3);
  ok('the download columns are named', r.columns.length >= 10 &&
    r.columns[0].label === 'Service engineer', r.columns[0]);
  ok('newest first', r.rows[0].date >= r.rows[r.rows.length - 1].date);

  console.log('\nALL TIME, AND THE STREAMS A READER WORKS IN');
  const all = await portal.getEngineerLeadsReport({});
  ok('no dates means everything',
    all.engineers.filter((e) => e.email === 'suresh@pie.in')[0].spare.logged === 1);
  portal.CURRENT_USER_ = PRIYA;
  const spareOnly = await portal.getEngineerLeadsReport({ from: '2026-10-01', to: '2026-10-10' });
  ok('a Spare Sales coordinator sees the spare side only', spareOnly.showSpare &&
    !spareOnly.showUnits, { s: spareOnly.showSpare, u: spareOnly.showUnits });
  ok('and none of the compressor leads', spareOnly.rows.every((x) => x.stream === 'Spare Sales') &&
    spareOnly.totals.units.logged === 0, spareOnly.rows.map((x) => x.ref));
  portal.CURRENT_USER_ = RAVI;
  await refuses('a service engineer cannot open the sales report',
    () => portal.getEngineerLeadsReport({}), /sales work/);
  portal.CURRENT_USER_ = BOSS;
  await refuses('a start after the end is refused',
    () => portal.getEngineerLeadsReport({ from: '2026-10-10', to: '2026-10-01' }), /after the end/);
  await refuses('a date that is not one is refused',
    () => portal.getEngineerLeadsReport({ from: 'last week' }), /not a date/);

  // ---------------------------------------------------------------- saving the engineer
  console.log('\nA SPARE ENQUIRY STORES THE ENGINEER, AND ONLY A SERVICE ENGINEER');
  const s1 = await portal.saveSpareEnquiry({ customerId: 'CU-1', customerName: 'Topworth Urja', source: 'Service Engineer',
    date: '2025-01-15', requirementText: 'Oil separator', serviceEngineerEmail: 'RAVI@pie.in' });
  const s1row = await db.findRowById('SpareEnquiries', s1.id);
  ok('stored, as the address on the user list', s1row.serviceEngineerEmail === RAVI.email,
    s1row.serviceEngineerEmail);
  await refuses('a sales engineer is not a service engineer',
    () => portal.saveSpareEnquiry({ customerId: 'CU-1', date: '2025-01-15', source: 'Call',
      serviceEngineerEmail: 'kiran@pie.in' }), /service engineer/);
  await refuses('nor is somebody who has left',
    () => portal.saveSpareEnquiry({ customerId: 'CU-1', date: '2025-01-15', source: 'Call',
      serviceEngineerEmail: 'deepak@pie.in' }), /service engineer/);
  await refuses('nor somebody nobody has heard of',
    () => portal.saveSpareEnquiry({ customerId: 'CU-1', date: '2025-01-15', source: 'Call',
      serviceEngineerEmail: 'stranger@x.com' }), /service engineer/);
  const blank = await portal.saveSpareEnquiry({ customerId: 'CU-1', date: '2025-01-15', source: 'WhatsApp',
    serviceEngineerEmail: '' });
  ok('blank is allowed — not every enquiry comes from an engineer',
    (await db.findRowById('SpareEnquiries', blank.id)).serviceEngineerEmail === '');

  console.log('\nTHE SOURCE IS REQUIRED, FROM THE LIST');
  ok('stored as picked', (await db.findRowById('SpareEnquiries', blank.id)).source === 'WhatsApp');
  await refuses('a new enquiry must say where it came from',
    () => portal.saveSpareEnquiry({ customerId: 'CU-1', date: '2025-01-15' }), /Pick where this enquiry came from/);
  await refuses('from the list',
    () => portal.saveSpareEnquiry({ customerId: 'CU-1', date: '2025-01-15', source: 'Pigeon' }), /must be one of: Email, Call, Service Engineer, Sales Engineer, WhatsApp/);
  await refuses('and one from a service engineer names who generated it',
    () => portal.saveSpareEnquiry({ customerId: 'CU-1', date: '2025-01-15', source: 'Service Engineer' }), /generated by/);
  const phoned = await portal.saveSpareEnquiry({ customerId: 'CU-1', date: '2025-01-15', source: 'phone' });
  ok('the old word Phone reads as Call', phoned.source === 'Call', phoned.source);
  await db.updateRowById('SpareEnquiries', 'id', phoned.id, { source: 'Trade fair' });
  const kept = await portal.saveSpareEnquiry({ id: phoned.id, customerId: 'CU-1', date: '2025-01-15', source: 'Trade fair', requirementText: 'x' });
  ok('an enquiry from before the list keeps its source when edited', kept.source === 'Trade fair', kept.source);
  await refuses('but cannot be changed to another word off the list',
    () => portal.saveSpareEnquiry({ id: phoned.id, customerId: 'CU-1', date: '2025-01-15', source: 'Fax' }), /must be one of/);

  await portal.saveSpareEnquiry({ id: s1.id, customerId: 'CU-1', date: '2025-01-15',
    requirementText: 'Oil separator, two of' });
  ok('an edit that does not mention the engineer leaves them alone',
    (await db.findRowById('SpareEnquiries', s1.id)).serviceEngineerEmail === RAVI.email);

  // Deepak generated E5 and has since left. Editing E5 must not be refused for that.
  await portal.saveSpareEnquiry({ id: 'E5', customerId: 'CU-1', date: '2026-10-07',
    serviceEngineerEmail: 'deepak@pie.in', requirementText: 'Updated' });
  ok('an engineer who has since left stays on the enquiry he generated',
    (await db.findRowById('SpareEnquiries', 'E5')).serviceEngineerEmail === 'deepak@pie.in');

  await refuses('an enquiry a service engineer brought in cannot lose its engineer',
    () => portal.saveSpareEnquiry({ id: s1.id, customerId: 'CU-1', date: '2025-01-15', serviceEngineerEmail: '' }), /generated by/);
  await portal.saveSpareEnquiry({ id: s1.id, customerId: 'CU-1', date: '2025-01-15', source: 'Call',
    serviceEngineerEmail: '' });
  ok('and choosing None clears it', (await db.findRowById('SpareEnquiries', s1.id)).serviceEngineerEmail === '');

  const listed = await portal.listSpareEnquiries({ includeClosed: true });
  const e1listed = listed.filter((x) => x.id === 'E1')[0];
  ok('the list names the engineer', e1listed && e1listed.serviceEngineerName === 'Ravi Kumar',
    e1listed && e1listed.serviceEngineerName);

  console.log('\nA COMPRESSOR LEAD THE SAME');
  const ld = await portal.saveLead({ customerName: 'New Prospect Pvt Ltd', date: '2025-01-15',
    nextActionDate: '2025-01-20', serviceEngineerEmail: 'suresh@pie.in',
    salesEngineerEmail: 'kiran@pie.in' });
  const ldrow = await db.findRowById('Leads', ld.id);
  ok('stored beside the sales engineer, each in its own column',
    ldrow.serviceEngineerEmail === 'suresh@pie.in' && ldrow.salesEngineerEmail === 'kiran@pie.in',
    { s: ldrow.serviceEngineerEmail, e: ldrow.salesEngineerEmail });
  await refuses('a sales engineer in the service engineer box is refused',
    () => portal.saveLead({ customerName: 'X', date: '2025-01-15', nextActionDate: '2025-01-20',
      serviceEngineerEmail: 'kiran@pie.in' }), /service engineer/);
  await portal.saveLead({ id: ld.id, customerName: 'New Prospect Pvt Ltd', date: '2025-01-15',
    nextActionDate: '2025-01-25' });
  ok('an edit that does not mention the engineer leaves them alone',
    (await db.findRowById('Leads', ld.id)).serviceEngineerEmail === 'suresh@pie.in');
  const leadsListed = await portal.listLeads({ includeClosed: true });
  const ldl = leadsListed.filter((x) => x.id === ld.id)[0];
  ok('the lead list names the engineer', ldl && ldl.serviceEngineerName === 'Suresh Patil',
    ldl && ldl.serviceEngineerName);

  console.log('\nRAISED FROM A SERVICE JOB, THE ENGINEER IS CREDITED');
  await add('ServiceJobs', { id: 'SJ1', jobNo: 'SJ/1', customerId: 'CU-1',
    customerName: 'Topworth Urja', engineerEmail: 'suresh@pie.in', status: 'Assigned' });
  await add('ServiceJobs', { id: 'SJ2', jobNo: 'SJ/2', customerId: 'CU-1',
    customerName: 'Topworth Urja', engineerEmail: 'suresh@pie.in', status: 'Assigned' });
  portal.CURRENT_USER_ = RAVI;
  const fromRavi = await portal.raiseSpareEnquiryFromServiceJob('SJ1',
    { requirementText: 'Drain valve leaking' });
  ok('pressed by an engineer: that engineer',
    (await db.findRowById('SpareEnquiries', fromRavi.id)).serviceEngineerEmail === RAVI.email);
  portal.CURRENT_USER_ = BOSS;
  const fromOffice = await portal.raiseSpareEnquiryFromServiceJob('SJ2',
    { requirementText: 'Belt worn' });
  ok('pressed by the office: the engineer the job is assigned to',
    (await db.findRowById('SpareEnquiries', fromOffice.id)).serviceEngineerEmail === 'suresh@pie.in');

  console.log('\nTHE ENGINEERS LIST');
  portal.CURRENT_USER_ = BOSS;
  let L = await portal.addEngineers('Arun Kale\n  Bina   Rao \n\nArun Kale', 'Service Engineer');
  ok('several added at once, one per line, a repeat skipped', L.added.join('|') === 'Arun Kale|Bina Rao' && L.skipped.join('|') === 'Arun Kale' && L.engineers.length === 2, L);
  L = await portal.addEngineers('Chetan Iyer', 'Sales Engineer');
  const arun = L.engineers.find((e) => e.name === 'Arun Kale');
  const bina = L.engineers.find((e) => e.name === 'Bina Rao');
  const chetan = L.engineers.find((e) => e.name === 'Chetan Iyer');
  ok('listed by type, then name', L.engineers.map((e) => e.name).join('|') === 'Arun Kale|Bina Rao|Chetan Iyer', L.engineers);
  await refuses('a name already on it', () => portal.saveEngineer({ name: 'arun kale', kind: 'Service Engineer' }), /already on the list/);
  await refuses('a type off the list', () => portal.addEngineers('Xavier', 'Fitter'), /Service Engineer or Sales Engineer/);
  portal.CURRENT_USER_ = RAVI;
  await refuses('kept by the sales team', () => portal.addEngineers('Yash', 'Service Engineer'), /sales team/);
  ok('read by anybody', (await portal.listEngineers()).canEdit === false);
  portal.CURRENT_USER_ = PRIYA;
  L = await portal.saveEngineer({ id: bina.id, name: 'Bina Rao-Patil' });
  ok('a coordinator renames one', L.engineers.some((e) => e.id === bina.id && e.name === 'Bina Rao-Patil') && L.canEdit === true);

  console.log('\nGENERATED BY, FROM THE LIST');
  portal.CURRENT_USER_ = BOSS;
  const g1 = await portal.saveSpareEnquiry({ customerId: 'CU-1', date: '2026-10-05', source: 'Service Engineer', generatedById: arun.id, requirementText: 'Filter' });
  ok('the engineer, with the name kept on the enquiry', g1.generatedById === arun.id && g1.generatedByName === 'Arun Kale', g1);
  await refuses('of the kind the source says', () => portal.saveSpareEnquiry({ customerId: 'CU-1', source: 'Service Engineer', generatedById: chetan.id }),
    /as a Sales Engineer; the source says Service Engineer/);
  const g2 = await portal.saveSpareEnquiry({ customerId: 'CU-1', date: '2026-10-06', source: 'Sales Engineer', generatedById: chetan.id, requirementText: 'Dryer' });
  ok('a sales engineer brings one in too', g2.generatedByName === 'Chetan Iyer');
  await refuses('and a sales engineer source names one', () => portal.saveSpareEnquiry({ customerId: 'CU-1', source: 'Sales Engineer' }), /generated by/);
  await portal.saveEngineer({ id: arun.id, active: false });
  await refuses('one switched off is not picked for a new enquiry', () => portal.saveSpareEnquiry({ customerId: 'CU-1', source: 'Service Engineer', generatedById: arun.id }), /switched off/);
  const keptG = await portal.saveSpareEnquiry({ id: g1.id, customerId: 'CU-1', date: '2026-10-05', requirementText: 'Filter, two of', generatedById: arun.id });
  ok('but stays on the enquiries he generated', keptG.generatedByName === 'Arun Kale');
  const listedG = await portal.listSpareEnquiries({ includeClosed: true });
  ok('the enquiry list names who generated it', (listedG.find((e) => e.id === g1.id) || {}).serviceEngineerName === 'Arun Kale');
  const repG = await portal.getEngineerLeadsReport({ from: '2026-10-01', to: '2026-10-31' });
  ok('Leads by Engineer counts them', repG.engineers.some((l) => l.name === 'Chetan Iyer' && l.spare.logged === 1) &&
    repG.rows.some((r) => r.id === g1.id && r.engineer === 'Arun Kale'), repG.engineers.map((l) => l.name + ':' + l.spare.logged));

  console.log('\nA UNIT QUOTATION NAMES ITS SALES ENGINEER');
  const uq = await portal.createBlankQuotation({ customerId: 'CU-1', businessStream: 'Compressor Sales', salesEngineerId: chetan.id });
  ok('picked on New quotation', uq.salesEngineerId === chetan.id && uq.salesEngineerName === 'Chetan Iyer', uq.salesEngineerName);
  await refuses('a sales engineer, not a service one', () => portal.createBlankQuotation({ customerId: 'CU-1', businessStream: 'Compressor Sales', salesEngineerId: bina.id }),
    /not a Sales Engineer/);
  const uq2 = await portal.saveQuotationHeader({ id: uq.id, notes: 'x' });
  ok('kept by a save that does not send it', uq2.salesEngineerName === 'Chetan Iyer');
  const uq3 = await portal.saveQuotationHeader({ id: uq.id, salesEngineerId: '' });
  ok('and cleared on the details', uq3.salesEngineerId === '' && uq3.salesEngineerName === '');

  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.log('CRASHED: ' + e.message);
  console.log(e.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
