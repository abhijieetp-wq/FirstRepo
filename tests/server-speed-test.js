/**
 * What makes the server quick, and the promises each shortcut has to keep.
 *
 * Three things were costing PIE seconds on the slow screens:
 *
 *   - the portal's cache lived for one request, so a signed-in session was looked up in the
 *     database on every click, and the dashboard was rebuilt every time — and, worse, the
 *     Google gate could never find its own sign-in state when Google sent the person back
 *   - nothing was compressed, so the 6.9 MB spare catalogue crossed the internet at full size
 *   - the small tables every screen reads were fetched afresh each time: Settings alone made
 *     twelve round trips to Neon
 *
 * Each fix is a shortcut, and a shortcut that serves a stale answer is a bug. So alongside
 * "it is faster" this checks what must still be true: a logout ends the session at once, a
 * change is seen on the next read, and a write that was rolled back is never remembered.
 *
 *   DATABASE_URL=postgres://... node tests/server-speed-test.js
 */
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.log('no DATABASE_URL — skipping (set it to run these against a real Postgres)');
  process.exit(0);
}

const { connect } = require(path.join(__dirname, '..', 'server', 'db.js'));
const { loadPortal } = require(path.join(__dirname, '..', 'server', 'load.js'));
const { build } = require(path.join(__dirname, '..', 'server', 'index.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

const TENANT = 'speed-test';
const TABLES = ['users', 'sessions', 'company_profile', 'spares', 'price_list', 'config_lists',
  'audit_log', 'customers', 'brands', 'warehouses', 'lost_reasons', 'quote_templates',
  'business_streams', 'telemetry'];

(async () => {
  const db = connect({ connectionString: URL_, tenant: TENANT });
  for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);

  await db.appendRow('Users', { id: 'USR-1', username: 'boss', email: 'boss@pie.in',
    name: 'Anil Shah', role: 'ERP Admin', businessStream: 'All', active: 'TRUE' });
  await db.appendRow('ConfigLists', { id: 'CL-1', category: 'LeadSource', code: 'PHONE',
    label: 'Phone', sortOrder: 1, active: 'TRUE' });
  // Enough catalogue to be worth compressing, the way the real one is: rows repeating keys.
  const spares = [];
  for (let i = 0; i < 2000; i++) {
    spares.push({ id: 'SP-' + i, partNo: 'ELG-' + (100000 + i), description: 'Separator element ' + i,
      productGroup: 'Separators', uom: 'Nos', gstPct: 18, active: 'TRUE', brand: 'ELGI' });
  }
  await db.appendRows('Spares', spares);
  await db.q('DELETE FROM audit_log WHERE tenant_id = $1', [TENANT]);

  const setup = loadPortal(db, 'setup', { quiet: true });
  setup.CURRENT_USER_ = { email: 'setup@pie.in', role: 'ERP Admin' };
  const password = (/boss\s+(\S+)/.exec(String(await setup.createSignInPasswords())) || [])[1];
  await db.updateRowById('Users', 'id', 'USR-1', { mustChangePassword: 'FALSE' });

  // Every statement that reaches the database, with its text, so a test can say which.
  const seen = [];
  const realPoolQuery = db.pool.query.bind(db.pool);
  db.pool.query = function (text) { seen.push(String(text)); return realPoolQuery.apply(null, arguments); };

  const server = build({ db, tenant: TENANT, properties: {
    GOOGLE_GATE: 'off', GOOGLE_GATE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    GOOGLE_GATE_CLIENT_SECRET: 'test-secret' } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // Raw HTTP, so the encoding the server chose is visible rather than undone by fetch.
  const request = (method, p, body, headers) => new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign(
      data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers || {}) },
    (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw).toString() : raw.toString();
        resolve({ status: res.statusCode, headers: res.headers, bytes: raw.length, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  const login = JSON.parse((await request('POST', '/api/login', { username: 'boss', password })).text);
  const token = login.ok && (login.ok.token || login.ok);
  const call = async (fn, args, headers) => {
    seen.length = 0;
    const r = await request('POST', '/api/call', { fn, args: args || [], token }, headers);
    return { status: r.status, headers: r.headers, bytes: r.bytes, body: JSON.parse(r.text), queries: seen.slice() };
  };
  const reads = (qs, table) => qs.filter((q) => new RegExp('FROM ' + table + '\\b').test(q)).length;

  console.log('A SIGNED-IN SESSION IS REMEMBERED BETWEEN REQUESTS');
  const first = await call('listCustomers');
  const second = await call('listCustomers');
  ok('the first call looks the session up', reads(first.queries, 'sessions') === 1, first.queries);
  ok('the second does not go back to the database for it', reads(second.queries, 'sessions') === 0 &&
    reads(second.queries, 'users') === 0, second.queries);
  ok('and still answers', second.status === 200 && Array.isArray(second.body.ok), second.status);

  console.log('\nA LOGOUT STILL ENDS THE SESSION AT ONCE');
  const other = JSON.parse((await request('POST', '/api/login', { username: 'boss', password })).text).ok;
  const otherToken = other.token || other;
  const before = await request('POST', '/api/call', { fn: 'listCustomers', args: [], token: otherToken });
  ok('a second session works', before.status === 200, before.status);
  await request('POST', '/api/logout', { token: otherToken });
  const after = await request('POST', '/api/call', { fn: 'listCustomers', args: [], token: otherToken });
  ok('after logging out it is refused, remembered or not', after.status === 401, [after.status, after.text.slice(0, 120)]);
  ok('and the first session is untouched', (await call('listCustomers')).status === 200);

  console.log('\nSETTINGS\' SMALL TABLES ARE REMEMBERED, AND FORGOTTEN WHEN WRITTEN');
  await call('getSettings');
  const again = await call('getSettings');
  ok('a second visit to Settings asks the database nothing', again.queries.length === 0, again.queries);
  // Written the way any part of the portal writes: through the one query path.
  await db.q("INSERT INTO config_lists (tenant_id, id, category, code, label, sort_order, active) " +
    "VALUES ($1, 'CL-2', 'LeadSource', 'EXPO', 'Trade fair', 2, true)", [TENANT]);
  const fresh = await call('getSettings');
  ok('a write is seen on the very next read', fresh.body.ok.configLists.some((c) => c.label === 'Trade fair'),
    fresh.body.ok.configLists.map((c) => c.label));
  ok('because the written table was read again', reads(fresh.queries, 'config_lists') === 1, fresh.queries);
  ok('and only that one', fresh.queries.length === 1, fresh.queries);

  console.log('\nA ROLLED-BACK WRITE IS NEVER REMEMBERED');
  let rolledBack = null;
  try {
    await db.withTransaction(async (tx) => {
      await tx.updateRowById('Users', 'id', 'USR-1', { name: 'Phantom Name' });
      await tx.readTable('Users');                       // reads its own uncommitted change
      throw new Error('later step failed');
    });
  } catch (e) { rolledBack = e.message; }
  ok('the transaction failed', rolledBack === 'later step failed', rolledBack);
  const users = (await call('getSettings')).body.ok.users;
  ok('and the name it wrote is not what anybody sees', users.some((u) => u.name === 'Anil Shah') &&
    !users.some((u) => u.name === 'Phantom Name'), users.map((u) => u.name));
  await db.withTransaction(async (tx) => {
    await tx.updateRowById('Users', 'id', 'USR-1', { designation: 'Director' });
  });
  ok('while a committed one is seen straight away',
    (await call('getSettings')).body.ok.users.some((u) => u.designation === 'Director'));
  const rows = await db.readTable('Users');
  rows[0].name = 'Scribbled on';
  ok('rows handed out are copies, so one caller cannot change another\'s',
    (await db.readTable('Users'))[0].name === 'Anil Shah');

  console.log('\nBIG ANSWERS ARE COMPRESSED, SMALL ONES ARE NOT');
  const gz = await call('listSpares', [false], { 'Accept-Encoding': 'gzip, deflate, br' });
  const plain = await call('listSpares', [false], {});
  ok('the catalogue goes out gzipped when the browser accepts it', gz.headers['content-encoding'] === 'gzip',
    gz.headers['content-encoding']);
  ok('at a fraction of the size', gz.bytes < plain.bytes / 5, [gz.bytes, plain.bytes]);
  ok('and arrives as exactly the same answer', JSON.stringify(gz.body) === JSON.stringify(plain.body));
  ok('a browser that does not accept gzip gets it plain', !plain.headers['content-encoding']);
  ok('caches are told the answer depends on the encoding', /Accept-Encoding/i.test(gz.headers.vary || ''));
  const small = await call('listProducts', [false], { 'Accept-Encoding': 'gzip' });
  ok('a small answer is not worth compressing', !small.headers['content-encoding'], small.bytes);
  const pageRes = await request('GET', '/', null, { 'Accept-Encoding': 'gzip' });
  ok('the page itself is compressed too', pageRes.headers['content-encoding'] === 'gzip' &&
    /<html/i.test(pageRes.text), pageRes.headers['content-encoding']);

  console.log('\nTHE GOOGLE GATE FINDS ITS OWN SIGN-IN WHEN GOOGLE SENDS THE PERSON BACK');
  // The link stores a state; Google's callback is a separate request that must find it. With
  // a cache per request it never could, and every Google sign-in ended in "expired".
  const link = JSON.parse((await request('POST', '/api/google-link', {})).text).ok;
  const state = link && link.url && (/[?&]state=([^&]+)/.exec(link.url) || [])[1];
  ok('the gate hands out a sign-in link with a state', !!state, link);
  const back = await request('GET', '/?state=' + state + '&error=access_denied');
  ok('the callback recognises it', !/expired or was not started here/.test(back.text), back.text.slice(0, 300));
  ok('and reports what Google actually said', /access_denied/.test(back.text));
  const replay = await request('GET', '/?state=' + state + '&error=access_denied');
  ok('a state is good for one return only', /expired or was not started here/.test(replay.text));

  server.close();
  db.pool.query = realPoolQuery;
  for (const t of TABLES) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
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
