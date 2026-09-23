/**
 * Generic sheet-backed table access. Every tab in the bound Spreadsheet is treated as a
 * table whose first row is the header row. All read/write helpers key off those headers,
 * so a tab's columns are the single source of truth for its schema.
 */

/**
 * Everything below reads through a cache that lives for one request and no longer.
 *
 * Apps Script charges by the round trip, not the cell: every getRange().getValues() is an
 * RPC to Google's servers costing tens of milliseconds whether it fetches one cell or ten
 * thousand. Reading a tab therefore cost two trips — one for the header row, one for the
 * body — and a screen that touched six tabs paid twelve. Printing an offer read the
 * QuoteTemplates header twelve separate times.
 *
 * A server-side script instance handles one request and is then discarded, so these caches
 * cannot outlive the call that filled them and there is no cross-user staleness to reason
 * about. Within a call, headers only move when a column is added, which is why the structural
 * operations below drop them explicitly.
 */
var SHEET_CACHE_ = {};
var HEADER_CACHE_ = {};
// The raw cell block per tab, exactly as it came back from the sheet. Objects are still built
// fresh on every readTable_ call, so a caller that mutates a row cannot affect the next one —
// what is saved is the round trip, not the work.
var TABLE_CACHE_ = {};

/** Forgets a tab's cached headers. Called wherever a column is added or the tab is rebuilt. */
function invalidateHeaders_(name) {
  if (name === undefined) {
    HEADER_CACHE_ = {}; SHEET_CACHE_ = {}; TABLE_CACHE_ = {};
    return;
  }
  delete HEADER_CACHE_[name];
  delete TABLE_CACHE_[name];
}

/**
 * Forgets a tab's cached rows. Every write must call this, including the handful that reach
 * the sheet directly instead of through the helpers below — a write whose tab stays cached
 * would be invisible to the rest of the same request, which is the one way this cache can
 * do harm. Called with no argument it drops everything, which is what the bulk operations do.
 */
function invalidateTable_(name) {
  if (name === undefined) { TABLE_CACHE_ = {}; return; }
  delete TABLE_CACHE_[name];
}

/** Registers a Sheet fetched without getSheet_, so its headers cache like any other. */
function rememberSheet_(name, sheet) {
  if (!SHEET_CACHE_.hasOwnProperty(name)) SHEET_CACHE_[name] = sheet;
  return sheet;
}

function getSheet_(name) {
  if (SHEET_CACHE_.hasOwnProperty(name)) return SHEET_CACHE_[name];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    // Almost always means the schema moved on but setupSheet() hasn't been re-run yet.
    var known = SCHEMA && SCHEMA.hasOwnProperty(name);
    throw new Error('The "' + name + '" tab is missing from the spreadsheet.' +
      (known
        ? ' Run setupSheet() from the Apps Script editor to create it — the schema has been updated since this Sheet was last set up.'
        : ' This tab is not part of the declared schema, which suggests a code error rather than a setup step.'));
  }
  SHEET_CACHE_[name] = sheet;
  return sheet;
}

/**
 * The header row, cached per tab for the life of the request.
 *
 * `name` is how the cache is keyed. Every caller already knows it — they asked getSheet_ for
 * the tab a line earlier — and passing it beats deriving it, which would mean either a
 * getName() round trip or a reverse lookup that fails quietly on a Sheet fetched some other
 * way. A caller that genuinely has only the Sheet may omit it and pay for getName().
 */
function getHeaders_(sheet, name) {
  var key = name === undefined ? sheet.getName() : name;
  if (HEADER_CACHE_.hasOwnProperty(key)) return HEADER_CACHE_[key];
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h).trim();
  });
  HEADER_CACHE_[key] = headers;
  return headers;
}

function normalizeCell_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd');
  }
  return v;
}

/** Reads every non-blank row of a tab into an array of plain objects keyed by header name.
 *  Each object also carries `_row`, the 1-indexed sheet row, for later update/delete calls. */
