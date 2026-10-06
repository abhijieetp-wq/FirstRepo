/**
 * The stopwatch: it measures, it costs nothing when off, and it never takes a call down.
 */
const { load, reset, rowsOf, liveRows, checks } = require('./harness');

const MODULES = ['Auth.gs', 'Schema.gs', 'SheetService.gs', 'StreamAccess.gs', 'SalesPolicy.gs',
  'Pricing.gs', 'Telemetry.gs'];

const t = checks();

// ---------------------------------------------------------------- off by default

console.log('OFF UNLESS SOMEBODY TURNS IT ON');
let sb = load(MODULES);
reset(sb);
sb.getCurrentUser = () => ({ email: 'boss@pie.in', role: 'ERP Admin' });
sb.requireRole_ = () => {};
t.ok('it starts off', sb.telemetryOn_() === false);

// The ordinary day has to cost nothing at all, or measuring becomes a reason not to measure.
let ran = 0;
let out = sb.telemetryWrap_('listThings', () => { ran++; return 'result'; });
t.ok('the call still runs', ran === 1 && out === 'result', out);
t.ok('and nothing is recorded', rowsOf('Telemetry').length === 0);

// ---------------------------------------------------------------- on

console.log('\nON, IT TIMES WHAT WENT THROUGH IT');
sb = load(MODULES, { TELEMETRY: 'on' });
reset(sb);
sb.getCurrentUser = () => ({ email: 'boss@pie.in', role: 'ERP Admin' });
sb.requireRole_ = () => {};
sb.CURRENT_USER_ = { email: 'priya@pie.in' };

t.ok('it reports itself on', sb.telemetryOn_() === true);
out = sb.telemetryWrap_('listQuotations', () => 'rows');
t.ok('the call still returns its own answer', out === 'rows');

// Fifty is the batch. One call is held in the cache, not written — a write per call would add
// a round trip to every request, which on this platform is most of what a request costs.
t.ok('one call does not reach the sheet yet', rowsOf('Telemetry').length === 0,
  rowsOf('Telemetry').length);
sb.flushTelemetry();
t.ok('and a flush brings it out', rowsOf('Telemetry').length === 1,
  rowsOf('Telemetry').length);

let report = sb.getTelemetryReport();
t.ok('the report names the function', report.functions[0].fn === 'listQuotations',
  report.functions.map(f => f.fn));
t.ok('and counts the call', report.functions[0].calls === 1);

// ---------------------------------------------------------------- what it counts

console.log('\nIT COUNTS WHAT THE CALL READ');
sb = load(MODULES, { TELEMETRY: 'on' });
reset(sb);
sb.getCurrentUser = () => ({ email: 'boss@pie.in', role: 'ERP Admin' });
sb.requireRole_ = () => {};
sb.CURRENT_USER_ = { email: 'priya@pie.in' };

// Two tabs of known size, one of them much the bigger.
for (let i = 0; i < 40; i++) {
  rowsOf('Customers').push(sb.SCHEMA.Customers.columns.map((c) => (c === 'id' ? 'CU-' + i : '')));
}
for (let i = 0; i < 900; i++) {
  rowsOf('StockMovements').push(
    sb.SCHEMA.StockMovements.columns.map((c) => (c === 'id' ? 'SM-' + i : '')));
}

sb.telemetryWrap_('someScreen', () => {
  sb.readTable_('Customers');
  sb.readTable_('StockMovements');
  // The same tab again. It comes from the request cache and costs nothing, so it must not be
  // counted — otherwise the numbers describe the code's shape rather than its cost.
  sb.readTable_('Customers');
  return true;
});
sb.flushTelemetry();
report = sb.getTelemetryReport();
let entry = report.functions.find((f) => f.fn === 'someScreen');
t.ok('two tabs, not three', entry.avgTabs === 2, entry.avgTabs);
t.ok('and every row they held', entry.avgRows === 940, entry.avgRows);
// The widest read is usually the answer: eight small tabs and one enormous one look identical
// by tab count and are completely different problems.
t.ok('it names the widest read', entry.widest === 'StockMovements:900', entry.widest);

// ---------------------------------------------------------------- failures

