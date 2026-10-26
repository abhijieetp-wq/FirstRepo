/**
 * Service due calls, end to end on the server: the weekly upload, the call, the spares
 * quotation, the follow-ups, the three ways it ends and the report.
 *
 * Customers and machines are invented. PIE's real Service Due Report — their customers,
 * their machines — stays out of the repository.
 *
 *   DATABASE_URL=postgres://... node tests/service-due-sql-test.js
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

const TENANT = 'servicedue-test';
const COORD = { email: 'isha@pie.in', name: 'Isha', role: 'Sales Coordinator', businessStream: 'Spare Sales' };
const COORD2 = { email: 'dhriti@pie.in', name: 'Dhriti', role: 'Sales Coordinator', businessStream: 'Spare Sales' };
const TABLES = ['users', 'customers', 'customer_contacts', 'customer_addresses', 'service_due_lists',
  'service_due_calls', 'service_due_follow_ups', 'spare_enquiries', 'spare_enquiry_items', 'quotations',
  'quotation_items', 'sales_orders', 'audit_log'];

/** One report row, the shape the browser reads off ELGi's sheet. */
const machine = (fabNo, customerName, extra) => Object.assign({
  fabNo, customerName, dealerName: 'PREMIER INDIA ENTERPRISES - CU1P01781', productModel: 'TX 15-7.5',
  productGroup: 'SEPSAC', warrantyType: 'Out of warranty', amcType: '', callType: 'General Service',
  category: 'B (Below 100% potential spares purchase)', segment: 'TEST SEGMENT',
  serviceEngineer: 'Test Engineer', lastServiceCall: 'CC-1', lastServiceComment: 'Work done',
  commissionDate: '2022-01-23', invoiceDate: '2021-10-21', hmrDate: '2026-08-27', totalHours: '5218',
  runningHoursPerDay: '6', overdue: '1', dueThisMonth: '0', dueNextMonth: '0',
  dueDates: { AF: '2026-09-01', OF: '2026-10-25', OIL: '2026-11-15', AOS: '2027-03-01' }
}, extra || {});

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  for (const u of [COORD, COORD2, { email: 'admin@pie.in', name: 'Abhi Admin', role: 'ERP Admin', businessStream: 'All' },
    { email: 'svc@pie.in', name: 'Sam Service', role: 'Service Engineer', businessStream: 'All' }]) {
    await db.appendRow('Users', { id: 'U-' + u.name, email: u.email, name: u.name, role: u.role,
      businessStream: u.businessStream, active: 'TRUE' });
  }
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'M/s. Testwell Agro Foods Pvt. Ltd.', active: 'TRUE' });
  await db.appendRow('Customers', { id: 'CU-2', customerCode: 'C2', name: 'Sample Castings', active: 'TRUE' });
  await db.appendRow('CustomerAddresses', { id: 'AD-1', customerId: 'CU-1', addressType: 'Billing',
    line1: 'Plot 1', city: 'Nagpur', state: 'Maharashtra', pincode: '440001', isDefault: 'TRUE' });
  await db.appendRow('CustomerContacts', { id: 'CC-1', customerId: 'CU-1', name: 'Mr Rao', phone: '9800000001',
    email: 'rao@testwell.in', isPrimary: 'TRUE', active: 'TRUE' });

  const p = loadPortal(db, COORD.email, { quiet: true });
  p.CURRENT_USER_ = COORD;

  console.log('THE WEEKLY UPLOAD');
  const week1 = [
    machine('FAB001', 'TESTWELL AGRO FOODS PRIVATE LIMITED'),
    machine('FAB002', 'Testwell Agro Foods Pvt Ltd', { productModel: 'TX 22-7.5' }),
    machine('FAB003', 'Unknown Mills'),
    machine('FAB004', 'PREMIER INDIA ENTERPRISES - CU1P01781'),
    machine('fab001', 'TESTWELL AGRO FOODS PRIVATE LIMITED'),
    machine('', 'Nobody')
  ];
  let res = await p.importServiceDueList({ listDate: '2026-10-19', fileName: 'SDR_TEST.xlsx', rows: week1 });
  ok('three machines to call', res.added === 3 && res.carried === 0, res);
  ok('PIE’s own machine left out, and why', res.skipped.dealer === 1, res.skipped);
  ok('a repeated fab number and a row with none left out', res.skipped.duplicate === 1 && res.skipped.noFab === 1, res.skipped);
  ok('the customer not in Customers is named, so it can be added', JSON.stringify(res.unmatchedCustomers) === '["Unknown Mills"]', res.unmatchedCustomers);
  let screen = await p.getServiceDueScreen({ listId: res.listId });
  const byFab = (s) => Object.fromEntries(s.calls.map((c) => [c.fabNo, c]));
  let f = byFab(screen);
  ok('matched by name however it is spelt', f.FAB001.customerId === 'CU-1' && f.FAB002.customerId === 'CU-1' &&
    f.FAB001.customerName === 'M/s. Testwell Agro Foods Pvt. Ltd.', [f.FAB001.customerId, f.FAB002.customerId]);
  ok('what is due, in words', f.FAB001.dueParts === 'Overdue: AF · This month: OF · Next month: Oil', f.FAB001.dueParts);
  ok('and every part’s date kept', /AF 2026-09-01 \| OF 2026-10-25/.test(f.FAB001.dueDetail), f.FAB001.dueDetail);
  ok('everything starts To call, with the uploader', screen.calls.every((c) => c.status === 'To call' && c.ownerEmail === COORD.email));
  const people = screen.coordinators.map((x) => x.email);
  ok('the people list holds the ERP Admin, so their name shows, not their e-mail',
    people.includes('admin@pie.in') && screen.coordinators.find((x) => x.email === 'admin@pie.in').name === 'Abhi Admin', screen.coordinators);
  ok('but not a service engineer, who does not work the list', !people.includes('svc@pie.in'), people);
  ok('a file with no customer names is refused, nothing written', await refused(() => p.importServiceDueList({
    listDate: '2026-10-19', rows: [{ fabNo: 'X1', customerName: '' }, { fabNo: 'X2' }] }), /no customer names/) &&
    (await p.getServiceDueScreen({ view: 'all' })).lists.length === 1);
  ok('the week is listed', screen.lists.length === 1 && screen.lists[0].addedCount === 3 && screen.lists[0].skippedCount === 3, screen.lists);

  console.log('\nNEXT WEEK’S LIST');
  // Linked by hand in between: an upload must not undo it.
  await p.saveServiceDueCall({ id: f.FAB003.id, customerId: 'CU-2' });
  const week2 = [
    machine('FAB001', 'TESTWELL AGRO FOODS PRIVATE LIMITED', { totalHours: '5300', dueDates: { AF: '2026-09-01' } }),
    machine('FAB003', 'Unknown Mills'),
    machine('FAB005', 'Sample Castings')
  ];
  res = await p.importServiceDueList({ listDate: '2026-10-26', fileName: 'SDR_TEST_2.xlsx', rows: week2 });
  ok('two carried over, one new — not the round started again', res.added === 1 && res.carried === 2, res);
  screen = await p.getServiceDueScreen({});
  f = byFab(screen);
  ok('the carried machine shows the new figures', f.FAB001.totalHours === '5300' && f.FAB001.dueParts === 'Overdue: AF', [f.FAB001.totalHours, f.FAB001.dueParts]);
  ok('and both weeks', f.FAB001.listedCount === 2 && f.FAB001.listIds.split(',').length === 2 &&
    f.FAB001.firstListDate === '2026-10-19' && f.FAB001.lastListDate === '2026-10-26', [f.FAB001.listedCount, f.FAB001.listIds]);
  ok('a customer linked by hand stays linked', f.FAB003.customerId === 'CU-2', f.FAB003.customerId);
  ok('this week’s list holds this week’s machines', (await p.getServiceDueScreen({ listId: res.listId })).calls.length === 3);
  ok('FAB002 is still open from last week', f.FAB002.status === 'To call' && f.FAB002.listedCount === 1);

  console.log('\nTHE CALL');
  let call = await p.getServiceDueCall(f.FAB001.id);
  ok('the customer’s contacts, to ring', call.contacts.length === 1 && call.contacts[0].phone === '9800000001');
  ok('and their other machine on the list', call.siblings.length === 1 && call.siblings[0].fabNo === 'FAB002', call.siblings);
  ok('a call needs what the customer said', await refused(() => p.saveServiceDueCall({ id: f.FAB001.id, callDate: '2026-10-27' }), /what the customer said/));
  call = await p.saveServiceDueCall({ id: f.FAB001.id, callDate: '2026-10-27', callResponse: 'Needs spares',
    contactId: 'CC-1', contactName: 'Mr Rao', callNotes: 'Wants the filter kit', alsoIds: [f.FAB002.id, f.FAB005.id] });
  ok('logged', call.status === 'Called' && call.callResponse === 'Needs spares' && call.contactName === 'Mr Rao');
  f = byFab(await p.getServiceDueScreen({}));
  ok('on the same customer’s other machine too', f.FAB002.status === 'Called' && f.FAB002.callNotes === 'Wants the filter kit');
  ok('never on another customer’s, whatever the screen sent', f.FAB005.status === 'To call');

  console.log('\nTHE QUOTATION');
  // A machine whose customer is not linked to a record cannot be quoted yet.
  await p.saveServiceDueCall({ id: f.FAB005.id, customerId: '' });
  ok('not without a customer record', await refused(() => p.prepareServiceDueQuotation(f.FAB005.id), /not linked to a customer record/));
  await p.saveServiceDueCall({ id: f.FAB005.id, customerId: 'CU-2' });
  const made = await p.prepareServiceDueQuotation(f.FAB001.id);
  ok('a spares quotation, raised through an enquiry', /^SPARE\//.test(made.quoteNo) && made.existing === false, made);
  const q = await p.getQuotation(made.quotationId);
  ok('for this machine: fab number and model on it', q.serialNo === 'FAB001' && q.machineModel === 'TX 15-7.5' &&
    q.businessStream === 'Spare Sales' && q.customerId === 'CU-1', [q.serialNo, q.machineModel]);
  ok('addressed to the person who was called', q.contactId === 'CC-1', q.contactId);
  const enq = (await db.q('SELECT enquiry_no, source, requirement_text FROM spare_enquiries WHERE tenant_id = $1', [TENANT])).rows;
  ok('the enquiry says where it came from', enq.length === 1 && enq[0].source === 'Service Due List' &&
    /Overdue: AF/.test(enq[0].requirement_text), enq);
  ok('pressing it twice does not make a second', (await p.prepareServiceDueQuotation(f.FAB001.id)).existing === true &&
    (await db.q('SELECT count(*)::int n FROM quotations WHERE tenant_id = $1', [TENANT])).rows[0].n === 1);
  f = byFab(await p.getServiceDueScreen({}));
  ok('Quotation prepared', f.FAB001.status === 'Quotation prepared' && f.FAB001.quoteNo === made.quoteNo && f.FAB001.enquiryNo === enq[0].enquiry_no);
  await db.q("UPDATE quotations SET status = 'Submitted', submitted_date = '2026-10-27' WHERE tenant_id = $1", [TENANT]);
  f = byFab(await p.getServiceDueScreen({}));
  ok('once it goes out: Quotation sent', f.FAB001.status === 'Quotation sent' && f.FAB001.sentDate === '2026-10-27', f.FAB001.status);
  ok('a quotation already made can be tied on by its number', (await p.linkServiceDueQuotation(f.FAB002.id, made.quoteNo)).quotationId === made.quotationId);
  ok('but not one for another customer', await refused(() => p.linkServiceDueQuotation(f.FAB005.id, made.quoteNo), /different customer/));

  console.log('\nTHE FOLLOW-UPS');
  ok('a follow-up says what was said', await refused(() => p.addServiceDueFollowUp({ callId: f.FAB001.id, notes: '' }), /what was said/));
  call = await p.addServiceDueFollowUp({ callId: f.FAB001.id, followUpDate: '2026-10-29', mode: 'Call',
    notes: 'Checking budget', response: 'Call back Monday', nextFollowUpDate: '2026-11-02' });
  ok('the first, numbered 1', call.followUps.length === 1 && call.followUps[0].followUpNo === '1' && call.status === 'Following up', call.followUps);
  ok('the next date carried to the call', call.nextFollowUpDate === '2026-11-02' && call.followUpCount === 1);
  for (let i = 2; i <= 6; i++) {
    call = await p.addServiceDueFollowUp({ callId: f.FAB001.id, followUpDate: '2026-11-0' + i, mode: i % 2 ? 'Call' : 'WhatsApp', notes: 'Follow-up ' + i });
  }
  ok('six, in order', call.followUps.map((u) => u.followUpNo).join() === '1,2,3,4,5,6' && call.followUpCount === 6);
  ok('a next date before the follow-up is refused', await refused(() => p.addServiceDueFollowUp({ callId: f.FAB002.id,
    followUpDate: '2026-11-05', nextFollowUpDate: '2026-11-01', notes: 'x' }), /cannot be before/));

  console.log('\nHOW IT ENDS');
  ok('Not closed needs a reason', await refused(() => p.closeServiceDueCall({ id: f.FAB001.id, outcome: 'Not closed', reason: '' }), /why this customer could not be closed/));
  ok('not a token one', await refused(() => p.closeServiceDueCall({ id: f.FAB001.id, outcome: 'Not closed', reason: 'no' }), /why/));
  call = await p.closeServiceDueCall({ id: f.FAB001.id, outcome: 'Not closed', reason: 'Bought from a local supplier', outcomeDate: '2026-11-07' });
  ok('closed, with the reason', call.status === 'Not closed' && call.notClosedReason === 'Bought from a local supplier' && call.nextFollowUpDate === '');
  ok('a closed call takes no more follow-ups', await refused(() => p.addServiceDueFollowUp({ callId: f.FAB001.id, notes: 'x' }), /closed/));
  ok('PO rejected needs a reason too', await refused(() => p.closeServiceDueCall({ id: f.FAB002.id, outcome: 'PO rejected' }), /why the PO was rejected/));
  call = await p.closeServiceDueCall({ id: f.FAB002.id, outcome: 'PO rejected', reason: 'Price higher than budget', poNo: 'PO-77', outcomeDate: '2026-11-07' });
  ok('PO rejected, with its reason', call.status === 'PO rejected' && call.poRejectedReason === 'Price higher than budget' && call.notClosedReason === '');
  ok('PO received needs the PO number', await refused(() => p.closeServiceDueCall({ id: f.FAB003.id, outcome: 'PO received' }), /PO number/));
  call = await p.closeServiceDueCall({ id: f.FAB003.id, outcome: 'PO received', poNo: 'PO-88', poDate: '2026-11-08', poValue: 45000, outcomeDate: '2026-08-01' });
  ok('PO received', call.status === 'PO received' && call.poNo === 'PO-88' && Number(call.poValue) === 45000);
  call = await p.reopenServiceDueCall(f.FAB003.id);
  ok('reopened, the outcome cleared', call.status === 'Called' || call.status === 'To call', call.status);
  await p.closeServiceDueCall({ id: f.FAB003.id, outcome: 'PO received', poNo: 'PO-88', outcomeDate: '2026-08-01' });
  screen = await p.getServiceDueScreen({ view: 'closed' });
  ok('the closed ones, on their own', screen.calls.length === 3 && screen.calls.every((c) => c.outcome), screen.calls.map((c) => c.status));
  ok('and the open ones without them', (await p.getServiceDueScreen({})).calls.every((c) => !c.outcome));

  console.log('\nWHEN A CLOSED MACHINE COMES ROUND AGAIN');
  res = await p.importServiceDueList({ listDate: '2026-11-09', rows: [
    machine('FAB001', 'TESTWELL AGRO FOODS PRIVATE LIMITED'), machine('FAB003', 'Unknown Mills') ] });
  ok('closed two days ago: left off', res.skipped.recentlyClosed === 1 && res.added === 1, res);
  const again = (await p.getServiceDueScreen({})).calls.find((c) => c.fabNo === 'FAB003');
  ok('closed three months ago: back on, saying how it ended last time', again && /^PO received 01-08-2026/.test(again.previousOutcome), again && again.previousOutcome);

  console.log('\nHANDING CALLS OVER');
  const open = (await p.getServiceDueScreen({})).calls.map((c) => c.id);
  const moved = await p.assignServiceDueCalls(open, COORD2.email);
  ok('assigned', moved.assigned === open.length && (await p.getServiceDueScreen({})).calls.every((c) => c.ownerEmail === COORD2.email));

  console.log('\nTHE REPORT');
  const rep = await p.exportServiceDueReport({ view: 'all' });
  // FAB001 and FAB002 closed, FAB003 closed in August and back on the list, FAB005 open.
  ok('every machine, one row each', rep.rows.length === 5, rep.rows.length);
  ok('six follow-up columns at least', rep.headers.includes('Follow-up 6 notes') && rep.headers.includes('Follow-up 1 date'));
  const col = (h) => rep.headers.indexOf(h);
  const row1 = rep.rows.find((r) => r[col('Fab No')] === 'FAB001');
  ok('the reason not closed, in its column', row1[col('Reason not closed')] === 'Bought from a local supplier' &&
    row1[col('Status')] === 'Not closed', [row1[col('Status')], row1[col('Reason not closed')]]);
  ok('the follow-ups, dated, with what was said', row1[col('Follow-up 1 date')] === '2026-10-29' &&
    /Checking budget/.test(row1[col('Follow-up 1 notes')]) && /Call back Monday/.test(row1[col('Follow-up 1 notes')]));
  ok('the quotation and when it went out', /^SPARE\//.test(row1[col('Quotation No')]) && row1[col('Sent to customer')] === '2026-10-27');
  const row2 = rep.rows.find((r) => r[col('Fab No')] === 'FAB002');
  ok('the reason the PO was rejected, in its own column', row2[col('Reason PO rejected')] === 'Price higher than budget');
  ok('the workbook is told where the reasons are', rep.reasonColumns[0] === col('Reason not closed') &&
    rep.reasonColumns[1] === col('Reason PO rejected') && rep.statusColumn === col('Status'));
  ok('a summary by coordinator', rep.summary.length >= 1 && rep.summaryHeaders.includes('PO received') &&
    rep.summaryHeaders.includes('Not closed'), rep.summary);
  const onlyRejected = await p.exportServiceDueReport({ view: 'all', status: 'PO rejected' });
  ok('and it follows the screen’s filter', onlyRejected.rows.length === 1);

  console.log('\nTAKING A WRONG UPLOAD BACK OUT');
  const before5 = (await p.getServiceDueScreen({})).calls.find((c) => c.fabNo === 'FAB005');
  const wrong = await p.importServiceDueList({ listDate: '2026-11-16', fileName: 'wrong.xlsx', rows: [
    machine('FAB005', '', { dueDates: {} }), machine('FAB100', 'Fresh Mills'), machine('FAB101', 'Fresh Mills') ] });
  ok('the wrong file: two new, one carried', wrong.added === 2 && wrong.carried === 1, wrong);
  let s5 = (await p.getServiceDueScreen({})).calls.find((c) => c.fabNo === 'FAB005');
  ok('a blank in the new file does not wipe the name or what is due', s5.sdrCustomerName === 'Sample Castings' &&
    s5.dueParts === before5.dueParts && s5.dueParts !== '', [s5.sdrCustomerName, s5.dueParts]);
  ok('but the week is added to it', s5.listedCount === 2 && s5.lastListDate === '2026-11-16');
  const f101 = (await p.getServiceDueScreen({})).calls.find((c) => c.fabNo === 'FAB101');
  await p.saveServiceDueCall({ id: f101.id, callDate: '2026-11-17', callResponse: 'Needs spares', contactName: 'Mr Jain' });
  const out = await p.deleteServiceDueList(wrong.listId);
  ok('removed: the untouched machine goes, the one already called stays, the carried one goes back',
    out.removed === 1 && out.kept === 1 && out.carried === 1 && out.listDate === '2026-11-16', out);
  const after = await p.getServiceDueScreen({});
  ok('the week is gone from the list of weeks', !after.lists.some((l) => l.id === wrong.listId), after.lists.map((l) => l.listDate));
  ok('FAB100 deleted, FAB101 kept with its call', !after.calls.some((c) => c.fabNo === 'FAB100') &&
    after.calls.some((c) => c.fabNo === 'FAB101' && c.status === 'Called'));
  s5 = after.calls.find((c) => c.fabNo === 'FAB005');
  ok('FAB005 back to the weeks it was on before', s5.listedCount === 1 && s5.lastListDate === '2026-10-26' &&
    s5.listIds === before5.listIds, [s5.listedCount, s5.lastListDate, s5.listIds, before5.listIds]);
  ok('removing it twice says so', await refused(() => p.deleteServiceDueList(wrong.listId), /no longer there/));

  console.log('\nWHO MAY');
  const svc = loadPortal(db, 'eng@pie.in', { quiet: true });
  svc.CURRENT_USER_ = { email: 'eng@pie.in', name: 'Eng', role: 'Service Engineer', businessStream: 'All' };
  ok('not a service engineer', await refused(() => svc.getServiceDueScreen({}), /.+/));
  ok('nor take an upload out', await refused(() => svc.deleteServiceDueList('SDL-x'), /.+/));
  const comp = loadPortal(db, 'unit@pie.in', { quiet: true });
  comp.CURRENT_USER_ = { email: 'unit@pie.in', name: 'Unit', role: 'Sales Coordinator', businessStream: 'Compressor Sales' };
  ok('not the compressor desk', await refused(() => comp.getServiceDueScreen({}), /Spare Sales/));

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
