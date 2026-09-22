/**
 * Bulk CSV upload for the Spares and Products catalogs.
 *
 * This runs perhaps twice a year but rewrites the entire price list when it does, so the
 * safety pattern matters more than the convenience: parse and validate everything, show the
 * user exactly what will change, and only write after they confirm. Nothing is written by
 * `previewCatalogImport`; `commitCatalogImport` re-parses the same text and applies it.
 *
 * Matching is an upsert on the natural key — `partNo` for spares, `productCode` for products.
 * Existing rows are updated in place (so ids, history and links survive), unknown codes are
 * appended, and rows missing a required field are skipped and reported rather than guessed at.
 *
 * Performance: Apps Script kills any single call at six minutes, and one of these files is
 * 3,500 parts with up to 7,000 prices behind them — comfortably past it. So the commit runs
 * in chunks: the client asks for a few hundred rows at a time and keeps asking until the
 * server says it is done. Every chunk is a complete, committed piece of work, which also
 * means an interrupted load has written what it reported and nothing else.
 *
 * Within a chunk, master rows are written with two bulk range writes (one update block, one
 * append block) and prices in a single pass through savePricesBulk_ — writing row by row
 * would not finish either.
 *
 * Audit: a bulk import writes one summary AuditLog row rather than thousands. Per-row detail
 * would swamp the log and make it useless for the change-tracking it exists to serve.
 */

/**
 * Rows per chunk.
 *
 * Small enough that a chunk finishes well inside the six-minute limit even late in a load,
 * when the catalogue it reads first is at full size; large enough that a 3,500-row file is
 * seven or eight round trips rather than dozens.
 */
var IMPORT_CHUNK_ROWS = 500;

var IMPORT_SPECS = {
  Spare: {
    tab: 'Spares',
    keyField: 'partNo',
    idPrefix: 'SP-',
    required: ['partNo', 'description'],
    columns: ['partNo', 'hsnCode', 'description', 'productGroup', 'category', 'uom', 'gstPct',
      'piePrice', 'elgiPrice', 'reorderLevel', 'safetyStock', 'defaultBinId', 'notes'],
    masterFields: ['partNo', 'hsnCode', 'description', 'productGroup', 'category', 'uom', 'gstPct',
      'reorderLevel', 'safetyStock', 'defaultBinId', 'notes'],
    numeric: ['gstPct', 'piePrice', 'elgiPrice', 'reorderLevel', 'safetyStock']
  },
  Product: {
    tab: 'Products',
    keyField: 'productCode',
    idPrefix: 'PR-',
    required: ['productCode', 'model'],
    // The six spec fields are the specification table PIE prints on every compressor offer.
    // The schema has always had them and the document has always known how to print them —
    // but there was no column here to load them through and no field on the form to type
    // them into, so the table never appeared for any machine.
    columns: ['productCode', 'hsnCode', 'model', 'family', 'series', 'description', 'category',
      'hpRating', 'fad', 'workingPressure', 'capacityCfm', 'maxPressure', 'motorKw',
      'starterType', 'dimensionsMm', 'weightKg', 'gstPct', 'piePrice', 'elgiPrice',
      'warrantyMonths', 'leadTimeDays', 'uom', 'notes'],
    masterFields: ['productCode', 'hsnCode', 'model', 'family', 'series', 'description',
      'category', 'hpRating', 'fad', 'workingPressure', 'capacityCfm', 'maxPressure',
      'motorKw', 'starterType', 'dimensionsMm', 'weightKg', 'gstPct', 'warrantyMonths',
      'leadTimeDays', 'uom', 'notes'],
    numeric: ['gstPct', 'piePrice', 'elgiPrice', 'warrantyMonths', 'leadTimeDays']
  }
};

/** The header row for the upload template, so the columns are always right. */
function getImportTemplate(itemType) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  var spec = importSpec_(itemType);
  return {
    header: spec.columns.join(','),
    columns: spec.columns,
    required: spec.required,
    example: spec.columns.map(function (c) { return exampleValue_(itemType, c); }).join(',')
  };
}

