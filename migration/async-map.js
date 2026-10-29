/**
 * How far `async` actually spreads.
 *
 * Counting calls to the storage functions gave 630, and that number is misleading in both
 * directions. It overcounts, because many of those calls sit in the same handful of
 * functions. And it badly undercounts, because `async` is contagious: a function that awaits
 * must itself be async, and so must everything that calls it, all the way up to the entry
 * points the browser reaches. The honest size of the job is the transitive closure, and
 * guessing at it is how a two-week estimate becomes a five-week one.
 *
 * So this parses all 43 files properly rather than grepping, builds the call graph, seeds it
 * with the twelve functions that now return promises, and propagates until nothing changes.
 *
 *   node migration/async-map.js           the summary
 *   node migration/async-map.js --files   per file, worst first
 *   node migration/async-map.js --list    every function that must change
 *   node migration/async-map.js --clean   the files that need nothing
 */
const fs = require('fs');
const path = require('path');
const acorn = require('../server/node_modules/acorn');
const walk = require('../server/node_modules/acorn-walk');

const SRC = path.join(__dirname, '..', 'src');

/**
 * The twelve that now return a promise.
 *
 * Taken from what db.js implements, not from a list typed out by hand — the two have to say
 * the same thing or this whole exercise measures the wrong graph.
 */
const DB_SEEDS = ['readTable_', 'findRowById_', 'findRowsByColumn_', 'findRowsByIds_',
  'columnMap_', 'appendRow_', 'appendRows_', 'updateRowById_', 'deleteRowById_',
  'deleteRowsWhere_', 'audit_', 'auditMany_'];

/**
 * And the ones a hand-written query file replaced, which are seeds for exactly the same reason.
 *
 * This was missing, and it cost a real bug. `getEffectivePrices_` reached the sheet through
 * `getSheet_` rather than through `readTable_`, so the graph never called it async and the
 * codemod left its caller alone:
 *
 *     function getEffectivePrice_(itemType, itemId, priceLevel, asOf) {
 *       var found = getEffectivePrices_(itemType, [itemId], priceLevel, asOf);
 *       return found[String(itemId)] || null;          // found is a Promise
 *     }
 *
 * The moment the SQL replacement made that function async, `found` became a promise,
 * `found['SP-2']` became undefined, and every price lookup on a quotation line answered "no
 * price" — no error, no warning, a zero on the offer. Found by the side-by-side test on its
 * first run, which is the entire reason that test compares against the sheet instead of
 * checking the SQL looks reasonable.
 *
 * So the seeds are read from server/queries/ rather than listed here: a new query file makes
 * its functions seeds automatically, the closure grows, and the codemod puts the awaits in.
 * Nobody has to remember.
 */
function querySeeds() {
  const dir = path.join(__dirname, '..', 'server', 'queries');
  if (!fs.existsSync(dir)) return [];
  const found = [];
  fs.readdirSync(dir).filter((f) => f.endsWith('.js')).forEach((f) => {
    const code = fs.readFileSync(path.join(dir, f), 'utf8');
    const ast = acorn.parse(code, { ecmaVersion: 2020 });
    ast.body.forEach((n) => {
      if (n.type === 'FunctionDeclaration' && n.id && n.async) found.push(n.id.name);
    });
  });
  return found;
}

const QUERY_SEEDS = querySeeds();
/**
 * Asynchronous services the server's platform hands the modules by a plain name. Claude is read
 * over the network (server/ai.js), so whoever asks it has to wait for the answer.
 */
const PLATFORM_SEEDS = ['claudePropose_'];
const ASYNC_SEEDS = DB_SEEDS.concat(QUERY_SEEDS.filter((n) => DB_SEEDS.indexOf(n) === -1), PLATFORM_SEEDS);

/**
 * Functions that exist only because the storage was a spreadsheet.
 *
 * Not seeds, because they do not become async — they stop existing. Counting their callers
 * as work to do would inflate the estimate with lines that get deleted.
 */
const DISAPPEARING = ['getSheet_', 'getHeaders_', 'sheetRows_', 'sheetCols_', 'noteRowCount_',
  'invalidateTable_', 'invalidateHeaders_', 'rememberSheet_', 'cacheRowWritten_',
  'cacheRowAppended_', 'cacheRowRemoved_', 'acquireLock_'];

