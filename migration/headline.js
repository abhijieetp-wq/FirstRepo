/**
 * The numbers PIE would notice if the migration got them wrong.
 *
 * import.js already proves the rows arrived: every row's digest recomputed, every tab's
 * digest recomputed, every column mapped, and every row read back and compared field by
 * field. That is fidelity, and it is the right check — but it is not the question anybody
 * asks on cutover day. The question is "is my outstanding still forty-two lakh".
 *
 * So this reads the loaded database through the portal's own code and prints what the
 * portal itself believes. Not a reimplementation of the arithmetic: getDashboard is the
 * function the Control Tower calls, so if these figures match the Sheet then the screens
 * will too, and if they do not then the difference is real rather than an artefact of a
 * second opinion written for this script.
 *
 * Compare the output against the same figures in the Sheet before switching anybody over.
 *
 *   DATABASE_URL=postgres://... node migration/headline.js [--tenant pie]
 *   DATABASE_URL=postgres://... node migration/headline.js --json > before.json
 *   DATABASE_URL=postgres://... node migration/headline.js --compare before.json
 *
 * The tenant must be the one import.js loaded, or every figure is a confident zero.
 *
 * --compare takes an earlier --json run and shows only what moved, which is how a rehearsal
 * is checked against the load it is meant to reproduce.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { connect, mapFor } = require(path.join(__dirname, '..', 'server', 'db.js'));
const { loadSchema } = require(path.join(__dirname, 'schema.js'));
const { loadPortal } = require(path.join(__dirname, '..', 'server', 'load.js'));

const args = process.argv.slice(2);
const asJson = args.indexOf('--json') !== -1;
const compareTo = (() => {
  const i = args.indexOf('--compare');
  return i === -1 ? null : args[i + 1];
})();

/** Indian grouping, because every figure here is rupees and PIE reads them that way. */
function inr(n) {
  const v = Math.round(Number(n) || 0);
  const s = String(Math.abs(v));
  if (s.length <= 3) return (v < 0 ? '-' : '') + s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return (v < 0 ? '-' : '') + rest + ',' + last3;
}

async function gather(db) {
  // Counts straight from the database, named by the tab they came from so a row in this
  // table can be read next to the tab in the Sheet without translating.
  const schema = loadSchema();
  const counts = {};
  for (const tab of Object.keys(schema)) {
    const table = mapFor(tab).table;
    try {
      const r = await db.q('SELECT count(*)::int AS n FROM ' + table +
        ' WHERE tenant_id = $1', [db.tenant]);
      counts[tab] = r.rows[0].n;
    } catch (err) {
      counts[tab] = 'MISSING: ' + (err.code || err.message);
    }
  }

  // And the figures, through the portal, as Management would see them.
  const portal = loadPortal(db, 'cutover-check', { quiet: true });
  portal.CURRENT_USER_ = { email: 'cutover@check', name: 'Cutover check',
    role: 'Management', businessStream: 'All', username: 'cutover' };

  let headline = null, funnelTotal = null, dashError = null;
  try {
    const dash = await portal.getDashboard({ stream: '', refresh: true });
    headline = dash.headline;
    funnelTotal = (dash.orderPipeline || []).reduce((a, r) => a + (Number(r.count) || 0), 0);
  } catch (err) {
    dashError = err.message;
  }

  // Three sums the dashboard does not carry, and which are the easiest to eyeball against
  // the Sheet: what the catalogue holds, and what it is priced at.
  const extras = {};
  /**
   * Summed through a cast to text and back, with a guard.
   *
   * These columns are NUMERIC where the type could be inferred and TEXT where it could
   * not, and the first version of this assumed text — NULLIF(grand,'') against a numeric
   * column asks Postgres to read '' as a number, which is error 22P02 and reported every
   * money figure as MISSING. Going via text works for either, and the pattern skips a
   * cell holding something that is not a number at all rather than failing the whole sum.
   */
  const money = (col) => "COALESCE(sum(CASE WHEN " + col +
    "::text ~ '^\\s*-?[0-9]+(\\.[0-9]+)?\\s*$' THEN " + col + "::text::numeric END),0)::float8";
  const sums = [
    ['spares on the catalogue', 'SELECT count(*)::int AS v FROM spares WHERE tenant_id = $1'],
    ['price rows', 'SELECT count(*)::int AS v FROM price_list WHERE tenant_id = $1'],
    ['customers', 'SELECT count(*)::int AS v FROM customers WHERE tenant_id = $1'],
    ['quotations, all revisions', 'SELECT count(*)::int AS v FROM quotations WHERE tenant_id = $1'],
    ['quotation value, all of them',
      'SELECT ' + money('grand') + ' AS v FROM quotations WHERE tenant_id = $1'],
    ['invoices', 'SELECT count(*)::int AS v FROM invoices WHERE tenant_id = $1'],
    ['invoiced value', 'SELECT ' + money('grand') + ' AS v FROM invoices WHERE tenant_id = $1'],
    ['receipts', 'SELECT count(*)::int AS v FROM receipts WHERE tenant_id = $1'],
    ['received value', 'SELECT ' + money('amount') + ' AS v FROM receipts WHERE tenant_id = $1']
  ];
  for (const [label, sql] of sums) {
    try { extras[label] = (await db.q(sql, [db.tenant])).rows[0].v; }
    catch (err) { extras[label] = 'MISSING: ' + (err.code || err.message); }
  }

  return { takenAt: new Date().toISOString(), tenant: db.tenant, counts, headline,
    orderCount: funnelTotal, dashError, extras };
}

