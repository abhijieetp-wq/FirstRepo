/**
 * Getting PIE's live data out of the spreadsheet, in a form that can be proved complete.
 *
 * This runs once, for real, on the day of the cutover. There is no second attempt at a first
 * export: once the portal is pointed at Postgres, the sheet stops being written to, and
 * anything this missed is a quotation or an invoice that no longer exists. So the whole design
 * is arranged around being able to prove afterwards that nothing was lost — not around being
 * quick or clever.
 *
 * WHY IT RUNS HERE RATHER THAN FROM THE SERVER. Reading the sheet from Node would mean a
 * Google Cloud project, a service account, a key file and sharing the spreadsheet with it.
 * Every one of those is a step that can go wrong on the day, and the OAuth setup for this
 * project has already cost two sessions. Here the owner presses Run in the editor they already
 * have open, signed in as themselves, with the access they already have.
 *
 * WHAT IT WRITES. One JSON file per tab in a Drive folder, plus a manifest. One file per tab,
 * not one big one, for three reasons: a 27,000-row tab fits comfortably in memory on its own
 * and all 52 together may not; a run that dies halfway has written everything up to that point
 * rather than nothing; and Drive hands the whole folder over as a single zip when the person
 * downloads it, so it costs them nothing.
 *
 * WHAT MAKES IT CHECKABLE. Every row carries a digest, and every tab carries a digest over its
 * rows' digests. migration/import.js recomputes both from the file it received, with its own
 * implementation, and refuses to load anything that disagrees. Two implementations of the same
 * rule agreeing is real evidence that the file crossing from Drive to a laptop to a server
 * arrived as it left; one implementation checking itself is not evidence of anything.
 *
 * THE SHEET'S HEADERS ARE THE TRUTH, not Schema.gs's columns. The two can differ — that is
 * exactly why assertWritableFields_ exists — and a sheet that is behind the code, or ahead of
 * it, has to be reported rather than quietly reconciled. The manifest names every difference.
 *
 *   1. In the Apps Script editor, select exportForMigration and press Run.
 *   2. If it stops saying there is more to do, press Run again. It picks up where it left off.
 *   3. When it says the export is complete, open the folder link it prints and download it.
 */

var EXPORT_FOLDER_PROP_ = 'MIGRATION_EXPORT_FOLDER';
var EXPORT_DONE_PROP_ = 'MIGRATION_EXPORT_DONE';
var EXPORT_STARTED_PROP_ = 'MIGRATION_EXPORT_STARTED';

/**
 * How long to keep going before stopping to be run again.
 *
 * Apps Script kills an execution at six minutes with no warning and no way to catch it, so
 * stopping voluntarily at four and a half is what makes this resumable rather than a gamble.
 * A tab is never half-written: the check happens between tabs, and the biggest single tab
 * takes seconds.
 */
var EXPORT_BUDGET_MS_ = 270000;

/**
 * The canonical text of one row, which both sides have to agree on exactly.
 *
 * This string is what gets hashed, so the rule has to be written down precisely and
 * reimplemented in Node from the description rather than from the code:
 *
 *   - the row is its cells in the sheet's own column order, nothing added or removed
 *   - each cell becomes text: a Date becomes yyyy-MM-dd in the script's timezone, everything
 *     else becomes String(value), with null and undefined becoming the empty string
 *   - the cells are joined with \u001f, the unit separator, which no spreadsheet cell contains
 *
 * The separator matters. Joining with a comma would make ['a,b', 'c'] and ['a', 'b,c'] hash
 * identically, so two different rows would appear to be the same row and a verifier would
 * pass on data it had never compared.
 */
function exportCellText_(v) {
  if (v === null || v === undefined) return '';
  // Object.prototype.toString, not `instanceof Date`. `instanceof` compares against the
  // constructor of the realm the code is running in, and a Date made anywhere else fails it
  // while still being a Date in every way that matters. In the live portal that never bites,
  // because the Dates come from the Sheets host in the same realm as the script — which is
  // why normalizeCell_ gets away with `instanceof` and is left alone. Here it did bite: the
  // round-trip test handed this a Date from Node and got 'Thu Jan 15 2026 00:00:00 GMT+0000'
  // in the export file instead of '2026-01-15'. A date written that way is a date nothing
  // downstream can parse, in the one file there is no second chance at.
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd');
  }
  return String(v);
}

function exportRowText_(cells) {
  var out = [];
  for (var i = 0; i < cells.length; i++) out.push(exportCellText_(cells[i]));
  return out.join('\u001f');
}