function readTable_(sheetName) {
  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];

  // One round trip, not two. The header row used to be fetched separately from the body,
  // which doubled the cost of reading any tab — and reading a tab is what this application
  // spends its time on. Taking the block from row 1 gets both, and the headers are kept so
  // the next caller in this request does not pay for them again.
  var block = TABLE_CACHE_.hasOwnProperty(sheetName)
    ? TABLE_CACHE_[sheetName]
    : (TABLE_CACHE_[sheetName] = sheet.getRange(1, 1, lastRow, lastCol).getValues());
  var headers = HEADER_CACHE_[sheetName] ||
    (HEADER_CACHE_[sheetName] = block[0].map(function (h) { return String(h).trim(); }));
  if (lastRow < 2 || headers.length === 0) return [];
  var values = block.slice(1);
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var blank = row.every(function (c) { return c === '' || c === null; });
    if (blank) continue;
    var obj = {};
    headers.forEach(function (h, idx) {
      obj[h] = normalizeCell_(row[idx]);
    });
    obj._row = i + 2;
    rows.push(obj);
  }
  return rows;
}

/** Appends one row, taking values from `obj` for each existing header (missing keys become ''). */
/**
 * Refuses to write a field the sheet has no column for.
 *
 * Both writers map over the sheet's own headers, so anything the sheet does not have a column
 * for was silently thrown away — the value appeared to save, then came back empty on the next
 * read, with nothing anywhere saying why. That is how a logo could be uploaded a dozen times
 * and never stick.
 *
 * A field the schema declares but the sheet lacks means the sheet is behind the code, which
 * Run Setup fixes; that is worth stopping for. A field the schema does not declare at all is a
 * mistake in the code rather than in the sheet, and is logged rather than thrown so that one
 * stray key cannot take a working screen down.
 */
function assertWritableFields_(sheetName, headers, obj) {
  var unknown = Object.keys(obj).filter(function (k) { return headers.indexOf(k) === -1; });
  if (!unknown.length) return;

  var declared = (SCHEMA[sheetName] && SCHEMA[sheetName].columns) || [];
  var behind = unknown.filter(function (k) { return declared.indexOf(k) !== -1; });

  if (behind.length) {
    throw new Error('The "' + sheetName + '" tab is missing the column' +
      (behind.length > 1 ? 's ' : ' ') + behind.join(', ') +
      ', so that value cannot be saved. The sheet is behind the code — open ' +
      'Settings → System and press Run Setup, which adds missing columns without touching ' +
      'anything already there.');
  }

  var stray = unknown.filter(function (k) { return declared.indexOf(k) === -1; });
  if (stray.length) {
    console.warn('Ignored field(s) not declared for ' + sheetName + ': ' + stray.join(', '));
  }
}

function appendRow_(sheetName, obj, auditReason) {
  var lock = acquireLock_(LOCK_WAIT_ROW_MS, 'that save');
  try {
    var sheet = getSheet_(sheetName);
    var headers = getHeaders_(sheet, sheetName);
    assertWritableFields_(sheetName, headers, obj);
    var row = headers.map(function (h) {
      return obj.hasOwnProperty(h) && obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
    });
    invalidateTable_(sheetName);
    sheet.appendRow(row);
    audit_('Create', sheetName, obj.id || '', '', '', '', auditReason);
    return sheet.getLastRow();
  } finally {
    lock.releaseLock();
  }
}

/** Merges `patch` onto the row whose `idField` column equals `idValue`. Untouched columns keep their value. */
function updateRowById_(sheetName, idField, idValue, patch, auditReason) {
  var lock = acquireLock_(LOCK_WAIT_ROW_MS, 'that save');
  try {
    var sheet = getSheet_(sheetName);
    var headers = getHeaders_(sheet, sheetName);
    var idCol = headers.indexOf(idField);
    if (idCol === -1) throw new Error('Column "' + idField + '" not found in ' + sheetName);
    assertWritableFields_(sheetName, headers, patch);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('No rows in ' + sheetName + ' yet.');
    // The tab is usually already in hand — the caller read it to decide on this very update.
    // When it is, finding the row and reading its current values costs nothing; when it is
    // not, the id column is fetched as before rather than pulling the whole tab in.
    var cached = TABLE_CACHE_[sheetName];
    var ids = cached
      ? cached.slice(1).map(function (r) { return [r[idCol]]; })
      : sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(idValue)) {
        var rowNum = i + 2;
        var current = cached
          ? cached[i + 1].slice(0, headers.length)
          : sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
        var changes = [];
        var updated = headers.map(function (h, idx) {
          if (!patch.hasOwnProperty(h)) return current[idx];
          if (String(patch[h]) !== String(current[idx])) {
            changes.push({ field: h, oldValue: current[idx], newValue: patch[h] });
          }
          return patch[h];
        });
        invalidateTable_(sheetName);
        sheet.getRange(rowNum, 1, 1, headers.length).setValues([updated]);
        auditMany_(changes.map(function (c) {
          return { action: 'Update', tableName: sheetName, recordId: idValue,
            fieldName: c.field, oldValue: c.oldValue, newValue: c.newValue, reason: auditReason };
        }));
        return true;
      }
    }
    throw new Error('Row with ' + idField + '=' + idValue + ' not found in ' + sheetName);
  } finally {
    lock.releaseLock();
  }
}

