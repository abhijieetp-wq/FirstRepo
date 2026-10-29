/**
 * The Ask bar through the real server, end to end: off on /health and in the bootstrap without
 * ANTHROPIC_API_KEY; with the service handed in, /health says so, the bootstrap shows the bar,
 * a request goes through /api/call to the service and back as actions, and the ticked ones are
 * done through the portal's own saves. Claude is stood in for; nothing leaves the machine.
 *
 * People are invented.
 *
 *   DATABASE_URL=postgres://... node tests/ai-server-test.js
 */
const path = require('path');

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.log('no DATABASE_URL — skipping (set it to run these against a real Postgres)');
  process.exit(0);
}
const R = path.join(__dirname, '..');
const { connect } = require(path.join(R, 'server', 'db.js'));
const { loadPortal } = require(path.join(R, 'server', 'load.js'));
const { build } = require(path.join(R, 'server', 'index.js'));
const { syncSchema } = require(path.join(R, 'server', 'schema-sync.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : ''));
};

const TENANT = 'ai-server-test';

(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const db = connect({ connectionString: URL_, tenant: TENANT });
  await syncSchema(db, () => {});
  const clean = async () => {
    for (const t of ['users', 'sessions', 'audit_log', 'company_profile', 'tasks']) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  };
  await clean();
  await db.appendRow('CompanyProfile', { id: 'CO-1', appName: 'Premier India Enterprise' });
  await db.appendRow('Users', { id: 'U-1', username: 'boss', email: 'boss@pie.in', name: 'Anil Shah', role: 'Management', businessStream: 'All', active: 'TRUE' });
  await db.appendRow('Users', { id: 'U-2', username: 'priya', email: 'priya@pie.in', name: 'Priya Deshmukh', role: 'Sales Coordinator', businessStream: 'All', active: 'TRUE' });
  const setup = loadPortal(db, 'setup', { quiet: true });
  setup.CURRENT_USER_ = { email: 'setup@pie.in', role: 'ERP Admin' };
  const said = String(await setup.createSignInPasswords());
  const pw = (login) => (new RegExp('\\b' + login + '\\s+(\\S+)').exec(said) || [])[1];
  for (const id of ['U-1', 'U-2']) await db.updateRowById('Users', 'id', id, { mustChangePassword: 'FALSE' }, 't');
  const today = setup.todayIso_();

  const start = async (ai) => {
    const s = build({ db, tenant: TENANT, ai });
    await s.ready;
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    s.base = 'http://127.0.0.1:' + s.address().port;
    return s;
  };
  const session = (server) => {
    const post = (p, body) => fetch(server.base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return {
      health: async () => (await fetch(server.base + '/health')).json(),
      login: async (u) => ((await (await post('/api/login', { username: u, password: pw(u) })).json()).ok || {}).token,
      call: async (token, fn, args) => (await post('/api/call', { token, fn, args: args || [] })).json()
    };
  };

  console.log('WITHOUT THE KEY');
  let server = await start();
  let s = session(server);
  let h = await s.health();
  ok('/health says it is off, and how to turn it on', h.ai && /^off/.test(h.ai.state) && /ANTHROPIC_API_KEY/.test(h.ai.state), h.ai);
  let boss = await s.login('boss');
  ok('the bootstrap hides the bar', (await s.call(boss, 'bootstrap')).ok.aiCommands === false);
  let r = await s.call(boss, 'proposeAiCommand', ['Remind Priya to call back']);
  ok('and a request says why it cannot', /ANTHROPIC_API_KEY/.test(r.error || ''), r);
  ok('the service is not a door the browser can knock on', !!(await s.call(boss, 'claudePropose_', [{}])).error);
  await new Promise((done) => server.close(done));

  console.log('\nWITH IT');
  const asked = [];
  const stand = { enabled: true, reason: '', model: 'claude-opus-5-5', propose: async (req) => {
    asked.push(req);
    return { reply: 'A task for Priya.', actions: [{ kind: 'task', title: 'Call back Topworth', person: 'Priya', company: '', date: today, area: '', purpose: '',
      details: '', contactName: '', phone: '', model: '', type: '', priority: 'High', screen: '' }] };
  } };
  server = await start(stand);
  s = session(server);
  h = await s.health();
  ok('/health says it is on, and which model', h.ai && h.ai.state === 'ok' && h.ai.model === 'claude-opus-5-5', h.ai);
  boss = await s.login('boss');
  ok('the bootstrap shows the bar', (await s.call(boss, 'bootstrap')).ok.aiCommands === true);
  r = await s.call(boss, 'proposeAiCommand', ['Remind Priya to call back Topworth today, high priority']);
  const a = r.ok && r.ok.actions[0];
  ok('the request reaches the service and comes back as actions', asked.length === 1 && /I am Anil Shah \(Management\)/.test(asked[0].text) &&
    a && a.input.assigneeEmail === 'priya@pie.in' && a.input.priority === 'High', r);
  ok('nothing done yet', (await db.q('SELECT count(*)::int AS n FROM tasks WHERE tenant_id=$1', [TENANT])).rows[0].n === 0);
  r = await s.call(boss, 'applyAiActions', [[{ kind: a.kind, input: a.input }]]);
  ok('done once ticked, through the task save', r.ok && r.ok[0].ok === true && (await db.q('SELECT assignee_email, created_by FROM tasks WHERE tenant_id=$1', [TENANT])).rows
    .some((t) => t.assignee_email === 'priya@pie.in' && t.created_by === 'boss@pie.in'), r);
  ok('signed out, nothing', !!(await s.call(null, 'proposeAiCommand', ['x'])).error && asked.length === 1);
  await new Promise((done) => server.close(done));

  await clean();
  await db.pool.end();
  console.log('\n' + (failures.length ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')' : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + e.message); console.log(e.stack.split('\n').slice(1, 8).join('\n')); process.exit(1); });
