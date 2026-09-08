/**
 * One-click Sheet setup and upgrade.
 *
 * Run `setupSheet()` from the Apps Script editor (Run menu) after any schema change. It is
 * idempotent and non-destructive:
 *   - creates any tab declared in SCHEMA that doesn't exist
 *   - appends any missing column to an existing tab (never reorders, renames or deletes)
 *   - inserts any seed row whose id is not already present (so values added to SCHEMA
 *     later reach sheets that already exist)
 *   - migrates legacy role names and the legacy department column on Users
 *   - copies the old Parts/Units catalogs into the new Spares/Products tabs (old tabs are
 *     left untouched as a backup; nothing is deleted)
 *
 * It never removes a column or a row, so running it twice is safe and running it on a live
 * sheet cannot lose data.
 */

/** Old role name → new role name (D4). */
var LEGACY_ROLE_MAP = {
  'Coordinator': 'Sales Coordinator',
  'Warehouse': 'Sales Coordinator',
  'Manager': 'Management',
  'Admin': 'ERP Admin'
};

function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var report = { created: [], columnsAdded: [], seeded: [], migrated: [], skipped: [] };

  Object.keys(SCHEMA).forEach(function (tabName) {
    var def = SCHEMA[tabName];
    var sheet = ss.getSheetByName(tabName);

    if (!sheet) {
      sheet = ss.insertSheet(tabName);
      sheet.getRange(1, 1, 1, def.columns.length).setValues([def.columns]);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, def.columns.length).setFontWeight('bold');
      report.created.push(tabName + ' (' + def.columns.length + ' columns)');
    } else {
      var existing = getHeaders_(sheet);
      var missing = def.columns.filter(function (c) { return existing.indexOf(c) === -1; });
      if (missing.length) {
        sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
        sheet.getRange(1, 1, 1, existing.length + missing.length).setFontWeight('bold');
        report.columnsAdded.push(tabName + ': ' + missing.join(', '));
      }
    }

    // Seed rows are added by id, not only into an empty tab. Seeding only when the tab was
    // empty meant a value added to SCHEMA later — a new compressor type, a new payment term —
    // silently never appeared on any sheet that already existed, which is a bug that looks
    // like an empty dropdown and gives no clue why.
    if (def.seed && def.seed.length) {
      var headers = getHeaders_(sheet);
      var idCol = headers.indexOf('id');
      var present = {};
      if (idCol !== -1 && sheet.getLastRow() > 1) {
        sheet.getRange(2, idCol + 1, sheet.getLastRow() - 1, 1).getValues()
          .forEach(function (r) { present[String(r[0]).trim()] = true; });
      }

      var missingSeeds = def.seed.filter(function (obj) {
        return idCol === -1 ? false : !present[String(obj.id).trim()];
      });

      if (missingSeeds.length) {
        var rows = missingSeeds.map(function (obj) {
          return headers.map(function (h) {
            return obj.hasOwnProperty(h) && obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
          });
        });
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
        report.seeded.push(tabName + ' (' + rows.length + ' row' +
          (rows.length === 1 ? '' : 's') + ')');
      }
    }
  });

  migrateUsers_(ss, report);
  migrateLegacyCatalog_(ss, 'Parts', 'Spares', report);
  migrateLegacyCatalog_(ss, 'Units', 'Products', report);
  backfillIds_(ss, report);
  migratePriceLevels_(ss, report);

  var summary = formatSetupReport_(report);
  Logger.log(summary);
  try {
    SpreadsheetApp.getUi().alert('ERP Sheet Setup', summary, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    // No UI context (e.g. run from the editor without the sheet open) — the log is enough.
  }
  return summary;
}

/**
 * Moves PriceList rows off the retired List/Standard/Key Account/Special levels onto the
 * PIE (cost) / ELGI (selling) pair.
 *
 * The old "List" price was the selling price, so it becomes ELGI. "Special" was a second
 * selling price and has no home in the new two-level model — leaving it would produce two
 * competing ELGI prices, so those rows are deactivated rather than converted, and the audit
 * trail records why. Nothing is deleted; the rows stay readable in the sheet.
 */
function migratePriceLevels_(ss, report) {
  var sheet = ss.getSheetByName('PriceList');
  if (!sheet || sheet.getLastRow() < 2) return;

  var converted = 0;
  var retired = 0;
  readTable_('PriceList').forEach(function (row) {
    var level = String(row.priceLevel || '').trim();
    if (level === 'List') {
      updateRowById_('PriceList', 'id', row.id, { priceLevel: SELLING_PRICE_LEVEL },
        'Price level List renamed to ELGI (selling price)');
      converted++;
    } else if (level === 'Standard' || level === 'Key Account' || level === 'Special') {
      updateRowById_('PriceList', 'id', row.id, { active: 'FALSE' },
        'Price level "' + level + '" retired — the model is now PIE (cost) and ELGI (selling)');
      retired++;
    }
  });

  if (converted) report.migrated.push('PriceList: ' + converted + ' List price(s) became ELGI');
  if (retired) report.migrated.push('PriceList: ' + retired + ' row(s) on retired levels deactivated');
}

/**
 * Fills in a generated id for any row that has none.
 *
 * Rows typed directly into the Sheet usually leave `id` blank, and everything downstream
 * (editing, pricing, stock, foreign keys) is keyed on it — so a blank id makes a row look
 * fine but behave badly. This gives every such row a real id.
 */
