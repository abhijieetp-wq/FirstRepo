/**
 * Assembles the forty-two converted modules into one running portal.
 *
 * On Apps Script every .gs file sees every other: there are no imports, and `ROLES`, `SCHEMA`
 * and two hundred helpers are simply there. The converted modules are unchanged in that
 * respect — deliberately, because rewriting 42 files to import each other is weeks of churn
 * that changes no behaviour. So they are loaded into one `vm` context with the database shim
 * and the platform shim injected, which is the same shape Apps Script gave them.
 *
 * LOAD ORDER IS NOT ALPHABETICAL AND CANNOT BE. `Auth.gs` opens with
 *
 *     var ALL_ROLES = [ROLES.SALES_COORDINATOR, ...];
 *
 * which runs the moment the file loads and needs `ROLES` to exist already — and `ROLES` lives
 * in Settings.gs. Apps Script has its own order that happens to work; nothing says what it is,
 * and depending on a guess about it is how a server starts failing six months later when
 * somebody adds a file.
 *
 * So the order is discovered rather than declared: load every file, and when one throws a
 * ReferenceError for a name that has not been defined yet, set it aside and try again after
 * the rest. Each pass defines more names, so each pass lets more files through. If a pass
 * defines nothing new, the remaining files have a genuine cycle or a genuine missing name, and
 * that is reported with the name in it rather than retried forever.
 *
 * This also makes the loader the first thing to notice a file that cannot load at all, which
 * nothing else in the suite was checking.
 *
 * As it happens all 42 load on the first pass today, because `ROLES` is declared in Auth.gs
 * and Auth sorts first. That is luck, not design — one new file named earlier in the alphabet
 * and the first pass stops working — so the retry is tested directly against a pair of files
 * built for the purpose rather than left to be exercised for the first time in production.
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const { globalsFor } = require('./shim.js');
const { platformFor } = require('./platform.js');

const MODULES = path.join(__dirname, 'modules');
const QUERIES = path.join(__dirname, 'queries');

/**
 * Compiled once, run into a fresh context per request.
 *
 * A context per request is not negotiable — the shim keeps "which connection am I on" and
 * "who is calling" in it, and two requests sharing that would put one person's statements
 * inside another's transaction. But PARSING 42 files for every request is waste: it is the
 * same 42 files, and V8 will happily run one compiled script into many contexts.
 *
 * Keyed by path and modification time, so editing a module during development picks the new
 * one up without a restart, and production never recompiles at all.
 */
const COMPILED = new Map();

function compiled(file) {
  let stamp = 0;
  try { stamp = fs.statSync(file).mtimeMs; } catch (err) { stamp = 0; }
  const hit = COMPILED.get(file);
  if (hit && hit.stamp === stamp) return hit.script;
  const script = new vm.Script(fs.readFileSync(file, 'utf8'),
    { filename: path.relative(__dirname, file) });
  COMPILED.set(file, { stamp, script });
  return script;
}

/**
 * @param db       a Db from db.js, already bound to a tenant
 * @param actor    whose email the audit trail and the per-user cache are keyed by
 * @param opts     passed through to platformFor: properties, baseUrl, cache, quiet.
 *                 `modulesDir` and `queriesDir` point it somewhere else, which is how the
 *                 load-order recovery is tested without inventing a broken module in src/.
 * @return         the context, with every module's functions on it
 */
