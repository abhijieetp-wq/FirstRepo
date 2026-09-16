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
    notes: String(input.notes || '').trim()
  };
  // `active` is set only where the caller means to set it. The edit form does not carry the
  // flag, so defaulting it to TRUE on every save silently brought deactivated parts back the
  // next time anyone corrected a typo on one.
  if (input.active !== undefined) record.active = input.active === false ? 'FALSE' : 'TRUE';

  var isNew = !input.id;
  if (isNew) {
    if (record.active === undefined) record.active = 'TRUE';
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

/**
 * Soft delete: masters referenced by history are deactivated, never removed.
 *
 * The row keeps its place in the sheet so every quotation, order and stock movement that
 * names it still resolves; it simply stops being offered anywhere new work is entered.
 * Reversible through reactivateSpare — see the note there for why that matters.
 */
function deleteSpare(id, reason) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  updateRowById_('Spares', 'id', id, { active: 'FALSE' }, reason || 'Spare deactivated');
  return true;
}

/**
 * Puts a deactivated spare back into circulation.
 *
 * Deactivating was one-way: the row vanished from the catalogue, which lists active parts
 * only, and nothing offered a route back. On a 13,000-part catalogue a mis-click was
 * permanent from the screen's point of view, while the part number stayed taken — the
 * duplicate check reads every row, active or not — so it could not even be typed in again.
 */
function reactivateSpare(id, reason) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  updateRowById_('Spares', 'id', id, { active: 'TRUE' }, reason || 'Spare reactivated');
  return true;
}

/**
 * Removes a spare outright, for the case deactivation handles badly: a row typed in wrong.
 *
 * Deactivating a mistake leaves it in the sheet forever and keeps its part number reserved,
 * so the corrected row cannot reuse it. Deleting is only safe while nothing refers to the
 * part, and that is checked across every table that can name one rather than assumed — if
 * anything does, this refuses and says what, because deactivating is then the right answer.
 *
 * Its price history and compatibility rows go with it: neither means anything without the
 * part, and leaving them turns the next import into a mess of orphans.
 */
function purgeSpare(id) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);

  var spare = readTable_('Spares').filter(function (s) { return String(s.id) === String(id); })[0];
  if (!spare) throw new Error('That spare no longer exists.');

  var ids = {};
  ids[String(spare.id)] = spare.partNo;
  assertItemUnreferenced_('Spare', ids, 'Part ' + spare.partNo + ' is');

  var removed = removeSpareDependents_(ids);
  deleteRowById_('Spares', 'id', spare.id, 'Spare deleted — nothing referred to it');
  return { partNo: spare.partNo, prices: removed.prices, compatibility: removed.compatibility,
           alternates: removed.alternates };
}

/**
 * Clears the rows that only exist to describe a spare, for every id in `ids`.
 * Shared by the single delete and the whole-catalogue purge so the two cannot drift apart.
 */
