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

/**
 * How long an offer stands. The client quotes 30 days as standard but asked for short-dated
 * offers too, so anything from a single day up to a month is allowed and nothing outside that.
 */
var QUOTE_VALIDITY_MIN = 1;
var QUOTE_VALIDITY_MAX = 30;
var QUOTE_VALIDITY_DEFAULT = 30;

function clampValidity_(days) {
  var n = Number(days);
  if (!n || isNaN(n)) return QUOTE_VALIDITY_DEFAULT;
  return Math.min(QUOTE_VALIDITY_MAX, Math.max(QUOTE_VALIDITY_MIN, Math.round(n)));
}

/**
 * The contact and addresses a quotation should point at for a given customer.
 *
 * Shared by the three ways a quotation comes into being, and — the reason it exists as a
 * function — by changing the customer on a draft. A contact and an address belong to one
 * customer, so moving the quotation to another and keeping the old pointers would print
 * someone else's address on the offer.
 */
function defaultPartiesFor_(customerId) {
  var addresses = readTable_('CustomerAddresses').filter(function (a) {
    return String(a.customerId) === String(customerId) &&
      String(a.active).toUpperCase() !== 'FALSE';
  });
  var billing = addresses.filter(function (a) {
    return a.addressType === 'Billing' && String(a.isDefault).toUpperCase() === 'TRUE';
  })[0] || addresses.filter(function (a) { return a.addressType === 'Billing'; })[0];
  var shipping = addresses.filter(function (a) {
    return a.addressType === 'Shipping' && String(a.isDefault).toUpperCase() === 'TRUE';
  })[0] || billing;

  var contacts = readTable_('CustomerContacts').filter(function (c) {
    return String(c.customerId) === String(customerId) &&
      String(c.active).toUpperCase() !== 'FALSE';
  });
  var primary = contacts.filter(function (c) {
    return String(c.isPrimary).toUpperCase() === 'TRUE';
  })[0] || contacts[0];

  return {
    contactId: primary ? primary.id : '',
    billingAddressId: billing ? billing.id : '',
    shippingAddressId: shipping ? shipping.id : ''
  };
}

/**
 * The address this offer should print, healing a quotation that was drafted before the
 * customer had one.
 *
 * A quotation stamps its addresses at the moment it is created, so a customer entered in a
 * hurry leaves the offer pointing at nothing. Fixing the customer record afterwards did
 * nothing for the quotations already drafted against it — the pointer stayed empty and the
 * offer kept printing a name over blank space. Resolving it again here means adding the
 * address is enough; the drafts already open pick it up.
 *
 * Deliberately a pure read. Everything that needs an address goes through this function, so
 * the stored pointer being stale costs nothing, and healing it would put a write on the path
 * every quotation screen takes.
 *
 * Returns the address row, or null when the customer record genuinely has none.
 */
function resolveQuoteAddress_(quote) {
  var addresses = readTable_('CustomerAddresses').filter(function (a) {
    return String(a.customerId) === String(quote.customerId) &&
      String(a.active).toUpperCase() !== 'FALSE';
  });
  if (!addresses.length) return null;

  var current = addresses.filter(function (a) {
    return String(a.id) === String(quote.billingAddressId);
  })[0];
  if (current) return current;

  // Billing first, because that is what an offer is addressed to — but any address on the
  // record beats a blank block, so a customer who only has a site address still gets one.
  return addresses.filter(function (a) {
      return a.addressType === 'Billing' && String(a.isDefault).toUpperCase() === 'TRUE';
    })[0] ||
    addresses.filter(function (a) { return a.addressType === 'Billing'; })[0] ||
    addresses[0];
}

/** The address an order should ship to, resolved the same way rather than copied stale. */
function quoteShippingAddressId_(quote) {
  if (quote.shippingAddressId) return quote.shippingAddressId;
  var found = resolveQuoteAddress_(quote);
  return found ? found.id : '';
}

/**
 * What to say when there is no address to print. Empty when there is one.
 *
 * The gap is never really on the quotation — it is on the customer record behind it — so the
 * message names that record and the screen to fix it on. Anything vaguer sends somebody
 * hunting through the offer for a field that was never there.
 */
function quoteAddressGap_(quote) {
  if (resolveQuoteAddress_(quote)) return '';
  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(quote.customerId);
  })[0];
  var name = customer && customer.name ? customer.name : '';
  return 'The customer record' + (name ? ' for ' + name : '') + ' has no address on it. ' +
    'Open Customers \u2192 ' + (name || 'that customer') +
    ' \u2192 Addresses and add one, then try again.';
}

/** Refuses to let an offer leave the building with an empty address block. */
function requireQuoteAddress_(quote) {
  var gap = quoteAddressGap_(quote);
  if (gap) throw new Error(gap);
}

/** Statuses after which the quotation is frozen and further edits fork a revision. */
var LOCKED_QUOTE_STATUSES = ['Approved', 'Submitted', 'Negotiating', 'Won', 'Lost', 'Expired'];

