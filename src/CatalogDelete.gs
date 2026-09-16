/**
 * Removing a set of catalogue rows, together with whatever is holding them there.
 *
 * The single-row delete refuses the moment anything points at a part, and says to deactivate
 * instead. That is the right answer for a part with history. It is the wrong answer for trial
 * data, where the thing pointing at it is a seeded opening-stock row or a quotation raised to
 * try the screen out — and it is not even a workable answer, because a stock movement cannot
 * be removed from any screen in the app. So a row blocked by one could never be deleted at
 * all, whatever it was.
 *
 * This works on a selection rather than on the whole tab, which matters once a real catalogue
 * has been loaded: the trial compressors and the 70 real ones live side by side, and "clear
 * the product catalogue" would take both.
 *
 * Two passes, always in this order:
 *   1. plan  — read-only, says what would go and what stands in the way
 *   2. apply — deletes what the plan described, and nothing else
 *
 * The line it will not cross is a commitment: a sales order, goods receipt, dispatch or
 * invoice is a record of something that actually happened, often with statutory weight. Nor a
 * quotation past Draft, one with an order raised from it, or one that has been revised — the
 * policy discardQuotation already applies. It refuses as a whole rather than doing what it
 * can, because a half-applied delete leaves rows whose documents are gone and documents whose
 * rows are gone.
 */

/** Tab and key field for each kind of catalogue row. */
function catalogSpec_(itemType) {
  if (itemType === 'Spare') return { tab: 'Spares', code: 'partNo', label: 'spare' };
  if (itemType === 'Product') return { tab: 'Products', code: 'productCode', label: 'compressor' };
  throw new Error('itemType must be Spare or Product.');
}

/**
 * What deleting these rows would take with it, and what stops it.
 *
 * Returns the selection split three ways: `free` can go on its own, `withDocuments` can go
 * once the documents naming it go too, and `blocked` cannot go at all. Nothing is written.
 */
function planCatalogDelete(itemType, ids) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  var spec = catalogSpec_(itemType);

  var wanted = {};
  (ids || []).forEach(function (id) { wanted[String(id)] = true; });
  if (!Object.keys(wanted).length) throw new Error('Nothing is selected.');

  var codes = {};
  readTable_(spec.tab).forEach(function (row) {
    if (wanted[String(row.id)]) codes[String(row.id)] = row[spec.code];
  });
  var missing = Object.keys(wanted).filter(function (id) { return !codes.hasOwnProperty(id); });
  if (missing.length) {
    throw new Error(missing.length + ' of the selected rows no longer exist. Reload the ' +
      'catalogue and try again.');
  }

  var refs = itemReferenceMap_(itemType, codes);

  // Which documents this is willing to remove, and which it never is.
  var removable = { 'stock movement': true, 'reservation on order': true, 'enquiry': true };
  var quoteState = quotationStatesFor_(itemType, codes);

  var free = [], withDocs = [], blocked = [];
  Object.keys(codes).forEach(function (id) {
    var mine = refs[id] || [];
    if (!mine.length) { free.push({ id: id, code: codes[id] }); return; }

    var stoppers = [];
    mine.forEach(function (phrase) {
      var kind = phrase.split(' ').slice(0, 2).join(' ');
      if (removable[phrase] || removable[kind] || /^stock movement/.test(phrase)) return;
      if (/^quotation /.test(phrase)) {
        var no = phrase.replace(/^quotation /, '');
        var why = quoteState[no];
        if (why) stoppers.push('quotation ' + no + ' ' + why);
        return;                       // a discardable draft: not a stopper
      }
      stoppers.push(phrase);
    });

    if (stoppers.length) blocked.push({ id: id, code: codes[id], why: stoppers });
    else withDocs.push({ id: id, code: codes[id], usedBy: mine });
  });

  return { itemType: itemType, label: spec.label, free: free, withDocuments: withDocs,
           blocked: blocked, total: Object.keys(codes).length };
}

/**
 * For every quotation naming one of these rows, why it could not be discarded — or nothing,
 * when it could. Same rules as discardQuotation, read here so the plan can show them all at
 * once instead of one refusal at a time.
 */