console.log('\nA CALL THAT FAILS SLOWLY IS WORTH KNOWING ABOUT');
sb = load(MODULES, { TELEMETRY: 'on' });
reset(sb);
sb.getCurrentUser = () => ({ email: 'boss@pie.in', role: 'ERP Admin' });
sb.requireRole_ = () => {};
let msg = t.threw(() => sb.telemetryWrap_('brokenThing', () => { throw new Error('nope'); }));
t.ok('the error still reaches the caller', msg === 'nope', msg);
sb.flushTelemetry();
report = sb.getTelemetryReport();
entry = report.functions.find((f) => f.fn === 'brokenThing');
// A timing set containing only the successes describes a portal nobody is using.
t.ok('the failure was timed too', !!entry && entry.calls === 1, report.functions);
t.ok('and marked as one', entry.errors === 1, entry);

// ---------------------------------------------------------------- it cannot break a call

console.log('\nAND THE STOPWATCH CANNOT TAKE A CALL DOWN');
sb = load(MODULES, { TELEMETRY: 'on' });
reset(sb);
sb.getCurrentUser = () => ({ email: 'boss@pie.in', role: 'ERP Admin' });
sb.requireRole_ = () => {};
// Whatever goes wrong in here — a full cache, a missing tab, a quota — the call it was
// watching has to finish. A portal that falls over because its stopwatch failed would be a
// poor trade for knowing how fast it was.
sb.CacheService = {
  getScriptCache: () => { throw new Error('cache unavailable'); },
  getUserCache: () => { throw new Error('cache unavailable'); }
};
ran = 0;
out = sb.telemetryWrap_('stillWorks', () => { ran++; return 'fine'; });
t.ok('the call ran', ran === 1);
t.ok('and returned its answer', out === 'fine', out);

// ---------------------------------------------------------------- the report

console.log('\nTHE REPORT SORTS BY WHAT THE OFFICE WAITS ON');
sb = load(MODULES, { TELEMETRY: 'on' });
reset(sb);
sb.getCurrentUser = () => ({ email: 'boss@pie.in', role: 'ERP Admin' });
sb.requireRole_ = () => {};
const seed = (fn, ms) => rowsOf('Telemetry').push(
  sb.SCHEMA.Telemetry.columns.map((c) =>
    ({ id: 'TLM-' + fn + ms, at: '2026-10-06T09:00:00Z', fn: fn, ms: ms,
       tabsRead: 1, rowsRead: 10, widestRead: 'X:10', userEmail: 'p@pie.in', error: '' })[c] || ''));

// A four-second report run twice beats a 400ms search run fifty times only if you sort by the
// wrong thing. The office waits 20 seconds on the search and 8 on the report.
seed('heavyReport', 4000); seed('heavyReport', 4000);
for (let i = 0; i < 50; i++) seed('quickSearch', 400);
report = sb.getTelemetryReport();
t.ok('the search comes first', report.functions[0].fn === 'quickSearch',
  report.functions.map((f) => f.fn + ':' + f.totalMs));
t.ok('on total time, not worst case', report.functions[0].totalMs === 20000,
  report.functions[0].totalMs);
t.ok('and the heavy one is still listed', report.functions[1].fn === 'heavyReport');

// p95 beside the median, because an average hides the shape.
sb = load(MODULES, { TELEMETRY: 'on' });
reset(sb);
sb.getCurrentUser = () => ({ email: 'boss@pie.in', role: 'ERP Admin' });
sb.requireRole_ = () => {};
// Nine quick and one terrible. Nearest-rank over ten samples puts the slow one at p95, which
// is the point: the average of these is 990ms and describes neither the usual call nor the
// bad one.
for (let i = 0; i < 9; i++) seed('spiky', 100);
seed('spiky', 9000);
report = sb.getTelemetryReport();
entry = report.functions[0];
t.ok('the median stays honest', entry.medianMs === 100, entry.medianMs);
t.ok('and the tail is visible', entry.p95Ms === 9000, entry.p95Ms);
t.ok('as is the worst one', entry.maxMs === 9000, entry.maxMs);

console.log('\nAND IT CAN BE STOPPED AND EMPTIED');
sb.setTelemetry(false);
t.ok('stopping takes effect', sb.telemetryOn_() === false);
report = sb.clearTelemetry();
// Blanked in place, the way a sheet clears — so the live rows are what to count.
t.ok('and clearing empties it', liveRows('Telemetry').length === 0, liveRows('Telemetry').length);
t.ok('the report says so', report.samples === 0, report.samples);

t.done();