function deleteRowById_(sheetName, idField, idValue, auditReason) {
  var lock = acquireLock_(LOCK_WAIT_ROW_MS, 'that delete');
  try {
    var sheet = getSheet_(sheetName);
    var headers = getHeaders_(sheet, sheetName);
    var idCol = headers.indexOf(idField);
    if (idCol === -1) throw new Error('Column "' + idField + '" not found in ' + sheetName);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('No rows in ' + sheetName + ' yet.');
    var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(idValue)) {
        var doomed = sheet.getRange(i + 2, 1, 1, headers.length).getValues()[0].join(' | ');
        invalidateTable_(sheetName);
        sheet.deleteRow(i + 2);
        audit_('Delete', sheetName, idValue, '', doomed, '', auditReason);
        return true;
      }
    }
    throw new Error('Row with ' + idField + '=' + idValue + ' not found in ' + sheetName);
  } finally {
    lock.releaseLock();
  }
}

/**
 * How long each kind of write is prepared to queue behind another one.
 *
 * A single-row save is quick, so waiting long for it means something is wrong. A bulk import
 * or price load holds the sheet for as long as it takes to rewrite tens of thousands of cells
 * — minutes, on a real catalogue — and the next one in the queue should wait that out rather
 * than give up on it. Apps Script caps waitLock at five minutes.
 */
var LOCK_WAIT_ROW_MS = 10000;
var LOCK_WAIT_BULK_MS = 240000;

/**
 * Takes the script lock, or fails with something a person can act on.
 *
 * Apps Script's own message is "Lock timeout: another process was holding the lock for too
 * long", which says nothing about what was holding it, whether any data was written, or what
 * to do next. All three matter here: an import that cannot take the lock has written nothing
 * at all, because the lock comes before the first write — and being told that is the
 * difference between retrying calmly and going to hunt for half-loaded rows.
 */
function acquireLock_(waitMs, what) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(waitMs);
  } catch (e) {
    throw new Error('Could not start ' + what + ': another save or import is still running, ' +
      'and it did not finish within ' + Math.round(waitMs / 1000) + ' seconds. A large ' +
      'catalogue import holds the sheet for a few minutes — wait for it to report how many ' +
      'rows it wrote, then try again. Nothing from this attempt was written.');
  }
  return lock;
}

/**
 * Deletes every row a predicate matches, by rewriting the tab rather than deleting row by row.
 *
 * `deleteRowById_` re-reads and re-indexes for each row, which is right for one row and
 * unusable for hundreds — and deleting rows from under an index shifts every row after it.
 * This reads once, keeps the rows that do not match, writes them back, and logs one audit
 * entry for the batch rather than burying the log.
 */
function deleteRowsWhere_(sheetName, matches, auditReason) {
  var lock = acquireLock_(LOCK_WAIT_BULK_MS, 'that clear-out');
  try {
    var sheet = getSheet_(sheetName);
    var headers = getHeaders_(sheet, sheetName);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2 || !headers.length) return 0;

    var block = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    var survivors = [];
    var removed = 0;

    block.forEach(function (row) {
      var blank = row.every(function (c) { return c === '' || c === null; });
      if (blank) return;
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = normalizeCell_(row[i]); });
      if (matches(obj)) { removed++; return; }
      survivors.push(row);
    });

    if (!removed) return 0;

    invalidateTable_(sheetName);
    sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
    if (survivors.length) {
      sheet.getRange(2, 1, survivors.length, headers.length).setValues(survivors);
    }
    audit_('Delete', sheetName, '(bulk)', '', removed + ' rows', '', auditReason);
    return removed;
  } finally {
    lock.releaseLock();
  }
}

/**
 * One row by its id, without materialising the table to find it.
 *
 * `readTable_` builds an object for every row and normalizes every cell. Asking it for one
 * row out of a spare catalogue means 3,500 objects and 60,000 cell conversions to reach the
 * one that was wanted — which is what every added quotation line was paying.
 */
