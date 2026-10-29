/**
 * ERP 2.0's escalations, on the server: a board card escalated to a named person, who may
 * answer it and how, withdrawing, who sees what, the card carrying it, the dashboard tile, and
 * the two ERP 2 rules left out — nothing escalates by itself, and a decision changes no
 * quotation.
 *
 * Customers and people are invented.
 *
 *   DATABASE_URL=postgres://... node tests/escalations-sql-test.js
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

const TENANT = 'escalations-test';
const PRIYA = { email: 'priya@pie.in', name: 'Priya', role: 'Sales Coordinator', businessStream: 'Spare Sales' };
const KIRAN = { email: 'kiran@pie.in', name: 'Kiran', role: 'Sales Coordinator', businessStream: 'Spare Sales' };
const NEHA = { email: 'neha@pie.in', name: 'Neha', role: 'Sales Coordinator', businessStream: 'Compressor Sales' };
const ROHAN = { email: 'rohan@pie.in', name: 'Rohan', role: 'Sales Engineer', businessStream: 'All' };
const MONA = { email: 'mona@pie.in', name: 'Mona', role: 'Management', businessStream: 'All' };
const TEJ = { email: 'tej@pie.in', name: 'Tej', role: 'Service Engineer', businessStream: 'All' };
const SONA = { email: 'sona@pie.in', name: 'Sona', role: 'Service Coordinator', businessStream: 'All' };
const TABLES = ['users', 'customers', 'spare_enquiries', 'quotations', 'sales_orders', 'leads', 'opportunities',
  'escalations', 'audit_log'];
const SP = 'Spare Sales';
const CP = 'Compressor Sales';

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  for (const u of [PRIYA, KIRAN, NEHA, ROHAN, MONA, TEJ, SONA]) {
    await db.appendRow('Users', { id: 'U-' + u.name, email: u.email, name: u.name, role: u.role, businessStream: u.businessStream, active: 'TRUE' });
  }
  await db.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'Testwell Foods', active: 'TRUE' });
  const as = (who) => { const p = loadPortal(db, who.email, { quiet: true }); p.CURRENT_USER_ = who; return p; };
  const priya = as(PRIYA);
  const kiran = as(KIRAN);
  const neha = as(NEHA);
  const mona = as(MONA);
  const tej = as(TEJ);
  const today = priya.todayIso_();
  const day = (n) => priya.addDays_(today, n);
  const enquiry = (id, status, extra) => db.appendRow('SpareEnquiries', Object.assign({ id, enquiryNo: 'SE/' + id, date: day(-5),
    customerId: 'CU-1', customerName: 'Testwell Foods', requirementText: 'Filter kit', urgency: 'Normal', ownerEmail: PRIYA.email,
    status, businessStream: SP }, extra || {}));
  await enquiry('E1', 'Quoted');
  await db.appendRow('Quotations', { id: 'Q1', quoteNo: 'Q/1', revision: 'R0', date: day(-4), businessStream: SP, customerId: 'CU-1',
    preparedBy: PRIYA.email, status: 'Negotiating', submittedDate: day(-3), grand: 96000, spareEnquiryId: 'E1' });
  await enquiry('E2', 'New');
  await enquiry('E3', 'Lost');
  await db.appendRow('Leads', { id: 'L1', leadNo: 'LD/1', date: day(-3), customerId: 'CU-1', requirementSummary: '22 kW screw',
    ownerEmail: NEHA.email, status: 'Qualified', businessStream: CP });

  console.log('ESCALATING A DEAL');
  const board = await priya.getEnquiryBoard({ stream: SP });
  ok('the board says who a deal can go to: Management first, then coordinators, never yourself',
    board.escalateTo.map((p) => p.name).join() === 'Mona,Kiran,Neha', board.escalateTo);
  const e1 = await priya.escalateCard({ ref: 'SE:E1', toEmail: 'MONA@pie.in', note: 'Customer wants 5% more off. Can we give 4%?' });
  ok('sent to the person named, with what needs deciding', e1.status === 'Open' && e1.toName === 'Mona' && e1.raisedByName === 'Priya' &&
    e1.note === 'Customer wants 5% more off. Can we give 4%?' && e1.raisedDay === today && e1.waitingDays === 0, e1);
  ok('about the card: its number, desk, customer, owner and value', e1.label === 'SE/E1' && e1.kind === 'enquiry' && e1.recordId === 'E1' &&
    e1.desk === 'Spares' && e1.customerName === 'Testwell Foods' && e1.ownerName === 'Priya' && e1.value === 96000, e1);
  ok('one at a time on a card', await refused(() => kiran.escalateCard({ ref: 'SE:E1', toEmail: MONA.email, note: 'Me too please' }), /already with Mona/));
  ok('it needs saying what', await refused(() => priya.escalateCard({ ref: 'SE:E2', toEmail: MONA.email, note: 'ok' }), /what needs deciding/));
  ok('to somebody else', await refused(() => priya.escalateCard({ ref: 'SE:E2', toEmail: PRIYA.email, note: 'Please decide this' }), /somebody else/));
  ok('a coordinator or Management, not service', await refused(() => priya.escalateCard({ ref: 'SE:E2', toEmail: SONA.email, note: 'Please decide this' }), /Sales Coordinator or somebody in Management/));
  ok('not a closed deal', await refused(() => priya.escalateCard({ ref: 'SE:E3', toEmail: MONA.email, note: 'Please decide this' }), /closed/));
  ok('only a card on a desk you work', await refused(() => priya.escalateCard({ ref: 'LD:L1', toEmail: MONA.email, note: 'Please decide this' }), /no longer on the board/));
  ok('service does not escalate deals', await refused(() => tej.escalateCard({ ref: 'SE:E2', toEmail: MONA.email, note: 'Please decide this' }), /sales work/));
  const e2 = await priya.escalateCard({ ref: 'SE:E2', toEmail: KIRAN.email, note: 'Do we stock the separator for this one?' });
  const l1 = await neha.escalateCard({ ref: 'LD:L1', toEmail: MONA.email, note: 'Customer asks 60 days credit' });
  ok('a compressor lead too', l1.desk === 'Compressor' && l1.label === 'LD/1');

  console.log('\nON THE BOARD');
  const b2 = await priya.getEnquiryBoard({ stream: SP });
  const card = (b, ref) => b.cards.find((c) => c.ref === ref);
  ok('the card carries the one waiting', card(b2, 'SE:E1').escalation && card(b2, 'SE:E1').escalation.id === e1.id &&
    card(b2, 'SE:E2').escalation.toName === 'Kiran' && !card(b2, 'SE:E3').escalation);

  console.log('\nWHO SEES WHAT');
  let list = await mona.getEscalations();
  ok('Management sees every one waiting, oldest first', list.open.length === 3 && list.kpis.waiting === 3 && list.kpis.spares === 2 &&
    list.kpis.compressor === 1 && list.boss === true);
  list = await kiran.getEscalations();
  ok('a coordinator, the ones sent to them', list.open.map((e) => e.id).join() === e2.id && list.kpis.toMe === 1);
  list = await neha.getEscalations();
  ok('and the ones they raised, on their own desk only', list.open.map((e) => e.id).join() === l1.id);
  ok('service sees none', await refused(() => tej.getEscalations(), /sales work/));

  console.log('\nANSWERING');
  ok('a coordinator it was sent to replies; they do not decide', (await kiran.getEscalations()).open[0].outcomes.join() === 'Replied' &&
    await refused(() => kiran.decideEscalation(e2.id, 'Approved', 'Yes'), /reply/));
  ok('somebody else cannot answer it', await refused(() => priya.decideEscalation(e1.id, 'Approved', 'Fine by me'), /Only Mona or Management/));
  ok('Management decides', (await mona.getEscalations()).open.find((e) => e.id === e1.id).outcomes.join() === 'Sent back,Approved,Won,Lost');
  ok('an answer needs words', await refused(() => mona.decideEscalation(e1.id, 'Approved', ''), /decision or instruction/));
  ok('and a real outcome', await refused(() => mona.decideEscalation(e1.id, 'Maybe', 'Hmm'), /Sent back, Approved, Won or Lost/));
  const d1 = await mona.decideEscalation(e1.id, 'Approved', 'Give 4%, close at 92,000');
  ok('decided, with the instruction', d1.status === 'Decided' && d1.outcome === 'Approved' && d1.decisionNote === 'Give 4%, close at 92,000' &&
    d1.decidedByName === 'Mona' && d1.decidedDay === today && !d1.outcomes.length && !d1.canWithdraw, d1);
  ok('once', await refused(() => mona.decideEscalation(e1.id, 'Lost', 'Changed my mind'), /already been answered/));
  const r2 = await kiran.decideEscalation(e2.id, 'Replied', 'Yes, two in stock');
  ok('the reply goes back', r2.outcome === 'Replied' && r2.status === 'Decided');
  const w = await mona.decideEscalation(l1.id, 'Won', 'Agree 60 days, take the order');
  ok('“Won” is the word to the coordinator', w.outcome === 'Won');
  const q1 = (await db.q("SELECT status FROM quotations WHERE tenant_id=$1 AND id='Q1'", [TENANT])).rows[0];
  const lead = (await db.q("SELECT status FROM leads WHERE tenant_id=$1 AND id='L1'", [TENANT])).rows[0];
  ok('and a decision changes no quotation and no lead', q1.status === 'Negotiating' && lead.status === 'Qualified', [q1, lead]);
  list = await priya.getEscalations();
  ok('what was decided lately, newest first', list.recent.map((e) => e.id).join() === [r2.id, d1.id].join() && list.kpis.decidedThisMonth === 2);
  const b3 = await priya.getEnquiryBoard({ stream: SP });
  ok('and the card keeps the history', !card(b3, 'SE:E1').escalation && card(b3, 'SE:E1').escalations.length === 1 &&
    card(b3, 'SE:E1').escalations[0].outcome === 'Approved');

  console.log('\nWITHDRAWING');
  const e3 = await priya.escalateCard({ ref: 'SE:E1', toEmail: MONA.email, note: 'Customer came back for 2% more' });
  ok('a card can go up again once answered', e3.status === 'Open');
  ok('only whoever raised it, or Management', await refused(() => kiran.withdrawEscalation(e3.id), /no longer there|Only whoever/));
  const wd = await priya.withdrawEscalation(e3.id);
  ok('withdrawn', wd.status === 'Withdrawn' && wd.outcome === 'Withdrawn' && !wd.outcomes.length);
  ok('and cannot then be answered', await refused(() => mona.decideEscalation(e3.id, 'Approved', 'Ok'), /withdrawn/));

  console.log('\nNOTHING ESCALATES BY ITSELF');
  await db.appendRow('Quotations', { id: 'Q2', quoteNo: 'Q/2', revision: 'R0', date: day(-2), businessStream: SP, customerId: 'CU-1',
    preparedBy: PRIYA.email, status: 'Submitted', submittedDate: day(-1), grand: 5000, spareEnquiryId: 'E2' });
  await priya.moveBoardCard({ ref: 'SE:E2', to: 'negotiation', note: 'Wants 5% off' });
  ok('moving a deal to negotiation raises no escalation',
    (await db.q("SELECT count(*)::int AS n FROM escalations WHERE tenant_id=$1 AND card_ref='SE:E2' AND status='Open'", [TENANT])).rows[0].n === 0);

  console.log('\nON THE DASHBOARD');
  await priya.escalateCard({ ref: 'SE:E1', toEmail: KIRAN.email, note: 'Can you cover this customer tomorrow?' });
  const tile = (d) => d.tiles.find((t) => t.key === 'escalations');
  const kd = tile(await kiran.getPersonDashboard({}));
  ok('escalated to a coordinator', kd && kd.label === 'Escalated to you' && kd.value === '1' && kd.go === 'escalations', kd);
  const pd = tile(await priya.getPersonDashboard({}));
  ok('and theirs waiting on somebody', pd && pd.value === '0' && /^1 of yours waiting/.test(pd.sub), pd);
  await neha.escalateCard({ ref: 'LD:L1', toEmail: MONA.email, note: 'Second question on the same lead' });
  await db.q("UPDATE escalations SET created_at = now() - interval '5 days' WHERE tenant_id=$1 AND status='Open' AND card_ref='LD:L1'", [TENANT]);
  const md = tile(await mona.getPersonDashboard({}));
  ok('Management: everything waiting, and what has waited long', md && md.label === 'Waiting for a decision' && md.value === '2' &&
    md.sub === '1 waiting over 3 days' && md.tone === 'warn', md);
  ok('nothing for somebody with nothing waiting', !tile(await as(ROHAN).getPersonDashboard({})));

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
