/**
 * Opening-balance import from Tally — customers, stock on hand, and open receivables.
 *
 * PMT run Tally Prime and have done for years. The customer ledger, the item masters and the
 * outstanding invoices already exist there, and asking anyone to re-key them would be both
 * tedious and a fresh source of error. Every one of these is a standard Tally report with a
 * built-in export, so the job here is to accept those exports rather than to make people type.
 *
 * The open-receivables import is the one that is easy to skip and shouldn't be. Without it the
 * ERP believes every customer owes nothing on day one: the credit check waves through orders
 * it should stop, the ageing report is empty, and the dashboard reports zero outstanding — all
 * of which are confidently wrong rather than merely missing.
 *
 * Every import here follows the same shape as the catalog and receipt imports already in the
 * system: parse and validate changing nothing, hand back exactly what would happen and what
 * would be rejected, and only write when the caller confirms. Each one also returns a
 * reconciliation total to be checked against the Tally report it came from — if the two
 * numbers disagree, that is worth knowing on day one, not in three weeks.
 */

var TALLY_IMPORT_ROLES = [ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

var TALLY_IMPORT_SPECS = {
  Customer: {
    label: 'Customers',
    source: 'Tally: List of Accounts / Sundry Debtors, exported as CSV',
    columns: ['name', 'gstin', 'creditLimit', 'creditDays', 'paymentTerms', 'industry',
      'territory', 'pan', 'notes'],
    required: ['name'],
    example: 'Bharat Forge Ltd,27AAACB1234C1ZX,500000,30,NET30,Engineering,Pune,AAACB1234C,'
  },
  OpeningStock: {
    label: 'Opening Stock',
    source: 'Tally: Stock Summary closing balances, or a physical stock count',
    columns: ['itemType', 'itemCode', 'qty', 'warehouseCode', 'binId', 'notes'],
    required: ['itemCode', 'qty'],
    example: 'Spare,ELG-1234567,40,MAIN,,'
  },
  OpenInvoice: {
    label: 'Open Receivables',
    source: 'Tally: Bills Receivable / Outstandings, exported as CSV',
    columns: ['invoiceNo', 'invoiceDate', 'dueDate', 'customerName', 'gstin', 'amount',
      'amountReceived', 'businessStream', 'notes'],
    required: ['invoiceNo', 'invoiceDate', 'customerName', 'amount'],
    example: 'INV/2526/0412,2026-07-14,2026-08-13,Bharat Forge Ltd,27AAACB1234C1ZX,400000,0,Spare,'
  }
};

function getTallyImportSpecs() {
  var user = getCurrentUser();
  requireRole_(user, TALLY_IMPORT_ROLES);
  return Object.keys(TALLY_IMPORT_SPECS).map(function (key) {
    var spec = TALLY_IMPORT_SPECS[key];
    return {
      key: key,
      label: spec.label,
      source: spec.source,
      header: spec.columns.join(','),
      required: spec.required,
      example: spec.example
    };
  });
}

/** Dry run. Nothing is written; the caller sees exactly what would happen. */
function previewTallyImport(kind, csvText) {
  var user = getCurrentUser();
  requireRole_(user, TALLY_IMPORT_ROLES);
  return analyseTallyImport_(kind, csvText);
}

function commitTallyImport(kind, csvText) {
  var user = getCurrentUser();
  requireRole_(user, TALLY_IMPORT_ROLES);

  var analysis = analyseTallyImport_(kind, csvText);
  if (!analysis.valid.length) {
    throw new Error('Nothing to import — every row was rejected. ' +
      (analysis.errors[0] ? 'First problem: ' + analysis.errors[0].message : ''));
  }

  if (kind === 'Customer') commitCustomerImport_(analysis, user);
  else if (kind === 'OpeningStock') commitOpeningStockImport_(analysis, user);
  else if (kind === 'OpenInvoice') commitOpenInvoiceImport_(analysis, user);
  else throw new Error('Unknown import type.');

  audit_('Import', TALLY_IMPORT_SPECS[kind].label, '', 'rowCount', '', analysis.valid.length,
    'Tally opening import: ' + analysis.valid.length + ' applied, ' +
    analysis.errors.length + ' rejected');

  return {
    kind: kind,
    imported: analysis.valid.length,
    created: analysis.created,
    updated: analysis.updated,
    rejected: analysis.errors.length,
    reconciliation: analysis.reconciliation,
    errors: analysis.errors.slice(0, 50)
  };
}

// ------------------------------------------------------------------------------- analysis

function analyseTallyImport_(kind, csvText) {
  var spec = TALLY_IMPORT_SPECS[kind];
  if (!spec) throw new Error('Unknown import type.');

  var rows = parseCsv_(csvText).filter(function (r) {
    return r.some(function (c) { return String(c).trim() !== ''; });
  });
  if (rows.length < 2) throw new Error('The file needs a header row and at least one data row.');

  var headers = rows[0].map(function (h) { return String(h).trim(); });
  var missing = spec.required.filter(function (c) { return headers.indexOf(c) === -1; });
  if (missing.length) {
    throw new Error('Missing required column(s): ' + missing.join(', ') +
      '. Expected header: ' + spec.columns.join(', '));
  }

  var reader = function (cells) {
    return function (col) {
      var idx = headers.indexOf(col);
      return idx === -1 ? '' : String(cells[idx] === undefined ? '' : cells[idx]).trim();
    };
  };

  if (kind === 'Customer') return analyseCustomers_(rows, reader);
  if (kind === 'OpeningStock') return analyseOpeningStock_(rows, reader);
  return analyseOpenInvoices_(rows, reader);
}

/** Money out of Tally arrives as "4,00,000.00" or "400000.00 Dr" — strip it back to a number. */
function parseTallyAmount_(raw) {
  var text = String(raw || '').replace(/[,\s]/g, '').replace(/(Dr|Cr)$/i, '');
  var n = Number(text);
  return isNaN(n) ? null : n;
}

/** Tally exports dates in several shapes; accept the common ones and normalise to ISO. */
function parseTallyDate_(raw) {
  var text = String(raw || '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  var dmy = /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/.exec(text);
  if (dmy) {
    var year = dmy[3].length === 2 ? '20' + dmy[3] : dmy[3];
    return year + '-' + ('0' + dmy[2]).slice(-2) + '-' + ('0' + dmy[1]).slice(-2);
  }

  var months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  var dMon = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{2,4})$/.exec(text);
  if (dMon) {
    var mm = months[dMon[2].toLowerCase()];
    if (mm) {
      var yr = dMon[3].length === 2 ? '20' + dMon[3] : dMon[3];
      return yr + '-' + mm + '-' + ('0' + dMon[1]).slice(-2);
    }
  }
  return null;
}

// ------------------------------------------------------------------------------ customers

function analyseCustomers_(rows, reader) {
  var existing = readTable_('Customers');
  var byGstin = {};
  var byName = {};
  existing.forEach(function (c) {
    if (String(c.gstin || '').trim()) byGstin[String(c.gstin).trim().toUpperCase()] = c;
    byName[String(c.name || '').trim().toLowerCase()] = c;
  });

  var valid = [];
  var errors = [];
  var seenInFile = {};
  var created = 0;
  var updated = 0;

  for (var i = 1; i < rows.length; i++) {
    var get = reader(rows[i]);
    var lineNo = i + 1;

    var name = get('name');
    if (!name) { errors.push({ line: lineNo, key: '', message: 'No customer name.' }); continue; }

    var gstin = get('gstin').toUpperCase();
    var fileKey = (gstin || name.toLowerCase());
    if (seenInFile[fileKey]) {
      errors.push({ line: lineNo, key: name, message: 'Appears more than once in this file.' });
      continue;
    }

    // GSTIN identifies a company; name is the fallback when Tally has no GSTIN on the ledger.
    var match = (gstin && byGstin[gstin]) || byName[name.toLowerCase()];

    var creditLimit = get('creditLimit') ? parseTallyAmount_(get('creditLimit')) : '';
    if (creditLimit === null) {
      errors.push({ line: lineNo, key: name, message: 'Credit limit is not a number.' });
      continue;
    }
    var creditDays = get('creditDays') ? Number(get('creditDays')) : '';
    if (creditDays !== '' && isNaN(creditDays)) {
      errors.push({ line: lineNo, key: name, message: 'Credit days is not a number.' });
      continue;
    }

    if (match) updated++; else created++;
    // Only now, once the row is known good — a rejected row must not consume the slot and
    // make a later, valid row for the same customer look like a duplicate.
    seenInFile[fileKey] = true;

    valid.push({
      line: lineNo,
      existingId: match ? match.id : '',
      action: match ? 'Update' : 'Create',
      name: name,
      gstin: gstin,
      pan: get('pan').toUpperCase(),
      creditLimit: creditLimit,
      creditDays: creditDays,
      paymentTerms: get('paymentTerms'),
      industry: get('industry'),
      territory: get('territory'),
      notes: get('notes')
    });
  }

  return {
    kind: 'Customer',
    totalRows: rows.length - 1,
    valid: valid,
    errors: errors,
    created: created,
    updated: updated,
    reconciliation: {
      label: 'Customers in the file',
      count: valid.length,
      detail: created + ' new, ' + updated + ' matched to an existing record'
    }
  };
}

function commitCustomerImport_(analysis, user) {
  analysis.valid.forEach(function (row) {
    var record = {
      name: row.name,
      gstin: row.gstin,
      pan: row.pan,
      industry: row.industry,
      territory: row.territory,
      paymentTerms: row.paymentTerms,
      creditLimit: row.creditLimit,
      creditDays: row.creditDays,
      active: 'TRUE'
    };

    if (row.existingId) {
      // Only fill what Tally actually knows. Contacts, addresses and the assigned
      // salesperson are the ERP's own and are never cleared by an import.
      updateRowById_('Customers', 'id', row.existingId, record, 'Updated from Tally import');
    } else {
      record.id = generateId_('CUS-');
      record.customerCode = nextSeriesNo_('Customers', 'customerCode', 'C');
      record.legalName = row.name;
      record.brand = 'ELGI';
      record.notes = row.notes;
      record.createdAt = todayIso_();
      record.createdBy = user.email;
      appendRow_('Customers', record, 'Imported from Tally');
    }
  });
}

// -------------------------------------------------------------------------- opening stock

function analyseOpeningStock_(rows, reader) {
  var spares = {};
  readTable_('Spares').forEach(function (s) {
    spares[String(s.partNo || '').trim().toUpperCase()] = s;
  });
  var products = {};
  readTable_('Products').forEach(function (p) {
    products[String(p.productCode || '').trim().toUpperCase()] = p;
  });

  // Re-running an opening import must not double the stock, so an item that already has an
  // Opening movement is refused rather than added to.
  var alreadyOpened = {};
  readTable_('StockMovements').forEach(function (m) {
    if (m.movementType === 'Opening') alreadyOpened[m.itemType + ':' + String(m.itemId)] = true;
  });

  var warehouses = {};
  readTable_('Warehouses').forEach(function (w) {
    warehouses[String(w.code || '').trim().toUpperCase()] = w;
  });

  var valid = [];
  var errors = [];
  var seenInFile = {};
  var totalQty = 0;

  for (var i = 1; i < rows.length; i++) {
    var get = reader(rows[i]);
    var lineNo = i + 1;

    var code = get('itemCode').toUpperCase();
    if (!code) { errors.push({ line: lineNo, key: '', message: 'No item code.' }); continue; }

    var declaredType = get('itemType');
    var item = null;
    var itemType = '';
    if (declaredType === 'Product') { item = products[code]; itemType = 'Product'; }
    else if (declaredType === 'Spare') { item = spares[code]; itemType = 'Spare'; }
    else {
      // No type given — look in both, but refuse if the code is ambiguous.
      if (spares[code] && products[code]) {
        errors.push({ line: lineNo, key: code,
          message: 'That code exists as both a spare and a product. Set itemType.' });
        continue;
      }
      if (spares[code]) { item = spares[code]; itemType = 'Spare'; }
      else if (products[code]) { item = products[code]; itemType = 'Product'; }
    }

    if (!item) {
      errors.push({ line: lineNo, key: code,
        message: 'No spare or product with that code. Import the catalog first.' });
      continue;
    }

    var key = itemType + ':' + String(item.id);
    if (alreadyOpened[key]) {
      errors.push({ line: lineNo, key: code,
        message: 'This item already has an opening balance. Use a stock adjustment instead.' });
      continue;
    }
    if (seenInFile[key]) {
      errors.push({ line: lineNo, key: code, message: 'Appears more than once in this file.' });
      continue;
    }

    var qty = parseTallyAmount_(get('qty'));
    if (qty === null || qty < 0) {
      errors.push({ line: lineNo, key: code, message: 'Quantity is not a number, or is negative.' });
      continue;
    }
    if (qty === 0) {
      errors.push({ line: lineNo, key: code, message: 'Quantity is zero — nothing to open with.' });
      continue;
    }

    var whCode = get('warehouseCode').toUpperCase();
    var warehouse = whCode ? warehouses[whCode] : null;
    if (whCode && !warehouse) {
      errors.push({ line: lineNo, key: code, message: 'No warehouse with code ' + whCode + '.' });
      continue;
    }

    totalQty += qty;
    seenInFile[key] = true;
    valid.push({
      line: lineNo,
      itemType: itemType,
      itemId: item.id,
      itemCode: code,
      description: item.description || item.model || '',
      qty: qty,
      warehouseId: warehouse ? warehouse.id : '',
      binId: get('binId'),
      notes: get('notes')
    });
  }

  return {
    kind: 'OpeningStock',
    totalRows: rows.length - 1,
    valid: valid,
    errors: errors,
    created: valid.length,
    updated: 0,
    reconciliation: {
      label: 'Total quantity to be opened',
      count: valid.length,
      total: roundMoney_(totalQty),
      detail: valid.length + ' item(s), ' + roundMoney_(totalQty) + ' units in total'
    }
  };
}

function commitOpeningStockImport_(analysis, user) {
  analysis.valid.forEach(function (row) {
    appendRow_('StockMovements', {
      id: generateId_('SM-'),
      timestamp: new Date().toISOString(),
      movementDate: todayIso_(),
      itemType: row.itemType,
      itemId: row.itemId,
      itemCode: row.itemCode,
      movementType: 'Opening',
      qty: row.qty,
      warehouseId: row.warehouseId,
      binId: row.binId,
      serialNo: '',
      referenceType: 'Opening Import',
      referenceId: '',
      enteredBy: user.email,
      notes: row.notes || 'Opening balance imported from Tally'
    });
  });
}

// ------------------------------------------------------------------------ open receivables

function analyseOpenInvoices_(rows, reader) {
  var customers = readTable_('Customers');
  var byGstin = {};
  var byName = {};
  customers.forEach(function (c) {
    if (String(c.gstin || '').trim()) byGstin[String(c.gstin).trim().toUpperCase()] = c;
    byName[String(c.name || '').trim().toLowerCase()] = c;
  });

  var existingNos = {};
  readTable_('Invoices').forEach(function (inv) {
    existingNos[String(inv.invoiceNo || '').trim().toUpperCase()] = true;
  });

  var valid = [];
  var errors = [];
  var seenInFile = {};
  var totalOutstanding = 0;

  for (var i = 1; i < rows.length; i++) {
    var get = reader(rows[i]);
    var lineNo = i + 1;

    var invoiceNo = get('invoiceNo');
    if (!invoiceNo) { errors.push({ line: lineNo, key: '', message: 'No invoice number.' }); continue; }

    var noKey = invoiceNo.toUpperCase();
    if (existingNos[noKey]) {
      errors.push({ line: lineNo, key: invoiceNo, message: 'That invoice number is already in the ERP.' });
      continue;
    }
    if (seenInFile[noKey]) {
      errors.push({ line: lineNo, key: invoiceNo, message: 'Appears more than once in this file.' });
      continue;
    }

    var gstin = get('gstin').toUpperCase();
    var custName = get('customerName');
    var customer = (gstin && byGstin[gstin]) || byName[custName.toLowerCase()];
    if (!customer) {
      errors.push({ line: lineNo, key: invoiceNo,
        message: 'No customer matching "' + custName + '". Import customers first.' });
      continue;
    }

    var invoiceDate = parseTallyDate_(get('invoiceDate'));
    if (!invoiceDate) {
      errors.push({ line: lineNo, key: invoiceNo,
        message: 'Invoice date is missing or not a date we recognise.' });
      continue;
    }

    var amount = parseTallyAmount_(get('amount'));
    if (amount === null || amount <= 0) {
      errors.push({ line: lineNo, key: invoiceNo, message: 'Amount is not a positive number.' });
      continue;
    }

    var received = get('amountReceived') ? parseTallyAmount_(get('amountReceived')) : 0;
    if (received === null || received < 0) {
      errors.push({ line: lineNo, key: invoiceNo, message: 'Amount received is not a number.' });
      continue;
    }
    if (received > amount) {
      errors.push({ line: lineNo, key: invoiceNo,
        message: 'More received than the invoice is worth.' });
      continue;
    }

    var dueDate = get('dueDate') ? parseTallyDate_(get('dueDate')) : '';
    if (dueDate === null) {
      errors.push({ line: lineNo, key: invoiceNo, message: 'Due date is not a date we recognise.' });
      continue;
    }
    if (!dueDate) {
      var days = customer.creditDays === '' || customer.creditDays === null
        ? 0 : Number(customer.creditDays);
      dueDate = addDays_(invoiceDate, days);
    }

    // Accept the short words people actually type in a spreadsheet, store the canonical value.
    var streamRaw = get('businessStream').toLowerCase();
    var stream = streamRaw.indexOf('compressor') === 0 ? STREAM_COMPRESSOR : STREAM_SPARE;

    totalOutstanding += (amount - received);
    seenInFile[noKey] = true;
    valid.push({
      line: lineNo,
      invoiceNo: invoiceNo,
      invoiceDate: invoiceDate,
      dueDate: dueDate,
      customerId: customer.id,
      customerName: customer.name,
      businessStream: stream,
      amount: roundMoney_(amount),
      received: roundMoney_(received),
      balance: roundMoney_(amount - received),
      paymentTerms: customer.paymentTerms || '',
      notes: get('notes')
    });
  }

  return {
    kind: 'OpenInvoice',
    totalRows: rows.length - 1,
    valid: valid,
    errors: errors,
    created: valid.length,
    updated: 0,
    reconciliation: {
      label: 'Total outstanding to be imported',
      count: valid.length,
      total: roundMoney_(totalOutstanding),
      detail: 'Check this against Tally’s own receivables total before going live.'
    }
  };
}

/**
 * Opening invoices carry no order, dispatch or lines — the goods went out before the ERP
 * existed. They are marked as already synced to Tally, because Tally is precisely where they
 * came from, and a receipt against one behaves exactly like a receipt against any other
 * invoice, so ageing and collections work from day one.
 */
function commitOpenInvoiceImport_(analysis, user) {
  analysis.valid.forEach(function (row) {
    var invoiceId = generateId_('INV-');

    appendRow_('Invoices', {
      id: invoiceId,
      invoiceNo: row.invoiceNo,
      invoiceDate: row.invoiceDate,
      salesOrderId: '',
      dispatchId: '',
      customerId: row.customerId,
      billingAddressId: '',
      businessStream: row.businessStream,
      brand: 'ELGI',
      subtotal: row.amount,
      discountAmt: 0,
      taxAmt: 0,
      freight: 0,
      grand: row.amount,
      amountReceived: row.received,
      paymentTerms: row.paymentTerms,
      dueDate: row.dueDate,
      warrantyTerms: '',
      status: 'Issued',
      tallySyncStatus: 'Synced',
      tallySyncDate: todayIso_(),
      tallySyncError: '',
      notes: row.notes || 'Opening balance imported from Tally',
      createdAt: todayIso_(),
      createdBy: user.email
    }, 'Opening receivable imported from Tally');

    // A part-paid opening invoice needs a matching receipt, or the receipts ledger and the
    // invoice's amountReceived disagree the moment anyone opens the customer statement.
    if (row.received > 0) {
      appendRow_('Receipts', {
        id: generateId_('RCP-'),
        receiptNo: 'OPEN-' + row.invoiceNo,
        receiptDate: row.invoiceDate,
        customerId: row.customerId,
        invoiceId: invoiceId,
        amount: row.received,
        mode: 'Adjustment',
        reference: 'Opening balance',
        tallyRef: '',
        importedDate: todayIso_(),
        notes: 'Received before go-live, imported with the opening balance',
        createdAt: todayIso_(),
        createdBy: user.email
      });
    }
  });
}
