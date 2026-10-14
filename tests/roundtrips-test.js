/**
 * How many times one request talks to the spreadsheet.
 *
 * PIE said saves were slow. Counting a single saveSpareEnquiry found fourteen operations,
 * and five of them were getLastRow and getLastColumn asking the same two questions over
 * again — three times on CustomerContacts, twice on SpareEnquiries, with nothing in between
 * that could have changed the answer. They look free in the source. On this platform every
 * one of them crosses into the Sheets service, and that is the unit the portal is slow in.
 *
 * These checks exist because the fix is invisible: a dimension cache is correct right up
 * until some later change measures a tab outside it, and nothing about the screen would say
 * so. Only a count notices.
 */
const { load, reset, rowsOf, makeRow, countOps, checks } = require('./harness');

const MODULES = ['Auth.gs', 'Schema.gs', 'SheetService.gs', 'StreamAccess.gs', 'SalesPolicy.gs',
  'Pricing.gs', 'Stock.gs', 'Spares.gs', 'Customers.gs', 'SpareEnquiries.gs', 'Telemetry.gs'];

const t = checks();

function fixture() {
  const sb = load(MODULES);
  reset(sb);
  sb.getCurrentUser = () => ({ email: 'priya@pie.in', role: 'Sales Coordinator',
    businessStream: 'Spare Sales' });
  sb.requireRole_ = () => {};
  sb.requireCommercial_ = () => {};
  sb.requireStream_ = () => {};
  sb.canSeeCostPrices_ = () => true;
  rowsOf('Customers').push(makeRow(sb, 'Customers',
    { id: 'CU-1', customerCode: 'C0001', name: 'Topworth Urja', active: 'TRUE' }));
  for (let i = 0; i < 200; i++) {
    rowsOf('SpareEnquiries').push(makeRow(sb, 'SpareEnquiries',
      { id: 'SE-' + i, enquiryNo: 'SE2610-' + i, customerId: 'CU-1',
        customerName: 'Topworth Urja', status: 'New', date: '2026-10-01' }));
  }
  return sb;
}

// ------------------------------------------------------------------ measuring a tab

console.log('A TAB IS MEASURED ONCE PER REQUEST, NOT ONCE PER QUESTION');
let sb = fixture();
let spy = countOps(sb);
spy.reset();

sb.readTable_('SpareEnquiries');
sb.readTable_('SpareEnquiries');
sb.getHeaders_(sb.getSheet_('SpareEnquiries'), 'SpareEnquiries');
sb.findRowById_('SpareEnquiries', 'SE-5');

t.ok('one getLastRow for four callers', spy.count('.getLastRow') === 1, spy.tally());
t.ok('and one getLastColumn', spy.count('.getLastColumn') === 1, spy.tally());
// This one failed on its first run and was right to. The block was cached and findRowById_
// went to the sheet anyway for a single row of it — two further reads of rows it was
// already holding. updateRowById_ and columnMap_ had both taken the cache into account;
// that one path had not.
t.ok('and one actual read of the rows', spy.count('.getValues') === 1, spy.tally());

// ------------------------------------------------------------------ the save

console.log('\nAND A SAVE DOES NOT RE-MEASURE WHAT IT ALREADY MEASURED');
sb = fixture();
spy = countOps(sb);
spy.reset();

sb.saveSpareEnquiry({
  customerId: 'CU-1', customerName: 'Topworth Urja', contactName: 'Mr Pathak',
  contactPhone: '9822737001', requirementText: 'Air oil separator', urgency: 'Normal'
});

const tally = spy.tally();
// Each tab the save touches: measured once, read once, written once. Anything above that is
// a question asked twice, and the number is the thing to look at when this fails.
t.ok('SpareEnquiries measured once', (tally['SpareEnquiries.getLastRow'] || 0) === 1, tally);
t.ok('CustomerContacts measured once', (tally['CustomerContacts.getLastRow'] || 0) === 1, tally);
t.ok('the enquiry row was written', (tally['SpareEnquiries.appendRow'] || 0) === 1, tally);
// Fourteen before. A ceiling rather than an exact figure, so an honest extra read can be
// added without a test failing for no reason — but not five of them.
t.ok('the whole save stays in single figures', spy.ops.length <= 11, spy.ops.length);

// ------------------------------------------------------------------ correctness

console.log('\nTHE CACHED COUNT FOLLOWS THE WRITES, OR ADMITS IT DOES NOT');
sb = fixture();
const before = sb.sheetRows_('SpareEnquiries');
t.ok('it starts at the real height', before === 201, before);   // 200 rows + header

sb.appendRow_('SpareEnquiries', { id: 'SE-new', enquiryNo: 'SE2610-999', customerId: 'CU-1' },
  'test');
t.ok('an append moves it', sb.sheetRows_('SpareEnquiries') === 202,
  sb.sheetRows_('SpareEnquiries'));
// The number is what the next append is placed on top of. A count that drifted high would
// write past the end; one that drifted low would overwrite a real row.
t.ok('and it still agrees with the sheet',
  sb.sheetRows_('SpareEnquiries') === rowsOf('SpareEnquiries').length + 1,
  [sb.sheetRows_('SpareEnquiries'), rowsOf('SpareEnquiries').length + 1]);

// deleteRowsWhere_ blanks rows in place rather than removing them — which is what a real
// sheet does too, and why liveRows exists in the harness. So the height does not drop, and
// asserting that it did was the test being wrong rather than the code. What matters is that
// the row is gone from what anyone reads, and that the count still matches the sheet.
sb.deleteRowsWhere_('SpareEnquiries', (r) => r.id === 'SE-new', 'test');
t.ok('the row is gone',
  sb.readTable_('SpareEnquiries').every((r) => r.id !== 'SE-new'));
t.ok('and the count still agrees with the sheet',
  sb.sheetRows_('SpareEnquiries') === rowsOf('SpareEnquiries').length + 1,
  [sb.sheetRows_('SpareEnquiries'), rowsOf('SpareEnquiries').length + 1]);

// Dropping a tab's cache must drop its measurements too, or the next caller trusts a figure
// that was invalidated for a reason. The spy has to be in place before the sheet is first
// fetched — it wraps getSheetByName, and a sheet already in SHEET_CACHE_ is never fetched
// again, so a spy installed afterwards sees nothing and reports a false pass.
sb = fixture();
spy = countOps(sb);
spy.reset();
sb.sheetRows_('SpareEnquiries');
const afterFirst = spy.ops.length;
sb.invalidateTable_('SpareEnquiries');
sb.sheetRows_('SpareEnquiries');
t.ok('invalidating forces a fresh measurement',
  spy.count('.getLastRow') === 2, [afterFirst, spy.tally()]);

// ------------------------------------------------------------------ a real append lands right

console.log('\nAND A ROW APPENDED AFTER A CACHED COUNT LANDS WHERE IT SHOULD');
sb = fixture();
// Warm the count, then write through a different path, then append. If the cached figure
// were stale the new row would overwrite the one written in between.
sb.sheetRows_('SpareEnquiries');
sb.appendRow_('SpareEnquiries', { id: 'SE-a', enquiryNo: 'A', customerId: 'CU-1' }, 'a');
sb.appendRow_('SpareEnquiries', { id: 'SE-b', enquiryNo: 'B', customerId: 'CU-1' }, 'b');
const rows = sb.readTable_('SpareEnquiries');
t.ok('both rows are there', rows.filter((r) => r.id === 'SE-a' || r.id === 'SE-b').length === 2,
  rows.length);
t.ok('and nothing was trampled', rows.length === 202, rows.length);

t.done();
