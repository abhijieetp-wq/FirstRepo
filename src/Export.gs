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
 * Rows per file. Tabs bigger than this are written in several.
 *
 * The first two real runs against PIE's sheet both died on the Drive write with "Service
 * error: Drive", and the two candidates were a file too big for Drive to take in one go and a
 * Drive fault that was simply passing. This removes the first candidate: nothing now goes to
 * Drive bigger than a few megabytes however large the tab, and the retry handles the second.
 *
 * It also bounds memory, which matters more than the file size. Reading 200,000 audit rows,
 * building a text for each, hashing each, and then JSON.stringify-ing the lot means several
 * copies of the whole tab alive at once inside a runtime with a fixed and undocumented
 * ceiling. A block at a time keeps one block alive, whatever the tab.
 *
 * 5,000 is chosen to be comfortably small rather than optimal: 5,000 rows of the widest tab
 * here is well under a megabyte, and at PIE's volumes the most any tab needs is six files.
 */
var EXPORT_ROWS_PER_FILE_ = 5000;

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

var EXPORT_BUILD_PROP_ = 'MIGRATION_EXPORT_BUILD';

/** Which tabs are already written, so a second run does not redo them. */
function exportDone_() {
  var raw = PropertiesService.getScriptProperties().getProperty(EXPORT_DONE_PROP_);
  if (!raw) return {};
  var stored;
  try { stored = JSON.parse(raw); } catch (err) { return {}; }
  var out = {};
  Object.keys(stored).forEach(function (tab) {
    var s = stored[tab] || {};
    var full = {};
    Object.keys(EXPORT_DONE_KEYS_).forEach(function (k) {
      if (s[EXPORT_DONE_KEYS_[k]] !== undefined) full[k] = s[EXPORT_DONE_KEYS_[k]];
      else if (s[k] !== undefined) full[k] = s[k];  // a record written before the keys were shortened
    });
    out[tab] = full;
  });
  return out;
}

/**
 * The progress record's keys, one letter each in the property and the full names everywhere
 * else (exportDone_ turns them back). Spelled out, the names alone were about 60 bytes a tab,
 * and at 58 tabs the record reached the 9,000 bytes noteExported_ allows.
 */
var EXPORT_DONE_KEYS_ = { rows: 'r', parts: 'p', digest: 'd', blankRowsSkipped: 'b', sheetLastRow: 'l', bytes: 'y',
  columnCount: 'c', missing: 'm', empty: 'e' };

/**
 * Refuses to continue an export that a different build started.
 *
 * This is the one that actually bit. The first attempts, under a build that wrote one file
 * per tab, got through 27 tabs before Drive refused the 19 MB PriceList. The next build wrote
 * 5,000 rows per file — but the progress record still said those 27 were done, so the run
 * carried on from the 28th and the folder ended up holding two formats: Activities.json from
 * the old one beside PriceList.01.json from the new. The manifest described it with the old
 * build's fields, the importer looked for Activities.01.json, and the whole export had to be
 * thrown away.
 *
 * The instruction to run resetMigrationExport() between builds existed and was reasonable and
 * was not followed, which is the ordinary fate of a step a person has to remember in the
 * middle of something else. So the export remembers instead: the build is stored with the
 * progress, and a run under a different one clears the progress and starts a new folder,
 * saying so. The old folder is left in Drive — deciding to throw away evidence of what the
 * sheet held is not this function's business.
 */
function exportBuildChanged_() {
  var props = PropertiesService.getScriptProperties();
  var now = typeof APP_BUILD === 'string' ? APP_BUILD : 'unknown';
  var was = props.getProperty(EXPORT_BUILD_PROP_);

  if (!was) { props.setProperty(EXPORT_BUILD_PROP_, now); return null; }
  if (was === now) return null;

  var done = exportDone_();
  var hadTabs = Object.keys(done).length;
  props.deleteProperty(EXPORT_DONE_PROP_);
  props.deleteProperty(EXPORT_FOLDER_PROP_);
  props.deleteProperty(EXPORT_STARTED_PROP_);
  props.setProperty(EXPORT_BUILD_PROP_, now);

  return 'Starting again in a new folder.\n\n' + hadTabs + ' tab(s) were exported by build ' +
    was + ' and this is build ' + now + '. Carrying on would leave one folder holding files ' +
    'written two different ways, which is an export nobody can check — so it starts over ' +
    'rather than continuing. The old folder is left in Drive, untouched.\n\n' +
    'Nothing is lost and nothing needs doing: the run below is the whole export.\n';
}

