/**
 * Spare enquiry and part identification — FR-022, FR-023, FR-025.
 *
 * The flow this supports is the one the spare desk actually runs:
 *   customer rings in → log the enquiry against their machine model/serial → identify the
 *   right ELGi part numbers → check what is really available → quote.
 *
 * Identification is the step that prevents the expensive mistake (quoting a part that does
 * not fit), so `suggestSpares` searches the compatibility map first and falls back to a text
 * search, and each suggestion carries its live availability rather than a stale stock column.
 */

var ENQUIRY_STATUSES = ['New', 'Identifying', 'Quoted', 'Won', 'Lost', 'Dropped'];

/** Everyone on the sales side can log and work an enquiry. */
var ENQUIRY_EDITORS = [ROLES.SALES_COORDINATOR, ROLES.SALES_ENGINEER, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

function listSpareEnquiries(options) {
  var user = getCurrentUser();
  var opts = options || {};

  var itemsByEnquiry = {};
  readTable_('SpareEnquiryItems').forEach(function (i) {
    var key = String(i.spareEnquiryId);
    (itemsByEnquiry[key] = itemsByEnquiry[key] || []).push(stripRow_(i));
  });

  var customerNames = {};
  readTable_('Customers').forEach(function (c) { customerNames[String(c.id)] = c.name; });

  var rows = readTable_('SpareEnquiries').map(function (e) {
    var row = stripRow_(e);
    row.items = (itemsByEnquiry[String(row.id)] || []).sort(function (a, b) {
      return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0);
    });
    row.itemCount = row.items.length;
    if (row.customerId && customerNames[String(row.customerId)]) {
      row.customerName = customerNames[String(row.customerId)];
    }
    row.overdue = row.nextActionDate && String(row.nextActionDate) < todayIso_() &&
      ['Won', 'Lost', 'Dropped'].indexOf(row.status) === -1;
    return row;
  });

  // "My enquiries" is the default working view for a coordinator (FR-007).
  if (opts.mineOnly) {
    rows = rows.filter(function (r) { return String(r.ownerEmail).toLowerCase() === user.email.toLowerCase(); });
  }
  if (!opts.includeClosed) {
    rows = rows.filter(function (r) { return ['Won', 'Lost', 'Dropped'].indexOf(r.status) === -1; });
  }

  return rows.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
}

function saveSpareEnquiry(input) {
  var user = getCurrentUser();
  requireRole_(user, ENQUIRY_EDITORS);

  if (!input.customerId) throw new Error('Pick the customer this enquiry is from.');
  var status = String(input.status || 'New').trim();
  if (ENQUIRY_STATUSES.indexOf(status) === -1) {
    throw new Error('Status must be one of: ' + ENQUIRY_STATUSES.join(', ') + '.');
  }
  // A lost enquiry has to say why, so lost-reason analysis is possible (FR-013).
  if (status === 'Lost' && !String(input.lostReasonId || '').trim()) {
    throw new Error('Pick a lost reason before marking this enquiry Lost.');
  }

  var record = {
    date: String(input.date || todayIso_()).slice(0, 10),
    customerId: String(input.customerId),
    customerName: String(input.customerName || '').trim(),
    contactName: String(input.contactName || '').trim(),
    productModel: String(input.productModel || '').trim(),
    serialNo: String(input.serialNo || '').trim(),
    installedBaseId: String(input.installedBaseId || '').trim(),
    requirementText: String(input.requirementText || '').trim(),
    urgency: String(input.urgency || 'Normal').trim(),
    source: String(input.source || '').trim(),
    ownerEmail: String(input.ownerEmail || user.email).trim(),
    status: status,
    nextActionDate: String(input.nextActionDate || '').slice(0, 10),
    lostReasonId: String(input.lostReasonId || '').trim(),
    businessStream: 'Spare Sales',
    brand: String(input.brand || 'ELGI').trim()
  };

  if (input.id) {
    record.id = input.id;
    updateRowById_('SpareEnquiries', 'id', input.id, record, 'Spare enquiry updated');
  } else {
    record.id = generateId_('SE-');
    record.enquiryNo = nextEnquiryNo_();
    record.createdAt = todayIso_();
    record.createdBy = user.email;
    appendRow_('SpareEnquiries', record, 'Spare enquiry logged');
  }
  return record;
}

// ------------------------------------------------------------------ identification

/**
 * Suggests parts for an enquiry line (FR-023).
 *
 * A model match is the trustworthy signal, so compatibility-mapped parts are returned first
 * and marked; a free-text match is offered after them, flagged as unverified, because
 * quoting an unverified part is exactly the mistake this screen exists to prevent.
 */
