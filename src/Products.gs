/**
 * Compressor product master — FR-014.
 *
 * Same shape as Spares.gs: identity and specification on the master row, prices from
 * PriceList (effective-dated), stock derived from StockMovements. Compressors are
 * serial-tracked (FR-038), so on-hand here is a count of units held; individual serials live
 * in the SerialNumbers tab and are attached at inward/dispatch. There is deliberately no
 * opening-stock entry here — compressor units enter stock through inward/GRN against a
 * serial number, never as a typed opening figure.
 *
 * PIE is the buying price and ELGI the selling price; PIE is cost data and is returned only
 * to Management and ERP Admin (FR-062).
 *
 * Write access is Management + ERP Admin (D4).
 */

function listProducts(includeInactive) {
  var user = getCurrentUser();
  var showCost = canSeeCostPrices_(user);

  // A blank `active` cell counts as active, so a row typed straight into the Sheet still
  // shows up without the person having to know about the flag.
  var products = readTable_('Products')
    .filter(function (p) { return includeInactive || String(p.active).toUpperCase() !== 'FALSE'; })
    .map(stripRow_);
  var prices = priceMapFor_('Product');
  var onHand = stockOnHandMap_('Product');
  var reserved = stockReservedMap_('Product');

  return products.map(function (p) {
    var id = String(p.id);
    var levels = prices[id] || {};
    // `price` is the selling (ELGI) price under a neutral name — what quotations use.
    p.price = levels[SELLING_PRICE_LEVEL] ? levels[SELLING_PRICE_LEVEL].price : null;
    p.elgiPrice = p.price;
    if (showCost) {
      p.piePrice = levels[COST_PRICE_LEVEL] ? levels[COST_PRICE_LEVEL].price : null;
      p.margin = (p.price !== null && p.piePrice !== null) ? p.price - p.piePrice : null;
    }
    p.onHand = onHand[id] || 0;
    p.reserved = reserved[id] || 0;
    p.available = (onHand[id] || 0) - (reserved[id] || 0);
    return p;
  });
}

function saveProduct(input) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);

  var productCode = String(input.productCode || '').trim();
  var model = String(input.model || '').trim();
  if (!productCode || !model) throw new Error('Product Code and Model are required.');

  var duplicate = readTable_('Products').filter(function (p) {
    return String(p.productCode).trim().toLowerCase() === productCode.toLowerCase() &&
      String(p.id) !== String(input.id || '');
  })[0];
  if (duplicate) throw new Error('Product Code "' + productCode + '" already exists.');

  var record = {
    productCode: productCode,
    hsnCode: String(input.hsnCode || '').trim(),
    brand: String(input.brand || 'ELGI').trim(),
    family: String(input.family || '').trim(),
    series: String(input.series || '').trim(),
    model: model,
    description: String(input.description || '').trim(),
    category: String(input.category || '').trim(),
    hpRating: String(input.hpRating || '').trim(),
    fad: String(input.fad || '').trim(),
    workingPressure: String(input.workingPressure || '').trim(),
    gstPct: input.gstPct === '' || input.gstPct === undefined || input.gstPct === null ? '' : Number(input.gstPct),
    warrantyMonths: input.warrantyMonths === '' || input.warrantyMonths === undefined || input.warrantyMonths === null ? '' : Number(input.warrantyMonths),
    standardAccessories: String(input.standardAccessories || '').trim(),
    leadTimeDays: input.leadTimeDays === '' || input.leadTimeDays === undefined || input.leadTimeDays === null ? '' : Number(input.leadTimeDays),
    uom: String(input.uom || 'Nos').trim() || 'Nos',
    notes: String(input.notes || '').trim(),
    active: input.active === false ? 'FALSE' : 'TRUE'
  };

  var isNew = !input.id;
  if (isNew) {
    record.id = generateId_('PR-');
    record.createdAt = todayIso_();
    record.createdBy = user.email;
    appendRow_('Products', record, 'Product created');
  } else {
    record.id = input.id;
    updateRowById_('Products', 'id', input.id, record, 'Product updated');
  }

  applyCatalogPrices_('Product', record.id, record.productCode, input);
  return record;
}

/** Soft delete — a product referenced by orders or installed machines must stay resolvable. */
function deleteProduct(id, reason) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  updateRowById_('Products', 'id', id, { active: 'FALSE' }, reason || 'Product deactivated');
  return true;
}
