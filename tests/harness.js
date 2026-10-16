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

// Shared with the server rather than written twice. Its own test checks it against the
// timezone PIE works in and against the two patterns this code uses.
const { formatDate: realFormatDate } = require(path.join(__dirname, '..', 'server', 'platform.js'));

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
        getId: () => 'test-spreadsheet-id',
        getUrl: () => 'https://example.invalid/sheet',
        getSheets: () => Object.keys(TABS).map(sheetFor)
      })
    },

    /**
     * Drive, in memory. Its folders are reachable as `sandbox.DriveApp._folders`.
     *
     * Added for the migration export, which writes one file per tab and whose whole value is
     * that the files can be checked afterwards. A stub that accepted createFile and threw the
     * content away would let the export pass every test while writing nothing — which is
     * precisely the failure that matters on a cutover there is one attempt at.
     *
     * Trashing is modelled rather than ignored, because the export replaces a tab's file on a
     * re-run and a stub that kept both would hide a duplicate-file bug that makes an import
     * ambiguous.
     */
    DriveApp: (() => {
      const folders = {};
      const makeFolder = (name) => {
        const id = 'folder-' + (Object.keys(folders).length + 1);
        const files = [];
        const folder = {
          getId: () => id,
          getName: () => name,
          getUrl: () => 'https://example.invalid/folder/' + id,
          createFile: (blob) => {
            const file = {
              getName: () => blob.getName(),
              getBlob: () => blob,
              getId: () => 'file-' + files.length,
              trashed: false,
              setTrashed: (t) => { file.trashed = !!t; return file; }
            };
            files.push(file);
            return file;
          },
          getFilesByName: (wanted) => {
            const hits = files.filter((f) => !f.trashed && f.getName() === wanted);
            let at = 0;
            return { hasNext: () => at < hits.length, next: () => hits[at++] };
          },
          getFiles: () => {
            const live = files.filter((f) => !f.trashed);
            let at = 0;
            return { hasNext: () => at < live.length, next: () => live[at++] };
          },
          _files: files
        };
        folders[id] = folder;
        return folder;
      };
      return {
        createFolder: makeFolder,
        getFolderById: (id) => {
          if (!folders[id]) throw new Error('No folder with id ' + id);
          return folders[id];
        },
        getFoldersByName: (wanted) => {
          const hits = Object.values(folders).filter((f) => f.getName() === wanted);
          let at = 0;
          return { hasNext: () => at < hits.length, next: () => hits[at++] };
        },
        _folders: folders
      };
    })(),
    Session: {
      getScriptTimeZone: () => 'Asia/Kolkata',
      getActiveUser: () => ({ getEmail: () => 'tester@pie.in' }),
      getEffectiveUser: () => ({ getEmail: () => 'tester@pie.in' })
    },
    Utilities: {
      // The real implementation, shared with the server, not a constant.
      //
      // This returned the fixed string '2026-10-06' whatever it was asked, which made every
      // date the sheet code computes a lie. `previousDay_('2026-10-16')` answered '2026-10-06'
      // — ten days adrift — so savePricesBulk_ closed a superseded price ten days before its
      // replacement started and the price vanished for that window. Nothing noticed, because
      // the only thing checking was comparing one stubbed answer against another.
      //
      // This file's own opening comment warns about exactly this: "A test passing against a
      // stub that behaves differently from the real API is worse than no test, because it is
      // believed." It was true of this line.
      formatDate: (d, tz, pattern) => realFormatDate(d, tz, pattern),
      getUuid: () => 'u' + (++uuid),
      sleep() {},
      base64Encode: (s) => Buffer.from(String(s)).toString('base64'),
      base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')),
      /**
       * A blob that still holds what it was given.
       *
       * This kept the bytes and discarded everything else: getDataAsString did not exist and
       * setName returned an empty object instead of the blob. Fine while the only callers
       * were attaching a PDF nobody read back; not fine for the migration export, whose whole
       * value is that the files it writes can be opened afterwards and checked. A stub that
       * accepts content and loses it lets an export pass every test while writing nothing.
       */
      newBlob: (content, type, name) => {
        let blobName = name || '';
        const bytes = Buffer.isBuffer(content) ? content
          : Buffer.from(typeof content === 'string' ? content : Array.from(content));
        const blob = {
          getBytes: () => Array.from(bytes),
          getDataAsString: () => bytes.toString('utf8'),
          getContentType: () => type || 'application/octet-stream',
          getName: () => blobName,
          setName: (n) => { blobName = n; return blob; },
          getAs: () => blob,
          copyBlob: () => blob
        };
        return blob;
      }
    },
    MailApp: {
      sendEmail: (o) => { sandbox.__sent.push(o); },
      getRemainingDailyQuota: () => 1500
    },
    UrlFetchApp: {
      fetch: () => ({ getResponseCode: () => 200, getContentText: () => '' })
    },
    // Project triggers, as a list. Enough to install one, find it and delete it — which is
    // the whole of what the keep-warm experiment does to the project.
    ScriptApp: {
      getProjectTriggers: () => sandbox.__triggers.slice(),
      deleteTrigger: (t) => {
        const i = sandbox.__triggers.indexOf(t);
        if (i !== -1) sandbox.__triggers.splice(i, 1);
      },
      newTrigger: (fn) => {
        const spec = { fn, minutes: null };
        const builder = {
          timeBased: () => builder,
          everyMinutes: (n) => { spec.minutes = n; return builder; },
          create: () => {
            const t = { getHandlerFunction: () => spec.fn, minutes: spec.minutes };
            sandbox.__triggers.push(t);
            return t;
          }
        };
        return builder;
      },
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' })
    },
    __triggers: [],
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

