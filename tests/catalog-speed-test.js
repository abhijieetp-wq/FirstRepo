/**
 * What the catalogue costs to look at.
 *
 * The first week of timings said the dashboard read 13,225 rows across 15 tabs, and that
 * 13,146 of those rows were the spares catalogue — fetched to compute one advisory tile,
 * on a catalogue where not a single part has a reorder level set. These are the checks that
 * it stops doing that, and keeps giving the same answers.
 *
 *   node tests/catalog-speed-test.js
 */
const { load, reset, rowsOf, makeRow, checks } = require('./harness');

const MODULES = ['Auth.gs', 'Schema.gs', 'SheetService.gs', 'StreamAccess.gs', 'SalesPolicy.gs',
  'Pricing.gs', 'Stock.gs', 'Spares.gs', 'SpareEnquiries.gs', 'Telemetry.gs'];

const t = checks();

/**
 * Counts what a call actually fetched.
 *
 * Two doors, because the code uses both: readTable_ for anything it wants as objects, and
 * getSheet_ + getRange for the hot paths that only want a column or two and cannot afford an
 * object per row. A test that watched only one of them would have called this change a
 * success while it moved the cost from one door to the other.
 */
function watch(sb) {
  const seen = { tables: [], sheets: [] };
  const realTable = sb.readTable_;
  const realSheet = sb.getSheet_;
  sb.readTable_ = function (name) { seen.tables.push(name); return realTable.apply(null, arguments); };
  sb.getSheet_ = function (name) { seen.sheets.push(name); return realSheet.apply(null, arguments); };
  seen.touched = (name) => seen.tables.indexOf(name) !== -1 || seen.sheets.indexOf(name) !== -1;
  seen.clear = () => { seen.tables.length = 0; seen.sheets.length = 0; };
  return seen;
}

function seedCatalogue(sb, count, opts) {
  const o = opts || {};
  for (let i = 0; i < count; i++) {
    rowsOf('Spares').push(makeRow(sb, 'Spares', {
      id: 'SP-' + i,
      partNo: 'P' + String(i).padStart(5, '0'),
      description: 'Element ' + i,
      productGroup: i % 2 ? 'RCD Spares' : 'OFSAC',
      category: 'Filter',
      uom: 'Nos',
      active: 'TRUE',
      // The imported ELGi catalogue carries no reorder levels at all. That is the case
      // worth defending, because it is the live one.
      reorderLevel: o.reorderLevels ? (i < o.reorderLevels ? 5 : '') : ''
    }));
  }
}

function setUser(sb) {
  sb.getCurrentUser = () => ({ email: 'priya@pie.in', role: 'ERP Admin', businessStream: 'All' });
  sb.requireRole_ = () => {};
  sb.canSeeCostPrices_ = () => true;
}

// ------------------------------------------------------- the tile that cost the most

console.log('A CATALOGUE WITH NO REORDER LEVELS IS NOT WORTH SCANNING TWICE');
let sb = load(MODULES);
reset(sb);
setUser(sb);
seedCatalogue(sb, 300);
// A ledger the old code summed in full, every time, for every user.
for (let i = 0; i < 500; i++) {
  rowsOf('StockMovements').push(makeRow(sb, 'StockMovements', {
    id: 'SM-' + i, itemType: 'Spare', itemId: 'SP-' + (i % 300), qty: 2, movementType: 'Inward'
  }));
}

let seen = watch(sb);
let count = sb.countBelowReorder_();
t.ok('nothing is below a level nobody set', count === 0, count);
// The point of the whole change: no part carries a level, so no part can be under one, and
// the ledger never needs opening to say so.
t.ok('and the ledger was not read to find that out', !seen.touched('StockMovements'),
  seen.tables.concat(seen.sheets));

// ------------------------------------------------------- but it still answers correctly

console.log('\nWHEN LEVELS ARE SET, THE ANSWER IS STILL THE RIGHT ONE');
sb = load(MODULES);
reset(sb);
setUser(sb);
seedCatalogue(sb, 50, { reorderLevels: 4 });   // SP-0..SP-3 want 5 on hand
rowsOf('StockMovements').push(makeRow(sb, 'StockMovements',
  { id: 'SM-1', itemType: 'Spare', itemId: 'SP-0', qty: 9, movementType: 'Inward' }));
