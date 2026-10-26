/**
 * Deleting a quotation with nothing on it.
 *
 * A quotation with no compressor and no part offers nothing, so it can be deleted at any
 * status — a draft raised by mistake, a revision opened and never filled in, one marked sent
 * before anything went on it. Charge lines go with it. Still refused when a sales order or a
 * later revision hangs off it, and only the latest version of an offer can go, so revision
 * numbers never repeat.
 *
 * What it leaves behind is put right, for Discard Draft too: the version it replaced is
 * current again, the spares enquiry it came from goes back to Identifying, a service due call
 * lets go of it.
 *
 * Customers and parts are invented.
 *
 *   DATABASE_URL=postgres://... node tests/quote-delete-sql-test.js
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
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};
const refused = async (fn, re) => {
  try { await fn(); return 'not refused'; } catch (e) { return re.test(e.message) ? true : e.message; }
};

const TENANT = 'quote-delete-test';
const BOSS = { email: 'boss@pie.in', name: 'Test Boss', role: 'ERP Admin', businessStream: 'All' };
const TABLES = ['users', 'customers', 'customer_addresses', 'products', 'spares', 'price_list', 'quotations',
  'quotation_items', 'spare_enquiries', 'sales_orders', 'service_due_calls', 'quote_templates', 'audit_log'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  await db.appendRow('Users', { id: 'U-1', email: BOSS.email, name: BOSS.name, role: BOSS.role, active: 'TRUE' });
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Test Customer', active: 'TRUE' });
  await db.appendRow('CustomerAddresses', { id: 'AD-1', customerId: 'CU-1', addressType: 'Billing',
    line1: 'Plot 1', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: 'TRUE' });
  await db.appendRow('Spares', { id: 'SP-KIT', partNo: 'TST-KIT', description: 'TX recovery kit', uom: 'Nos',
    gstPct: 18, hsnCode: '8414', active: 'TRUE' });

  const p = loadPortal(db, BOSS.email, { quiet: true });
  p.CURRENT_USER_ = BOSS;
  const blank = () => p.createBlankQuotation({ customerId: 'CU-1', businessStream: 'Compressor Sales' });
  const row = async (id) => (await db.q('SELECT * FROM quotations WHERE tenant_id = $1 AND id = $2', [TENANT, id])).rows[0];
  const lines = async (id) => Number((await db.q('SELECT count(*) AS n FROM quotation_items WHERE tenant_id = $1 AND quotation_id = $2',
    [TENANT, id])).rows[0].n);
  const sent = (id) => db.q("UPDATE quotations SET status = 'Submitted', locked = 'TRUE', approval_date = '2026-10-20', " +
    "submitted_date = '2026-10-21' WHERE tenant_id = $1 AND id = $2", [TENANT, id]);

  console.log('AN EMPTY QUOTATION');
  let q = await blank();
  let res = await p.deleteQuotation(q.id);
  ok('a draft with nothing on it is deleted', !(await row(q.id)) && res.quoteNo === q.quoteNo && res.restored === null, res);
  q = await blank();
  await sent(q.id);
  ok('so is one marked sent before anything went on it', (await p.deleteQuotation(q.id)) && !(await row(q.id)));
  q = await blank();
  await p.saveQuotationCharge({ quotationId: q.id, description: 'Freight', amount: 1500 });
  await p.deleteQuotation(q.id);
  ok('charge lines alone do not stop it, and go with it', !(await row(q.id)) && (await lines(q.id)) === 0);
  ok('twice says so', await refused(() => p.deleteQuotation(q.id), /no longer exists/));

  console.log('\nONE WITH SOMETHING ON IT');
  q = await blank();
  await p.saveQuotationItem({ quotationId: q.id, itemType: 'Spare', itemId: 'SP-KIT', qty: 1 });
  ok('a draft with a part is refused, pointing at Discard Draft', await refused(() => p.deleteQuotation(q.id),
    /has 1 compressor or part on it.*Discard Draft/));
  await sent(q.id);
  ok('a sent one with a part is refused, pointing at Declined', await refused(() => p.deleteQuotation(q.id),
    /mark it Declined/));
  ok('and nothing was removed', !!(await row(q.id)) && (await lines(q.id)) === 1);
  const withOrder = await blank();
  await db.appendRow('SalesOrders', { id: 'SO-1', orderNo: 'SO-0001', customerId: 'CU-1', quotationId: withOrder.id });
  ok('an empty one with a sales order against it is refused', await refused(() => p.deleteQuotation(withOrder.id), /SO-0001/));

  console.log('\nA REVISION OPENED AND NEVER FILLED');
  const r0 = await blank();
  await p.saveQuotationItem({ quotationId: r0.id, itemType: 'Spare', itemId: 'SP-KIT', qty: 1 });
  await sent(r0.id);
  const r1 = await p.reviseQuotation(r0.id, 'Customer asked for a lower price');
  for (const it of r1.items) await p.deleteQuotationItem(it.id);
  ok('the first version cannot go while a revision came from it', await refused(() => p.deleteQuotation(r0.id),
    /came from .* Delete that revision first/));
  res = await p.deleteQuotation(r1.id);
  ok('the empty revision is deleted', !(await row(r1.id)));
  ok('and the version it replaced is current again, at the status its dates show',
    res.restored && res.restored.id === r0.id && res.restored.status === 'Submitted' &&
    (await row(r0.id)).status === 'Submitted', res.restored);
  const again = await p.reviseQuotation(r0.id, 'Customer asked for a lower price');
  ok('revising again gives R1, not R2', again.revision === 'R1', again.revision);
  for (const it of again.items) await p.deleteQuotationItem(it.id);
  await db.q("UPDATE quotations SET status = 'Approved', locked = 'TRUE', approval_date = '2026-10-22' " +
    'WHERE tenant_id = $1 AND id = $2', [TENANT, again.id]);
  const r2 = await p.reviseQuotation(again.id, 'Quantity changed to two');
  ok('only the latest version can go', await refused(() => p.deleteQuotation(again.id), /Only the latest version/));
  await p.deleteQuotation(r2.id);
  ok('R2 gone: R1 current again, Approved', (await row(again.id)).status === 'Approved', (await row(again.id)).status);

  console.log('\nWHAT IT WAS RAISED FROM');
  await db.appendRow('SpareEnquiries', { id: 'SE-1', enquiryNo: 'SE-0001', customerId: 'CU-1', status: 'Quoted' });
  const fromEnquiry = await blank();
  const second = await blank();
  await db.q('UPDATE quotations SET spare_enquiry_id = $3 WHERE tenant_id = $1 AND id = ANY($2)', [TENANT, [fromEnquiry.id, second.id], 'SE-1']);
  await p.deleteQuotation(fromEnquiry.id);
  const enq = async () => (await db.q("SELECT status FROM spare_enquiries WHERE tenant_id = $1 AND id = 'SE-1'", [TENANT])).rows[0].status;
  ok('the enquiry stays Quoted while another quotation is left for it', (await enq()) === 'Quoted');
  await p.deleteQuotation(second.id);
  ok('and goes back to Identifying when none is', (await enq()) === 'Identifying', await enq());
  const forCall = await blank();
  await db.appendRow('ServiceDueCalls', { id: 'SDC-1', fabNo: 'TXFAB1', quotationId: forCall.id, followUpCount: 0, listedCount: 1 });
  await p.deleteQuotation(forCall.id);
  const call = (await db.q("SELECT quotation_id FROM service_due_calls WHERE tenant_id = $1 AND id = 'SDC-1'", [TENANT])).rows[0];
  ok('a service due call lets go of it, so it can be quoted again', !call.quotation_id, call);

  console.log('\nDISCARD DRAFT PUTS THE SAME THINGS RIGHT');
  const d0 = await blank();
  await p.saveQuotationItem({ quotationId: d0.id, itemType: 'Spare', itemId: 'SP-KIT', qty: 1 });
  await sent(d0.id);
  const d1 = await p.reviseQuotation(d0.id, 'Delivery date changed');
  res = await p.discardQuotation(d1.id);
  ok('a discarded revision hands back to the version before it', res.restored && res.restored.id === d0.id &&
    (await row(d0.id)).status === 'Submitted', res.restored);

  console.log('\nWHO MAY');
  const eng = loadPortal(db, 'svc@pie.in', { quiet: true });
  eng.CURRENT_USER_ = { email: 'svc@pie.in', name: 'Svc', role: 'Service Engineer', businessStream: 'All' };
  const mine = await blank();
  ok('not a service engineer', await refused(() => eng.deleteQuotation(mine.id), /.+/) && !!(await row(mine.id)));

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
