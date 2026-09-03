/**
 * Generic sheet-backed table access. Every tab in the bound Spreadsheet is treated as a
 * table whose first row is the header row. All read/write helpers key off those headers,
 * so a tab's columns are the single source of truth for its schema.
 */

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new Error('Sheet tab "' + name + '" was not found. Check the tab exists and is spelled exactly like this.');
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
function appendRow_(sheetName, obj) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet_(sheetName);
    var headers = getHeaders_(sheet);
    var row = headers.map(function (h) {
      return obj.hasOwnProperty(h) && obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
    });
    sheet.appendRow(row);
    return sheet.getLastRow();
  } finally {
    lock.releaseLock();
  }
}

/** Merges `patch` onto the row whose `idField` column equals `idValue`. Untouched columns keep their value. */
function updateRowById_(sheetName, idField, idValue, patch) {
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
        var updated = headers.map(function (h, idx) {
          return patch.hasOwnProperty(h) ? patch[h] : current[idx];
        });
        sheet.getRange(rowNum, 1, 1, headers.length).setValues([updated]);
        return true;
      }
    }
    throw new Error('Row with ' + idField + '=' + idValue + ' not found in ' + sheetName);
  } finally {
    lock.releaseLock();
  }
}

function deleteRowById_(sheetName, idField, idValue) {
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
        sheet.deleteRow(i + 2);
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

/** Removes the internal `_row` bookkeeping field before a row is sent to the client. */
function stripRow_(obj) {
  var copy = {};
  for (var k in obj) {
    if (k !== '_row') copy[k] = obj[k];
  }
  return copy;
}