/**
 * Records one finished tab, in a form that fits.
 *
 * A Script Property value may be 9 KB and no more, and the first version of this stored the
 * full column list for every tab — 9,478 bytes of column names on their own. The property
 * crossed the limit at around the 28th of the 52 tabs, at which point setProperty throws and
 * the export can never finish however well Drive behaves. Found by measuring it rather than
 * by reaching tab 28.
 *
 * So what is kept here is only what a resumed run and the manifest need as NUMBERS. The
 * column names live in the part files, where they are needed anyway, and the manifest reads
 * the header row again at the end — 52 one-row reads, which costs nothing and has the side
 * benefit of noticing a header that changed during the run.
 */
function noteExported_(tab, summary) {
  var done = exportDone_();
  done[tab] = {
    rows: summary.rows, parts: summary.parts, digest: summary.digest,
    blankRowsSkipped: summary.blankRowsSkipped, sheetLastRow: summary.sheetLastRow,
    bytes: summary.bytes, columnCount: summary.columnCount,
    missing: summary.missing || undefined, empty: summary.empty || undefined
  };
  var stored = {};
  Object.keys(done).forEach(function (t) {
    var short = {};
    Object.keys(EXPORT_DONE_KEYS_).forEach(function (k) {
      if (done[t][k] !== undefined) short[EXPORT_DONE_KEYS_[k]] = done[t][k];
    });
    stored[t] = short;
  });
  var text = JSON.stringify(stored);
  if (text.length > 9000) {
    throw new Error('The export progress record has reached ' + text.length + ' bytes and ' +
      'Apps Script allows 9,216 per property. This should not happen \u2014 it holds only ' +
      'numbers now. Something is storing more than it should in noteExported_.');
  }
  PropertiesService.getScriptProperties().setProperty(EXPORT_DONE_PROP_, text);
}

/**
 * Writes one file to Drive, retrying the failures that are worth retrying.
 *
 * "Exception: Service error: Drive" is Google's generic "something went wrong at our end", and
 * it is overwhelmingly transient — the documented response is to wait and try again. Without
 * that, one hiccup two minutes into a fifty-two tab run ends the whole run, which is what
 * happened on the first real attempt.
 *
 * The write is safe to repeat: any earlier file of this name is trashed first, so a retry
 * after a failure that actually succeeded at Drive's end leaves one file, not two.
 *
 * Three attempts, backing off 2s, 4s, 8s. If all three fail the error names the tab, its size
 * and how many attempts were made, because "Service error: Drive" on its own tells whoever is
 * standing in front of it nothing at all — not which of the 52 tabs, not whether it is the
 * big one, not whether running it again is worth doing.
 */
