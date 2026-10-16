/**
 * Converted from src/SpareEnquiries.gs by migration/to-async.js.
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

async function listSpareEnquiries(options) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Spare enquiries');
  requireStream_(user, STREAM_SPARE, 'Spare enquiries');
  var opts = options || {};

  var itemsByEnquiry = {};
  (await readTable_('SpareEnquiryItems')).forEach(function (i) {
    var key = String(i.spareEnquiryId);
    (itemsByEnquiry[key] = itemsByEnquiry[key] || []).push(stripRow_(i));
  });

  var customerNames = {};
  (await readTable_('Customers')).forEach(function (c) { customerNames[String(c.id)] = c.name; });

  var rows = (await readTable_('SpareEnquiries')).map(function (e) {
    var row = stripRow_(e);
    row.items = (itemsByEnquiry[String(row.id)] || []).sort(function (a, b) {
      return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0);
    });
    row.itemCount = row.items.length;
    if (row.customerId && customerNames[String(row.customerId)]) {
      row.customerName = customerNames[String(row.customerId)];
    }
    // Late means the parts are late, not that somebody forgot to make a call: the date on a
    // spares enquiry is the one the customer was given.
    row.overdue = row.expectedDeliveryDate && String(row.expectedDeliveryDate) < todayIso_() &&
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

async function saveSpareEnquiry(input) {
  var user = getCurrentUser();
  requireRole_(user, ENQUIRY_EDITORS);
  requireCommercial_(user, 'Spare enquiries');
  requireStream_(user, STREAM_SPARE, 'Spare enquiries');

  if (!input.customerId) throw new Error('Pick the customer this enquiry is from.');

  // Nobody types the status of a spares enquiry. It is decided by what has happened to the
  // enquiry — a part identified, an offer raised, that offer won or lost — and those places
  // set it themselves. A form that also offered it invited two answers to one question, and
  // the one typed last won. So an edit keeps whatever the record already says, and a new
  // enquiry starts at New, unless a caller states a status explicitly.
  var existing = input.id ? await findRowById_('SpareEnquiries', input.id) : null;
  var status = String(
    input.status !== undefined && input.status !== ''
      ? input.status
      : (existing ? existing.status : '') || 'New').trim();
  if (ENQUIRY_STATUSES.indexOf(status) === -1) {
    throw new Error('Status must be one of: ' + ENQUIRY_STATUSES.join(', ') + '.');
  }
  // A lost enquiry has to say why, so lost-reason analysis is possible (FR-013).
  var lostReasonId = String(
    input.lostReasonId !== undefined && input.lostReasonId !== ''
      ? input.lostReasonId
      : (existing ? existing.lostReasonId : '') || '').trim();
  if (status === 'Lost' && !lostReasonId) {
    throw new Error('Pick a lost reason before marking this enquiry Lost.');
  }

  var who = await resolveEnquiryContact_(input, user);

  var record = {
    date: String(input.date || todayIso_()).slice(0, 10),
    customerId: String(input.customerId),
    customerName: String(input.customerName || '').trim(),
    contactName: who.contactName,
    contactId: who.contactId,
    contactPhone: who.contactPhone,
    contactEmail: who.contactEmail,
    productModel: String(input.productModel || '').trim(),
    serialNo: String(input.serialNo || '').trim(),
    installedBaseId: String(input.installedBaseId || '').trim(),
    requirementText: String(input.requirementText || '').trim(),
    urgency: String(input.urgency || 'Normal').trim(),
    source: String(input.source || '').trim(),
    ownerEmail: String(input.ownerEmail || user.email).trim(),
    status: status,
    expectedDeliveryDate: String(input.expectedDeliveryDate || '').slice(0, 10),
    lostReasonId: lostReasonId,
    businessStream: STREAM_SPARE,
    brand: String(input.brand || 'ELGI').trim()
  };

  if (input.id) {
    record.id = input.id;
    await updateRowById_('SpareEnquiries', 'id', input.id, record, 'Spare enquiry updated');
  } else {
    record.id = generateId_('SE-');
    record.enquiryNo = await nextEnquiryNo_();
    record.createdAt = todayIso_();
    record.createdBy = user.email;
    await appendRow_('SpareEnquiries', record, 'Spare enquiry logged');
  }
  return record;
}


/**
 * The person who raised the enquiry, tied to the customer's contact list.
 *
 * An enquiry used to hold a typed name and nothing else — no number, no address, and no link
 * to the contact record where those are kept. So the one thing the coordinator learns on the
 * call, how to reach the person who wants the parts, was thrown away at the moment it was
 * collected, and the quotation raised from the enquiry went out addressed to whoever happened
 * to be marked primary on the customer.
 *
 * A name already on file is matched rather than duplicated. A new one is added to the
 * customer's contacts, so the second enquiry from the same person does not ask again. The
 * number and address are also written onto the enquiry itself: the contact record is the
 * place they are maintained, but the enquiry should still say who was spoken to on the day,
 * even if that person later leaves and their record is edited.
 */
