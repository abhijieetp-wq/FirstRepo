/**
 * The portal over HTTP: the page, the one door, and everything that must be refused at it.
 *
 * This is the surface PIE's browsers will reach, and the only part of the system a stranger
 * could reach too. So most of what is here is refusals rather than successes — a server that
 * serves the right page is easy, and a server that refuses the right things is the one worth
 * testing.
 *
 * It starts a real server on a port the operating system picks and stops it again, rather
 * than assuming one is running on 3000. Starting a listener as a side effect of loading a
 * file is how a suite ends up with four servers fighting over one port, which happened while
 * this was being written and cost twenty minutes of testing the previous version of the code
 * without noticing.
 *
 *   DATABASE_URL=postgres://... node tests/server-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.log('no DATABASE_URL — skipping');
  process.exit(0);
}

const { connect } = require(path.join(__dirname, '..', 'server', 'db.js'));
const { loadPortal } = require(path.join(__dirname, '..', 'server', 'load.js'));
const { build } = require(path.join(__dirname, '..', 'server', 'index.js'));

const TENANT = 'http-test';
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

(async () => {
  const db = connect({ connectionString: URL_, tenant: TENANT });
  for (const t of ['users', 'sessions', 'company_profile', 'spares', 'audit_log',
    'price_list', 'sales_orders', 'documents']) {
    await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  }
  await db.appendRow('CompanyProfile', { id: 'CO-1', appName: 'Premier India Enterprise ERP' });
  await db.appendRow('Spares', { id: 'SP-1', partNo: 'ELG-100001',
    description: 'Separator element', productGroup: 'Separators', uom: 'Nos', active: 'TRUE' });
  await db.appendRow('Users', { id: 'USR-1', username: 'boss', email: 'boss@pie.in',
    name: 'Boss', role: 'ERP Admin', businessStream: 'All', active: 'TRUE' });
  await db.appendRow('SalesOrders', { id: 'SO-1', orderNo: 'SO2610-0001',
    businessStream: 'Spare Sales', customerId: 'CU-1', orderStatus: 'Material Pending' });

  // A real password, derived the way the portal derives them.
  const setup = loadPortal(db, 'setup', { quiet: true });
  setup.CURRENT_USER_ = { email: 'setup@pie.in', role: 'ERP Admin' };
  const said = await setup.createSignInPasswords();
  const password = (/boss\s+(\S+)/.exec(String(said)) || [])[1];
  ok('a user exists with a password', !!password);

  const FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-server-test-'));
  const server = build({ db, tenant: TENANT, filesDir: FILES });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const get = async (p) => {
    const r = await fetch(base + p);
    return { status: r.status, text: await r.text() };
  };
  const post = async (p, obj) => {
    const r = await fetch(base + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: typeof obj === 'string' ? obj : JSON.stringify(obj)
    });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* not json, which is itself a finding */ }
    return { status: r.status, body, text };
  };

  console.log('IT SERVES THE PORTAL');
  const page = await get('/');
  ok('the page comes back', page.status === 200, page.status);
  ok('with the stylesheet in it', /<style/.test(page.text));
  ok('and the application code', /<script/.test(page.text));
  // Apps Script assembled these three files with its own templating; nothing of that
  // survives, so a leftover tag would be visible on screen.
  ok('and no template tags left behind', !/<\?/.test(page.text),
    (page.text.match(/<\?[^>]{0,40}/g) || []).slice(0, 3));
  ok('named from the company profile, not from the markup',
    /<title>Premier India Enterprise ERP<\/title>/.test(page.text),
    (page.text.match(/<title>[^<]*/) || [])[0]);
  ok('and it is the whole thing, not a fragment', page.text.length > 300000,
    Math.round(page.text.length / 1024) + ' KB');

  const health = await get('/health');
  ok('the health check answers', health.status === 200, health.status);
  ok('and says it reached the database', /"ok":true/.test(health.text), health.text);
  // One request has to answer "did that deployment work", because four of this portal's
  // capabilities live outside the database and each one otherwise fails at the moment
  // somebody tries to use it.
  const h = JSON.parse(health.text);
  ok('it names the build', /^\d{4}-\d{2}-\d{2}\./.test(h.build || ''), h.build);
  ok('and which face it is serving', ['web', 'classic', 'v2'].indexOf(h.look) !== -1, h.look);
  ok('it reports the attachments directory', h.attachments && h.attachments.state === 'ok',
    h.attachments);
  ok('whether it can make PDFs', !!h.pdfs && typeof h.pdfs.state === 'string', h.pdfs);
  ok('whether it can send e-mail', /unconfigured|ok/.test((h.email || {}).state || ''), h.email);
  ok('whether Tally is set up', /unconfigured|ok/.test((h.tally || {}).state || ''), h.tally);
  ok('and whether a Google account is demanded', h.googleGate === 'off' || h.googleGate === 'demanded',
    h.googleGate);
  // A missing mailbox must not fail the check: a host would restart a working server for ever.
  ok('an unconfigured capability does not make it unhealthy', h.ok === true, h);

  console.log('\nAND IT SERVES ITS OWN TYPEFACES');
  // The stylesheet used to pull three families from fonts.googleapis.com on every load.
  // They are served from here now, so this is the check that they are actually reachable —
  // a 404 would not break the page, it would quietly drop it back to the system font and
  // nobody would notice until PIE asked why it looks different on their machine.
  const font = await fetch(base + '/fonts/inter-latin-var.woff2');
  ok('a font comes back', font.status === 200, font.status);
  ok('as a font', font.headers.get('content-type') === 'font/woff2',
    font.headers.get('content-type'));
  ok('cached for good, because the name changes when the file does',
    /immutable/.test(font.headers.get('cache-control') || ''),
    font.headers.get('cache-control'));
  // The first four bytes of a woff2 file are the signature. Serving the right length of
  // the wrong thing is exactly the failure a status code will not show.
  const sig = Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString('latin1');
  ok('and it is really a woff2', sig === 'wOF2', sig);

  const everyFace = await Promise.all(
    ['inter-latin-var', 'plexmono-latin-400', 'plexmono-latin-600']
      .map((n) => fetch(base + '/fonts/' + n + '.woff2').then((r) => r.status)));
  ok('every face the stylesheet names is there', everyFace.every((x) => x === 200), everyFace);

  // The name is matched against a pattern rather than cleaned, so there is no traversal to
  // get right — but the pattern is the whole defence, which makes it worth a test.
  const missing = await get('/fonts/not-a-font.woff2');
  ok('a font that is not there is a 404', missing.status === 404, missing.status);
  const escaped = await get('/fonts/%2e%2e%2f%2e%2e%2fserver%2fdb.js');
  ok('and an escaped path out of the folder is refused', escaped.status === 404, escaped.status);
  ok('without saying what it looked for',
    !/db\.js|assets|fonts\//.test(escaped.text), escaped.text);
  const posted = await post('/fonts/inter-latin-var.woff2', {});
  ok('and a POST to it is not a thing', posted.status === 404, posted.status);

  console.log('\nAND IT WEARS THE NEW DESIGN, WITH THE OLD ONE A SWITCH AWAY');
  // The new design is web/Stylesheet.html and web/Shell.html over the same markup and
  // behaviour. ERP_UI=classic serves exactly what Apps Script serves, from the same files,
  // so the new look can be switched off in a minute without a deployment.
  ok('the page carries the new shell', /function buildPalette/.test(page.text));
  ok('and the new stylesheet, not the one Apps Script serves',
    /\.ws-bar\{/.test(page.text) && !/fonts\.googleapis\.com\/css2/.test(page.text));
  ok('and the heading face it names is here to be fetched',
    (await fetch(base + '/fonts/jakarta-latin-var.woff2')).status === 200);
  const classicServer = build({ db, tenant: TENANT, ui: 'classic' });
  await new Promise((r) => classicServer.listen(0, '127.0.0.1', r));
  const classic = await (await fetch('http://127.0.0.1:' + classicServer.address().port + '/')).text();
  await new Promise((r) => classicServer.close(r));
  ok('switched to classic, the shell is gone', !/function buildPalette/.test(classic));
  ok('and the stylesheet is the one Apps Script serves, byte for byte',
    classic.indexOf(fs.readFileSync(path.join(__dirname, '..', 'src', 'Stylesheet.html'), 'utf8')) !== -1);
  ok('with the same behaviour underneath', classic.indexOf(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'JavaScript.html'), 'utf8')) !== -1 &&
    page.text.indexOf(fs.readFileSync(path.join(__dirname, '..', 'src', 'JavaScript.html'), 'utf8')) !== -1);

  console.log('\nAND ERP 2.0 IS A THIRD LOOK OVER THE SAME PORTAL');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const is2 = (html) => html.indexOf(read('web2/Theme.html')) !== -1 && html.indexOf(read('web2/Shell.html')) !== -1;
  ok('not served unless asked for', !is2(page.text));
  const v2Server = build({ db, tenant: TENANT, ui: 'v2' });
  await new Promise((r) => v2Server.listen(0, '127.0.0.1', r));
  const v2Base = 'http://127.0.0.1:' + v2Server.address().port;
  const v2 = await (await fetch(v2Base + '/')).text();
  ok('ERP_UI=v2 serves its theme and its shell', is2(v2));
  ok('over the new design and the same behaviour, byte for byte', v2.indexOf(read('web/Stylesheet.html')) !== -1 &&
    v2.indexOf(read('web/Shell.html')) !== -1 && v2.indexOf(read('src/JavaScript.html')) !== -1);
  ok('the theme after the stylesheet, so its tokens win', v2.indexOf(read('web2/Theme.html')) > v2.indexOf(read('web/Stylesheet.html')));
  ok('the 2.0 shell after the shell it builds on', v2.indexOf(read('web2/Shell.html')) > v2.indexOf(read('web/Shell.html')));
  ok('and the health check says which look', JSON.parse(await (await fetch(v2Base + '/health')).text()).look === 'v2');
  await new Promise((r) => v2Server.close(r));
  const fonts2 = await Promise.all(['archivo-latin-var', 'plexsans-latin-400', 'plexsans-latin-500', 'plexsans-latin-600',
    'plexsans-latin-700'].map((n) => fetch(base + '/fonts/' + n + '.woff2').then((r) => r.status)));
  ok('the faces 2.0 names are here to be fetched', fonts2.every((x) => x === 200), fonts2);

  console.log('\nAND ONE BROWSER CAN TRY IT WITHOUT ANYBODY ELSE SEEING IT');
  const tried = await fetch(base + '/quotations?look=2');
  const cookie = tried.headers.get('set-cookie') || '';
  ok('?look=2 serves 2.0', is2(await tried.text()));
  ok('and remembers it for this browser only', /^erp_look=v2;/.test(cookie) && /HttpOnly/.test(cookie) &&
    /SameSite=Lax/.test(cookie) && /Path=\//.test(cookie), cookie);
  ok('the next page in that browser is 2.0 too', is2(await (await fetch(base + '/customers', { headers: { cookie: 'erp_look=v2' } })).text()));
  ok('another browser still gets the current look', !is2(await (await fetch(base + '/customers')).text()));
  const back = await fetch(base + '/?look=web', { headers: { cookie: 'erp_look=v2' } });
  ok('?look=web goes back', !is2(await back.text()) && /^erp_look=web;/.test(back.headers.get('set-cookie') || ''));
  const forget = await fetch(base + '/?look=default', { headers: { cookie: 'erp_look=v2' } });
  ok('?look=default forgets the choice', !is2(await forget.text()) && /Max-Age=0/.test(forget.headers.get('set-cookie') || ''),
    forget.headers.get('set-cookie'));
  ok('a cookie naming no look is ignored', !is2(await (await fetch(base + '/', { headers: { cookie: 'erp_look=<script>' } })).text()));
  ok('and the same address with no ?look sets nothing', !(await fetch(base + '/')).headers.get('set-cookie'));

  console.log('\nAND SIGNING IN WORKS');
  const login = await post('/api/login', { username: 'boss', password });
  ok('a correct password is accepted', login.status === 200, login.status);
  const token = login.body && login.body.ok && login.body.ok.token;
  ok('and hands back a token', !!token);
  ok('and who it belongs to', login.body.ok.user.name === 'Boss', login.body.ok.user);
  // The hash must never leave the server, whatever else does.
  ok('and nothing resembling a password comes back with it',
    !/passwordHash|passwordSalt/.test(login.text), login.text.slice(0, 120));

  console.log('\nAND THE ONE DOOR CARRIES THE WHOLE PORTAL');
  const boot = await post('/api/call', { token, fn: 'bootstrap', args: [] });
  ok('bootstrap answers', boot.status === 200, boot.status);
  ok('with the application name', boot.body.ok.appName === 'Premier India Enterprise ERP',
    boot.body.ok.appName);
  ok('the signed-in user', boot.body.ok.role === 'ERP Admin', boot.body.ok.role);
  ok('and which build is running', !!boot.body.ok.build, boot.body.ok.build);

  const search = await post('/api/call',
    { token, fn: 'suggestSpares', args: ['separator', '', ''] });
  ok('a real query runs', search.status === 200, search.status);
  ok('and finds the part', search.body.ok.length === 1, search.body.ok);

  console.log('\nAND REFUSES WHAT IT MUST');
  // The portal's own `call` enforces these; this proves the HTTP layer did not get in
  // front of them or around them.
  const cases = [
    ['no token at all', { fn: 'listQuotations', args: [{}] }, 401, /SESSION_ENDED/],
    ['a made-up token', { token: 'nope', fn: 'listQuotations', args: [{}] }, 401, /SESSION_ENDED/],
    ['an editor-only function', { token, fn: 'resetAllSignInPasswords', args: [] }, 400,
      /Unknown action/],
    ['createSignInPasswords too', { token, fn: 'createSignInPasswords', args: [] }, 400,
      /Unknown action/],
    ['the Google gate switch', { token, fn: 'disableGoogleGate', args: [] }, 400,
      /Unknown action/],
    ['a private helper', { token, fn: 'readTable_', args: ['Users'] }, 400, /Unknown action/],
    ['a name that does not exist', { token, fn: 'rm', args: [] }, 400, /Unknown action/],
    ['something off the prototype', { token, fn: 'constructor', args: [] }, 400,
      /Unknown action/]
  ];
  for (const [what, payload, status, pattern] of cases) {
    const r = await post('/api/call', payload);
    ok('refuses ' + what, r.status === status && pattern.test(r.body.error),
      [r.status, r.body && r.body.error]);
  }

  const wrong = await post('/api/login', { username: 'boss', password: 'not it' });
  ok('refuses a wrong password', wrong.status === 401, wrong.status);
  // 401 and not 500: a typo is the portal working, and logging it as a fault makes the log
  // one in which a real fault cannot be seen.
  ok('and says so without calling it a server fault',
    /do not match/.test(wrong.body.error), wrong.body.error);

  const nowhere = await get('/nope');
  ok('an unknown path is a 404', nowhere.status === 404, nowhere.status);
  const broken = await post('/api/call', 'not json at all');
  ok('a body it cannot read is a 400', broken.status === 400, broken.status);

  console.log('\nAND SETTINGS CAN STILL ASK ABOUT THE SCHEMA');
  // Three of Setup.gs's functions are reached at runtime from modules that do convert, so
  // they could not just be left behind with the rest of that file. On a database they answer
  // a better question than they did on a sheet: a column the code expects and the database
  // has not got is a migration somebody did not run.
  const sys = await post('/api/call', { token, fn: 'getSettings', args: [] });
  ok('the Settings screen answers at all', sys.status === 200,
    [sys.status, sys.body && sys.body.error]);
  const system = sys.body && sys.body.ok && sys.body.ok.system;
  ok('and its System panel says where the data lives',
    system && system.storage === 'PostgreSQL', system);
  ok('naming the database and the tenant',
    system && !!system.databaseName && !!system.tenant, system);
  // The connection string carries the password and a settings panel is exactly the kind of
  // screen somebody screenshots. Named precisely rather than matching on "password", which
  // flagged hasPassword, mustChangePassword and passwordSetAt — all three deliberate, all
  // three things the screen needs. A check that cries wolf gets switched off.
  ok('and never the connection string', !/postgres(ql)?:\/\//.test(sys.text),
    sys.text.slice(0, 100));
  ok('nor any user\u2019s stored password',
    !/passwordHash|passwordSalt|passwordIterations/.test(sys.text),
    (sys.text.match(/password\w*/g) || []).slice(0, 6));
  ok('and finds no drift against a correctly built database',
    system && Array.isArray(system.drift) && system.drift.length === 0, system && system.drift);
  const ranSetup = await post("/api/call", { token, fn: "runSetupFromSettings", args: [] });
  ok('"Run Setup" reports rather than reshaping a live database',
    ranSetup.status === 200 && /Nothing to do/.test(JSON.stringify(ranSetup.body)),
    [ranSetup.status, JSON.stringify(ranSetup.body).slice(0, 120)]);

  console.log('\nAND IT HOLDS THE PAPERWORK');
  // Apps Script put these on Drive. There is no Drive, so saveDocument writes to the
  // server's files directory and the row points at /files/<id>. Nothing above this line
  // knows that changed, which is the point.
  const PDF = Buffer.from('%PDF-1.4\n' + 'x'.repeat(2000));
  const saved = await post('/api/call', { token, fn: 'saveDocument', args: [{
    recordType: 'SalesOrder', recordId: 'SO-1', docType: 'Purchase Order',
    name: 'Bhima PO 2210.pdf', dataUrl: 'data:application/pdf;base64,' + PDF.toString('base64') }] });
  ok('a purchase order can be attached', saved.status === 200, saved.body);
  ok('and is recorded with its size', saved.body.ok && saved.body.ok.sizeBytes === PDF.length,
    saved.body.ok);

  const listed = await post('/api/call', { token, fn: 'listDocuments', args: ['SalesOrder', 'SO-1'] });
  const doc = listed.body.ok && listed.body.ok[0];
  ok('it comes back on the record', !!doc, listed.body);
  // The row holds a plain /files/<id>; the signature is added on the way out, so a link is
  // a day old at most when the browser receives it.
  ok('with a signed link', doc && /^\/files\/[0-9a-f]{32}\?t=\d+\.[A-Za-z0-9_-]{32}$/.test(doc.fileUrl),
    doc && doc.fileUrl);
  const stored = await db.q("SELECT file_url FROM documents WHERE tenant_id = $1", [TENANT]);
  ok('and nothing expiring stored in the database',
    /^\/files\/[0-9a-f]{32}$/.test(stored.rows[0].file_url), stored.rows[0]);

  const fetched = await fetch(base + doc.fileUrl);
  const bytes = Buffer.from(await fetched.arrayBuffer());
  ok('the file itself comes back', fetched.status === 200, fetched.status);
  ok('byte for byte', bytes.equals(PDF));
  ok('as a PDF', fetched.headers.get('content-type') === 'application/pdf');
  ok('named, not by its id',
    /filename="Purchase Order SO2610-0001 .*Bhima PO 2210\.pdf"/.test(
      fetched.headers.get('content-disposition') || ''), fetched.headers.get('content-disposition'));
  ok('and never kept by a shared cache',
    /private/.test(fetched.headers.get('cache-control') || ''), fetched.headers.get('cache-control'));

  const bare = await get(doc.fileUrl.split('?')[0]);
  ok('without a signature it is not served', bare.status === 404, bare.status);
  const forged = await get(doc.fileUrl.replace(/\.[A-Za-z0-9_-]{32}$/, '.' + 'A'.repeat(32)));
  ok('nor with a forged one', forged.status === 404, forged.status);
  const stale = await get(doc.fileUrl.split('?')[0] + '?t=1.' + 'A'.repeat(32));
  ok('nor with an expired one', stale.status === 404, stale.status);
  const wandering = await get('/files/..%2f..%2fserver%2fdb.js');
  ok('and a path out of the directory is refused', wandering.status === 404, wandering.status);
  ok('with nothing said about what exists',
    !/db\.js|No such file|\.bin/.test(bare.text + forged.text + wandering.text));

  const removed = await post('/api/call', { token, fn: 'deleteDocument', args: [doc.id] });
  ok('it can be removed', removed.status === 200, removed.body);
  ok('and the link stops working', (await get(doc.fileUrl)).status === 404);
  // Documents.gs calls it a bin, not a delete. The bytes stay until something sweeps them.
  ok('though the bytes are still there to recover',
    fs.readdirSync(path.join(FILES, TENANT)).some((f) => f.endsWith('.bin')),
    fs.readdirSync(path.join(FILES, TENANT)));

  console.log('\nAND DOES NOT LEAK WHAT IT KNOWS');
  const boom = await post('/api/call', { token, fn: 'getQuotation', args: ['no-such-id'] });
  ok('an error message reaches the person', boom.body && !!boom.body.error, boom.body);
  // The message is written for whoever is reading it. The stack names tables and columns
  // and belongs in the server log.
  ok('but the stack does not', !/\bat \w+ \(/.test(boom.text), boom.text.slice(0, 160));

  // A 413 rather than a dropped connection: a dropped connection is indistinguishable from
  // the server having fallen over, which is the wrong thing to tell somebody whose only
  // mistake was a runaway argument.
  let huge = null;
  try {
    huge = await post('/api/call',
      { token, fn: 'bootstrap', args: [], padding: 'x'.repeat(2 * 1024 * 1024) });
  } catch (e) { huge = { status: 'the connection dropped', body: null }; }
  ok('a body past a megabyte is refused with a 413', huge.status === 413, huge.status);
  ok('and said so in words', huge.body && /too large/.test(huge.body.error), huge.body);
  // And the server is still answering afterwards, rather than having been knocked over.
  const after = await get('/health');
  ok('and the server is still up', after.status === 200, after.status);

  await new Promise((r) => server.close(r));
  fs.rmSync(FILES, { recursive: true, force: true });
  for (const t of ['users', 'sessions', 'company_profile', 'spares', 'audit_log', 'price_list',
    'sales_orders', 'documents']) {
    await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  }
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