rowsOf('StockMovements').push(makeRow(sb, 'StockMovements',
  { id: 'SM-2', itemType: 'Spare', itemId: 'SP-1', qty: 2, movementType: 'Inward' }));
rowsOf('StockMovements').push(makeRow(sb, 'StockMovements',
  { id: 'SM-3', itemType: 'Spare', itemId: 'SP-1', qty: -1, movementType: 'Dispatch' }));
// A movement against a part with no level at all, which must not be counted or summed.
rowsOf('StockMovements').push(makeRow(sb, 'StockMovements',
  { id: 'SM-4', itemType: 'Spare', itemId: 'SP-40', qty: -99, movementType: 'Dispatch' }));
// SP-0 has 9 (fine). SP-1 has 1 (short). SP-2 and SP-3 have nothing at all (short).
t.ok('three parts are short', sb.countBelowReorder_() === 3, sb.countBelowReorder_());

// A deactivated part is not a purchasing problem.
rowsOf('Spares').find((r) => r[sb.SCHEMA.Spares.columns.indexOf('id')] === 'SP-2')[
  sb.SCHEMA.Spares.columns.indexOf('active')] = 'FALSE';
t.ok('a deactivated part drops out', sb.countBelowReorder_() === 2, sb.countBelowReorder_());

// ------------------------------------------------------- computed once for everybody

console.log('\nAND IT IS COMPUTED ONCE FOR THE COMPANY, NOT ONCE PER PERSON');
sb = load(MODULES);
reset(sb);
setUser(sb);
seedCatalogue(sb, 100, { reorderLevels: 2 });

seen = watch(sb);
const first = sb.belowReorderCount_();
const readsAfterFirst = seen.sheets.filter((n) => n === 'Spares').length;
seen.clear();
const second = sb.belowReorderCount_();
t.ok('the second caller gets the same number', second === first, [first, second]);
t.ok('without reading the catalogue again',
  seen.sheets.filter((n) => n === 'Spares').length === 0, seen.sheets);
t.ok('and the first one did read it', readsAfterFirst > 0, readsAfterFirst);

// Zero is the live answer, and a cached zero has to survive being read back — this is the
// bug that would have made every subsequent call recompute while appearing to work.
sb = load(MODULES);
reset(sb);
setUser(sb);
seedCatalogue(sb, 100);
t.ok('zero caches like any other number', sb.belowReorderCount_() === 0);
seen = watch(sb);
t.ok('a cached zero is returned, not recomputed', sb.belowReorderCount_() === 0);
t.ok('so the sheet is left alone', seen.sheets.indexOf('Spares') === -1, seen.sheets);

// ------------------------------------------------------- editing a part says so

console.log('\nCHANGING THE CATALOGUE CLEARS WHAT WAS DERIVED FROM IT');
sb = load(MODULES);
reset(sb);
setUser(sb);
seedCatalogue(sb, 20);
t.ok('starts at zero', sb.belowReorderCount_() === 0);
t.ok('and the groups are the two seeded', sb.listProductGroups().join('|') === 'OFSAC|RCD Spares',
  sb.listProductGroups());

sb.saveSpare({ partNo: 'P99999', description: 'New element', productGroup: 'DSF',
  uom: 'Nos', reorderLevel: 3 });

// Both derived answers were cached a moment ago and both are now wrong. If the invalidation
// did not fire, the new part is invisible on both counts until the TTL expires.
t.ok('the new part shows as short', sb.belowReorderCount_() === 1, sb.belowReorderCount_());
t.ok('and its group appears', sb.listProductGroups().indexOf('DSF') !== -1,
  sb.listProductGroups());

// ------------------------------------------------------- the dropdown

console.log('\nTHE GROUP LIST IS CACHED AND READS ONE COLUMN');
sb = load(MODULES);
reset(sb);
setUser(sb);
seedCatalogue(sb, 200);

seen = watch(sb);
const groups = sb.listProductGroups();
t.ok('the groups are right', groups.join('|') === 'OFSAC|RCD Spares', groups);
// Ten strings used to cost an object per part. The column read is the same round trip and a
// fraction of the work, and readTable_ must not be the thing that fetched it.
t.ok('without building the catalogue as objects', seen.tables.indexOf('Spares') === -1,
  seen.tables);