function listQuotations(options) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Quotations');
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
    // 'Revised' belongs here too. A revision is a new quotation row, so revising an offer put
    // two lines in the working list for one offer — the live version and the one it replaced,
    // told apart by a small R1. The replaced one is reachable from Versions on the live one,
    // which is where somebody looking for it actually looks.
    rows = rows.filter(function (r) {
      return ['Won', 'Lost', 'Expired', 'Revised'].indexOf(r.status) === -1;
    });
  }
  if (opts.businessStream) {
    rows = rows.filter(function (r) { return r.businessStream === opts.businessStream; });
  }
  // A spare-sales coordinator has no business reading compressor deals.
  rows = forStream_(user, rows);

  // The stage is worked out after filtering, and for the whole page in one pass: reading the
  // orders, dispatches and invoices per quotation would be three scans per row, and reading
  // them whole would be three tables the screen does not need most of.
  var journey = journeyIndex_(rows.map(function (r) { return String(r.id); }));
  rows.forEach(function (r) { r.journey = quotationJourney_(r, journey); });

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
  requireStream_(user, stream, 'A quotation in that stream');

  // A spares offer answers a request, and the request is the enquiry. Starting one here would
  // be an offer with nothing recorded about what the customer actually asked for, how it
  // reached PIE or who to ring about it — and the enquiry list, which is the spares desk's
  // worklist, would not know the offer existed. Compressor offers still start here: their
  // front door is a lead or an opportunity, not this rule.
  if (stream === STREAM_SPARE) {
    throw new Error('A spares quotation starts from an enquiry. Log what the customer asked ' +
      'for on the Spare Sales screen, then press Create Quotation on it.');
  }

  var parties = defaultPartiesFor_(customer.id);

  var validity = clampValidity_(input.validityDays);

  var quote = {
    id: generateId_('QT-'),
    quoteNo: nextQuoteNo_(defaultBrand_()),
    revision: 'R0',
    parentQuotationId: '',
    date: todayIso_(),
    businessStream: stream,
    brand: defaultBrand_(),
    customerId: customer.id,
    contactId: parties.contactId,
    billingAddressId: parties.billingAddressId,
    shippingAddressId: parties.shippingAddressId,
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
    createdAt: nowIso_(),
    createdBy: user.email
  };
  appendRow_('Quotations', quote, 'Blank quotation started for ' + customer.name);
  return getQuotation(quote.id);
}

function createQuotationFromEnquiry(spareEnquiryId) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);

  requireStream_(user, STREAM_SPARE, 'Spare enquiries');

  var enquiry = readTable_('SpareEnquiries').filter(function (e) {
    return String(e.id) === String(spareEnquiryId);
  })[0];
  if (!enquiry) throw new Error('That enquiry no longer exists.');

  var items = readTable_('SpareEnquiryItems')
    .filter(function (i) { return String(i.spareEnquiryId) === String(spareEnquiryId); })
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); });
  // No refusal for an enquiry with no parts identified yet. Identifying them against the
  // enquiry is the better path and the screen still leads with it, but this is now the only
  // way to raise a spares offer at all, so it cannot be a dead end for a coordinator who
  // would rather pick the parts on the quotation, where the prices and stock are. An offer
  // with no lines is a draft, and a draft cannot be approved or sent.

  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(enquiry.customerId);
  })[0];

  var parties = defaultPartiesFor_(enquiry.customerId);

  // The offer goes to the person who asked for it. This used to take the customer's primary
  // contact instead, so an enquiry logged against Mohan was quoted to whoever happened to be
  // marked primary — and the name the coordinator had typed was dropped at the one step it
  // was collected for. The primary is still the fallback for an enquiry that named nobody.
  var contactId = String(enquiry.contactId || '').trim() || parties.contactId;

  var quote = {
    id: generateId_('QT-'),
    quoteNo: nextQuoteNo_(defaultBrand_()),
    revision: 'R0',
    parentQuotationId: '',
    date: todayIso_(),
    businessStream: STREAM_SPARE,
    brand: defaultBrand_(),
    customerId: enquiry.customerId,
    contactId: contactId,
    billingAddressId: parties.billingAddressId,
    shippingAddressId: parties.shippingAddressId,
    opportunityId: '',
    spareEnquiryId: spareEnquiryId,
    machineModel: enquiry.productModel,
    serialNo: enquiry.serialNo,
    preparedBy: user.email,
    validityDays: QUOTE_VALIDITY_DEFAULT,
    validUntil: addDays_(todayIso_(), QUOTE_VALIDITY_DEFAULT),
    status: 'Draft',
    paymentTerms: customer ? (customer.paymentTerms || '') : '',
    deliveryTerms: '',
    warrantyTerms: '',
    notes: '',
    locked: 'FALSE',
    createdAt: nowIso_(),
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
  var reader = getCurrentUser();
  var q = readTable_('Quotations').filter(function (r) { return String(r.id) === String(id); })[0];
  if (!q) throw new Error('Quotation not found.');
  requireCommercial_(reader, 'A quotation');
  requireStream_(reader, q.businessStream, 'This quotation');
  var row = stripRow_(q);
  // The lines of one quotation, not of all of them. Reading the whole tab to find four rows
  // is what an eight-line offer paid for eight times over while it was being built.
  row.items = quotationLines_(id)
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); })
    .map(stripRow_);
  row.locked = String(row.locked).toUpperCase() === 'TRUE';

  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(row.customerId);
  })[0];
  row.customerName = customer ? customer.name : '';
  row.customerGstin = customer ? customer.gstin : '';
  row.specGaps = specGapsFor_(row.items);
  // The customer record behind this offer may have no address to print. Said here, while the
  // quotation is still being built, rather than at the print button.
  row.addressGap = quoteAddressGap_(q);
  row.billingAddressId = q.billingAddressId;
  // Where this offer stands in the order-to-cash run, read off the records that own each
  // step rather than duplicated onto the quotation.
  row.journey = quotationJourneyFor_(row);
  // Who approves this offer before it goes out, so the screen says it rather than letting
  // somebody find out by being refused.
  row.approvalRule = quoteApprovalRule_(customer);
  row.approvalRule.youMay = mayActForCustomer_(reader, customer);
  // Who built it, who signed it off, and whose customer it is. All three were already on the
  // records; none of them reached the screen, so the only answer to "whose is this?" was to
  // read the sheet.
  row.ownership = {
    preparedBy: String(row.preparedBy || ''),
    approvedBy: String(row.approvedBy || ''),
    approvalDate: String(row.approvalDate || ''),
    coordinatorInCharge: coordinatorInCharge_(customer),
    youMayAssign: mayActForCustomer_(reader, customer)
  };
  return row;
}

