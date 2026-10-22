/**
 * Quotations sent through PIE's Gmail over Google's API — connected, sent, surviving a restart,
 * coping with a withdrawn permission, and disconnected — against a fake Google.
 *
 * Railway's Hobby plan blocks SMTP, so this is the only way PIE's quotations leave the server.
 * Every step a person takes is here: an admin presses Connect Gmail, Google sends the browser
 * back, a quotation goes out with its PDF, the server restarts, somebody removes the app in
 * their Google account, and an admin disconnects. Plus the doors: only Management and the ERP
 * admin may touch it, and the address Google returns to cannot be used by anybody who did not
 * start from a signed-in session.
 *
 *   DATABASE_URL=postgres://... node tests/gmail-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.log('no DATABASE_URL — skipping'); process.exit(0); }

const R = path.join(__dirname, '..');
const { connect } = require(path.join(R, 'server', 'db.js'));
const { loadPortal } = require(path.join(R, 'server', 'load.js'));
const { build } = require(path.join(R, 'server', 'index.js'));
const { DDL } = require(path.join(R, 'server', 'settings.js'));

const TENANT = 'gmail-test';
const SENDER = 'admin.premierindia@gmail.com';
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ------------------------------------------------------------- a fake Google
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-gmail-test-'));
  const log = path.join(work, 'google.log');
  fs.writeFileSync(log, '');
  const google = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'fake-google.js'), log],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  const gport = await new Promise((resolve) => google.stdout.once('data', (d) => resolve(String(d).trim())));
  const G = 'http://127.0.0.1:' + gport;
  process.env.GMAIL_AUTH_URL = G + '/auth';
  process.env.GMAIL_TOKEN_URL = G + '/token';
  process.env.GMAIL_SEND_URL = G + '/send';
  process.env.GMAIL_REVOKE_URL = G + '/revoke';
  delete process.env.ERP_BASE_URL;
  delete process.env.SMTP_URL;
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const lastTo = (p) => calls().filter((c) => c.path.startsWith(p)).pop();

  // ------------------------------------------------------------- PIE, with a Google client set
  const db = connect({ connectionString: URL_, tenant: TENANT });
  await db.q(DDL);
  const clean = async () => {
    for (const t of ['users', 'sessions', 'audit_log', 'company_profile', 'settings']) {
      await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
    }
  };
  await clean();
  await db.appendRow('CompanyProfile', { id: 'CO-1', appName: 'Premier India Enterprise' });
  await db.appendRow('Users', { id: 'U-1', username: 'boss', email: 'boss@pie.in', name: 'Anil Shah',
    role: 'ERP Admin', businessStream: 'All', active: 'TRUE' });
  await db.appendRow('Users', { id: 'U-2', username: 'priya', email: 'priya@pie.in', name: 'Priya Deshmukh',
    role: 'Sales Coordinator', businessStream: 'Spare Sales', active: 'TRUE' });
  for (const [k, v] of [['GOOGLE_GATE_CLIENT_ID', '123-abc.apps.googleusercontent.com'],
    ['GOOGLE_GATE_CLIENT_SECRET', 'the-client-secret']]) {
    await db.q('INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3)', [TENANT, k, v]);
  }
  const setup = loadPortal(db, 'setup', { quiet: true });
  setup.CURRENT_USER_ = { email: 'setup@pie.in', role: 'ERP Admin' };
  const said = String(await setup.createSignInPasswords());
  const pw = (login) => (new RegExp('\\b' + login + '\\s+(\\S+)').exec(said) || [])[1];
  for (const id of ['U-1', 'U-2']) await db.updateRowById('Users', 'id', id, { mustChangePassword: 'FALSE' }, 't');

  const start = async () => {
    const s = build({ db, tenant: TENANT });
    await s.ready;
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    s.base = 'http://127.0.0.1:' + s.address().port;
    return s;
  };
  let server = await start();
  const post = (p, body) => fetch(server.base + p, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const tokenFor = async (login) => ((await (await post('/api/login',
    { username: login, password: pw(login) })).json()).ok || {}).token;
  const boss = await tokenFor('boss');
  const email = async (action, token) => {
    const r = await post('/api/email', { token: token === undefined ? boss : token, action });
    const b = await r.json().catch(() => ({}));
    return { status: r.status, ok: b.ok, error: b.error };
  };

  // ------------------------------------------------------------- the door
  console.log('ONLY MANAGEMENT AND THE ERP ADMIN MAY TOUCH IT');
  ok('no session, nothing', (await email('status', null)).status === 401);
  const coord = await email('connect', await tokenFor('priya'));
  ok('a sales coordinator is refused, in words', coord.status === 403 && !!coord.error, coord);

  console.log('\nBEFORE IT IS CONNECTED');
  let st = (await email('status')).ok;
  ok('it says it is not connected', st && st.connected === false && st.using === 'none', st);
  ok('and that the Google client is already there', st.clientConfigured === true, st);
  ok('and names the address to register with Google', st.redirectUri === server.base + '/oauth/gmail',
    st.redirectUri);
  ok('the permission itself is never in what the screen gets', !JSON.stringify(st).includes('REFRESH'));
  const health0 = await (await fetch(server.base + '/health')).json();
  ok('/health says email is not connected, and where to fix it',
    /unconfigured/.test(health0.email.state) && /Connect Gmail/.test(health0.email.state), health0.email);
  let refused = '';
  try { server.mail.sendEmail({ to: 'x@y.com', subject: 's', body: 'b' }); }
  catch (e) { refused = e.message; }
  ok('a quotation email says where to connect, and that the quotation is safe',
    /Connect Gmail/.test(refused) && /saved/.test(refused), refused);

  // ------------------------------------------------------------- connecting
  console.log('\nCONNECT GMAIL SENDS THE BROWSER TO GOOGLE');
  const go = (await email('connect')).ok;
  const to = new URL(go.url);
  const q = Object.fromEntries(to.searchParams);
  ok('to Google’s sign-in', go.url.indexOf(G + '/auth?') === 0, go.url);
  ok('with PIE’s Google client', q.client_id === '123-abc.apps.googleusercontent.com', q.client_id);
  ok('asking only to send email, and who the account is',
    q.scope === 'https://www.googleapis.com/auth/gmail.send openid email', q.scope);
  ok('for a permission that lasts', q.access_type === 'offline' && q.prompt === 'consent', q);
  ok('coming back to the registered address', q.redirect_uri === server.base + '/oauth/gmail');
  ok('with a one-time value', /^[0-9a-f]{48}$/.test(q.state || ''), q.state);

  console.log('\nTHE ADDRESS GOOGLE RETURNS TO CANNOT BE USED BY ANYBODY ELSE');
  let page = await (await fetch(server.base + '/oauth/gmail?code=GOOD&state=' + 'f'.repeat(48))).text();
  ok('a made-up value is refused', /was not connected/.test(page) && /expired or was already used/.test(page));
  ok('and nothing is connected', (await email('status')).ok.connected === false);

  console.log('\nGOOGLE SAYS YES');
  page = await (await fetch(server.base + '/oauth/gmail?code=GOOD&state=' + q.state)).text();
  ok('the page says it is connected, and from which account',
    /Gmail is connected/.test(page) && page.includes(SENDER), page.slice(0, 300));
  ok('with a way back to Settings', /href="\/settings"/.test(page));
  const exchange = lastTo('/token');
  const ex = Object.fromEntries(new URLSearchParams(exchange.body));
  ok('the code was swapped with the client secret, for the same return address',
    ex.grant_type === 'authorization_code' && ex.code === 'GOOD' &&
    ex.client_secret === 'the-client-secret' && ex.redirect_uri === server.base + '/oauth/gmail', ex);
  st = (await email('status')).ok;
  ok('Settings now shows the account, who connected it and when', st.connected === true &&
    st.sender === SENDER && st.connectedBy === 'boss@pie.in' && /^\d{4}-/.test(st.connectedAt), st);
  page = await (await fetch(server.base + '/oauth/gmail?code=GOOD&state=' + q.state)).text();
  ok('and the same link does not work twice', /expired or was already used/.test(page));
  const health1 = await (await fetch(server.base + '/health')).json();
  ok('/health says email works, through Gmail, from which account',
    health1.email.state === 'ok' && health1.email.via === 'gmail' && health1.email.from === SENDER, health1.email);
  await sleep(300);
  const audited = await db.q("SELECT user_email, new_value, reason FROM audit_log WHERE tenant_id = $1 " +
    "AND table_name = 'Email'", [TENANT]);
  ok('the connection is in the audit log, against who made it', audited.rows.length === 1 &&
    audited.rows[0].user_email === 'boss@pie.in' && audited.rows[0].new_value === SENDER, audited.rows);
  const stored = await db.q("SELECT key, value FROM settings WHERE tenant_id = $1 AND key LIKE 'GMAIL_%'", [TENANT]);
  const kept = Object.fromEntries(stored.rows.map((r) => [r.key, r.value]));
  ok('the permission is kept in the settings table, where the export does not reach',
    kept.GMAIL_REFRESH_TOKEN === 'REFRESH-1' && kept.GMAIL_SENDER === SENDER, Object.keys(kept));

  // ------------------------------------------------------------- sending
  console.log('\nA TEST EMAIL, FROM SETTINGS');
  const test = await email('test');
  ok('it goes to the Gmail account itself', test.ok && test.ok.sentTo === SENDER, test);
  let sent = lastTo('/send');
  ok('through Gmail’s upload, as a whole message', sent.contentType === 'message/rfc822' &&
    /^To: admin\.premierindia@gmail\.com/m.test(sent.body) &&
    /^Test from the ERP — quotation emails are working$/.test(Buffer.from(
      (/^Subject: =\?UTF-8\?B\?([^?]+)\?=/m.exec(sent.body) || [])[1] || '', 'base64').toString('utf8')),
    sent.body.slice(0, 300));
  ok('named for the company', /^From: Premier India Enterprise <admin\.premierindia@gmail\.com>/m.test(sent.body),
    sent.body.slice(0, 120));
  ok('with the access token Google gave on connecting', sent.authorization === 'Bearer ACCESS-1');

  console.log('\nA QUOTATION, WITH ITS PDF');
  const PDF = Buffer.from('%PDF-1.4\n% a quotation\n%%EOF\n');
  server.mail.sendEmail({
    to: 'purchase@bharatforge.example', cc: 'boss@pie.in', subject: 'Quotation PIE/ELGI/QUOT/26-27/401',
    body: 'Dear Sir,\nPlease find our offer attached.', name: 'Priya Deshmukh', replyTo: 'office@pie.example',
    attachments: [{ getBytes: () => Array.from(PDF), getName: () => 'PIE-ELGI-QUOT-26-27-401.pdf',
      getContentType: () => 'application/pdf' }]
  });
  sent = lastTo('/send');
  ok('from the office Gmail, under the name of whoever sent it',
    /^From: Priya Deshmukh <admin\.premierindia@gmail\.com>/m.test(sent.body), sent.body.slice(0, 200));
  ok('to the customer, copied, replies to the office',
    /^To: purchase@bharatforge\.example/m.test(sent.body) && /^Cc: boss@pie\.in/m.test(sent.body) &&
    /^Reply-To: office@pie\.example/m.test(sent.body));
  const b64 = (/filename="PIE-ELGI-QUOT-26-27-401\.pdf"\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(sent.body) || [])[1] || '';
  ok('and the PDF arrives byte for byte', Buffer.from(b64.replace(/\s+/g, ''), 'base64').equals(PDF));
  ok('no second token was needed within the hour',
    calls().filter((c) => c.path.startsWith('/token')).length === 1);

  // ------------------------------------------------------------- the screen
  console.log('\nSETTINGS → EMAIL, IN A BROWSER');
  let chromium = null;
  try { ({ chromium } = require(path.join(R, 'node_modules', 'playwright'))); } catch (e) { /* skip */ }
  if (chromium) {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
    const pg = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const errs = [];
    pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto(server.base + '/settings', { waitUntil: 'networkidle' });
    await pg.fill('#signin-email', 'boss');
    await pg.fill('#signin-password', pw('boss'));
    await pg.click('#btn-signin');
    await pg.waitForSelector('#subtab-email', { state: 'visible', timeout: 15000 });
    await pg.$eval('#subtab-email', (b) => b.click());
    await pg.waitForSelector('#btn-em-test', { timeout: 10000 });
    const panel = await pg.innerText('#set-panel');
    ok('it shows the account quotations go from', panel.includes(SENDER), panel.slice(0, 300));
    ok('and who connected it', /Anil Shah/.test(panel), panel.slice(0, 300));
    await pg.$eval('#btn-em-test', (b) => b.click());
    await pg.waitForFunction(() => /Test email sent/.test((document.getElementById('msg-box') || {}).textContent || ''),
      null, { timeout: 15000 }).catch(() => {});
    ok('Send a Test Email says where it went', /Test email sent to admin\.premierindia@gmail\.com/.test(
      await pg.innerText('#msg-box')), await pg.innerText('#msg-box'));
    ok('no script errors', errs.length === 0, errs);
    await browser.close();
  } else {
    console.log('  (playwright not installed — screen not checked)');
  }

  // ------------------------------------------------------------- a restart
  console.log('\nAFTER A RESTART IT IS STILL CONNECTED');
  await new Promise((r) => server.close(r));
  server = await start();
  st = (await email('status', await tokenFor('boss'))).ok;
  ok('the connection was read back from the database', st.connected === true && st.sender === SENDER, st);
  server.mail.sendEmail({ to: 'a@b.example', subject: 'After restart', body: 'x' });
  const renew = Object.fromEntries(new URLSearchParams(lastTo('/token').body));
  ok('a fresh access token is made from the lasting permission',
    renew.grant_type === 'refresh_token' && renew.refresh_token === 'REFRESH-1' &&
    renew.client_secret === 'the-client-secret', renew);
  ok('and used', lastTo('/send').authorization === 'Bearer ACCESS-2', lastTo('/send').authorization);
  server.mail.sendEmail({ to: 'a@b.example', subject: 'Again', body: 'x' });
  ok('and kept for the next message', calls().filter((c) => c.path.startsWith('/token')).length === 2);

  console.log('\nIF SOMEBODY REMOVES THE APP IN THEIR GOOGLE ACCOUNT');
  await db.q("UPDATE settings SET value = 'REVOKED' WHERE tenant_id = $1 AND key = 'GMAIL_REFRESH_TOKEN'", [TENANT]);
  await new Promise((r) => server.close(r));
  server = await start();
  let stopped = '';
  try { server.mail.sendEmail({ to: 'a@b.example', subject: 'x', body: 'x' }); }
  catch (e) { stopped = e.message; }
  ok('sending says so, and what to press', /Connect Gmail again/.test(stopped) && /saved/.test(stopped), stopped);

  console.log('\nDISCONNECT');
  const off = await email('disconnect', await tokenFor('boss'));
  ok('it is no longer connected', off.ok && off.ok.connected === false && off.ok.using === 'none', off);
  ok('and the permission was withdrawn at Google',
    Object.fromEntries(new URLSearchParams(lastTo('/revoke').body)).token === 'REVOKED');
  await sleep(300);
  const left = await db.q("SELECT count(*)::int AS n FROM settings WHERE tenant_id = $1 AND key LIKE 'GMAIL_%'", [TENANT]);
  ok('and nothing of it is left in the settings table', left.rows[0].n === 0, left.rows[0].n);
  const offAudit = await db.q("SELECT user_email FROM audit_log WHERE tenant_id = $1 AND reason LIKE 'Gmail disconnected%'", [TENANT]);
  ok('the disconnection is audited against who did it', offAudit.rows.length === 1 &&
    offAudit.rows[0].user_email === 'boss@pie.in', offAudit.rows);

  console.log('\nGOOGLE’S OTHER ANSWERS');
  const bossNow = await tokenFor('boss');
  let st2 = new URL((await email('connect', bossNow)).ok.url).searchParams.get('state');
  page = await (await fetch(server.base + '/oauth/gmail?code=NOSEND&state=' + st2)).text();
  ok('a connection without the send permission ticked is refused, saying which box',
    /was not connected/.test(page) && /Send email on your behalf/.test(page), page.slice(0, 400));
  st2 = new URL((await email('connect', bossNow)).ok.url).searchParams.get('state');
  page = await (await fetch(server.base + '/oauth/gmail?error=access_denied&state=' + st2)).text();
  ok('pressing Cancel at Google connects nothing, and says so', /told not to allow/.test(page));
  ok('and it is still not connected', (await email('status', bossNow)).ok.connected === false);

  await new Promise((r) => server.close(r));
  google.kill();
  fs.rmSync(work, { recursive: true, force: true });
  await clean();
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
