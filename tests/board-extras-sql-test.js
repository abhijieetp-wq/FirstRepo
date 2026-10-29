/**
 * ERP 2.0's additions to the enquiry board, on the server: a compressor lead's area (Local or
 * Outstation) through ERP 1's own lead save, kept when ERP 1's form saves without it; and the
 * card's order tab — order date, the lorry, the first invoice.
 *
 * Customers and people are invented.
 *
 *   DATABASE_URL=postgres://... node tests/board-extras-sql-test.js
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

const TENANT = 'board-extras-test';
const NEHA = { email: 'neha@pie.in', name: 'Neha', role: 'Sales Coordinator', businessStream: 'All' };
const TABLES = ['users', 'customers', 'leads', 'lead_requirements', 'spare_enquiries', 'quotations', 'sales_orders', 'dispatches', 'invoices',
  'credit_checks', 'config_lists', 'audit_log'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  await db.appendRow('Users', { id: 'U-N', email: NEHA.email, name: NEHA.name, role: NEHA.role, businessStream: NEHA.businessStream, active: 'TRUE' });
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Testwell Foods', active: 'TRUE' });
  const neha = loadPortal(db, NEHA.email, { quiet: true });
  neha.CURRENT_USER_ = NEHA;
  const today = neha.todayIso_();
  const day = (n) => neha.addDays_(today, n);

  console.log('A LEAD’S AREA');
  const base = { customerName: 'Brightline Mills', source: 'Phone', requirementSummary: '37 kW screw', status: 'New', nextActionDate: day(3) };
  const lead = await neha.saveLead(Object.assign({ area: 'Wardha' }, base));
  ok('kept on the lead', lead.area === 'Wardha');
  ok('only an area on the list', await refused(() => neha.saveLead(Object.assign({ area: 'Atlantis' }, base)), /area from the list/));
  await neha.saveLead(Object.assign({ id: lead.id }, base, { contactPhone: '9800000001' }));
  ok('ERP 1’s form, sending none, keeps it', (await db.q('SELECT area FROM leads WHERE tenant_id=$1 AND id=$2', [TENANT, lead.id])).rows[0].area === 'Wardha');
  await neha.saveLead(Object.assign({ id: lead.id, area: '' }, base));
  ok('2.0’s form can clear it', (await db.q('SELECT area FROM leads WHERE tenant_id=$1 AND id=$2', [TENANT, lead.id])).rows[0].area === null);
  await neha.saveLead(Object.assign({ id: lead.id, area: 'Hingna MIDC' }, base));
  let board = await neha.getEnquiryBoard({ stream: 'Compressor Sales' });
  const lc = board.cards.find((c) => c.ref === 'LD:' + lead.id);
  ok('the card shows it, Local or Outstation', lc.area === 'Hingna MIDC' && lc.areaType === 'Local', lc);

  console.log('\nTHE ORDER TAB ON THE CARD');
  await db.appendRow('SpareEnquiries', { id: 'E1', enquiryNo: 'SE/1', date: day(-10), customerId: 'CU-1', status: 'Won', ownerEmail: NEHA.email, businessStream: 'Spare Sales' });
  await db.appendRow('Quotations', { id: 'Q1', quoteNo: 'Q/1', revision: 'R0', date: day(-9), businessStream: 'Spare Sales', customerId: 'CU-1',
    preparedBy: NEHA.email, status: 'Won', grand: 1000, spareEnquiryId: 'E1' });
  await db.appendRow('SalesOrders', { id: 'O1', orderNo: 'SO/1', date: day(-5), businessStream: 'Spare Sales', customerId: 'CU-1', quotationId: 'Q1',
    poNo: 'PO-1', orderStatus: 'Dispatched', grand: 1180 });
  await db.appendRow('Dispatches', { id: 'D1', dispatchNo: 'DN-1', salesOrderId: 'O1', dispatchDate: day(-2), status: 'Dispatched',
    transporterName: 'Quickline Roadways', vehicleNo: 'MH31AB1234', lrNumber: 'LR-77', lrDate: day(-2) });
  await db.appendRow('Invoices', { id: 'I1', invoiceNo: 'INV/1', invoiceDate: day(-2), salesOrderId: 'O1', dispatchId: 'D1', customerId: 'CU-1', grand: 1180 });
  board = await neha.getEnquiryBoard({ stream: 'Spare Sales' });
  const ec = board.cards.find((c) => c.ref === 'SE:E1');
  ok('the order with its date', ec.order && ec.order.orderNo === 'SO/1' && ec.order.date === day(-5), ec.order);
  ok('the lorry', ec.dispatch.transporter === 'Quickline Roadways' && ec.dispatch.vehicleNo === 'MH31AB1234' && ec.dispatch.lrNumber === 'LR-77' &&
    ec.dispatch.lrDate === day(-2), ec.dispatch);
  ok('and the first invoice', ec.invoice && ec.invoice.invoiceNo === 'INV/1' && ec.invoice.date === day(-2), ec.invoice);
  ok('a spare enquiry has no area', ec.area === '' && ec.areaType === '');

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
