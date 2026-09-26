/**
 * Effective-dated pricing (FR-016, FR-017).
 *
 * Prices are never edited in place. Changing a price closes the current row (sets
 * `effectiveTo` to the day before the new price starts) and appends a new one. A quotation
 * raised last month therefore still resolves to the price that was in force last month,
 * which is the whole point of the requirement.
 *
 * FR-017's minimum-price control now has a natural floor: the PIE (cost) price. The
 * minPrice/maxDiscountPct columns remain in the schema for when that approval rule is
 * built with the quotation module, but nothing writes them today.
 */

/**
 * Two price levels, and the distinction matters:
 *   PIE  — what PMT buys the item at (cost). Margin-sensitive: only Management and ERP Admin
 *          see it, per FR-062's "restrict cost/margin data".
 *   ELGI — what PMT sells it at. Quotations always use this one, and label it just "Price"
 *          so the customer-facing document never exposes the internal naming.
 */
var PRICE_LEVELS = ['PIE', 'ELGI'];
var COST_PRICE_LEVEL = 'PIE';
var SELLING_PRICE_LEVEL = 'ELGI';

function todayIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd');
}

/**
 * The moment something happened, to the second.
 *
 * A date alone answers "which day"; a quotation list wants "which of the four we did on
 * Tuesday, and in what order". Written with the T and the Z so the sheet keeps it as text —
 * a bare "2026-09-26 10:35" is parsed into a date cell and read back with the time gone.
 */
function nowIso_() {
  return new Date().toISOString();
}

/** True when `asOf` falls inside the row's effective window. Blank effectiveTo = open-ended. */
function priceRowActiveOn_(row, asOf) {
  if (String(row.active).toUpperCase() === 'FALSE') return false;
  var from = String(row.effectiveFrom || '').slice(0, 10);
  var to = String(row.effectiveTo || '').slice(0, 10);
  if (from && asOf < from) return false;
  if (to && asOf > to) return false;
  return true;
}

/**
 * Builds { itemId: { PIE: {...}, ELGI: {...} } } for one item type in a single read.
 * Callers that need prices for a whole catalog page use this rather than querying per row.
 */
function priceMapFor_(itemType, asOf) {
  var when = asOf || todayIso_();
  var map = {};

  // Deliberately not readTable_. That builds an object for every row and normalizes every
  // cell, and this table is the largest in the sheet — two prices for each of 13,000 parts.
  // Reading the block and indexing by column position lets a row of the wrong itemType be
  // rejected on a single comparison, which is most of them whenever the caller wants
  // products. It is the difference between the catalogue screen opening and appearing empty
  // for half a minute while it loads.
  var sheet = getSheet_('PriceList');
  var headers = getHeaders_(sheet, 'PriceList');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2 || !headers.length) return map;

  var ci = {};
  headers.forEach(function (h, i) { ci[h] = i; });
  var block = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();

  var asIso = function (v) {
    if (v instanceof Date) {
      return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd');
    }
    return String(v || '').slice(0, 10);
  };

  for (var r = 0; r < block.length; r++) {
    var row = block[r];
    if (row[ci.itemType] !== itemType) continue;
    if (String(row[ci.active]).toUpperCase() === 'FALSE') continue;

    var from = asIso(row[ci.effectiveFrom]);
    var to = asIso(row[ci.effectiveTo]);
    if (from && when < from) continue;
    if (to && when > to) continue;

    var itemId = row[ci.itemId];
    var level = row[ci.priceLevel];
    if (!map[itemId]) map[itemId] = {};
    var existing = map[itemId][level];
    // Later effectiveFrom wins if two rows somehow overlap.
    if (existing && String(from) < String(existing.effectiveFrom)) continue;

    var min = row[ci.minPrice], maxd = row[ci.maxDiscountPct];
    map[itemId][level] = {
      price: Number(row[ci.price]) || 0,
      minPrice: min === '' || min === null ? null : Number(min),
      maxDiscountPct: maxd === '' || maxd === null ? null : Number(maxd),
      effectiveFrom: from,
      priceId: row[ci.id]
    };
  }
  return map;
}

/**
 * The price for one item at one level on a given date, or null. Used by quotations.
 *
 * This went through priceMapFor_, which reads every column of every price row and indexes the
 * whole catalogue — 105,000 cells to answer a question about one part, on every line added to
 * every quotation. Instead: read the single itemId column to find the two or three rows that
 * could be the answer, then fetch those rows in full. About fifteen times less, and the same
 * answer, because the narrowing column is the one the map was keyed on anyway.
 */
function getEffectivePrice_(itemType, itemId, priceLevel, asOf) {
  var found = getEffectivePrices_(itemType, [itemId], priceLevel, asOf);
  return found[String(itemId)] || null;
}