function backfillIds_(ss, report) {
  var prefixes = { Spares: 'SP-', Products: 'PR-', Customers: 'CUS-', Users: 'USR-' };
  var filled = [];

  Object.keys(SCHEMA).forEach(function (tabName) {
    if (SCHEMA[tabName].columns.indexOf('id') !== 0) return;
    var sheet = ss.getSheetByName(tabName);
    if (!sheet || sheet.getLastRow() < 2) return;

    var headers = getHeaders_(sheet);
    var lastRow = sheet.getLastRow();
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    var count = 0;

    for (var i = 0; i < ids.length; i++) {
      var rowIsBlank = rows[i].every(function (c) { return c === '' || c === null; });
      if (rowIsBlank) continue;
      if (String(ids[i][0]).trim() === '') {
        ids[i][0] = generateId_(prefixes[tabName] || (tabName.slice(0, 3).toUpperCase() + '-'));
        count++;
      }
    }
    if (count) {
      sheet.getRange(2, 1, ids.length, 1).setValues(ids);
      filled.push(tabName + ': ' + count + ' row(s)');
    }
  });

  if (filled.length) report.migrated.push('Generated missing ids — ' + filled.join('; '));
}

/** Rewrites legacy role values and fills in businessStream/id so nobody is locked out. */
function migrateUsers_(ss, report) {
  var sheet = ss.getSheetByName('Users');
  if (!sheet || sheet.getLastRow() < 2) return;

  var headers = getHeaders_(sheet);
  var roleCol = headers.indexOf('role');
  var streamCol = headers.indexOf('businessStream');
  var idCol = headers.indexOf('id');
  var deptCol = headers.indexOf('department');
  if (roleCol === -1) return;

  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var changed = 0;

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!row[headers.indexOf('email')]) continue;

    var role = String(row[roleCol]).trim();
    if (LEGACY_ROLE_MAP[role]) {
      row[roleCol] = LEGACY_ROLE_MAP[role];
      changed++;
    }
    if (idCol !== -1 && !row[idCol]) row[idCol] = generateId_('USR-');
    if (streamCol !== -1 && !row[streamCol]) {
      // Legacy department carried the stream idea; admins/management span all streams.
      var legacyDept = deptCol !== -1 ? String(row[deptCol]).trim() : '';
      var newRole = String(row[roleCol]).trim();
      row[streamCol] = (newRole === 'ERP Admin' || newRole === 'Management')
        ? 'All'
        : (legacyDept && legacyDept.toLowerCase().indexOf('compressor') !== -1 ? 'Compressor Sales' : 'Spare Sales');
    }
  }

  sheet.getRange(2, 1, values.length, headers.length).setValues(values);
  if (changed) report.migrated.push('Users: remapped ' + changed + ' legacy role value(s)');
}

/** Copies rows from a legacy catalog tab into its replacement, matching on column names. */
function migrateLegacyCatalog_(ss, fromTab, toTab, report) {
  var src = ss.getSheetByName(fromTab);
  var dest = ss.getSheetByName(toTab);
  if (!src || !dest) return;
  if (src.getLastRow() < 2) return;
  if (dest.getLastRow() >= 2) {
    report.skipped.push(toTab + ' already has data — legacy ' + fromTab + ' rows not copied again');
    return;
  }

  var srcHeaders = getHeaders_(src);
  var destHeaders = getHeaders_(dest);
  var srcRows = src.getRange(2, 1, src.getLastRow() - 1, srcHeaders.length).getValues();

  // Legacy column name → new column name, where they differ.
  var RENAMES = { modelCode: 'productCode', modelName: 'model', unit: 'uom', systemStock: null,
    listRate: null, specialRate: null, altPartNo: null, altDescription: null, altRate: null,
    warrantyPeriod: 'warrantyMonths' };

  var out = [];
  srcRows.forEach(function (row) {
    var blank = row.every(function (c) { return c === '' || c === null; });
    if (blank) return;
    var obj = {};
    srcHeaders.forEach(function (h, idx) {
      var target = RENAMES.hasOwnProperty(h) ? RENAMES[h] : h;
      if (target) obj[target] = row[idx];
    });
    if (!obj.id) obj.id = generateId_(toTab === 'Spares' ? 'SP-' : 'PR-');
    if (destHeaders.indexOf('brand') !== -1 && !obj.brand) obj.brand = 'ELGI';
    if (destHeaders.indexOf('active') !== -1 && !obj.active) obj.active = 'TRUE';
    out.push(destHeaders.map(function (h) {
      return obj.hasOwnProperty(h) && obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
    }));
  });

  if (out.length) {
    dest.getRange(2, 1, out.length, destHeaders.length).setValues(out);
    report.migrated.push(fromTab + ' → ' + toTab + ': copied ' + out.length + ' row(s). ' +
      'Rates were NOT copied — they now live in PriceList (FR-016).');
  }
}

function formatSetupReport_(report) {
  var lines = [];
  function section(title, items) {
    if (!items.length) return;
    lines.push(title);
    items.forEach(function (i) { lines.push('  • ' + i); });
    lines.push('');
  }
  section('Tabs created:', report.created);
  section('Columns added to existing tabs:', report.columnsAdded);
  section('Reference data seeded:', report.seeded);
  section('Data migrated:', report.migrated);
  section('Skipped:', report.skipped);
  if (!lines.length) return 'Everything already up to date — no changes made.';
  return lines.join('\n');
}
