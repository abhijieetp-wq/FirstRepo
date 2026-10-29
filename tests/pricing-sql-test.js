/**
 * The price queries, checked against the spreadsheet code they replace.
 *
 * Not "the SQL returns something sensible". The same price rows are put into a fake sheet and
 * into Postgres, the original Apps Script function and the new query are both asked the same
 * question, and the two answers must be identical — key for key, field for field. The sheet
 * version is the specification: it is what has been quoting PIE's customers, and a migration
 * that changes a price by a rupee or drops a minPrice has broken something nobody will notice
 * until a customer does.
 *
 * The cases are chosen to be the ones effective dating gets wrong: a blank effectiveFrom, a
 * blank effectiveTo, a row marked inactive, two rows overlapping, two rows starting on the
 * same day, a date before anything starts, a date after everything ends. Those are where a
 * rewrite drifts, and a test with one happy path would pass through every one of them.
 *
 *   DATABASE_URL=postgres://... node tests/pricing-sql-test.js
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
/**
 * Deep equality by value, reported as the two values rather than as "false".
 *
 * Not assert.deepStrictEqual, which compares prototypes: both sides of this test come out of
 * `vm` contexts, so an object literal built inside one has a different Object.prototype from
 * one built inside the other and from one built here. deepStrictEqual called every single
 * comparison a failure, `{}` against `{}` included, which is a test that cannot pass rather
 * than a difference worth knowing about. Keys are sorted so insertion order — which is a real
 * difference between a SQL result and a sheet scan, and not one anybody depends on — does not
 * count either.
 */
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

/**
 * The same comparison, with generated ids taken out.
 *
 * After a write, `priceId` is whatever generateId_ invented on each side, so comparing it
 * compares the random number generator. Everything else about the row — the price, the
 * window, the floor, the discount ceiling — still has to match exactly.
 */
const stripIds = (v) => {
  const out = JSON.parse(JSON.stringify(canonical(v)));
  Object.keys(out).forEach((id) => {
    Object.keys(out[id]).forEach((level) => { delete out[id][level].priceId; });
  });
  return out;
};
const sameButIds = (label, got, want) => {
  const a = JSON.stringify(stripIds(got));
  const b = JSON.stringify(stripIds(want));
  ok(label, a === b, a === b ? undefined : { got: a, want: b });
};

const BOSS = { email: 'boss@pie.in', name: 'Boss', role: 'ERP Admin' };

/**
 * The price rows both sides get. Columns named as the portal names them.
 *
 * SP-1 is the ordinary case: one price, open-ended.
 * SP-2 is superseded: an old row closed yesterday and a new one from today.
 * SP-3 carries a minPrice and a maxDiscountPct, which must survive as numbers and not as ''.
 * SP-4 is inactive and must never appear.
 * SP-5 has a blank effectiveFrom — in force from the beginning of time.
 * SP-6 has two rows starting on the SAME day, which is the tie-break.
 * SP-7 is in the future and must not appear today.
 * SP-8 expired last month.
 * PR-1 is a Product, so it must not show up in a Spare query.
 */