/** Parses and validates, changing nothing. Returns the counts and problems to confirm against. */
function previewCatalogImport(itemType, csvText) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  // The preview runs once per file and is the number a person decides on, so it pays for the
  // extra read that tells it which prices would actually change. The commit skips that: it
  // runs once per chunk, and savePricesBulk_ is already holding the price list it would need.
  var analysis = analyseImport_(itemType, csvText, { comparePrices: true });
  return {
    totalRows: analysis.totalRows,
    chunkRows: IMPORT_CHUNK_ROWS,
    newCount: analysis.creates.length,
    updateCount: analysis.updates.length,
    reactivatedCount: analysis.updates.filter(function (u) { return u.wasInactive; }).length,
    skippedCount: analysis.skipped.length,
    priceChangeCount: analysis.priceChanges.length,
    skipped: analysis.skipped.slice(0, 50),
    skippedTruncated: analysis.skipped.length > 50,
    sample: analysis.creates.concat(analysis.updates).slice(0, 10).map(function (r) {
      return { action: r.action, code: r.key, description: r.values.description || r.values.model || '' };
    })
  };
}

/**
 * Applies one chunk of the file the preview described.
 *
 * `fromRow` is the 0-based index into the file's data rows (the header is not one). The
 * caller starts at 0 and keeps passing back the `nextRow` it is given until `done` comes
 * back true; `maxRows` defaults to IMPORT_CHUNK_ROWS for anyone doing that. Omitting both
 * does the whole file in one call, which is what the tests do and what a small file can
 * still afford.
 */
function commitCatalogImport(itemType, csvText, fromRow, maxRows) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);

  var spec = importSpec_(itemType);
  // Passing a starting row is what says "I am driving this in chunks", so that call gets the
  // chunk size unless it asked for a different one. Calling with neither — a small file, or a
  // test — still does the whole thing in one go.
  var driving = fromRow !== undefined && fromRow !== null;
  var rowsThisCall = Number(maxRows) > 0 ? Number(maxRows)
                   : (driving ? IMPORT_CHUNK_ROWS : 0);
  var analysis = analyseImport_(itemType, csvText,
    { fromRow: fromRow, maxRows: rowsThisCall });

  // Parsing and analysis are already done, above, outside the lock: the lock covers only the
  // writes, so the sheet is held for as short a time as the work allows.
  var lock = acquireLock_(LOCK_WAIT_BULK_MS, 'this import');
  try {
    var sheet = getSheet_(spec.tab);
    var headers = getHeaders_(sheet, spec.tab);

    // One bulk write for changed existing rows.
    if (analysis.updates.length) {
      var lastRow = sheet.getLastRow();
      var block = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
      var activeCol = headers.indexOf('active');
      analysis.updates.forEach(function (u) {
        var target = block[u.rowIndex];
        spec.masterFields.forEach(function (f) {
          var col = headers.indexOf(f);
          if (col === -1) return;
          if (u.values[f] === undefined || u.values[f] === '') return;
          target[col] = u.values[f];
        });
        // A code present in the imported catalogue is a live item. Without this, a row that
        // had been deactivated — by the pre-import clear-out, say — was updated with the real
        // description and price and then stayed invisible, so the part looked missing from a
        // catalogue that had just loaded it.
        if (activeCol !== -1) target[activeCol] = 'TRUE';
      });
      invalidateTable_(spec.tab);
      sheet.getRange(2, 1, block.length, headers.length).setValues(block);
    }

    // One bulk append for new rows.
    if (analysis.creates.length) {
      var newRows = analysis.creates.map(function (c) {
        return headers.map(function (h) {
          if (h === 'id') return c.id;
          if (h === 'brand') return defaultBrand_();
          if (h === 'active') return 'TRUE';
          if (h === 'createdAt') return todayIso_();
          if (h === 'createdBy') return user.email;
          if (h === 'defaultWarehouseId') return 'WH-MAIN';
          return c.values[h] === undefined ? '' : c.values[h];
        });
      });
      invalidateTable_(spec.tab);
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, headers.length).setValues(newRows);
    }
  } finally {
    lock.releaseLock();
  }

  // Prices stay properly effective-dated (FR-016), but in one pass rather than one call each:
  // a real catalogue is thousands of parts, and savePrice re-reads the whole PriceList every
  // time it is called.
  var pricesWritten = savePricesBulk_(analysis.priceChanges.map(function (p) {
    return { itemType: itemType, itemId: p.itemId, itemCode: p.itemCode,
             priceLevel: p.level, price: p.price };
  }), 'Bulk catalog import');

  audit_('Update', spec.tab, '(bulk import)', '', '',
    analysis.creates.length + ' new, ' + analysis.updates.length + ' updated, ' +
    pricesWritten + ' price revisions, ' + analysis.skipped.length + ' skipped',
    'Bulk catalog import by ' + user.email +
    (analysis.chunked ? ' (rows ' + (analysis.fromRow + 1) + '–' + analysis.nextRow + ' of ' +
      analysis.totalRows + ')' : ''));

  return {
    newCount: analysis.creates.length,
    updateCount: analysis.updates.length,
    reactivatedCount: analysis.updates.filter(function (u) { return u.wasInactive; }).length,
    priceChangeCount: pricesWritten,
    skippedCount: analysis.skipped.length,
    totalRows: analysis.totalRows,
    nextRow: analysis.nextRow,
    done: analysis.done
  };
}