function exportWriteFile_(folder, name, text, tab, rowCount) {
  var attempts = 3;
  var waitMs = 2000;
  var last = null;

  for (var i = 1; i <= attempts; i++) {
    try {
      var existing = folder.getFilesByName(name);
      while (existing.hasNext()) existing.next().setTrashed(true);
      folder.createFile(Utilities.newBlob(text, 'application/json', name));
      return i;
    } catch (err) {
      last = err;
      if (i < attempts) {
        Utilities.sleep(waitMs);
        waitMs = waitMs * 2;
      }
    }
  }

  throw new Error('Could not write ' + name + ' to Drive after ' + attempts + ' attempts. ' +
    'The tab was read fine — ' + rowCount + ' row(s), ' +
    Math.round(text.length / 1024) + ' KB — and Drive would not take the file. ' +
    'Google\u2019s message was: ' + (last && last.message ? last.message : String(last)) +
    '\n\nEverything exported before ' + tab + ' is written and recorded. Run ' +
    'exportForMigration() again and it starts at this tab. If it fails here every time, the ' +
    'problem is this tab rather than a passing Drive fault.');
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
    return { rows: 0, parts: 0, digest: '', missing: true };
  }

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return { rows: 0, parts: 0, digest: '', empty: true };

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });

  // Any file of this tab's from an earlier attempt goes first. A run that failed part-way
  // through a big tab leaves some of its parts behind, and parts from two attempts in one
  // folder is an import that silently reads a mixture.
  exportTrashParts_(folder, tab);

  var partDigests = [];
  var totalRows = 0;
  var blankRows = 0;
  var bytes = 0;
  var part = 0;

  // One block of rows at a time, read to written, so only one block is ever in memory.
  for (var start = 2; start <= lastRow; start += EXPORT_ROWS_PER_FILE_) {
    var height = Math.min(EXPORT_ROWS_PER_FILE_, lastRow - start + 1);
    if (height <= 0) break;
    var block = sheet.getRange(start, 1, height, lastCol).getValues();

    var rows = [];
    var digests = [];
    for (var r = 0; r < block.length; r++) {
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
    if (!rows.length) continue;        // a block of nothing but blank rows

    part++;
    var partDigest = exportTabDigest_(digests);
    partDigests.push(partDigest);
    totalRows += rows.length;

    var payload = {
      tab: tab,
      part: part,
      columns: headers,
      rowCount: rows.length,
      digest: partDigest,
      rowDigests: digests,
      rows: rows
    };
    var text2 = JSON.stringify(payload);
    bytes += text2.length;
    exportWriteFile_(folder, exportPartName_(tab, part), text2, tab, rows.length);
  }

  // The tab's digest is over its parts' digests, in order. It still changes if any row
  // changes, if two rows swap places, or if a whole part goes missing — and it never needs
  // every row's digest alive at once, which is the point.
  return {
    rows: totalRows, parts: part, digest: exportTabDigest_(partDigests),
    partDigests: partDigests, blankRowsSkipped: blankRows, sheetLastRow: lastRow,
    bytes: bytes, columnCount: headers.length
  };
}

/** Tab.1.json, Tab.2.json. Padded so a folder listing sorts the way the parts run. */
function exportPartName_(tab, part) {
  return tab + '.' + (part < 10 ? '0' + part : String(part)) + '.json';
}

/**
 * Removes every part file for one tab, from whatever attempt wrote them.
 *
 * Stops at the first one that is not there. Parts are written in order and a failed write
 * ends the run, so there is never a gap — part 1 missing means none of them exist. The
 * earlier version looked one past the gap "just in case", which cost two Drive lookups for
 * every one of the 52 tabs on every run whether or not anything was there. Drive chatter is
 * the leading suspect for the service errors that stopped the first two attempts, so a
 * hundred pointless calls is not a cost worth paying for a case that cannot arise.
 */
