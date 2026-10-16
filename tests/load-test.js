/**
 * The loader, including the part of it that has never run.
 *
 * All 42 modules load on the first pass today because `ROLES` lives in Auth.gs and Auth sorts
 * first in the alphabet. That is luck. One file named `Accounts.gs` with a top-level
 * `[ROLES.MANAGEMENT]` in it and the first pass stops working — and the recovery that is meant
 * to handle it would be running for the first time in front of PIE.
 *
 * So the recovery is tested against a pair of files built to need it, and so is the case it
 * must not paper over: a name nothing defines has to be reported with the name in it rather
 * than retried until the loop gives up.
 *
 *   node tests/load-test.js
 */
const path = require('path');
const { loadPortal } = require(path.join(__dirname, '..', 'server', 'load.js'));

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

// A database that is never reached: loading must not need one. A module whose top-level code
// queried would be a module that cannot be loaded without a connection, and that is worth
// finding out from here.
const noDb = {
  tenant: 'test',
  q: () => { throw new Error('the loader must not query while loading'); },
  readTable: () => { throw new Error('the loader must not query while loading'); },
  withTransaction: (fn) => fn(noDb)
};
const FIXTURES = path.join(__dirname, 'fixtures');

console.log('THE REAL PORTAL LOADS, ALL OF IT');
const portal = loadPortal(noDb, 'boss@pie.in', { quiet: true });
ok('all 42 modules loaded', portal.__loaded.length === 42, portal.__loaded.length);
ok('and none of them queried on the way in', true);   // the fake db would have thrown
// A spot check across the project rather than one function: a module that failed to load
// silently would leave its names missing and nothing else would notice until a request.
[['getCurrentUser', 'Auth'], ['readTable_', 'the shim'], ['priceMapFor_', 'Pricing'],
 ['saveQuotationItems', 'Quotations'], ['postDispatch', 'Dispatch'], ['issueInvoice', 'Billing'],
 ['suggestSpares', 'SpareEnquiries'], ['getDashboard', 'Dashboard'],
 ['sha256Bytes_', 'Sha256'], ['setGoogleGate', 'GoogleGate']].forEach(([fn, where]) => {
  ok(fn + ' is there, from ' + where, typeof portal[fn] === 'function', typeof portal[fn]);
});
ok('and the platform is there too', typeof portal.Utilities.formatDate === 'function');
ok('and SpreadsheetApp is the refusal, not a spreadsheet', (() => {
  try { portal.SpreadsheetApp.getActiveSpreadsheet(); return false; }
  catch (e) { return /not available on the server/.test(e.message); }
})());

console.log('\nA FORWARD REFERENCE BETWEEN FILES RESOLVES ITSELF');
// Apple.js sorts first and reads a name Zebra.js defines. Loading in name order throws; the
// loader has to set Apple aside, load Zebra, and come back to it.
let orderErr = null;
let ordered = null;
try {
  ordered = loadPortal(noDb, 'x', { quiet: true,
    modulesDir: path.join(FIXTURES, 'load-order'), queriesDir: path.join(FIXTURES, 'nothing') });
} catch (e) { orderErr = e.message; }
ok('it loaded despite the order', orderErr === null, orderErr);
ok('and worked out the order itself',
  ordered && JSON.stringify(ordered.__loaded) === JSON.stringify(['Zebra.js', 'Apple.js']),
  ordered && ordered.__loaded);
ok('and the file that needed the other one really ran',
  ordered && ordered.appleCount() === 2, ordered && ordered.appleCount());

console.log('\nAND A NAME NOTHING DEFINES IS REPORTED, NOT RETRIED');
let cycleErr = null;
try {
  loadPortal(noDb, 'x', { quiet: true,
    modulesDir: path.join(FIXTURES, 'load-cycle'), queriesDir: path.join(FIXTURES, 'nothing') });
} catch (e) { cycleErr = e.message; }
ok('it gives up rather than looping', cycleErr !== null);
ok('and names the file', /Missing\.js/.test(String(cycleErr)), cycleErr);
ok('and names the identifier, which is what anyone needs',
  /NOBODY_DEFINES_THIS/.test(String(cycleErr)), cycleErr);