/**
 * Which machines on the offer will print a specification table with empty rows.
 *
 * The table prints for every machine now, gaps and all, because a missing table is invisible
 * and nobody chases a page that was never there. That only helps if somebody is told, so the
 * screen says which lines are short and of what, while the quotation can still be fixed.
 */
function specGapsFor_(items) {
  var wanted = [
    { field: 'capacityCfm', label: 'capacity' },
    { field: 'maxPressure', label: 'maximum pressure' },
    { field: 'workingPressure', label: 'normal working pressure' },
    { field: 'motorKw', label: 'motor rating' },
    { field: 'starterType', label: 'starter' },
    { field: 'dimensionsMm', label: 'dimensions' },
    { field: 'weightKg', label: 'weight' }
  ];

  var products = {};
  var needed = (items || []).some(function (i) { return i.itemType === 'Product'; });
  if (!needed) return [];
  readTable_('Products').forEach(function (p) { products[String(p.id)] = p; });

  var gaps = [];
  (items || []).forEach(function (i) {
    if (i.itemType !== 'Product') return;
    var p = products[String(i.itemId)];
    if (!p) return;
    var missing = wanted.filter(function (w) {
      return String(p[w.field] === undefined ? '' : p[w.field]).trim() === '';
    }).map(function (w) { return w.label; });
    if (missing.length) {
      gaps.push({ itemId: String(i.itemId), code: p.productCode, missing: missing });
    }
  });
  return gaps;
}

/** Header edits. Refuses to touch a locked quotation — revise it instead. */
function saveQuotationHeader(input) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);
  var existing = requireUnlockedQuote_(input.id);

  var validityDays = clampValidity_(input.validityDays || existing.validityDays);

  // Changing who the offer is addressed to. Allowed while it is a draft, because picking the
  // wrong name from a list of three thousand is an ordinary slip and the alternative was
  // abandoning the quotation and re-keying every line. Once approved or submitted the quote is
  // locked anyway, so this cannot rewrite what a customer has already received.
  var patch = {};
  var newCustomerId = String(input.customerId || '').trim();
  if (newCustomerId && newCustomerId !== String(existing.customerId)) {
    var customer = readTable_('Customers').filter(function (c) {
      return String(c.id) === newCustomerId;
    })[0];
    if (!customer) throw new Error('That customer no longer exists.');
    if (String(customer.active).toUpperCase() === 'FALSE') {
      throw new Error(customer.name + ' is deactivated. Reactivate them before quoting.');
    }
    // The contact and the addresses belonged to the previous customer; carrying them over
    // would print one company's name above another company's address.
    var parties = defaultPartiesFor_(newCustomerId);
    patch.customerId = newCustomerId;
    patch.contactId = parties.contactId;
    patch.billingAddressId = parties.billingAddressId;
    patch.shippingAddressId = parties.shippingAddressId;
  } else if (!existing.contactId || !existing.billingAddressId) {
    // The offer is addressed to a person at an address: "Kind Attention", their mobile and
    // email, and the customer's address under the company name. Those are stamped on when the
    // quotation is created, from whatever the customer record held at that moment — so a
    // customer created in a hurry, without a contact, produced an offer addressed to nobody
    // and no way to fix it short of starting again. Adding the contact and pressing Save
    // Details now picks it up.
    var found = defaultPartiesFor_(existing.customerId);
    if (!existing.contactId && found.contactId) patch.contactId = found.contactId;
    if (!existing.billingAddressId && found.billingAddressId) {
      patch.billingAddressId = found.billingAddressId;
      if (!existing.shippingAddressId) patch.shippingAddressId = found.shippingAddressId;
    }
  }

  // The package discount is the one their printed offer shows: everything listed at full price
  // with a single percentage struck off the total.
  var pkgPct = input.packageDiscountPct === undefined || input.packageDiscountPct === ''
    ? Number(existing.packageDiscountPct) || 0
    : Number(input.packageDiscountPct);
  if (isNaN(pkgPct) || pkgPct < 0 || pkgPct > 100) {
    throw new Error('Package discount must be between 0 and 100.');
  }
  var pf = input.pfAmount === undefined || input.pfAmount === ''
    ? Number(existing.pfAmount) || 0
    : Number(input.pfAmount);
  if (isNaN(pf) || pf < 0) throw new Error('P&F must be zero or more.');

  var taxMode = String(input.taxMode || existing.taxMode || 'Extra').trim();
  if (['Extra', 'Included'].indexOf(taxMode) === -1) {
    throw new Error('Tax mode must be Extra or Included.');
  }

  var record = {
    date: String(input.date || existing.date).slice(0, 10),
    validityDays: validityDays,
    validUntil: addDays_(String(input.date || existing.date).slice(0, 10), validityDays),
    paymentTerms: String(input.paymentTerms || '').trim(),
    deliveryTerms: String(input.deliveryTerms || '').trim(),
    warrantyTerms: String(input.warrantyTerms || '').trim(),
    machineModel: String(input.machineModel || '').trim(),
    serialNo: String(input.serialNo || '').trim(),
    notes: String(input.notes || '').trim(),
    packageDiscountPct: pkgPct,
    pfAmount: pf,
    taxMode: taxMode
  };
  Object.keys(patch).forEach(function (k) { record[k] = patch[k]; });

  updateRowById_('Quotations', 'id', input.id, record, 'Quotation header updated');

  // Discount, P&F and tax mode all move the totals, so they have to be recomputed here and
  // not only when a line changes.
  recalcQuotation_(input.id);

  return getQuotation(input.id);
}