function findRowById_(sheetName, idValue) {
  var sheet = getSheet_(sheetName);
  var headers = getHeaders_(sheet, sheetName);
  var lastRow = sheet.getLastRow();
  var idCol = headers.indexOf('id');
  if (lastRow < 2 || idCol === -1) return null;

  var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  var want = String(idValue);
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) !== want) continue;
    var row = sheet.getRange(i + 2, 1, 1, headers.length).getValues()[0];
    var obj = {};
    headers.forEach(function (h, idx) { obj[h] = normalizeCell_(row[idx]); });
    obj._row = i + 2;
    return obj;
  }
  return null;
}

/**
 * Every row whose `column` holds one of `values`, without reading the tab.
 *
 * Asking a table of orders which ones belong to one quotation used to mean building an object
 * for all of them and throwing away all but one. Here one read of the column being matched
 * says which rows can possibly qualify, and only those are fetched.
 */
function findRowsByColumn_(sheetName, column, values) {
  var sheet = getSheet_(sheetName);
  var headers = getHeaders_(sheet, sheetName);
  var lastRow = sheet.getLastRow();
  var col = headers.indexOf(column);
  if (lastRow < 2 || col === -1) return [];

  var want = {};
  var any = false;
  (values || []).forEach(function (v) {
    if (v === '' || v === null || v === undefined) return;
    want[String(v)] = true;
    any = true;
  });
  if (!any) return [];

  var keys = sheet.getRange(2, col + 1, lastRow - 1, 1).getValues();
  var hits = [];
  for (var i = 0; i < keys.length; i++) {
    if (want[String(keys[i][0])]) hits.push(i + 2);
  }
  if (!hits.length) return [];

  // Matching rows are rarely neighbours, so read the runs rather than the span between the
  // first and the last.
  var out = [];
  rowRuns_(hits).forEach(function (run) {
    var block = sheet.getRange(run[0], 1, run[1] - run[0] + 1, headers.length).getValues();
    for (var b = 0; b < block.length; b++) {
      if (!want[String(block[b][col])]) continue;
      var obj = {};
      for (var h = 0; h < headers.length; h++) obj[headers[h]] = normalizeCell_(block[b][h]);
      obj._row = run[0] + b;
      out.push(obj);
    }
  });
  return out;
}

/**
 * The same read for several ids at once, keyed by id. A quotation is built a dozen lines at a
 * time, and doing it one line per call meant one scan of the id column per line.
 */
function findRowsByIds_(sheetName, idValues) {
  var out = {};
  findRowsByColumn_(sheetName, 'id', idValues).forEach(function (row) {
    var key = String(row.id);
    if (!out[key]) out[key] = row;
  });
  return out;
}

/**
 * Turns a sorted list of row numbers into the fewest ranges worth reading. Neighbours share a
 * read; rows a catalogue apart get their own, so a handful of scattered rows never drags in
 * everything between them. Past a point the read count costs more than the wasted cells, and
 * one span wins.
 */
var ROW_RUN_GAP_ = 8;
var ROW_RUN_MAX_ = 12;

function rowRuns_(rows) {
  if (!rows.length) return [];
  var runs = [];
  var from = rows[0], to = rows[0];
  for (var i = 1; i < rows.length; i++) {
    if (rows[i] - to <= ROW_RUN_GAP_) {
      to = rows[i];
    } else {
      runs.push([from, to]);
      from = to = rows[i];
    }
  }
  runs.push([from, to]);
  if (runs.length > ROW_RUN_MAX_) return [[rows[0], rows[rows.length - 1]]];
  return runs;
}

/** Appends several rows in one write, sharing one lock and one audit pass. */
function appendRows_(sheetName, objs, auditReason) {
  if (!objs || !objs.length) return 0;
  var lock = acquireLock_(LOCK_WAIT_ROW_MS, 'that save');
  try {
    var sheet = getSheet_(sheetName);
    var headers = getHeaders_(sheet, sheetName);
    var rows = objs.map(function (obj) {
      assertWritableFields_(sheetName, headers, obj);
      return headers.map(function (h) {
        return obj.hasOwnProperty(h) && obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
      });
    });
    var start = sheet.getLastRow() + 1;
    invalidateTable_(sheetName);
    sheet.getRange(start, 1, rows.length, headers.length).setValues(rows);
    objs.forEach(function (obj) {
      audit_('Create', sheetName, obj.id || '', '', '', '', auditReason);
    });
    return sheet.getLastRow();
  } finally {
    lock.releaseLock();
  }
}

/** Indian digit grouping: 13,16,600.00 rather than 1,316,600.00. Used by the printed
 * documents and by any message that quotes a figure back to somebody: 13,16,600.00 rather than 1,316,600.00. */
