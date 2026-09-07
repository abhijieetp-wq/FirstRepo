/**
 * Quotations — FR-018, FR-019, FR-020.
 *
 * Shared by both business streams: a quotation can carry spare lines, compressor lines, or
 * both. Spare quotations start from an enquiry and inherit its identified parts; compressor
 * quotations will start from an opportunity when that module lands. The item table is
 * deliberately stream-agnostic (`itemType` = Spare | Product) so neither stream needs its own
 * quotation engine.
 *
 * Pricing: lines are priced from the ELGI (selling) price effective on the quotation's date,
 * and it is carried on the line as `unitPrice`. Nothing here exposes the internal price-level
 * naming — to the user and to the customer it is simply the price.
 *
 * Revision control (FR-019): an approved or submitted quotation is locked. Changing it
 * creates R1, R2 … as a new row that points back at the original through `parentQuotationId`,
 * so the version the customer received stays exactly as it was sent.
 */

var QUOTE_EDITORS = [ROLES.SALES_COORDINATOR, ROLES.SALES_ENGINEER, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/** Statuses after which the quotation is frozen and further edits fork a revision. */
var LOCKED_QUOTE_STATUSES = ['Approved', 'Submitted', 'Won', 'Lost', 'Expired'];

function listQuotations(options) {
  var user = getCurrentUser();
  var opts = options || {};

  var itemsByQuote = {};
  readTable_('QuotationItems').forEach(function (i) {
    var key = String(i.quotationId);
    (itemsByQuote[key] = itemsByQuote[key] || []).push(stripRow_(i));
  });

  var customerNames = {};
  readTable_('Customers').forEach(function (c) { customerNames[String(c.id)] = c.name; });

  var rows = readTable_('Quotations').map(function (q) {
    var row = stripRow_(q);
    row.items = (itemsByQuote[String(row.id)] || []).sort(function (a, b) {
      return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0);
    });
    row.itemCount = row.items.length;
    row.customerName = customerNames[String(row.customerId)] || '';
    row.locked = String(row.locked).toUpperCase() === 'TRUE';
    row.expired = row.validUntil && String(row.validUntil) < todayIso_() &&
      ['Won', 'Lost'].indexOf(row.status) === -1;
    return row;
  });

  if (opts.mineOnly) {
    rows = rows.filter(function (r) { return String(r.preparedBy).toLowerCase() === user.email.toLowerCase(); });
  }
  if (!opts.includeClosed) {
    rows = rows.filter(function (r) { return ['Won', 'Lost', 'Expired'].indexOf(r.status) === -1; });
  }
  if (opts.businessStream) {
    rows = rows.filter(function (r) { return r.businessStream === opts.businessStream; });
  }

  return rows.sort(function (a, b) {
    return String(b.date + b.quoteNo).localeCompare(String(a.date + a.quoteNo));
  });
}

/**
 * Creates a spare quotation from an enquiry, carrying its identified parts across and
 * pricing each at today's selling price (FR-026 — the fast spare quote).
 */
