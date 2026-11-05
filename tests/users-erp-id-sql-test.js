/**
 * The ERP ID (Users.email): PIE's people have no mailboxes, so a person added with none gets
 * one made from their username at a domain that can never receive mail (Settings.gs,
 * freeErpId_). Each person still needs their own: it is how every record knows whose it is.
 *
 * And everybody still known by an e-mail address moved onto one at once (UserEmail.gs,
 * applyErpIdCleanup): the list shown first, a list that changed since refused, their work
 * moving with them, the approver of new customers keeping their inbox, the admin's own last.
 *
 * People are invented.
 *
 *   DATABASE_URL=postgres://... node tests/users-erp-id-sql-test.js
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

const TENANT = 'users-erp-id-test';
const ADMIN = { email: 'office@pie.invalid', name: 'Office Admin', role: 'ERP Admin', businessStream: 'All' };
const TABLES = ['users', 'audit_log', 'sessions', 'customers', 'quotations'];

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => { for (const t of TABLES) { try { await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]); } catch (e) { /* no table */ } } };
  await clean();
  await db.appendRow('Users', { id: 'U-ADMIN', username: 'office', email: ADMIN.email, name: ADMIN.name, role: ADMIN.role, businessStream: 'All', active: 'TRUE' });
  await db.appendRow('Users', { id: 'U-OLD', username: 'omkarj', email: 'omkar@pie.invalid', name: 'Omkar Jadhav', role: 'Sales Engineer', businessStream: 'All', active: 'TRUE' });
  const p = loadPortal(db, ADMIN.email, { quiet: true, properties: {} });
  p.CURRENT_USER_ = ADMIN;
  const user = (s, name) => s.users.find((u) => u.name === name) || {};

  console.log('ADDED WITH NO E-MAIL');
  let s = await p.saveUser({ name: 'Priya Shah', role: 'Sales Coordinator' });
  ok('the username comes from the first name, the ERP ID from the username', user(s, 'Priya Shah').username === 'priya' &&
    user(s, 'Priya Shah').email === 'priya@pie.invalid', user(s, 'Priya Shah'));
  s = await p.saveUser({ name: 'Priya Desai', role: 'Sales Coordinator' });
  ok('a second Priya gets her own of both', user(s, 'Priya Desai').username === 'priya2' && user(s, 'Priya Desai').email === 'priya2@pie.invalid', user(s, 'Priya Desai'));
  s = await p.saveUser({ name: 'Kiran Patil', username: 'kiran.p', role: 'Sales Coordinator' });
  ok('a username typed is the ERP ID’s start', user(s, 'Kiran Patil').email === 'kiran.p@pie.invalid', user(s, 'Kiran Patil'));
  s = await p.saveUser({ name: 'Omkar Pawar', username: 'omkar', role: 'Sales Engineer' });
  ok('an ERP ID somebody already has is stepped round', user(s, 'Omkar Pawar').email === 'omkar2@pie.invalid', user(s, 'Omkar Pawar'));

  console.log('\nTYPED, IT IS CHECKED');
  s = await p.saveUser({ name: 'Sunil More', email: ' Sunil@PIE.invalid ', role: 'Service Engineer' });
  ok('one typed is kept, in small letters', user(s, 'Sunil More').email === 'sunil@pie.invalid');
  ok('one somebody has is refused, saying each needs their own',
    (await refuses(() => p.saveUser({ name: 'Second Sunil', email: 'sunil@pie.invalid', role: 'Service Engineer' }), /already somebody’s ERP ID\. Each person needs their own/)) === true);
  ok('so is the shared office address on a second person', (await refuses(async () => {
    await p.saveUser({ name: 'Front Desk', email: 'admin@example.com', role: 'Sales Coordinator' });
    await p.saveUser({ name: 'Back Office', email: 'admin@example.com', role: 'Sales Coordinator' });
  }, /already somebody’s ERP ID/)) === true);
  ok('one with a space is refused', (await refuses(() => p.saveUser({ name: 'X Y', email: 'x y@pie.invalid', role: 'Service Engineer' }), /no spaces/)) === true);
  ok('one with no name before the @ is refused', (await refuses(() => p.saveUser({ name: 'X Y', email: '@pie.invalid', role: 'Service Engineer' }), /looks like name@something/)) === true);

  console.log('\nEDITING');
  const priya = user(s, 'Priya Shah');
  s = await p.saveUser({ id: priya.id, email: priya.email, name: 'Priya Shah', role: 'Sales Coordinator', designation: 'Sales Coordinator', username: 'priya' });
  ok('an edit keeps the ERP ID', user(s, 'Priya Shah').email === 'priya@pie.invalid' && user(s, 'Priya Shah').designation === 'Sales Coordinator');
  ok('an edit with the ERP ID missing is refused, not given a new one',
    (await refuses(() => p.saveUser({ id: priya.id, name: 'Priya Shah', role: 'Sales Coordinator' }), /ERP ID is missing/)) === true);

  console.log('\nWHICH ADDRESSES ARE MAILBOXES');
  ok('a made-up ERP ID is not', p.isMailbox_('priya@pie.invalid') === false && p.isMailbox_('PRIYA@PIE.INVALID') === false);
  ok('a real address is', p.isMailbox_('admin@example.com') === true);
  ok('nor is something that is not an address', p.isMailbox_('priya') === false && p.isMailbox_('') === false);

  console.log('\nEVERYBODY STILL ON AN E-MAIL ADDRESS, AT ONCE');
  const IT = { email: 'it@example.com', name: 'Zubin Irani', role: 'ERP Admin', businessStream: 'All' };
  await db.appendRow('Users', { id: 'U-IT', username: 'zubin', email: IT.email, name: IT.name, role: IT.role, businessStream: 'All', active: 'TRUE' });
  await db.appendRow('Users', { id: 'U-MEENA', username: 'meena', email: 'meena.personal@example.com', name: 'Meena Gokhale', role: 'Sales Coordinator', businessStream: 'All', active: 'TRUE' });
  await db.appendRow('Users', { id: 'U-GONE', username: 'vikas', email: 'vikas@example.com', name: 'Vikas Rane', role: 'Sales Engineer', businessStream: 'All', active: 'FALSE' });
  await db.appendRow('Users', { id: 'U-BOSS', username: 'rajesh', email: 'office.gmail@example.com', name: 'Rajesh Kamat', role: 'Management', businessStream: 'All', active: 'TRUE' });
  // Somebody already holds rajesh@pie.invalid, so Rajesh is stepped round it.
  await db.appendRow('Users', { id: 'U-R2', username: 'rkulkarni', email: 'rajesh@pie.invalid', name: 'Rajesh Kulkarni', role: 'Sales Engineer', businessStream: 'All', active: 'TRUE' });
  await db.appendRow('Customers', { id: 'CU-M1', customerCode: 'C1', name: 'Sahyadri Castings', createdBy: 'meena.personal@example.com', active: 'TRUE' });
  await db.appendRow('Quotations', { id: 'QT-M1', quoteNo: 'Q/1', preparedBy: 'meena.personal@example.com', status: 'Draft' });
  await db.appendRow('Quotations', { id: 'QT-M2', quoteNo: 'Q/2', preparedBy: 'meena.personal@example.com', status: 'Draft' });
  const props = {};
  const it = loadPortal(db, IT.email, { quiet: true, properties: props });
  it.CURRENT_USER_ = IT;
  await it.saveCustomerApprover({ email: 'office.gmail@example.com' });
  const meenaP = loadPortal(db, 'meena.personal@example.com', { quiet: true, properties: props });
  meenaP.CURRENT_USER_ = { email: 'meena.personal@example.com', name: 'Meena Gokhale', role: 'Sales Coordinator', businessStream: 'All' };
  ok('only ERP Admin may look', (await refuses(() => meenaP.previewErpIdCleanup(), /./)) === true);

  const look = await it.previewErpIdCleanup();
  const by = (n) => look.people.find((x) => x.name === n) || {};
  ok('everybody on an e-mail address, and nobody already on an ERP ID', look.people.map((x) => x.name).join('|') ===
    'Front Desk|Meena Gokhale|Rajesh Kamat|Vikas Rane|Zubin Irani', look.people.map((x) => x.name));
  ok('each to their username at pie.invalid', by('Meena Gokhale').newEmail === 'meena@pie.invalid' && by('Vikas Rane').newEmail === 'vikas@pie.invalid', look.people);
  ok('stepped round one already taken', by('Rajesh Kamat').newEmail === 'rajesh2@pie.invalid', by('Rajesh Kamat'));
  ok('with how much of their work moves', by('Meena Gokhale').records === 3, by('Meena Gokhale'));
  ok('the inactive say so, and the admin is marked as themselves', by('Vikas Rane').active === false && by('Zubin Irani').isSelf === true);

  const send = look.people.map((x) => ({ userId: x.userId, newEmail: x.newEmail }));
  ok('a list other than the one shown is refused', (await refuses(() => it.applyErpIdCleanup({ people: send.slice(1) }), /has changed since you looked/)) === true);
  ok('and nothing moved', (await db.q("SELECT email FROM users WHERE tenant_id = $1 AND id = 'U-MEENA'", [TENANT])).rows[0].email === 'meena.personal@example.com');

  const done = await it.applyErpIdCleanup({ people: send });
  ok('all five moved', done.changed.length === 5, done.changed);
  ok('the admin’s own move last, and said', done.changed[4].name === 'Zubin Irani' && done.selfChanged === true);
  const mrow = (await db.q("SELECT email FROM users WHERE tenant_id = $1 AND id = 'U-MEENA'", [TENANT])).rows[0];
  const work = (await db.q("SELECT (SELECT created_by FROM customers WHERE tenant_id = $1 AND id = 'CU-M1') AS c, " +
    "(SELECT count(*)::int FROM quotations WHERE tenant_id = $1 AND prepared_by = 'meena@pie.invalid') AS q", [TENANT])).rows[0];
  ok('their row and their work moved together', mrow.email === 'meena@pie.invalid' && work.c === 'meena@pie.invalid' && work.q === 2, { mrow, work });
  const left = (await db.q("SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND email NOT LIKE '%@pie.invalid'", [TENANT])).rows[0].n;
  ok('nobody is left on an e-mail address', left === 0, left);
  ok('the approver still approves, and their e-mail still reaches the inbox it did', props.CUSTOMER_APPROVER === 'rajesh2@pie.invalid' &&
    props.CUSTOMER_APPROVER_MAIL === 'office.gmail@example.com' && done.keptInbox === 'office.gmail@example.com', props);
  const renames = (await db.q("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'RENAME'", [TENANT])).rows[0].n;
  ok('each move is in the audit trail', renames === 5, renames);
  ok('run again: nothing to do', (await it.previewErpIdCleanup()).people.length === 0 &&
    (await refuses(() => it.applyErpIdCleanup({ people: [] }), /Everybody already has an ERP ID/)) === true);

  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