/**
 * The digest of one row, in base64.
 *
 * Sha256.gs rather than Utilities.computeDigest, and for the reason that file was written: a
 * host call costs far more than the arithmetic, and 27,000 of them for the PriceList alone
 * would be minutes of pure overhead inside a six-minute limit. In V8 the same hashing is
 * milliseconds.
 */
function exportRowDigest_(cells) {
  return base64FromBytes_(sha256Bytes_(utf8Bytes_(exportRowText_(cells))));
}

/**
 * The digest of a whole tab: one hash over its rows' digests, in row order.
 *
 * Not a hash of the concatenated rows, which would mean building a ten-megabyte string for
 * the PriceList and hashing it in pure JavaScript. Hashing 27,000 digests of 44 characters
 * each is a megabyte, bounded and quick, and it still changes if any row changes, if two rows
 * swap places, or if a row goes missing.
 */
function exportTabDigest_(rowDigests) {
  return base64FromBytes_(sha256Bytes_(utf8Bytes_(rowDigests.join('\n'))));
}

/** The folder this export is going into, made once and remembered across runs. */
function exportFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(EXPORT_FOLDER_PROP_);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* deleted — make another */ }
  }
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC',
    'yyyy-MM-dd HH:mm:ss').replace(/[: ]/g, '-');
  var folder = DriveApp.createFolder('PIE ERP migration export ' + stamp);
  props.setProperty(EXPORT_FOLDER_PROP_, folder.getId());
  props.setProperty(EXPORT_STARTED_PROP_, new Date().toISOString());
  return folder;
}

/** Which tabs are already written, so a second run does not redo them. */
function exportDone_() {
  var raw = PropertiesService.getScriptProperties().getProperty(EXPORT_DONE_PROP_);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (err) { return {}; }
}

function noteExported_(tab, summary) {
  var done = exportDone_();
  done[tab] = summary;
  PropertiesService.getScriptProperties()
    .setProperty(EXPORT_DONE_PROP_, JSON.stringify(done));
}

/**
 * Reads one tab whole and writes it to the folder.
 *
 * Deliberately not readTable_. That one caches, counts telemetry, drops the `_row` it adds
 * and normalises through a path shared with the live portal — all reasonable for serving a
 * screen and all wrong for this. An export wants the cells as they are, read once, with
 * nothing in between that could be the thing that is broken.
 *
 * A blank row is skipped, which is the one piece of readTable_'s behaviour that IS copied,
 * because it has to be: the portal has never shown those rows, nothing references them, and
 * carrying them over would make every row count disagree with what PIE sees today.
 */
function exportTab_(tab, folder) {
  var sheet = getSheet_(tab);
  if (!sheet) {
    return { rows: 0, columns: [], digest: '', missing: true };
  }

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return { rows: 0, columns: [], digest: '', empty: true };

  var block = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = block[0].map(function (h) { return String(h).trim(); });

  var rows = [];
  var digests = [];
  var blankRows = 0;
  for (var r = 1; r < block.length; r++) {
    var cells = block[r];
    var blank = true;
    for (var c = 0; c < cells.length; c++) {
      if (cells[c] !== '' && cells[c] !== null) { blank = false; break; }
    }
    if (blank) { blankRows++; continue; }

    var text = [];
    for (var k = 0; k < cells.length; k++) text.push(exportCellText_(cells[k]));
    rows.push(text);
    digests.push(base64FromBytes_(sha256Bytes_(utf8Bytes_(text.join('\u001f')))));
  }

  var digest = exportTabDigest_(digests);
  var payload = {
    tab: tab,
    columns: headers,
    rowCount: rows.length,
    blankRowsSkipped: blankRows,
    sheetLastRow: lastRow,
    digest: digest,
    rowDigests: digests,
    rows: rows
  };

  // Replaced rather than added to, so re-running a tab after fixing something in it does not
  // leave two files and an ambiguous import.
  var name = tab + '.json';
  var existing = folder.getFilesByName(name);
  while (existing.hasNext()) existing.next().setTrashed(true);
  folder.createFile(Utilities.newBlob(JSON.stringify(payload), 'application/json', name));

  return { rows: rows.length, columns: headers, digest: digest, blankRowsSkipped: blankRows,
           sheetLastRow: lastRow };
}

