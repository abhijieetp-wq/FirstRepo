/**
 * What the converted modules still reach for that nothing on the server side provides.
 *
 * Forty-two files now call `readTable_` and friends through server/shim.js, which points
 * them at db.js. But SheetService.gs defined thirty-seven things, and the shim covers
 * eighteen of them. The rest fall into three piles, and only a list sorted into those piles
 * tells anyone what is actually left to do:
 *
 *   PURE        — generateId_, inr_, stripRow_. No sheet in them. They move across as they
 *                 are and the work is a copy.
 *   PLATFORM    — SpreadsheetApp, CacheService, Utilities. Google's, not ours; each needs a
 *                 Node equivalent or a decision that the feature goes away.
 *   SHEET-BOUND — getSheet_, getHeaders_, sheetRows_. A module calling one of these is
 *                 reading the grid directly rather than through readTable_, which is exactly
 *                 the code that cannot be shimmed and has to become SQL.
 *
 * That third pile is the honest remainder of this migration. It is small on purpose: the
 * block reads were written for speed on a spreadsheet and are the places where a real query
 * will be both faster and shorter.
 *
 *   node migration/missing.js
 *   node migration/missing.js --sheet      just the pile that needs rewriting
 */
const fs = require('fs');
const path = require('path');
const acorn = require('../server/node_modules/acorn');
const walk = require('../server/node_modules/acorn-walk');

const MODULES = path.join(__dirname, '..', 'server', 'modules');

/** The twelve db.js forwards plus the cache no-ops, as server/shim.js actually defines them. */
function shimNames() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'shim.js'), 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 2020 });
  const names = new Set();
  // Every key of the object `globalsFor` returns. Read from the file rather than listed here,
  // so adding one to the shim does not leave this report quietly out of date.
  walk.simple(ast, {
    Property(node) {
      const k = node.key.name || node.key.value;
      if (typeof k === 'string' && /_$|^with/.test(k)) names.add(k);
    }
  });
  return names;
}

/** Things Google provides that a Node server has to answer for itself. */
const PLATFORM = new Set([
  'SpreadsheetApp', 'CacheService', 'PropertiesService', 'ScriptApp', 'Session',
  'Utilities', 'UrlFetchApp', 'HtmlService', 'LockService', 'DriveApp', 'MailApp',
  'GmailApp', 'Logger', 'ContentService'
]);

const BUILTIN = new Set([
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Date', 'Math', 'JSON', 'RegExp',
  'Error', 'TypeError', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'Promise', 'Map', 'Set', 'Symbol',
  'console', 'require', 'escape', 'unescape'
]);

const files = fs.readdirSync(MODULES).filter((f) => f.endsWith('.js')).sort();

// Everything the converted set defines for itself, across all 42 files — they share one
// global scope in Apps Script and will share one module scope on the server.
//
// Locals count too, and have to. The first run of this report listed `esc`, `L`, `add` and
// twenty-three others as missing, all of them `var esc = function (s) {...}` inside the
// function that uses them. A report with twenty-three false entries does not get read, so
// every binding at any depth is collected — a name declared somewhere in the file is not a
// name the server has to supply.
const defined = new Set();
const local = {};
const parsed = {};
files.forEach((f) => {
  const code = fs.readFileSync(path.join(MODULES, f), 'utf8');
  const ast = acorn.parse(code, { ecmaVersion: 2020, locations: true });
  parsed[f] = { ast, code };
  const here = new Set();
  ast.body.forEach((n) => {
    if (n.type === 'FunctionDeclaration' && n.id) defined.add(n.id.name);
    if (n.type === 'VariableDeclaration') {
      n.declarations.forEach((d) => { if (d.id.name) defined.add(d.id.name); });
    }
  });
  walk.simple(ast, {
    FunctionDeclaration(n) { if (n.id) here.add(n.id.name); },
    VariableDeclarator(n) { if (n.id.name) here.add(n.id.name); },
    FunctionExpression(n) { if (n.id) here.add(n.id.name); },
    // Parameters bind names too. `refScan_(list, idOf)` takes the scanner as an argument and
    // calls it; without this, `idOf` and `run` read as names the server has to supply.
    Function(n) { n.params.forEach((pp) => { if (pp.name) here.add(pp.name); }); }
  });
  local[f] = here;
});

