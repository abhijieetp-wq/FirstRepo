/**
 * The stock queries, checked against the spreadsheet code they replace.
 *
 * The same movements and reservations go into a fake sheet and into Postgres, the original
 * Apps Script function and the new query are asked the same question, and the answers must be
 * identical. The sheet version is the specification: it is what quotations have been showing
 * as "available", and a stock figure that moves by one unit in a migration is a part promised
 * to two customers.
 *
 * The cases are the ones a GROUP BY gets wrong: a part that moved and came back to zero (must
 * be present, as zero), a part that never moved (must be absent), a Product among the Spares,
 * a reservation that was released, a status in the wrong case, a fractional quantity, and the
 * three shapes `onlyIds` arrives in — none, a list, a set — plus the empty list, which means
 * "nothing", not "everything".
 *
 *   DATABASE_URL=postgres://... node tests/stock-sql-test.js
 */
const path = require('path');

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.log('no DATABASE_URL — skipping (set it to run these against a real Postgres)');
  process.exit(0);
}

const { load, reset, table } = require(path.join(__dirname, 'harness.js'));
const { connect } = require(path.join(__dirname, '..', 'server', 'db.js'));
const { loadPortal } = require(path.join(__dirname, '..', 'server', 'load.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};
// Key-sorted JSON, for the same reason as in pricing-sql-test.js: both sides come out of vm
// contexts with their own Object.prototype, and SQL row order is not sheet row order.
const canonical = (v) => {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canonical);
  const out = {};
  Object.keys(v).sort().forEach((k) => { out[k] = canonical(v[k]); });
  return out;
};
const same = (label, got, want) => {
  const a = JSON.stringify(canonical(got));
  const b = JSON.stringify(canonical(want));
  ok(label, a === b, a === b ? undefined : { got: a, want: b });
};

const BOSS = { email: 'boss@pie.in', name: 'Boss', role: 'ERP Admin' };
const TENANT = 'stock-test';

/**
 * SP-1 is the ordinary case: opening, inward, dispatch, adjustment.
 * SP-2 moved and came back to exactly nothing — present, as 0.
 * SP-3 never moved — absent from every map.
 * SP-4 carries fractional quantities that are exact in binary, so both sides can agree.
 * SP-5 has only a return.
 * PR-1 is a Product and must not appear among the Spares, and the other way round.
 */
const MOVES = [
  ['MOV-01', 'Spare', 'SP-1', 'Opening', 10],
  ['MOV-02', 'Spare', 'SP-1', 'Inward', 5],
  ['MOV-03', 'Spare', 'SP-1', 'Dispatch', -3],
  ['MOV-04', 'Spare', 'SP-1', 'Adjustment', -1],
  ['MOV-05', 'Spare', 'SP-2', 'Opening', 5],
  ['MOV-06', 'Spare', 'SP-2', 'Dispatch', -5],
  ['MOV-07', 'Spare', 'SP-4', 'Inward', 2.5],
  ['MOV-08', 'Spare', 'SP-4', 'Dispatch', -0.25],
  ['MOV-09', 'Spare', 'SP-5', 'Return', 1],
  ['MOV-10', 'Product', 'PR-1', 'Opening', 3],
  ['MOV-11', 'Product', 'SP-1', 'Opening', 100]
].map(([id, itemType, itemId, movementType, qty]) => ({
  id, itemType, itemId, itemCode: itemId, movementType, qty,
  movementDate: '2026-10-01', timestamp: '2026-10-01 10:00:00', warehouseId: 'WH-MAIN',
  enteredBy: 'seed', notes: movementType === 'Adjustment' ? 'count' : ''
}));

/**
 * SP-1 has an active reservation and a released one; only the active one counts.
 * SP-2 has an active reservation against stock it no longer has — available goes negative,
 *      which is a real state (over-promised) and must be reported, not floored at zero.
 * SP-4 has a reservation whose status is 'active' in the wrong case. The sheet compared
 *      exactly, so it never counted, and still must not.
 * PR-1 is reserved as a Product.
 */
const RESERVES = [
  ['RES-01', 'Spare', 'SP-1', 4, 'Active'],
  ['RES-02', 'Spare', 'SP-1', 2, 'Released'],
  ['RES-03', 'Spare', 'SP-2', 1, 'Active'],
  ['RES-04', 'Spare', 'SP-4', 1, 'active'],
  ['RES-05', 'Product', 'PR-1', 2, 'Active']
].map(([id, itemType, itemId, qtyReserved, status]) => ({
  id, itemType, itemId, itemCode: itemId, qtyReserved, status, salesOrderId: 'SO-1',
  warehouseId: 'WH-MAIN', reservedBy: 'seed', reservedDate: '2026-10-01'
}));

(async () => {
  // ---------------------------------------------------------------- the sheet side
  const sb = load(['Auth.gs', 'Settings.gs', 'Schema.gs', 'SheetService.gs', 'Stock.gs']);
  sb.CURRENT_USER_ = BOSS;
  reset(sb);
  for (const [tab, rows] of [['StockMovements', MOVES], ['StockReservations', RESERVES]]) {
    const t = table(tab);
    rows.forEach((r) => t.rows.push(t.headers.map((h) => (r[h] === undefined ? '' : r[h]))));
  }

  // ---------------------------------------------------------------- the database side
  const db = connect({ connectionString: URL, tenant: TENANT });
  for (const t of ['stock_movements', 'stock_reservations', 'audit_log']) {
    await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  }
  // Through db.js, so the types the queries meet are the ones the real write path produces.
  for (const m of MOVES) await db.appendRow('StockMovements', m);
  for (const r of RESERVES) await db.appendRow('StockReservations', r);

  const portal = loadPortal(db, BOSS.email, { quiet: true });
  portal.CURRENT_USER_ = BOSS;

  console.log('THE QUERY FILE REPLACED WHAT IT WAS MEANT TO');
  ['stockOnHandMap_', 'stockReservedMap_', 'getAvailability'].forEach((fn) => {
    ok(fn + ' now comes from the query file', portal.__overridden.indexOf(fn) !== -1,
      portal.__overridden);
  });

  console.log('\nTHE WHOLE MAP, BOTH ITEM TYPES');
  for (const type of ['Spare', 'Product']) {
    same('on-hand for every ' + type + ' matches the sheet',
      await portal.stockOnHandMap_(type), sb.stockOnHandMap_(type));
    same('reserved for every ' + type + ' matches the sheet',
      await portal.stockReservedMap_(type), sb.stockReservedMap_(type));
  }

  // Spelled out as well as compared, so a failure names the rule that broke.
  const onHand = await portal.stockOnHandMap_('Spare');
  const reserved = await portal.stockReservedMap_('Spare');
  ok('the ordinary part sums its movements', onHand['SP-1'] === 11, onHand['SP-1']);
  ok('a part that came back to nothing is present, as zero',
    Object.prototype.hasOwnProperty.call(onHand, 'SP-2') && onHand['SP-2'] === 0, onHand);
  ok('a part that never moved is absent, not zero',
    !Object.prototype.hasOwnProperty.call(onHand, 'SP-3'), onHand);
  ok('fractional quantities survive as numbers', onHand['SP-4'] === 2.25, onHand['SP-4']);
  ok('a Product movement is not a Spare one, even under the same id', onHand['SP-1'] === 11);
  ok('a released reservation does not hold stock', reserved['SP-1'] === 4, reserved['SP-1']);
  ok('a status in the wrong case does not count, as it never did',
    !Object.prototype.hasOwnProperty.call(reserved, 'SP-4'), reserved);
  ok('the totals are numbers, not the strings NUMERIC arrives as',
    typeof onHand['SP-1'] === 'number' && typeof reserved['SP-1'] === 'number');

  console.log('\nNARROWED TO A FEW IDS, IN EVERY SHAPE THE CALLERS USE');
  const shapes = [
    ['a list', ['SP-1', 'SP-3']],
    ['a set keyed by id — SpareEnquiries passes this', { 'SP-1': true, 'SP-2': true }],
    ['ids that are not there', ['SP-99']],
    ['the same id twice', ['SP-1', 'SP-1']],
    ['an empty list, which asks for nothing rather than everything', []]
  ];
  for (const [what, ids] of shapes) {
    same('on-hand for ' + what, await portal.stockOnHandMap_('Spare', ids),
      sb.stockOnHandMap_('Spare', ids));
    same('reserved for ' + what, await portal.stockReservedMap_('Spare', ids),
      sb.stockReservedMap_('Spare', ids));
  }

  console.log('\nGETAVAILABILITY, ONE PART AT A TIME');
  const ASK = [['Spare', 'SP-1'], ['Spare', 'SP-2'], ['Spare', 'SP-3'], ['Spare', 'SP-4'],
    ['Spare', 'SP-5'], ['Product', 'PR-1'], ['Product', 'SP-1'], ['Spare', 'SP-404']];
  for (const [type, id] of ASK) {
    same('getAvailability(' + type + ', ' + id + ') matches the sheet',
      await portal.getAvailability(type, id), sb.getAvailability(type, id));
  }
  const sp1 = await portal.getAvailability('Spare', 'SP-1');
  ok('available is on-hand less reserved', sp1.onHand === 11 && sp1.reserved === 4 &&
    sp1.available === 7, sp1);
  const sp2 = await portal.getAvailability('Spare', 'SP-2');
  ok('an over-promised part reports negative availability rather than hiding it',
    sp2.available === -1, sp2);
  const never = await portal.getAvailability('Spare', 'SP-404');
  ok('a part nobody has heard of is all zeros, not an error',
    never.onHand === 0 && never.reserved === 0 && never.available === 0, never);

  console.log('\nAND IT ASKS FOR ONE PART, NOT ALL OF THEM');
  // The point of the change. Counting rows handed back is a better witness than a timing,
  // which on a fixture this size measures the connection rather than the query.
  const seen = [];
  const realQ = db.q;
  db.q = function (sql, params) { seen.push({ sql: String(sql), params }); return realQ.apply(db, arguments); };
  await portal.getAvailability('Spare', 'SP-1');
  db.q = realQ;
  const stockReads = seen.filter((s) => /stock_(movements|reservations)/.test(s.sql));
  ok('two queries, one per table', stockReads.length === 2, stockReads.map((s) => s.sql));
  ok('each narrowed to the one id asked about',
    stockReads.every((s) => /ANY\(\$3\)/.test(s.sql) &&
      JSON.stringify(s.params[2]) === '["SP-1"]'), stockReads.map((s) => s.params));
  ok('and neither reads a table whole', stockReads.every((s) => /GROUP BY item_id/.test(s.sql)));

  console.log('\nTHE ONE DELIBERATE DIFFERENCE: DECIMALS ADD UP');
  // The sheet summed doubles; NUMERIC sums exactly. Pinned so that nobody "restores" the
  // sheet's answer, which was 0.30000000000000004 litres.
  await db.appendRow('StockMovements', Object.assign({}, MOVES[0], { id: 'MOV-F1', itemId: 'OIL', qty: 0.1 }));
  await db.appendRow('StockMovements', Object.assign({}, MOVES[0], { id: 'MOV-F2', itemId: 'OIL', qty: 0.2 }));
  const oil = await portal.stockOnHandMap_('Spare', ['OIL']);
  ok('0.1 + 0.2 is 0.3 on the database', oil.OIL === 0.3, oil.OIL);

  console.log('\nAND IT STILL CHECKS WHO IS ASKING');
  // getCurrentUser() is the first line of the original and the only access control the
  // function has. Dropping it in a rewrite would make stock readable without signing in.
  const anon = loadPortal(db, '', { quiet: true });
  let refused = null;
  try { await anon.getAvailability('Spare', 'SP-1'); } catch (e) { refused = e.message; }
  ok('a caller nobody signed in is refused', refused !== null, refused);
  ok('and refused for that reason, not for some other failure on the way',
    /sign|session|user|access/i.test(String(refused)), refused);

  for (const t of ['stock_movements', 'stock_reservations', 'audit_log']) {
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