/**
 * A charge line — carting, freight, packing — that is not an item in any catalog.
 *
 * Their spares offer lists CARTING among the parts with no part number and no rate, just an
 * amount, and the tax on the offer is charged on a base that includes it: ₹2,83,343 × 18% is
 * exactly the ₹51,001.74 they show. So a charge is taxed like everything else, and the default
 * rate follows the lines already on the quotation rather than being assumed.
 *
 * It is a separate function from saveQuotationItem because that one insists on a catalog item
 * and prices from the price list, and neither applies here.
 */
function saveQuotationCharge(input) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);
  requireUnlockedQuote_(input.quotationId);

  var description = String(input.description || '').trim();
  if (!description) throw new Error('Give the charge a description, for example Carting.');

  var amount = Number(input.amount);
  if (isNaN(amount) || amount < 0) throw new Error('The amount must be a number, zero or more.');

  var existingLines = quotationLines_(input.quotationId);

  var taxPct;
  if (input.taxPct === '' || input.taxPct === undefined || input.taxPct === null) {
    // Follow the goods: a charge taxed at a different rate to the order it belongs to is
    // almost always a slip rather than an intention.
    var goods = existingLines.filter(function (i) { return i.lineType !== 'Charge'; });
    taxPct = goods.length ? (Number(goods[0].taxPct) || 0) : 18;
  } else {
    taxPct = Number(input.taxPct);
  }
  if (isNaN(taxPct) || taxPct < 0 || taxPct > 100) throw new Error('Tax must be between 0 and 100.');

  var record = {
    quotationId: String(input.quotationId),
    lineNo: input.id ? Number(input.lineNo) : existingLines.length + 1,
    lineType: 'Charge',
    itemType: '',
    itemId: '',
    itemCode: '',
    description: description,
    qty: 1,
    uom: 'Lot',
    listPrice: '',
    rateType: 'Charge',
    unitPrice: roundMoney_(amount),
    discountPct: 0,
    taxPct: taxPct,
    lineTotal: roundMoney_(amount),
    availabilityNote: '',
    leadTimeDays: ''
  };

  if (input.id) {
    updateRowById_('QuotationItems', 'id', input.id, record, 'Charge updated');
  } else {
    record.id = generateId_('QI-');
    appendRow_('QuotationItems', record, 'Charge added: ' + description);
  }
  recalcQuotation_(input.quotationId);
  return getQuotation(input.quotationId);
}

/** Adds or updates one line. See `quoteItemRecord_` for how the row itself is derived. */
function saveQuotationItem(input) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);
  var quote = requireUnlockedQuote_(input.quotationId);

  var itemType = quoteItemType_(input.itemType);
  var master = masterRecordFor_(itemType, input.itemId);
  var effective = getEffectivePrice_(itemType, String(input.itemId), SELLING_PRICE_LEVEL, quote.date);

  var existingLines = quotationLines_(input.quotationId);

  var record = quoteItemRecord_(input, itemType, master, effective,
    input.id ? Number(input.lineNo) : existingLines.length + 1);

  var merged = [];
  if (input.id) {
    record.id = input.id;
    updateRowById_('QuotationItems', 'id', input.id, record, 'Quotation line updated');
  } else {
    var twin = matchingQuoteLine_(existingLines, record);
    if (twin) {
      merged.push(mergeIntoQuoteLine_(twin, record));
    } else {
      record.id = generateId_('QI-');
      appendRow_('QuotationItems', record, 'Quotation line added');
    }
  }

  recalcQuotation_(input.quotationId);
  return withMergeNote_(getQuotation(input.quotationId), merged);
}

/**
 * The line a part being added is already on, or nothing.
 *
 * A part picked twice is nearly always the same part remembered late — the quantity was left
 * at 1 and the rest of it added afterwards — so it belongs on the line that is already there.
 * The exception is a part deliberately quoted twice at different money: two rates, or one
 * discounted batch and one not. Those are genuinely two lines on the offer, so the price, the
 * discount and the tax all have to agree before two rows become one.
 */
function matchingQuoteLine_(lines, record) {
  var key = quoteLineKey_(record);
  return lines.filter(function (l) {
    return String(l.lineType || 'Item') === 'Item' && quoteLineKey_(l) === key;
  })[0] || null;
}

function quoteLineKey_(l) {
  return [
    String(l.itemType || ''),
    String(l.itemId || ''),
    money2_(l.unitPrice),
    money2_(l.discountPct),
    money2_(l.taxPct)
  ].join('|');
}

/** Two figures that print the same are the same figure; comparing them raw makes 385 and
 * 385.0000000001 into two lines on a customer's offer. */
function money2_(v) {
  return (Math.round((Number(v) || 0) * 100) / 100).toFixed(2);
}

