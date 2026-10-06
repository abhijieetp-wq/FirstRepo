/**
 * The Apps Script platform, faked well enough to run the real server code against.
 *
 * Every `.gs` file in this project assumes a handful of Google globals — SpreadsheetApp,
 * LockService, CacheService, PropertiesService, Utilities, Session. This provides them over
 * plain JavaScript objects and an in-memory tab, then loads the real source into a `vm`
 * context and hands it back. Nothing is mocked that the code under test actually does: the
 * sheet is a fake, the logic is not.
 *
 * Why a shared harness rather than one per test: every file had its own copy, which drifted,
 * and the copies disagreed about things like whether getRange(1, ...) includes the header row.
 * A test passing against a stub that behaves differently from the real API is worse than no
 * test, because it is believed.
 *
 * Usage:
 *
 *   const { load, table, rowsOf, cell } = require('./harness');
 *   const sb = load(['Auth.gs', 'Schema.gs', 'SheetService.gs', 'Customers.gs']);
 *   sb.getCurrentUser = () => ({ email: 'p@pie.in', role: 'ERP Admin' });
 *
 * Load every module whose functions get reached, not just the one under test — Apps Script
 * puts them all in one scope, so a missing file surfaces as `X is not defined` from somewhere
 * unrelated.
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

/** The tabs of the current fake spreadsheet: { name: { headers: [], rows: [[]] } }. */
let TABS = {};

function sheetFor(name) {
  const t = TABS[name];
  return {
    getName: () => name,
    getLastRow: () => t.rows.length + 1,
    getLastColumn: () => t.headers.length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => {
        const R = nr || 1;
        const C = nc || t.headers.length;
        // A range starting at row 1 spans the header AND the body. The real Sheets API has
        // always worked this way; an earlier stub returned only the header, which hid the
        // fact that reading a tab was costing two round trips instead of one.
        const all = [t.headers].concat(t.rows);
        return all.slice(r - 1, r - 1 + R).map(row => {
          const o = (row || []).slice(c - 1, c - 1 + C);
          while (o.length < C) o.push('');
          return o;
        });
      },
      setValues: (v) => {
        if (r === 1) {
          for (let j = 0; j < v[0].length; j++) t.headers[c - 1 + j] = v[0][j];
          t.rows.forEach(row => { while (row.length < t.headers.length) row.push(''); });
          return;
        }
        v.forEach((row, k) => {
          const i = r - 2 + k;
          while (t.rows.length <= i) t.rows.push(new Array(t.headers.length).fill(''));
          for (let j = 0; j < row.length; j++) t.rows[i][c - 1 + j] = row[j];
        });
      },
      setFontWeight() { return this; },
      setValue() { return this; },
      // Really blanks the cells. It was a no-op, which made deleteRowsWhere_ look broken
      // when it was not — a stub that quietly does nothing is how a test comes to disagree
      // with the platform it is standing in for.
      clearContent() {
        const C = nc || t.headers.length;
        for (let k = 0; k < (nr || 1); k++) {
          const i = r - 2 + k;
          if (i < 0 || i >= t.rows.length) continue;
          for (let j = 0; j < C; j++) t.rows[i][c - 1 + j] = '';
        }
        return this;
      }
    }),
    deleteRow: (r) => { t.rows.splice(r - 2, 1); },
    deleteRows: (r, n) => { t.rows.splice(r - 2, n); },
    appendRow: (row) => { t.rows.push(row.slice()); },
    insertSheet() { return this; },
    setFrozenRows() { return this; },
    autoResizeColumns() { return this; },
    clear() { t.rows = []; return this; }
  };
}

/** A script-scoped store that behaves like CacheService/PropertiesService well enough. */
function keyStore(initial) {
  const m = Object.assign({}, initial || {});
  return {
    get: (k) => (m.hasOwnProperty(k) ? m[k] : null),
    getProperty: (k) => (m.hasOwnProperty(k) ? m[k] : null),
    put: (k, v) => { m[k] = v; },
    setProperty: (k, v) => { m[k] = v; },
    remove: (k) => { delete m[k]; },
    deleteProperty: (k) => { delete m[k]; },
    getProperties: () => Object.assign({}, m),
    _all: m
  };
}

/**
 * Builds the sandbox, loads the named source files into it, and returns it.
 *
 * `props` seeds Script Properties, which is how features that are off by default — the
 * Google sign-in gate, the timing — get switched on for a test.
 */
