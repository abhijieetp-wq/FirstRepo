/**
 * The ERP ID (Users.email): PIE's people have no mailboxes, so a person added with none gets
 * one made from their username at a domain that can never receive mail (Settings.gs,
 * freeErpId_). Each person still needs their own: it is how every record knows whose it is.
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
const TABLES = ['users', 'audit_log', 'sessions'];

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

  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length ? failures.length + ' failed, ' + pass + ' passed' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
