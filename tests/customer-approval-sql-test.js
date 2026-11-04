/**
 * New customers, approved by one person (CustomerApproval.gs), against a real Postgres.
 *
 *   - a customer added by anybody but the approver is saved, usable, and waits;
 *   - the approver gets ONE e-mail per save, and ONE for a whole bulk upload listing every
 *     customer it added, with a link to that batch;
 *   - only the approver decides; Management see the list as a notice; others see nothing;
 *   - approving stamps who and when; rejecting deactivates and tells whoever added it on their
 *     dashboard (not by e-mail: staff have no mailboxes) until they dismiss it; a decided customer
 *     is not decided twice;
 *   - an approver whose ERP ID is not a mailbox gets the e-mail only at an inbox given for it;
 *   - a mailbox that fails never fails the save;
 *   - with nobody chosen (or the chosen one gone), Management decide.
 *
 * People and customers are invented.
 *
 *   DATABASE_URL=postgres://... node tests/customer-approval-sql-test.js
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
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 600) : ''));
};
const refuses = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return re.test(String(e.message)); }
};

const TENANT = 'customer-approval-test';
const MEERA = { email: 'meera@pie.in', name: 'Meera Joshi', role: 'Management', businessStream: 'All' };
const ANIL = { email: 'anil@pie.in', name: 'Anil Rao', role: 'ERP Admin', businessStream: 'All' };
const KIRAN = { email: 'kiran@pie.in', name: 'Kiran Patil', role: 'Sales Coordinator', businessStream: 'Spare Sales' };
const TABLES = ['users', 'customers', 'customer_addresses', 'customer_contacts', 'audit_log'];
const BASE = 'https://erp.example.com';

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  for (const u of [MEERA, ANIL, KIRAN]) {
    await db.appendRow('Users', { id: 'U-' + u.name.split(' ')[0], email: u.email, name: u.name, role: u.role,
      businessStream: u.businessStream, active: 'TRUE' });
  }

  const properties = {};
  let sent = [];
  let failMail = false;
  const mail = { sendEmail: (m) => { if (failMail) throw new Error('This server cannot send e-mail yet: no mailbox is connected.'); sent.push(m); return true; } };
  const as = (who) => {
    const p = loadPortal(db, who.email, { quiet: true, properties, mail, baseUrl: BASE });
    p.CURRENT_USER_ = who;
    return p;
  };
  const row = async (id) => (await db.q('SELECT * FROM customers WHERE tenant_id = $1 AND id = $2', [TENANT, id])).rows[0];
  const meera = as(MEERA);
  const anil = as(ANIL);
  const kiran = as(KIRAN);

  console.log('WITH NOBODY CHOSEN, MANAGEMENT DECIDE');
  const first = await kiran.saveCustomer({ name: 'Sahyadri Castings', gstin: '27AAACS1234A1Z5' });
  ok('a coordinator’s new customer is saved and waits', first.id && (await row(first.id)).approval_status === 'Pending', await row(first.id));
  ok('and is usable meanwhile: active, in the customer list', (await row(first.id)).active === true &&
    (await kiran.listCustomers()).some((c) => c.id === first.id && c.approvalStatus === 'Pending'));
  ok('nobody to e-mail, and the save says why', sent.length === 0 && first.approval && /No approver is chosen/.test(first.approval.reason), first.approval);
  const anilSees = await anil.listCustomerApprovals();
  ok('Management may decide', anilSees.visible && anilSees.canDecide && anilSees.approver === null && anilSees.count === 1, anilSees);
  ok('the coordinator sees no list', (await kiran.listCustomerApprovals()).visible === false);

  console.log('\nCHOOSING THE APPROVER');
  ok('only Settings’ roles choose', await refuses(() => kiran.saveCustomerApprover({ email: MEERA.email }), /./));
  ok('somebody who is not in Users is refused', await refuses(() => anil.saveCustomerApprover({ email: 'nobody@pie.in' }), /nobody with that address/));
  ok('a mailbox that is not one is refused', await refuses(() => anil.saveCustomerApprover({ email: MEERA.email, mailTo: 'meera at home' }), /does not look like an e-mail/));
  const chosen = await anil.saveCustomerApprover({ email: 'MEERA@pie.in', mailTo: 'meera.ops@example.com' });
  ok('chosen, as Users spells the address, with where the mail goes', chosen.approver === MEERA.email && chosen.mailTo === 'meera.ops@example.com', chosen);
  ok('Settings shows it', (await anil.getSettings()).customerApproval.approver === MEERA.email);

  console.log('\nONE CUSTOMER, ONE E-MAIL, TO THE APPROVER ALONE');
  sent = [];
  const deccan = await kiran.saveCustomerWithDetails({ customer: { name: 'Deccan Polymers', industry: 'Plastics' },
    address: { line1: 'Plot 14, MIDC', city: 'Chakan', state: 'Maharashtra' } });
  ok('it waits', (await row(deccan.id)).approval_status === 'Pending' && (await row(deccan.id)).approval_batch === deccan.id);
  ok('one e-mail, to where the approver reads it', sent.length === 1 && sent[0].to === 'meera.ops@example.com', sent.map((m) => m.to));
  const m1 = sent[0] || {};
  ok('the subject names the customer and its code', m1.subject === 'New customer to approve: Deccan Polymers (' + deccan.customerCode + ')', m1.subject);
  ok('the body: who added it, the customer and where they are, and the link to it', /^Dear Meera Joshi,/.test(m1.body) &&
    /Kiran Patil added a new customer/.test(m1.body) && /Deccan Polymers {2}· {2}no GSTIN {2}· {2}Chakan/.test(m1.body) &&
    m1.body.indexOf(BASE + '/customers?approve=' + deccan.id) !== -1, m1.body);
  ok('and the same as HTML, with a button to it', /<b>Deccan Polymers<\/b>/.test(m1.htmlBody) &&
    m1.htmlBody.indexOf('href="' + BASE + '/customers?approve=' + deccan.id + '"') !== -1 && /Approve or reject<\/a>/.test(m1.htmlBody));
  ok('the save says where it went', deccan.approval && deccan.approval.emailed === 'meera.ops@example.com', deccan.approval);

  console.log('\nWHO DECIDES NOW');
  const anilNow = await anil.listCustomerApprovals();
  ok('Management are told, and no longer decide', anilNow.visible && !anilNow.canDecide && anilNow.approver.name === 'Meera Joshi' && anilNow.count === 2, anilNow);
  ok('and are refused if they try', await refuses(() => anil.decideCustomers({ ids: [deccan.id], outcome: 'Approved' }), /approved by Meera Joshi/));
  ok('so is the coordinator', await refuses(() => kiran.decideCustomers({ ids: [deccan.id], outcome: 'Approved' }), /approved by Meera Joshi/));
  const meeraSees = await meera.listCustomerApprovals();
  const dp = meeraSees.waiting.find((r) => r.name === 'Deccan Polymers') || {};
  ok('the approver decides: both waiting, with where they are and who added them', meeraSees.canDecide && meeraSees.count === 2 &&
    dp.place === 'Chakan' && dp.createdByName === 'Kiran Patil' && dp.customerCode === deccan.customerCode, meeraSees);

  console.log('\nA BULK UPLOAD: ONE E-MAIL LISTING THEM ALL');
  sent = [];
  const csv = 'name,gstin,creditLimit,creditDays,paymentTerms,industry,territory,pan,notes\n' +
    'Godavari Textile Mills,27AAACG1111B1Z2,,,,Textiles,Nashik,,\n' +
    'Tapi Engineering Works,,,,,Engineering,Jalgaon,,\n' +
    'Konkan Agro Foods,27AAACK2222C1Z3,,,,Food,Ratnagiri,,\n';
  const up = await anil.commitTallyImport('Customer', csv);
  ok('three created', up.created === 3, up);
  ok('ONE e-mail for the three', sent.length === 1 && sent[0].to === 'meera.ops@example.com', sent.length);
  const m2 = sent[0] || {};
  ok('the subject counts them', m2.subject === '3 new customers to approve, from a bulk upload', m2.subject);
  ok('the body lists every one, numbered', /1\. .*Godavari Textile Mills/.test(m2.body) && /2\. .*Tapi Engineering Works .*no GSTIN/.test(m2.body) &&
    /3\. .*Konkan Agro Foods/.test(m2.body) && /Tick the ones to approve or reject here/.test(m2.body), m2.body);
  const ups = (await db.q("SELECT id, approval_status, approval_batch FROM customers WHERE tenant_id = $1 AND name IN ('Godavari Textile Mills','Tapi Engineering Works','Konkan Agro Foods')", [TENANT])).rows;
  const batch = ups[0] && ups[0].approval_batch;
  ok('all three wait, as one batch', ups.length === 3 && ups.every((r) => r.approval_status === 'Pending' && r.approval_batch === batch) && /^CUB-/.test(batch), ups);
  ok('the link opens that batch', m2.body.indexOf(BASE + '/customers?approve=' + batch) !== -1 && /Tick whom to approve or reject<\/a>/.test(m2.htmlBody));
  // To look at the e-mail: CA_MAIL_OUT=/some/dir writes the bulk one there as HTML.
  if (process.env.CA_MAIL_OUT) require('fs').writeFileSync(path.join(process.env.CA_MAIL_OUT, 'bulk-mail.html'), m2.htmlBody);
  ok('and the upload says the e-mail went', up.approval && up.approval.emailed === 'meera.ops@example.com', up.approval);
  const inBatch = await meera.listCustomerApprovals({ batch });
  ok('the approver’s list knows the batch: 3 of the 5 waiting', inBatch.batch.count === 3 && inBatch.count === 5, inBatch.batch);
  sent = [];
  await anil.commitTallyImport('Customer', 'name,gstin,creditLimit,creditDays,paymentTerms,industry,territory,pan,notes\nGodavari Textile Mills,27AAACG1111B1Z2,,30,,Textiles,Nashik,,\n');
  ok('an upload that only updates sends nothing', sent.length === 0);

  console.log('\nTHE APPROVER PICKS');
  const [g, t, k] = ['Godavari Textile Mills', 'Tapi Engineering Works', 'Konkan Agro Foods'].map((n) => inBatch.waiting.find((r) => r.name === n).id);
  ok('nothing ticked is refused', await refuses(() => meera.decideCustomers({ ids: [], outcome: 'Approved' }), /Tick at least one/));
  ok('an outcome that is neither is refused', await refuses(() => meera.decideCustomers({ ids: [g], outcome: 'Maybe' }), /Approve or reject/));
  const yes = await meera.decideCustomers({ ids: [g, k], outcome: 'Approved', batch });
  ok('two approved', yes.decided === 2 && yes.skipped === 0 && yes.count === 3 && yes.batch.count === 1, yes);
  const gr = await row(g);
  ok('stamped with who and when', gr.approval_status === 'Approved' && gr.approved_by === MEERA.email && !!gr.approved_at && gr.active === true, gr);
  sent = [];
  const no = await meera.decideCustomers({ ids: [t], outcome: 'Rejected', note: 'Duplicate of an existing account' });
  ok('one rejected', no.decided === 1 && no.count === 2, no);
  ok('nobody is e-mailed about it: staff have no mailboxes', sent.length === 0);
  ok('the decision says who will see it on their dashboard', JSON.stringify(no.creators) === '["Anil Rao"]', no.creators);
  const told = (await anil.getPersonDashboard({})).rejectedCustomers || [];
  ok('whoever added it sees it on their dashboard: who rejected it, when, and why', told.length === 1 && told[0].id === t &&
    told[0].name === 'Tapi Engineering Works' && told[0].by === 'Meera Joshi' && /^\d{4}-\d\d-\d\d$/.test(told[0].at) &&
    told[0].note === 'Duplicate of an existing account', told);
  ok('nobody else does', !(await kiran.getPersonDashboard({})).rejectedCustomers && !(await meera.getPersonDashboard({})).rejectedCustomers);
  const tr = await row(t);
  ok('a rejected customer is deactivated, with the reason', tr.approval_status === 'Rejected' && tr.active === false &&
    tr.approval_note === 'Duplicate of an existing account', tr);
  ok('and drops out of the customer list', !(await kiran.listCustomers()).some((c) => c.id === t));
  const again = await meera.decideCustomers({ ids: [g, t], outcome: 'Rejected' });
  ok('a customer already decided is not decided again', again.decided === 0 && again.skipped === 2 && (await row(g)).approval_status === 'Approved');
  ok('somebody else cannot dismiss it', (await kiran.dismissRejectedCustomers([t])).length === 0 &&
    ((await anil.getPersonDashboard({})).rejectedCustomers || []).length === 1);
  ok('Dismiss takes it off their dashboard', (await anil.dismissRejectedCustomers([t])).length === 0 &&
    !(await anil.getPersonDashboard({})).rejectedCustomers && !!(await row(t)).rejection_seen_at);
  ok('and the customer stays rejected', (await row(t)).approval_status === 'Rejected' && (await row(t)).active === false);
  const trail = (await db.q("SELECT reason FROM audit_log WHERE tenant_id = $1 AND table_name = 'Customers' AND record_id = $2", [TENANT, t])).rows.map((r) => r.reason);
  ok('the decision is in the audit trail', trail.some((r) => /New customer rejected by meera@pie\.in: Duplicate/.test(r)), trail);

  console.log('\nTHE APPROVER’S OWN, AND A MAILBOX THAT FAILS');
  sent = [];
  const own = await meera.saveCustomer({ name: 'Bhima Sugar Industries' });
  ok('the approver’s own addition needs no second look', (await row(own.id)).approval_status === 'Approved' &&
    (await row(own.id)).approved_by === MEERA.email && sent.length === 0);
  failMail = true;
  const lost = await kiran.saveCustomer({ name: 'Warna Dairy Cooperative' });
  failMail = false;
  ok('no mailbox: the customer is saved all the same, and waits', (await row(lost.id)).approval_status === 'Pending');
  ok('and the save says the e-mail did not go, and why', lost.approval && lost.approval.emailed === '' && /no mailbox is connected/.test(lost.approval.reason), lost.approval);
  const notified = (await db.q("SELECT reason FROM audit_log WHERE tenant_id = $1 AND action = 'Notify'", [TENANT])).rows;
  ok('which the audit trail keeps', notified.some((r) => /Approval e-mail not sent/.test(r.reason)), notified);
  ok('editing a waiting customer leaves it waiting', (await kiran.saveCustomer({ id: lost.id, name: 'Warna Dairy Co-operative' })) &&
    (await row(lost.id)).approval_status === 'Pending' && sent.length === 0);
  ok('and an edit cannot approve it', (await kiran.saveCustomer({ id: lost.id, name: 'Warna Dairy Co-operative', approvalStatus: 'Approved' })) &&
    (await row(lost.id)).approval_status === 'Pending');

  console.log('\nON THE DASHBOARD');
  const dm = await meera.getPersonDashboard({});
  ok('the approver’s desk: the waiting customers, to decide', dm.approvals && dm.approvals.canDecide && dm.approvals.count === 3, dm.approvals);
  const da = await anil.getPersonDashboard({});
  ok('another admin’s: the same, as a notice', da.approvals && !da.approvals.canDecide && da.approvals.count === 3 && da.approvals.approver.name === 'Meera Joshi');
  ok('a coordinator’s: none', !(await kiran.getPersonDashboard({})).approvals);
  ok('nor on somebody else’s desk looked at by Management', !(await anil.getPersonDashboard({ as: KIRAN.email })).approvals);

  console.log('\nAN APPROVER WHOSE ERP ID IS NOT A MAILBOX');
  await db.appendRow('Users', { id: 'U-Ravi', email: 'ravi@pie.invalid', name: 'Ravi Kulkarni', role: 'Management', businessStream: 'All', active: 'TRUE' });
  ok('a made-up address will not do as the inbox', await refuses(() => anil.saveCustomerApprover({ email: 'ravi@pie.invalid', mailTo: 'ravi@pie.invalid' }), /anybody reads/));
  await anil.saveCustomerApprover({ email: 'ravi@pie.invalid' });
  sent = [];
  const quiet = await kiran.saveCustomer({ name: 'Satara Steel Rolling' });
  ok('with no inbox given, nothing is sent to the ERP ID, and the save says it waits on the dashboard', sent.length === 0 &&
    quiet.approval && quiet.approval.emailed === '' && /Ravi Kulkarni has no e-mail address set/.test(quiet.approval.reason), quiet.approval);
  await anil.saveCustomerApprover({ email: 'ravi@pie.invalid', mailTo: 'office@example.com' });
  await kiran.saveCustomer({ name: 'Karad Sugar Works' });
  ok('given one, the e-mail goes there', sent.length === 1 && sent[0].to === 'office@example.com');
  await anil.saveCustomerApprover({ email: MEERA.email, mailTo: 'meera.ops@example.com' });

  console.log('\nTHE APPROVER MOVES ON');
  await anil.changeUserEmail({ userId: 'U-Meera', newEmail: 'meera.joshi@pie.in' });
  ok('a renamed approver still approves', (await anil.getSettings()).customerApproval.approver === 'meera.joshi@pie.in');
  await db.q("UPDATE users SET active = 'FALSE' WHERE tenant_id = $1 AND name = 'Meera Joshi'", [TENANT]);
  const fallback = await anil.listCustomerApprovals();
  ok('one who has left: Management decide again, so nothing is stranded', fallback.canDecide && fallback.approver === null, fallback);
  ok('cleared, the setting is gone', (await anil.saveCustomerApprover({ email: '' })).approver === '');

  for (const tb of TABLES) await db.q('DELETE FROM ' + tb + ' WHERE tenant_id = $1', [TENANT]);
  await db.pool.end();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