function quotationStatesFor_(itemType, codes) {
  var quoteIds = {};
  readTable_('QuotationItems').forEach(function (i) {
    if (i.itemType === itemType && codes.hasOwnProperty(String(i.itemId))) {
      quoteIds[String(i.quotationId)] = true;
    }
  });

  var quotes = readTable_('Quotations');
  var orderByQuote = {};
  readTable_('SalesOrders').forEach(function (o) { orderByQuote[String(o.quotationId)] = o.orderNo; });
  var revisionOf = {};
  quotes.forEach(function (q) {
    if (q.parentQuotationId) revisionOf[String(q.parentQuotationId)] = q.quoteNo + ' ' + q.revision;
  });

  var out = {};
  quotes.forEach(function (q) {
    if (!quoteIds[String(q.id)]) return;
    if (String(q.locked).toUpperCase() === 'TRUE' || q.status !== 'Draft') {
      out[q.quoteNo] = 'is ' + q.status + ', not a draft — reopen it as a draft first, or ' +
        'mark it Lost so the record of what was sent survives';
    } else if (orderByQuote[String(q.id)]) {
      out[q.quoteNo] = 'has sales order ' + orderByQuote[String(q.id)] + ' raised from it';
    } else if (revisionOf[String(q.id)]) {
      out[q.quoteNo] = 'was revised as ' + revisionOf[String(q.id)];
    }
  });
  return out;
}

/**
 * Applies the plan. `withDocuments` false deletes only the rows nothing refers to.
 *
 * The confirmation is the number of rows being deleted, typed out, because the count is the
 * one thing a person can check against what they selected.
 */
function deleteCatalogItems(itemType, ids, withDocuments, confirmText) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  var spec = catalogSpec_(itemType);

  var plan = planCatalogDelete(itemType, ids);
  var going = withDocuments ? plan.free.concat(plan.withDocuments) : plan.free;

  if (plan.blocked.length) {
    var first = plan.blocked[0];
    throw new Error(plan.blocked.length + ' of the selected rows cannot be deleted — for ' +
      'example ' + first.code + ', because ' + first.why.slice(0, 2).join(' and ') +
      '. Clear those first, or deselect them. Nothing was deleted.');
  }
  if (!going.length) throw new Error('Nothing in the selection can be deleted on its own.');
  if (String(confirmText).trim() !== String(going.length)) {
    throw new Error('Type ' + going.length + ' to confirm.');
  }

  var codes = {};
  going.forEach(function (g) { codes[String(g.id)] = g.code; });

  // Documents first, while the rows still exist, so an interrupted run leaves lines whose
  // item resolves rather than lines pointing at nothing.
  var quotations = [];
  if (withDocuments) {
    var quoteIds = {};
    readTable_('QuotationItems').forEach(function (i) {
      if (i.itemType === itemType && codes.hasOwnProperty(String(i.itemId))) {
        quoteIds[String(i.quotationId)] = true;
      }
    });
    Object.keys(quoteIds).forEach(function (qid) {
      quotations.push(discardQuotation(qid).quoteNo);
    });
  }

  var isMine = function (row) {
    return row.itemType === itemType && codes.hasOwnProperty(String(row.itemId));
  };
  var movements = 0, reservations = 0, enquiryLines = 0;
  if (withDocuments) {
    movements = deleteRowsWhere_('StockMovements', isMine,
      'Stock movement removed with the ' + spec.label + ' it referred to');
    reservations = deleteRowsWhere_('StockReservations', isMine,
      'Reservation removed with the ' + spec.label + ' it referred to');
    if (itemType === 'Spare') {
      enquiryLines = deleteRowsWhere_('SpareEnquiryItems', function (r) {
        return codes.hasOwnProperty(String(r.spareId));
      }, 'Enquiry line removed with the spare it referred to');
    }
  }

  var prices = deleteRowsWhere_('PriceList', function (r) {
    return r.itemType === itemType && codes.hasOwnProperty(String(r.itemId));
  }, 'Price removed with the ' + spec.label);

  var compat = deleteRowsWhere_('SpareCompatibility', function (r) {
    return codes.hasOwnProperty(String(itemType === 'Spare' ? r.spareId : r.productId));
  }, 'Compatibility row removed with the ' + spec.label);

  var alternates = itemType === 'Spare'
    ? deleteRowsWhere_('SpareAlternates', function (r) {
        return codes.hasOwnProperty(String(r.spareId)) ||
               codes.hasOwnProperty(String(r.alternateSpareId));
      }, 'Substitute link removed with the spare')
    : 0;

  var removed = deleteRowsWhere_(spec.tab, function (r) {
    return codes.hasOwnProperty(String(r.id));
  }, 'Deleted from the catalogue by ' + user.email);

  return { deleted: removed, codes: going.map(function (g) { return g.code; }).slice(0, 25),
           prices: prices, compatibility: compat, alternates: alternates,
           stockMovements: movements, reservations: reservations, enquiryLines: enquiryLines,
           quotations: quotations };
}