/**
 * The price in force for each of several items, in one pass over the PriceList.
 *
 * Reading the whole table to answer a question about one part is what made adding a quotation
 * line slow: PriceList is the largest tab in the sheet — two rows for each of 26,000 parts —
 * and `priceMapFor_` indexed all of it. One read of the id column says which rows can possibly
 * matter; only those rows are then fetched.
 */
function getEffectivePrices_(itemType, itemIds, priceLevel, asOf) {
  var when = asOf || todayIso_();
  var out = {};

  var want = {};
  var any = false;
  (itemIds || []).forEach(function (v) { want[String(v)] = true; any = true; });
  if (!any) return out;

  var sheet = getSheet_('PriceList');
  var headers = getHeaders_(sheet, 'PriceList');
  var lastRow = sheet.getLastRow();
  var idCol = headers.indexOf('itemId');
  if (lastRow < 2 || idCol === -1) return out;

  var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  var hits = [];
  for (var i = 0; i < ids.length; i++) {
    if (want[String(ids[i][0])]) hits.push(i + 2);
  }
  if (!hits.length) return out;

  // A bulk import appends every ELGI price and then every PIE price, so one part's two rows
  // sit a whole catalogue apart. Reading the span between them would be reading the table.
  rowRuns_(hits).forEach(function (run) {
    var values = sheet.getRange(run[0], 1, run[1] - run[0] + 1, headers.length).getValues();
    for (var v = 0; v < values.length; v++) {
      var row = {};
      for (var h = 0; h < headers.length; h++) row[headers[h]] = normalizeCell_(values[v][h]);
      var key = String(row.itemId);
      if (!want[key]) continue;
      if (row.itemType !== itemType || row.priceLevel !== priceLevel) continue;
      if (!priceRowActiveOn_(row, when)) continue;
      var best = out[key];
      // Later effectiveFrom wins if two rows somehow overlap.
      if (best && String(row.effectiveFrom) < String(best.effectiveFrom)) continue;
      out[key] = {
        price: Number(row.price) || 0,
        minPrice: row.minPrice === '' || row.minPrice === null ? null : Number(row.minPrice),
        maxDiscountPct: row.maxDiscountPct === '' || row.maxDiscountPct === null
          ? null : Number(row.maxDiscountPct),
        effectiveFrom: String(row.effectiveFrom || '').slice(0, 10),
        priceId: row.id
      };
    }
  });
  return out;
}

/**
 * Records a new effective-dated price, closing the previous row for that item+level.
 * Master data is Management/ERP Admin only (D4, FR-062).
 */
/**
 * Sets many prices in one pass.
 *
 * savePrice reads the whole PriceList to find the row it supersedes, then appends. That is
 * right for one price and ruinous for thousands: a 13,000-part catalogue with a cost and a
 * selling price each is 26,000 full table reads, which no Apps Script execution will survive.
 * This does the same work — supersede what is open, append what is new, keep the effective
 * dating honest — reading once and writing twice.
 */