const PRICES = [
  { id: 'PRC-01', itemType: 'Spare', itemId: 'SP-1', itemCode: 'P1', priceLevel: 'PIE',
    price: 100, effectiveFrom: '2026-01-01', effectiveTo: '', active: 'TRUE' },
  { id: 'PRC-02', itemType: 'Spare', itemId: 'SP-1', itemCode: 'P1', priceLevel: 'ELGI',
    price: 90, effectiveFrom: '2026-01-01', effectiveTo: '', active: 'TRUE' },

  { id: 'PRC-03', itemType: 'Spare', itemId: 'SP-2', itemCode: 'P2', priceLevel: 'PIE',
    price: 200, effectiveFrom: '2026-01-01', effectiveTo: '2026-10-14', active: 'TRUE' },
  { id: 'PRC-04', itemType: 'Spare', itemId: 'SP-2', itemCode: 'P2', priceLevel: 'PIE',
    price: 250, effectiveFrom: '2026-10-15', effectiveTo: '', active: 'TRUE' },

  { id: 'PRC-05', itemType: 'Spare', itemId: 'SP-3', itemCode: 'P3', priceLevel: 'PIE',
    price: 300, minPrice: 275, maxDiscountPct: 8, effectiveFrom: '2026-02-01',
    effectiveTo: '', active: 'TRUE' },

  { id: 'PRC-06', itemType: 'Spare', itemId: 'SP-4', itemCode: 'P4', priceLevel: 'PIE',
    price: 400, effectiveFrom: '2026-01-01', effectiveTo: '', active: 'FALSE' },

  { id: 'PRC-07', itemType: 'Spare', itemId: 'SP-5', itemCode: 'P5', priceLevel: 'PIE',
    price: 500, effectiveFrom: '', effectiveTo: '', active: 'TRUE' },

  { id: 'PRC-08', itemType: 'Spare', itemId: 'SP-6', itemCode: 'P6', priceLevel: 'PIE',
    price: 600, effectiveFrom: '2026-03-01', effectiveTo: '', active: 'TRUE' },
  { id: 'PRC-09', itemType: 'Spare', itemId: 'SP-6', itemCode: 'P6', priceLevel: 'PIE',
    price: 650, effectiveFrom: '2026-03-01', effectiveTo: '', active: 'TRUE' },

  { id: 'PRC-10', itemType: 'Spare', itemId: 'SP-7', itemCode: 'P7', priceLevel: 'PIE',
    price: 700, effectiveFrom: '2027-01-01', effectiveTo: '', active: 'TRUE' },

  { id: 'PRC-11', itemType: 'Spare', itemId: 'SP-8', itemCode: 'P8', priceLevel: 'PIE',
    price: 800, effectiveFrom: '2026-01-01', effectiveTo: '2026-09-30', active: 'TRUE' },

  { id: 'PRC-12', itemType: 'Product', itemId: 'PR-1', itemCode: 'EQ11', priceLevel: 'PIE',
    price: 900, effectiveFrom: '2026-01-01', effectiveTo: '', active: 'TRUE' }
];