function createQuotationFromEnquiry(spareEnquiryId) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);

  var enquiry = readTable_('SpareEnquiries').filter(function (e) {
    return String(e.id) === String(spareEnquiryId);
  })[0];
  if (!enquiry) throw new Error('That enquiry no longer exists.');

  var items = readTable_('SpareEnquiryItems')
    .filter(function (i) { return String(i.spareEnquiryId) === String(spareEnquiryId); })
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); });
  if (!items.length) {
    throw new Error('Identify at least one part on the enquiry before quoting it.');
  }

  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(enquiry.customerId);
  })[0];

  var addresses = readTable_('CustomerAddresses').filter(function (a) {
    return String(a.customerId) === String(enquiry.customerId) &&
      String(a.active).toUpperCase() !== 'FALSE';
  });
  var billing = addresses.filter(function (a) {
    return a.addressType === 'Billing' && String(a.isDefault).toUpperCase() === 'TRUE';
  })[0] || addresses.filter(function (a) { return a.addressType === 'Billing'; })[0];
  var shipping = addresses.filter(function (a) {
    return a.addressType === 'Shipping' && String(a.isDefault).toUpperCase() === 'TRUE';
  })[0] || billing;

  var contacts = readTable_('CustomerContacts').filter(function (c) {
    return String(c.customerId) === String(enquiry.customerId) &&
      String(c.active).toUpperCase() !== 'FALSE';
  });
  var primary = contacts.filter(function (c) {
    return String(c.isPrimary).toUpperCase() === 'TRUE';
  })[0] || contacts[0];

  var quote = {
    id: generateId_('QT-'),
    quoteNo: nextQuoteNo_(),
    revision: 'R0',
    parentQuotationId: '',
    date: todayIso_(),
    businessStream: 'Spare Sales',
    brand: 'ELGI',
    customerId: enquiry.customerId,
    contactId: primary ? primary.id : '',
    billingAddressId: billing ? billing.id : '',
    shippingAddressId: shipping ? shipping.id : '',
    opportunityId: '',
    spareEnquiryId: spareEnquiryId,
    machineModel: enquiry.productModel,
    serialNo: enquiry.serialNo,
    preparedBy: user.email,
    validityDays: 7,
    validUntil: addDays_(todayIso_(), 7),
    status: 'Draft',
    paymentTerms: customer ? (customer.paymentTerms || '') : '',
    deliveryTerms: '',
    warrantyTerms: '',
    notes: '',
    locked: 'FALSE',
    createdAt: todayIso_(),
    createdBy: user.email
  };
  appendRow_('Quotations', quote, 'Quotation created from enquiry ' + (enquiry.enquiryNo || ''));

  var prices = priceMapFor_('Spare', quote.date);
  var spareById = {};
  readTable_('Spares').forEach(function (s) { spareById[String(s.id)] = s; });

  items.forEach(function (item, idx) {
    var spare = spareById[String(item.spareId)] || {};
    var level = prices[String(item.spareId)] || {};
    var unitPrice = level[SELLING_PRICE_LEVEL] ? level[SELLING_PRICE_LEVEL].price : 0;
    var qty = Number(item.qty) || 1;
    var taxPct = spare.gstPct === '' || spare.gstPct === undefined ? 18 : Number(spare.gstPct);

    appendRow_('QuotationItems', {
      id: generateId_('QI-'),
      quotationId: quote.id,
      lineNo: idx + 1,
      itemType: 'Spare',
      itemId: item.spareId,
      itemCode: item.partNo,
      description: item.description,
      qty: qty,
      uom: spare.uom || 'Nos',
      listPrice: unitPrice,
      rateType: 'Standard',
      unitPrice: unitPrice,
      discountPct: 0,
      taxPct: taxPct,
      lineTotal: roundMoney_(unitPrice * qty),
      availabilityNote: item.availabilityNote || '',
      leadTimeDays: ''
    }, 'Line carried over from the enquiry');
  });

  recalcQuotation_(quote.id);
  updateRowById_('SpareEnquiries', 'id', spareEnquiryId, { status: 'Quoted' },
    'Quotation ' + quote.quoteNo + ' raised');
  return getQuotation(quote.id);
}

function getQuotation(id) {
  getCurrentUser();
  var q = readTable_('Quotations').filter(function (r) { return String(r.id) === String(id); })[0];
  if (!q) throw new Error('Quotation not found.');
  var row = stripRow_(q);
  row.items = readTable_('QuotationItems')
    .filter(function (i) { return String(i.quotationId) === String(id); })
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); })
    .map(stripRow_);
  row.locked = String(row.locked).toUpperCase() === 'TRUE';

  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(row.customerId);
  })[0];
  row.customerName = customer ? customer.name : '';
  row.customerGstin = customer ? customer.gstin : '';
  return row;
}

/** Header edits. Refuses to touch a locked quotation — revise it instead. */
function saveQuotationHeader(input) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);
  var existing = requireUnlockedQuote_(input.id);

  var validityDays = Number(input.validityDays);
  if (isNaN(validityDays) || validityDays <= 0) validityDays = Number(existing.validityDays) || 7;

  updateRowById_('Quotations', 'id', input.id, {
    date: String(input.date || existing.date).slice(0, 10),
    validityDays: validityDays,
    validUntil: addDays_(String(input.date || existing.date).slice(0, 10), validityDays),
    paymentTerms: String(input.paymentTerms || '').trim(),
    deliveryTerms: String(input.deliveryTerms || '').trim(),
    warrantyTerms: String(input.warrantyTerms || '').trim(),
    machineModel: String(input.machineModel || '').trim(),
    serialNo: String(input.serialNo || '').trim(),
    notes: String(input.notes || '').trim()
  }, 'Quotation header updated');

  return getQuotation(input.id);
}

/**
 * Adds or updates a line. `unitPrice` defaults to the item's selling price on the quotation
 * date, so a coordinator never has to look a price up, but it can be overridden — with the
 * discount that implies recorded explicitly rather than buried in a changed number.
 */
