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
function appendRow_(sheetName, obj, auditReason) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet_(sheetName);
    var headers = getHeaders_(sheet);
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
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
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
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
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
