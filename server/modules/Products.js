/**
 * Converted from src/Products.gs by migration/to-async.js.
 *
 * Only two things changed: functions that reach storage are `async`, and the calls that
 * reach it are `await`ed. Everything else — the logic, the names, the comments — is the
 * original, because the original is the specification and reformatting it would make the
 * diff unreadable at exactly the moment it needs to be read.
 *
 * Storage comes from server/shim.js, which keeps the old names (`readTable_`,
 * `appendRow_`) pointing at db.js. If this file is edited from here on, edit this one —
 * the .gs original stays frozen at the point of conversion so the live portal keeps running.
 */
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

async function listProducts(includeInactive) {
  var user = getCurrentUser();
  var showCost = canSeeCostPrices_(user);

  // A blank `active` cell counts as active, so a row typed straight into the Sheet still
  // shows up without the person having to know about the flag.
  var products = (await readTable_('Products'))
    .filter(function (p) { return includeInactive || String(p.active).toUpperCase() !== 'FALSE'; })
    .map(stripRow_);
  var prices = priceMapFor_('Product');
  var onHand = await stockOnHandMap_('Product');
  var reserved = await stockReservedMap_('Product');

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

async function saveProduct(input) {
  var user = getCurrentUser();
  requireRole_(user, CATALOG_EDITORS);
  requireStream_(user, STREAM_COMPRESSOR, 'The compressor catalogue');

  var productCode = String(input.productCode || '').trim();
  var model = String(input.model || '').trim();
  if (!productCode || !model) throw new Error('Product Code and Model are required.');

  var duplicate = (await readTable_('Products')).filter(function (p) {
    return String(p.productCode).trim().toLowerCase() === productCode.toLowerCase() &&
      String(p.id) !== String(input.id || '');
  })[0];
  if (duplicate) throw new Error('Product Code "' + productCode + '" already exists.');

  var record = {
    productCode: productCode,
    hsnCode: String(input.hsnCode || '').trim(),
    brand: String(input.brand || await defaultBrand_()).trim(),
    family: String(input.family || '').trim(),
    series: String(input.series || '').trim(),
    model: model,
    description: String(input.description || '').trim(),
    category: String(input.category || '').trim(),
    hpRating: String(input.hpRating || '').trim(),
    fad: String(input.fad || '').trim(),
    workingPressure: String(input.workingPressure || '').trim(),
    // The specification table on a compressor offer. Present in the schema since the start
    // and printed by the document, but with nowhere to enter them they were always blank.
    capacityCfm: String(input.capacityCfm || '').trim(),
    maxPressure: String(input.maxPressure || '').trim(),
    motorKw: String(input.motorKw || '').trim(),
    starterType: String(input.starterType || '').trim(),
    dimensionsMm: String(input.dimensionsMm || '').trim(),
    weightKg: String(input.weightKg || '').trim(),
    gstPct: input.gstPct === '' || input.gstPct === undefined || input.gstPct === null ? '' : Number(input.gstPct),
    warrantyMonths: input.warrantyMonths === '' || input.warrantyMonths === undefined || input.warrantyMonths === null ? '' : Number(input.warrantyMonths),
    standardAccessories: String(input.standardAccessories || '').trim(),
    leadTimeDays: input.leadTimeDays === '' || input.leadTimeDays === undefined || input.leadTimeDays === null ? '' : Number(input.leadTimeDays),
    uom: String(input.uom || 'Nos').trim() || 'Nos',
    notes: String(input.notes || '').trim()
  };
  // Set only where the caller means to — see the same note in saveSpare. An edit that
  // defaulted this to TRUE brought deactivated products back without anyone asking.
  if (input.active !== undefined) record.active = input.active === false ? 'FALSE' : 'TRUE';

  var isNew = !input.id;
  if (isNew) {
    if (record.active === undefined) record.active = 'TRUE';
    record.id = generateId_('PR-');
    record.createdAt = todayIso_();
    record.createdBy = user.email;
    await appendRow_('Products', record, 'Product created');
  } else {
    record.id = input.id;
    await updateRowById_('Products', 'id', input.id, record, 'Product updated');
  }

  await applyCatalogPrices_('Product', record.id, record.productCode, input);
  return record;
}

/** Soft delete — a product referenced by orders or installed machines must stay resolvable. */
async function deleteProduct(id, reason) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  await updateRowById_('Products', 'id', id, { active: 'FALSE' }, reason || 'Product deactivated');
  return true;
}

/** Puts a deactivated product back in the catalogue. The counterpart deleteProduct lacked. */
async function reactivateProduct(id, reason) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  await updateRowById_('Products', 'id', id, { active: 'TRUE' }, reason || 'Product reactivated');
  return true;
}

/**
 * Removes a product outright, for a row entered in error.
 *
 * Only while nothing refers to it — an order line, a serial number, an installed machine, a
 * compressor selection or a spare's compatibility entry all block it, and the refusal names
 * which. A product that has sold is deactivated, never deleted.
 */
async function purgeProduct(id) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);

  var product = (await readTable_('Products')).filter(function (p) { return String(p.id) === String(id); })[0];
  if (!product) throw new Error('That product no longer exists.');

  var ids = {};
  ids[String(product.id)] = product.productCode;
  await assertItemUnreferenced_('Product', ids, 'Product ' + product.productCode + ' is');

  var prices = 0;
  // Iterating the rows already read, so removing as we go cannot disturb the loop.
  for (var r of await readTable_('PriceList')) {
    if (r.itemType === 'Product' && ids.hasOwnProperty(String(r.itemId))) {
      await deleteRowById_('PriceList', 'id', r.id, 'Removed with the product');
      prices++;
    }
  }

  await deleteRowById_('Products', 'id', product.id, 'Product deleted — nothing referred to it');
  return { productCode: product.productCode, prices: prices };
}
