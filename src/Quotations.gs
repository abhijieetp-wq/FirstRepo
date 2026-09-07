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
/**
 * Starts a quotation from nothing but a customer.
 *
 * The two existing creators both need something to come from — an enquiry with identified
 * parts, or an opportunity with a technical requirement. That is the right default, because a
 * quote traceable to what the customer actually asked for is a better quote. But it left the
 * New Quotation screen unable to create a new quotation, which is an odd thing for a screen of
 * that name to be unable to do: a walk-in asking for two filters has no enquiry behind it, and
 * making someone log one first is ceremony, not control.
 *
 * Lines are added afterwards from the catalog, exactly as on any other quotation.
 */
function createBlankQuotation(input) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);

  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(input.customerId);
  })[0];
  if (!customer) throw new Error('Pick the customer this quotation is for.');

  var stream = BUSINESS_STREAMS.indexOf(input.businessStream) !== -1
    ? input.businessStream : STREAM_SPARE;

  var addresses = readTable_('CustomerAddresses').filter(function (a) {
    return String(a.customerId) === String(customer.id) &&
      String(a.active).toUpperCase() !== 'FALSE';
  });
  var billing = addresses.filter(function (a) {
    return a.addressType === 'Billing' && String(a.isDefault).toUpperCase() === 'TRUE';
  })[0] || addresses.filter(function (a) { return a.addressType === 'Billing'; })[0];
  var shipping = addresses.filter(function (a) {
    return a.addressType === 'Shipping' && String(a.isDefault).toUpperCase() === 'TRUE';
  })[0] || billing;

  var contacts = readTable_('CustomerContacts').filter(function (c) {
    return String(c.customerId) === String(customer.id) &&
      String(c.active).toUpperCase() !== 'FALSE';
  });
  var primary = contacts.filter(function (c) {
    return String(c.isPrimary).toUpperCase() === 'TRUE';
  })[0] || contacts[0];

  var validity = Number(input.validityDays) > 0 ? Number(input.validityDays) : 7;

  var quote = {
    id: generateId_('QT-'),
    quoteNo: nextQuoteNo_(),
    revision: 'R0',
    parentQuotationId: '',
    date: todayIso_(),
    businessStream: stream,
    brand: 'ELGI',
    customerId: customer.id,
    contactId: primary ? primary.id : '',
    billingAddressId: billing ? billing.id : '',
    shippingAddressId: shipping ? shipping.id : '',
    opportunityId: '',
    spareEnquiryId: '',
    machineModel: String(input.machineModel || '').trim(),
    serialNo: String(input.serialNo || '').trim(),
    preparedBy: user.email,
    validityDays: validity,
    validUntil: addDays_(todayIso_(), validity),
    status: 'Draft',
    paymentTerms: customer.paymentTerms || '',
    deliveryTerms: '',
    warrantyTerms: '',
    notes: String(input.notes || '').trim(),
    locked: 'FALSE',
    createdAt: todayIso_(),
    createdBy: user.email
  };
  appendRow_('Quotations', quote, 'Blank quotation started for ' + customer.name);
  return getQuotation(quote.id);
}

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
    businessStream: STREAM_SPARE,
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

  // Keep whatever the quotation came from in step, so there is one truth to read.
  if (['Won', 'Lost'].indexOf(status) !== -1) {
    if (quote.spareEnquiryId) {
      updateRowById_('SpareEnquiries', 'id', quote.spareEnquiryId,
        status === 'Lost' ? { status: 'Lost', lostReasonId: lostReasonId } : { status: 'Won' },
        'Quotation ' + quote.quoteNo + ' marked ' + status);
    }
    if (quote.opportunityId) {
      updateRowById_('Opportunities', 'id', quote.opportunityId,
        status === 'Lost'
          ? { stage: 'Lost', probability: 0, lostReasonId: lostReasonId }
          : { stage: 'Won', probability: 100 },
        'Quotation ' + quote.quoteNo + ' marked ' + status);
    }
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

/**
 * Creates a compressor quotation from an opportunity, seeded with the selected machine and
 * its accessories.
 *
 * FR-009's control is enforced here rather than left to discipline: without a captured
 * technical requirement there is nothing to size the machine against, so the quotation is
 * refused. That is the difference between a spec and a safeguard.
 */
function createQuotationFromOpportunity(opportunityId) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);

  var opportunity = readTable_('Opportunities').filter(function (o) {
    return String(o.id) === String(opportunityId);
  })[0];
  if (!opportunity) throw new Error('That opportunity no longer exists.');

  var tech = readTable_('TechnicalRequirements').filter(function (t) {
    return String(t.opportunityId) === String(opportunityId);
  })[0];
  if (!tech) {
    throw new Error('Capture the technical requirement first — application, required FAD and ' +
      'working pressure — so the machine is sized against something real.');
  }

  var selections = readTable_('CompressorSelections').filter(function (c) {
    return String(c.opportunityId) === String(opportunityId);
  });
  if (!selections.length) {
    throw new Error('Select the recommended compressor before quoting.');
  }

  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(opportunity.customerId);
  })[0];

  var addresses = readTable_('CustomerAddresses').filter(function (a) {
    return String(a.customerId) === String(opportunity.customerId) &&
      String(a.active).toUpperCase() !== 'FALSE';
  });
  var billing = addresses.filter(function (a) {
    return a.addressType === 'Billing' && String(a.isDefault).toUpperCase() === 'TRUE';
  })[0] || addresses.filter(function (a) { return a.addressType === 'Billing'; })[0];
  var shipping = addresses.filter(function (a) {
    return a.addressType === 'Shipping' && String(a.isDefault).toUpperCase() === 'TRUE';
  })[0] || billing;

  var contacts = readTable_('CustomerContacts').filter(function (c) {
    return String(c.customerId) === String(opportunity.customerId) &&
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
    businessStream: STREAM_COMPRESSOR,
    brand: 'ELGI',
    customerId: opportunity.customerId,
    contactId: primary ? primary.id : '',
    billingAddressId: billing ? billing.id : '',
    shippingAddressId: shipping ? shipping.id : '',
    opportunityId: opportunityId,
    spareEnquiryId: '',
    machineModel: '',
    serialNo: '',
    preparedBy: user.email,
    validityDays: 30,
    validUntil: addDays_(todayIso_(), 30),
    status: 'Draft',
    paymentTerms: customer ? (customer.paymentTerms || '') : '',
    deliveryTerms: '',
    warrantyTerms: '',
    notes: 'Application: ' + tech.application + ' · FAD ' + tech.requiredFad +
      ' · ' + tech.workingPressure,
    locked: 'FALSE',
    createdAt: todayIso_(),
    createdBy: user.email
  };
  appendRow_('Quotations', quote, 'Quotation created from opportunity ' + opportunity.opportunityNo);

  var prices = priceMapFor_('Product', quote.date);
  var productById = {};
  readTable_('Products').forEach(function (p) { productById[String(p.id)] = p; });

  selections.forEach(function (sel, idx) {
    var product = productById[String(sel.productId)] || {};
    var level = prices[String(sel.productId)] || {};
    var unitPrice = level[SELLING_PRICE_LEVEL] ? level[SELLING_PRICE_LEVEL].price : 0;
    var taxPct = product.gstPct === '' || product.gstPct === undefined ? 18 : Number(product.gstPct);
    var accessories = [sel.dryer, sel.receiver, sel.filters, sel.accessories]
      .filter(function (x) { return String(x || '').trim(); }).join(', ');

    appendRow_('QuotationItems', {
      id: generateId_('QI-'),
      quotationId: quote.id,
      lineNo: idx + 1,
      itemType: 'Product',
      itemId: sel.productId,
      itemCode: sel.productCode,
      description: (product.model || sel.productCode) + (accessories ? ' with ' + accessories : ''),
      qty: 1,
      uom: product.uom || 'Nos',
      listPrice: unitPrice,
      rateType: 'Standard',
      unitPrice: unitPrice,
      discountPct: 0,
      taxPct: taxPct,
      lineTotal: roundMoney_(unitPrice),
      availabilityNote: '',
      leadTimeDays: product.leadTimeDays || ''
    }, 'Selected compressor carried onto the quotation');
  });

  recalcQuotation_(quote.id);

  // Reaching the quotation stage is what the funnel calls it, so move the stage with it.
  if (['Won', 'Lost'].indexOf(opportunity.stage) === -1) {
    updateRowById_('Opportunities', 'id', opportunityId, { stage: 'Quotation' },
      'Quotation ' + quote.quoteNo + ' raised');
  }
  return getQuotation(quote.id);
}