/** { name: { file, calls:Set, callSites:{callee:count} } } for every function in the project. */
function buildGraph() {
  const fns = {};
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort();

  files.forEach((file) => {
    const code = fs.readFileSync(path.join(SRC, file), 'utf8');
    let ast;
    try {
      ast = acorn.parse(code, { ecmaVersion: 2020, locations: true });
    } catch (err) {
      console.error('could not parse ' + file + ': ' + err.message);
      return;
    }

    // Every function declaration, and the calls inside it. Nested functions (callbacks
    // passed to forEach and friends) are attributed to the enclosing declaration, because
    // that is the thing that has to carry the async keyword — and a storage call inside a
    // forEach is the one case this cannot fix mechanically. Counted separately below.
    walk.ancestor(ast, {
      FunctionDeclaration(node, state, ancestors) {
        const name = node.id && node.id.name;
        if (!name) return;
        fns[name] = fns[name] || { file, calls: {}, inCallback: {}, line: node.loc.start.line };
      },
      CallExpression(node, state, ancestors) {
        if (node.callee.type !== 'Identifier') return;
        const callee = node.callee.name;
        // The nearest enclosing *named* function declaration.
        let owner = null;
        let insideCallback = false;
        for (let i = ancestors.length - 1; i >= 0; i--) {
          const a = ancestors[i];
          if (a.type === 'FunctionDeclaration' && a.id) { owner = a.id.name; break; }
          if (a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression') {
            insideCallback = true;
          }
        }
        if (!owner) return;
        fns[owner] = fns[owner] || { file, calls: {}, inCallback: {}, line: 0 };
        fns[owner].calls[callee] = (fns[owner].calls[callee] || 0) + 1;
        if (insideCallback) {
          fns[owner].inCallback[callee] = (fns[owner].inCallback[callee] || 0) + 1;
        }
      }
    });
  });

  return { fns, files };
}

/** Propagates asyncness up the call graph until it stops spreading. */
function spread(fns) {
  const isAsync = new Set(ASYNC_SEEDS);
  let changed = true;
  let rounds = 0;
  while (changed) {
    changed = false;
    rounds++;
    Object.keys(fns).forEach((name) => {
      if (isAsync.has(name)) return;
      const hits = Object.keys(fns[name].calls).filter((c) => isAsync.has(c));
      if (!hits.length) return;
      isAsync.add(name);
      changed = true;
    });
  }
  // The db seeds live in SheetService.gs, which is being replaced wholesale rather than
  // edited, so they are not functions anyone converts. A query seed is different: it is
  // still declared in the .gs the module is generated from, and that declaration has to
  // carry `async` too, or the generated module's own internal calls to it go unawaited.
  DB_SEEDS.forEach((s) => isAsync.delete(s));
  return { isAsync, rounds };
}

/**
 * The graph and its closure, worked out once and shared.
 *
 * to-async.js needs exactly the same answer this file prints — which functions become async
 * — and computing it twice from two copies of the rules is how the tool and the measurement
 * come to disagree about what the job is.
 */
let CACHED = null;
function closure() {
  if (CACHED) return CACHED;
  const g = buildGraph();
  const s = spread(g.fns);
  CACHED = { fns: g.fns, files: g.files, isAsync: s.isAsync, rounds: s.rounds };
  return CACHED;
}

module.exports = { ASYNC_SEEDS, DB_SEEDS, QUERY_SEEDS, DISAPPEARING,
  buildGraph, spread, closure };

if (require.main !== module) return;

const { fns, files } = buildGraph();
const { isAsync, rounds } = spread(fns);

// How many places actually need an `await` typed in front of them.
let awaits = 0;
let awaitsInCallbacks = 0;
const perFile = {};
files.forEach((f) => { perFile[f] = { fns: 0, awaits: 0, callbacks: 0 }; });

Object.keys(fns).forEach((name) => {
  const fn = fns[name];
  if (!isAsync.has(name)) return;
  perFile[fn.file].fns++;
  Object.keys(fn.calls).forEach((callee) => {
    if (!isAsync.has(callee) && ASYNC_SEEDS.indexOf(callee) === -1) return;
    awaits += fn.calls[callee];
    perFile[fn.file].awaits += fn.calls[callee];
    const cb = fn.inCallback[callee] || 0;
    awaitsInCallbacks += cb;
    perFile[fn.file].callbacks += cb;
  });
});

const touched = files.filter((f) => perFile[f].fns > 0);
const clean = files.filter((f) => perFile[f].fns === 0);

const arg = process.argv[2];

if (arg === '--files') {
  console.log('file                    functions   awaits   of those, inside a callback');
  touched.sort((a, b) => perFile[b].awaits - perFile[a].awaits).forEach((f) => {
    const p = perFile[f];
    console.log(f.replace('.gs', '').padEnd(24) + String(p.fns).padStart(8) +
      String(p.awaits).padStart(9) + String(p.callbacks).padStart(12));
  });
} else if (arg === '--list') {
  Array.from(isAsync).sort().forEach((n) => {
    if (!fns[n]) return;
    console.log(fns[n].file.replace('.gs', '').padEnd(22) + n);
  });
} else if (arg === '--clean') {
  console.log('Files needing no change at all (' + clean.length + '):');
  clean.forEach((f) => console.log('  ' + f.replace('.gs', '')));
} else {
  console.log('THE REAL SIZE OF THE ASYNC CONVERSION\n');
  console.log('  functions that must become async   ' + isAsync.size);
  console.log('  awaits to type in                  ' + awaits);
  console.log('  files touched                      ' + touched.length + ' of ' + files.length);
  console.log('  files needing nothing              ' + clean.length);
  console.log('  rounds for it to stop spreading    ' + rounds);
  console.log('\n  of those awaits, inside a callback ' + awaitsInCallbacks +
    '   <- the only part that is not mechanical');
  console.log('\nA callback is the hard case: `rows.forEach(function (r) { ... audit_(r) })`');
  console.log('cannot simply be awaited — the forEach returns before the work finishes. Each');
  console.log('one becomes a for...of loop, by hand, read individually.');
}
