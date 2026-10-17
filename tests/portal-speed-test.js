/**
 * The portal's own functions, run against Postgres, at PIE's size.
 *
 * Everything so far has tested the pieces: the queries match the sheet, the modules convert
 * faithfully, the data loads and verifies. None of it has answered the question PIE actually
 * has, which is whether the thing is quick now. That question cannot be answered by any test
 * of a part — it needs the real entry points, the ones the screens call, running against a
 * real database with a real amount of data in it.
 *
 * So this loads all 42 converted modules into one context, points them at Postgres, puts
 * PIE's volumes in it, and calls the functions that were slow. It is as close to the live
 * portal as anything can be without a browser in front of it.
 *
 * The numbers are a floor, not a promise. This is a unix socket on the same machine; Neon is
 * an internet round trip, and Singapore from Pune is around 60ms. A function making one query
 * pays that once. The ones to watch are any that make many.
 *
 *   DATABASE_URL=postgres://... node tests/portal-speed-test.js
 */
const path = require('path');

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.log('no DATABASE_URL — skipping');
  process.exit(0);
}

const { connect } = require(path.join(__dirname, '..', 'server', 'db.js'));
const { loadPortal } = require(path.join(__dirname, '..', 'server', 'load.js'));

const TENANT = 'speed-test';
const BOSS = { id: 'USR-1', email: 'boss@pie.in', name: 'Boss', role: 'ERP Admin',
  businessStream: 'All', active: 'TRUE' };

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

/**
 * Both numbers, because only reporting the best hides the one that matters.
 *
 * getDashboard came back as 0ms, which is not a measurement of anything — it is the
 * two-minute cache answering the second and third calls. The first call is what somebody
 * waits for when they open the screen; the later ones are what they get while they work.
 * Reporting only the best would have made a cached answer look like a fast one.
 */
async function time(label, fn) {
  const t0 = Date.now();
  let out = await fn();
  const first = Date.now() - t0;
  let best = first;
  for (let i = 0; i < 2; i++) {
    const t = Date.now();
    out = await fn();
    best = Math.min(best, Date.now() - t);
  }
  console.log('  ' + label.padEnd(42) + (first + 'ms').padStart(8) +
    (best === first ? '' : '   then ' + best + 'ms'));
  return out;
}

