/**
 * Turns one Apps Script module into its asynchronous twin.
 *
 * Two rules, and deliberately no more than two:
 *
 *   1. a function the call graph says must be async gets `async ` in front of it
 *   2. a call to something asynchronous gets `await ` in front of it
 *
 * Nothing is renamed. `readTable_('Spares')` stays `readTable_('Spares')` and keeps working,
 * because `server/shim.js` defines those twelve names as async functions that forward to
 * db.js. That choice halves the job: the diff is purely `async` and `await`, which a person
 * can review line by line, instead of 967 renames tangled up with it. The shim is a dozen
 * lines and can be dissolved later if anyone wants to.
 *
 * EDITS BY POSITION, NEVER BY REPRINTING. The AST is used to decide *where* to insert, and
 * then the original text is cut and spliced. Regenerating code from the tree would produce
 * something functionally identical and strip every comment in the file — and in this project
 * the comments are the part that took the longest and are worth the most.
 *
 * THE ORIGINAL IS NOT TOUCHED. src/X.gs stays exactly as it is and the live portal keeps
 * running on it; the converted copy is written to server/modules/X.js. PIE cannot be asked
 * to stop working for the weeks this takes, and a long-lived branch where both versions
 * drift is a worse answer than two files.
 *
 *   node migration/to-async.js GoogleGate            what would change
 *   node migration/to-async.js GoogleGate --write    do it
 *   node migration/to-async.js --all                 what would change everywhere
 */
const fs = require('fs');
const path = require('path');
const acorn = require('../server/node_modules/acorn');
const walk = require('../server/node_modules/acorn-walk');
const { ASYNC_SEEDS, closure } = require('./async-map.js');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, '..', 'server', 'modules');

/**
 * Files that have no server existence at all, and are not conversions that are pending.
 *
 * SheetService.gs IS the spreadsheet storage layer; db.js replaces it rather than translating
 * it. Export.gs reads the live spreadsheet to get the data out of it once, which is a thing
 * only Apps Script can do and only before the cutover — a copy of it on the server would be a
 * file whose every line calls a service that refuses.
 *
 * Named here rather than skipped by hand so that `--all` counts them as decided rather than
 * outstanding, and so the next person does not wonder which of the two it is.
 */
const APPS_SCRIPT_ONLY = {
  SheetService: 'the spreadsheet storage layer — server/db.js replaces it',
  Export: 'reads the live spreadsheet for the one-off migration export'
};

/**
 * Works out every edit one file needs, without making any of them.
 *
 * Returns the insertions, and separately the places it refuses to touch. A call inside
 * `rows.forEach(function (r) { ... })` cannot be fixed by inserting `await`: the callback
 * would become an async function returning a promise that forEach discards, so the loop
 * finishes while the writes are still in flight and the save reports success. That is the
 * worst possible failure — silent, intermittent, and only under load. So they are listed for
 * a person to turn into `for...of` by hand, and the file is not written until they are gone.
 */
function plan(name) {
  const file = name.endsWith('.gs') ? name : name + '.gs';
  const code = fs.readFileSync(path.join(SRC, file), 'utf8');
  const ast = acorn.parse(code, { ecmaVersion: 2020, locations: true });
  const { isAsync } = closure();

  const needsAwait = (callee) => isAsync.has(callee) || ASYNC_SEEDS.indexOf(callee) !== -1;

  const inserts = [];
  const callbacks = [];
  const fnNames = [];

  walk.ancestor(ast, {
    FunctionDeclaration(node) {
      const n = node.id && node.id.name;
      if (!n || !isAsync.has(n)) return;
      if (node.async) return;                       // already converted
      fnNames.push(n);
      inserts.push({ at: node.start, text: 'async ', what: 'async ' + n });
    },
    CallExpression(node, state, ancestors) {
      if (node.callee.type !== 'Identifier') return;
      const callee = node.callee.name;
      if (!needsAwait(callee)) return;

      // Already awaited? The parent is an AwaitExpression starting at the same place.
      const parent = ancestors[ancestors.length - 2];
      if (parent && parent.type === 'AwaitExpression') return;

      // Inside a callback, between this call and its enclosing declaration?
      let insideCallback = false;
      for (let i = ancestors.length - 2; i >= 0; i--) {
        const a = ancestors[i];
        if (a.type === 'FunctionDeclaration') break;
        if (a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression') {
          insideCallback = true;
          break;
        }
      }
      if (insideCallback) {
        callbacks.push({ line: node.loc.start.line, callee,
          text: lineAt(code, node.loc.start.line) });
        return;
      }

      // `await` is a prefix operator over the WHOLE expression that follows, so putting it
      // at the front of a call whose result is then indexed into is wrong in a way that
      // parses perfectly:
      //
      //    await readTable_(tab).filter(fn)   ->  await (promise.filter(fn))  -> TypeError
      //    await stockOnHandMap_(t)[id] || 0  ->  await (promise[id]) || 0    -> silently 0
      //
      // The second is the one that matters. It throws nothing, reads as zero, and on-hand
      // stock quietly becomes nil on every screen. Found by the verifier on the first run
      // over eighteen files, which is the entire reason that check exists.
      //
      // When the call is the object of a member access, the await has to wrap the call
      // itself: (await readTable_(tab)).filter(fn).
      const parentIsMember = parent && parent.type === 'MemberExpression' &&
        parent.object === node;
      if (parentIsMember) {
        inserts.push({ at: node.start, text: '(await ', what: '(await ' + callee + ')' });
        inserts.push({ at: node.end, text: ')', what: '' });
        return;
      }
      inserts.push({ at: node.start, text: 'await ', what: 'await ' + callee });
    }
  });

  return { file, code, inserts, callbacks, fnNames };
}