/**
 * Counts what a call actually asked the spreadsheet for.
 *
 * Not reads-of-tabs — individual operations, because on this platform every one of them is a
 * round trip and that is the unit the portal is slow in. getLastRow() looks free in the
 * source and is not; counting one saveSpareEnquiry found fourteen operations, five of them
 * the same two questions asked over again.
 *
 * Wraps getSheetByName only. getSheet_ goes through it, and so does the audit writer, so one
 * door catches everything — wrapping both counted every operation twice, which is how the
 * first measurement reported an append that was never happening.
 */
function countOps(sb) {
  const ops = [];
  const COUNTED = ['appendRow', 'getRange', 'getLastRow', 'getLastColumn', 'deleteRow',
    'deleteRows', 'clear'];
  const RANGE_OPS = ['getValues', 'setValues', 'clearContent', 'setValue', 'getValue'];

  const wrapRange = (name, range) => new Proxy(range, {
    get(t, k) {
      const v = t[k];
      if (typeof v !== 'function') return v;
      return (...a) => {
        if (RANGE_OPS.indexOf(String(k)) !== -1) ops.push(name + '.' + String(k));
        return v.apply(t, a);
      };
    }
  });

  const wrapSheet = (name, sheet) => new Proxy(sheet, {
    get(t, k) {
      const v = t[k];
      if (typeof v !== 'function') return v;
      return (...a) => {
        if (COUNTED.indexOf(String(k)) !== -1) ops.push(name + '.' + String(k));
        const out = v.apply(t, a);
        return String(k) === 'getRange' ? wrapRange(name, out) : out;
      };
    }
  });

  const realGet = sb.SpreadsheetApp.getActiveSpreadsheet;
  sb.SpreadsheetApp.getActiveSpreadsheet = function () {
    const ss = realGet.apply(null, arguments);
    const byName = ss.getSheetByName;
    ss.getSheetByName = (n) => { const sh = byName(n); return sh ? wrapSheet(n, sh) : sh; };
    return ss;
  };

  return {
    ops,
    reset() {
      ops.length = 0;
      // The sheet cache holds objects fetched before the spy existed, and the header and
      // dimension caches would answer from the last call. A measurement has to start cold
      // or it measures the previous one.
      if (sb.invalidateHeaders_) sb.invalidateHeaders_();
    },
    count(suffix) { return ops.filter((o) => o.indexOf(suffix) !== -1).length; },
    tally() {
      const out = {};
      ops.forEach((o) => { out[o] = (out[o] || 0) + 1; });
      return out;
    }
  };
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

module.exports = { load, reset, table, rowsOf, liveRows, makeRow, cell, checks, countOps, SRC };