(async () => {
  const db = connect({ connectionString: URL, tenant: TENANT });

  console.log('Filling a database the size of PIE’s...');
  const tables = ['spares', 'price_list', 'stock_movements', 'quotations', 'quotation_items',
    'customers', 'users', 'sales_orders', 'sales_order_items', 'invoices', 'audit_log',
    'spare_enquiries', 'company_profile', 'config_lists'];
  for (const t of tables) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);

  // Bulk inserts rather than appendRow, which would write an audit row for each of 92,000.
  const bulk = async (table, cols, rows, make) => {
    for (let s = 0; s < rows; s += 1000) {
      const n = Math.min(1000, rows - s);
      const params = [TENANT];
      const tuples = [];
      for (let i = 0; i < n; i++) {
        const v = make(s + i);
        const ph = ['$1'];
        for (const c of cols) { params.push(v[c]); ph.push('$' + params.length); }
        tuples.push('(' + ph.join(',') + ')');
      }
      await db.q('INSERT INTO ' + table + ' (tenant_id,' + cols.join(',') + ') VALUES ' +
        tuples.join(','), params);
    }
  };

  await bulk('spares', ['id', 'part_no', 'description', 'product_group', 'uom', 'gst_pct',
    'active', 'brand'], 13587, (i) => ({
    id: 'SP-' + String(i).padStart(6, '0'), part_no: 'ELG-' + String(100000 + i),
    description: 'Separator element ' + i + ' for screw compressor',
    product_group: ['Airend', 'Filters', 'Separators', 'Hoses'][i % 4],
    uom: 'Nos', gst_pct: 18, active: true, brand: 'ELGI'
  }));
  // Two price levels per part, plus the superseded history PIE actually carries.
  await bulk('price_list', ['id', 'item_type', 'item_id', 'item_code', 'price_level', 'price',
    'currency', 'effective_from', 'effective_to', 'active'], 78486, (i) => {
    const part = i % 13587;
    const gen = Math.floor(i / 27174);            // 0 = current, 1 and 2 = superseded
    return {
      id: 'PRC-' + String(i).padStart(6, '0'), item_type: 'Spare',
      item_id: 'SP-' + String(part).padStart(6, '0'), item_code: 'ELG-' + String(100000 + part),
      price_level: i % 2 === 0 ? 'ELGI' : 'PIE', price: 500 + (i % 90000),
      currency: 'INR',
      effective_from: gen === 0 ? '2026-09-01' : (gen === 1 ? '2026-06-01' : '2026-01-01'),
      effective_to: gen === 0 ? null : (gen === 1 ? '2026-08-31' : '2026-05-31'),
      active: true
    };
  });
  await bulk('stock_movements', ['id', 'item_type', 'item_id', 'movement_type', 'qty',
    'movement_date'], 9000, (i) => ({
    id: 'MOV-' + i, item_type: 'Spare', item_id: 'SP-' + String(i % 13587).padStart(6, '0'),
    movement_type: i % 3 ? 'Dispatch' : 'Inward', qty: i % 3 ? -2 : 10,
    movement_date: '2026-09-01'
  }));
  await bulk('customers', ['id', 'customer_code', 'name', 'active'], 15, (i) => ({
    id: 'CUS-' + i, customer_code: 'C' + i, name: 'Customer ' + i + ' Pvt Ltd', active: true
  }));
  await bulk('quotations', ['id', 'quote_no', 'revision', 'date', 'customer_id',
    'business_stream', 'status', 'grand', 'locked', 'prepared_by'], 31, (i) => ({
    id: 'QT-' + i, quote_no: 'PIE/ELGI/QUOT/26-27/' + (400 + i), revision: 'R0',
    date: '2026-09-20', customer_id: 'CUS-' + (i % 15), business_stream: 'Spare Sales',
    status: ['Draft', 'Sent', 'Won', 'Lost'][i % 4], grand: 10000 + i,
    locked: i % 4 >= 2, prepared_by: 'boss@pie.in'
  }));
  await bulk('quotation_items', ['id', 'quotation_id', 'line_no', 'item_type', 'item_id',
    'item_code', 'qty', 'unit_price', 'tax_pct', 'line_total'], 48, (i) => ({
    id: 'QI-' + i, quotation_id: 'QT-' + (i % 31), line_no: (i % 3) + 1, item_type: 'Spare',
    item_id: 'SP-' + String(i).padStart(6, '0'), item_code: 'ELG-' + (100000 + i),
    qty: 2, unit_price: 1200, tax_pct: 18, line_total: 2400
  }));
  await bulk('audit_log', ['id', 'timestamp', 'user_email', 'action', 'table_name',
    'record_id'], 1259, (i) => ({
    id: 'AUD-' + i, timestamp: new Date().toISOString(), user_email: 'boss@pie.in',
    action: 'Update', table_name: 'Quotations', record_id: 'QT-' + (i % 31)
  }));
  await bulk('users', ['id', 'email', 'name', 'role', 'business_stream', 'active'], 7, (i) => ({
    id: 'USR-' + i, email: i === 1 ? 'boss@pie.in' : 'user' + i + '@pie.in',
    name: 'User ' + i, role: i === 1 ? 'ERP Admin' : 'Sales Coordinator',
    business_stream: 'All', active: true
  }));

  const counts = {};
  for (const t of ['spares', 'price_list', 'stock_movements', 'quotations']) {
    counts[t] = (await db.q('SELECT count(*)::int n FROM ' + t + ' WHERE tenant_id=$1',
      [TENANT])).rows[0].n;
  }
  console.log('  ' + Object.keys(counts).map((k) => k + ' ' + counts[k].toLocaleString())
    .join(', ') + '\n');

  const portal = loadPortal(db, BOSS.email, { quiet: true });
  portal.CURRENT_USER_ = BOSS;

  console.log('WHAT THE SCREENS ACTUALLY CALL');
  const found = await time('suggestSpares("separator")',
    () => portal.suggestSpares('separator element 50', '', ''));
  ok('the spare search finds parts', found && found.length > 0, found && found.length);
  ok('and stops at fifty, as it always did', !found || found.length <= 50, found && found.length);
  ok('with a price on them',
    found && found.some((r) => Number(r.price) > 0), found && found[0]);

  const picker = await time('sparePickerData() — the whole catalogue',
    () => portal.sparePickerData('', 'CUS-1'));
  ok('the picker sends every active part', picker && picker.count === 13587, picker && picker.count);
  ok('and its columns in the agreed order',
    picker && picker.cols[0] === 'id' && picker.cols[1] === 'partNo', picker && picker.cols);

  const groups = await time('listProductGroups()', () => portal.listProductGroups());
  ok('the groups come back', groups && groups.length === 4, groups);

  const quotes = await time('listQuotations()', () => portal.listQuotations({}));
  // Sixteen of the thirty-one, not all of them: the fixture cycles Draft, Sent, Won, Lost and
  // the list leaves out the ones that are finished unless asked. My expectation of 31 was
  // wrong, and the portal was right — worth keeping as an assertion of the real rule.
  ok('open quotations are listed and closed ones are not',
    quotes && quotes.length === 16, quotes && quotes.length);
  const withClosed = await portal.listQuotations({ includeClosed: true });
  ok('and all 31 when asked for the closed ones too',
    withClosed && withClosed.length === 31, withClosed && withClosed.length);

  const one = await time('getQuotation() — one offer with its lines',
    () => portal.getQuotation('QT-1'));
  ok('it has its lines', one && one.items && one.items.length > 0, one && one.items);

  const dash = await time('getDashboard()', () => portal.getDashboard());
  // Its real shape, read off the thing rather than guessed at.
  ok('the dashboard builds', dash && dash.headline && dash.exceptions,
    dash && Object.keys(dash || {}));
  // Empty, and rightly: this fixture has no reorder levels set, no credit holds and no
  // overdue invoices, so there is nothing exceptional to report. An empty list here is the
  // dashboard being correct, not the dashboard being broken.
  ok('with an exceptions list, empty because this data has no exceptions in it',
    dash && Array.isArray(dash.exceptions) && dash.exceptions.length === 0, dash.exceptions);
  ok('and it says when it was built', !!(dash && dash.generatedAt));

  await time('getAvailability() — one part’s stock',
    () => portal.getAvailability('Spare', 'SP-000001'));

  console.log('\nWHAT THEY USED TO COST');
  console.log('  On the sheet the first interaction of a session was 10-15 seconds of cold');
  console.log('  start before any of this ran, and the spare search then read the whole');
  console.log('  catalogue and the whole 78,486-row price list on every keystroke.');
  console.log('  There is no cold start here. Add ~60ms per query for Singapore from Pune.');
  console.log('');
  console.log('  getAvailability used to read the whole movements ledger twice, for one');
  console.log('  part, and sum it in JavaScript. server/queries/stock.js makes it two');
  console.log('  indexed lookups, so its cost no longer grows with the ledger. Nothing on');
  console.log('  this list reads a table whole now except the picker, which is meant to.');

  for (const t of tables) await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
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