function suggestSpares(query, productModel) {
  getCurrentUser();

  var q = String(query || '').trim().toLowerCase();
  var model = String(productModel || '').trim().toLowerCase();

  var compatibleIds = {};
  if (model) {
    readTable_('SpareCompatibility').forEach(function (c) {
      if (String(c.active).toUpperCase() === 'FALSE') return;
      if (String(c.productModel).trim().toLowerCase() === model) {
        compatibleIds[String(c.spareId)] = { isServiceKit: String(c.isServiceKit).toUpperCase() === 'TRUE' };
      }
    });
  }

  var prices = priceMapFor_('Spare');
  var onHand = stockOnHandMap_('Spare');
  var reserved = stockReservedMap_('Spare');

  var results = [];
  readTable_('Spares').forEach(function (s) {
    if (String(s.active).toUpperCase() === 'FALSE') return;
    var id = String(s.id);
    var matchesText = !q ||
      String(s.partNo).toLowerCase().indexOf(q) !== -1 ||
      String(s.description).toLowerCase().indexOf(q) !== -1 ||
      String(s.category).toLowerCase().indexOf(q) !== -1;
    var isCompatible = !!compatibleIds[id];
    if (!matchesText && !isCompatible) return;
    if (q && !matchesText) return;

    var levels = prices[id] || {};
    results.push({
      id: s.id,
      partNo: s.partNo,
      description: s.description,
      category: s.category,
      uom: s.uom,
      // The selling price, under a neutral name — this is what the quotation will carry.
      price: levels[SELLING_PRICE_LEVEL] ? levels[SELLING_PRICE_LEVEL].price : null,
      hsnCode: s.hsnCode,
      onHand: onHand[id] || 0,
      reserved: reserved[id] || 0,
      available: (onHand[id] || 0) - (reserved[id] || 0),
      compatibilityConfirmed: isCompatible,
      isServiceKit: isCompatible && compatibleIds[id].isServiceKit
    });
  });

  // Confirmed-compatible parts first; then alphabetically so results are stable.
  return results.sort(function (a, b) {
    if (a.compatibilityConfirmed !== b.compatibilityConfirmed) return a.compatibilityConfirmed ? -1 : 1;
    return String(a.partNo).localeCompare(String(b.partNo));
  }).slice(0, 50);
}

function saveSpareEnquiryItem(input) {
  var user = getCurrentUser();
  requireRole_(user, ENQUIRY_EDITORS);
  if (!input.spareEnquiryId) throw new Error('spareEnquiryId is required.');

  var qty = Number(input.qty);
  if (isNaN(qty) || qty <= 0) throw new Error('Quantity must be greater than zero.');

  var existing = readTable_('SpareEnquiryItems').filter(function (i) {
    return String(i.spareEnquiryId) === String(input.spareEnquiryId);
  });

  var record = {
    spareEnquiryId: String(input.spareEnquiryId),
    lineNo: input.id ? input.lineNo : existing.length + 1,
    spareId: String(input.spareId || '').trim(),
    partNo: String(input.partNo || '').trim(),
    description: String(input.description || '').trim(),
    qty: qty,
    identifiedBy: user.email,
    compatibilityConfirmed: input.compatibilityConfirmed ? 'TRUE' : 'FALSE',
    availabilityNote: String(input.availabilityNote || '').trim(),
    notes: String(input.notes || '').trim()
  };
  if (!record.partNo && !record.description) {
    throw new Error('Pick a part from the catalog, or describe what the customer asked for.');
  }

  if (input.id) {
    record.id = input.id;
    updateRowById_('SpareEnquiryItems', 'id', input.id, record, 'Enquiry line updated');
  } else {
    record.id = generateId_('SEI-');
    appendRow_('SpareEnquiryItems', record, 'Part identified on enquiry');
  }

  // Logging the first identified part moves the enquiry out of New by itself.
  var enquiry = readTable_('SpareEnquiries').filter(function (e) {
    return String(e.id) === String(input.spareEnquiryId);
  })[0];
  if (enquiry && enquiry.status === 'New') {
    updateRowById_('SpareEnquiries', 'id', enquiry.id, { status: 'Identifying' },
      'First part identified');
  }
  return record;
}

function deleteSpareEnquiryItem(id) {
  var user = getCurrentUser();
  requireRole_(user, ENQUIRY_EDITORS);
  deleteRowById_('SpareEnquiryItems', 'id', id, 'Enquiry line removed');
  return true;
}

/** Active lost reasons for the dropdown (FR-013). */
function listLostReasons() {
  getCurrentUser();
  return readTable_('LostReasons')
    .filter(function (r) { return String(r.active).toUpperCase() !== 'FALSE'; })
    .map(stripRow_);
}

/** Distinct compressor models seen in the catalog and in installed machines, for the picker. */
function listKnownModels() {
  getCurrentUser();
  var seen = {};
  readTable_('Products').forEach(function (p) {
    if (p.model) seen[String(p.model).trim()] = true;
  });
  readTable_('SpareCompatibility').forEach(function (c) {
    if (c.productModel) seen[String(c.productModel).trim()] = true;
  });
  return Object.keys(seen).sort();
}

function nextEnquiryNo_() {
  var yy = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyMM');
  var prefix = 'SE' + yy + '-';
  var highest = 0;
  readTable_('SpareEnquiries').forEach(function (e) {
    var m = new RegExp('^' + prefix + '(\\\\d+)$').exec(String(e.enquiryNo || '').trim());
    if (m) highest = Math.max(highest, Number(m[1]));
  });
  return prefix + String(highest + 1).padStart(3, '0');
}