function saveQuotationItem(input) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);
  var quote = requireUnlockedQuote_(input.quotationId);

  var itemType = String(input.itemType || 'Spare').trim();
  if (['Spare', 'Product'].indexOf(itemType) === -1) throw new Error('itemType must be Spare or Product.');
  var qty = Number(input.qty);
  if (isNaN(qty) || qty <= 0) throw new Error('Quantity must be greater than zero.');

  var discountPct = Number(input.discountPct) || 0;
  if (discountPct < 0 || discountPct > 100) throw new Error('Discount must be between 0 and 100.');

  var master = masterRecordFor_(itemType, input.itemId);
  var effective = getEffectivePrice_(itemType, String(input.itemId), SELLING_PRICE_LEVEL, quote.date);
  var listPrice = effective ? effective.price : 0;
  var unitPrice = (input.unitPrice === '' || input.unitPrice === undefined || input.unitPrice === null)
    ? listPrice : Number(input.unitPrice);
  if (isNaN(unitPrice) || unitPrice < 0) throw new Error('The price must be a number.');

  var taxPct = input.taxPct === '' || input.taxPct === undefined || input.taxPct === null
    ? (master && master.gstPct !== '' ? Number(master.gstPct) : 18)
    : Number(input.taxPct);

  var net = unitPrice * (1 - discountPct / 100);
  var existingLines = readTable_('QuotationItems').filter(function (i) {
    return String(i.quotationId) === String(input.quotationId);
  });

  var record = {
    quotationId: String(input.quotationId),
    lineNo: input.id ? Number(input.lineNo) : existingLines.length + 1,
    itemType: itemType,
    itemId: String(input.itemId || '').trim(),
    itemCode: String(input.itemCode || (master ? (master.partNo || master.productCode) : '')).trim(),
    description: String(input.description || (master ? (master.description || master.model) : '')).trim(),
    qty: qty,
    uom: String(input.uom || (master ? master.uom : 'Nos') || 'Nos').trim(),
    listPrice: listPrice,
    rateType: discountPct > 0 ? 'Discounted' : 'Standard',
    unitPrice: unitPrice,
    discountPct: discountPct,
    taxPct: taxPct,
    lineTotal: roundMoney_(net * qty),
    availabilityNote: String(input.availabilityNote || '').trim(),
    leadTimeDays: input.leadTimeDays === '' || input.leadTimeDays === undefined ? '' : Number(input.leadTimeDays)
  };

  if (input.id) {
    record.id = input.id;
    updateRowById_('QuotationItems', 'id', input.id, record, 'Quotation line updated');
  } else {
    record.id = generateId_('QI-');
    appendRow_('QuotationItems', record, 'Quotation line added');
  }

  recalcQuotation_(input.quotationId);
  return getQuotation(input.quotationId);
}

function deleteQuotationItem(id) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);
  var line = readTable_('QuotationItems').filter(function (i) { return String(i.id) === String(id); })[0];
  if (!line) throw new Error('That line no longer exists.');
  requireUnlockedQuote_(line.quotationId);

  deleteRowById_('QuotationItems', 'id', id, 'Quotation line removed');
  renumberQuotationLines_(line.quotationId);
  recalcQuotation_(line.quotationId);
  return getQuotation(line.quotationId);
}

/**
 * Moves a quotation through its status list (FR-020). Reaching a locked status freezes it,
 * which is what makes revision control meaningful: what the customer received cannot then
 * be edited underneath them.
 */
function setQuotationStatus(id, status, lostReasonId) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);
  if (QUOTATION_STATUSES.indexOf(status) === -1) {
    throw new Error('Status must be one of: ' + QUOTATION_STATUSES.join(', ') + '.');
  }

  var quote = readTable_('Quotations').filter(function (q) { return String(q.id) === String(id); })[0];
  if (!quote) throw new Error('Quotation not found.');
  if (status === 'Lost' && !String(lostReasonId || '').trim()) {
    throw new Error('Pick a lost reason before marking this quotation Lost.');
  }
  if (status !== 'Draft' && !readTable_('QuotationItems').some(function (i) {
    return String(i.quotationId) === String(id);
  })) {
    throw new Error('A quotation needs at least one line before it can leave Draft.');
  }

  var patch = { status: status, locked: LOCKED_QUOTE_STATUSES.indexOf(status) !== -1 ? 'TRUE' : 'FALSE' };
  if (status === 'Approved') { patch.approvedBy = user.email; patch.approvalDate = todayIso_(); }
  if (status === 'Submitted') patch.submittedDate = todayIso_();
  if (status === 'Lost') patch.lostReasonId = lostReasonId;

  updateRowById_('Quotations', 'id', id, patch, 'Status set to ' + status);

  // Keep the originating enquiry in step, so the desk sees one truth.
  if (quote.spareEnquiryId && ['Won', 'Lost'].indexOf(status) !== -1) {
    updateRowById_('SpareEnquiries', 'id', quote.spareEnquiryId,
      status === 'Lost' ? { status: 'Lost', lostReasonId: lostReasonId } : { status: 'Won' },
      'Quotation ' + quote.quoteNo + ' marked ' + status);
  }
  return getQuotation(id);
}

/**
 * Forks a locked quotation into the next revision (FR-019). The original keeps its number
 * and content and is marked Revised; the copy becomes R1, R2 … and is editable.
 */
