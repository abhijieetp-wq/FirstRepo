/**
 * The cutover's settings step: the Google client, the Gmail connection and the Tally address
 * arrive in the new database, no secret is ever printed, and nothing is written until asked.
 *
 * Uses a second, throwaway database beside the local one, because the script's whole job is
 * moving between two databases.
 *
 *   DATABASE_URL=postgres://... node tests/copy-settings-test.js
 */
const path = require('path');
const { execFileSync } = require('child_process');

const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.log('no DATABASE_URL — skipping'); process.exit(0); }

const R = path.join(__dirname, '..');
const { connect } = require(path.join(R, 'server', 'db.js'));
const { build } = require(path.join(R, 'server', 'index.js'));
const { DDL } = require(path.join(R, 'server', 'settings.js'));

const TENANT = 'copy-test';
const SECRET_VALUE = 'GOCSPX-this-must-never-be-printed';
const TOKEN_VALUE = '1//0g-refresh-token-must-never-be-printed';
let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};

(async () => {
  // A second database next to the local one, standing in for erp_live.
  const NEW = 'erp_copy_settings_test';
  const admin = connect({ connectionString: URL_, tenant: TENANT });
  await admin.q('DROP DATABASE IF EXISTS ' + NEW);
  await admin.q('CREATE DATABASE ' + NEW);
  const newUrl = URL_.replace(/\/([A-Za-z0-9_]+)(\?|$)/, '/' + NEW + '$2');
  if (newUrl === URL_) throw new Error('could not make a second connection string from ' + URL_);

  // The old database, as the website left it.
  await admin.q(DDL);
  await admin.q('DELETE FROM settings WHERE tenant_id = $1', [TENANT]);
  const rows = [
    ['GOOGLE_GATE_CLIENT_ID', '676782796496-abc.apps.googleusercontent.com'],
    ['GOOGLE_GATE_CLIENT_SECRET', SECRET_VALUE],
    ['GOOGLE_GATE', 'off'],
    ['GOOGLE_GATE_ACCOUNTS', 'admin.premierindia@gmail.com,engage@imcglobal.in'],
    ['GMAIL_REFRESH_TOKEN', TOKEN_VALUE],
    ['GMAIL_SENDER', 'admin.premierindia@gmail.com'],
    ['GMAIL_CONNECTED_AT', '2026-10-23T10:00:00.000Z'],
    ['GMAIL_CONNECTED_BY', 'boss@pie.in'],
    ['TALLY_ENDPOINT', 'http://10.0.0.5:9000']
  ];
  for (const [k, v] of rows) {
    await admin.q('INSERT INTO settings (tenant_id, key, value, updated_by) VALUES ($1, $2, $3, $4)',
      [TENANT, k, v, 'boss@pie.in']);
  }
  // Not a setting: which build last installed the standard quotation text.
  await admin.q("INSERT INTO settings (tenant_id, key, value) VALUES ($1, 'installedBuild', '2026-10-22.2')",
    [TENANT]);
  await admin.q("INSERT INTO settings (tenant_id, key, value) VALUES ('someone-else', 'TALLY_ENDPOINT', 'x') " +
    'ON CONFLICT DO NOTHING');

  const run = (extra) => {
    try {
      return execFileSync('node', [path.join(R, 'migration', 'copy-settings.js'), '--tenant', TENANT].concat(extra || []),
        { encoding: 'utf8', env: Object.assign({}, process.env, { FROM_DATABASE_URL: URL_, DATABASE_URL: newUrl }) });
    } catch (err) { return 'EXIT ' + err.status + '\n' + err.stdout + err.stderr; }
  };
  const fresh = connect({ connectionString: newUrl, tenant: TENANT });
  const count = async () => {
    try { return (await fresh.q('SELECT count(*)::int AS n FROM settings WHERE tenant_id = $1', [TENANT])).rows[0].n; }
    catch (e) { return 0; }
  };

  console.log('IT LOOKS BEFORE IT WRITES');
  const looked = run();
  ok('lists every setting it would copy', rows.every(([k]) => looked.includes(k)), looked);
  ok('and says nothing was written', /Nothing written/.test(looked), looked.split('\n').slice(-3));
  ok('and nothing was', (await count()) === 0);
  ok('the build stamp is listed as left behind, with the reason',
    /skip\s+installedBuild\s+\(the new database installs/.test(looked), looked);

  console.log('\nNO SECRET IS EVER PRINTED');
  ok('the client secret is not on the screen', !looked.includes(SECRET_VALUE) && !looked.includes('GOCSPX'));
  ok('nor the Gmail permission', !looked.includes(TOKEN_VALUE) && !looked.includes('1//0g'));
  ok('only that they are set', /GOOGLE_GATE_CLIENT_SECRET\s+\(set, \d+ characters — not shown\)/.test(looked), looked);
  ok('ordinary values are shown, so they can be checked',
    looked.includes('admin.premierindia@gmail.com') && looked.includes('http://10.0.0.5:9000'));
  ok('nor the database password', !/:[^:@/\s]+@/.test(looked));

  console.log('\nWITH --write, THEY ARRIVE');
  const wrote = run(['--write']);
  ok('it says how many it copied', /9 setting\(s\) copied/.test(wrote), wrote.split('\n').slice(-3));
  ok('and tells you to switch now', /Switch DATABASE_URL/.test(wrote));
  ok('no secret printed here either', !wrote.includes(SECRET_VALUE) && !wrote.includes(TOKEN_VALUE));
  const got = (await fresh.q('SELECT key, value FROM settings WHERE tenant_id = $1', [TENANT])).rows;
  const map = Object.fromEntries(got.map((r) => [r.key, r.value]));
  ok('every one, exactly', rows.every(([k, v]) => map[k] === v), Object.keys(map));
  const other = (await fresh.q("SELECT count(*)::int AS n FROM settings WHERE tenant_id = 'someone-else'")).rows[0].n;
  ok('and only this tenant’s', other === 0, other);
  ok('but not the build stamp, so the new database installs the standard text it lacks',
    map.installedBuild === undefined, map.installedBuild);

  console.log('\nA SECOND RUN CHANGES NOTHING');
  const again = run(['--write']);
  ok('everything is the same, so nothing is copied', /0 setting\(s\) copied/.test(again) &&
    (again.match(/^\s+same\s/mg) || []).length === 9, again);

  console.log('\nTHE WEBSITE ON THE NEW DATABASE PICKS THEM UP');
  const server = build({ db: fresh, tenant: TENANT, syncSchema: false });
  await server.ready;
  const g = server.gmail.status();
  ok('Gmail is still connected, from the same account, with nobody reconnecting',
    g.connected === true && g.sender === 'admin.premierindia@gmail.com', g);
  ok('and the Google client is there for Connect Gmail and sign-in', g.clientConfigured === true, g);

  console.log('\nIT REFUSES WHAT WOULD BE A MISTAKE');
  let same = '';
  try {
    execFileSync('node', [path.join(R, 'migration', 'copy-settings.js')],
      { encoding: 'utf8', env: Object.assign({}, process.env, { FROM_DATABASE_URL: URL_, DATABASE_URL: URL_ }) });
  } catch (err) { same = String(err.stdout); }
  ok('the same database twice', /same database/.test(same), same);
  let none = '';
  try {
    const env = Object.assign({}, process.env, { DATABASE_URL: newUrl });
    delete env.FROM_DATABASE_URL;
    execFileSync('node', [path.join(R, 'migration', 'copy-settings.js')], { encoding: 'utf8', env });
  } catch (err) { none = String(err.stdout); }
  ok('or no old database named', /FROM_DATABASE_URL/.test(none), none);

  await fresh.pool.end();
  await admin.q('DELETE FROM settings WHERE tenant_id = $1', [TENANT]);
  await admin.q("DELETE FROM settings WHERE tenant_id = 'someone-else'");
  await admin.q('DROP DATABASE IF EXISTS ' + NEW + ' WITH (FORCE)');
  await admin.pool.end();
  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.log('CRASHED: ' + e.message);
  console.log(e.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
