/**
 * A converted module, running for real.
 *
 * The codemod is only worth anything if what comes out the other end works, so this loads
 * `server/modules/GoogleGate.js` — the actual converted file, not a copy — into a vm with
 * the shim's globals, calls the one function that changed, and checks the audit row landed
 * in Postgres.
 *
 * The specific thing being proved is the `await`. Before conversion, `audit_` was a
 * synchronous write and the function returned after it. After conversion it returns a
 * promise, and if the `await` were missing the function would return with the write still
 * in flight — the caller would see success, and the audit row would arrive later or not at
 * all. That is the failure mode this whole exercise has to rule out, and it is invisible
 * unless something checks the database immediately after the call resolves.
 *
 *   DATABASE_URL=postgres://... node tests/converted-test.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.log('no DATABASE_URL — skipping (set it to run these against a real Postgres)');
  process.exit(0);
}

const MODULE = path.join(__dirname, '..', 'server', 'modules', 'GoogleGate.js');
if (!fs.existsSync(MODULE)) {
  console.log('server/modules/GoogleGate.js not built — run migration/to-async.js GoogleGate --write');
  process.exit(1);
}

const { connect } = require(path.join(__dirname, '..', 'server', 'db.js'));
const { globalsFor } = require(path.join(__dirname, '..', 'server', 'shim.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

(async () => {
  const db = connect({ connectionString: URL, tenant: 'test' });
  await db.q("DELETE FROM audit_log WHERE tenant_id = 'test'");

  // The Apps Script globals this module reaches for, faked only where they are platform —
  // never where they are logic. The module's own code is untouched.
  const props = {};
  const sandbox = Object.assign({
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.hasOwnProperty(k) ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; }
      })
    },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/x/exec' }) },
    Utilities: {
      base64Encode: (s) => Buffer.from(String(s)).toString('base64'),
      getUuid: () => 'u-' + Math.random().toString(16).slice(2)
    },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
    HtmlService: { createHtmlOutput: (h) => ({ html: h }) },
    SETTINGS_ROLES: ['ERP Admin'],
    ROLES: { ERP_ADMIN: 'ERP Admin', MANAGEMENT: 'Management' },
    getCurrentUser: () => ({ email: 'boss@pie.in', role: 'ERP Admin',
      googleEmail: 'boss@imcglobal.in' }),
    requireRole_: () => {}
  }, globalsFor(db, 'boss@pie.in'));

  vm.createContext(sandbox);
  const src = fs.readFileSync(MODULE, 'utf8');

  console.log('IT STILL PARSES AND LOADS');
  let loadErr = null;
  try { vm.runInContext(src, sandbox, { filename: 'GoogleGate.js' }); }
  catch (e) { loadErr = e.message; }
  ok('the converted module loads', loadErr === null, loadErr);
  ok('and setGoogleGate is there', typeof sandbox.setGoogleGate === 'function');
  // The codemod's whole job, visible from outside: the function is async now.
  ok('and it is async', sandbox.setGoogleGate.constructor.name === 'AsyncFunction',
    sandbox.setGoogleGate.constructor.name);

  console.log('\nAND THE WRITE REALLY FINISHES BEFORE IT RETURNS');
  props.GOOGLE_GATE_CLIENT_ID = 'x.apps.googleusercontent.com';
  props.GOOGLE_GATE_CLIENT_SECRET = 'secret';
  props.GOOGLE_GATE_ACCOUNTS = 'boss@imcglobal.in';

  let err = null;
  try { await sandbox.setGoogleGate({ enforced: true }); } catch (e) { err = e.message; }
  ok('the call succeeds', err === null, err);
  ok('and the property was set', props.GOOGLE_GATE === 'on', props.GOOGLE_GATE);

  // Read the instant the call resolves. A missing await would leave this empty — and would
  // pass any test that slept first, which is why there is no sleep here.
  const rows = (await db.readTable('AuditLog'))
    .filter((a) => a.tableName === 'GoogleGate');
  ok('the audit row is already in the database', rows.length === 1, rows.length);
  ok('it records the change', rows.length && rows[0].fieldName === 'enforced',
    rows.length && rows[0].fieldName);
  ok('from off to on', rows.length && rows[0].oldValue === 'off' && rows[0].newValue === 'on',
    rows.length && [rows[0].oldValue, rows[0].newValue]);
  // The actor comes from the request, not from the process — the server runs as nobody.
  ok('and who did it', rows.length && rows[0].userEmail === 'boss@pie.in',
    rows.length && rows[0].userEmail);

  console.log('\nAND THE LOGIC AROUND IT IS UNCHANGED');
  // The guards are the valuable part of this module and the codemod must not have touched
  // them. Switching the requirement on from a session with no Google account would end the
  // administrator's own access on the next click.
  const noGoogle = Object.assign({}, sandbox);
  sandbox.getCurrentUser = () => ({ email: 'boss@pie.in', role: 'ERP Admin', googleEmail: '' });
  props.GOOGLE_GATE = 'off';
  let guard = null;
  try { await sandbox.setGoogleGate({ enforced: true }); } catch (e) { guard = e.message; }
  ok('it still refuses to lock you out', /Sign out and sign in again/.test(String(guard)),
    guard);
  ok('and did not switch it on', props.GOOGLE_GATE === 'off', props.GOOGLE_GATE);
  void noGoogle;

  await db.q("DELETE FROM audit_log WHERE tenant_id = 'test'");
  await db.pool.end();

  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.log('CRASHED: ' + e.message);
  console.log(e.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
