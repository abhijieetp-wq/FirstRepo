/**
 * ERP 2.0's dashboard additions, on the server: the period selector (this month, last month,
 * quarter, year, a range) behind every "this month" figure; the spare enquiries a service
 * engineer raised, waiting for the coordinator; and a sales engineer's visits today.
 *
 * Customers and people are invented.
 *
 *   DATABASE_URL=postgres://... node tests/dashboard-extras-sql-test.js
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

const TENANT = 'dashboard-extras-test';
const PRIYA = { email: 'priya@pie.in', name: 'Priya', role: 'Sales Coordinator', businessStream: 'All' };
const ROHAN = { email: 'rohan@pie.in', name: 'Rohan', role: 'Sales Engineer', businessStream: 'All' };
const TEJ = { email: 'tej@pie.in', name: 'Tej', role: 'Service Engineer', businessStream: 'All' };
const TABLES = ['users', 'customers', 'spare_enquiries', 'quotations', 'sales_orders', 'leads', 'opportunities', 'sales_visits', 'tasks',
  'service_due_calls', 'config_lists', 'audit_log'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  for (const u of [PRIYA, ROHAN, TEJ]) {
    await db.appendRow('Users', { id: 'U-' + u.name, email: u.email, name: u.name, role: u.role, businessStream: u.businessStream, active: 'TRUE' });
  }
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Testwell Foods', active: 'TRUE' });
  const as = (who) => { const p = loadPortal(db, who.email, { quiet: true }); p.CURRENT_USER_ = who; return p; };
  const priya = as(PRIYA);
  const rohan = as(ROHAN);
  const today = priya.todayIso_();
  const day = (n) => priya.addDays_(today, n);
  const lastMonth = priya.taskPeriod_({ period: 'lastmonth' }, today);

  await db.appendRow('Quotations', { id: 'Q1', quoteNo: 'Q/1', date: lastMonth.from, businessStream: 'Spare Sales', customerId: 'CU-1', preparedBy: PRIYA.email, status: 'Won', grand: 5000 });
  await db.appendRow('SalesOrders', { id: 'O1', orderNo: 'SO/1', date: lastMonth.from, businessStream: 'Spare Sales', customerId: 'CU-1', quotationId: 'Q1', orderStatus: 'Draft', grand: 5900 });

  console.log('THE PERIOD');
  let d = await priya.getPersonDashboard({});
  const tile = (x, k) => x.tiles.find((t) => t.key === k) || {};
  ok('this month unless asked', d.period.key === 'month' && d.periodWord === 'this month' && tile(d, 'orders').label === 'My orders this month' &&
    tile(d, 'orders').value === '0' && d.periods.length === 5);
  d = await priya.getPersonDashboard({ period: 'lastmonth' });
  ok('last month’s figures, so named', tile(d, 'orders').label === 'My orders last month' && tile(d, 'orders').value === '1' && tile(d, 'orders').money === 5900, tile(d, 'orders'));
  d = await priya.getPersonDashboard({ period: 'custom', from: lastMonth.from, to: today });
  ok('or a range', tile(d, 'orders').label === 'My orders in the range' && tile(d, 'orders').value === '1');
  ok('the tasks tile follows it', /in the range$/.test(tile(d, 'tasks').sub || 'in the range'), tile(d, 'tasks'));

  console.log('\nRAISED BY SERVICE ENGINEERS, WAITING');
  await db.appendRow('SpareEnquiries', { id: 'E1', enquiryNo: 'SE/1', date: day(-3), customerId: 'CU-1', status: 'New', ownerEmail: PRIYA.email,
    serviceEngineerEmail: TEJ.email, productModel: 'EG 99', businessStream: 'Spare Sales' });
  await db.appendRow('SpareEnquiries', { id: 'E2', enquiryNo: 'SE/2', date: day(-1), customerId: 'CU-1', status: 'New', ownerEmail: PRIYA.email, businessStream: 'Spare Sales' });
  await db.appendRow('SpareEnquiries', { id: 'E3', enquiryNo: 'SE/3', date: day(-5), customerId: 'CU-1', status: 'Quoted', ownerEmail: PRIYA.email,
    serviceEngineerEmail: TEJ.email, businessStream: 'Spare Sales' });
  await db.appendRow('Quotations', { id: 'Q3', quoteNo: 'Q/3', date: day(-4), businessStream: 'Spare Sales', customerId: 'CU-1', preparedBy: PRIYA.email,
    status: 'Draft', grand: 0, spareEnquiryId: 'E3' });
  d = await priya.getPersonDashboard({});
  const list = d.lists.find((l) => l.key === 'engineer');
  ok('only the unquoted ones a service engineer raised', list && list.rows.length === 1 && /SE\/1 · from Tej · EG 99/.test(list.rows[0].sub) &&
    list.rows[0].rightSub === '3 days waiting' && list.rows[0].tone === 'bad' && list.rows[0].open.kind === 'enquiry', list);
  ok('and a tile for them', tile(d, 'engineer').value === '1' && tile(d, 'engineer').go === 'enquiries');

  console.log('\nTODAY’S VISITS');
  await db.appendRow('SalesVisits', { id: 'V1', engineerEmail: ROHAN.email, visitDate: today, customerName: 'Brightline Mills', area: 'Wardha',
    purpose: 'Air audit / energy study', status: 'Planned', active: 'TRUE' });
  await db.appendRow('SalesVisits', { id: 'V2', engineerEmail: ROHAN.email, visitDate: day(1), customerName: 'Sunrise Agro', status: 'Planned', active: 'TRUE' });
  d = await rohan.getPersonDashboard({});
  const visits = d.lists[0];
  ok('first on a sales engineer’s desk, today’s only', visits.key === 'visits' && visits.rows.length === 1 && visits.rows[0].title === 'Brightline Mills' &&
    /Air audit \/ energy study · Wardha \(Outstation\)/.test(visits.rows[0].sub) && visits.rows[0].rightSub === 'Planned' && visits.rows[0].open.kind === 'visits', visits);

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
