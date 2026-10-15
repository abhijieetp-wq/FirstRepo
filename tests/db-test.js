/**
 * The data layer, against a real Postgres.
 *
 * Not a stub. The whole value of this suite is that it runs the same statements the live
 * system will, so a column that does not exist, a type that will not accept '' and a tenant
 * clause left off a WHERE all fail here rather than during a cutover.
 *
 * The behaviour being checked is not "what a sensible database layer does" — it is what
 * SheetService.gs already does, oddities and all. The portal is 17,500 lines written against
 * those oddities, and every one that changes silently is a bug nobody will trace back here.
 *
 *   DATABASE_URL=postgres://... node tests/db-test.js
 *
 * Skips with a note rather than failing when no database is configured, so the rest of the
 * suite still runs on a machine without one.
 */
const path = require('path');

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.log('no DATABASE_URL — skipping (set it to run these against a real Postgres)');
  process.exit(0);
}

const { connect, generateId } = require(path.join(__dirname, '..', 'server', 'db.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};
const threw = async (fn) => {
  try { await fn(); return null; } catch (e) { return e.message; }
};

(async () => {
  const db = connect({ connectionString: URL, tenant: 'test' });
  const other = connect({ connectionString: URL, tenant: 'someone-else' });
  db.actor = 'priya@pie.in';

  const wipe = async () => {
    for (const t of ['spares', 'price_list', 'customers', 'audit_log', 'spare_enquiries']) {
      await db.q('DELETE FROM ' + t + " WHERE tenant_id IN ('test','someone-else')");
    }
  };
  await wipe();

  // ---------------------------------------------------------------- writing and reading

  console.log('A ROW GOES IN AND COMES BACK THE SAME SHAPE');
  await db.appendRow('Spares', {
    id: 'SP-1', partNo: '959439', description: '1 BSP BONDED SEAL WASHER VITON',
    productGroup: 'RCD Spares', category: 'Filter', uom: 'Nos', gstPct: 18,
    active: 'TRUE', createdAt: '2026-10-15T09:00:00Z', createdBy: 'priya@pie.in'
  }, 'test');

  let rows = await db.readTable('Spares');
  ok('one row', rows.length === 1, rows.length);
  const r = rows[0];
  ok('the part number survived', r.partNo === '959439', r.partNo);
  // The sheet handed back numbers. pg hands back NUMERIC as a string unless told otherwise,
  // and `18` !== `'18'` in a dozen comparisons across the portal.
  ok('a number comes back as a number', r.gstPct === 18, [r.gstPct, typeof r.gstPct]);
  // Every blank field in the portal is '' because a spreadsheet has no null, and the code is
  // full of String(x).trim() written against that. null would print as "null" on a quotation.
  ok('an unset field is empty string, not null', r.hsnCode === '', JSON.stringify(r.hsnCode));
  ok('and so is an unset number', r.reorderLevel === '', JSON.stringify(r.reorderLevel));
  // String(true).toUpperCase() === 'TRUE', which is exactly what the portal tests for.
  ok('a flag still reads as the portal expects',
    String(r.active).toUpperCase() === 'TRUE', r.active);

  console.log('\nAND BLANKS DO NOT BREAK TYPED COLUMNS');
  // Every form in the portal sends '' for an absent value. A DATE column given '' raises
  // "invalid input syntax for type date", which is a correct complaint about a value that
  // was always meant to be absent.
  const msg = await threw(() => db.appendRow('Spares', {
    id: 'SP-blank', partNo: 'B1', description: 'Blank test',
    gstPct: '', reorderLevel: '', safetyStock: '', createdAt: ''
  }, 'test'));
  ok('an empty number or date is accepted', msg === null, msg);

  // ---------------------------------------------------------------- one client cannot see another

  console.log('\nONE CLIENT CANNOT SEE ANOTHER');
  await other.appendRow('Spares', { id: 'SP-X', partNo: 'THEIRS', description: 'Not ours' },
    'test');
  rows = await db.readTable('Spares');
  ok('their row is not in our table', rows.every((x) => x.partNo !== 'THEIRS'),
    rows.map((x) => x.partNo));
  // A missing WHERE on a shared table is how one client reads another's prices, so the
  // lookups are checked too, not just the full read.
  ok('and not findable by id', (await db.findRowById('Spares', 'SP-X')) === null);
  ok('nor by column', (await db.findRowsByColumn('Spares', 'partNo', ['THEIRS'])).length === 0);
  ok('nor in a column map',
    (await db.columnMap('Spares', 'id', 'partNo'))['SP-X'] === undefined);
  // And it cannot be reached through a write either.
  const xmsg = await threw(() => db.updateRowById('Spares', 'id', 'SP-X', { category: 'X' }, 't'));
  ok('nor writable', /not found/.test(String(xmsg)), xmsg);

  // ---------------------------------------------------------------- the audit trail

  console.log('\nAN UPDATE RECORDS EVERY FIELD THAT CHANGED');
  await db.updateRowById('Spares', 'id', 'SP-1',
    { category: 'Seal', uom: 'Set', description: '1 BSP BONDED SEAL WASHER VITON' }, 'tidy up');

  const audit = (await db.readTable('AuditLog'))
    .filter((a) => a.recordId === 'SP-1' && a.action === 'Update');
  // Two fields changed, the third was sent unchanged. One row saying "updated" cannot answer
  // "who changed the price and what was it before", which is the only reason the log exists.
  ok('one entry per changed field', audit.length === 2, audit.map((a) => a.fieldName));
  const cat = audit.find((a) => a.fieldName === 'category');
  ok('it keeps the old value', cat && cat.oldValue === 'Filter', cat && cat.oldValue);
  ok('and the new one', cat && cat.newValue === 'Seal', cat && cat.newValue);
  ok('and who did it', cat && cat.userEmail === 'priya@pie.in', cat && cat.userEmail);
  ok('an unchanged field is not recorded',
    !audit.some((a) => a.fieldName === 'description'), audit.map((a) => a.fieldName));

  const after = await db.findRowById('Spares', 'SP-1');
  ok('and the row really changed', after.category === 'Seal' && after.uom === 'Set',
    [after.category, after.uom]);

  console.log('\nAND A SAVE AGAINST A ROW THAT IS GONE IS AN ERROR, NOT A SHRUG');
  const gone = await threw(() =>
    db.updateRowById('Spares', 'id', 'SP-nope', { category: 'x' }, 'test'));
  ok('it throws', /not found/.test(String(gone)), gone);

  // ---------------------------------------------------------------- deleting

  console.log('\nA DELETE KEEPS WHAT IT REMOVED');
  await db.deleteRowById('Spares', 'id', 'SP-blank', 'no longer needed');
  ok('the row is gone', (await db.findRowById('Spares', 'SP-blank')) === null);
  const del = (await db.readTable('AuditLog')).find((a) => a.action === 'Delete' &&
    a.recordId === 'SP-blank');
  ok('the audit entry exists', !!del);
  ok('and holds what it held', del && /B1/.test(del.oldValue), del && del.oldValue);

  console.log('\nAND A PREDICATE DELETE REMOVES ONLY WHAT MATCHES');
  await db.appendRows('Spares', [
    { id: 'SP-a', partNo: 'A1', description: 'keep', category: 'Keep' },
    { id: 'SP-b', partNo: 'B2', description: 'drop', category: 'Drop' },
    { id: 'SP-c', partNo: 'C3', description: 'drop', category: 'Drop' }
  ], 'bulk');
  const removed = await db.deleteRowsWhere('Spares', (x) => x.category === 'Drop', 'clear-out');
  ok('two went', removed === 2, removed);
  rows = await db.readTable('Spares');
  ok('and the keeper stayed', rows.some((x) => x.id === 'SP-a'), rows.map((x) => x.id));
  ok('along with the original', rows.some((x) => x.id === 'SP-1'), rows.map((x) => x.id));

  // ---------------------------------------------------------------- transactions

  console.log('\nWORK THAT FAILS HALFWAY LEAVES NOTHING BEHIND');
  // The thing a spreadsheet could never do. A dispatch decrements stock, updates the order
  // and writes an audit row; on Sheets that could half-complete with no way back, and
  // ARCHITECTURE.md lists it first among the reasons to leave.
  const before = (await db.readTable('Customers')).length;
  const boom = await threw(() => db.withTransaction(async (t) => {
    await t.appendRow('Customers', { id: 'CU-1', customerCode: 'C1', name: 'First' }, 'x');
    await t.appendRow('Customers', { id: 'CU-2', customerCode: 'C2', name: 'Second' }, 'x');
    throw new Error('something went wrong after the second write');
  }));
  ok('the error reaches the caller', /something went wrong/.test(String(boom)), boom);
  ok('and neither row was kept', (await db.readTable('Customers')).length === before,
    (await db.readTable('Customers')).length);

  console.log('\nAND WORK THAT SUCCEEDS IS KEPT WHOLE');
  await db.withTransaction(async (t) => {
    await t.appendRow('Customers', { id: 'CU-3', customerCode: 'C3', name: 'Third' }, 'x');
    await t.appendRow('Customers', { id: 'CU-4', customerCode: 'C4', name: 'Fourth' }, 'x');
  });
  ok('both rows are there', (await db.readTable('Customers')).length === before + 2);

  // ---------------------------------------------------------------- dates and prices

  console.log('\nDATES STAY THE DAY THEY WERE, AND PRICES STAY EXACT');
  await db.appendRows('PriceList', [
    { id: 'PL-1', itemType: 'Spare', itemId: 'SP-1', itemCode: '959439', priceLevel: 'ELGI',
      price: 154, effectiveFrom: '2026-04-01', active: 'TRUE' },
    { id: 'PL-2', itemType: 'Spare', itemId: 'SP-1', itemCode: '959439', priceLevel: 'PIE',
      price: 143, effectiveFrom: '2026-04-01', active: 'TRUE' }
  ], 'prices');
  const prices = await db.readTable('PriceList');
  const selling = prices.find((p) => p.priceLevel === 'ELGI');
  // pg builds a Date at the server's midnight for a DATE column, which can slide a day
  // across time zones. The portal compares these as 'yyyy-MM-dd' strings throughout.
  ok('a date is still the string the portal compares',
    selling.effectiveFrom === '2026-04-01', selling.effectiveFrom);
  ok('and the price is exact', selling.price === 154, selling.price);
  // priceLevel was the inference the schema report caught: PIE and ELGI, not a number.
  ok('the price level is text', typeof selling.priceLevel === 'string', selling.priceLevel);

  console.log('\nAND THE NARROW LOOKUPS AGREE WITH THE WIDE ONE');
  const byCol = await db.findRowsByColumn('PriceList', 'itemId', ['SP-1']);
  ok('two prices for the part', byCol.length === 2, byCol.length);
  const map = await db.columnMap('Spares', 'id', 'partNo');
  ok('the map is keyed right', map['SP-1'] === '959439', map['SP-1']);
  const byIds = await db.findRowsByIds('Spares', ['SP-1', 'SP-a']);
  ok('two rows by id', byIds.length === 2, byIds.map((x) => x.id));

  // ---------------------------------------------------------------- it refuses to be careless

  console.log('\nIT REFUSES THE TWO THINGS THAT WOULD BE QUIET DISASTERS');
  let e = null;
  try { connect({ connectionString: URL }); } catch (err) { e = err.message; }
  ok('no tenant, no connection', /tenant/i.test(String(e)), e);
  const bad = await threw(() => db.readTable('NotATab'));
  ok('an undeclared tab is named, not guessed at', /not declared/.test(String(bad)), bad);

  await wipe();
  await db.pool.end();
  await other.pool.end();

  console.log('\n' + (failures.length
    ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
    : 'all ' + pass + ' passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.log('CRASHED: ' + err.message);
  console.log(err.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
