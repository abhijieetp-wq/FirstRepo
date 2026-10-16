/**
 * The catalogue and rename queries, checked against the spreadsheet code they replace.
 *
 * Same method as pricing-sql-test: identical data into a fake sheet and into Postgres, the
 * original function and the query both asked the same question, and the answers must match.
 * The sheet version is the specification — it is what has been running — so a disagreement is
 * a regression until proved otherwise, and twice now it has been the sheet that was wrong.
 *
 *   DATABASE_URL=postgres://... node tests/catalog-sql-test.js
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

const BOSS = { email: 'boss@pie.in', name: 'Boss', role: 'ERP Admin', active: 'TRUE' };
const TENANT = 'catalog-test';

/**
 * Spares chosen for the awkward cases rather than the ordinary one.
 *
 * SP-1 has two groups in one field, which is why product groups cannot be a plain DISTINCT.
 * SP-2 repeats one of them, so deduplication has something to do.
 * SP-3 uses a semicolon instead of a comma — both separate groups.
 * SP-4 has no group at all.
 * SP-5 has a group but is inactive.
 * SP-6 has untidy spacing, which is the normal state of an imported catalogue.
 */
const SPARES = [
  { id: 'SP-1', partNo: 'P1', description: 'Airend kit', productGroup: 'Airend, Filters',
    reorderLevel: 5, active: 'TRUE', uom: 'Nos' },
  { id: 'SP-2', partNo: 'P2', description: 'Filter', productGroup: 'Filters',
    reorderLevel: 10, active: 'TRUE', uom: 'Nos' },
  { id: 'SP-3', partNo: 'P3', description: 'Separator', productGroup: 'Separators;Airend',
    reorderLevel: 0, active: 'TRUE', uom: 'Nos' },
  { id: 'SP-4', partNo: 'P4', description: 'Odds and ends', productGroup: '',
    reorderLevel: 2, active: 'TRUE', uom: 'Nos' },
  { id: 'SP-5', partNo: 'P5', description: 'Discontinued', productGroup: 'Obsolete',
    reorderLevel: 50, active: 'FALSE', uom: 'Nos' },
  { id: 'SP-6', partNo: 'P6', description: 'Hose', productGroup: '  Hoses ,  Filters  ',
    reorderLevel: 3, active: 'TRUE', uom: 'Nos' }
];

/**
 * Movements that put each part on a different side of its reorder level.
 *
 * SP-1: 2 in, level 5 — under.
 * SP-2: 12 in then 3 out, level 10 — exactly 9, under.
 * SP-4: no movements at all, level 2 — nothing on hand, under. This is the case a plain
 *       join drops, and it is the one that matters most: a part nobody has ever stocked.
 * SP-6: 10 in, level 3 — over, so not counted.
 * SP-5 is inactive, so its level is irrelevant however little is on hand.
 */
const MOVEMENTS = [
  { id: 'MOV-1', itemType: 'Spare', itemId: 'SP-1', movementType: 'Inward', qty: 2 },
  { id: 'MOV-2', itemType: 'Spare', itemId: 'SP-2', movementType: 'Inward', qty: 12 },
  { id: 'MOV-3', itemType: 'Spare', itemId: 'SP-2', movementType: 'Dispatch', qty: -3 },
  { id: 'MOV-4', itemType: 'Spare', itemId: 'SP-6', movementType: 'Inward', qty: 10 },
  { id: 'MOV-5', itemType: 'Spare', itemId: 'SP-5', movementType: 'Inward', qty: 1 },
  // A product movement with the same id as a spare, to catch a query that forgets item_type.
  { id: 'MOV-6', itemType: 'Product', itemId: 'SP-1', movementType: 'Inward', qty: 500 }
];