function reviseQuotation(id) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);

  var source = readTable_('Quotations').filter(function (q) { return String(q.id) === String(id); })[0];
  if (!source) throw new Error('Quotation not found.');

  var rootId = source.parentQuotationId || source.id;
  var siblings = readTable_('Quotations').filter(function (q) {
    return String(q.parentQuotationId) === String(rootId) || String(q.id) === String(rootId);
  });
  var nextRevision = 'R' + siblings.length;

  var copy = stripRow_(source);
  copy.id = generateId_('QT-');
  copy.revision = nextRevision;
  copy.parentQuotationId = rootId;
  copy.date = todayIso_();
  copy.validUntil = addDays_(todayIso_(), Number(source.validityDays) || 7);
  copy.status = 'Draft';
  copy.locked = 'FALSE';
  copy.approvedBy = '';
  copy.approvalDate = '';
  copy.submittedDate = '';
  copy.emailSentDate = '';
  copy.lostReasonId = '';
  copy.preparedBy = user.email;
  copy.createdAt = todayIso_();
  copy.createdBy = user.email;
  appendRow_('Quotations', copy, 'Revision ' + nextRevision + ' of ' + source.quoteNo);

  readTable_('QuotationItems')
    .filter(function (i) { return String(i.quotationId) === String(id); })
    .forEach(function (i) {
      var line = stripRow_(i);
      line.id = generateId_('QI-');
      line.quotationId = copy.id;
      appendRow_('QuotationItems', line, 'Line copied into ' + nextRevision);
    });

  updateRowById_('Quotations', 'id', id, { status: 'Revised' },
    'Superseded by revision ' + nextRevision);
  recalcQuotation_(copy.id);
  return getQuotation(copy.id);
}

// ------------------------------------------------------------------ internals

/** Totals are always recomputed from the lines — never accumulated or hand-edited. */
function recalcQuotation_(quotationId) {
  var lines = readTable_('QuotationItems').filter(function (i) {
    return String(i.quotationId) === String(quotationId);
  });

  var subtotal = 0, discountAmt = 0, taxAmt = 0;
  lines.forEach(function (l) {
    var qty = Number(l.qty) || 0;
    var unit = Number(l.unitPrice) || 0;
    var disc = Number(l.discountPct) || 0;
    var gross = unit * qty;
    var net = Number(l.lineTotal) || 0;
    subtotal += gross;
    discountAmt += gross - net;
    taxAmt += net * (Number(l.taxPct) || 0) / 100;
  });

  var quote = readTable_('Quotations').filter(function (q) {
    return String(q.id) === String(quotationId);
  })[0];
  var freight = quote ? (Number(quote.freight) || 0) : 0;
  var grand = subtotal - discountAmt + taxAmt + freight;

  updateRowById_('Quotations', 'id', quotationId, {
    subtotal: roundMoney_(subtotal),
    discountAmt: roundMoney_(discountAmt),
    taxAmt: roundMoney_(taxAmt),
    grand: roundMoney_(grand)
  }, 'Totals recalculated');
}

function requireUnlockedQuote_(quotationId) {
  var quote = readTable_('Quotations').filter(function (q) {
    return String(q.id) === String(quotationId);
  })[0];
  if (!quote) throw new Error('Quotation not found.');
  if (String(quote.locked).toUpperCase() === 'TRUE') {
    throw new Error('Quotation ' + quote.quoteNo + ' ' + quote.revision + ' is ' + quote.status +
      ' and cannot be edited. Use "Revise" to create the next revision.');
  }
  return quote;
}

function renumberQuotationLines_(quotationId) {
  readTable_('QuotationItems')
    .filter(function (i) { return String(i.quotationId) === String(quotationId); })
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); })
    .forEach(function (line, idx) {
      if (Number(line.lineNo) !== idx + 1) {
        updateRowById_('QuotationItems', 'id', line.id, { lineNo: idx + 1 }, 'Lines renumbered');
      }
    });
}

function masterRecordFor_(itemType, itemId) {
  var tab = itemType === 'Product' ? 'Products' : 'Spares';
  return readTable_(tab).filter(function (r) { return String(r.id) === String(itemId); })[0] || null;
}

function nextQuoteNo_() {
  var yy = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyMM');
  var prefix = 'QT' + yy + '-';
  var highest = 0;
  readTable_('Quotations').forEach(function (q) {
    var m = new RegExp('^' + prefix + '(\\d+)$').exec(String(q.quoteNo || '').trim());
    if (m) highest = Math.max(highest, Number(m[1]));
  });
  return prefix + String(highest + 1).padStart(3, '0');
}

function addDays_(isoDate, days) {
  var parts = String(isoDate).slice(0, 10).split('-');
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  d.setDate(d.getDate() + Number(days));
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd');
}

function roundMoney_(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
