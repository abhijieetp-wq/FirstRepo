/**
 * Compressor product master — FR-014.
 *
 * Same shape as Spares.gs: identity and specification on the master row, prices from
 * PriceList (effective-dated), stock derived from StockMovements. Compressors are
 * serial-tracked (FR-038), so on-hand here is a count of units held; individual serials live
 * in the SerialNumbers tab and are attached at inward/dispatch.
 *
 * Write access is Management + ERP Admin (D4).
 */

function listProducts() {
  getCurrentUser();

  var products = readTable_('Products').map(stripRow_);
  var prices = priceMapFor_('Product');
  var onHand = stockOnHandMap_('Product');
  var reserved = stockReservedMap_('Product');

  return products.map(function (p) {
    var id = String(p.id);
    var levels = prices[id] || {};
    p.listPrice = levels.List ? levels.List.price : null;
    p.specialPrice = levels.Special ? levels.Special.price : null;
    p.minPrice = levels.List && levels.List.minPrice !== null ? levels.List.minPrice : null;
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
  if (isNew && input.openingStock !== '' && input.openingStock !== undefined &&
      input.openingStock !== null && Number(input.openingStock) !== 0) {
    recordStockMovement({
      itemType: 'Product', itemId: record.id, itemCode: record.productCode,
      movementType: 'Opening', qty: Number(input.openingStock),
      notes: 'Opening balance entered when the product was created'
    });
  }
  return record;
}

/** Soft delete — a product referenced by orders or installed machines must stay resolvable. */
function deleteProduct(id, reason) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  updateRowById_('Products', 'id', id, { active: 'FALSE' }, reason || 'Product deactivated');
  return true;
}
