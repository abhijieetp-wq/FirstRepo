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

/**
 * Clears the spare catalogue so a real one can be loaded over a set of trial rows.
 *
 * Refuses outright if anything in the system is built on those parts — a quotation line, an
 * order, a dispatch or a stock movement — because deleting a part that a document refers to
 * leaves that document unable to say what it sold. It reports what blocked it rather than a
 * flat no. Prices and compatibility rows for the parts it does remove go with them, since
 * neither means anything without the part.
 */
function purgeSpares(confirmText) {
  var user = getCurrentUser();
  requireRole_(user, [ROLES.ERP_ADMIN]);

  if (String(confirmText).trim().toUpperCase() !== 'DELETE ALL SPARES') {
    throw new Error('Type DELETE ALL SPARES to confirm.');
  }

  var spares = readTable_('Spares');
  if (!spares.length) return { deleted: 0, prices: 0, compatibility: 0 };

  var ids = {};
  spares.forEach(function (s) { ids[String(s.id)] = s.partNo; });

  var blockers = [];
  var check = function (tab, field, label, typeField) {
    readTable_(tab).forEach(function (r) {
      if (typeField && r[typeField] !== 'Spare') return;
      if (ids[String(r[field])]) blockers.push(label + ' ' + (r.quotationId || r.id));
    });
  };
  check('QuotationItems', 'itemId', 'quotation line', 'itemType');
  check('StockLedger', 'itemId', 'stock movement', 'itemType');

  if (blockers.length) {
    throw new Error('These spares are already used by ' + blockers.length +
      ' record(s) — for example ' + blockers.slice(0, 3).join(', ') +
      '. Clear those first, or keep the catalogue and let the import update it instead.');
  }

  var prices = 0, compat = 0;
  readTable_('PriceList').forEach(function (r) {
    if (r.itemType === 'Spare' && ids[String(r.itemId)]) {
      deleteRowById_('PriceList', 'id', r.id, 'Removed with the spare catalogue');
      prices++;
    }
  });
  readTable_('SpareCompatibility').forEach(function (r) {
    if (ids[String(r.spareId)]) {
      deleteRowById_('SpareCompatibility', 'id', r.id, 'Removed with the spare catalogue');
      compat++;
    }
  });

  var sheet = getSheet_('Spares');
  if (sheet.getLastRow() > 1) sheet.deleteRows(2, sheet.getLastRow() - 1);
  audit_('Delete', 'Spares', '(all)', '', spares.length + ' spares', '',
    'Spare catalogue cleared before a bulk load');

  return { deleted: spares.length, prices: prices, compatibility: compat };
}

/**
 * Fills in what a part is missing, at the moment someone needs it.
 *
 * Real catalogues arrive incomplete — 4,470 of ELGi's own rows carry the words "Will update
 * shortly" where an HSN code belongs. Blocking the quotation until a master record is perfect
 * is not an option, and quoting a part with no HSN on a GST document is not one either, so the
 * gap is filled where it is noticed.
 *
 * Quoting rights are enough to supply the values, because the coordinator is the person who
 * has them. Writing them back into the catalogue needs master rights: a price typed to get one
 * quotation out should not silently become the price everyone else quotes. When the person
 * lacks those rights the values still reach the quotation line, and the return says the
 * catalogue was left alone so the screen can say so too.
 */
function completeSpareDetails(input) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);

  var spare = readTable_('Spares').filter(function (s) {
    return String(s.id) === String(input.spareId);
  })[0];
  if (!spare) throw new Error('That part no longer exists.');

  var hsn = String(input.hsnCode === undefined ? '' : input.hsnCode).trim();
  if (hsn && !/^\d{6,8}$/.test(hsn)) {
    throw new Error('An HSN code is 6 to 8 digits. Leave it blank rather than guessing — it ' +
      'prints on the quotation.');
  }

  var price = input.price === '' || input.price === undefined || input.price === null
    ? null : Number(input.price);
  if (price !== null && (isNaN(price) || price < 0)) {
    throw new Error('The price must be a number, zero or more.');
  }

  var canWriteMaster = MASTER_EDITORS.indexOf(user.role) !== -1;
  var written = [];

  if (canWriteMaster && hsn && hsn !== String(spare.hsnCode || '').trim()) {
    updateRowById_('Spares', 'id', spare.id, { hsnCode: hsn },
      'HSN supplied while quoting ' + (input.quoteNo || ''));
    written.push('HSN code');
  }

  if (canWriteMaster && price !== null) {
    savePrice({
      itemType: 'Spare', itemId: spare.id, itemCode: spare.partNo,
      priceLevel: SELLING_PRICE_LEVEL, price: price,
      reason: 'Supplied while quoting ' + (input.quoteNo || '')
    });
    written.push('selling price');
  }

  return {
    partNo: spare.partNo,
    hsnCode: hsn || spare.hsnCode || '',
    price: price,
    savedToCatalog: written,
    canWriteMaster: canWriteMaster
  };
}