function savePricesBulk_(entries, reason) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  if (!entries || !entries.length) return 0;

  var today = todayIso_();
  var wanted = entries.map(function (e) {
    var price = Number(e.price);
    if (isNaN(price) || price < 0) throw new Error('A valid price is required for ' + e.itemCode + '.');
    if (PRICE_LEVELS.indexOf(e.priceLevel) === -1) {
      throw new Error('Unknown price level "' + e.priceLevel + '".');
    }
    return {
      itemType: e.itemType, itemId: String(e.itemId), itemCode: String(e.itemCode || ''),
      priceLevel: e.priceLevel, price: price,
      effectiveFrom: String(e.effectiveFrom || today).slice(0, 10)
    };
  });

  // Deliberately a second acquisition rather than one held across the whole import: the
  // master rows are written and released first, so the price pass — the long one, since it
  // rewrites the entire price list — does not also hold the catalogue tab while it runs.
  var lock = acquireLock_(LOCK_WAIT_BULK_MS, 'this price load');
  try {
    var sheet = getSheet_('PriceList');
    var headers = getHeaders_(sheet, 'PriceList');
    var lastRow = sheet.getLastRow();

    // One read. Index the open rows by item+level so superseding is a lookup, not a scan.
    var openRows = {};
    var block = null;
    if (lastRow > 1) {
      block = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
      var ci = {};
      headers.forEach(function (h, i) { ci[h] = i; });
      block.forEach(function (row, idx) {
        var key = row[ci.itemType] + '|' + row[ci.itemId] + '|' + row[ci.priceLevel];
        (openRows[key] = openRows[key] || []).push({ idx: idx, row: row, ci: ci });
      });
    }

    // A price that is already in force is left alone: no row closed, no row appended. The
    // caller used to make this decision, which meant reading the whole price list a second
    // time to do it. The list is already open here, so the comparison happens here.
    var superseded = 0;
    var changing = [];
    wanted.forEach(function (w) {
      var hits = openRows[w.itemType + '|' + w.itemId + '|' + w.priceLevel];
      var toClose = [];
      var unchanged = false;

      (hits || []).forEach(function (h) {
        var asRow = {};
        headers.forEach(function (name, i) { asRow[name] = h.row[i]; });
        if (!priceRowActiveOn_(asRow, w.effectiveFrom)) return;
        if (Number(asRow.price) === w.price) { unchanged = true; return; }
        toClose.push(h);
      });

      if (unchanged) return;
      toClose.forEach(function (h) {
        h.row[h.ci.effectiveTo] = previousDay_(w.effectiveFrom);
        superseded++;
      });
      changing.push(w);
    });
    if (superseded && block) {
      invalidateTable_('PriceList');
      sheet.getRange(2, 1, block.length, headers.length).setValues(block);
    }
    if (!changing.length) return 0;

    var rows = changing.map(function (w) {
      return headers.map(function (h) {
        switch (h) {
          case 'id': return generateId_('PRC-');
          case 'itemType': return w.itemType;
          case 'itemId': return w.itemId;
          case 'itemCode': return w.itemCode;
          case 'priceLevel': return w.priceLevel;
          case 'price': return w.price;
          case 'currency': return 'INR';
          case 'effectiveFrom': return w.effectiveFrom;
          case 'effectiveTo': return '';
          case 'approvedBy': return user.email;
          case 'active': return 'TRUE';
          case 'createdAt': return today;
          case 'createdBy': return user.email;
          default: return '';
        }
      });
    });
    invalidateTable_('PriceList');
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);

    // One audit line for the batch: 26,000 would bury everything else in the log.
    audit_('Update', 'PriceList', '(bulk)', '', '',
      rows.length + ' price(s), ' + superseded + ' superseded', reason || 'Bulk price load');
    return rows.length;
  } finally {
    lock.releaseLock();
  }
}

function savePrice(input) {
  var user = getCurrentUser();
  requireRole_(user, CATALOG_EDITORS);

  var itemType = String(input.itemType || '').trim();
  var itemId = String(input.itemId || '').trim();
  var priceLevel = String(input.priceLevel || SELLING_PRICE_LEVEL).trim();
  var price = Number(input.price);
  if (['Product', 'Spare'].indexOf(itemType) === -1) throw new Error('itemType must be Product or Spare.');
  if (!itemId) throw new Error('itemId is required.');
  if (PRICE_LEVELS.indexOf(priceLevel) === -1) throw new Error('Unknown price level "' + priceLevel + '".');
  if (isNaN(price) || price < 0) throw new Error('A valid price is required.');

  var effectiveFrom = String(input.effectiveFrom || todayIso_()).slice(0, 10);

  // Close any row for this item+level that is still open on the new start date.
  readTable_('PriceList').forEach(function (row) {
    if (row.itemType !== itemType || String(row.itemId) !== itemId || row.priceLevel !== priceLevel) return;
    if (!priceRowActiveOn_(row, effectiveFrom)) return;
    updateRowById_('PriceList', 'id', row.id,
      { effectiveTo: previousDay_(effectiveFrom) }, 'Superseded by a new price effective ' + effectiveFrom);
  });

  var record = {
    id: generateId_('PRC-'),
    itemType: itemType,
    itemId: itemId,
    itemCode: String(input.itemCode || '').trim(),
    priceLevel: priceLevel,
    price: price,
    minPrice: input.minPrice === '' || input.minPrice === undefined || input.minPrice === null ? '' : Number(input.minPrice),
    maxDiscountPct: input.maxDiscountPct === '' || input.maxDiscountPct === undefined || input.maxDiscountPct === null ? '' : Number(input.maxDiscountPct),
    currency: 'INR',
    effectiveFrom: effectiveFrom,
    effectiveTo: '',
    approvedBy: user.email,
    active: 'TRUE',
    createdAt: todayIso_(),
    createdBy: user.email
  };
  appendRow_('PriceList', record, input.reason || 'Price set from catalog');
  return record;
}

/** Full price history for one item — what changed, when, and who approved it. */
function getPriceHistory(itemType, itemId) {
  getCurrentUser();
  return readTable_('PriceList')
    .filter(function (r) { return r.itemType === itemType && String(r.itemId) === String(itemId); })
    .sort(function (a, b) { return String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)); })
    .map(stripRow_);
}

function previousDay_(isoDate) {
  var parts = String(isoDate).slice(0, 10).split('-');
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  d.setDate(d.getDate() - 1);
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd');
}