seen.clear();
sb.listProductGroups();
t.ok('and the second caller reads nothing at all',
  seen.tables.length === 0 && seen.sheets.length === 0, seen.tables.concat(seen.sheets));

// ------------------------------------------------------- the part search

console.log('\nTHE PART SEARCH PRICES WHAT IT FOUND, NOT WHAT IT LOOKED AT');
sb = load(MODULES);
reset(sb);
setUser(sb);
seedCatalogue(sb, 400);
// Two prices for every part, which is the shape of the real PriceList.
for (let i = 0; i < 400; i++) {
  ['ELGI', 'PIE'].forEach((level, n) => {
    rowsOf('PriceList').push(makeRow(sb, 'PriceList', {
      id: 'PL-' + i + '-' + n, itemType: 'Spare', itemId: 'SP-' + i, itemCode: 'P' + i,
      priceLevel: level, price: 100 + i, effectiveFrom: '2026-01-01', active: 'TRUE'
    }));
  });
}

let hits = sb.suggestSpares('P0001');
t.ok('it finds the part', hits.length >= 1 && hits[0].partNo === 'P00010', hits.map(h => h.partNo));
t.ok('and carries its selling price', hits[0].price === 110, hits[0].price);

// The behaviour that must not change: fifty at most, compatible first, then by part number.
hits = sb.suggestSpares('Element');
t.ok('still capped at fifty', hits.length === 50, hits.length);
t.ok('still sorted by part number', hits[0].partNo === 'P00000', hits[0].partNo);
t.ok('still the same fields', ['id', 'partNo', 'price', 'onHand', 'reserved', 'available',
  'compatibilityConfirmed'].every((k) => hits[0].hasOwnProperty(k)), Object.keys(hits[0]));

// The actual saving. priceMapFor_ built an entry for all 400 parts — 800 price rows indexed
// — to decorate fifty. Now it is asked only about the fifty that survived the cap.
const realPriceMap = sb.priceMapFor_;
let askedFor = null;
sb.priceMapFor_ = function (itemType, asOf, onlyIds) {
  askedFor = onlyIds;
  return realPriceMap.apply(null, arguments);
};
hits = sb.suggestSpares('Element');
t.ok('prices were asked for by id', !!askedFor, askedFor);
t.ok('and only for the rows being returned', askedFor && askedFor.length === 50,
  askedFor && askedFor.length);

// A search that matches nothing must not read prices or stock at all.
sb.readTable_ = sb.readTable_;
seen = watch(sb);
hits = sb.suggestSpares('nothingmatchesthis');
t.ok('an empty search returns nothing', hits.length === 0);
t.ok('and reads no prices', !seen.touched('PriceList'), seen.tables.concat(seen.sheets));
t.ok('and no stock', !seen.touched('StockMovements'), seen.tables.concat(seen.sheets));

// ------------------------------------------------------- the maps themselves

console.log('\nTHE STOCK MAPS NARROW WITHOUT CHANGING THEIR ANSWERS');
sb = load(MODULES);
reset(sb);
setUser(sb);
[['SM-1', 'SP-1', 10], ['SM-2', 'SP-1', -3], ['SM-3', 'SP-2', 7]].forEach(([id, item, qty]) => {
  rowsOf('StockMovements').push(makeRow(sb, 'StockMovements',
    { id: id, itemType: 'Spare', itemId: item, qty: qty, movementType: 'Inward' }));
});
rowsOf('StockMovements').push(makeRow(sb, 'StockMovements',
  { id: 'SM-4', itemType: 'Product', itemId: 'PR-1', qty: 99, movementType: 'Inward' }));

const all = sb.stockOnHandMap_('Spare');
t.ok('unfiltered is unchanged', all['SP-1'] === 7 && all['SP-2'] === 7, all);
t.ok('and still ignores other item types', all['PR-1'] === undefined, all);
const some = sb.stockOnHandMap_('Spare', ['SP-1']);
t.ok('narrowed gives the same figure', some['SP-1'] === 7, some);
t.ok('and leaves the rest out', some['SP-2'] === undefined, some);

t.done();