function removeSpareDependents_(ids) {
  var prices = 0, compat = 0, alts = 0;

  readTable_('PriceList').forEach(function (r) {
    if (r.itemType === 'Spare' && ids.hasOwnProperty(String(r.itemId))) {
      deleteRowById_('PriceList', 'id', r.id, 'Removed with the spare');
      prices++;
    }
  });
  readTable_('SpareCompatibility').forEach(function (r) {
    if (ids.hasOwnProperty(String(r.spareId))) {
      deleteRowById_('SpareCompatibility', 'id', r.id, 'Removed with the spare');
      compat++;
    }
  });
  readTable_('SpareAlternates').forEach(function (r) {
    if (ids.hasOwnProperty(String(r.spareId))) {
      deleteRowById_('SpareAlternates', 'id', r.id, 'Removed with the spare');
      alts++;
    }
  });

  return { prices: prices, compatibility: compat, alternates: alts };
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
 * A part that no document refers to is deleted outright, with its prices, compatibility and
 * substitute rows, since none of those mean anything without the part. A part that some
 * quotation, order, dispatch or stock movement does refer to is **deactivated instead** —
 * deleting it would leave that document unable to say what it sold, and the row costs
 * nothing where it is.
 *
 * It used to refuse the whole job over a single referenced part, which is the wrong trade:
 * one demo quotation made from trial data blocked the load of a 13,000-part catalogue, and
 * the only way forward was to go and destroy real work first. Deactivating gets the same
 * end state — those parts are out of the catalogue and off every picker — without touching
 * anything anyone has quoted. The caller is told exactly which parts were kept and why.
 *
 * The reference check is the shared one in ItemReferences.gs. It used to be a local pair of
 * lookups here, one of which named a tab ("StockLedger") that does not exist in the schema —
 * so this threw on the missing tab every time it ran and never cleared a catalogue at all.
 */
function purgeSpares(confirmText) {
  var user = getCurrentUser();
  requireRole_(user, [ROLES.ERP_ADMIN]);

  if (String(confirmText).trim().toUpperCase() !== 'DELETE ALL SPARES') {
    throw new Error('Type DELETE ALL SPARES to confirm.');
  }

  var spares = readTable_('Spares');
  if (!spares.length) {
    return { deleted: 0, deactivated: 0, prices: 0, compatibility: 0, alternates: 0, kept: [] };
  }

  var ids = {};
  spares.forEach(function (s) { ids[String(s.id)] = s.partNo; });

  var referenced = itemReferenceMap_('Spare', ids);

  var removable = {};
  var kept = [];
  spares.forEach(function (s) {
    var id = String(s.id);
    if (referenced.hasOwnProperty(id)) {
      kept.push({ partNo: s.partNo, description: s.description, usedBy: referenced[id] });
    } else {
      removable[id] = s.partNo;
    }
  });

  var removed = removeSpareDependents_(removable);

  // Rewritten as one block rather than deleted row by row: on a catalogue this size, a
  // per-row delete does not finish inside an execution.
  var sheet = getSheet_('Spares');
  var headers = getHeaders_(sheet);
  var idCol = headers.indexOf('id');
  var activeCol = headers.indexOf('active');
  var lastRow = sheet.getLastRow();
  var block = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];

  var survivors = block.filter(function (row) {
    var id = String(row[idCol]);
    if (!referenced.hasOwnProperty(id)) return false;
    if (activeCol !== -1) row[activeCol] = 'FALSE';
    return true;
  });

  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  if (survivors.length) {
    sheet.getRange(2, 1, survivors.length, headers.length).setValues(survivors);
  }

  var deleted = spares.length - kept.length;
  audit_('Delete', 'Spares', '(bulk)', '', spares.length + ' spares', kept.length + ' kept',
    'Spare catalogue cleared before a bulk load — ' + deleted + ' deleted, ' +
    kept.length + ' deactivated because documents refer to them');

  return { deleted: deleted, deactivated: kept.length, prices: removed.prices,
           compatibility: removed.compatibility, alternates: removed.alternates,
           kept: kept.slice(0, 25), keptTotal: kept.length };
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

/**
 * The deeper clear-out: the trial spares *and* the documents built on them.
 *
 * The ordinary clear deactivates a part some document refers to, which is right when that
 * document matters. It is not right when the document is itself trial data — a seeded opening
 * stock row, or a quotation raised to try the screen out. Then the part stays in the sheet
 * forever on the strength of a record nobody wants either.
 *
 * So this removes both, and draws one hard line: anything that has reached a **commitment**
 * stops it. A sales order, a goods receipt, a dispatch or an invoice is a record of something
 * that actually happened, often with statutory weight, and no button labelled "clear the trial
 * data" gets to sweep those away. The same goes for a quotation that is past Draft, has an
 * order raised from it, or has been revised — the policy `discardQuotation` already applies,
 * for the same reason: the record of what was sent to a customer has to survive.
 *
 * It refuses as a whole rather than doing what it can. A half-applied clear-out leaves parts
 * whose documents are gone and documents whose parts are gone, which is worse than either.
 */
function planSparePurge() {
  var user = getCurrentUser();
  requireRole_(user, [ROLES.ERP_ADMIN]);

  var spares = readTable_('Spares');
  var ids = {};
  spares.forEach(function (s) { ids[String(s.id)] = s.partNo; });

  var isOurs = function (row) {
    return row.itemType === 'Spare' && ids.hasOwnProperty(String(row.itemId));
  };

  // Committed records: named, never removed.
  var blocked = [];
  var refuse = function (tab, label, parentField, parentTab, parentField2) {
    var hits = readTable_(tab).filter(isOurs);
    if (!hits.length) return;
    var names = {};
    if (parentTab) {
      readTable_(parentTab).forEach(function (r) { names[String(r.id)] = r[parentField2]; });
    }
    var shown = [];
    hits.forEach(function (h) {
      var n = label + ' ' + (names[String(h[parentField])] || h[parentField] || h.id);
      if (shown.indexOf(n) === -1) shown.push(n);
    });
    blocked = blocked.concat(shown);
  };
  refuse('SalesOrderItems', 'sales order', 'salesOrderId', 'SalesOrders', 'orderNo');
  refuse('GRNItems', 'goods receipt', 'grnId', 'GRNs', 'grnNo');
  refuse('DispatchItems', 'dispatch', 'dispatchId', 'Dispatches', 'dispatchNo');
  refuse('InvoiceItems', 'invoice', 'invoiceId', 'Invoices', 'invoiceNo');

  // Quotations that name one of these parts, with the discard policy applied to each.
  var quoteIds = {};
  readTable_('QuotationItems').forEach(function (i) {
    if (isOurs(i)) quoteIds[String(i.quotationId)] = true;
  });
  var allQuotes = readTable_('Quotations');
  var orderByQuote = {};
  readTable_('SalesOrders').forEach(function (o) { orderByQuote[String(o.quotationId)] = o.orderNo; });
  var revisionOf = {};
  allQuotes.forEach(function (q) {
    if (q.parentQuotationId) revisionOf[String(q.parentQuotationId)] = q.quoteNo + ' ' + q.revision;
  });

  var quotations = [];
  allQuotes.forEach(function (q) {
    if (!quoteIds[String(q.id)]) return;
    var why = '';
    if (String(q.locked).toUpperCase() === 'TRUE' || q.status !== 'Draft') {
      why = 'is ' + q.status + ', not a draft — mark it Lost instead, so the record of what ' +
        'was sent survives';
    } else if (orderByQuote[String(q.id)]) {
      why = 'has sales order ' + orderByQuote[String(q.id)] + ' raised from it';
    } else if (revisionOf[String(q.id)]) {
      why = 'was revised as ' + revisionOf[String(q.id)];
    }
    if (why) blocked.push('quotation ' + q.quoteNo + ' ' + why);
    else quotations.push({ id: q.id, quoteNo: q.quoteNo, status: q.status });
  });

  // Enquiries are working notes, not commitments, so the lines simply go.
  var enquiryLines = readTable_('SpareEnquiryItems').filter(function (i) {
    return ids.hasOwnProperty(String(i.spareId));
  });

  return {
    spares: spares.length,
    stockMovements: readTable_('StockMovements').filter(isOurs).length,
    reservations: readTable_('StockReservations').filter(isOurs).length,
    quotations: quotations,
    enquiryLines: enquiryLines.length,
    blocked: blocked
  };
}

/** Applies the plan above. Same confirmation discipline, one step further. */
function purgeSparesWithDocuments(confirmText) {
  var user = getCurrentUser();
  requireRole_(user, [ROLES.ERP_ADMIN]);

  if (String(confirmText).trim().toUpperCase() !== 'DELETE SPARES AND DOCUMENTS') {
    throw new Error('Type DELETE SPARES AND DOCUMENTS to confirm.');
  }

  var plan = planSparePurge();
  if (plan.blocked.length) {
    throw new Error('This would have to remove ' + plan.blocked.length +
      ' committed record(s), which it will not do — ' + plan.blocked.slice(0, 4).join(', ') +
      (plan.blocked.length > 4 ? ', and others' : '') +
      '. Those are records of what actually happened. Use Clear Spare Catalogue instead: the ' +
      'parts they name are deactivated rather than deleted, and everything else still goes.');
  }
  if (!plan.spares) return { deleted: 0, quotations: [], stockMovements: 0, reservations: 0,
                             enquiryLines: 0, prices: 0, compatibility: 0, alternates: 0 };

  var ids = {};
  readTable_('Spares').forEach(function (s) { ids[String(s.id)] = s.partNo; });
  var isOurs = function (row) {
    return row.itemType === 'Spare' && ids.hasOwnProperty(String(row.itemId));
  };

  // Documents first: while the parts still exist, so an interrupted run leaves lines whose
  // part resolves rather than lines pointing at nothing.
  var discarded = [];
  plan.quotations.forEach(function (q) {
    var res = discardQuotation(q.id);
    discarded.push(res.quoteNo);
  });

  var enquiryLines = deleteRowsWhere_('SpareEnquiryItems', function (r) {
    return ids.hasOwnProperty(String(r.spareId));
  }, 'Enquiry line removed with the trial spare catalogue');

  var movements = deleteRowsWhere_('StockMovements', isOurs,
    'Stock movement removed with the trial spare catalogue');
  var reservations = deleteRowsWhere_('StockReservations', isOurs,
    'Reservation removed with the trial spare catalogue');

  var removed = removeSpareDependents_(ids);

  var sheet = getSheet_('Spares');
  var headers = getHeaders_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();

  var count = Object.keys(ids).length;
  audit_('Delete', 'Spares', '(all)', '', count + ' spares', '',
    'Spare catalogue and the documents built on it cleared by ' + user.email);

  return { deleted: count, quotations: discarded, stockMovements: movements,
           reservations: reservations, enquiryLines: enquiryLines, prices: removed.prices,
           compatibility: removed.compatibility, alternates: removed.alternates };
}
