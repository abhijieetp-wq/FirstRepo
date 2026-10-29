/**
 * ERP 2.0's enquiry drawer, on the server: the card's flag, contact and town; the drawer's
 * lists (flags, owners, lost reasons); the next follow-up, flag and owner set from the drawer,
 * each written to ERP 1's own record; follow-ups kept in Activities and counted on the card;
 * marking a card lost with a reason; and who may do which.
 *
 * Customers and people are invented.
 *
 *   DATABASE_URL=postgres://... node tests/board-drawer-sql-test.js
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

const TENANT = 'board-drawer-test';
const ANIL = { email: 'anil@pie.in', name: 'Anil Rao', role: 'Management', businessStream: 'All' };
const KIRAN = { email: 'kiran@pie.in', name: 'Kiran Patil', role: 'Sales Coordinator', businessStream: 'Spare Sales' };
const PRIYA = { email: 'priya@pie.in', name: 'Priya Deshmukh', role: 'Sales Coordinator', businessStream: 'Compressor Sales' };
const OMKAR = { email: 'omkar@pie.in', name: 'Omkar Joshi', role: 'Sales Engineer', businessStream: 'Compressor Sales' };
const TEJ = { email: 'tej@pie.in', name: 'Tej Pawar', role: 'Service Engineer', businessStream: 'All' };
const TABLES = ['users', 'customers', 'customer_addresses', 'spare_enquiries', 'leads', 'opportunities', 'quotations', 'activities', 'lost_reasons',
  'config_lists', 'audit_log'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => { for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]); };
  await clean();
  for (const u of [ANIL, KIRAN, PRIYA, OMKAR, TEJ]) {
    await db.appendRow('Users', { id: 'U-' + u.email, email: u.email, name: u.name, role: u.role, businessStream: u.businessStream, active: 'TRUE' });
  }
  for (const r of [['LR-1', 'Price too high', 'All'], ['LR-2', 'Part not available in time', 'Spare'], ['LR-3', 'Competitor selected', 'All']]) {
    await db.appendRow('LostReasons', { id: r[0], reasonText: r[1], appliesTo: r[2], active: 'TRUE' });
  }
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Sahyadri Castings', active: 'TRUE' });
  await db.appendRow('CustomerAddresses', { id: 'AD-1', customerId: 'CU-1', city: 'Butibori', isDefault: 'TRUE', active: 'TRUE' });
  await db.appendRow('SpareEnquiries', { id: 'E1', enquiryNo: 'SE/1', date: '2026-10-17', customerId: 'CU-1', status: 'New', ownerEmail: KIRAN.email,
    contactName: 'R. Joshi', contactPhone: '98220 41187', productModel: 'EG 37', serialNo: 'EG37-21874', requirementText: 'Separator and filters',
    expectedDeliveryDate: '2026-11-10', businessStream: 'Spare Sales' });
  await db.appendRow('Leads', { id: 'L1', leadNo: 'LD/1', date: '2026-10-23', customerName: 'Kolhapur Forgings', prospectCity: 'Kolhapur', status: 'New',
    contactName: 'V. Kore', contactPhone: '98901 55620', requirementSummary: '150 cfm at 7.5 bar', nextActionDate: '2026-10-29', ownerEmail: PRIYA.email,
    businessStream: 'Compressor Sales' });
  const as = (who) => { const p = loadPortal(db, who.email, { quiet: true }); p.CURRENT_USER_ = who; return p; };
  const anil = as(ANIL); const kiran = as(KIRAN); const priya = as(PRIYA); const omkar = as(OMKAR); const tej = as(TEJ);
  const today = anil.todayIso_();
  const day = (n) => anil.addDays_(today, n);
  const card = async (p, stream, ref) => (await p.getEnquiryBoard({ stream })).cards.find((c) => c.ref === ref);

  console.log('THE CARD AND THE DRAWER’S LISTS');
  let b = await kiran.getEnquiryBoard({ stream: 'Spare Sales' });
  let e1 = b.cards.find((c) => c.ref === 'SE:E1');
  ok('who to ring and the town', e1.contactName === 'R. Joshi' && e1.contactPhone === '98220 41187' && e1.place === 'Butibori', e1);
  ok('no flag yet, and the date the parts are expected', e1.flag === '' && e1.followUp === '2026-11-10' && e1.followUpLabel === 'Expected' && e1.logCount === 0);
  ok('the flags', b.flags.join() === 'Hot,Warm,Cold,Price issue,Competitor in play,Budget pending');
  ok('the spares desk’s owners: its coordinators and Management', b.owners.map((p) => p.email).join() === 'anil@pie.in,kiran@pie.in', b.owners);
  ok('its lost reasons, the spares one included', b.lostReasons.map((r) => r.id).join() === 'LR-1,LR-2,LR-3' && b.canOwner === true);
  let bc = await priya.getEnquiryBoard({ stream: 'Compressor Sales' });
  ok('the compressor desk’s: no spares reason', bc.lostReasons.map((r) => r.id).join() === 'LR-1,LR-3' &&
    bc.owners.map((p) => p.email).join() === 'anil@pie.in,omkar@pie.in,priya@pie.in', bc);
  const l1 = bc.cards.find((c) => c.ref === 'LD:L1');
  ok('a lead’s town from where the prospect is', l1.place === 'Kolhapur' && l1.contactName === 'V. Kore');

  console.log('\nTHE DROPDOWNS');
  e1 = await kiran.setBoardCardDetail({ ref: 'SE:E1', field: 'followUp', value: day(1) });
  ok('a spare enquiry’s next follow-up', e1.followUp === day(1) && e1.followUpLabel === 'Next follow-up', e1);
  let row = (await db.q('SELECT * FROM spare_enquiries WHERE tenant_id=$1 AND id=$2', [TENANT, 'E1'])).rows[0];
  ok('kept apart from when the parts are expected', String(row.next_follow_up_date).length > 0 && row.expected_delivery_date !== null);
  e1 = await kiran.setBoardCardDetail({ ref: 'SE:E1', field: 'flag', value: 'Hot' });
  ok('the flag', e1.flag === 'Hot');
  ok('only a flag from the list', await refused(() => kiran.setBoardCardDetail({ ref: 'SE:E1', field: 'flag', value: 'Lukewarm' }), /from the list/));
  e1 = await kiran.setBoardCardDetail({ ref: 'SE:E1', field: 'owner', value: 'anil@pie.in' });
  ok('the owner, on the enquiry itself', e1.ownerEmail === 'anil@pie.in' &&
    (await db.q('SELECT owner_email FROM spare_enquiries WHERE tenant_id=$1 AND id=$2', [TENANT, 'E1'])).rows[0].owner_email === 'anil@pie.in');
  ok('only somebody on the desk', await refused(() => kiran.setBoardCardDetail({ ref: 'SE:E1', field: 'owner', value: 'priya@pie.in' }), /from the list/));
  let lc = await priya.setBoardCardDetail({ ref: 'LD:L1', field: 'followUp', value: day(3) });
  ok('a lead’s next action, ERP 1’s own date', lc.followUp === day(3) &&
    String((await db.q('SELECT next_action_date FROM leads WHERE tenant_id=$1 AND id=$2', [TENANT, 'L1'])).rows[0].next_action_date).length > 0);
  ok('which an open lead cannot lose', await refused(() => priya.setBoardCardDetail({ ref: 'LD:L1', field: 'followUp', value: '' }), /must always have/));
  ok('a sales engineer flags, but does not hand a lead on', (await omkar.setBoardCardDetail({ ref: 'LD:L1', field: 'flag', value: 'Warm' })).flag === 'Warm' &&
    await refused(() => omkar.setBoardCardDetail({ ref: 'LD:L1', field: 'owner', value: 'omkar@pie.in' }), /permission/));
  ok('nobody from the other desk', await refused(() => kiran.setBoardCardDetail({ ref: 'LD:L1', field: 'flag', value: 'Hot' }), /Compressor Sales/));
  ok('nor service', await refused(() => tej.setBoardCardDetail({ ref: 'SE:E1', field: 'flag', value: 'Hot' }), /commercial|service|Spare enquiries|enquiry board/i));
  ok('every change in the audit trail', Number((await db.q("SELECT count(*) FROM audit_log WHERE tenant_id=$1 AND reason LIKE 'Board:%'", [TENANT])).rows[0].count) >= 5);

  console.log('\nFOLLOW-UPS');
  ok('words needed', await refused(() => kiran.addBoardFollowUp({ ref: 'SE:E1', text: ' ' }), /what happened/));
  let r = await kiran.addBoardFollowUp({ ref: 'SE:E1', mode: 'WhatsApp', text: 'Sent the separator photo; customer checking with plant', nextDate: day(2) });
  ok('kept, and the next date taken', r.card.followUp === day(2) && r.card.logCount === 1 && r.log.length === 1 && r.log[0].mode === 'WhatsApp' &&
    r.log[0].by === 'Kiran Patil' && r.log[0].next === day(2), r);
  const act = (await db.q('SELECT related_type, related_id, activity_type FROM activities WHERE tenant_id=$1', [TENANT])).rows[0];
  ok('in Activities, against the enquiry', act.related_type === 'SpareEnquiry' && act.related_id === 'E1' && act.activity_type === 'WhatsApp');
  await priya.addBoardFollowUp({ ref: 'LD:L1', mode: 'Visit', text: 'Saw the forging shop; 2 × 75 kW', nextDate: '' });
  ok('a lead’s where ERP 1 lists them', (await priya.listActivities('Lead', 'L1')).length === 1 && (await card(priya, 'Compressor Sales', 'LD:L1')).followUp === day(3));
  ok('read back, newest first', (await anil.getBoardCardLog('SE:E1'))[0].text.indexOf('Sent the separator') === 0);

  console.log('\nMARKING LOST');
  ok('a reason needed', await refused(() => kiran.markBoardCardLost({ ref: 'SE:E1', reasonId: '' }), /why it was lost/));
  ok('from this desk’s list', await refused(() => priya.markBoardCardLost({ ref: 'LD:L1', reasonId: 'LR-2' }), /why it was lost/));
  e1 = await kiran.markBoardCardLost({ ref: 'SE:E1', reasonId: 'LR-2', note: 'Customer bought locally' });
  row = (await db.q('SELECT status, lost_reason_id FROM spare_enquiries WHERE tenant_id=$1 AND id=$2', [TENANT, 'E1'])).rows[0];
  ok('an enquiry Lost, with the reason, on the board as lost', row.status === 'Lost' && row.lost_reason_id === 'LR-2' && e1.stage === 'lost' &&
    /Part not available in time/.test(e1.closedWhy), [row, e1 && e1.closedWhy]);
  ok('and said in its follow-ups', (await kiran.getBoardCardLog('SE:E1'))[0].text === 'Marked lost: Part not available in time — Customer bought locally');
  lc = await priya.markBoardCardLost({ ref: 'LD:L1', reasonId: 'LR-3' });
  ok('a lead Disqualified', lc.stage === 'lost' && (await db.q('SELECT status FROM leads WHERE tenant_id=$1 AND id=$2', [TENANT, 'L1'])).rows[0].status === 'Disqualified');

  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + e.message); console.log(e.stack.split('\n').slice(1, 8).join('\n')); process.exit(1); });