function loadPortal(db, actor, opts) {
  const o = opts || {};
  const sandbox = {
    console, JSON, Math, Date, isNaN, isFinite, parseInt, parseFloat, RegExp, Error,
    String, Number, Boolean, Array, Object, Promise, encodeURIComponent,
    decodeURIComponent, setTimeout, clearTimeout
  };
  Object.defineProperties(sandbox,
    Object.getOwnPropertyDescriptors(platformFor(Object.assign({ actor }, o))));
  // Descriptors, not Object.assign. The shim exposes `db` as a GETTER returning whichever
  // connection is current, so that a query file writing `db.q(...)` inside a transaction runs
  // on the transaction. Object.assign invokes the getter and copies the value it happened to
  // return, which was the pool — so every such query ran outside the transaction it was
  // wrapped in, and a rollback rolled back nothing. Found by a rename test that threw halfway
  // and then found the new addresses still there.
  Object.defineProperties(sandbox, Object.getOwnPropertyDescriptors(globalsFor(db, actor)));

  // Everything present before a single portal file is loaded: the intrinsics above, the
  // platform shim, the database shim. Whatever is a function after loading and is not in
  // here was declared by the portal, and that is the set the browser may reach.
  const injected = new Set(Object.keys(sandbox));

  // normalizeCell_ needs the platform's date formatting, which the shim has no handle on, so
  // it is bound here where both halves are in scope. Nothing reaches it any more — the only
  // caller was a Pricing function that server/queries replaced — but an unreachable function
  // that would throw if it were ever reached is not worth the saving.
  const { normalizeCell_ } = require('./helpers.js');
  sandbox.normalizeCell_ = (v) => normalizeCell_(v, sandbox.Utilities, sandbox.Session);

  vm.createContext(sandbox);

  const modulesDir = o.modulesDir || MODULES;
  const queriesDir = o.queriesDir || QUERIES;

  const files = fs.readdirSync(modulesDir).filter((f) => f.endsWith('.js')).sort();
  const order = [];
  let waiting = files.slice();
  const lastError = {};

  while (waiting.length) {
    const defined = Object.keys(sandbox).length;
    const stillWaiting = [];

    for (const f of waiting) {
      try {
        compiled(path.join(modulesDir, f)).runInContext(sandbox);
        order.push(f);
      } catch (err) {
        // A name this file needs is in a file not loaded yet. Anything else is a real
        // problem in the file and is raised now, not buried in a retry.
        //
        // By name, not `instanceof`. The error is thrown inside the vm context, which has its
        // own realm and therefore its own ReferenceError constructor, so `instanceof
        // ReferenceError` is false for every one of them. The recovery below could never
        // have run — it reported a load-order problem as a broken file instead, which is the
        // opposite of what it is for. Found by the first test that gave it something to
        // recover from.
        if (err === null || typeof err !== 'object' || err.name !== 'ReferenceError') {
          throw new Error('modules/' + f + ' failed to load: ' +
            (err && err.message ? err.message : String(err)));
        }
        lastError[f] = err.message;
        stillWaiting.push(f);
      }
    }

    if (stillWaiting.length === waiting.length && Object.keys(sandbox).length === defined) {
      // Nothing moved and nothing new was defined, so another pass would do the same.
      throw new Error('These modules cannot load — a missing name or a cycle between them:\n' +
        stillWaiting.map((f) => '  ' + f + ': ' + lastError[f]).join('\n'));
    }
    waiting = stillWaiting;
  }

  // The hand-written SQL last, so its definitions replace the faithful translations they were
  // written to supersede. The generated module keeps the original, now unreachable, which is
  // not dead weight: it is the specification the query has to reproduce, sitting next to it
  // for anyone checking the two agree.
  const overridden = [];
  if (fs.existsSync(queriesDir)) {
    for (const f of fs.readdirSync(queriesDir).filter((f) => f.endsWith('.js')).sort()) {
      // The values before, not just the names. Comparing names alone reported every function
      // in the context as overridden — the shim's twelve, the platform's, the lot — because
      // they were all there before and all still functions after. A list that says everything
      // was replaced says nothing, and it made the check that priceMapFor_ really had been
      // replaced pass for the wrong reason.
      const before = new Map(Object.keys(sandbox).map((k) => [k, sandbox[k]]));
      compiled(path.join(queriesDir, f)).runInContext(sandbox);
      // What a query file redefines is the interesting part, so it is recorded rather than
      // assumed: a file that was meant to replace priceMapFor_ and quietly defines
      // priceMapFor2_ because of a typo would otherwise look like it worked.
      Object.keys(sandbox).forEach((k) => {
        if (before.has(k) && before.get(k) !== sandbox[k] && typeof sandbox[k] === 'function') {
          overridden.push(k);
        }
      });
    }
  }

  sandbox.__loaded = order;
  sandbox.__overridden = overridden;

  /**
   * The names the portal's own files declared, and nothing else.
   *
   * Session.gs's `call` decides what the browser may reach with a DENY list: not ending in
   * an underscore, not one of the editor-only doors, and `typeof this[name] === 'function'`.
   * On Apps Script that was airtight, because on Apps Script every global IS a portal
   * declaration — there is nothing else in the scope to find.
   *
   * Here there is. The context also holds the shim, the platform and JavaScript's own
   * intrinsics, so `constructor`, `toString`, `Object`, `Array`, `setTimeout` and
   * `withTransaction` all satisfy those three conditions. None of them is an escape today —
   * `eval` and `Function` are not reachable through this object, and arguments arrive as
   * JSON so no function can be passed in — but the shape is wrong, and the risk is not
   * today's: it is that the next useful global somebody adds to this sandbox joins the
   * public API without anybody deciding that it should.
   *
   * So the deny list gains an allow list. Only what the module and query files declared,
   * captured here where it is known exactly.
   */
  // Object.create(null), not {}. A plain object inherits from Object.prototype, so
  // `declared['constructor']` and `declared['toString']` are truthy whatever is in it — and
  // those are exactly the two names this list was added to shut out. The fix for a
  // prototype-chain hole had the same hole in it, which the check below caught.
  const declared = Object.create(null);
  for (const name of Object.keys(sandbox)) {
    if (injected.has(name)) continue;
    if (typeof sandbox[name] !== 'function') continue;
    declared[name] = true;
  }
  sandbox.PORTAL_FUNCTIONS_ = declared;

  return sandbox;
}

module.exports = { loadPortal };
