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
  requireRole_(user, CATALOG_EDITORS);
  requireStream_(user, STREAM_COMPRESSOR, 'The compressor catalogue');

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
    brand: String(input.brand || defaultBrand_()).trim(),
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
    spcKw100Cfm: input.spcKw100Cfm === '' || input.spcKw100Cfm === undefined || input.spcKw100Cfm === null ? '' : Number(input.spcKw100Cfm),
    uom: String(input.uom || 'Nos').trim() || 'Nos',
    notes: String(input.notes || '').trim()
  };
  if (record.spcKw100Cfm !== '' && !(record.spcKw100Cfm > 0)) {
    throw new Error('Specific power should be a number of kW per 100 cfm, such as 18.4.');
  }
  // The form has no box for these, so an edit sent them as blanks and wiped what an upload had
  // filled in — the series the model picker filters on among them. Written only when sent.
  ['series', 'standardAccessories', 'spcKw100Cfm'].forEach(function (f) {
    if (input[f] === undefined) delete record[f];
  });
  // Set only where the caller means to — see the same note in saveSpare. An edit that
  // defaulted this to TRUE brought deactivated products back without anyone asking.
  if (input.active !== undefined) record.active = input.active === false ? 'FALSE' : 'TRUE';

  var isNew = !input.id;
  if (isNew) {
    if (record.active === undefined) record.active = 'TRUE';
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

/** Puts a deactivated product back in the catalogue. The counterpart deleteProduct lacked. */
function reactivateProduct(id, reason) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  updateRowById_('Products', 'id', id, { active: 'TRUE' }, reason || 'Product reactivated');
  return true;
}

/**
 * Removes a product outright, for a row entered in error.
 *
 * Only while nothing refers to it — an order line, a serial number, an installed machine, a
 * compressor selection or a spare's compatibility entry all block it, and the refusal names
 * which. A product that has sold is deactivated, never deleted.
 */
function purgeProduct(id) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);

  var product = readTable_('Products').filter(function (p) { return String(p.id) === String(id); })[0];
  if (!product) throw new Error('That product no longer exists.');

  var ids = {};
  ids[String(product.id)] = product.productCode;
  assertItemUnreferenced_('Product', ids, 'Product ' + product.productCode + ' is');

  var prices = 0;
  // Iterating the rows already read, so removing as we go cannot disturb the loop.
  for (var r of readTable_('PriceList')) {
    if (r.itemType === 'Product' && ids.hasOwnProperty(String(r.itemId))) {
      deleteRowById_('PriceList', 'id', r.id, 'Removed with the product');
      prices++;
    }
  }

  deleteRowById_('Products', 'id', product.id, 'Product deleted — nothing referred to it');
  return { productCode: product.productCode, prices: prices };
}

// ------------------------------------------------------------------ the model picker

/**
 * Which compressors meet a requirement for flow and pressure — and which of them to offer.
 *
 * The rule is PIE's own, from the selector in their specification workbook: a model qualifies
 * when it delivers at least the flow asked for at a working pressure at least as high as the
 * one asked for, optionally within one series.
 *
 * What it then recommends differs in one respect. The workbook flags the qualifying model with
 * the lowest specific power, and on its own that favours the biggest machine: asked for 150
 * cfm at 7 bar it picks an EQ 45 delivering 296. A screw compressor twice the size spends its
 * day unloaded, drawing power for nothing, and costs twice as much to buy. So the list is
 * sorted by how closely each one fits, and two models are named: the closest fit, and the
 * most efficient. Usually an engineer wants the first and should know about the second.
 *
 * Closest means pressure first, then flow. Flow alone picked an EQ 37-13 — a 13 bar machine —
 * for 150 cfm at 7 bar, because its 164 cfm was nearest; the 7.5 bar build of the same machine
 * gives 242 cfm for the same power, and no engineer would offer the other. So among the models
 * that qualify, the ones built for the nearest pressure come first, smallest flow first.
 *
 * The flow and pressure are read from the catalogue's own fields, which hold what an offer
 * prints — "132 cfm (3.74 m³/min)", "7 bar.g". A model whose figures cannot be read is not
 * guessed at; it is counted and named so somebody can fix the record.
 *
 * input: { fad, fadUnit: 'cfm' | 'm3min', pressure, series } — or { opportunityId } to take
 * the requirement already captured on the opportunity.
 */
var CFM_PER_M3MIN_ = 35.3147;
var PSI_PER_BAR_ = 14.5038;