/**
 * Did the spreadsheet change while we were reading it?
 *
 * THE EXPORT IS NOT ATOMIC ACROSS TABS, and it cannot be: there are 52 of them and Sheets
 * offers no way to read them all as of one moment. They are read in name order, which puts a
 * document's LINES before its HEADER — QuotationItems before Quotations, InvoiceItems before
 * Invoices, DispatchItems before Dispatches. So a quotation saved between those two reads
 * arrives in the export as a header with no lines, and a quotation deleted between them as
 * lines belonging to nothing. Both load without complaint and both are wrong.
 *
 * The only real answer is that nobody uses the portal while the export runs. This is the
 * tripwire that catches it when somebody does, instead of relying on everyone having
 * remembered.
 *
 * WHAT IT CATCHES AND WHAT IT DOES NOT, plainly, because a safeguard that is trusted further
 * than it reaches is worse than none. getLastRow moves when rows are added or removed, so a
 * saved quotation, a new order, a stock movement, an audit entry — anything that appends — is
 * caught. EDITING a row that already exists does not move it, so a price changed on an
 * existing quotation line during the export is not caught. Appending is what almost everything
 * in this portal does, the audit log included, so in practice any use of the portal at all
 * trips this. It is a tripwire, not a lock.
 */
function exportTabsThatMoved_(done) {
  var moved = [];
  var tabs = Object.keys(done);
  for (var i = 0; i < tabs.length; i++) {
    var tab = tabs[i];
    var before = done[tab].sheetLastRow;
    if (before === undefined || done[tab].missing) continue;
    var sheet = getSheet_(tab);
    if (!sheet) continue;
    var after = sheet.getLastRow();
    if (after !== before) {
      moved.push({ tab: tab, wasLastRow: before, nowLastRow: after, by: after - before });
    }
  }
  return moved;
}

/**
 * Exports every tab, stopping before Apps Script stops it. Run again to continue.
 *
 * @return a report, printed to the execution log, saying what was written and what is left.
 */
function exportForMigration() {
  var folder = exportFolder_();
  var done = exportDone_();
  var started = Date.now();

  var tabs = Object.keys(SCHEMA).sort();
  var wrote = [];
  var remaining = [];

  for (var i = 0; i < tabs.length; i++) {
    var tab = tabs[i];
    if (done.hasOwnProperty(tab)) continue;

    if (Date.now() - started > EXPORT_BUDGET_MS_) {
      remaining = tabs.slice(i).filter(function (t) { return !done.hasOwnProperty(t); });
      break;
    }

    var summary = exportTab_(tab, folder);
    noteExported_(tab, summary);
    done[tab] = summary;
    wrote.push(tab + ' (' + summary.rows + ')');
  }

  if (remaining.length) {
    var msg = 'Wrote ' + wrote.length + ' tab(s) this run: ' + wrote.join(', ') + '\n\n' +
      remaining.length + ' tab(s) still to go. Run exportForMigration() again — it carries ' +
      'on from here. Nothing is repeated and nothing is lost.';
    Logger.log(msg);
    return msg;
  }

  var moved = exportTabsThatMoved_(done);
  var manifest = exportManifest_(folder, done, moved);
  Logger.log(manifest.text);
  return manifest.text;
}

/**
 * The manifest: what was exported, how much of it, and everywhere the sheet and the schema
 * disagree.
 *
 * The disagreements are the point of writing this at all. A column the sheet has and
 * Schema.gs does not means data with nowhere to go — the import has to refuse rather than drop
 * it. A column the schema declares and the sheet lacks is the ordinary case of a sheet behind
 * the code and becomes blank, which is fine but should be said out loud. Either way nobody
 * should discover it by comparing row counts afterwards and wondering.
 */