function show(r) {
  console.log('PIE, as this database has it   (' + r.tenant + ', ' +
    r.takenAt.slice(0, 19).replace('T', ' ') + ' UTC)\n');

  const rows = Object.entries(r.counts).filter(([, n]) => n !== 0);
  if (!rows.length) {
    console.log('EVERY TAB IS EMPTY for tenant "' + r.tenant + '".\n\n' +
      'That is either a database nothing has been loaded into, or the wrong tenant — ' +
      'import.js\ntakes --tenant and defaults to "pie". It is not a finding about the ' +
      'data until the\ntenant is right.\n');
  }
  const empty = Object.entries(r.counts).filter(([, n]) => n === 0).map(([t]) => t);
  console.log('ROWS PER TAB');
  rows.sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));
  for (const [tab, n] of rows) {
    console.log('  ' + String(tab).padEnd(26) + String(n).padStart(9));
  }
  console.log('  ' + String(rows.reduce((a, [, n]) => a + (Number(n) || 0), 0)).padStart(35) +
    '   total');
  if (empty.length) console.log('\n  empty: ' + empty.join(', '));

  console.log('\nWHAT THE CATALOGUE AND THE LEDGERS HOLD');
  for (const [label, v] of Object.entries(r.extras)) {
    const money = /value/.test(label);
    console.log('  ' + label.padEnd(30) +
      (typeof v === 'number' ? (money ? '₹' + inr(v) : String(v)) : v).padStart(18));
  }

  console.log('\nWHAT THE CONTROL TOWER WOULD SHOW');
  if (r.dashError) {
    console.log('  the dashboard could not be built: ' + r.dashError);
  } else {
    const h = r.headline;
    const line = (label, v, money) => console.log('  ' + label.padEnd(30) +
      (money ? '₹' + inr(v) : String(v)).padStart(18));
    line('outstanding', h.outstanding, true);
    line('  of which overdue', h.overdueAmount, true);
    line('  overdue share', (h.overduePct || 0) + '%');
    line('open order book', h.openOrderValue, true);
    line('  orders not yet closed', h.openOrderCount);
    line('invoiced this month', h.invoicedThisMonth, true);
    line('collected this month', h.collectedThisMonth, true);
    line('open quotations', h.openQuotationCount);
    line('  their value', h.openQuotationValue, true);
    line('weighted pipeline', h.weightedPipeline, true);
  }
  console.log('\nCheck these against the same figures in the Sheet before switching anyone over.');
}

function compare(now, then) {
  console.log('WHAT MOVED SINCE ' + then.takenAt.slice(0, 19).replace('T', ' ') + ' UTC\n');
  let differences = 0;
  const check = (label, a, b) => {
    if (String(a) === String(b)) return;
    differences++;
    console.log('  ' + label.padEnd(30) + String(b).padStart(14) + '  ->' +
      String(a).padStart(14));
  };
  for (const tab of new Set(Object.keys(now.counts).concat(Object.keys(then.counts)))) {
    check(tab, now.counts[tab], then.counts[tab]);
  }
  for (const k of new Set(Object.keys(now.extras).concat(Object.keys(then.extras)))) {
    check(k, now.extras[k], then.extras[k]);
  }
  if (now.headline && then.headline) {
    for (const k of Object.keys(now.headline)) check(k, now.headline[k], then.headline[k]);
  }
  console.log(differences
    ? '\n' + differences + ' figure(s) moved. Every one needs a reason before you switch.'
    : '\nNothing moved. The two loads are the same database as far as the portal can tell.');
  return differences;
}

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }
  // --tenant, like import.js, because these two are run one after the other and a figure
  // of zero because the tenant did not match is the most believable wrong answer there is.
  // TENANT_ID is honoured too, because that is what the server reads.
  const at = args.indexOf('--tenant');
  const tenant = (at !== -1 && args[at + 1]) || process.env.TENANT_ID || 'pie';
  const db = connect({ connectionString: url, tenant });
  const now = await gather(db);
  await db.pool.end();

  if (asJson) { process.stdout.write(JSON.stringify(now, null, 2) + '\n'); return; }
  if (compareTo) {
    const then = JSON.parse(fs.readFileSync(compareTo, 'utf8'));
    process.exit(compare(now, then) ? 1 : 0);
  }
  show(now);
})().catch((e) => { console.error(e.message); process.exit(1); });
