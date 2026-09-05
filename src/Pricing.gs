/**
 * Effective-dated pricing (FR-016, FR-017).
 *
 * Prices are never edited in place. Changing a price closes the current row (sets
 * `effectiveTo` to the day before the new price starts) and appends a new one. A quotation
 * raised last month therefore still resolves to the price that was in force last month,
 * which is the whole point of the requirement.
 *
 * `minPrice` and `maxDiscountPct` carry the minimum selling price / discount threshold that
 * quotations get checked against (FR-017, approval A02).
 */

var PRICE_LEVELS = ['List', 'Standard', 'Key Account', 'Special'];

function todayIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd');
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
 * Builds { itemId: { List: {...}, Special: {...} } } for one item type in a single read.
 * Callers that need prices for a whole catalog page use this rather than querying per row.
 */
function priceMapFor_(itemType, asOf) {
  var when = asOf || todayIso_();
  var map = {};
  readTable_('PriceList').forEach(function (row) {
    if (row.itemType !== itemType) return;
    if (!priceRowActiveOn_(row, when)) return;
    if (!map[row.itemId]) map[row.itemId] = {};
    var existing = map[row.itemId][row.priceLevel];
    // Later effectiveFrom wins if two rows somehow overlap.
    if (!existing || String(row.effectiveFrom) >= String(existing.effectiveFrom)) {
      map[row.itemId][row.priceLevel] = {
        price: Number(row.price) || 0,
        minPrice: row.minPrice === '' || row.minPrice === null ? null : Number(row.minPrice),
        maxDiscountPct: row.maxDiscountPct === '' || row.maxDiscountPct === null ? null : Number(row.maxDiscountPct),
        effectiveFrom: row.effectiveFrom,
        priceId: row.id
      };
    }
  });
  return map;
}

/** The price for one item at one level on a given date, or null. Used by quotations. */
function getEffectivePrice_(itemType, itemId, priceLevel, asOf) {
  var levels = priceMapFor_(itemType, asOf)[itemId];
  if (!levels) return null;
  return levels[priceLevel] || null;
}

/**
 * Records a new effective-dated price, closing the previous row for that item+level.
 * Master data is Management/ERP Admin only (D4, FR-062).
 */
function savePrice(input) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);

  var itemType = String(input.itemType || '').trim();
  var itemId = String(input.itemId || '').trim();
  var priceLevel = String(input.priceLevel || 'List').trim();
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