async function resolveEnquiryContact_(input, user) {
  var blank = { contactId: '', contactName: '', contactPhone: '', contactEmail: '' };
  var customerId = String(input.customerId || '');
  var name = String(input.contactName || '').trim();
  var phone = String(input.contactPhone || '').trim();
  var email = String(input.contactEmail || '').trim();
  var wantedId = String(input.contactId || '').trim();
  if (!customerId || (!name && !wantedId)) return blank;

  var contacts = (await readTable_('CustomerContacts')).filter(function (c) {
    return String(c.customerId) === customerId && String(c.active).toUpperCase() !== 'FALSE';
  });

  var match = null;
  if (wantedId) {
    match = contacts.filter(function (c) { return String(c.id) === wantedId; })[0] || null;
  }
  if (!match && name) {
    match = contacts.filter(function (c) {
      return String(c.name).trim().toLowerCase() === name.toLowerCase();
    })[0] || null;
  }

  if (match) {
    // Blanks are filled in, but nothing already on the record is overwritten: a number typed
    // in a hurry during a call should complete a contact, not replace one somebody maintains.
    var patch = {};
    if (phone && !String(match.phone || '').trim()) patch.phone = phone;
    if (email && !String(match.email || '').trim()) patch.email = email;
    if (patch.phone || patch.email) {
      await updateRowById_('CustomerContacts', 'id', match.id, patch,
        'Filled in from spare enquiry');
    }
    return {
      contactId: String(match.id),
      contactName: String(match.name),
      contactPhone: phone || String(match.phone || ''),
      contactEmail: email || String(match.email || '')
    };
  }

  // Somebody new. Adding them to the customer is how the next enquiry finds them, but it is
  // a write to master data. The two role lists agree today, so this check never refuses
  // anybody; it is here so that narrowing one of them later costs a contact record rather
  // than the whole enquiry.
  if (CUSTOMER_EDITORS.indexOf(user.role) !== -1) {
    var created = await saveCustomerContact({
      customerId: customerId,
      name: name,
      phone: phone,
      email: email,
      contactRole: 'Purchase',
      // The first person we ever spoke to at this customer is the one to address by default.
      isPrimary: !contacts.length
    });
    return { contactId: String(created.id), contactName: name,
             contactPhone: phone, contactEmail: email };
  }
  return { contactId: '', contactName: name, contactPhone: phone, contactEmail: email };
}

// ------------------------------------------------------------------ identification

/**
 * Suggests parts for an enquiry line (FR-023).
 *
 * A model match is the trustworthy signal, so compatibility-mapped parts are returned first
 * and marked; a free-text match is offered after them, flagged as unverified, because
 * quoting an unverified part is exactly the mistake this screen exists to prevent.
 */
/**
 * Finds spares for a quotation or an enquiry.
 *
 * `productGroup` narrows the search to ELGi's own grouping — RCD Spares, EPSAC Airend and so
 * on. On a catalogue of a few dozen parts that was a nicety; on thirteen thousand it is how
 * the counter actually works, because that is the term the customer uses on the phone.
 */
