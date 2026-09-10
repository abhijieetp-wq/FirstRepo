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
 * Performance: a 7,000-row file cannot be written row by row inside the 6-minute limit, so
 * master rows are written with two bulk range writes (one update block, one append block).
 * Prices still go through savePrice because effective-dating is the whole point of FR-016 —
 * that is the slow part, and only prices that actually changed are written.
 *
 * Audit: a bulk import writes one summary AuditLog row rather than thousands. Per-row detail
 * would swamp the log and make it useless for the change-tracking it exists to serve.
 */

var IMPORT_SPECS = {
  Spare: {
    tab: 'Spares',
    keyField: 'partNo',
    idPrefix: 'SP-',
    required: ['partNo', 'description'],
    columns: ['partNo', 'hsnCode', 'description', 'category', 'uom', 'gstPct', 'piePrice',
      'elgiPrice', 'reorderLevel', 'safetyStock', 'defaultBinId', 'notes'],
    masterFields: ['partNo', 'hsnCode', 'description', 'category', 'uom', 'gstPct',
      'reorderLevel', 'safetyStock', 'defaultBinId', 'notes'],
    numeric: ['gstPct', 'piePrice', 'elgiPrice', 'reorderLevel', 'safetyStock']
  },
  Product: {
    tab: 'Products',
    keyField: 'productCode',
    idPrefix: 'PR-',
    required: ['productCode', 'model'],
    columns: ['productCode', 'hsnCode', 'model', 'family', 'series', 'description', 'category',
      'hpRating', 'fad', 'workingPressure', 'gstPct', 'piePrice', 'elgiPrice', 'warrantyMonths',
      'leadTimeDays', 'uom', 'notes'],
    masterFields: ['productCode', 'hsnCode', 'model', 'family', 'series', 'description',
      'category', 'hpRating', 'fad', 'workingPressure', 'gstPct', 'warrantyMonths',
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
  var analysis = analyseImport_(itemType, csvText);
  return {
    newCount: analysis.creates.length,
    updateCount: analysis.updates.length,
    skippedCount: analysis.skipped.length,
    priceChangeCount: analysis.priceChanges.length,
    skipped: analysis.skipped.slice(0, 50),
    skippedTruncated: analysis.skipped.length > 50,
    sample: analysis.creates.concat(analysis.updates).slice(0, 10).map(function (r) {
      return { action: r.action, code: r.key, description: r.values.description || r.values.model || '' };
    })
  };
}

/** Applies the same file the preview described. */
function commitCatalogImport(itemType, csvText) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);

  var spec = importSpec_(itemType);
  var analysis = analyseImport_(itemType, csvText);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet_(spec.tab);
    var headers = getHeaders_(sheet);

    // One bulk write for changed existing rows.
    if (analysis.updates.length) {
      var lastRow = sheet.getLastRow();
      var block = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
      analysis.updates.forEach(function (u) {
        var target = block[u.rowIndex];
        spec.masterFields.forEach(function (f) {
          var col = headers.indexOf(f);
          if (col === -1) return;
          if (u.values[f] === undefined || u.values[f] === '') return;
          target[col] = u.values[f];
        });
      });
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
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, headers.length).setValues(newRows);
    }
  } finally {
    lock.releaseLock();
  }

  // Prices go through savePrice so each change is properly effective-dated (FR-016).
  var pricesWritten = 0;
  analysis.priceChanges.forEach(function (p) {
    savePrice({
      itemType: itemType, itemId: p.itemId, itemCode: p.itemCode, priceLevel: p.level,
      price: p.price, reason: 'Bulk catalog import'
    });
    pricesWritten++;
  });

  audit_('Update', spec.tab, '(bulk import)', '', '',
    analysis.creates.length + ' new, ' + analysis.updates.length + ' updated, ' +
    pricesWritten + ' price revisions, ' + analysis.skipped.length + ' skipped',
    'Bulk catalog import by ' + user.email);

  return {
    newCount: analysis.creates.length,
    updateCount: analysis.updates.length,
    priceChangeCount: pricesWritten,
    skippedCount: analysis.skipped.length
  };
}

// ------------------------------------------------------------------ internals

function importSpec_(itemType) {
  var spec = IMPORT_SPECS[itemType];
  if (!spec) throw new Error('itemType must be Spare or Product.');
  return spec;
}

/** Shared by preview and commit so what you confirm is exactly what gets applied. */
function analyseImport_(itemType, csvText) {
  var spec = importSpec_(itemType);
  var rows = parseCsv_(csvText);
  if (!rows.length) throw new Error('That file has no rows.');

  var header = rows[0].map(function (h) { return String(h).trim(); });
  var missingRequired = spec.required.filter(function (r) { return header.indexOf(r) === -1; });
  if (missingRequired.length) {
    throw new Error('The file is missing required column(s): ' + missingRequired.join(', ') +
      '. Use the template header shown above.');
  }

  var existing = readTable_(spec.tab);
  var byKey = {};
  existing.forEach(function (row, idx) {
    var key = String(row[spec.keyField] || '').trim().toLowerCase();
    if (key) byKey[key] = { row: row, rowIndex: idx };
  });

  var prices = priceMapFor_(itemType);
  var creates = [], updates = [], skipped = [], priceChanges = [];
  var seenKeys = {};

  for (var i = 1; i < rows.length; i++) {
    var raw = rows[i];
    if (raw.every(function (c) { return String(c).trim() === ''; })) continue;

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
    if (seenKeys[lower]) {
      skipped.push({ line: lineNo, code: key, reason: 'duplicate of line ' + seenKeys[lower] + ' in this file' });
      continue;
    }
    seenKeys[lower] = lineNo;

    var match = byKey[lower];
    var itemId;
    if (match) {
      itemId = match.row.id;
      updates.push({ action: 'update', key: key, values: values, rowIndex: match.rowIndex, id: itemId });
    } else {
      itemId = generateId_(spec.idPrefix);
      creates.push({ action: 'new', key: key, values: values, id: itemId });
    }

    // Only price levels whose value actually changed become revisions.
    var current = prices[String(itemId)] || {};
    [[COST_PRICE_LEVEL, 'piePrice'], [SELLING_PRICE_LEVEL, 'elgiPrice']].forEach(function (pair) {
      var level = pair[0], field = pair[1];
      if (values[field] === undefined || values[field] === '') return;
      var num = Number(values[field]);
      if (current[level] && current[level].price === num) return;
      priceChanges.push({ itemId: itemId, itemCode: key, level: level, price: num });
    });
  }

  return { creates: creates, updates: updates, skipped: skipped, priceChanges: priceChanges };
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
    hpRating: '50', fad: '6.2 m3/min', workingPressure: '7.5 bar',
    warrantyMonths: '12', leadTimeDays: '30'
  };
  return examples[column] === undefined ? '' : examples[column];
}
