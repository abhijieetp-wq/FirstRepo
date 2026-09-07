/**
 * Spare (parts) master — FR-015.
 *
 * The master row holds identity and handling data only. Prices live in PriceList
 * (effective-dated, FR-016) and stock is derived from StockMovements (FR-036), so this
 * module composes those three sources when listing. Substitute parts come from
 * SpareAlternates and feed the rate-comparison chips.
 *
 * Two prices: PIE is what PMT buys at, ELGI is what it sells at. The PIE price is cost data,
 * so it is only returned to Management and ERP Admin (FR-062). Everyone else sees the
 * selling price, exposed as `price` — quotations use that and never show the internal name.
 *
 * Write access is Management + ERP Admin (D4).
 */

function listSpares(includeInactive) {
  // A blank `active` cell counts as active, so a row typed straight into the Sheet still
  // shows up without the person having to know about the flag.
  var user = getCurrentUser();
  var showCost = canSeeCostPrices_(user);

  var spares = readTable_('Spares')
    .filter(function (s) { return includeInactive || String(s.active).toUpperCase() !== 'FALSE'; })
    .map(stripRow_);
  var prices = priceMapFor_('Spare');
  var onHand = stockOnHandMap_('Spare');
  var reserved = stockReservedMap_('Spare');

  var alternatesBySpare = {};
  readTable_('SpareAlternates').forEach(function (a) {
    if (String(a.active).toUpperCase() === 'FALSE') return;
    var key = String(a.spareId);
    if (!alternatesBySpare[key]) alternatesBySpare[key] = [];
    alternatesBySpare[key].push(stripRow_(a));
  });

  var compatBySpare = {};
  readTable_('SpareCompatibility').forEach(function (c) {
    if (String(c.active).toUpperCase() === 'FALSE') return;
    var key = String(c.spareId);
    if (!compatBySpare[key]) compatBySpare[key] = [];
    compatBySpare[key].push(c.productModel);
  });

  return spares.map(function (s) {
    var id = String(s.id);
    var levels = prices[id] || {};
    var alts = alternatesBySpare[id] || [];

    // An alternate's own selling price, so the Alternate chip can show a real number.
    alts.forEach(function (a) {
      var altLevels = a.alternateSpareId ? (prices[String(a.alternateSpareId)] || {}) : {};
      a.altRate = altLevels[SELLING_PRICE_LEVEL] ? altLevels[SELLING_PRICE_LEVEL].price : null;
    });

    // `price` is the selling (ELGI) price under a neutral name — what quotations use.
    s.price = levels[SELLING_PRICE_LEVEL] ? levels[SELLING_PRICE_LEVEL].price : null;
    s.elgiPrice = s.price;
    if (showCost) {
      s.piePrice = levels[COST_PRICE_LEVEL] ? levels[COST_PRICE_LEVEL].price : null;
      s.margin = (s.price !== null && s.piePrice !== null) ? s.price - s.piePrice : null;
    }
    s.onHand = onHand[id] || 0;
    s.reserved = reserved[id] || 0;
    s.available = (onHand[id] || 0) - (reserved[id] || 0);
    s.alternates = alts;
    s.compatibleModels = compatBySpare[id] || [];
    s.belowReorder = s.reorderLevel !== '' && s.reorderLevel !== null &&
      s.available <= Number(s.reorderLevel);
    return s;
  });
}

/**
 * Creates or updates a spare. Price and opening-stock fields are optional conveniences —
 * they are written through Pricing/Stock so they land in the right ledgers rather than as
 * columns on this row.
 */
function saveSpare(input) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);

  var partNo = String(input.partNo || '').trim();
  var description = String(input.description || '').trim();
  if (!partNo || !description) throw new Error('Part No. and Description are required.');

  var duplicate = readTable_('Spares').filter(function (s) {
    return String(s.partNo).trim().toLowerCase() === partNo.toLowerCase() && String(s.id) !== String(input.id || '');
  })[0];
  if (duplicate) throw new Error('Part No. "' + partNo + '" already exists in the spare master.');

  var record = {
    partNo: partNo,
    hsnCode: String(input.hsnCode || '').trim(),
    description: description,
    category: String(input.category || '').trim(),
    brand: String(input.brand || 'ELGI').trim(),
    uom: String(input.uom || 'Nos').trim() || 'Nos',
    gstPct: input.gstPct === '' || input.gstPct === undefined || input.gstPct === null ? '' : Number(input.gstPct),
    reorderLevel: input.reorderLevel === '' || input.reorderLevel === undefined || input.reorderLevel === null ? '' : Number(input.reorderLevel),
    safetyStock: input.safetyStock === '' || input.safetyStock === undefined || input.safetyStock === null ? '' : Number(input.safetyStock),
    defaultWarehouseId: String(input.defaultWarehouseId || 'WH-MAIN').trim(),
    defaultBinId: String(input.defaultBinId || '').trim(),
    notes: String(input.notes || '').trim(),
    active: input.active === false ? 'FALSE' : 'TRUE'
  };

  var isNew = !input.id;
  if (isNew) {
    record.id = generateId_('SP-');
    record.createdAt = todayIso_();
    record.createdBy = user.email;
    appendRow_('Spares', record, 'Spare created');
  } else {
    record.id = input.id;
    updateRowById_('Spares', 'id', input.id, record, 'Spare updated');
  }

  applyCatalogPrices_('Spare', record.id, record.partNo, input);
  if (isNew && input.openingStock !== '' && input.openingStock !== undefined &&
      input.openingStock !== null && Number(input.openingStock) !== 0) {
    recordStockMovement({
      itemType: 'Spare', itemId: record.id, itemCode: record.partNo,
      movementType: 'Opening', qty: Number(input.openingStock),
      warehouseId: record.defaultWarehouseId, binId: record.defaultBinId,
      notes: 'Opening balance entered when the part was created'
    });
  }
  return record;
}