/** Raises a line's quantity and the money that follows from it, in place. */
function addQuoteLineQty_(line, extraQty) {
  line.qty = (Number(line.qty) || 0) + (Number(extraQty) || 0);
  var net = (Number(line.unitPrice) || 0) * (1 - (Number(line.discountPct) || 0) / 100);
  line.lineTotal = roundMoney_(net * line.qty);
  return line.qty;
}

/** Adds the new quantity to the line already there, and reports what it became. */
function mergeIntoQuoteLine_(line, record) {
  var qty = (Number(line.qty) || 0) + (Number(record.qty) || 0);
  var net = (Number(record.unitPrice) || 0) * (1 - (Number(record.discountPct) || 0) / 100);
  updateRowById_('QuotationItems', 'id', line.id,
    { qty: qty, lineTotal: roundMoney_(net * qty) },
    'Quantity increased on an existing line');
  return {
    id: line.id,
    lineNo: Number(line.lineNo) || 0,
    itemCode: String(line.itemCode || record.itemCode || ''),
    description: String(line.description || record.description || ''),
    was: Number(line.qty) || 0,
    qty: qty
  };
}

/**
 * Says which lines grew instead of being added, so the screen can tell the difference. A
 * quantity that changes on a line further up the list is easy to miss, and a coordinator who
 * does not see their part appear will add it again.
 */
function withMergeNote_(row, merged) {
  if (merged && merged.length) row.merged = merged;
  return row;
}

/**
 * Adds several lines in one call.
 *
 * Adding a spares offer's worth of parts one at a time meant one execution per part, each one
 * starting up, taking the lock, scanning the catalogue's id column and the price list, and
 * recalculating the quotation. A coordinator picking twelve parts paid all of that twelve
 * times over. Here every catalogue and price lookup happens once for the whole selection, the
 * rows are written in a single block, and the quotation is recalculated once.
 */
function saveQuotationItems(input) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);
  var quote = requireUnlockedQuote_(input.quotationId);

  var lines = (input.lines || []).filter(function (l) { return l && l.itemId; });
  if (!lines.length) throw new Error('Nothing was selected to add.');

  // One lookup per catalogue, not per line.
  var types = lines.map(function (l) { return quoteItemType_(l.itemType || input.itemType); });
  var idsByType = {};
  types.forEach(function (t, i) {
    (idsByType[t] = idsByType[t] || []).push(String(lines[i].itemId));
  });

  var masters = {};
  var prices = {};
  Object.keys(idsByType).forEach(function (t) {
    var tab = t === 'Product' ? 'Products' : 'Spares';
    masters[t] = findRowsByIds_(tab, idsByType[t]);
    prices[t] = getEffectivePrices_(t, idsByType[t], SELLING_PRICE_LEVEL, quote.date);
  });

  var existingLines = quotationLines_(input.quotationId);
  var nextLineNo = existingLines.length + 1;

  // A selection can contain a part the offer already carries, and — once two selections are
  // made in a row — two of its own. Both fold into the line that is already there.
  var settled = existingLines.slice();
  var records = [], merged = [];
  lines.forEach(function (l, i) {
    var t = types[i];
    var key = String(l.itemId);
    var record = quoteItemRecord_(
      { quotationId: input.quotationId, itemId: l.itemId, itemCode: l.itemCode,
        description: l.description, qty: l.qty, uom: l.uom, unitPrice: l.unitPrice,
        discountPct: l.discountPct, taxPct: l.taxPct,
        availabilityNote: l.availabilityNote, leadTimeDays: l.leadTimeDays },
      t, masters[t][key] || null, prices[t][key] || null, nextLineNo);

    var twin = matchingQuoteLine_(settled, record);
    if (twin && records.indexOf(twin) !== -1) {
      // A twin from this same selection has not been written yet, so it is only a quantity to
      // carry — updating it by id would be updating a row that does not exist.
      addQuoteLineQty_(twin, record.qty);
      return;
    }
    if (twin) {
      var note = mergeIntoQuoteLine_(twin, record);
      twin.qty = note.qty;                 // so a third copy in the same call lands here too
      merged.push(note);
      return;
    }
    record.id = generateId_('QI-');
    records.push(record);
    settled.push(record);
    nextLineNo++;
  });

  appendRows_('QuotationItems', records, 'Quotation lines added');
  recalcQuotation_(input.quotationId);
  return withMergeNote_(getQuotation(input.quotationId), merged);
}

function quoteItemType_(value) {
  var itemType = String(value || 'Spare').trim();
  if (['Spare', 'Product'].indexOf(itemType) === -1) {
    throw new Error('itemType must be Spare or Product.');
  }
  return itemType;
}

/**
 * One line's row, built the same way whether it arrived alone or as part of a selection.
 * `unitPrice` defaults to the item's selling price on the quotation date, so a coordinator
 * never has to look a price up, but it can be overridden — with the discount that implies
 * recorded explicitly rather than buried in a changed number.
 */