function exportManifest_(folder, done, moved) {
  var tabs = Object.keys(done).sort();
  var total = 0;
  var entries = [];
  var notInSchema = [];
  var notInSheet = [];
  var missingTabs = [];

  for (var i = 0; i < tabs.length; i++) {
    var tab = tabs[i];
    var s = done[tab];
    total += Number(s.rows) || 0;

    if (s.missing) { missingTabs.push(tab); }

    var declared = (SCHEMA[tab] && SCHEMA[tab].columns) || [];
    var have = s.columns || [];
    for (var h = 0; h < have.length; h++) {
      if (have[h] && declared.indexOf(have[h]) === -1) notInSchema.push(tab + '.' + have[h]);
    }
    for (var d = 0; d < declared.length; d++) {
      if (have.indexOf(declared[d]) === -1) notInSheet.push(tab + '.' + declared[d]);
    }

    // rowCount, the same name the per-tab file uses. It was `rows` here and `rowCount` there,
    // so the importer's row-count check compared a number against undefined and reported every
    // one of the 52 tabs as disagreeing with itself. Two names for one thing across a file
    // boundary is how that happens.
    entries.push({
      tab: tab, rowCount: Number(s.rows) || 0, columns: have, digest: s.digest || '',
      blankRowsSkipped: Number(s.blankRowsSkipped) || 0
    });
  }

  var manifest = {
    build: typeof APP_BUILD === 'string' ? APP_BUILD : 'unknown',
    // Who ran it is deliberately NOT recorded here, and that is worth explaining because the
    // obvious one-liner for it is a trap. Session.getEffectiveUser().getEmail() would be the
    // first call to that service anywhere in this project, and Apps Script works out a
    // deployment's OAuth scopes by scanning the source — so adding it would add
    // userinfo.email to the set. A deployed web app running as USER_DEPLOYING stops serving
    // when its scope set grows until the owner opens the editor and authorises again, which
    // for PIE would be an authorisation error on every screen until somebody noticed. Not
    // worth one field in a file. Apps Script's own execution log records who pressed Run.
    exportedAt: new Date().toISOString(),
    startedAt: PropertiesService.getScriptProperties().getProperty(EXPORT_STARTED_PROP_) || '',
    timezone: Session.getScriptTimeZone() || 'Etc/UTC',
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    tabCount: entries.length,
    totalRows: total,
    tabs: entries,
    columnsNotInSchema: notInSchema,
    columnsNotInSheet: notInSheet,
    tabsMissingFromSheet: missingTabs,
    // Empty means nothing was added to or removed from any tab between its read and the end
    // of the run. The import refuses an export where this is not empty, because the pieces of
    // one document may have landed either side of the change.
    tabsThatMovedDuringExport: moved || []
  };

  var name = '_manifest.json';
  var old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);
  folder.createFile(Utilities.newBlob(JSON.stringify(manifest, null, 2),
    'application/json', name));

  var movedText = '';
  if (moved && moved.length) {
    movedText = 'THE SPREADSHEET CHANGED WHILE THIS WAS READING IT.\n\n' +
      moved.map(function (m) {
        return '  ' + m.tab + ': ' + (m.by > 0 ? m.by + ' row(s) added' : (-m.by) +
          ' row(s) removed') + ' after it had been read';
      }).join('\n') + '\n\n' +
      'The tabs are read one after another, in name order, and that puts a document\u2019s ' +
      'lines before its header \u2014 QuotationItems before Quotations. So something saved ' +
      'part-way through can land in the export as a header with no lines, which loads ' +
      'without complaint and is wrong.\n\n' +
      'The import will refuse this export. Ask everyone to stay out of the portal, then run ' +
      'resetMigrationExport() and exportForMigration() again.\n\n';
  }

  var text = (movedText ? movedText : 'Export complete.\n\n') +
    entries.length + ' tabs, ' + total + ' rows.\n' +
    'Folder: ' + folder.getUrl() + '\n\n' +
    (notInSchema.length
      ? 'THE SHEET HAS ' + notInSchema.length + ' COLUMN(S) THE SCHEMA DOES NOT DECLARE:\n  ' +
        notInSchema.join('\n  ') + '\nThe import will refuse these rather than drop them. ' +
        'Either add them to Schema.gs or decide the data is not wanted.\n\n'
      : '') +
    (notInSheet.length
      ? notInSheet.length + ' declared column(s) the sheet has not got (these import as ' +
        'blank, which is normal for a sheet behind the code):\n  ' +
        notInSheet.slice(0, 20).join('\n  ') +
        (notInSheet.length > 20 ? '\n  ... and ' + (notInSheet.length - 20) + ' more' : '') +
        '\n\n'
      : '') +
    (missingTabs.length
      ? missingTabs.length + ' declared tab(s) not in the spreadsheet at all: ' +
        missingTabs.join(', ') + '\n\n'
      : '') +
    'Next: download the folder, then\n' +
    '  node migration/import.js <the folder> --verify\n' +
    'which checks every digest and every field before it writes anything.';

  return { manifest: manifest, text: text };
}

/**
 * Forgets the progress so the next run starts over in a new folder.
 *
 * Needed for a second export — the real one after a rehearsal — and for the case where
 * something in the sheet was corrected and everything has to be read again. The old folder is
 * left alone rather than deleted: it is evidence of what the sheet held at that moment, and
 * deciding to throw that away is not this function's business.
 */
function resetMigrationExport() {
  var props = PropertiesService.getScriptProperties();
  var old = props.getProperty(EXPORT_FOLDER_PROP_);
  props.deleteProperty(EXPORT_DONE_PROP_);
  props.deleteProperty(EXPORT_FOLDER_PROP_);
  props.deleteProperty(EXPORT_STARTED_PROP_);
  return 'Progress cleared. The next exportForMigration() starts a new folder.' +
    (old ? ' The previous one is left in Drive, untouched.' : '');
}