function findCompressors(input) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Compressor selection');
  var o = input || {};

  var req = { fadCfm: null, pressureBar: null, series: String(o.series || '').trim().toUpperCase(),
              from: 'entered' };
  if (o.opportunityId && (o.fad === undefined || o.fad === null || o.fad === '')) {
    var tr = readTable_('TechnicalRequirements').filter(function (t) {
      return String(t.opportunityId) === String(o.opportunityId);
    })[0];
    if (tr) {
      req.fadCfm = flowCfm_(tr.requiredFad);
      req.pressureBar = pressureBar_(tr.workingPressure);
      req.from = 'requirement';
      req.requirementText = { fad: String(tr.requiredFad || ''), pressure: String(tr.workingPressure || '') };
    }
  } else {
    var amount = Number(o.fad);
    req.fadCfm = amount > 0 ? (o.fadUnit === 'm3min' ? amount * CFM_PER_M3MIN_ : amount) : null;
    var bar = Number(o.pressure);
    req.pressureBar = bar > 0 ? bar : null;
  }
  if (req.fadCfm !== null) req.fadCfm = Math.round(req.fadCfm * 10) / 10;

  var result = { requirement: req, matches: [], considered: 0, unreadable: [], largestAtPressure: null,
                 seriesAvailable: [] };
  if (!(req.fadCfm > 0) || !(req.pressureBar > 0)) return result;
  var seriesSeen = {};

  var prices = priceMapFor_('Product');
  var candidates = [];
  readTable_('Products').forEach(function (p) {
    if (String(p.active).toUpperCase() === 'FALSE') return;
    var cfm = flowCfm_(p.fad) || flowCfm_(p.capacityCfm);
    var wp = pressureBar_(p.workingPressure);
    if (!(cfm > 0) || !(wp > 0)) {
      result.unreadable.push(String(p.productCode || p.model || p.id));
      return;
    }
    var series = String(p.series || '').trim().toUpperCase() ||
      (String(p.productCode || p.model || '').match(/^[A-Za-z]+/) || [''])[0].toUpperCase();
    // Offered in the series filter whatever is chosen now, so choosing one does not hide the rest.
    if (series) seriesSeen[series] = true;
    if (req.series && series !== req.series) return;
    var spc = Number(p.spcKw100Cfm);
    var level = (prices[String(p.id)] || {})[SELLING_PRICE_LEVEL];
    candidates.push({
      id: String(p.id), productCode: String(p.productCode || ''), model: String(p.model || ''),
      series: series, hpRating: String(p.hpRating || ''), motorKw: String(p.motorKw || ''),
      fadCfm: cfm, fadM3min: Math.round(cfm / CFM_PER_M3MIN_ * 100) / 100,
      workingBar: wp, maxPressure: String(p.maxPressure || ''),
      spc: spc > 0 ? spc : null,
      inputKw: spc > 0 ? Math.round(spc * cfm) / 100 : null,
      price: level ? level.price : null
    });
  });
  result.considered = candidates.length;
  result.seriesAvailable = Object.keys(seriesSeen).sort();

  result.matches = candidates.filter(function (c) {
    return c.fadCfm >= req.fadCfm && c.workingBar >= req.pressureBar;
  }).map(function (c) {
    c.sparePct = Math.round((c.fadCfm / req.fadCfm - 1) * 1000) / 10;
    return c;
  }).sort(function (a, b) {
    return (a.workingBar - b.workingBar) || (a.fadCfm - b.fadCfm) ||
      ((a.spc || 999) - (b.spc || 999));
  });

  if (result.matches.length) {
    result.matches[0].closest = true;
    var withSpc = result.matches.filter(function (m) { return m.spc !== null; });
    if (withSpc.length) {
      var best = withSpc.reduce(function (x, y) { return y.spc < x.spc ? y : x; });
      best.bestSpc = true;
    }
  } else {
    // Nothing is big enough. Saying what the biggest is at that pressure turns "no results"
    // into the next question: two machines, or a bigger series?
    var atPressure = candidates.filter(function (c) { return c.workingBar >= req.pressureBar; });
    if (atPressure.length) {
      result.largestAtPressure = atPressure.reduce(function (x, y) { return y.fadCfm > x.fadCfm ? y : x; });
    }
  }
  return result;
}

/** cfm from text a catalogue or a requirement holds: "132 cfm", "3.74 m³/min", "3.7 m3/min". */
function flowCfm_(text) {
  var s = String(text === undefined || text === null ? '' : text).replace(/,/g, '');
  var m = s.match(/([\d.]+)\s*cfm/i);
  if (m) return Number(m[1]) || null;
  m = s.match(/([\d.]+)\s*(?:m3|m³|cum|cmm)\s*\/?\s*min/i) || s.match(/([\d.]+)\s*cmm\b/i);
  if (m) return Number(m[1]) ? Number(m[1]) * CFM_PER_M3MIN_ : null;
  m = s.match(/^\s*([\d.]+)\s*$/);
  return m ? (Number(m[1]) || null) : null;
}

/** bar from "7 bar.g", "7.5 bar", "100 psi", "7 kg/cm2" (taken as bar, as the trade does). */
function pressureBar_(text) {
  var s = String(text === undefined || text === null ? '' : text).replace(/,/g, '');
  var m = s.match(/([\d.]+)\s*psi/i);
  if (m) return Number(m[1]) ? Math.round(Number(m[1]) / PSI_PER_BAR_ * 10) / 10 : null;
  m = s.match(/([\d.]+)\s*(?:bar|kg)/i) || s.match(/^\s*([\d.]+)\s*$/);
  return m ? (Number(m[1]) || null) : null;
}
