/**
 * Download All Data, then load it into another database, and prove nothing changed.
 *
 * The whole point of the button is the day somebody switches database. So this does exactly
 * that, end to end: fills one tenant with the awkward cases — decimals, dates, timestamps,
 * true/false flags, text with quotes, commas, line breaks and rupee signs, password hashes, a
 * table big enough to need two files — downloads the export through the real server as the
 * browser would, unzips it with a zip reader that is not ours, runs the cutover's own
 * migration/import.js into a second, empty tenant, and then compares every field of every row
 * of every table between the two.
 *
 * And the door: no session, and a session that is not Management or the ERP admin, get no file.
 *
 *   DATABASE_URL=postgres://... node tests/export-roundtrip-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.log('no DATABASE_URL — skipping'); process.exit(0); }

const R = path.join(__dirname, '..');
const { connect, mapFor, SCHEMA } = require(path.join(R, 'server', 'db.js'));
const { loadPortal } = require(path.join(R, 'server', 'load.js'));
const { build } = require(path.join(R, 'server', 'index.js'));
const { syncSchema } = require(path.join(R, 'server', 'schema-sync.js'));

const FROM = 'export-from';
const TO = 'export-to';
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};

(async () => {
  const db = connect({ connectionString: URL_, tenant: FROM });
  await syncSchema(db, () => {});
  const tables = Object.keys(SCHEMA).map((t) => mapFor(t).table).concat(['sessions']);
  const clean = async (tenant) => {
    for (const t of tables) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [tenant]);
  };
  await clean(FROM);
  await clean(TO);

  // ------------------------------------------------------------- the awkward cases
  const add = (tab, row) => db.appendRow(tab, row);
  await add('CompanyProfile', { id: 'CO-1', appName: 'Premier India Enterprise' });
  await add('Users', { id: 'U-1', username: 'boss', email: 'boss@pie.in', name: 'Anil Shah',
    role: 'ERP Admin', businessStream: 'All', active: 'TRUE' });
  await add('Users', { id: 'U-2', username: 'priya', email: 'priya@pie.in', name: 'Priya Deshmukh',
    role: 'Sales Coordinator', businessStream: 'Spare Sales', active: 'TRUE' });
  await add('Customers', { id: 'CU-1', customerCode: 'C0001', active: 'TRUE', creditLimit: 500000.5,
    name: 'Shree "Ganesh" Pumps, Pune — ₹ unit', notes: 'Line one\nline two, with a comma\tand a tab' });
  await add('Quotations', { id: 'QT-1', quoteNo: 'PIE/ELGI/QUOT/26-27/401', revision: 'R0',
    date: '2026-10-01', validUntil: '2026-10-31', customerId: 'CU-1', businessStream: 'Spare Sales',
    status: 'Submitted', grand: 41101.46, taxAmt: 7398.26, locked: 'TRUE',
    createdAt: '2026-10-01T09:15:30.123Z', createdBy: 'boss@pie.in' });
  await add('SalesOrders', { id: 'SO-1', orderNo: 'SO/1', quotationId: 'QT-1', customerId: 'CU-1',
    businessStream: 'Spare Sales', orderStatus: 'Invoiced', grand: 48499.72, poVerified: 'TRUE' });
  await add('Dispatches', { id: 'DS-1', salesOrderId: 'SO-1', deliveryConfirmed: 'FALSE',
    serviceNotified: 'TRUE' });
  // Enough price rows that the table needs two files: 5,000 to a file.
  const many = [];
  for (let i = 1; i <= 5203; i++) {
    many.push({ id: 'PRC-' + i, itemType: 'Spare', itemId: 'SP-' + i, itemCode: 'ELG-' + (100000 + i),
      priceLevel: 'ELGI', price: 1200 + i / 4, currency: 'INR', effectiveFrom: '2026-01-01', active: 'TRUE' });
  }
  for (let s = 0; s < many.length; s += 1000) await db.appendRows('PriceList', many.slice(s, s + 1000));

  const setup = loadPortal(db, 'setup', { quiet: true });
  setup.CURRENT_USER_ = { email: 'setup@pie.in', role: 'ERP Admin' };
  const said = String(await setup.createSignInPasswords());
  const pw = (login) => (new RegExp('\\b' + login + '\\s+(\\S+)').exec(said) || [])[1];
  for (const id of ['U-1', 'U-2']) {
    await db.updateRowById('Users', 'id', id, { mustChangePassword: 'FALSE' }, 'test');
  }

  const server = build({ db, tenant: FROM });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (p, body) => fetch(base + p, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const tokenFor = async (login) => {
    const r = await post('/api/login', { username: login, password: pw(login) });
    const b = await r.json();
    return b.ok && b.ok.token;
  };

  // ------------------------------------------------------------- the door
  console.log('ONLY MANAGEMENT AND THE ERP ADMIN GET THE FILE');
  const anon = await post('/api/export', {});
  ok('no session, no file', anon.status === 401 && !/zip/.test(anon.headers.get('content-type') || ''),
    anon.status);
  const coordinator = await post('/api/export', { token: await tokenFor('priya') });
  const said403 = await coordinator.json().catch(() => ({}));
  ok('a sales coordinator is refused, in words', coordinator.status === 403 && !!said403.error,
    { status: coordinator.status, said: said403 });

  // ------------------------------------------------------------- the download
  console.log('\nTHE ERP ADMIN DOWNLOADS IT');
  const t0 = Date.now();
  const res = await post('/api/export', { token: await tokenFor('boss') });
  const file = Buffer.from(await res.arrayBuffer());
  const ms = Date.now() - t0;
  ok('a zip comes back', res.status === 200 && res.headers.get('content-type') === 'application/zip',
    res.status);
  const disp = res.headers.get('content-disposition') || '';
  ok('named for the company and the minute', /^attachment; filename="Premier India Enterprise data export \d{4}-\d\d-\d\d \d\d-\d\d\.zip"$/.test(disp), disp);
  ok('saying how many records it holds', Number(res.headers.get('x-export-rows')) >= 5203 + 7,
    res.headers.get('x-export-rows'));
  ok('and it is not cached anywhere on the way', res.headers.get('cache-control') === 'no-store');
  console.log('   ' + Math.round(file.length / 1024) + ' KB in ' + ms + ' ms');

  const audit = await db.q("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND " +
    "action = 'EXPORT' AND user_email = 'boss@pie.in'", [FROM]);
  ok('the download is in the audit log, against who took it', audit.rows[0].n === 1, audit.rows[0].n);

  // ------------------------------------------------------------- someone else's unzip
  console.log('\nIT OPENS WITH AN ORDINARY ZIP TOOL');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-export-'));
  const zipPath = path.join(work, 'export.zip');
  fs.writeFileSync(zipPath, file);
  const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  ok('unzip lists it without complaint', /_manifest\.json/.test(listing) && /PriceList\.02\.json/.test(listing),
    listing.split('\n').slice(0, 6));
  execFileSync('unzip', ['-q', zipPath, '-d', path.join(work, 'out')]);
  execFileSync('unzip', ['-tq', zipPath]);   // every file's checksum, by unzip's own reckoning
  const inner = fs.readdirSync(path.join(work, 'out'));
  ok('one folder inside, as a download from Drive has', inner.length === 1, inner);
  const manifest = JSON.parse(fs.readFileSync(path.join(work, 'out', inner[0], '_manifest.json'), 'utf8'));
  ok('every declared table is in it', manifest.tabCount === Object.keys(SCHEMA).length,
    { got: manifest.tabCount, want: Object.keys(SCHEMA).length });
  ok('the price list in two files', manifest.tabs.filter((t) => t.tab === 'PriceList')[0].parts === 2);
  ok('nothing moved while it was read — it is one snapshot', manifest.tabsThatMovedDuringExport.length === 0);
  const sess = JSON.parse(fs.readFileSync(path.join(work, 'out', inner[0], 'Sessions.01.json'), 'utf8'));
  ok('sign-ins are in it only as fingerprints, so a copied file is no way in',
    sess.columns.indexOf('tokenHash') !== -1 && !sess.columns.some((c) => /^token$/i.test(c)) &&
    sess.rows.length >= 2, sess.columns);

  // ------------------------------------------------------------- into another database
  console.log('\nTHE CUTOVER IMPORT LOADS IT INTO AN EMPTY ONE');
  const run = (args) => {
    try {
      return execFileSync('node', [path.join(R, 'migration', 'import.js')].concat(args),
        { encoding: 'utf8', env: Object.assign({}, process.env, { DATABASE_URL: URL_ }) });
    } catch (err) { return 'EXIT ' + err.status + '\n' + err.stdout + err.stderr; }
  };
  const checked = run([path.join(work, 'out'), '--tenant', TO]);
  ok('every check passes before anything is written', /Checks passed/.test(checked),
    checked.split('\n').slice(-12));
  const loaded = run([path.join(work, 'out'), '--tenant', TO, '--write']);
  ok('it loads, and the import reads every row back', /Every row and every field made the trip/.test(loaded),
    loaded.split('\n').slice(-15));

  console.log('\nAND THE TWO ARE THE SAME, FIELD BY FIELD');
  const other = connect({ connectionString: URL_, tenant: TO });
  let tabsSame = 0;
  const differ = [];
  for (const tab of Object.keys(SCHEMA)) {
    const key = (r) => String(r.id || '') + '|' + JSON.stringify(r);
    const a = (await db.readTable(tab)).map((r) => JSON.stringify(r)).sort();
    const b = (await other.readTable(tab)).map((r) => JSON.stringify(r)).sort();
    if (a.length === b.length && a.every((x, i) => x === b[i])) tabsSame++;
    else differ.push({ tab, from: a.length, to: b.length, first: a.find((x, i) => x !== b[i]) });
    void key;
  }
  ok('every table identical in the new place', differ.length === 0, differ.slice(0, 3));
  console.log('   ' + tabsSame + ' tables compared, every field of every row');
  const exported = (await other.readTable('AuditLog')).filter((a) => a.action === 'EXPORT');
  ok('the audit log too — including the row saying who took the file', exported.length === 1 &&
    exported[0].userEmail === 'boss@pie.in', exported);
  const hash = (await other.findRowById('Users', 'U-1'));
  ok('passwords come across, so people sign in as before', !!hash.passwordHash &&
    hash.passwordHash === (await db.findRowById('Users', 'U-1')).passwordHash);
  const cust = await other.findRowById('Customers', 'CU-1');
  ok('awkward text survives exactly', cust.name === 'Shree "Ganesh" Pumps, Pune — ₹ unit' &&
    cust.notes === 'Line one\nline two, with a comma\tand a tab', cust);
  const q = await other.findRowById('Quotations', 'QT-1');
  ok('money, dates and the moment it was made, unchanged', q.grand === 41101.46 &&
    q.date === '2026-10-01' && q.createdAt === '2026-10-01T09:15:30.123Z', q);
  const d = await other.findRowById('Dispatches', 'DS-1');
  ok('and true is true, false is false', d.deliveryConfirmed === false && d.serviceNotified === true, d);

  // ------------------------------------------------------------- the new place works
  console.log('\nAND THE PORTAL RUNS ON THE NEW ONE');
  const server2 = build({ db: other, tenant: TO });
  await new Promise((r) => server2.listen(0, '127.0.0.1', r));
  const base2 = 'http://127.0.0.1:' + server2.address().port;
  const login2 = await fetch(base2 + '/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: pw('boss') }) });
  const body2 = await login2.json();
  ok('the same password signs in', login2.status === 200 && !!(body2.ok && body2.ok.token), body2);
  const call2 = await fetch(base2 + '/api/call', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: body2.ok && body2.ok.token, fn: 'listQuotations', args: [{}] }) });
  const quotes2 = (await call2.json()).ok || [];
  ok('and the quotation is there', quotes2.some((x) => x.quoteNo === 'PIE/ELGI/QUOT/26-27/401'),
    quotes2.length);

  await new Promise((r) => server.close(r));
  await new Promise((r) => server2.close(r));
  fs.rmSync(work, { recursive: true, force: true });
  await clean(FROM);
  await clean(TO);
  await other.pool.end();
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
