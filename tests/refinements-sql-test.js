/**
 * The refinements of 19 Oct, against a real Postgres, through the portal's own code.
 *
 * The browser test proves the screens ask and show the right things. This proves the server
 * holds the line when the screen is skipped, and that the figures it hands the screens are
 * the right ones: a revision without a reason is refused whoever sends it, the progress
 * download names the right people and the right reasons, and an invoice is owed at what
 * Tally billed — never when it is a draft, never when it was cancelled.
 *
 *   DATABASE_URL=postgres://... node tests/refinements-sql-test.js
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

const TENANT = 'refine-test';
const BOSS = { email: 'boss@pie.in', name: 'Anil Shah', role: 'ERP Admin' };
const TABLES = ['users', 'customers', 'lost_reasons', 'quotations', 'quotation_items',
  'sales_orders', 'sales_order_items', 'invoices', 'receipts', 'audit_log',
  'collection_followups', 'dispatches', 'dispatch_items', 'documents'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();

  const add = (tab, row) => db.appendRow(tab, row);
  await add('Users', { id: 'U-1', email: 'priya@pie.in', name: 'Priya Deshmukh', role: 'Sales Coordinator', active: 'TRUE' });
  await add('Users', { id: 'U-2', email: BOSS.email, name: BOSS.name, role: BOSS.role, active: 'TRUE' });
  await add('Customers', { id: 'CU-1', customerCode: 'C0001', name: 'Topworth Urja', active: 'TRUE', creditLimit: 500000 });
  await add('Customers', { id: 'CU-2', customerCode: 'C0002', name: 'Kalyani Steels', active: 'TRUE' });
  await add('LostReasons', { id: 'LR-001', reasonText: 'Price too high', appliesTo: 'All', active: 'TRUE' });

  const quote = (o) => Object.assign({ revision: 'R0', businessStream: 'Spare Sales',
    date: '2026-10-01', validityDays: 30, status: 'Submitted', locked: 'TRUE',
    grand: 10000, taxAmt: 0, taxMode: 'Inclusive', preparedBy: 'priya@pie.in',
    createdBy: 'priya@pie.in', createdAt: '2026-10-01T09:00:00Z' }, o);
  await add('Quotations', quote({ id: 'QT-1', quoteNo: 'Q/401', customerId: 'CU-1',
    approvedBy: BOSS.email, approvalDate: '2026-10-01', submittedDate: '2026-10-02' }));
  await add('QuotationItems', { id: 'QI-1', quotationId: 'QT-1', lineNo: 1, itemType: 'Spare',
    itemId: 'SP-1', itemCode: 'P1', description: 'Separator', qty: 2, unitPrice: 5000, lineTotal: 10000 });
  await add('Quotations', quote({ id: 'QT-2', quoteNo: 'Q/402', customerId: 'CU-2',
    status: 'Lost', lostReasonId: 'LR-001', lostDate: '2026-10-05',
    lostNotes: 'Said "too costly", went with Atlas', lostToCompetitor: 'Atlas Copco',
    lostAtPrice: 8800 }));
  await add('Quotations', quote({ id: 'QT-3', quoteNo: 'Q/403', customerId: 'CU-1',
    status: 'Won', wonDate: '2026-10-03', grand: 100000 }));

  const portal = loadPortal(db, BOSS.email, { quiet: true });
  portal.CURRENT_USER_ = BOSS;

  // ---------------------------------------------------------------- the reason to revise
  console.log('A REVISION IS REFUSED WITHOUT A REASON, WHOEVER ASKS');
  await refuses('no reason at all', () => portal.reviseQuotation('QT-1'), /Say why/);
  await refuses('a blank one', () => portal.reviseQuotation('QT-1', '   '), /Say why/);
  await refuses('a token one', () => portal.reviseQuotation('QT-1', 'ok'), /real reason/);
  await refuses('punctuation', () => portal.reviseQuotation('QT-1', '.....'), /real reason/);
  const untouched = await db.findRowById('Quotations', 'QT-1');
  ok('and a refused revision changes nothing', untouched.status === 'Submitted', untouched.status);

  console.log('\nWITH ONE, THE REASON IS KEPT ON THE REVISION IT MADE');
  const r1 = await portal.reviseQuotation('QT-1', '  Customer asked for   a lower price  ');
  ok('the revision is made', r1 && r1.revision === 'R1', r1 && r1.revision);
  const r1row = await db.findRowById('Quotations', r1.id);
  ok('carrying the reason, tidied', r1row.revisionReason === 'Customer asked for a lower price',
    r1row.revisionReason);
  ok('the one it replaced is Revised', (await db.findRowById('Quotations', 'QT-1')).status === 'Revised');
  const audit = await db.q("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND " +
    "reason LIKE '%Customer asked for a lower price%'", [TENANT]);
  ok('and the audit log says why, on both rows', audit.rows[0].n >= 2, audit.rows[0].n);

  const versions = await portal.listQuotationVersions(r1.id);
  ok('the versions list carries the reason', versions.some((v) =>
    v.revision === 'R1' && v.revisionReason === 'Customer asked for a lower price'), versions);
  const trail = await portal.getQuotationProgress(r1.id);
  ok('and so does the progress trail', trail.revisions.some((v) =>
    v.revision === 'R1' && v.revisionReason === 'Customer asked for a lower price'), trail.revisions);

  console.log('\nA DECLINED OFFER REVISED IS A FRESH ATTEMPT, NOT A SECOND LOSS');
  const again = await portal.reviseQuotation('QT-2', 'Trying again at the price they named');
  const againRow = await db.findRowById('Quotations', again.id);
  ok('the new revision carries none of the decline', !againRow.lostReasonId &&
    !againRow.lostNotes && !againRow.lostToCompetitor && againRow.lostAtPrice === '' &&
    !againRow.lostDate, againRow);

  // ---------------------------------------------------------------- the progress list
  console.log('\nTHE PROGRESS LIST NAMES WHO CREATED EACH OFFER');
  // Put QT-2's family back to a single declined offer for the rest of this, so the list has a
  // live declined row to describe.
  await db.q("DELETE FROM quotations WHERE tenant_id = $1 AND id = $2", [TENANT, again.id]);
  await db.updateRowById('Quotations', 'id', 'QT-2', { status: 'Lost' });

  const list = await portal.listProgressCandidates();
  const live1 = list.find((r) => r.quoteNo === 'Q/401');
  ok('one row per offer, the live revision', list.length === 3 && live1 && live1.revision === 'R1',
    list.map((r) => r.quoteNo + ' ' + r.revision));
  ok('created by the person who raised the original', live1.createdBy === 'Priya Deshmukh', live1);
  ok('and the revision by whoever made it', live1.revisedBy === BOSS.name, live1);
  ok('by name, never by address', list.every((r) => !/@/.test(r.createdBy + r.revisedBy)));
  const lost = list.find((r) => r.quoteNo === 'Q/402');
  ok('a declined offer says why', lost.lostReason === 'Price too high' && lost.stage === 'Declined', lost);
  ok('and an unrevised one names nobody twice', lost.revisedBy === '', lost);

  console.log('\nTHE DOWNLOAD HAS EVERYTHING, IN THE HEADER\'S ORDER');
  // Money on the won offer: an order, an issued invoice Tally billed differently from the
  // lines, a part payment, a draft and a cancelled one that must not count.
  await add('SalesOrders', { id: 'SO-1', orderNo: 'SO/1', quotationId: 'QT-3', customerId: 'CU-1',
    date: '2026-10-04', orderStatus: 'Invoiced', grand: 100000, poNo: 'PO-77', businessStream: 'Spare Sales' });
  await add('Invoices', { id: 'IN-1', invoiceNo: 'ELGI/0444', salesOrderId: 'SO-1', customerId: 'CU-1',
    invoiceDate: '2026-10-05', dueDate: '2026-10-06', status: 'Issued', grand: 100000,
    invoiceValue: 100400, amountReceived: 0, businessStream: 'Spare Sales' });
  await add('Invoices', { id: 'IN-2', invoiceNo: '', salesOrderId: 'SO-1', customerId: 'CU-1',
    invoiceDate: '2026-10-06', status: 'Draft', grand: 25000, amountReceived: 0, businessStream: 'Spare Sales' });
  await add('Invoices', { id: 'IN-3', invoiceNo: 'ELGI/0440', salesOrderId: 'SO-1', customerId: 'CU-1',
    invoiceDate: '2026-10-02', status: 'Cancelled', grand: 70000, amountReceived: 0, businessStream: 'Spare Sales' });
  await portal.saveReceipt({ invoiceId: 'IN-1', amount: 40000, receiptDate: '2026-10-10', mode: 'NEFT' });

  const t = await portal.exportQuotationProgress();
  ok('every row is as long as the header', t.rows.every((r) => r.length === t.headers.length),
    t.headers.length);
  const col = (name) => t.headers.indexOf(name);
  const rowOf = (no) => t.rows.find((r) => r[col('Quote No.')] === no);
  const dl = rowOf('Q/402');
  ok('the decline reason is there', dl[col('Reason for decline')] === 'Price too high', dl);
  ok('with what the customer said', dl[col('What the customer said')] === 'Said "too costly", went with Atlas');
  ok('who won it and at what price', dl[col('Lost to')] === 'Atlas Copco' && dl[col('Their price (Rs)')] === 8800,
    [dl[col('Lost to')], dl[col('Their price (Rs)')]]);
  ok('in the screens\' words', dl[col('Status')] === 'Declined', dl[col('Status')]);
  const rv = rowOf('Q/401');
  ok('the revision reason and count', rv[col('Latest revision reason')] === 'Customer asked for a lower price' &&
    rv[col('Times revised')] === 1, [rv[col('Latest revision reason')], rv[col('Times revised')]]);
  ok('who created it and who revised it', rv[col('Created by')] === 'Priya Deshmukh' &&
    rv[col('Live revision by')] === BOSS.name);
  const won = rowOf('Q/403');
  ok('the order and the customer PO', won[col('Sales order')] === 'SO/1' && won[col('Customer PO')] === 'PO-77');
  ok('invoiced at what Tally billed, the draft and the cancelled one left out',
    won[col('Invoiced (Rs)')] === 100400, won[col('Invoiced (Rs)')]);
  ok('received and balance from the receipts', won[col('Received (Rs)')] === 40000 &&
    won[col('Balance due (Rs)')] === 60400, [won[col('Received (Rs)')], won[col('Balance due (Rs)')]]);
  ok('money as numbers, not text', typeof won[col('Quoted value (Rs)')] === 'number');

  // ---------------------------------------------------------------- invoices
  console.log('\nAN INVOICE IS OWED AT WHAT WAS BILLED, AND ONLY ONCE ISSUED');
  const invs = await portal.listInvoices({});
  const by = (id) => invs.find((i) => i.id === id);
  ok('the list values the issued invoice at what Tally billed', by('IN-1').billedAmt === 100400,
    by('IN-1').billedAmt);
  ok('and its balance is billed less received — the figure the invoice window shows',
    by('IN-1').balanceAmt === 60400 &&
    (await portal.getInvoice('IN-1')).balanceAmt === 60400, by('IN-1').balanceAmt);
  ok('it is owed', by('IN-1').owed === true);
  ok('a draft is not owed yet', by('IN-2').owed === false, by('IN-2'));
  ok('and has no days overdue to count', by('IN-2').overdueDays === 0);
  const unpaid = await portal.listInvoices({ unpaidOnly: true });
  ok('unpaid-only judges on the billed figure too', unpaid.some((i) => i.id === 'IN-1'));

  const exposure = await portal.calculateCreditExposure('CU-1');
  ok('credit exposure counts the issued balance at billed', Math.round(exposure.outstandingAmt) === 60400,
    exposure.outstandingAmt);
  ok('not the cancelled invoice, nor the draft on top of its order',
    Math.round(exposure.existingExposure) === 60400, exposure);

  console.log('\nAND IT IS SETTLED ONLY WHEN WHAT WAS BILLED HAS BEEN PAID');
  // Paying the computed figure used to close the order with Rs 400 still owed.
  await portal.saveReceipt({ invoiceId: 'IN-1', amount: 60000, receiptDate: '2026-10-12', mode: 'NEFT' });
  ok('paying the lines\' total leaves the order open, Rs 400 short',
    (await db.findRowById('SalesOrders', 'SO-1')).orderStatus === 'Invoiced');
  // The draft has to go before the order can be called done — it is still to be billed.
  await db.updateRowById('Invoices', 'id', 'IN-2', { status: 'Cancelled' });
  await portal.saveReceipt({ invoiceId: 'IN-1', amount: 400, receiptDate: '2026-10-13', mode: 'NEFT' });
  ok('paying the rest closes it', (await db.findRowById('SalesOrders', 'SO-1')).orderStatus === 'Closed',
    (await db.findRowById('SalesOrders', 'SO-1')).orderStatus);

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