function quoteItemRecord_(input, itemType, master, effective, lineNo) {
  var qty = Number(input.qty);
  if (isNaN(qty) || qty <= 0) throw new Error('Quantity must be greater than zero.');

  var discountPct = Number(input.discountPct) || 0;
  if (discountPct < 0 || discountPct > 100) throw new Error('Discount must be between 0 and 100.');

  var listPrice = effective ? effective.price : 0;
  var unitPrice = (input.unitPrice === '' || input.unitPrice === undefined || input.unitPrice === null)
    ? listPrice : Number(input.unitPrice);
  if (isNaN(unitPrice) || unitPrice < 0) throw new Error('The price must be a number.');

  var taxPct = input.taxPct === '' || input.taxPct === undefined || input.taxPct === null
    ? (master && master.gstPct !== '' ? Number(master.gstPct) : 18)
    : Number(input.taxPct);

  var net = unitPrice * (1 - discountPct / 100);

  return {
    quotationId: String(input.quotationId),
    lineNo: lineNo,
    lineType: 'Item',
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
}

/**
 * Throws away a draft quotation and its lines.
 *
 * Only a draft, and only one nothing has been built on. A quotation that has been approved or
 * submitted is what a customer received and is never deleted — it is marked Lost instead. One
 * with a sales order against it, or with revisions hanging off it, would orphan those records,
 * so it is refused with a message saying which.
 *
 * The number can be reused afterwards, and that is fine: an unsent draft never reached anyone,
 * so nothing outside this system has seen it.
 */
function discardQuotation(quotationId) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);

  var quote = readTable_('Quotations').filter(function (q) {
    return String(q.id) === String(quotationId);
  })[0];
  if (!quote) throw new Error('That quotation no longer exists.');

  if (String(quote.locked).toUpperCase() === 'TRUE' || quote.status !== 'Draft') {
    throw new Error('Only a draft can be discarded. ' + quote.quoteNo + ' is ' +
      quote.status + ' — mark it Lost instead, so the record of what was sent survives.');
  }

  var order = readTable_('SalesOrders').filter(function (o) {
    return String(o.quotationId) === String(quotationId);
  })[0];
  if (order) {
    throw new Error('Sales order ' + order.orderNo + ' was raised from this quotation, so it ' +
      'cannot be discarded.');
  }

  var revision = readTable_('Quotations').filter(function (q) {
    return String(q.parentQuotationId) === String(quotationId);
  })[0];
  if (revision) {
    throw new Error('Revision ' + revision.quoteNo + ' ' + revision.revision + ' came from this ' +
      'quotation, so it cannot be discarded.');
  }

  var lines = quotationLines_(quotationId);
  lines.forEach(function (line) {
    deleteRowById_('QuotationItems', 'id', line.id, 'Line removed with discarded quotation');
  });

  var quoteNo = quote.quoteNo;
  deleteRowById_('Quotations', 'id', quotationId,
    'Draft quotation discarded (' + lines.length + ' line(s))');

  return { quoteNo: quoteNo, lines: lines.length };
}

/**
 * Puts a locked quotation back to Draft.
 *
 * Everything past Draft is locked, which is right — a quotation that has gone to a customer
 * should not quietly change under them. But the lock had no key: a quotation marked Submitted
 * by mistake, or raised to try the screen out, could never be edited or discarded again, and
 * it held onto the products it named for good. That made test data impossible to clear.
 *
 * Won and Lost are not reopened here. They are outcomes, and marking them moved the
 * opportunity or enquiry behind them; undoing that belongs with those records, not with a
 * button on the quotation. An order raised from the quotation, or a revision descended from
 * it, blocks it too — the same things that block discarding, for the same reason.
 *
 * The dates set on the way up are cleared on the way down, so a draft never carries an
 * approval or a submission date it no longer has.
 */
function reopenQuotation(id, reason) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);

  var quote = readTable_('Quotations').filter(function (q) {
    return String(q.id) === String(id);
  })[0];
  if (!quote) throw new Error('That quotation no longer exists.');

  if (quote.status === 'Draft') return getQuotation(id);
  if (['Won', 'Lost'].indexOf(quote.status) !== -1) {
    throw new Error(quote.quoteNo + ' is marked ' + quote.status + '. That outcome also moved ' +
      'the opportunity or enquiry it came from, so it is not undone from here.');
  }

  var order = readTable_('SalesOrders').filter(function (o) {
    return String(o.quotationId) === String(id);
  })[0];
  if (order) {
    throw new Error('Sales order ' + order.orderNo + ' was raised from ' + quote.quoteNo +
      ', so it cannot be reopened.');
  }

  var revision = readTable_('Quotations').filter(function (q) {
    return String(q.parentQuotationId) === String(id);
  })[0];
  if (revision) {
    throw new Error('Revision ' + revision.quoteNo + ' ' + revision.revision + ' came from ' +
      quote.quoteNo + ', so it cannot be reopened. Work on the revision instead.');
  }

  updateRowById_('Quotations', 'id', id,
    { status: 'Draft', locked: 'FALSE', approvedBy: '', approvalDate: '', submittedDate: '' },
    reason ? 'Reopened as draft: ' + reason : 'Reopened as draft');
  return getQuotation(id);
}

