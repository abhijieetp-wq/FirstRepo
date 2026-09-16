/**
 * Generic sheet-backed table access. Every tab in the bound Spreadsheet is treated as a
 * table whose first row is the header row. All read/write helpers key off those headers,
 * so a tab's columns are the single source of truth for its schema.
 */

function getSheet_(name) {
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
  return sheet;
}

function getHeaders_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h).trim();
  });
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
  var headers = getHeaders_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2 || headers.length === 0) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
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
    var headers = getHeaders_(sheet);
    assertWritableFields_(sheetName, headers, obj);
    var row = headers.map(function (h) {
      return obj.hasOwnProperty(h) && obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
    });
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
    var headers = getHeaders_(sheet);
    var idCol = headers.indexOf(idField);
    if (idCol === -1) throw new Error('Column "' + idField + '" not found in ' + sheetName);
    assertWritableFields_(sheetName, headers, patch);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('No rows in ' + sheetName + ' yet.');
    var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(idValue)) {
        var rowNum = i + 2;
        var current = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
        var changes = [];
        var updated = headers.map(function (h, idx) {
          if (!patch.hasOwnProperty(h)) return current[idx];
          if (String(patch[h]) !== String(current[idx])) {
            changes.push({ field: h, oldValue: current[idx], newValue: patch[h] });
          }
          return patch[h];
        });
        sheet.getRange(rowNum, 1, 1, headers.length).setValues([updated]);
        changes.forEach(function (c) {
          audit_('Update', sheetName, idValue, c.field, c.oldValue, c.newValue, auditReason);
        });
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
    var headers = getHeaders_(sheet);
    var idCol = headers.indexOf(idField);
    if (idCol === -1) throw new Error('Column "' + idField + '" not found in ' + sheetName);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('No rows in ' + sheetName + ' yet.');
    var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(idValue)) {
        var doomed = sheet.getRange(i + 2, 1, 1, headers.length).getValues()[0].join(' | ');
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
    var headers = getHeaders_(sheet);
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
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AUDIT_TAB);
    if (!sheet) return;
    var email = '';
    try { email = Session.getActiveUser().getEmail(); } catch (e) { email = 'unknown'; }
    var headers = getHeaders_(sheet);
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
    sheet.appendRow(headers.map(function (h) {
      return row.hasOwnProperty(h) && row[h] !== undefined && row[h] !== null ? row[h] : '';
    }));
  } catch (e) {
    Logger.log('Audit write failed: ' + e.message);
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
