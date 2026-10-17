/**
 * Settings that survive a restart, and the Google gate that depends on them.
 *
 * This suite exists because of a finding, not a feature. The portal's settings were an
 * empty object in memory on the server, and one of them decides whether a Google account
 * is demanded before the password. Missing, it reads as off — so a portal that demanded a
 * Google sign-in on Apps Script quietly did not here, and nothing failed to say so.
 *
 * So the assertions are mostly about that one setting: that it is written down, that it is
 * read back by a process that did not write it, and that the gate it controls both bites
 * and gives people a way through. A gate that can be switched on but not passed is not a
 * fix, it is a lock-out.
 *
 *   DATABASE_URL=postgres://... node tests/settings-test.js
 */
const path = require('path');

const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.log('no DATABASE_URL — skipping'); process.exit(0); }

const { connect } = require(path.join(__dirname, '..', 'server', 'db.js'));
const { loadPortal } = require(path.join(__dirname, '..', 'server', 'load.js'));
const { build } = require(path.join(__dirname, '..', 'server', 'index.js'));
const { settingsStore } = require(path.join(__dirname, '..', 'server', 'settings.js'));

const TENANT = 'settings-test';
const FILES = '/tmp/erp-files-settings-test';
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};
const settle = () => new Promise((r) => setTimeout(r, 250));

(async () => {
  const db = connect({ connectionString: URL_, tenant: TENANT });
  const wipe = ['users', 'sessions', 'company_profile', 'audit_log'];
  const clean = async () => {
    for (const t of wipe) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
    await db.q('DELETE FROM settings WHERE tenant_id = $1', [TENANT]).catch(() => {});
  };
  await db.q(require(path.join(__dirname, '..', 'server', 'settings.js')).DDL);
  await clean();
  await db.appendRow('CompanyProfile', { id: 'CO-1', appName: 'Premier India Enterprise' });
  await db.appendRow('Users', { id: 'USR-1', username: 'boss', email: 'boss@pie.in',
    name: 'Boss', role: 'ERP Admin', businessStream: 'All', active: 'TRUE' });
  const setup = loadPortal(db, 'setup', { quiet: true });
  setup.CURRENT_USER_ = { email: 'setup@pie.in', role: 'ERP Admin' };
  const password = (/boss\s+(\S+)/.exec(String(await setup.createSignInPasswords())) || [])[1];

  console.log('A SETTING IS WRITTEN DOWN');
  const first = settingsStore(db, {});
  await first.load();
  ok('nothing is there to begin with', Object.keys(first.props).length === 0, first.props);
  first.store('boss@pie.in').setProperty('TALLY_ENDPOINT', 'http://192.168.1.9:9000');
  await settle();
  ok('and the next read in the same process sees it',
    first.store('').getProperty('TALLY_ENDPOINT') === 'http://192.168.1.9:9000');

  // The point of the whole exercise: a process that did not write it can read it.
  const second = settingsStore(db, {});
  await second.load();
  ok('so does a process that did not write it',
    second.store('').getProperty('TALLY_ENDPOINT') === 'http://192.168.1.9:9000',
    second.props);
  const row = await db.q('SELECT value, updated_by FROM settings WHERE tenant_id = $1 AND key = $2',
    [TENANT, 'TALLY_ENDPOINT']);
  ok('with a note of who changed it', row.rows[0].updated_by === 'boss@pie.in', row.rows[0]);

  second.store('').deleteProperty('TALLY_ENDPOINT');
  await settle();
  const third = settingsStore(db, {});
  await third.load();
  ok('removing one removes it for good', third.store('').getProperty('TALLY_ENDPOINT') === null);
  ok('and an unset key is null, not undefined', third.store('').getProperty('NOTHING') === null);

  console.log('\nTHE ENVIRONMENT SEEDS, THE DATABASE DECIDES');
  const seeded = settingsStore(db, { TELEMETRY: 'off', TALLY_COMPANY: 'PIE' });
  await seeded.load();
  ok('a key only the environment has is used', seeded.store('').getProperty('TELEMETRY') === 'off');
  seeded.store('').setProperty('TELEMETRY', 'on');
  await settle();
  const afterwards = settingsStore(db, { TELEMETRY: 'off' });
  await afterwards.load();
  ok('and what was set in the portal wins from then on',
    afterwards.store('').getProperty('TELEMETRY') === 'on', afterwards.props);

  console.log('\nTHE GOOGLE GATE, WHICH ALL OF THAT IS FOR');
  const serve = async (set, go) => {
    const server = build({ db, tenant: TENANT, filesDir: FILES });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    await server.ready;
    if (set) { server.settings.store('boss@pie.in').setProperties(set); await settle(); }
    const out = await go('http://127.0.0.1:' + server.address().port, server);
    await new Promise((r) => server.close(r));
    return out;
  };
  const login = (base) => fetch(base + '/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password, googlePass: '' }) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  const page = (base) => fetch(base, { headers: {
    'x-forwarded-proto': 'https', 'x-forwarded-host': 'erp.pie.in' } })
    .then(async (r) => ({ status: r.status, html: await r.text() }));

  await db.q('DELETE FROM settings WHERE tenant_id = $1', [TENANT]);
  let r = await serve(null, async (b) => ({ page: await page(b), login: await login(b) }));
  ok('with the gate off the portal is served', r.page.html.length > 100000, r.page.html.length);
  ok('and a password is enough', r.login.body.ok && r.login.body.ok.token, r.login.body);

  // Switched on in one process; demanded by the next one, which is the finding.
  await serve({ GOOGLE_GATE: 'on' }, async () => {});
  r = await serve(null, async (b) => ({ page: await page(b), login: await login(b) }));
  ok('switched on, a cold process still demands it', r.login.status === 401, r.login.status);
  ok('refusing in words a person can act on',
    /GOOGLE_ACCOUNT_BLOCKED/.test(r.login.body.error || ''), r.login.body);
  // On with no client id is a mistake somebody can make from the Settings screen.
  ok('and the page says what is missing rather than going blank',
    /has not been given a Google client/.test(r.page.html), r.page.html.slice(0, 120));

  await serve({ GOOGLE_GATE_CLIENT_ID: 'cid.apps.googleusercontent.com',
    GOOGLE_GATE_CLIENT_SECRET: 'shh', GOOGLE_GATE_ACCOUNTS: 'anil@pie.in' }, async () => {});
  r = await serve(null, async (b) => ({ page: await page(b) }));
  ok('configured, there is a way through', /Continue with Google/.test(r.page.html));
  const link = (/href="([^"]+)"/.exec(r.page.html) || [])[1] || '';
  ok('to Google', link.indexOf('https://accounts.google.com/') === 0, link.slice(0, 40));
  ok('carrying the client id', /client_id=cid\./.test(link), link.slice(0, 90));
  // Behind a proxy the Host header is whatever the proxy says; Google matches the redirect
  // URI exactly, and http:// where the world sees https:// is rejected.
  ok('and a redirect the proxy’s own scheme and host',
    decodeURIComponent((/redirect_uri=([^&]+)/.exec(link) || [])[1] || '') === 'https://erp.pie.in',
    link);
  ok('the client secret is not on the page', !/shh/.test(r.page.html));
  ok('and the portal is not served behind it', r.page.html.length < 20000, r.page.html.length);

  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + e.message); console.log(e.stack.split('\n').slice(1,5).join('\n')); process.exit(1); });