function deleteQuotationItem(id) {
  var user = getCurrentUser();
  requireRole_(user, QUOTE_EDITORS);
  var line = readTable_('QuotationItems').filter(function (i) {
    return String(i.id) === String(id);
  })[0];
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
function setQuotationStatus(id, status, lostReasonId, lostDetails) {
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
  if (status !== 'Draft' && !quotationLines_(id).length) {
    throw new Error('A quotation needs at least one line before it can leave Draft.');
  }

  // Who may sign this off is a question about who looks after the customer, not about the
  // amount: the coordinator in charge makes the call, and Management can but need not.
  var customer = findRowById_('Customers', quote.customerId);
  var rule = quoteApprovalRule_(customer);

  if (status === 'Approved' && !mayActForCustomer_(user, customer)) {
    throw new Error(rule.why + ' You are signed in as ' + user.email + '.');
  }
  // The address first: a missing one is a gap in the data, and saying "get it approved" to
  // somebody whose offer cannot print either only costs them a second trip.
  if (status === 'Submitted') requireQuoteAddress_(quote);
  // Nothing goes to a customer unapproved. The test is the approval itself, not the status
  // it left behind: a quotation reopened as a draft has its approval cleared, so it has to be
  // signed off again before it can go out a second time.
  if (status === 'Submitted' && !quote.approvalDate) {
    throw new Error('This quotation has not been approved yet, and nothing goes to a ' +
      'customer unapproved. ' + rule.why);
  }

  var patch = { status: status, locked: LOCKED_QUOTE_STATUSES.indexOf(status) !== -1 ? 'TRUE' : 'FALSE' };
  if (status === 'Approved') { patch.approvedBy = user.email; patch.approvalDate = todayIso_(); }
  if (status === 'Submitted') patch.submittedDate = todayIso_();
  if (status === 'Won') patch.wonDate = todayIso_();
  if (status === 'Lost') {
    patch.lostReasonId = lostReasonId;
    patch.lostDate = todayIso_();
    // What actually happened, which is the part worth reading before quoting this customer
    // again. Optional: a coordinator who only knows the reason should not be stopped from
    // recording it, and a form that demands detail nobody has gets filled with "n/a".
    var detail = lostDetails || {};
    patch.lostNotes = String(detail.notes || '').trim();
    patch.lostToCompetitor = String(detail.competitor || '').trim();
    patch.lostAtPrice = detail.price === '' || detail.price === undefined ||
      detail.price === null ? '' : Number(detail.price);
    if (patch.lostAtPrice !== '' && (isNaN(patch.lostAtPrice) || patch.lostAtPrice < 0)) {
      throw new Error("A competitor's price cannot be negative.");
    }
  }

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
  copy.validUntil = addDays_(todayIso_(), clampValidity_(source.validityDays));
  copy.status = 'Draft';
  copy.locked = 'FALSE';
  copy.approvedBy = '';
  copy.approvalDate = '';
  copy.submittedDate = '';
  copy.emailSentDate = '';
  copy.lostReasonId = '';
  copy.preparedBy = user.email;
  copy.createdAt = nowIso_();
  copy.createdBy = user.email;
  appendRow_('Quotations', copy, 'Revision ' + nextRevision + ' of ' + source.quoteNo);

  quotationLines_(id)
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

/**
 * Every version of one quotation, oldest first.
 *
 * A revision is a separate quotation row that points back at the first one, which is right —
 * what the customer received has to survive unchanged — but it meant the versions of a single
 * offer were scattered through All Quotations among everybody else's work, told apart only by
 * a small R1 against the number. Asking "what did we send them last time, and what changed"
 * meant hunting. Here they are as one list, and nothing else is in it.
 */
function listQuotationVersions(id) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Quotations');

  var all = readTable_('Quotations');
  var source = all.filter(function (q) { return String(q.id) === String(id); })[0];
  if (!source) throw new Error('Quotation not found.');
  requireStream_(user, source.businessStream, 'This quotation');

  var rootId = String(source.parentQuotationId || source.id);
  var family = all.filter(function (q) {
    return String(q.id) === rootId || String(q.parentQuotationId) === rootId;
  });

  var journey = journeyIndex_(family.map(function (q) { return String(q.id); }));

  return family
    .map(function (q) {
      return {
        id: String(q.id),
        quoteNo: String(q.quoteNo || ''),
        revision: String(q.revision || 'R0'),
        date: String(q.date || ''),
        validUntil: String(q.validUntil || ''),
        status: String(q.status || ''),
        locked: String(q.locked).toUpperCase() === 'TRUE',
        grand: Number(q.grand) || 0,
        preparedBy: String(q.preparedBy || ''),
        approvedBy: String(q.approvedBy || ''),
        approvalDate: String(q.approvalDate || ''),
        submittedDate: String(q.submittedDate || ''),
        // Which one is the live offer: the newest that was not superseded by another.
        superseded: String(q.status) === 'Revised',
        isCurrent: String(q.id) === String(id),
        journeyLabel: quotationJourney_(q, journey).label
      };
    })
    .sort(function (a, b) {
      return (Number(String(a.revision).replace(/[^0-9]/g, '')) || 0) -
             (Number(String(b.revision).replace(/[^0-9]/g, '')) || 0);
    });
}

// ------------------------------------------------------------------ internals

/** Totals are always recomputed from the lines — never accumulated or hand-edited. */
/** One quotation row, from the block this request will want the rest of anyway. */
function quotationRow_(quotationId) {
  return readTable_('Quotations').filter(function (q) {
    return String(q.id) === String(quotationId);
  })[0];
}

/**
 * The lines of one quotation.
 *
 * Deliberately a whole-tab read and not a targeted one. Fetching just the four rows that
 * match costs a column scan plus a read per run of rows - three or four round trips where
 * reading the tab is one, and Apps Script charges by the round trip. The tab is read once per
 * request and every later caller is served from that block, writes included.
 */
function quotationLines_(quotationId) {
  return readTable_('QuotationItems').filter(function (i) {
    return String(i.quotationId) === String(quotationId);
  });
}

function recalcQuotation_(quotationId) {
  var lines = quotationLines_(quotationId);

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

  var quote = quotationRow_(quotationId);
  var freight = quote ? (Number(quote.freight) || 0) : 0;
  var pf = quote ? (Number(quote.pfAmount) || 0) : 0;

  // Their price schedule discounts the package, not the line: everything is listed at full
  // price and one percentage comes off the total. Line discounts still work, and the package
  // discount applies after them.
  var pkgPct = quote ? (Number(quote.packageDiscountPct) || 0) : 0;
  var afterLines = subtotal - discountAmt;
  var pkgDiscount = pkgPct > 0 ? afterLines * pkgPct / 100 : 0;
  var netGoods = afterLines - pkgDiscount;

  // A package discount changes the taxable value, so the line tax has to move with it.
  if (pkgPct > 0 && afterLines > 0) taxAmt = taxAmt * (netGoods / afterLines);

  // Their compressor offer quotes a pre-tax figure and notes "18% GST EXTRA"; the grand total
  // then excludes tax. The spares offer added it in. Which one applies is per quotation.
  var taxIncluded = !quote || String(quote.taxMode || 'Extra') !== 'Extra';
  var grand = netGoods + pf + freight + (taxIncluded ? taxAmt : 0);

  updateRowById_('Quotations', 'id', quotationId, {
    subtotal: roundMoney_(subtotal),
    discountAmt: roundMoney_(discountAmt + pkgDiscount),
    taxAmt: roundMoney_(taxAmt),
    grand: roundMoney_(grand)
  }, 'Totals recalculated');
}

function requireUnlockedQuote_(quotationId) {
  var quote = quotationRow_(quotationId);
  if (!quote) throw new Error('Quotation not found.');
  // Every edit to a quotation comes through here, so this is the one place the stream has to
  // be checked on the way in.
  requireStream_(getCurrentUser(), quote.businessStream, 'This quotation');
  if (String(quote.locked).toUpperCase() === 'TRUE') {
    throw new Error('Quotation ' + quote.quoteNo + ' ' + quote.revision + ' is ' + quote.status +
      ' and cannot be edited. Use "Revise" to create the next revision.');
  }
  return quote;
}

function renumberQuotationLines_(quotationId) {
  quotationLines_(quotationId)
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); })
    .forEach(function (line, idx) {
      if (Number(line.lineNo) !== idx + 1) {
        updateRowById_('QuotationItems', 'id', line.id, { lineNo: idx + 1 }, 'Lines renumbered');
      }
    });
}