function lineAt(code, n) {
  return (code.split('\n')[n - 1] || '').trim();
}

/** Applies the insertions back to front, so earlier offsets stay valid. */
function apply(code, inserts) {
  return inserts.slice().sort((a, b) => b.at - a.at)
    .reduce((out, i) => out.slice(0, i.at) + i.text + out.slice(i.at), code);
}

const HEADER = (name) => `/**
 * Converted from src/${name}.gs by migration/to-async.js.
 *
 * Only two things changed: functions that reach storage are \`async\`, and the calls that
 * reach it are \`await\`ed. Everything else — the logic, the names, the comments — is the
 * original, because the original is the specification and reformatting it would make the
 * diff unreadable at exactly the moment it needs to be read.
 *
 * Storage comes from server/shim.js, which keeps the old names (\`readTable_\`,
 * \`appendRow_\`) pointing at db.js. If this file is edited from here on, edit this one —
 * the .gs original stays frozen at the point of conversion so the live portal keeps running.
 */
`;

function convert(name, write) {
  const { file, code, inserts, callbacks, fnNames } = plan(name);
  const base = file.replace('.gs', '');

  console.log(base + ': ' + fnNames.length + ' function(s) become async, ' +
    inserts.filter((i) => i.text === 'await ').length + ' await(s) to insert' +
    (callbacks.length ? ', ' + callbacks.length + ' BY HAND' : ''));

  if (callbacks.length) {
    console.log('\n  These are inside callbacks and cannot be done mechanically.');
    console.log('  `forEach` returns before an async callback finishes, so the save would');
    console.log('  report success with its writes still in flight. Rewrite as for...of:\n');
    callbacks.forEach((c) => {
      console.log('    ' + String(c.line).padStart(5) + '  ' + c.text.slice(0, 92));
    });
    console.log('');
  }

  if (!write) {
    if (inserts.length) {
      console.log('\n  would insert:');
      inserts.slice().sort((a, b) => a.at - b.at).forEach((i) => {
        if (!i.what) return;                       // the closing paren of a wrap
        const line = code.slice(0, i.at).split('\n').length;
        console.log('    ' + String(line).padStart(5) + '  ' + i.what);
      });
    }
    return { ok: !callbacks.length, callbacks: callbacks.length };
  }

  if (callbacks.length) {
    console.log('  NOT WRITTEN. Deal with the callbacks first — a half-converted file that');
    console.log('  looks finished is worse than one that was never started.');
    return { ok: false, callbacks: callbacks.length };
  }

  fs.mkdirSync(OUT, { recursive: true });
  const out = HEADER(base) + apply(code, inserts);
  fs.writeFileSync(path.join(OUT, base + '.js'), out);
  console.log('  wrote server/modules/' + base + '.js');
  return { ok: true, callbacks: 0 };
}

const args = process.argv.slice(2);
if (args[0] === '--all') {
  const names = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort();
  let clean = 0, blocked = 0, skipped = 0;
  names.forEach((f) => {
    const base = f.replace('.gs', '');
    if (APPS_SCRIPT_ONLY[base]) {
      console.log(base + ': not converted — ' + APPS_SCRIPT_ONLY[base]);
      skipped++;
      return;
    }
    const r = convert(f, false);
    if (r.callbacks) blocked++; else clean++;
  });
  console.log('\n' + clean + ' file(s) convert mechanically, ' + blocked +
    ' need hand work first, ' + skipped + ' never convert.');
} else if (!args.length) {
  console.log('usage: node migration/to-async.js <Module> [--write]');
  process.exit(1);
} else {
  const base = args[0].replace('.gs', '');
  if (APPS_SCRIPT_ONLY[base]) {
    console.log(base + ' is not converted: ' + APPS_SCRIPT_ONLY[base] + '.');
    process.exit(0);
  }
  const r = convert(args[0], args.indexOf('--write') !== -1);
  process.exit(r.ok ? 0 : 1);
}
