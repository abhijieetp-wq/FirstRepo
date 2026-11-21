/**
 * The desk (StreamAccess.gs, deskOf_ and setMyDesk): somebody who works both streams works
 * one at a time. On a desk they are, everywhere, what a coordinator of that stream alone is;
 * they flip desks themselves, and the choice is kept. Combined shows both at once. Changing
 * desk does not sign anybody out.
 *
 * People and customers are invented.
 *
 *   DATABASE_URL=postgres://... node tests/desk-sql-test.js
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
const refuses = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return re.test(String(e.message)) || String(e.message); }
};

const TENANT = 'desk-test';
const TABLES = ['users', 'audit_log', 'sessions', 'customers', 'customer_addresses', 'quotations', 'quotation_items', 'products', 'spares', 'price_list',
  'spare_enquiries', 'quote_templates', 'company_profile'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => { for (const t of TABLES) { try { await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]); } catch (e) { /* no table */ } } };
  await clean();
  await db.appendRow('Users', { id: 'U-ADMIN', username: 'office', email: 'office@pie.invalid', name: 'Office Admin', role: 'ERP Admin', businessStream: 'All', active: 'TRUE' });
  await db.appendRow('Users', { id: 'U-BOTH', username: 'meera', email: 'meera@pie.invalid', name: 'Meera Kulkarni', role: 'Sales Coordinator', businessStream: 'All', active: 'TRUE' });
  await db.appendRow('Users', { id: 'U-SP', username: 'ravi', email: 'ravi@pie.invalid', name: 'Ravi Shinde', role: 'Sales Coordinator', businessStream: 'Spare Sales', active: 'TRUE' });
  // Added before the stream was asked for: blank, which the ERP has always read as Spare Sales.
  await db.appendRow('Users', { id: 'U-BLANK', username: 'sana', email: 'sana@pie.invalid', name: 'Sana Pathan', role: 'Sales Coordinator', businessStream: '', active: 'TRUE' });
  await db.appendRow('Products', { id: 'PR-1', productCode: 'S900100', model: 'EG 37-7.5', series: 'EG', gstPct: 18, active: 'TRUE' });
  await db.appendRow('Spares', { id: 'SP-1', partNo: 'B900000001', description: 'Oil filter', gstPct: 18, active: 'TRUE' });
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Test Customer', active: 'TRUE' });
  await db.appendRow('CustomerAddresses', { id: 'AD-1', customerId: 'CU-1', addressType: 'Billing', line1: 'Plot 1', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: 'TRUE' });

  const p = loadPortal(db, 'office@pie.invalid', { quiet: true, properties: {} });
  const row = async (id) => (await db.q('SELECT * FROM users WHERE tenant_id = $1 AND id = $2', [TENANT, id])).rows[0];
  const asUser = async (id) => {
    const r = (await p.readTable_('Users')).find((u) => u.id === id);
    p.CURRENT_USER_ = await p.userFromRow_(r);
    return p.CURRENT_USER_;
  };

  console.log('WHO IS ON WHICH DESK');
  const admin = await asUser('U-ADMIN');
  ok('the admin starts with both', admin.businessStream === 'All' && admin.homeStream === 'All' && admin.desk === '', admin);
  const both = await asUser('U-BOTH');
  ok('a coordinator of both starts on the compressor desk', both.businessStream === 'Compressor Sales' && both.homeStream === 'All' && both.desk === 'Compressor Sales', both);
  const sp = await asUser('U-SP');
  ok('a coordinator of one stream has no desk', sp.businessStream === 'Spare Sales' && sp.homeStream === 'Spare Sales' && sp.desk === '', sp);

  // One quotation on each desk, raised by the admin.
  await asUser('U-ADMIN');
  await p.installMissingQuoteTemplates_('desk');
  const comp = await p.createBlankQuotation({ customerId: 'CU-1', businessStream: 'Compressor Sales' });
  // A spares one is raised from its enquiry: New quotation no longer starts one.
  const spare = await p.createQuotationFromEnquiry((await p.saveSpareEnquiry({ customerId: 'CU-1', source: 'Call', requirementText: 'Filters' })).id);
  const streams = async () => (await p.listQuotations({ includeClosed: true })).map((q) => q.businessStream).sort().join(',');
  ok('with both, both desks’ quotations', await streams() === 'Compressor Sales,Spare Sales');

  console.log('\nON A DESK');
  await asUser('U-BOTH');
  ok('on the compressor desk, compressor quotations alone', await streams() === 'Compressor Sales');
  let back = await p.setMyDesk('Spare Sales');
  ok('flipped to spares, they are on spares at once', back.businessStream === 'Spare Sales' && back.desk === 'Spare Sales' && back.homeStream === 'All', back);
  ok('and kept', (await row('U-BOTH')).desk === 'Spare Sales');
  ok('spares quotations alone', await streams() === 'Spare Sales');
  ok('a compressor quotation is the other desk’s, and they are told how to reach it',
    await refuses(() => p.getQuotation(comp.id), /belongs to Compressor Sales\. You are on the Spare Sales desk: switch desks/));
  ok('their own desk’s opens', (await p.getQuotation(spare.id)).id === spare.id);
  ok('read afresh, they are still on spares', (await asUser('U-BOTH')).businessStream === 'Spare Sales');
  ok('not a desk that is not one', await refuses(() => p.setMyDesk('Service'), /A desk is Compressor Sales or Spare Sales, or All for both combined\./));
  back = await p.setMyDesk('All');
  ok('combined: both desks’ work at once', back.businessStream === 'All' && back.desk === '' && back.homeStream === 'All' &&
    await streams() === 'Compressor Sales,Spare Sales', back);
  ok('kept as All, so they come back to combined', (await row('U-BOTH')).desk === 'All' && (await asUser('U-BOTH')).businessStream === 'All');
  ok('both quotations open', (await p.getQuotation(comp.id)).id === comp.id);
  back = await p.setMyDesk('Compressor Sales');
  ok('and back again', back.businessStream === 'Compressor Sales' && await streams() === 'Compressor Sales');

  console.log('\nMANAGEMENT AND THE ADMIN');
  await asUser('U-ADMIN');
  back = await p.setMyDesk('Spare Sales');
  ok('the admin can work one desk too', back.businessStream === 'Spare Sales' && await streams() === 'Spare Sales');
  back = await p.setMyDesk('All');
  ok('and go back to both', back.businessStream === 'All' && back.desk === '' && await streams() === 'Compressor Sales,Spare Sales');
  ok('kept as All', (await row('U-ADMIN')).desk === 'All');

  console.log('\nONE STREAM, NO DESK');
  await asUser('U-SP');
  ok('somebody who works one stream has none to choose', await refuses(() => p.setMyDesk('Compressor Sales'), /You work in Spare Sales alone/));
  ok('and nothing was written', !(await row('U-SP')).desk);

  console.log('\nTHROUGH A SESSION');
  const coord = (await p.readTable_('Users')).find((u) => u.id === 'U-BOTH');
  await p.storePassword_(coord, 'Desk-test-pass-91', false);
  p.CURRENT_USER_ = null;
  const signed = await p.login('meera', 'Desk-test-pass-91');
  ok('signed in on the desk they left', signed.user.businessStream === 'Compressor Sales' && signed.user.homeStream === 'All', signed.user);
  await p.call(signed.token, 'listQuotations', [{}]);
  p.CURRENT_USER_ = null;
  ok('an e-mail address at the sign-in box is told to use the username',
    await refuses(() => p.login('meera.old@example.com', 'Desk-test-pass-91'), /Sign in with your username, not an e-mail address/));
  ok('a wrong username is still just a mismatch', await refuses(() => p.login('nobody', 'x'), /That username and password do not match/));
  const flipped = await p.call(signed.token, 'setMyDesk', ['Spare Sales']);
  ok('changed through the door every click comes in by', flipped.businessStream === 'Spare Sales', flipped);
  const next = await p.userForToken_(signed.token);
  ok('the very next request is on the new desk, still signed in', !!next && next.businessStream === 'Spare Sales', next);
  const lists = await p.call(signed.token, 'listQuotations', [{ includeClosed: true }]);
  ok('and lists that desk’s work', lists.length === 1 && lists[0].businessStream === 'Spare Sales', lists.map((q) => q.businessStream));

  console.log('\nA COMPRESSOR IS NOT A LINE ON A SPARES QUOTATION');
  await asUser('U-ADMIN');
  const refusal = await refuses(() => p.saveQuotationItem({ quotationId: spare.id, itemType: 'Product', itemId: 'PR-1', qty: 1, unitPrice: 100 }),
    /is a spares quotation and prints as a spares offer, so a compressor cannot go on it\. .*\+ New quotation, Business stream Compressor Sales/);
  ok('refused one at a time, saying how to make the unit quotation', refusal === true, refusal);
  ok('and in a selection', await refuses(() => p.saveQuotationItems({ quotationId: spare.id,
    lines: [{ itemType: 'Spare', itemId: 'SP-1', qty: 1 }, { itemType: 'Product', itemId: 'PR-1', qty: 1 }] }), /prints as a spares offer/));
  ok('nothing went on it', (await p.getQuotation(spare.id)).items.length === 0);
  ok('a spare still goes on it', (await p.saveQuotationItem({ quotationId: spare.id, itemType: 'Spare', itemId: 'SP-1', qty: 1, unitPrice: 50 })).items
    .filter((i) => i.itemType === 'Spare').length === 1);
  const unit = await p.saveQuotationItems({ quotationId: comp.id, lines: [{ itemType: 'Product', itemId: 'PR-1', qty: 1, unitPrice: 100 }, { itemType: 'Spare', itemId: 'SP-1', qty: 1, unitPrice: 50 }] });
  ok('a compressor quotation takes the compressor and its spares', unit.items.length === 2);
  await asUser('U-BOTH');
  await p.setMyDesk('Spare Sales');
  ok('on the spares desk, told to switch desks', await refuses(() => p.saveQuotationItem({ quotationId: spare.id, itemType: 'Product', itemId: 'PR-1', qty: 1 }),
    /Switch to the Compressor desk at the top of the page/));
  await p.setMyDesk('Compressor Sales');
  await asUser('U-SP');
  ok('working spares alone, told who can change that', await refuses(() => p.saveQuotationItem({ quotationId: spare.id, itemType: 'Product', itemId: 'PR-1', qty: 1 }),
    /works Spare Sales only: the ERP admin can set it to All in Settings → Users/));

  console.log('\nNEW QUOTATION NEVER GUESSES SPARES');
  await asUser('U-ADMIN');
  ok('somebody who works both must say which', await refuses(() => p.createBlankQuotation({ customerId: 'CU-1' }), /Choose whether this is a Compressor Sales \(unit\) or a Spare Sales quotation/));
  await asUser('U-BOTH');
  ok('on a desk, it is the desk’s', (await p.createBlankQuotation({ customerId: 'CU-1' })).businessStream === 'Compressor Sales');
  await asUser('U-SP');
  ok('somebody on the spares desk alone is sent to an enquiry instead', await refuses(() => p.createBlankQuotation({ customerId: 'CU-1' }), /A spares quotation starts from an enquiry/));

  console.log('\nTHE USERS LIST SAYS WHAT THE ERP APPLIES');
  await asUser('U-ADMIN');
  const listed = (await p.getSettings()).users;
  const streamOf = (id) => (listed.find((u) => u.id === id) || {}).businessStream;
  ok('a blank stream is shown as the Spare Sales it works as, not All', streamOf('U-BLANK') === 'Spare Sales' &&
    (await asUser('U-BLANK')).businessStream === 'Spare Sales', streamOf('U-BLANK'));
  ok('both, and the admin, as All; one stream as itself', streamOf('U-BOTH') === 'All' && streamOf('U-ADMIN') === 'All' && streamOf('U-SP') === 'Spare Sales');

  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length ? failures.length + ' FAILED, ' : 'all ') + pass + ' passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