/**
 * The product groups actually present in the catalogue, for the picker's dropdown.
 *
 * Ten or so strings, derived from every row in the catalogue. The screen asks for them once
 * per session, which meant one full read of thirteen thousand parts per person per day to
 * populate a dropdown whose contents change twice a year — when ELGi sends a new price list.
 *
 * So it is cached for the company rather than computed per person, and the import clears it
 * (see invalidateCatalogCaches_), which is the only thing that can change the answer other
 * than someone editing a single part's group by hand. An hour of staleness in that case is
 * the cost, and a stale dropdown shows one group too few until it expires — it cannot show a
 * wrong price or lose a part, because the search itself never consults this list.
 */
var PRODUCT_GROUPS_KEY_ = 'catalog:productGroups:Spare';
var PRODUCT_GROUPS_SECONDS_ = 3600;

function listProductGroups() {
  getCurrentUser();

  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (err) { cache = null; }
  if (cache) {
    var hit = cache.get(PRODUCT_GROUPS_KEY_);
    if (hit) {
      try { return JSON.parse(hit); } catch (e) { /* corrupt entry, rebuilt below */ }
    }
  }

  var groups = readProductGroups_();
  if (cache) {
    try { cache.put(PRODUCT_GROUPS_KEY_, JSON.stringify(groups), PRODUCT_GROUPS_SECONDS_); }
    catch (e) { /* over the cache limit — correct either way, just recomputed next time */ }
  }
  return groups;
}

/** The scan itself. One column, by position, rather than an object per part. */
function readProductGroups_() {
  var sheet = getSheet_('Spares');
  if (!sheet) return [];
  var headers = getHeaders_(sheet, 'Spares');
  var lastRow = sheetRows_('Spares', sheet);
  if (lastRow < 2 || !headers.length) return [];

  var col = headers.indexOf('productGroup');
  if (col === -1) return [];

  var column = sheet.getRange(2, col + 1, lastRow - 1, 1).getValues();
  var seen = {};
  for (var r = 0; r < column.length; r++) {
    String(column[r][0] || '').split(/\s*[;,]\s*/).forEach(function (g) {
      if (g.trim()) seen[g.trim()] = true;
    });
  }
  return Object.keys(seen).sort();
}

async function suggestSpares(query, productModel, productGroup) {
  getCurrentUser();

  var q = String(query || '').trim().toLowerCase();
  var model = String(productModel || '').trim().toLowerCase();
  var group = String(productGroup || '').trim().toLowerCase();

  var compatibleIds = {};
  if (model) {
    (await readTable_('SpareCompatibility')).forEach(function (c) {
      if (String(c.active).toUpperCase() === 'FALSE') return;
      if (String(c.productModel).trim().toLowerCase() === model) {
        compatibleIds[String(c.spareId)] = { isServiceKit: String(c.isServiceKit).toUpperCase() === 'TRUE' };
      }
    });
  }

  // Match first, price second.
  //
  // Prices, on-hand and reservations used to be built for the entire catalogue before a
  // single part had been matched — a map over every price row in the sheet, and a sum over
  // every stock movement ever recorded, to decorate the fifty rows that survive. On a
  // catalogue of a few dozen parts nobody would have noticed. On thirteen thousand it is the
  // most expensive thing the counter does, and it does it on every search.
  //
  // The matching itself needs none of that: it looks at part number, description, category,
  // group and compatibility, all of which live on the part. So the filter and the cap run
  // first, and only the survivors are looked up.
  var matched = [];
  (await readTable_('Spares')).forEach(function (s) {
    if (String(s.active).toUpperCase() === 'FALSE') return;
    var id = String(s.id);
    // A part can sit in more than one group, so the stored value is a list.
    if (group && String(s.productGroup || '').toLowerCase().indexOf(group) === -1) return;

    var matchesText = !q ||
      String(s.partNo).toLowerCase().indexOf(q) !== -1 ||
      String(s.description).toLowerCase().indexOf(q) !== -1 ||
      String(s.category).toLowerCase().indexOf(q) !== -1;
    var isCompatible = !!compatibleIds[id];
    if (!matchesText && !isCompatible) return;
    if (q && !matchesText) return;

    matched.push({ spare: s, id: id, compatibilityConfirmed: isCompatible });
  });

  // Confirmed-compatible parts first; then alphabetically so results are stable. Sorting
  // and capping before the lookups is the whole point — the cap is what makes them cheap.
  var top = matched.sort(function (a, b) {
    if (a.compatibilityConfirmed !== b.compatibilityConfirmed) return a.compatibilityConfirmed ? -1 : 1;
    return String(a.spare.partNo).localeCompare(String(b.spare.partNo));
  }).slice(0, 50);

  if (!top.length) return [];

  var ids = top.map(function (m) { return m.id; });
  var prices = await priceMapFor_('Spare', null, ids);
  var onHand = await stockOnHandMap_('Spare', ids);
  var reserved = await stockReservedMap_('Spare', ids);

  return top.map(function (m) {
    var s = m.spare;
    var id = m.id;
    var levels = prices[id] || {};
    return {
      id: s.id,
      partNo: s.partNo,
      description: s.description,
      productGroup: s.productGroup,
      category: s.category,
      uom: s.uom,
      // The selling price, under a neutral name — this is what the quotation will carry.
      price: levels[SELLING_PRICE_LEVEL] ? levels[SELLING_PRICE_LEVEL].price : null,
      hsnCode: s.hsnCode,
      onHand: onHand[id] || 0,
      reserved: reserved[id] || 0,
      available: (onHand[id] || 0) - (reserved[id] || 0),
      compatibilityConfirmed: m.compatibilityConfirmed,
      isServiceKit: m.compatibilityConfirmed && compatibleIds[id].isServiceKit
    };
  });
}

