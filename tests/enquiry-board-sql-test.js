/**
 * ERP 2.0's enquiry board, on the server: each card lands on the stage the records say it
 * has reached, the three hand-set stages write ERP 1's own fields, and renaming a stage
 * renames it on both desks.
 *
 * Customers, enquiries and offers are invented.
 *
 *   DATABASE_URL=postgres://... node tests/enquiry-board-sql-test.js
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

const TENANT = 'board-test';
const COORD = { email: 'isha@pie.in', name: 'Isha', role: 'Sales Coordinator', businessStream: 'All' };
const BOSS = { email: 'boss@pie.in', name: 'Anil', role: 'Management', businessStream: 'All' };
const TABLES = ['users', 'customers', 'spare_enquiries', 'quotations', 'quotation_items', 'sales_orders', 'dispatches',
  'credit_checks', 'invoices', 'leads', 'opportunities', 'activities', 'config_lists', 'lost_reasons', 'audit_log'];

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  for (const u of [COORD, BOSS]) {
    await db.appendRow('Users', { id: 'U-' + u.name, email: u.email, name: u.name, role: u.role,
      businessStream: u.businessStream, active: 'TRUE' });
  }
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Testwell Foods', active: 'TRUE' });
  await db.appendRow('LostReasons', { id: 'LR-1', reasonText: 'Price too high', appliesTo: 'All', active: 'TRUE' });

  const SP = 'Spare Sales';
  const CP = 'Compressor Sales';
  const enquiry = (id, status, extra) => db.appendRow('SpareEnquiries', Object.assign({ id, enquiryNo: 'SE/' + id,
    date: daysAgo(5), customerId: 'CU-1', customerName: 'Testwell Foods', productModel: 'EG 99', serialNo: 'FAB-' + id,
    requirementText: 'Filter kit', urgency: 'Normal', source: 'Phone', ownerEmail: COORD.email, status,
    businessStream: SP }, extra || {}));
  const quote = (id, stream, status, extra) => db.appendRow('Quotations', Object.assign({ id, quoteNo: 'Q/' + id,
    revision: 'R0', date: daysAgo(4), businessStream: stream, customerId: 'CU-1', preparedBy: COORD.email, status,
    grand: 1000 }, extra || {}));
  const order = (id, quotationId, orderStatus, extra) => db.appendRow('SalesOrders', Object.assign({ id, orderNo: 'SO/' + id,
    date: daysAgo(2), businessStream: SP, customerId: 'CU-1', quotationId, poNo: 'PO-' + id, orderStatus, grand: 1180 },
  extra || {}));

  // The spare desk, one enquiry per stage.
  await enquiry('E1', 'New');
  await enquiry('E2', 'Identifying');
  await enquiry('E3', 'Quoted'); await quote('Q3', SP, 'Draft', { spareEnquiryId: 'E3' });
  await enquiry('E4', 'Quoted'); await quote('Q4', SP, 'Submitted', { spareEnquiryId: 'E4', approvalDate: daysAgo(3), submittedDate: daysAgo(3) });
  await enquiry('E5', 'Quoted'); await quote('Q5', SP, 'Negotiating', { spareEnquiryId: 'E5', submittedDate: daysAgo(3) });
  await enquiry('E6', 'Won'); await quote('Q6', SP, 'Won', { spareEnquiryId: 'E6', wonDate: daysAgo(1) });
  await enquiry('E7', 'Won'); await quote('Q7', SP, 'Won', { spareEnquiryId: 'E7' }); await order('O7', 'Q7', 'Draft');
  await enquiry('E8', 'Won'); await quote('Q8', SP, 'Won', { spareEnquiryId: 'E8' }); await order('O8', 'Q8', 'Draft');
  await db.appendRow('CreditChecks', { id: 'CC-8', salesOrderId: 'O8', customerId: 'CU-1', checkDate: today, result: 'Pass' });
  await enquiry('E9', 'Won'); await quote('Q9', SP, 'Won', { spareEnquiryId: 'E9' });
  await order('O9', 'Q9', 'Credit Hold', { creditHold: 'TRUE' });
  await db.appendRow('CreditChecks', { id: 'CC-9', salesOrderId: 'O9', customerId: 'CU-1', checkDate: today, result: 'Hold' });
  await enquiry('E10', 'Won'); await quote('Q10', SP, 'Won', { spareEnquiryId: 'E10' }); await order('O10', 'Q10', 'Material Pending');
  await enquiry('E11', 'Won'); await quote('Q11', SP, 'Won', { spareEnquiryId: 'E11' }); await order('O11', 'Q11', 'Ready for Dispatch');
  await db.appendRow('Dispatches', { id: 'D11', dispatchNo: 'DN-11', salesOrderId: 'O11', dispatchDate: daysAgo(1), status: 'Dispatched' });
  await enquiry('E12', 'Lost', { lostReasonId: 'LR-1' }); await quote('Q12', SP, 'Lost', { spareEnquiryId: 'E12', lostReasonId: 'LR-1' });
  // Revised: R0 superseded by R1 that is sent.
  await enquiry('E13', 'Quoted');
  await quote('Q13', SP, 'Revised', { spareEnquiryId: 'E13' });
  await quote('Q13b', SP, 'Submitted', { spareEnquiryId: 'E13', revision: 'R1', parentQuotationId: 'Q13', submittedDate: daysAgo(1) });
  // Two quotations, one lost and one still open: the open one speaks.
  await enquiry('E14', 'Quoted');
  await quote('Q14a', SP, 'Lost', { spareEnquiryId: 'E14', lostReasonId: 'LR-1' });
  await quote('Q14b', SP, 'Draft', { spareEnquiryId: 'E14' });
  // Long finished: off the board.
  await enquiry('E15', 'Lost', { date: daysAgo(400) });
  await enquiry('E16', 'Quoted', { enquiryType: 'AMC renewal' }); await quote('Q16', SP, 'Expired', { spareEnquiryId: 'E16' });
  // A spares quotation with no enquiry behind it.
  await quote('Q17', SP, 'Approved', { approvalDate: daysAgo(1), machineModel: 'EG 77', serialNo: 'FAB-W' });

  // The compressor desk.
  await db.appendRow('Leads', { id: 'L1', leadNo: 'LD/1', date: daysAgo(6), customerId: 'CU-1', requirementSummary: '2 × 30 kW screw',
    ownerEmail: COORD.email, status: 'New', businessStream: CP, nextActionDate: daysAgo(1) });
  await db.appendRow('Leads', { id: 'L2', leadNo: 'LD/2', date: daysAgo(6), customerId: 'CU-1', requirementSummary: 'Dryer',
    ownerEmail: COORD.email, status: 'Converted', businessStream: CP });
  await db.appendRow('Opportunities', { id: 'OP2', opportunityNo: 'OP/2', leadId: 'L2', customerId: 'CU-1', stage: 'Quotation',
    businessStream: CP, title: 'Dryer for line 2' });
  await quote('QC2', CP, 'Submitted', { opportunityId: 'OP2', submittedDate: daysAgo(2) });
  await db.appendRow('Leads', { id: 'L3', leadNo: 'LD/3', date: daysAgo(6), customerId: 'CU-1', requirementSummary: 'Piston',
    ownerEmail: COORD.email, status: 'Disqualified', businessStream: CP });
  await quote('QC4', CP, 'Draft', {});

  const p = loadPortal(db, COORD.email, { quiet: true });
  p.CURRENT_USER_ = COORD;

  console.log('THE SPARE DESK');
  let board = await p.getEnquiryBoard({ stream: SP });
  const at = (b) => Object.fromEntries(b.cards.map((c) => [c.ref, c]));
  let c = at(board);
  ok('ten stages, in ERP 2’s order', board.stages.map((s) => s.label).join(' | ') ===
    'Enquiry received | Requirement understood | Quotation prepared | Quotation sent | In negotiation | ' +
    'Approved by customer | PO received | Sales order (WON) | Material procurement | Dispatched', board.stages.map((s) => s.label));
  ok('and a closed column apart', board.closed.label === 'Rejected / Lost');
  ok('which are set by hand, which move by themselves', board.stages.filter((s) => s.how === 'hand').map((s) => s.key).join() ===
    'enquiry,requirement,negotiation');
  const want = { 'SE:E1': 'enquiry', 'SE:E2': 'requirement', 'SE:E3': 'quoted', 'SE:E4': 'sent', 'SE:E5': 'negotiation',
    'SE:E6': 'approved', 'SE:E7': 'po', 'SE:E8': 'won', 'SE:E9': 'po', 'SE:E10': 'procurement', 'SE:E11': 'dispatched',
    'SE:E12': 'lost', 'SE:E13': 'sent', 'SE:E14': 'quoted', 'SE:E16': 'lost', 'QT:Q17': 'quoted' };
  const got = Object.fromEntries(Object.keys(want).map((k) => [k, c[k] ? c[k].stage : 'missing']));
  ok('every card on the stage its records say', JSON.stringify(got) === JSON.stringify(want), got);
  ok('a revised offer counts by its newest revision', c['SE:E13'].quote.quoteNo === 'Q/Q13b' && c['SE:E13'].quoteCount === 1, c['SE:E13'].quote);
  ok('a lost offer beside a live one does not close the enquiry', c['SE:E14'].quote.quoteNo === 'Q/Q14b');
  ok('the reason it was lost is on the card', c['SE:E12'].closedWhy === 'Lost: Price too high', c['SE:E12'].closedWhy);
  ok('an expired offer closes it, saying so', c['SE:E16'].closedWhy === 'Offer expired' && c['SE:E16'].type === 'AMC renewal');
  ok('a held order waits at PO received, its hold shown', c['SE:E9'].order.creditHold === true);
  ok('the value is the order’s once there is one, else the offer’s', c['SE:E7'].value === 1180 && c['SE:E4'].value === 1000 && c['SE:E1'].value === '');
  ok('a quotation with no enquiry is a card of its own', c['QT:Q17'].kind === 'quotation' && c['QT:Q17'].what === 'EG 77 · FAB-W');
  ok('long finished work has left the board', !c['SE:E15']);
  ok('the compressor desk’s offers are not on it', !Object.keys(c).some((k) => k === 'QT:QC4' || k === 'QT:QC2'));
  ok('the owner by name', c['SE:E1'].ownerName === 'Isha');

  console.log('\nMOVED BY HAND, INTO ERP 1’S OWN FIELDS');
  ok('only where a stage is set by hand', JSON.stringify(c['SE:E1'].moves) === '["requirement"]' &&
    JSON.stringify(c['SE:E2'].moves) === '["enquiry"]' && JSON.stringify(c['SE:E4'].moves) === '["negotiation"]' &&
    JSON.stringify(c['SE:E5'].moves) === '["sent"]' && c['SE:E3'].moves.length === 0 && c['SE:E7'].moves.length === 0);
  let moved = await p.moveBoardCard({ ref: 'SE:E1', to: 'requirement' });
  ok('enquiry → requirement understood', moved.stage === 'requirement');
  ok('written as the enquiry’s status, which ERP 1 shows', (await db.q("SELECT status FROM spare_enquiries WHERE tenant_id=$1 AND id='E1'", [TENANT])).rows[0].status === 'Identifying');
  moved = await p.moveBoardCard({ ref: 'SE:E1', to: 'enquiry' });
  ok('and back', moved.stage === 'enquiry');
  ok('a stage that follows the records is refused', await refused(() => p.moveBoardCard({ ref: 'SE:E3', to: 'sent' }), /cannot be moved/));
  ok('negotiation needs a word on what is being discussed', await refused(() => p.moveBoardCard({ ref: 'SE:E4', to: 'negotiation', note: '' }), /what the customer is discussing/));
  moved = await p.moveBoardCard({ ref: 'SE:E4', to: 'negotiation', note: 'Wants 5% off the kit' });
  ok('sent → in negotiation', moved.stage === 'negotiation');
  const q4 = (await db.q("SELECT status, submitted_date FROM quotations WHERE tenant_id=$1 AND id='Q4'", [TENANT])).rows[0];
  ok('the quotation is Negotiating, still sent on the day it went', q4.status === 'Negotiating' && String(q4.submitted_date).slice(0, 10) === daysAgo(3), q4);
  const note = (await db.q("SELECT notes, related_type FROM activities WHERE tenant_id=$1 AND related_id='Q4'", [TENANT])).rows;
  ok('and the note is kept against the quotation', note.length === 1 && note[0].notes === 'In negotiation: Wants 5% off the kit' && note[0].related_type === 'Quotation', note);
  moved = await p.moveBoardCard({ ref: 'SE:E4', to: 'sent' });
  ok('back to sent, the dates untouched', moved.stage === 'sent' &&
    String((await db.q("SELECT submitted_date FROM quotations WHERE tenant_id=$1 AND id='Q4'", [TENANT])).rows[0].submitted_date).slice(0, 10) === daysAgo(3));
  ok('a card no longer on the board says so', await refused(() => p.moveBoardCard({ ref: 'SE:NOPE', to: 'requirement' }), /no longer on the board/));

  console.log('\nTHE COMPRESSOR DESK');
  board = await p.getEnquiryBoard({ stream: CP });
  c = at(board);
  ok('a new lead is an enquiry received, its next action carried', c['LD:L1'].stage === 'enquiry' && c['LD:L1'].followUp === daysAgo(1));
  ok('a lead’s opportunity’s quotation moves the lead', c['LD:L2'].stage === 'sent' && c['LD:L2'].quote.quoteNo === 'Q/QC2', c['LD:L2']);
  ok('a disqualified lead is closed', c['LD:L3'].stage === 'lost' && /Disqualified/.test(c['LD:L3'].closedWhy));
  ok('the opportunity is not a second card for the same lead', !c['OP:OP2']);
  ok('a compressor quotation with no lead is a card of its own', c['QT:QC4'].stage === 'quoted');
  moved = await p.moveBoardCard({ ref: 'LD:L1', to: 'requirement', note: 'Two shifts, 7 bar' });
  ok('a lead moved on is Qualified, as ERP 1 calls it', moved.stage === 'requirement' &&
    (await db.q("SELECT status FROM leads WHERE tenant_id=$1 AND id='L1'", [TENANT])).rows[0].status === 'Qualified');
  ok('with its note in the lead’s follow-ups', (await db.q("SELECT notes FROM activities WHERE tenant_id=$1 AND related_id='L1'", [TENANT])).rows[0].notes === 'Two shifts, 7 bar');
  await p.moveBoardCard({ ref: 'LD:L2', to: 'negotiation', note: 'Comparing with a rival offer' });
  ok('negotiating a lead’s offer keeps its opportunity in step',
    (await db.q("SELECT stage FROM opportunities WHERE tenant_id=$1 AND id='OP2'", [TENANT])).rows[0].stage === 'Negotiation');

  console.log('\nSTAGE NAMES');
  ok('a coordinator may not rename a stage', await refused(() => p.saveBoardStageName('po', 'PO in hand'), /.+/));
  p.CURRENT_USER_ = BOSS;
  await p.saveBoardStageName('po', 'PO in hand');
  ok('management may, and both desks follow', (await p.getEnquiryBoard({ stream: SP })).stages.find((s) => s.key === 'po').label === 'PO in hand' &&
    (await p.getEnquiryBoard({ stream: CP })).stages.find((s) => s.key === 'po').label === 'PO in hand');
  await p.saveBoardStageName('po', 'PO received!');
  ok('renaming again changes the same entry', (await db.q("SELECT count(*)::int n FROM config_lists WHERE tenant_id=$1 AND category='BoardStage'", [TENANT])).rows[0].n === 1);
  ok('stages cannot be added', await refused(() => p.saveBoardStageName('invoiced', 'Invoiced'), /renamed, not added/));
  ok('or left nameless', await refused(() => p.saveBoardStageName('po', '  '), /needs a name/));

  console.log('\nWHO MAY');
  const svc = loadPortal(db, 'eng@pie.in', { quiet: true });
  svc.CURRENT_USER_ = { email: 'eng@pie.in', name: 'Eng', role: 'Service Engineer', businessStream: 'All' };
  ok('not service', await refused(() => svc.getEnquiryBoard({ stream: SP }), /sales work/));
  const unit = loadPortal(db, 'unit@pie.in', { quiet: true });
  unit.CURRENT_USER_ = { email: 'unit@pie.in', name: 'Unit', role: 'Sales Coordinator', businessStream: CP };
  ok('nor the other desk’s board', await refused(() => unit.getEnquiryBoard({ stream: SP }), /Spare Sales/));
  ok('nor move its cards', await refused(() => unit.moveBoardCard({ ref: 'SE:E2', to: 'enquiry' }), /Spare Sales/));

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
