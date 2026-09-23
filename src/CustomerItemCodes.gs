/**
 * What a customer calls a part in their own system.
 *
 * A purchase order from Sanvijay names each line by their material code — 2000004278 for an
 * oil filter — and mentions ELGi's part number, when it mentions it at all, somewhere inside
 * the description. One line reads "OIL FILTER ELEMENT PART NO. X017503"; the next reads
 * "PRE FILTER 015400889" with no label at all. So every repeat order starts with somebody
 * reading prose to work out which part is meant, and the prose is not written the same way
 * twice. Their customers are regular; only the timing is not. That is a translation done
 * over and over, from a document that cannot be parsed reliably.
 *
 * Recorded once, it stops being done. The code is entered against the customer, because it
 * means nothing outside their system: two customers will have different codes for the same
 * filter, and neither of them is the part's own number.
 */

var ITEM_CODE_EDITORS = [ROLES.SALES_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/** Records, or corrects, what one customer calls one part. */
function saveCustomerItemCode(input) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Customer item codes');
  requireRole_(user, ITEM_CODE_EDITORS);

  var customerId = String((input && input.customerId) || '').trim();
  var customer = customerId ? findRowById_('Customers', customerId) : null;
  if (!customer) throw new Error('Pick the customer this code belongs to.');

  var itemType = String((input && input.itemType) || 'Spare').trim();
  if (['Spare', 'Product'].indexOf(itemType) === -1) {
    throw new Error('An item code belongs to a spare or a product.');
  }
  // The stream comes from the part, not the customer: a customer is one record used by both
  // front offices, so asking which stream they belong to has no answer. A spares coordinator
  // has no business naming compressors, and a compressor coordinator none naming spares.
  requireStream_(user, itemType === 'Spare' ? STREAM_SPARE : STREAM_COMPRESSOR,
    itemType === 'Spare' ? 'Spares' : 'Compressors');

  var itemId = String((input && input.itemId) || '').trim();
  var item = itemId ? findRowById_(itemType === 'Spare' ? 'Spares' : 'Products', itemId) : null;
  if (!item) throw new Error('Pick the part this code refers to.');

  var theirCode = String((input && input.theirCode) || '').trim();
  if (!theirCode) throw new Error("Enter the code as it appears on the customer's order.");

  // A customer and a code are between them the whole identity of a mapping, so a save that
  // repeats both is an edit of the one already there rather than a second row. Without this,
  // recording the same line from a customer's next order quietly doubled it.
  var existing = customerItemCodeRows_().filter(function (r) {
    return String(r.customerId) === customerId &&
      String(r.theirCode).toLowerCase() === theirCode.toLowerCase() &&
      String(r.active).toUpperCase() !== 'FALSE';
  })[0];

  // The same code cannot mean two parts to one customer — that is the whole point of it.
  if (existing && String(existing.itemId) !== itemId &&
      String(existing.id) !== String((input && input.id) || '')) {
    var taken = findRowById_(existing.itemType === 'Product' ? 'Products' : 'Spares',
      existing.itemId);
    throw new Error(customer.name + ' already uses ' + theirCode + ' for ' +
      (taken ? (taken.partNo || taken.productCode) + ' — ' + taken.description : 'another part') +
      '. One code, one part.');
  }

  var record = {
    customerId: customerId,
    itemType: itemType,
    itemId: itemId,
    theirCode: theirCode,
    theirDescription: String((input && input.theirDescription) || '').trim(),
    notes: String((input && input.notes) || '').trim(),
    active: 'TRUE'
  };

  var editing = (input && input.id) || (existing ? existing.id : '');
  if (editing) {
    updateRowById_('CustomerItemCodes', 'id', editing, record, 'Customer item code updated');
    return listCustomerItemCodes(customerId);
  }
  record.id = generateId_('CIC-');
  record.createdAt = todayIso_();
  record.createdBy = user.email;
  appendRow_('CustomerItemCodes', record, 'Customer item code recorded');
  return listCustomerItemCodes(customerId);
}

/** Everything one customer calls by their own name, with our part beside it. */
function listCustomerItemCodes(customerId) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Customer item codes');

  var rows = customerItemCodeRows_().filter(function (r) {
    return String(r.customerId) === String(customerId) &&
      String(r.active).toUpperCase() !== 'FALSE';
  });
  if (!rows.length) return [];

  var spares = {};
  readTable_('Spares').forEach(function (s) { spares[String(s.id)] = s; });
  var products = {};
  readTable_('Products').forEach(function (p) { products[String(p.id)] = p; });

  return rows.map(function (r) {
    var row = stripRow_(r);
    var item = r.itemType === 'Product' ? products[String(r.itemId)] : spares[String(r.itemId)];
    row.ourCode = item ? String(item.partNo || item.productCode || '') : '';
    row.ourDescription = item ? String(item.description || item.model || '') : '';
    // A part deleted from the catalogue leaves the mapping pointing at nothing. Saying so is
    // better than printing a blank row somebody has to work out for themselves.
    row.missing = !item;
    return row;
  }).sort(function (a, b) { return String(a.theirCode).localeCompare(String(b.theirCode)); });
}

/** Forgets one mapping. Deactivated rather than deleted, so a mistake can be traced. */
function deleteCustomerItemCode(id) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Customer item codes');
  requireRole_(user, ITEM_CODE_EDITORS);

  var row = findRowById_('CustomerItemCodes', id);
  if (!row) throw new Error('That code is no longer there.');
  // From the part, as when it was recorded — the customer belongs to both streams.
  requireStream_(user, row.itemType === 'Product' ? STREAM_COMPRESSOR : STREAM_SPARE,
    row.itemType === 'Product' ? 'Compressors' : 'Spares');

  updateRowById_('CustomerItemCodes', 'id', id, { active: 'FALSE' }, 'Customer item code removed');
  return listCustomerItemCodes(row.customerId);
}

/**
 * The mapping table, tolerant of a Sheet set up before this existed.
 *
 * Read by the parts picker on every search, so a missing tab must read as "nobody has
 * recorded any codes" rather than taking the picker down with it.
 */
function customerItemCodeRows_() {
  try {
    return readTable_('CustomerItemCodes');
  } catch (err) {
    return [];
  }
}

/**
 * What this customer calls each part, keyed by our item id — for the picker and the offer.
 *
 * One read for the whole table rather than a lookup per part: the picker holds fifty results
 * and the printed offer holds every line, and either way the table is small.
 */
function customerCodeMap_(customerId) {
  var map = {};
  if (!customerId) return map;
  customerItemCodeRows_().forEach(function (r) {
    if (String(r.customerId) !== String(customerId)) return;
    if (String(r.active).toUpperCase() === 'FALSE') return;
    map[String(r.itemType) + '|' + String(r.itemId)] = {
      theirCode: String(r.theirCode || ''),
      theirDescription: String(r.theirDescription || '')
    };
  });
  return map;
}

/** The item ids a customer's own code matches, for searching by it. */
function itemIdsForCustomerCode_(customerId, query) {
  var hits = {};
  var q = String(query || '').trim().toLowerCase();
  if (!customerId || !q) return hits;
  customerItemCodeRows_().forEach(function (r) {
    if (String(r.customerId) !== String(customerId)) return;
    if (String(r.active).toUpperCase() === 'FALSE') return;
    if (String(r.theirCode).toLowerCase().indexOf(q) === -1 &&
        String(r.theirDescription).toLowerCase().indexOf(q) === -1) return;
    hits[String(r.itemId)] = String(r.theirCode || '');
  });
  return hits;
}