// ------------------------------------------------------------------ internals

function importSpec_(itemType) {
  var spec = IMPORT_SPECS[itemType];
  if (!spec) throw new Error('itemType must be Spare or Product.');
  return spec;
}

/**
 * Shared by preview and commit so what you confirm is exactly what gets applied.
 *
 * `opts.fromRow` / `opts.maxRows` restrict the work to one slice of the file. Parsing is done
 * on the whole file every time — it is pure string work and cheap next to a single sheet read
 * — so that duplicate part numbers are still found across the whole file rather than only
 * within whichever chunk happens to contain them. A row's fate must not depend on where the
 * chunk boundary fell.
 *
 * `opts.comparePrices` reads the current price list so that only genuine changes are counted.
 * The commit leaves it off: savePricesBulk_ has to read the price list anyway, and does the
 * same comparison where the data already is, rather than paying for a second full read.
 */
function analyseImport_(itemType, csvText, opts) {
  var options = opts || {};
  var spec = importSpec_(itemType);
  var rows = parseCsv_(csvText);
  if (!rows.length) throw new Error('That file has no rows.');

  var header = rows[0].map(function (h) { return String(h).trim(); });
  var missingRequired = spec.required.filter(function (r) { return header.indexOf(r) === -1; });
  if (missingRequired.length) {
    throw new Error('The file is missing required column(s): ' + missingRequired.join(', ') +
      '. Use the template header shown above.');
  }

  var keyCol = header.indexOf(spec.keyField);

  // Which data rows are real, and which key each carries — one pass, no sheet access, over
  // the whole file regardless of the chunk. `dataRows` holds indexes into `rows`.
  var dataRows = [];
  var firstLineFor = {};
  var duplicateOf = {};
  for (var r = 1; r < rows.length; r++) {
    var line = rows[r];
    if (line.every(function (c) { return String(c).trim() === ''; })) continue;
    dataRows.push(r);
    var k = keyCol === -1 ? '' : String(line[keyCol] === undefined ? '' : line[keyCol]).trim().toLowerCase();
    if (!k) continue;
    if (firstLineFor.hasOwnProperty(k)) duplicateOf[r] = firstLineFor[k];
    else firstLineFor[k] = r + 1;
  }

  var totalRows = dataRows.length;
  var fromRow = Math.max(0, Number(options.fromRow) || 0);
  var maxRows = Number(options.maxRows) > 0 ? Number(options.maxRows) : totalRows;
  var slice = dataRows.slice(fromRow, fromRow + maxRows);
  var nextRow = fromRow + slice.length;

  var existing = readTable_(spec.tab);
  var byKey = {};
  existing.forEach(function (row, idx) {
    var key = String(row[spec.keyField] || '').trim().toLowerCase();
    if (key) byKey[key] = { row: row, rowIndex: idx };
  });

  var prices = options.comparePrices ? priceMapFor_(itemType) : {};
  var creates = [], updates = [], skipped = [], priceChanges = [];

  for (var n = 0; n < slice.length; n++) {
    var i = slice[n];
    var raw = rows[i];

    var values = {};
    header.forEach(function (h, idx) {
      if (spec.columns.indexOf(h) === -1) return;
      values[h] = String(raw[idx] === undefined ? '' : raw[idx]).trim();
    });

    var lineNo = i + 1;
    var key = String(values[spec.keyField] || '').trim();
    if (!key) { skipped.push({ line: lineNo, code: '', reason: 'missing ' + spec.keyField }); continue; }

    var missing = spec.required.filter(function (f) { return !values[f]; });
    if (missing.length) {
      skipped.push({ line: lineNo, code: key, reason: 'missing ' + missing.join(' and ') });
      continue;
    }

    var badNumber = spec.numeric.filter(function (f) {
      return values[f] !== undefined && values[f] !== '' && isNaN(Number(values[f]));
    });
    if (badNumber.length) {
      skipped.push({ line: lineNo, code: key, reason: badNumber.join(', ') + ' is not a number' });
      continue;
    }
    spec.numeric.forEach(function (f) {
      if (values[f] !== undefined && values[f] !== '') values[f] = Number(values[f]);
    });

    var lower = key.toLowerCase();
    if (duplicateOf.hasOwnProperty(i)) {
      skipped.push({ line: lineNo, code: key,
                     reason: 'duplicate of line ' + duplicateOf[i] + ' in this file' });
      continue;
    }

    var match = byKey[lower];
    var itemId;
    if (match) {
      itemId = match.row.id;
      updates.push({ action: 'update', key: key, values: values, rowIndex: match.rowIndex,
                     id: itemId,
                     wasInactive: String(match.row.active).toUpperCase() === 'FALSE' });
    } else {
      itemId = generateId_(spec.idPrefix);
      creates.push({ action: 'new', key: key, values: values, id: itemId });
    }

    // Every price in the file is a candidate. With comparison on, the ones already in force
    // are dropped here; without it, savePricesBulk_ drops them when it reads the price list.
    var current = prices[String(itemId)] || {};
    [[COST_PRICE_LEVEL, 'piePrice'], [SELLING_PRICE_LEVEL, 'elgiPrice']].forEach(function (pair) {
      var level = pair[0], field = pair[1];
      if (values[field] === undefined || values[field] === '') return;
      var num = Number(values[field]);
      if (current[level] && current[level].price === num) return;
      priceChanges.push({ itemId: itemId, itemCode: key, level: level, price: num });
    });
  }

  return {
    creates: creates, updates: updates, skipped: skipped, priceChanges: priceChanges,
    totalRows: totalRows, fromRow: fromRow, nextRow: nextRow,
    done: nextRow >= totalRows,
    chunked: fromRow > 0 || nextRow < totalRows
  };
}

/** RFC-4180-ish CSV parser: handles quoted fields, embedded commas, quotes and newlines. */
function parseCsv_(text) {
  var rows = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  var s = String(text || '')
    // Excel writes a UTF-8 byte-order mark, which glues itself to the first header name and
    // makes a visibly present column read as missing. Strip it before anything else looks.
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function exampleValue_(itemType, column) {
  var examples = {
    partNo: 'AF-2210', productCode: 'EG37-STD', hsnCode: '84149011',
    description: 'Air Filter Element', model: 'EG37', family: 'Screw', series: 'EG',
    category: 'Filter', uom: 'Nos', gstPct: '18', piePrice: '980', elgiPrice: '1450',
    reorderLevel: '10', safetyStock: '5', defaultBinId: 'A-12', notes: '',
    hpRating: '25', fad: '113 cfm', workingPressure: '7 bar.g',
    capacityCfm: '113 cfm', maxPressure: '7.5 bar.g', motorKw: '18 kW, 25 hp',
    starterType: 'Variable Frequency Drive', dimensionsMm: '1500 x 821 x 1220',
    weightKg: '680 kg',
    warrantyMonths: '12', leadTimeDays: '42'
  };
  return examples[column] === undefined ? '' : examples[column];
}