function exportTrashParts_(folder, tab) {
  for (var part = 1; part <= 500; part++) {
    var hits = folder.getFilesByName(exportPartName_(tab, part));
    if (!hits.hasNext()) return;
    while (hits.hasNext()) hits.next().setTrashed(true);
  }
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
  var restarted = exportBuildChanged_();
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

    var summary;
    try {
      summary = exportTab_(tab, folder);
    } catch (err) {
      // Whatever went wrong, say which tab it was and what had already been done. The first
      // real run failed with nothing but "Service error: Drive" and two line numbers, which
      // left no way to tell whether it had got as far as the big tabs or fallen over on the
      // second one.
      throw new Error('Stopped on the ' + tab + ' tab, after writing ' + wrote.length +
        ' tab(s) this run.\n\n' + (err && err.message ? err.message : String(err)) +
        '\n\nNothing already written is lost. Run exportForMigration() again to carry on ' +
        'from ' + tab + '.');
    }
    noteExported_(tab, summary);
    done[tab] = summary;
    wrote.push(tab + ' (' + summary.rows + ')');
  }

  if (remaining.length) {
    var msg = (restarted ? restarted + '\n' : '') +
      'Wrote ' + wrote.length + ' tab(s) this run: ' + wrote.join(', ') + '\n\n' +
      remaining.length + ' tab(s) still to go. Run exportForMigration() again — it carries ' +
      'on from here. Nothing is repeated and nothing is lost.';
    Logger.log(msg);
    return msg;
  }

  var moved = exportTabsThatMoved_(done);
  var manifest = exportManifest_(folder, done, moved);
  var text = (restarted ? restarted + '\n' : '') + manifest.text;
  Logger.log(text);
  return text;
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
    // Read again rather than carried in the progress record, which has only 9 KB to live in.
    // One row per tab, and it also catches a header renamed while the export was running.
    var have = [];
    var sheet = getSheet_(tab);
    if (sheet && sheet.getLastColumn()) {
      have = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
        .map(function (h) { return String(h).trim(); })
        .filter(function (h) { return h !== ''; });
    }
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
      tab: tab, rowCount: Number(s.rows) || 0, parts: Number(s.parts) || 0, columns: have,
      digest: s.digest || '', blankRowsSkipped: Number(s.blankRowsSkipped) || 0
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

  var parts = 0;
  for (var e = 0; e < entries.length; e++) parts += entries[e].parts;

  var text = (movedText ? movedText : 'Export complete.\n\n') +
    entries.length + ' tabs, ' + total + ' rows, ' + parts + ' file(s).\n' +
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
    'Next: download THIS folder — it is a new one, and any earlier export is still in Drive\n' +
    'under its own name. Then, in the repo:\n' +
    '  node migration/import.js "<the folder>"\n' +
    'which checks every digest, every column and every timestamp and writes nothing. Add\n' +
    '--write once it says the checks passed.';

  return { manifest: manifest, text: text };
}

/**
 * What the export has done so far, and what is left. Run it any time; it changes nothing.
 *
 * Needed because a run that stops part-way leaves the answer in two places nobody wants to
 * dig through: a Script Property holding JSON and a Drive folder holding files. The first
 * real attempt stopped on a Drive fault two minutes in, and there was no way to ask how far
 * it had got short of counting files in Drive and comparing them to Schema.gs by eye.
 */
function migrationExportStatus() {
  var done = exportDone_();
  var tabs = Object.keys(SCHEMA).sort();
  var finished = [];
  var left = [];
  var rows = 0;
  var bytes = 0;

  for (var i = 0; i < tabs.length; i++) {
    if (done.hasOwnProperty(tabs[i])) {
      var d = done[tabs[i]];
      rows += Number(d.rows) || 0;
      bytes += Number(d.bytes) || 0;
      finished.push(tabs[i] + ' (' + (Number(d.rows) || 0) + ')');
    } else {
      left.push(tabs[i]);
    }
  }

  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty(EXPORT_FOLDER_PROP_);
  var where = '';
  if (folderId) {
    try { where = DriveApp.getFolderById(folderId).getUrl(); } catch (err) { where = '(gone)'; }
  }

  if (!finished.length) {
    return editorSays_('Nothing exported yet. Run exportForMigration() to start.');
  }

  return editorSays_(finished.length + ' of ' + tabs.length + ' tabs done, ' + rows + ' rows, ' +
    Math.round(bytes / 1024) + ' KB written.\n' +
    (where ? 'Folder: ' + where + '\n' : '') +
    (left.length
      ? '\n' + left.length + ' still to go, starting with ' + left[0] + ':\n  ' +
        left.join(', ') + '\n\nRun exportForMigration() to carry on.'
      : '\nAll tabs are done. Run exportForMigration() once more to write the manifest.'));
}