(async () => {
  const sb = load(['Auth.gs', 'Settings.gs', 'Schema.gs', 'SheetService.gs', 'Stock.gs',
    'SpareEnquiries.gs', 'UserEmail.gs', 'Session.gs', 'Sha256.gs', 'Pricing.gs',
    'CustomerItemCodes.gs']);
  sb.CURRENT_USER_ = BOSS;
  reset(sb);
  const seed = (tab, rows) => {
    const t = table(tab);
    rows.forEach((r) => t.rows.push(t.headers.map((h) => (r[h] === undefined ? '' : r[h]))));
  };
  seed('Spares', SPARES);
  seed('StockMovements', MOVEMENTS);

  const db = connect({ connectionString: URL, tenant: TENANT });
  for (const t of ['spares', 'stock_movements', 'users', 'quotations', 'audit_log']) {
    await db.q('DELETE FROM ' + t + ' WHERE tenant_id = $1', [TENANT]);
  }
  for (const s of SPARES) await db.appendRow('Spares', s);
  for (const m of MOVEMENTS) await db.appendRow('StockMovements', m);
  await db.q('DELETE FROM audit_log WHERE tenant_id = $1', [TENANT]);

  const portal = loadPortal(db, BOSS.email, { quiet: true });
  portal.CURRENT_USER_ = BOSS;

  console.log('EVERY REWRITE IS ACTUALLY IN EFFECT');
  ['readProductGroups_', 'countBelowReorder_', 'userEmailMatches_', 'rewriteUserEmailColumn_']
    .forEach((fn) => {
      ok(fn + ' is served by SQL', portal.__overridden.indexOf(fn) !== -1, portal.__overridden);
    });

  console.log('\nPRODUCT GROUPS COME OUT THE SAME, SPLIT AND SORTED');
  same('readProductGroups_ matches the sheet', await portal.readProductGroups_(),
    sb.readProductGroups_());
  const groups = await portal.readProductGroups_();
  // Spelled out too, so a failure names the rule rather than showing two lists.
  same('a comma separates two groups, and both appear', groups.indexOf('Airend') !== -1 &&
    groups.indexOf('Filters') !== -1, true);
  ok('a semicolon separates them too', groups.indexOf('Separators') !== -1, groups);
  ok('and a group named twice appears once',
    groups.filter((g) => g === 'Filters').length === 1, groups);
  ok('untidy spacing is trimmed', groups.indexOf('Hoses') !== -1, groups);
  ok('and nothing is blank', groups.every((g) => g === g.trim() && g !== ''), groups);
  // An inactive part's group still counts, exactly as on the sheet: the column scan never
  // looked at `active`, and a group that only obsolete parts belong to is still a group
  // somebody may be searching by.
  ok('an inactive part’s group still counts, as it did',
    groups.indexOf('Obsolete') !== -1, groups);

  console.log('\nAND SO DOES THE BELOW-REORDER COUNT');
  ok('countBelowReorder_ matches the sheet',
    (await portal.countBelowReorder_()) === sb.countBelowReorder_(),
    [await portal.countBelowReorder_(), sb.countBelowReorder_()]);
  ok('and it is three: SP-1 under, SP-2 exactly under, SP-4 never stocked',
    (await portal.countBelowReorder_()) === 3, await portal.countBelowReorder_());
  // The one a join would drop, and the one most worth reordering.
  ok('a part with a level and no movements at all is counted',
    (await portal.countBelowReorder_()) === 3);

  console.log('\nAND WHEN NO PART HAS A LEVEL, WHICH IS PIE’S CATALOGUE TODAY');
  // The ELGi import carries no reorder levels, so the honest answer is zero and the sheet
  // version skipped the whole ledger read to produce it.
  await db.q('UPDATE spares SET reorder_level = NULL WHERE tenant_id = $1', [TENANT]);
  table('Spares').rows.forEach((r) => {
    r[table('Spares').headers.indexOf('reorderLevel')] = '';
  });
  ok('both say zero', (await portal.countBelowReorder_()) === 0 && sb.countBelowReorder_() === 0,
    [await portal.countBelowReorder_(), sb.countBelowReorder_()]);
  await db.q('UPDATE spares SET reorder_level = $2 WHERE tenant_id = $1 AND id = $3',
    [TENANT, 5, 'SP-1']);
  ok('and one part with a level gives one', (await portal.countBelowReorder_()) === 1,
    await portal.countBelowReorder_());

  console.log('\nRENAMING A USER FINDS THE SAME ROWS');
  const USERS = [
    Object.assign({ id: 'USR-1', username: 'boss' }, BOSS),
    { id: 'USR-2', email: 'Coord@PIE.in', name: 'Coordinator', username: 'coord',
      role: 'Sales Coordinator', active: 'TRUE' },
    { id: 'USR-3', email: 'other@pie.in', name: 'Other', username: 'other',
      role: 'Sales Coordinator', active: 'TRUE' }
  ];
  // Quotations whose preparedBy records the person being renamed — including one with the
  // address in a different case and one with stray whitespace, which is how addresses
  // actually arrive in a sheet somebody has been typing into for a year.
  const QUOTES = [
    { id: 'QT-1', quoteNo: 'Q1', preparedBy: 'coord@pie.in', status: 'Draft' },
    { id: 'QT-2', quoteNo: 'Q2', preparedBy: 'COORD@PIE.IN', status: 'Draft' },
    { id: 'QT-3', quoteNo: 'Q3', preparedBy: '  coord@pie.in  ', status: 'Draft' },
    { id: 'QT-4', quoteNo: 'Q4', preparedBy: 'other@pie.in', status: 'Draft' },
    { id: 'QT-5', quoteNo: 'Q5', preparedBy: '', status: 'Draft' }
  ];
  seed('Users', USERS);
  seed('Quotations', QUOTES);
  for (const u of USERS) await db.appendRow('Users', u);
  for (const q of QUOTES) await db.appendRow('Quotations', q);
  await db.q('DELETE FROM audit_log WHERE tenant_id = $1', [TENANT]);

  const sheetHits = sb.userEmailMatches_('Quotations', 'preparedBy', 'coord@pie.in');
  const sqlHits = await portal.userEmailMatches_('Quotations', 'preparedBy', 'coord@pie.in');
  ok('the same number of rows match', sqlHits.length === sheetHits.length,
    [sqlHits.length, sheetHits.length]);
  ok('and it is three — different case and stray spaces both count', sqlHits.length === 3,
    sqlHits);
  // The one caller only takes .length, so returning ids rather than grid positions is a
  // free improvement; this pins that they are ids and not something incidental.
  ok('what comes back is row ids, not positions in a grid',
    sqlHits.slice().sort().join(',') === 'QT-1,QT-2,QT-3', sqlHits);
  same('an address nobody has matches nothing',
    (await portal.userEmailMatches_('Quotations', 'preparedBy', 'nobody@pie.in')).length,
    sb.userEmailMatches_('Quotations', 'preparedBy', 'nobody@pie.in').length);
  ok('a column the tab has not got is not an error',
    (await portal.userEmailMatches_('Quotations', 'notAColumn', 'x')).length === 0);

  console.log('\nAND REWRITES THE SAME ONES, AND ONLY THOSE');
  const sheetN = sb.rewriteUserEmailColumn_('Quotations', 'preparedBy', 'coord@pie.in',
    'coordinator@pie.in');
  const sqlN = await portal.rewriteUserEmailColumn_('Quotations', 'preparedBy', 'coord@pie.in',
    'coordinator@pie.in');
  ok('the same number of rows changed', sqlN === sheetN, [sqlN, sheetN]);
  ok('and it is three', sqlN === 3, sqlN);

  const after = {};
  (await db.readTable('Quotations')).forEach((q) => { after[q.id] = q.preparedBy; });
  ok('the three became the new address',
    after['QT-1'] === 'coordinator@pie.in' && after['QT-2'] === 'coordinator@pie.in' &&
    after['QT-3'] === 'coordinator@pie.in', after);
  // The corruption that actually happened on the sheet: a colleague's row inside the written
  // span was overwritten too, and the sheet then named the wrong person on a quotation.
  ok('and the colleague between them was not touched', after['QT-4'] === 'other@pie.in', after);
  ok('nor was the blank one', after['QT-5'] === '', after);
  ok('running it again changes nothing',
    (await portal.rewriteUserEmailColumn_('Quotations', 'preparedBy', 'coord@pie.in', 'x')) === 0);

  console.log('\nAND SAYS SO IN THE AUDIT LOG, ONCE PER COLUMN');
  const log = (await db.readTable('AuditLog')).filter((a) => a.tableName === 'Quotations');
  ok('one line, not one per row', log.length === 1, log.length);
  ok('naming the column', log.length && log[0].fieldName === 'preparedBy');
  ok('and both addresses, so it can be undone',
    log.length && log[0].oldValue === 'coord@pie.in' &&
    log[0].newValue === 'coordinator@pie.in', log[0]);
  ok('and how many rows moved', log.length && /3 row\(s\)/.test(String(log[0].reason)),
    log.length && log[0].reason);

  console.log('\nAND A FAILED RENAME LEAVES NOTHING HALF-DONE');
  // 34 tables, one UPDATE each. The sheet could not promise that a failure on table twenty
  // left the first nineteen alone — this can, and a half-renamed person is one whose work is
  // split across two names with no way to tell which rows moved.
  const before = (await db.readTable('Quotations')).map((q) => q.preparedBy).sort();
  let boom = null;
  try {
    await portal.withTransaction(async function () {
      await portal.rewriteUserEmailColumn_('Quotations', 'preparedBy', 'coordinator@pie.in',
        'wrong@pie.in');
      throw new Error('table twenty of thirty-four failed');
    });
  } catch (e) { boom = e.message; }
  ok('the failure surfaced', /table twenty/.test(String(boom)), boom);
  same('and every address is as it was',
    (await db.readTable('Quotations')).map((q) => q.preparedBy).sort(), before);

  for (const t of ['spares', 'stock_movements', 'users', 'quotations', 'audit_log']) {
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