function load(files, props) {
  const scriptProps = keyStore(props);
  const scriptCache = keyStore();
  const userCache = keyStore();
  let uuid = 0;

  const sandbox = {
    console,
    Logger: { log() {} },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {}, tryLock: () => true })
    },
    PropertiesService: {
      getScriptProperties: () => scriptProps,
      getDocumentProperties: () => scriptProps,
      getUserProperties: () => keyStore()
    },
    CacheService: {
      getScriptCache: () => scriptCache,
      getUserCache: () => userCache,
      getDocumentCache: () => scriptCache
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => (TABS[n] ? sheetFor(n) : null),
        insertSheet: (n) => { TABS[n] = { headers: [], rows: [] }; return sheetFor(n); },
        getName: () => 'ERP (test)',
        getUrl: () => 'https://example.invalid/sheet',
        getSheets: () => Object.keys(TABS).map(sheetFor)
      })
    },
    Session: {
      getScriptTimeZone: () => 'Asia/Kolkata',
      getActiveUser: () => ({ getEmail: () => 'tester@pie.in' }),
      getEffectiveUser: () => ({ getEmail: () => 'tester@pie.in' })
    },
    Utilities: {
      formatDate: () => '2026-10-06',
      getUuid: () => 'u' + (++uuid),
      sleep() {},
      base64Encode: (s) => Buffer.from(String(s)).toString('base64'),
      base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')),
      newBlob: (content, type, name) => ({
        getBytes: () => Array.from(Buffer.from(String(content))),
        getAs: () => ({ setName: () => ({}) }),
        setName: () => ({}),
        getName: () => name || ''
      })
    },
    MailApp: {
      sendEmail: (o) => { sandbox.__sent.push(o); },
      getRemainingDailyQuota: () => 1500
    },
    UrlFetchApp: {
      fetch: () => ({ getResponseCode: () => 200, getContentText: () => '' })
    },
    __sent: []
  };

  vm.createContext(sandbox);
  files.forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
  });
  return sandbox;
}

/** Empties every tab the schema declares, so each test starts from a known sheet. */
function reset(sb) {
  if (sb.invalidateHeaders_) sb.invalidateHeaders_();
  TABS = {};
  Object.keys(sb.SCHEMA).forEach((n) => {
    TABS[n] = { headers: sb.SCHEMA[n].columns.slice(), rows: [] };
  });
  return TABS;
}

/** The raw tab, for seeding and for asserting against. */
function table(name) { return TABS[name]; }
function rowsOf(name) { return TABS[name].rows; }

/**
 * Rows with something in them.
 *
 * A cleared row is blanked in place rather than removed, exactly as it is on a real sheet, so
 * the raw array stays its old length. readTable_ skips blanks; a test asserting on emptiness
 * has to do the same or it is asserting about the stub.
 */
function liveRows(name) {
  return TABS[name].rows.filter((r) => r.some((c) => c !== '' && c !== null));
}

/** Builds a row in a tab's column order from a plain object. */
function makeRow(sb, name, obj) {
  const headers = sb.SCHEMA[name].columns;
  const row = new Array(headers.length).fill('');
  Object.keys(obj).forEach((k) => {
    const i = headers.indexOf(k);
    if (i === -1) throw new Error(name + ' has no column ' + k);
    row[i] = obj[k];
  });
  return row;
}

/** One cell of one row, by the row's id. */
function cell(sb, name, id, column) {
  const headers = sb.SCHEMA[name].columns;
  const idCol = headers.indexOf('id');
  const col = headers.indexOf(column);
  const row = TABS[name].rows.find((r) => String(r[idCol]) === String(id));
  return row ? row[col] : undefined;
}

/** A tiny assertion counter. Prints only failures; the tail line carries the score. */
function checks() {
  let pass = 0;
  const failures = [];
  return {
    ok(label, cond, detail) {
      if (cond) { pass++; return; }
      failures.push(label + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
      console.log('  FAIL: ' + failures[failures.length - 1]);
    },
    /** Runs fn and returns the thrown message, or null if it did not throw. */
    threw(fn) {
      try { fn(); return null; } catch (e) { return e.message; }
    },
    done() {
      const total = pass + failures.length;
      console.log('\n' + (failures.length
        ? 'FAILED ' + failures.length + '  (' + pass + '/' + total + ')'
        : 'all ' + pass + ' passed'));
      process.exit(failures.length ? 1 : 0);
    }
  };
}

module.exports = { load, reset, table, rowsOf, liveRows, makeRow, cell, checks, SRC };