/**
 * The columns the sheet has and Schema.gs does not, with how much is actually in them.
 *
 * The export found 21 of these and refuses to guess what they are, which is right — a column
 * somebody added by hand holds data they entered and expect to find, and dropping it quietly
 * is the easiest way for this migration to lose something nobody notices for a year.
 *
 * But a NAME is not enough to decide on. Every one of the 21 has a declared column that looks
 * like its successor — Quotations.customer beside customerId, QuotationItems.rate beside
 * unitPrice, Customers.phone beside the CustomerContacts tab — which fits them being fossils
 * from before the schema settled: Setup.gs's appendMissingColumns_ adds columns the schema
 * declares and never removes ones it does not, so an old name survives every upgrade.
 *
 * Fits is not is. What settles it is whether they hold anything, and there are exactly three
 * answers:
 *
 *   empty                      ignore it, and nothing is lost
 *   full, and its successor is full too    a stale duplicate; ignore it
 *   full, and its successor is EMPTY       the data lives ONLY here, and dropping the
 *                                          column drops the data
 *
 * The third is the one that matters and the only one worth anybody's attention. So this
 * reports, per tab, how full each undeclared column is — and which declared columns are
 * completely empty, because those are the ones an undeclared column might be the only source
 * for. Pairing them is a judgement, and it belongs to somebody who knows what PIE typed into
 * which box, not to this function.
 *
 * Samples are cut to 24 characters: enough to recognise what kind of thing it is, not a dump
 * of customer details into an execution log.
 */
function undeclaredColumnReport() {
  var out = [];
  var tabs = Object.keys(SCHEMA).sort();
  var totalUndeclared = 0;
  var totalWithData = 0;

  for (var t = 0; t < tabs.length; t++) {
    var tab = tabs[t];
    var sheet = getSheet_(tab);
    if (!sheet) continue;
    var lastCol = sheet.getLastColumn();
    var lastRow = sheet.getLastRow();
    if (!lastCol || lastRow < 2) continue;

    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(function (h) { return String(h).trim(); });
    var declared = SCHEMA[tab].columns;

    var undeclared = [];
    for (var h = 0; h < headers.length; h++) {
      if (headers[h] && declared.indexOf(headers[h]) === -1) {
        undeclared.push({ name: headers[h], at: h });
      }
    }
    if (!undeclared.length) continue;

    // One read of the tab, however many columns are in question.
    var block = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

    // How full every column is, declared or not — the empty declared ones are half the
    // answer and cost nothing to count while the block is here.
    var filled = {};
    var samples = {};
    for (var r = 0; r < block.length; r++) {
      for (var c = 0; c < headers.length; c++) {
        var name = headers[c];
        if (!name) continue;
        var v = block[r][c];
        if (v === '' || v === null || v === undefined) continue;
        filled[name] = (filled[name] || 0) + 1;
        if (!samples[name]) samples[name] = [];
        if (samples[name].length < 3) {
          var text = String(v);
          samples[name].push(text.length > 24 ? text.slice(0, 24) + '\u2026' : text);
        }
      }
    }

    var lines = [tab + '  (' + block.length + ' rows)'];
    for (var u = 0; u < undeclared.length; u++) {
      var n = undeclared[u].name;
      var count = filled[n] || 0;
      totalUndeclared++;
      if (count) totalWithData++;
      lines.push('    ' + n + ': ' + (count
        ? count + ' row(s) have a value \u2014 e.g. ' + samples[n].join(' | ')
        : 'EMPTY \u2014 nothing to lose'));
    }

    var emptyDeclared = declared.filter(function (d) {
      return headers.indexOf(d) !== -1 && !filled[d];
    });
    if (emptyDeclared.length) {
      lines.push('    declared columns with nothing in them, for comparison:');
      lines.push('      ' + emptyDeclared.join(', '));
    }
    out.push(lines.join('\n'));
  }

  if (!out.length) return editorSays_('Every column in the sheet is declared in Schema.gs.');

  return editorSays_(totalUndeclared + ' undeclared column(s), ' + totalWithData +
    ' of them holding ' +
    'data.\n\n' + out.join('\n\n') +
    '\n\nFor each one that holds data, the question is whether the declared column that ' +
    'replaced it holds the same thing. Where it does, the old column is a stale copy and can ' +
    'be ignored. Where the declared one is empty, the data lives only in the old column and ' +
    'dropping it would lose it.');
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
  props.deleteProperty(EXPORT_BUILD_PROP_);
  return editorSays_('Progress cleared. The next exportForMigration() starts a new ' +
    'folder.' + (old ? ' The previous one is left in Drive, untouched.' : ''));
}