function inr_(n) {
  var v = Math.abs(Number(n) || 0).toFixed(2);
  var parts = v.split('.');
  var whole = parts[0];
  var last3 = whole.length > 3 ? whole.slice(-3) : whole;
  var rest = whole.length > 3 ? whole.slice(0, -3) : '';
  if (rest) last3 = ',' + last3;
  rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  // A non-breaking space: in a narrow column the symbol was wrapping onto the line above its
  // own number.
  return (Number(n) < 0 ? '-' : '') + '₹\u00A0' + rest + last3 + '.' + parts[1];
}

function generateId_(prefix) {
  return (prefix || '') + Utilities.getUuid().slice(0, 8);
}

/**
 * Writes one AuditLog row (FR-061). Deliberately never throws: an audit failure must not
 * roll back or block the business action it is recording. Writes straight to the sheet
 * rather than via appendRow_ so it cannot recurse.
 */
function audit_(action, tableName, recordId, fieldName, oldValue, newValue, reason) {
  try {
    // Not getSheet_, which throws when the tab is absent — an audit write must stay silent.
    // Registered all the same, so its header row is read once per request rather than once
    // per entry, and a save that writes four audit rows pays for one.
    var sheet = SHEET_CACHE_[AUDIT_TAB] ||
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AUDIT_TAB);
    if (!sheet) return;
    rememberSheet_(AUDIT_TAB, sheet);
    // Who acted comes from the session this request arrived with, not from Google — the app
    // runs as its owner now, so Google would name the owner on every entry.
    var email = (CURRENT_USER_ && CURRENT_USER_.email) || 'system';
    var headers = getHeaders_(sheet, AUDIT_TAB);
    var row = {
      id: generateId_('AUD-'),
      timestamp: Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd HH:mm:ss'),
      userEmail: email,
      action: action,
      tableName: tableName,
      recordId: recordId,
      fieldName: fieldName || '',
      oldValue: truncateForAudit_(oldValue),
      newValue: truncateForAudit_(newValue),
      reason: reason || ''
    };
    invalidateTable_(AUDIT_TAB);
    sheet.appendRow(headers.map(function (h) {
      return row.hasOwnProperty(h) && row[h] !== undefined && row[h] !== null ? row[h] : '';
    }));
  } catch (e) {
    Logger.log('Audit write failed: ' + e.message);
  }
}

/**
 * Writes several AuditLog rows in one go.
 *
 * A save that changes four fields records four entries, and appending them one at a time cost
 * four round trips for what is a single logical event. Same rows, same order, one write.
 * Silent on failure for the same reason audit_ is: the record must never block what it records.
 */
function auditMany_(entries) {
  if (!entries || !entries.length) return;
  if (entries.length === 1) {
    var e = entries[0];
    audit_(e.action, e.tableName, e.recordId, e.fieldName, e.oldValue, e.newValue, e.reason);
    return;
  }
  try {
    var sheet = SHEET_CACHE_[AUDIT_TAB] ||
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AUDIT_TAB);
    if (!sheet) return;
    rememberSheet_(AUDIT_TAB, sheet);
    var email = (CURRENT_USER_ && CURRENT_USER_.email) || 'system';
    var stamp = Utilities.formatDate(new Date(),
      Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd HH:mm:ss');
    var headers = getHeaders_(sheet, AUDIT_TAB);
    var rows = entries.map(function (entry) {
      var row = {
        id: generateId_('AUD-'), timestamp: stamp, userEmail: email,
        action: entry.action, tableName: entry.tableName, recordId: entry.recordId,
        fieldName: entry.fieldName || '',
        oldValue: truncateForAudit_(entry.oldValue), newValue: truncateForAudit_(entry.newValue),
        reason: entry.reason || ''
      };
      return headers.map(function (h) {
        return row.hasOwnProperty(h) && row[h] !== undefined && row[h] !== null ? row[h] : '';
      });
    });
    invalidateTable_(AUDIT_TAB);
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  } catch (err) {
    Logger.log('Audit batch write failed: ' + err.message);
  }
}

function truncateForAudit_(v) {
  var s = (v === undefined || v === null) ? '' : String(v);
  return s.length > 500 ? s.slice(0, 497) + '…' : s;
}

/** Removes the internal `_row` bookkeeping field before a row is sent to the client. */
function stripRow_(obj) {
  var copy = {};
  for (var k in obj) {
    if (k !== '_row') copy[k] = obj[k];
  }
  return copy;
}