(async () => {
  // ---------------------------------------------------------------- the sheet side
  const sb = load(['Auth.gs', 'Settings.gs', 'Schema.gs', 'SheetService.gs', 'Pricing.gs']);
  sb.CURRENT_USER_ = BOSS;
  reset(sb);
  const tab = table('PriceList');
  PRICES.forEach((p) => {
    tab.rows.push(tab.headers.map((h) => (p[h] === undefined ? '' : p[h])));
  });

  // ---------------------------------------------------------------- the database side
  const db = connect({ connectionString: URL, tenant: 'pricing-test' });
  await db.q("DELETE FROM price_list WHERE tenant_id = 'pricing-test'");

  // Inserted through db.js rather than by hand, so the types the readers meet are the types
  // the real write path produces — BOOLEAN for active, DATE for the windows.
  //
  // created_at is set explicitly and in order. It is the tie-break for two rows starting on
  // the same day, and `now()` for every row in one statement would give them all the same
  // timestamp, which would make the tie-break untestable rather than tested.
  for (let i = 0; i < PRICES.length; i++) {
    const p = PRICES[i];
    await db.appendRow('PriceList', Object.assign({ currency: 'INR', createdBy: 'seed' }, p));
    await db.q('UPDATE price_list SET created_at = $2 WHERE tenant_id = $1 AND id = $3',
      ['pricing-test', new Date(Date.UTC(2026, 0, 1, 0, i)), p.id]);
  }

  // Seeding through appendRow writes an audit row per price, which is correct of it and
  // nothing to do with what the code under test logs. Cleared after seeding so the audit
  // assertions at the end are about the loads and only the loads.
  await db.q("DELETE FROM audit_log WHERE tenant_id = 'pricing-test'");

  const portal = loadPortal(db, BOSS.email, { quiet: true });
  portal.CURRENT_USER_ = BOSS;

  console.log('THE QUERY FILES REPLACED WHAT THEY WERE MEANT TO');
  // A file that was supposed to override priceMapFor_ and defines priceMapFor2_ by a typo
  // would otherwise look like it had worked, and the slow version would keep running.
  ['priceMapFor_', 'getEffectivePrices_', 'savePricesBulk_'].forEach((fn) => {
    ok(fn + ' now comes from the query file', portal.__overridden.indexOf(fn) !== -1,
      portal.__overridden);
  });
  ok('and all 49 modules loaded', portal.__loaded.length === 49, portal.__loaded.length);

  console.log('\nTHE WHOLE MAP, ON A DAY THAT EXERCISES EVERY CASE');
  const ON = '2026-10-15';
  same('priceMapFor_ for spares matches the sheet exactly',
    await portal.priceMapFor_('Spare', ON), sb.priceMapFor_('Spare', ON));
  same('and for products', await portal.priceMapFor_('Product', ON),
    sb.priceMapFor_('Product', ON));

  // Spelled out as well as compared, so a failure says which rule broke rather than just
  // that two big objects differ.
  const map = await portal.priceMapFor_('Spare', ON);
  ok('an open-ended price is in force', map['SP-1'].PIE.price === 100);
  ok('both levels come through', map['SP-1'].ELGI.price === 90);
  ok('a superseded price gives way to the one that replaced it', map['SP-2'].PIE.price === 250,
    map['SP-2']);
  ok('minPrice survives as a number', map['SP-3'].PIE.minPrice === 275);
  ok('and maxDiscountPct too', map['SP-3'].PIE.maxDiscountPct === 8);
  ok('a blank minPrice is null, not an empty string', map['SP-1'].PIE.minPrice === null,
    map['SP-1'].PIE.minPrice);
  ok('an inactive row is not a price', map['SP-4'] === undefined);
  ok('a blank effectiveFrom is in force', map['SP-5'].PIE.price === 500);
  ok('a future price is not in force yet', map['SP-7'] === undefined);
  ok('an expired price is not in force any more', map['SP-8'] === undefined);
  ok('and a product is not a spare', map['PR-1'] === undefined);
  ok('the row id comes back, for the audit trail', map['SP-1'].PIE.priceId === 'PRC-01');

  console.log('\nTWO ROWS STARTING THE SAME DAY GO THE SAME WAY');
  // On the sheet the lower row won, because rows are appended and the comparison was a
  // strict `<`. PRC-09 was written after PRC-08, so both sides must answer 650.
  ok('the one written later wins, on both sides',
    map['SP-6'].PIE.price === 650 && sb.priceMapFor_('Spare', ON)['SP-6'].PIE.price === 650,
    [map['SP-6'].PIE.price, sb.priceMapFor_('Spare', ON)['SP-6'].PIE.price]);

  console.log('\nAND ON EVERY OTHER DATE WORTH ASKING ABOUT');
  for (const when of ['2025-12-31', '2026-01-01', '2026-02-01', '2026-09-30', '2026-10-14',
                      '2026-10-15', '2027-01-01', '2030-01-01']) {
    same('priceMapFor_ agrees on ' + when,
      await portal.priceMapFor_('Spare', when), sb.priceMapFor_('Spare', when));
  }

  console.log('\nNARROWED TO A FEW IDS, WHICH IS WHAT THE SEARCH DOES');
  same('a list of ids', await portal.priceMapFor_('Spare', ON, ['SP-1', 'SP-3']),
    sb.priceMapFor_('Spare', ON, ['SP-1', 'SP-3']));
  same('a set keyed by id — the other caller’s shape',
    await portal.priceMapFor_('Spare', ON, { 'SP-1': true, 'SP-2': true }),
    sb.priceMapFor_('Spare', ON, { 'SP-1': true, 'SP-2': true }));
  same('ids that are not there', await portal.priceMapFor_('Spare', ON, ['SP-99']),
    sb.priceMapFor_('Spare', ON, ['SP-99']));
  // An empty selection is the one place the two could sensibly differ, so it is pinned: it
  // means "nothing was asked for", not "everything".
  same('an empty list asks for nothing, not for everything',
    await portal.priceMapFor_('Spare', ON, []), sb.priceMapFor_('Spare', ON, []));

  console.log('\nONE LEVEL AT A TIME, WHICH IS WHAT A QUOTATION LINE DOES');
  for (const level of ['PIE', 'ELGI']) {
    same('getEffectivePrices_ at ' + level,
      await portal.getEffectivePrices_('Spare', ['SP-1', 'SP-2', 'SP-3', 'SP-4'], level, ON),
      sb.getEffectivePrices_('Spare', ['SP-1', 'SP-2', 'SP-3', 'SP-4'], level, ON));
  }
  same('getEffectivePrices_ with nothing asked for',
    await portal.getEffectivePrices_('Spare', [], 'PIE', ON),
    sb.getEffectivePrices_('Spare', [], 'PIE', ON));
  same('getEffectivePrices_ across every id and both dates',
    await portal.getEffectivePrices_('Spare', PRICES.map((p) => p.itemId), 'PIE', '2026-02-15'),
    sb.getEffectivePrices_('Spare', PRICES.map((p) => p.itemId), 'PIE', '2026-02-15'));

  console.log('\nAND THE SINGLE-ITEM READER THAT GOES THROUGH IT');
  // getEffectivePrice_ was not rewritten — it calls getEffectivePrices_, so it has to keep
  // working through the replacement without being touched.
  same('getEffectivePrice_ still answers', await portal.getEffectivePrice_('Spare', 'SP-2', 'PIE', ON),
    sb.getEffectivePrice_('Spare', 'SP-2', 'PIE', ON));
  ok('and nulls an item with no price at that level',
    (await portal.getEffectivePrice_('Spare', 'SP-4', 'PIE', ON)) === null);

  console.log('\nAND WRITING PRICES LEAVES BOTH SIDES IN THE SAME STATE');
  // The write path is the bigger risk of the two. The sheet version read the whole price list,
  // edited the block in memory and wrote all of it back; this closes what needs closing with
  // one UPDATE and appends with one INSERT. Ids cannot be compared — generateId_ invents a new
  // one on each side — so what is compared is what anyone would actually notice: the prices in
  // force afterwards, and how many rows were written.
  const BULK = [
    // unchanged: SP-1 PIE is already 100, so nothing should be closed or appended
    { itemType: 'Spare', itemId: 'SP-1', itemCode: 'P1', priceLevel: 'PIE', price: 100,
      effectiveFrom: '2026-10-16' },
    // a real change: SP-3 goes from 300 to 325
    { itemType: 'Spare', itemId: 'SP-3', itemCode: 'P3', priceLevel: 'PIE', price: 325,
      effectiveFrom: '2026-10-16' },
    // a level that has never had a price for this item
    { itemType: 'Spare', itemId: 'SP-3', itemCode: 'P3', priceLevel: 'ELGI', price: 290,
      effectiveFrom: '2026-10-16' },
    // an item whose only row is inactive: the inactive row is not in force, so this is new
    { itemType: 'Spare', itemId: 'SP-4', itemCode: 'P4', priceLevel: 'PIE', price: 450,
      effectiveFrom: '2026-10-16' },
    // an item with no rows at all
    { itemType: 'Spare', itemId: 'SP-NEW', itemCode: 'P9', priceLevel: 'PIE', price: 999,
      effectiveFrom: '2026-10-16' }
  ];

  const sheetWrote = sb.savePricesBulk_(BULK, 'test load');
  const sqlWrote = await portal.savePricesBulk_(BULK, 'test load');
  ok('the same number of rows were written', sheetWrote === sqlWrote, [sheetWrote, sqlWrote]);
  ok('and it is four, not five — the unchanged price wrote nothing', sqlWrote === 4, sqlWrote);

  const AFTER = '2026-10-16';
  sameButIds('the prices in force afterwards are identical',
    await portal.priceMapFor_('Spare', AFTER), sb.priceMapFor_('Spare', AFTER));
  const after = await portal.priceMapFor_('Spare', AFTER);
  ok('the changed price took effect', after['SP-3'].PIE.price === 325, after['SP-3']);
  ok('the new level appeared', after['SP-3'].ELGI.price === 290);
  ok('the brand-new item has a price', after['SP-NEW'].PIE.price === 999);
  ok('and an item whose only row was inactive now has one', after['SP-4'].PIE.price === 450);

  // The superseded row must be closed the DAY BEFORE the new one starts, or both are in force
  // on the changeover day and which price a quotation gets depends on the tie-break.
  sameButIds('and the day before the change still shows the old price',
    await portal.priceMapFor_('Spare', '2026-10-15'), sb.priceMapFor_('Spare', '2026-10-15'));
  ok('the old price is still the old price on the 15th',
    (await portal.priceMapFor_('Spare', '2026-10-15'))['SP-3'].PIE.price === 300);

  console.log('\nAND WRITING THE SAME THING TWICE CHANGES NOTHING THE SECOND TIME');
  // A chunked import re-sends rows it has already written when a chunk is retried, which the
  // 503s during the ELGi load made a routine event rather than a hypothetical.
  const again = await portal.savePricesBulk_(BULK, 'test load');
  ok('a repeat of the same load writes no rows', again === 0, again);
  same('and leaves the prices exactly as they were',
    await portal.priceMapFor_('Spare', AFTER), after);

  console.log('\nAND IT REFUSES WHAT THE SHEET VERSION REFUSED');
  for (const [what, entry] of [
    ['a price that is not a number', { itemType: 'Spare', itemId: 'SP-1', itemCode: 'X',
      priceLevel: 'PIE', price: 'free' }],
    ['a negative price', { itemType: 'Spare', itemId: 'SP-1', itemCode: 'X',
      priceLevel: 'PIE', price: -1 }],
    ['a price level nobody declared', { itemType: 'Spare', itemId: 'SP-1', itemCode: 'X',
      priceLevel: 'MATE\u2019S RATES', price: 10 }]
  ]) {
    let sqlErr = null, sheetErr = null;
    try { await portal.savePricesBulk_([entry], 'test'); } catch (e) { sqlErr = e.message; }
    try { sb.savePricesBulk_([entry], 'test'); } catch (e) { sheetErr = e.message; }
    ok('it refuses ' + what, sqlErr !== null && sqlErr === sheetErr, [sqlErr, sheetErr]);
  }

  console.log('\nAND A FAILED LOAD LEAVES NOTHING BEHIND');
  // The sheet could not promise this. It closed rows, then appended, and a failure between the
  // two left prices closed with no replacement — every one of those items quoting at zero.
  const before = await portal.priceMapFor_('Spare', '2026-11-01');
  let boom = null;
  try {
    await portal.withTransaction(async function () {
      await portal.savePricesBulk_([{ itemType: 'Spare', itemId: 'SP-3', itemCode: 'P3',
        priceLevel: 'PIE', price: 400, effectiveFrom: '2026-11-01' }], 'will be rolled back');
      throw new Error('something later in the request failed');
    });
  } catch (e) { boom = e.message; }
  ok('the failure surfaced', /something later/.test(String(boom)), boom);
  same('and the prices are untouched', await portal.priceMapFor_('Spare', '2026-11-01'), before);

  console.log('\nAND THE AUDIT TRAIL SAYS WHAT HAPPENED, ONCE');
  const log = (await db.readTable('AuditLog')).filter((a) => a.tableName === 'PriceList');
  // One line, from the one load that actually changed something. Four loads were attempted:
  // the first wrote and logged; the repeat wrote nothing and logged nothing, because a load
  // that changes no price is not an event; the three refusals threw before writing; and the
  // rolled-back one took its own audit row down with it. That last is the transaction doing
  // its job — on the sheet the audit line would have survived the failure and claimed a price
  // change that never happened.
  ok('one line per load that changed something, not one per price', log.length === 1, log.length);
  ok('and it counts what it did', /4 price\(s\), 1 superseded/.test(String(log[0].newValue)),
    log[0] && log[0].newValue);
  ok('and names the reason it was given', log[0].reason === 'test load', log[0] && log[0].reason);
  ok('and the rolled-back load left no trace',
    log.every((a) => a.reason !== 'will be rolled back'), log.map((a) => a.reason));

  await db.q("DELETE FROM price_list WHERE tenant_id = 'pricing-test'");
  await db.q("DELETE FROM audit_log WHERE tenant_id = 'pricing-test'");
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