async function saveSpareEnquiryItem(input) {
  var user = getCurrentUser();
  requireRole_(user, ENQUIRY_EDITORS);
  if (!input.spareEnquiryId) throw new Error('spareEnquiryId is required.');

  var qty = Number(input.qty);
  if (isNaN(qty) || qty <= 0) throw new Error('Quantity must be greater than zero.');

  var existing = (await readTable_('SpareEnquiryItems')).filter(function (i) {
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
    await updateRowById_('SpareEnquiryItems', 'id', input.id, record, 'Enquiry line updated');
  } else {
    record.id = generateId_('SEI-');
    await appendRow_('SpareEnquiryItems', record, 'Part identified on enquiry');
  }

  // Logging the first identified part moves the enquiry out of New by itself.
  var enquiry = (await readTable_('SpareEnquiries')).filter(function (e) {
    return String(e.id) === String(input.spareEnquiryId);
  })[0];
  if (enquiry && enquiry.status === 'New') {
    await updateRowById_('SpareEnquiries', 'id', enquiry.id, { status: 'Identifying' },
      'First part identified');
  }
  return record;
}

async function deleteSpareEnquiryItem(id) {
  var user = getCurrentUser();
  requireRole_(user, ENQUIRY_EDITORS);
  await deleteRowById_('SpareEnquiryItems', 'id', id, 'Enquiry line removed');
  return true;
}

/** Active lost reasons for the dropdown (FR-013). */
async function listLostReasons() {
  getCurrentUser();
  return (await readTable_('LostReasons'))
    .filter(function (r) { return String(r.active).toUpperCase() !== 'FALSE'; })
    .map(stripRow_);
}

/** Distinct compressor models seen in the catalog and in installed machines, for the picker. */
async function listKnownModels() {
  getCurrentUser();
  var seen = {};
  (await readTable_('Products')).forEach(function (p) {
    if (p.model) seen[String(p.model).trim()] = true;
  });
  (await readTable_('SpareCompatibility')).forEach(function (c) {
    if (c.productModel) seen[String(c.productModel).trim()] = true;
  });
  return Object.keys(seen).sort();
}

async function nextEnquiryNo_() {
  var yy = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyMM');
  var prefix = 'SE' + yy + '-';
  var highest = 0;
  (await readTable_('SpareEnquiries')).forEach(function (e) {
    var m = new RegExp('^' + prefix + '(\\\\d+)$').exec(String(e.enquiryNo || '').trim());
    if (m) highest = Math.max(highest, Number(m[1]));
  });
  return prefix + String(highest + 1).padStart(3, '0');
}

/**
 * The whole spare catalogue in one trip, lean enough to hold in the browser.
 *
 * `suggestSpares` runs the search on the server, which means a fresh Apps Script execution
 * and a dozen round trips to the Sheet for every keystroke. On a trial catalogue that felt
 * instant; on 3,500 parts it is seconds per letter, and picking five parts becomes a minute
 * of waiting. The compute is not the problem — the search itself is about 50 ms — the trips
 * are.
 *
 * So the catalogue comes down once when the picker opens and the typing happens in the
 * browser, where it costs nothing. Rows are plain arrays rather than objects: at 13,000 parts
 * the repeated field names are most of the payload, and dropping them roughly halves it.
 *
 * `suggestSpares` stays: the spare-enquiry screen still uses it, and it is the right shape
 * for one lookup.
 */
var SPARE_PICKER_COLS = ['id', 'partNo', 'description', 'productGroup', 'category', 'uom',
                         'hsnCode', 'price', 'available'];

async function sparePickerData(productModel, customerId) {
  getCurrentUser();

  var model = String(productModel || '').trim().toLowerCase();
  // What this customer calls each part, sent with the catalogue so searching by their code
  // stays as instant as searching by ours. Small: one row per part a customer has ever
  // ordered, not one per part in the catalogue.
  var theirCodes = {};
  var codeMap = await customerCodeMap_(customerId);
  Object.keys(codeMap).forEach(function (key) {
    if (key.indexOf('Spare|') !== 0) return;
    theirCodes[key.slice('Spare|'.length)] = codeMap[key].theirCode;
  });
  var compat = {};
  if (model) {
    (await readTable_('SpareCompatibility')).forEach(function (c) {
      if (String(c.active).toUpperCase() === 'FALSE') return;
      if (String(c.productModel).trim().toLowerCase() === model) {
        compat[String(c.spareId)] = String(c.isServiceKit).toUpperCase() === 'TRUE' ? 2 : 1;
      }
    });
  }

  var prices = await priceMapFor_('Spare');
  var onHand = await stockOnHandMap_('Spare');
  var reserved = await stockReservedMap_('Spare');

  // One block read, and no object built for a row that will not be sent.
  var sheet = getSheet_('Spares');
  var headers = getHeaders_(sheet, 'Spares');
  var lastRow = sheetRows_('Spares', sheet);
  var rows = [];
  if (lastRow > 1 && headers.length) {
    var ci = {};
    headers.forEach(function (h, i) { ci[h] = i; });
    var block = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    for (var r = 0; r < block.length; r++) {
      var row = block[r];
      if (String(row[ci.active]).toUpperCase() === 'FALSE') continue;
      var id = String(row[ci.id]);
      if (!id) continue;
      var levels = prices[id] || {};
      rows.push([
        id,
        String(row[ci.partNo] || ''),
        String(row[ci.description] || ''),
        String(row[ci.productGroup] || ''),
        String(row[ci.category] || ''),
        String(row[ci.uom] || 'Nos'),
        String(row[ci.hsnCode] || ''),
        levels[SELLING_PRICE_LEVEL] ? levels[SELLING_PRICE_LEVEL].price : null,
        (onHand[id] || 0) - (reserved[id] || 0)
      ]);
    }
  }

  return { cols: SPARE_PICKER_COLS, rows: rows, compat: compat, count: rows.length,
           theirCodes: theirCodes };
}

/**
 * Everything the Spare Sales screen needs, in one call.
 *
 * Opening it used to cost six separate calls — the enquiry list, the customers, the lost
 * reasons, the known models, the config lists and the user list. Apps Script charges for a
 * round trip whether it carries one row or ten thousand, and those six were paid one after
 * another before the screen drew anything. Gathered here they cost one, and the tabs they
 * share — Customers above all — are read once between them rather than once each.
 */
async function spareSalesScreen(options) {
  return {
    enquiries: await listSpareEnquiries(options || {}),
    customers: await listCustomers(),
    lostReasons: await listLostReasons(),
    knownModels: await listKnownModels()
  };
}
