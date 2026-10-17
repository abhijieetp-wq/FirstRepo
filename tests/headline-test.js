/**
 * The check that decides whether a cutover is accepted.
 *
 * import.js proves the rows arrived. This prints what the portal believes about them, to
 * be read next to the Sheet before anybody is switched over — so the one thing it must
 * never do is report a confident zero. A wrong tenant, a database nothing was loaded
 * into, a column that will not sum: each of those produced a tidy page of noughts in the
 * first version, and a page of noughts looks like an answer.
 *
 *   DATABASE_URL=postgres://... node tests/headline-test.js
 */
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.log('no DATABASE_URL — skipping'); process.exit(0); }

const { connect } = require(path.join(__dirname, '..', 'server', 'db.js'));
const TENANT = 'headline-test';
const SCRIPT = path.join(__dirname, '..', 'migration', 'headline.js');

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};
const run = (args) => execFileSync(process.execPath, [SCRIPT].concat(args),
  { encoding: 'utf8', env: Object.assign({}, process.env, { DATABASE_URL: URL_ }),
    maxBuffer: 32 * 1024 * 1024 });

(async () => {
  const db = connect({ connectionString: URL_, tenant: TENANT });
  const wipe = ['customers', 'quotations', 'invoices', 'receipts', 'spares', 'price_list',
    'company_profile', 'audit_log', 'sessions', 'users'];
  for (const t of wipe) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);

  console.log('AN EMPTY DATABASE SAYS SO, RATHER THAN REPORTING NOUGHTS');
  const empty = run(['--tenant', TENANT]);
  ok('it says every tab is empty', /EVERY TAB IS EMPTY/.test(empty), empty.slice(0, 120));
  ok('and names the tenant it looked under',
    empty.indexOf('"' + TENANT + '"') !== -1);
  // The likeliest cause by far, and the one that looks most like a real answer.
  ok('and points at the tenant as the likely reason', /--tenant/.test(empty));

  console.log('\nAND A LOADED ONE REPORTS WHAT IS IN IT');
  await db.appendRow('CompanyProfile', { id: 'CO-1', appName: 'Premier India Enterprise' });
  for (let i = 0; i < 7; i++) {
    await db.appendRow('Customers', { id: 'CU-' + i, customerCode: 'C' + i,
      name: 'Customer ' + i, active: 'TRUE' });
  }
  // Values chosen so a transposition or a dropped row changes the total visibly.
  const quotes = [125000, 340000, 97500];
  for (let i = 0; i < quotes.length; i++) {
    await db.appendRow('Quotations', { id: 'QT-' + i, quoteNo: 'Q/' + i, revision: 'R0',
      businessStream: 'Spare Sales', customerId: 'CU-0', status: 'Submitted',
      date: '2026-10-01', grand: quotes[i] });
  }
  await db.appendRow('Spares', { id: 'SP-1', partNo: 'ELG-1', description: 'Separator',
    productGroup: 'RCD Spares', uom: 'Nos', active: 'TRUE' });

  const out = run(['--tenant', TENANT]);
  ok('the row counts are right',
    /Customers\s+7/.test(out) && /Quotations\s+3/.test(out), out.match(/Customers.*|Quotations.*/g));
  // 12 rows written, and 12 audit rows written with them — appendRow records every insert,
  // so the audit trail is part of what a cutover carries and part of what is counted.
  ok('the audit trail is counted too', /AuditLog\s+12/.test(out),
    (out.match(/AuditLog.*/) || [])[0]);
  ok('and the total is everything', /\s24\s+total/.test(out), (out.match(/.*total.*/) || [])[0]);
  // 125000 + 340000 + 97500 = 562500, in Indian grouping.
  ok('money is summed, and grouped the way PIE reads it',
    out.indexOf('₹5,62,500') !== -1, (out.match(/quotation value.*/) || [])[0]);
  ok('and the Control Tower figures are built, not skipped',
    /WHAT THE CONTROL TOWER WOULD SHOW/.test(out) && !/could not be built/.test(out),
    (out.match(/could not be built.*/) || [])[0]);
  ok('no column quietly failed to sum', !/MISSING/.test(out),
    (out.match(/.*MISSING.*/g) || []).slice(0, 3));

  console.log('\nTWO RUNS CAN BE COMPARED, WHICH IS HOW A REHEARSAL IS CHECKED');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headline-'));
  const before = path.join(dir, 'before.json');
  fs.writeFileSync(before, run(['--tenant', TENANT, '--json']));
  ok('--json is machine-readable', !!JSON.parse(fs.readFileSync(before, 'utf8')).counts);

  let same = '';
  try { same = run(['--tenant', TENANT, '--compare', before]); }
  catch (e) { same = 'EXITED NONZERO: ' + (e.stdout || ''); }
  ok('an unchanged database compares clean', /Nothing moved/.test(same), same.slice(0, 160));

  await db.appendRow('Quotations', { id: 'QT-X', quoteNo: 'Q/X', revision: 'R0',
    businessStream: 'Spare Sales', customerId: 'CU-0', status: 'Submitted',
    date: '2026-10-02', grand: 1000 });
  let moved = '', exited = 0;
  try { moved = run(['--tenant', TENANT, '--compare', before]); }
  catch (e) { moved = e.stdout || ''; exited = e.status; }
  ok('and one extra row is caught', /Quotations/.test(moved) && /figure\(s\) moved/.test(moved),
    moved.slice(0, 200));
  ok('with the money moving too', /quotation value/.test(moved));
  // So it can be used in a script that must stop when something differs.
  ok('and it exits non-zero when something moved', exited === 1, exited);

  fs.rmSync(dir, { recursive: true, force: true });
  for (const t of wipe) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  await db.pool.end();

  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + e.message); console.log(e.stack.split('\n').slice(1,4).join('\n')); process.exit(1); });
