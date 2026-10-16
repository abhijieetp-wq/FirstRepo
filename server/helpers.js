/**
 * The four helpers from SheetService.gs that never touched a sheet.
 *
 * SheetService.gs is the one module that does not convert — db.js replaces it — and taking
 * the whole file would mean taking the spreadsheet with it. But four of its functions are
 * pure: they format a rupee amount, drop a key from an object, collapse a list of row numbers
 * into runs, turn a Date into yyyy-MM-dd. 61 call sites across the converted modules still
 * need them, and the portal fell over on the first one with "stripRow_ is not defined" the
 * moment it was run against Postgres for real.
 *
 * COPIED VERBATIM, and extracted by a script rather than retyped, because two versions of
 * inr_ that round differently is a quotation total that disagrees with itself depending on
 * which half of the system printed it. If one of these changes in SheetService.gs while both
 * are live during the cutover, the test below notices.
 *
 * Two of them — normalizeCell_ and rowRuns_ — are reachable only from the Pricing functions
 * that server/queries/pricing.js has already replaced, so nothing calls them any more. They
 * are here anyway: proving they are unreachable is a claim about the whole call graph, and
 * the cost of being wrong is a crash on a screen somebody is using.
 */
'use strict';

function normalizeCell_(v, Utilities, Session) {
  // Object.prototype.toString rather than `instanceof Date`. In the live portal the two agree
  // always, because the Dates come from the Sheets host in the same realm as the script. They
  // part company in the test harness, which runs this code in a `vm` and hands it Dates made
  // by Node: `instanceof` says no, and the cell comes back as
  // 'Thu Jan 15 2026 00:00:00 GMT+0000' instead of '2026-01-15'. No test seeded a Date, so
  // nothing was wrong — but the next one to do it would have been testing against behaviour
  // the portal does not have, and believed it. This costs nothing where it runs for real.
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd');
  }
  return v;
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

/** Removes the internal `_row` bookkeeping field before a row is sent to the client. */
function stripRow_(obj) {
  var copy = {};
  for (var k in obj) {
    if (k !== '_row') copy[k] = obj[k];
  }
  return copy;
}

module.exports = { normalizeCell_, inr_, rowRuns_, stripRow_ };