const shim = shimNames();

// Who calls what, and from where. The call sites are the point: "getHeaders_ is missing" is
// not actionable, "Stock.js:135 calls getHeaders_" is.
const calls = {};
files.forEach((f) => {
  const { ast } = parsed[f];
  walk.simple(ast, {
    CallExpression(node) {
      if (node.callee.type !== 'Identifier') return;
      const n = node.callee.name;
      if (defined.has(n) || shim.has(n) || BUILTIN.has(n) || local[f].has(n)) return;
      (calls[n] = calls[n] || []).push(f.replace('.js', '') + ':' + node.loc.start.line);
    },
    MemberExpression(node) {
      if (node.object.type !== 'Identifier') return;
      const n = node.object.name;
      if (!PLATFORM.has(n)) return;
      const key = n + '.' + (node.property.name || '?');
      (calls[key] = calls[key] || []).push(f.replace('.js', '') + ':' + node.loc.start.line);
    }
  });
});

// SheetService is the one module that does not convert, so what it defines is the dividing
// line: a name from it that the shim does not cover is either a pure helper to copy or a
// block read to rewrite.
const sheetServiceSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'SheetService.gs'), 'utf8');
const inSheetService = new Set(
  (sheetServiceSrc.match(/^function ([A-Za-z0-9_]+)/gm) || []).map((m) => m.slice(9))
);

// A helper is pure if its body never mentions a sheet or a Google service. Decided by reading
// the body rather than by a list, so a helper that grows a sheet read stops being called pure.
const bodyOf = (name) => {
  const i = sheetServiceSrc.indexOf('\nfunction ' + name + '(');
  if (i === -1) return '';
  const rest = sheetServiceSrc.slice(i + 1);
  const end = rest.indexOf('\n}\n');
  return end === -1 ? rest : rest.slice(0, end);
};
const isPure = (name) => !/SpreadsheetApp|getRange|getSheet_|getValues|setValues|CacheService|LockService|getHeaders_|sheetRows_|sheetCols_|appendRow|TABLE_CACHE_/.test(bodyOf(name));

const piles = { PURE: [], 'SHEET-BOUND': [], PLATFORM: [], UNKNOWN: [] };
Object.keys(calls).sort().forEach((n) => {
  const row = { name: n, sites: calls[n] };
  if (n.indexOf('.') !== -1) piles.PLATFORM.push(row);
  else if (inSheetService.has(n)) piles[isPure(n) ? 'PURE' : 'SHEET-BOUND'].push(row);
  else piles.UNKNOWN.push(row);
});

const only = process.argv.indexOf('--sheet') !== -1 ? ['SHEET-BOUND'] : Object.keys(piles);

console.log(files.length + ' converted module(s), ' + defined.size + ' name(s) they define ' +
  'between them, ' + shim.size + ' the shim covers.\n');

only.forEach((pile) => {
  const rows = piles[pile];
  if (!rows.length) return;
  const total = rows.reduce((s, r) => s + r.sites.length, 0);
  console.log(pile + '  —  ' + rows.length + ' name(s), ' + total + ' call site(s)');
  rows.forEach((r) => {
    const where = r.sites.length > 4
      ? r.sites.slice(0, 4).join(' ') + ' +' + (r.sites.length - 4) + ' more'
      : r.sites.join(' ');
    console.log('  ' + r.name.padEnd(34) + where);
  });
  console.log('');
});

const left = piles['SHEET-BOUND'].reduce((s, r) => s + r.sites.length, 0);
console.log(left
  ? left + ' call site(s) read the grid directly and have to become SQL.'
  : 'Nothing reads the grid directly.');
