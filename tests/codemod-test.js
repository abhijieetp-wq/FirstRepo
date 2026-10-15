/**
 * Every converted module, checked against the original it came from.
 *
 * A codemod that runs over 43 files is only trustworthy if something proves it changed
 * nothing it was not asked to change. "It still parses" does not prove that — a tool that
 * dropped a guard clause, moved a comment or mangled a string would still parse, and the
 * mistake would surface weeks later in a quotation with the wrong price on it.
 *
 * So the check is exact rather than indicative: take the converted file, remove every
 * `async ` and `await ` token, and it must equal the original byte for byte. That works
 * because there is not a single `async` or `await` anywhere in src/*.gs — Apps Script here
 * is written in an older style — so every one of them in the output was put there by the
 * tool, and removing them all has to land back exactly where it started.
 *
 *   node tests/codemod-test.js
 */
const fs = require('fs');
const path = require('path');
const acorn = require(path.join(__dirname, '..', 'server', 'node_modules', 'acorn'));
const { closure, ASYNC_SEEDS } = require(path.join(__dirname, '..', 'migration', 'async-map.js'));

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, '..', 'server', 'modules');

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log('  FAIL: ' + label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
};

if (!fs.existsSync(OUT)) {
  console.log('nothing converted yet — run migration/to-async.js');
  process.exit(0);
}

const built = fs.readdirSync(OUT).filter((f) => f.endsWith('.js')).sort();
const { isAsync } = closure();

/**
 * The original, structurally, with the two permitted changes undone.
 *
 * Comparing text was the obvious thing and it was wrong. The tool sometimes has to write
 * `(await readTable_(tab)).filter(...)` rather than `await readTable_(tab).filter(...)`,
 * because `await` is a prefix operator over the whole expression that follows — the second
 * form awaits a member access on a promise. Those added parentheses are a correct edit that
 * a text comparison reports as a difference.
 *
 * So: parse both, drop positions, clear every `async` flag, unwrap every `await`, and the
 * two trees must be identical. Parentheses do not exist in an AST, so the wrapping is
 * invisible to this — and anything the tool actually broke is not.
 */
function canonical(src) {
  const ast = acorn.parse(src, { ecmaVersion: 2020 });
  const strip = (node) => {
    if (!node || typeof node.type !== 'string') return node;
    if (node.type === 'AwaitExpression') return strip(node.argument);
    const out = { type: node.type };
    Object.keys(node).forEach((k) => {
      if (k === 'start' || k === 'end' || k === 'loc' || k === 'type') return;
      if (k === 'async') return;                       // the permitted change
      const v = node[k];
      if (Array.isArray(v)) out[k] = v.map(strip);
      else if (v && typeof v.type === 'string') out[k] = strip(v);
      else out[k] = v;
    });
    return out;
  };
  return JSON.stringify(strip(ast));
}

/** Every comment in a file, in order. The AST does not carry them, and they are the point. */
function comments(src) {
  const found = [];
  acorn.parse(src, { ecmaVersion: 2020, onComment: (block, text) => found.push(text) });
  return found;
}

const bodyOf = (converted) => converted.slice(converted.indexOf('\n */\n') + 5);

console.log('THE ORIGINAL LOGIC IS STILL IN THERE, EXACTLY');
built.forEach((f) => {
  const name = f.replace('.js', '');
  const body = bodyOf(fs.readFileSync(path.join(OUT, f), 'utf8'));
  const original = fs.readFileSync(path.join(SRC, name + '.gs'), 'utf8');
  ok(name + ' differs only by async and await', canonical(body) === canonical(original));
});

console.log('\nAND SO IS EVERY COMMENT');
// An AST comparison would not notice these disappearing, and in this project the comments
// are the part that took longest and explain why the code is the shape it is.
built.forEach((f) => {
  const name = f.replace('.js', '');
  const body = bodyOf(fs.readFileSync(path.join(OUT, f), 'utf8'));
  const original = fs.readFileSync(path.join(SRC, name + '.gs'), 'utf8');
  const got = comments(body), want = comments(original);
  ok(name + ' keeps all ' + want.length + ' comments',
    got.length === want.length && got.every((c, i) => c === want[i]),
    [got.length, want.length]);
});

console.log('\nAND IT IS STILL VALID JAVASCRIPT');
built.forEach((f) => {
  let err = null;
  try {
    acorn.parse(fs.readFileSync(path.join(OUT, f), 'utf8'), { ecmaVersion: 2020 });
  } catch (e) { err = e.message; }
  ok(f + ' parses', err === null, err);
});

console.log('\nEVERY FUNCTION THE GRAPH NAMED IS ASYNC, AND NO OTHERS ARE');
built.forEach((f) => {
  const name = f.replace('.js', '');
  const ast = acorn.parse(fs.readFileSync(path.join(OUT, f), 'utf8'), { ecmaVersion: 2020 });
  const wrong = [];
  const walkTop = (nodes) => nodes.forEach((n) => {
    if (n.type !== 'FunctionDeclaration' || !n.id) return;
    const should = isAsync.has(n.id.name);
    // An async keyword where the graph did not ask for one is as wrong as a missing one:
    // it means the tool is marking functions on some rule of its own.
    if (should !== n.async) wrong.push((n.async ? '+' : '-') + n.id.name);
  });
  walkTop(ast.body);
  ok(name + ' marks exactly the right functions', wrong.length === 0, wrong);
});

console.log('\nAND NOTHING ASYNCHRONOUS IS CALLED WITHOUT BEING AWAITED');
// The failure this whole exercise exists to prevent. A call that returns a promise nobody
// waits for means the work is still in flight when the function says it is done.
built.forEach((f) => {
  const name = f.replace('.js', '');
  const code = fs.readFileSync(path.join(OUT, f), 'utf8');
  const ast = acorn.parse(code, { ecmaVersion: 2020, locations: true });
  const bare = [];
  const needsAwait = (n) => isAsync.has(n) || ASYNC_SEEDS.indexOf(n) !== -1;

  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
        needsAwait(node.callee.name) &&
        !(parent && parent.type === 'AwaitExpression')) {
      bare.push(node.callee.name + ':' + node.loc.start.line);
    }
    Object.keys(node).forEach((k) => {
      if (k === 'loc' || k === 'start' || k === 'end') return;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, node));
      else if (v && typeof v.type === 'string') visit(v, node);
    });
  };
  visit(ast, null);
  ok(name + ' awaits everything that needs it', bare.length === 0, bare);
});

console.log('\n' + (failures.length
  ? 'FAILED ' + failures.length + '  (' + pass + '/' + (pass + failures.length) + ')'
  : 'all ' + pass + ' passed'));
process.exit(failures.length ? 1 : 0);