console.log('\nA QUERY FILE REPLACES WHAT IT WAS WRITTEN TO REPLACE');
const over = loadPortal(noDb, 'x', { quiet: true,
  modulesDir: path.join(FIXTURES, 'load-override', 'modules'),
  queriesDir: path.join(FIXTURES, 'load-override', 'queries') });
ok('the query file’s version is the one that runs',
  over.slowAnswer() instanceof Promise || typeof over.slowAnswer === 'function');
ok('and it is the async one', over.slowAnswer.constructor.name === 'AsyncFunction',
  over.slowAnswer.constructor.name);
ok('and the module’s other functions are untouched', over.alsoHere() === 'untouched');
// Recorded rather than assumed: a query file meant to replace priceMapFor_ that defines
// priceMapFor2_ by a typo would otherwise look like it had worked, and the slow version
// would go on running in production with every test still green.
ok('and the replacement is reported', over.__overridden.indexOf('slowAnswer') !== -1,
  over.__overridden);
ok('while a name it did not touch is not reported',
  over.__overridden.indexOf('alsoHere') === -1, over.__overridden);

console.log('\nAND THE REAL QUERY FILES ARE REPORTED TOO');
// The same check against what is actually shipped, so this test fails if a rewrite stops
// taking effect.
['priceMapFor_', 'getEffectivePrices_', 'savePricesBulk_'].forEach((fn) => {
  ok(fn + ' is served by SQL', portal.__overridden.indexOf(fn) !== -1, portal.__overridden);
  ok('  and is async', portal[fn].constructor.name === 'AsyncFunction');
});

console.log('\nAND `db` INSIDE A TRANSACTION IS THE TRANSACTION');
// The trap: the shim exposes `db` as a getter returning whichever connection is current, and
// Object.assign copies what a getter RETURNS rather than the getter. The context was built
// with Object.assign, so `db` was frozen as the pool and every query a query file wrote as
// `db.q(...)` inside withTransaction ran outside it — rollbacks rolled back nothing, and
// everything reported success. Checked here with two distinguishable connections because the
// end-to-end version of this test took a rename, a throw and a re-read to notice.
const pool = { id: 'pool', q: async () => ({ rows: [], rowCount: 0 }) };
const txDb = {
  tenant: 'test',
  id: 'pool',
  q: pool.q,
  readTable: async () => [],
  withTransaction: async (fn) => fn(Object.assign(Object.create(txDb), { id: 'transaction' }))
};
const t = loadPortal(txDb, 'x', { quiet: true });
ok('outside a transaction it is the pool', t.db.id === 'pool', t.db.id);
let inside = null;
let afterwards = null;
t.withTransaction(async () => { inside = t.db.id; }).then(() => {
  afterwards = t.db.id;
  ok('inside one it is the transaction', inside === 'transaction', inside);
  ok('and it goes back to the pool afterwards', afterwards === 'pool', afterwards);
  finish();
});

function finish() {

console.log('\nAND TWO REQUESTS DO NOT SHARE ANYTHING');
// One context per request. The whole shim design rests on this: a mutable "which connection
// am I on" lives in globalsFor, and two requests sharing one would put one request's
// statements inside another's transaction.
const a = loadPortal(noDb, 'one@pie.in', { quiet: true });
const b = loadPortal(noDb, 'two@pie.in', { quiet: true });
a.CURRENT_USER_ = { email: 'one@pie.in', role: 'ERP Admin' };
b.CURRENT_USER_ = { email: 'two@pie.in', role: 'Sales Coordinator' };
ok('one request’s user is not the other’s',
  a.getCurrentUser().email === 'one@pie.in' && b.getCurrentUser().email === 'two@pie.in');
ok('and their caches are separate', a.CacheService.getUserCache() !== b.CacheService.getUserCache());

console.log('\n' + (failures.length
  ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
  : 'all ' + pass + ' passed'));
process.exit(failures.length ? 1 : 0);

}