/** Soft delete: masters referenced by history are deactivated, never removed. */
function deleteSpare(id, reason) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  updateRowById_('Spares', 'id', id, { active: 'FALSE' }, reason || 'Spare deactivated');
  return true;
}

/** Links a substitute part. Either point at another spare, or record a free-text equivalent. */
function saveSpareAlternate(input) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  if (!input.spareId) throw new Error('spareId is required.');
  if (!input.alternateSpareId && !String(input.altPartNo || '').trim()) {
    throw new Error('Pick an alternate part from the catalog, or type an alternate part number.');
  }

  var record = {
    spareId: String(input.spareId),
    alternateSpareId: String(input.alternateSpareId || '').trim(),
    altPartNo: String(input.altPartNo || '').trim(),
    altDescription: String(input.altDescription || '').trim(),
    altSource: String(input.altSource || '').trim(),
    notes: String(input.notes || '').trim(),
    active: 'TRUE'
  };
  if (input.id) {
    record.id = input.id;
    updateRowById_('SpareAlternates', 'id', input.id, record, 'Alternate part updated');
  } else {
    record.id = generateId_('ALT-');
    appendRow_('SpareAlternates', record, 'Alternate part linked');
  }
  return record;
}

function deleteSpareAlternate(id) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  updateRowById_('SpareAlternates', 'id', id, { active: 'FALSE' }, 'Alternate part unlinked');
  return true;
}

/** Maps a spare to a compressor model it fits (FR-023). */
function saveSpareCompatibility(input) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  if (!input.spareId) throw new Error('spareId is required.');
  var model = String(input.productModel || '').trim();
  if (!model) throw new Error('A compressor model is required.');

  var record = {
    spareId: String(input.spareId),
    productModel: model,
    productId: String(input.productId || '').trim(),
    isServiceKit: input.isServiceKit ? 'TRUE' : 'FALSE',
    notes: String(input.notes || '').trim(),
    active: 'TRUE'
  };
  if (input.id) {
    record.id = input.id;
    updateRowById_('SpareCompatibility', 'id', input.id, record, 'Compatibility updated');
  } else {
    record.id = generateId_('CMP-');
    appendRow_('SpareCompatibility', record, 'Compatibility mapped');
  }
  return record;
}

function deleteSpareCompatibility(id) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  updateRowById_('SpareCompatibility', 'id', id, { active: 'FALSE' }, 'Compatibility removed');
  return true;
}

/** Only Management and ERP Admin may see cost prices and margin (FR-062). */
function canSeeCostPrices_(user) {
  return MASTER_EDITORS.indexOf(user.role) !== -1;
}

/**
 * Shared by saveSpare/saveProduct: writes the PIE and ELGI prices, but only when the
 * submitted value actually differs from what is currently effective — otherwise editing a
 * description would create a pointless price revision and clutter the price history.
 */
function applyCatalogPrices_(itemType, itemId, itemCode, input) {
  var current = priceMapFor_(itemType)[String(itemId)] || {};

  function maybeWrite(level, value) {
    if (value === '' || value === undefined || value === null) return;
    var num = Number(value);
    if (isNaN(num)) return;
    var existing = current[level];
    if (existing && existing.price === num) return;
    savePrice({
      itemType: itemType, itemId: itemId, itemCode: itemCode, priceLevel: level,
      price: num, effectiveFrom: input.priceEffectiveFrom,
      reason: input.priceReason || 'Set from the catalog screen'
    });
  }

  maybeWrite(COST_PRICE_LEVEL, input.piePrice);
  maybeWrite(SELLING_PRICE_LEVEL, input.elgiPrice);
}