function masterRecordFor_(itemType, itemId) {
  var tab = itemType === 'Product' ? 'Products' : 'Spares';
  // One row, fetched as one row. This read the whole table and threw away all but one of it,
  // on every line added to every quotation.
  return findRowById_(tab, itemId);
}

/**
 * Their own numbering: PIE/ELGI/QUOT/26-27/383 — company, brand, document, financial year,
 * serial. The brand sits inside the number, which is exactly what a second brand will need.
 * The serial runs on across the financial year rather than resetting monthly, as theirs does.
 */
function nextQuoteNo_(brand) {
  var profile = readTable_('CompanyProfile').filter(function (c) {
    return String(c.id) === 'CO-1';
  })[0];
  var base = String((profile && profile.quotePrefix) || 'PIE/ELGI/QUOT').trim()
    .replace(/\/+$/, '');
  // The prefix carries the house brand in the middle; a second brand swaps that segment out.
  var house = String((profile && profile.defaultBrand) || 'ELGI').trim();
  if (brand && house && String(brand).toUpperCase() !== house.toUpperCase()) {
    base = base.replace(new RegExp('/' + house.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/', 'i'),
      '/' + String(brand).toUpperCase() + '/');
  }

  var prefix = base + '/' + indianFinancialYear_() + '/';
  var highest = 0;
  readTable_('Quotations').forEach(function (q) {
    var m = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)$')
      .exec(String(q.quoteNo || '').trim());
    if (m) highest = Math.max(highest, Number(m[1]));
  });
  return prefix + String(highest + 1);
}

/** India's financial year runs April to March, and is written 26-27. */
function indianFinancialYear_(date) {
  var d = date ? new Date(date) : new Date();
  var y = d.getFullYear();
  var startYear = d.getMonth() >= 3 ? y : y - 1;   // April is month 3
  return String(startYear).slice(2) + '-' + String(startYear + 1).slice(2);
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

  requireStream_(user, STREAM_COMPRESSOR, 'The compressor funnel');

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

  var parties = defaultPartiesFor_(opportunity.customerId);

  var quote = {
    id: generateId_('QT-'),
    quoteNo: nextQuoteNo_(defaultBrand_()),
    revision: 'R0',
    parentQuotationId: '',
    date: todayIso_(),
    businessStream: STREAM_COMPRESSOR,
    brand: defaultBrand_(),
    customerId: opportunity.customerId,
    contactId: parties.contactId,
    billingAddressId: parties.billingAddressId,
    shippingAddressId: parties.shippingAddressId,
    opportunityId: opportunityId,
    spareEnquiryId: '',
    machineModel: '',
    serialNo: '',
    preparedBy: user.email,
    validityDays: QUOTE_VALIDITY_DEFAULT,
    validUntil: addDays_(todayIso_(), QUOTE_VALIDITY_DEFAULT),
    status: 'Draft',
    paymentTerms: customer ? (customer.paymentTerms || '') : '',
    deliveryTerms: '',
    warrantyTerms: '',
    notes: 'Application: ' + tech.application + ' · FAD ' + tech.requiredFad +
      ' · ' + tech.workingPressure,
    locked: 'FALSE',
    createdAt: nowIso_(),
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
