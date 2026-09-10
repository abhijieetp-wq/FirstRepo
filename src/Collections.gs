/**
 * Collections and receivables — M16.
 *
 * Ageing is derived, never stored. An "outstanding" column that someone updates by hand is
 * wrong within a day; here every figure is computed from issued invoices minus the receipts
 * posted against them, so the ageing report and the credit check can never disagree.
 *
 * Follow-ups exist to make a promise into a record. When a customer commits to a date and an
 * amount, that commitment is stored and then judged against what actually arrived — a
 * customer who breaks three commitments in a row is a different problem from one who is
 * simply slow, and only the register can tell them apart.
 *
 * Receipts reach the ERP three ways, in descending order of how much we trust the connection:
 * pulled from Tally, imported from a CSV export of the Tally ledger, or typed in. The last
 * two work with Tally switched off entirely (decision D3), which is why collections is not
 * blocked on an integration we cannot test.
 */

var COLLECTION_ROLES = [ROLES.SALES_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];
var RECEIPT_DELETE_ROLES = [ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

var RECEIPT_MODES = ['NEFT/RTGS', 'Cheque', 'Cash', 'UPI', 'Adjustment', 'Other'];

/** Ageing buckets, in days overdue. `null` upper bound means "and beyond". */
var AGEING_BUCKETS = [
  { key: 'notDue', label: 'Not Due', from: null, to: 0 },
  { key: 'd0_30', label: '1–30 Days', from: 1, to: 30 },
  { key: 'd31_60', label: '31–60 Days', from: 31, to: 60 },
  { key: 'd61_90', label: '61–90 Days', from: 61, to: 90 },
  { key: 'd90plus', label: '90+ Days', from: 91, to: null }
];

var FOLLOWUP_STATUSES = ['Open', 'Promised', 'Broken', 'Closed'];

/**
 * Every issued invoice with a balance, aged. This is the one place outstanding is calculated;
 * the dashboard, the credit check and the customer statement all read it rather than
 * re-implementing the arithmetic slightly differently.
 */
function getReceivables(options) {
  getCurrentUser();
  var opts = options || {};
  var today = todayIso_();

  var customers = {};
  readTable_('Customers').forEach(function (c) {
    customers[String(c.id)] = { name: c.name, ownerEmail: c.assignedSalesperson || '' };
  });

  var receivedByInvoice = {};
  readTable_('Receipts').forEach(function (r) {
    var key = String(r.invoiceId);
    receivedByInvoice[key] = (receivedByInvoice[key] || 0) + (Number(r.amount) || 0);
  });

  // The latest open follow-up per invoice — what the collector needs to see on the row.
  var followupByInvoice = {};
  readTable_('CollectionFollowups').forEach(function (f) {
    if (f.status === 'Closed') return;
    var key = String(f.invoiceId);
    var current = followupByInvoice[key];
    if (!current || String(f.contactDate) > String(current.contactDate)) {
      followupByInvoice[key] = f;
    }
  });

  return readTable_('Invoices')
    .filter(function (inv) { return inv.status === 'Issued'; })
    .map(function (inv) {
      var received = receivedByInvoice[String(inv.id)] || 0;
      var balance = roundMoney_((Number(inv.grand) || 0) - received);
      var overdueDays = inv.dueDate ? daysBetween_(inv.dueDate, today) : 0;
      var followup = followupByInvoice[String(inv.id)];
      var customer = customers[String(inv.customerId)] || {};

      return {
        invoiceId: inv.id,
        invoiceNo: inv.invoiceNo,
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        customerId: inv.customerId,
        customerName: customer.name || '',
        ownerEmail: customer.ownerEmail || '',
        businessStream: inv.businessStream,
        grand: roundMoney_(Number(inv.grand) || 0),
        receivedAmt: roundMoney_(received),
        balanceAmt: balance,
        overdueDays: overdueDays > 0 ? overdueDays : 0,
        bucket: ageingBucketFor_(overdueDays),
        lastContactDate: followup ? followup.contactDate : '',
        commitmentAmount: followup ? Number(followup.commitmentAmount) || 0 : 0,
        commitmentDate: followup ? followup.commitmentDate : '',
        commitmentOverdue: !!(followup && followup.commitmentDate &&
          daysBetween_(followup.commitmentDate, today) > 0 && followup.commitmentMet !== 'Yes'),
        nextFollowupDate: followup ? followup.nextFollowupDate : '',
        followupStatus: followup ? followup.status : ''
      };
    })
    .filter(function (r) {
      if (!opts.includeSettled && r.balanceAmt <= 0.5) return false;
      if (opts.customerId && String(r.customerId) !== String(opts.customerId)) return false;
      if (opts.bucket && r.bucket !== opts.bucket) return false;
      if (opts.overdueOnly && r.overdueDays <= 0) return false;
      return true;
    })
    .sort(function (a, b) { return b.overdueDays - a.overdueDays; });
}

function ageingBucketFor_(overdueDays) {
  var days = Number(overdueDays) || 0;
  for (var i = 0; i < AGEING_BUCKETS.length; i++) {
    var b = AGEING_BUCKETS[i];
    if (b.from !== null && days < b.from) continue;
    if (b.to !== null && days > b.to) continue;
    return b.key;
  }
  return 'd90plus';
}

/**
 * Ageing summarised by customer (FR-051). The per-customer view is the one collections
 * actually works from — you chase a customer, not an invoice.
 */
function getAgeingByCustomer() {
  getCurrentUser();

  var rows = getReceivables({});
  var limits = {};
  readTable_('Customers').forEach(function (c) {
    limits[String(c.id)] = {
      creditLimit: c.creditLimit === '' || c.creditLimit === null ? null : Number(c.creditLimit),
      creditDays: c.creditDays === '' ? null : Number(c.creditDays)
    };
  });

  var byCustomer = {};
  rows.forEach(function (r) {
    var key = String(r.customerId);
    if (!byCustomer[key]) {
      byCustomer[key] = {
        customerId: r.customerId,
        customerName: r.customerName,
        ownerEmail: r.ownerEmail,
        creditLimit: (limits[key] || {}).creditLimit,
        creditDays: (limits[key] || {}).creditDays,
        invoiceCount: 0,
        totalOutstanding: 0,
        oldestOverdueDays: 0,
        commitmentAmount: 0,
        brokenCommitments: 0
      };
      AGEING_BUCKETS.forEach(function (b) { byCustomer[key][b.key] = 0; });
    }
    var row = byCustomer[key];
    row.invoiceCount += 1;
    row.totalOutstanding += r.balanceAmt;
    row[r.bucket] += r.balanceAmt;
    row.oldestOverdueDays = Math.max(row.oldestOverdueDays, r.overdueDays);
    row.commitmentAmount += r.commitmentAmount;
    if (r.commitmentOverdue) row.brokenCommitments += 1;
  });

  return Object.keys(byCustomer)
    .map(function (k) {
      var row = byCustomer[k];
      row.totalOutstanding = roundMoney_(row.totalOutstanding);
      row.commitmentAmount = roundMoney_(row.commitmentAmount);
      AGEING_BUCKETS.forEach(function (b) { row[b.key] = roundMoney_(row[b.key]); });
      row.overLimit = row.creditLimit !== null && row.totalOutstanding > row.creditLimit;
      return row;
    })
    .sort(function (a, b) { return b.totalOutstanding - a.totalOutstanding; });
}

/** Totals per bucket — the strip across the top of the collections screen. */
function getAgeingSummary() {
  getCurrentUser();
  var rows = getReceivables({});

  var summary = { totalOutstanding: 0, overdueAmount: 0, invoiceCount: rows.length, buckets: [] };
  var totals = {};
  AGEING_BUCKETS.forEach(function (b) { totals[b.key] = { amount: 0, count: 0 }; });

  rows.forEach(function (r) {
    summary.totalOutstanding += r.balanceAmt;
    if (r.overdueDays > 0) summary.overdueAmount += r.balanceAmt;
    totals[r.bucket].amount += r.balanceAmt;
    totals[r.bucket].count += 1;
  });

  summary.totalOutstanding = roundMoney_(summary.totalOutstanding);
  summary.overdueAmount = roundMoney_(summary.overdueAmount);
  summary.buckets = AGEING_BUCKETS.map(function (b) {
    return {
      key: b.key, label: b.label,
      amount: roundMoney_(totals[b.key].amount),
      count: totals[b.key].count
    };
  });
  return summary;
}

/** One customer's statement: their open invoices and the receipts that paid the rest. */
function getCustomerStatement(customerId) {
  getCurrentUser();

  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(customerId);
  })[0];
  if (!customer) throw new Error('Customer not found.');

  var invoices = getReceivables({ customerId: customerId, includeSettled: true });
  var receipts = readTable_('Receipts')
    .filter(function (r) { return String(r.customerId) === String(customerId); })
    .map(stripRow_)
    .sort(function (a, b) { return String(b.receiptDate).localeCompare(String(a.receiptDate)); });

  var followups = listFollowups({ customerId: customerId });

  var outstanding = invoices.reduce(function (s, i) {
    return s + (i.balanceAmt > 0 ? i.balanceAmt : 0);
  }, 0);

  return {
    customerId: customerId,
    customerName: customer.name,
    creditLimit: customer.creditLimit === '' ? null : Number(customer.creditLimit),
    creditDays: customer.creditDays === '' ? null : Number(customer.creditDays),
    paymentTerms: customer.paymentTerms || '',
    invoices: invoices,
    receipts: receipts,
    followups: followups,
    totalOutstanding: roundMoney_(outstanding),
    totalReceived: roundMoney_(receipts.reduce(function (s, r) { return s + (Number(r.amount) || 0); }, 0))
  };
}

// ------------------------------------------------------------------------------- receipts

/**
 * Records a payment. Receipts are append-only and never edited — a wrong one is reversed with
 * a negative entry, so the trail of what was believed and when survives.
 */
function saveReceipt(input) {
  var user = getCurrentUser();
  requireRole_(user, COLLECTION_ROLES);

  var amount = Number(input.amount);
  if (isNaN(amount) || amount === 0) throw new Error('Enter the amount received.');

  var invoice = readTable_('Invoices').filter(function (inv) {
    return String(inv.id) === String(input.invoiceId);
  })[0];
  if (!invoice) throw new Error('Pick the invoice this payment settles.');
  if (invoice.status === 'Cancelled') throw new Error('That invoice was cancelled.');

  var alreadyReceived = readTable_('Receipts').reduce(function (s, r) {
    return String(r.invoiceId) === String(invoice.id) ? s + (Number(r.amount) || 0) : s;
  }, 0);
  var balance = roundMoney_((Number(invoice.grand) || 0) - alreadyReceived);
  if (amount > balance + 0.5) {
    throw new Error('That is more than the ' + roundMoney_(balance) + ' outstanding on ' +
      invoice.invoiceNo + '. Record the excess against the invoice it belongs to.');
  }

  var receiptId = generateId_('RCP-');
  appendRow_('Receipts', {
    id: receiptId,
    receiptNo: String(input.receiptNo || '').trim() || nextSeriesNo_('Receipts', 'receiptNo', 'RCP'),
    receiptDate: String(input.receiptDate || todayIso_()).slice(0, 10),
    customerId: invoice.customerId,
    invoiceId: invoice.id,
    amount: roundMoney_(amount),
    mode: String(input.mode || '').trim(),
    reference: String(input.reference || '').trim(),
    tallyRef: String(input.tallyRef || '').trim(),
    importedDate: '',
    notes: String(input.notes || '').trim(),
    createdAt: todayIso_(),
    createdBy: user.email
  }, 'Receipt against ' + invoice.invoiceNo);

  syncInvoiceReceipts_(invoice.id);
  settleCommitments_(invoice.id);
  return getReceipt_(receiptId);
}

/** Reverses a receipt with an offsetting entry rather than deleting the original. */
function reverseReceipt(receiptId, reason) {
  var user = getCurrentUser();
  requireRole_(user, RECEIPT_DELETE_ROLES);
  if (!String(reason || '').trim()) throw new Error('A reason is required to reverse a receipt.');

  var receipt = readTable_('Receipts').filter(function (r) {
    return String(r.id) === String(receiptId);
  })[0];
  if (!receipt) throw new Error('Receipt not found.');

  appendRow_('Receipts', {
    id: generateId_('RCP-'),
    receiptNo: receipt.receiptNo + '-REV',
    receiptDate: todayIso_(),
    customerId: receipt.customerId,
    invoiceId: receipt.invoiceId,
    amount: -roundMoney_(Number(receipt.amount) || 0),
    mode: 'Adjustment',
    reference: 'Reversal of ' + receipt.receiptNo,
    tallyRef: '',
    importedDate: '',
    notes: reason,
    createdAt: todayIso_(),
    createdBy: user.email
  }, 'Receipt reversed: ' + reason);

  syncInvoiceReceipts_(receipt.invoiceId);
  return listReceipts({});
}

function listReceipts(options) {
  getCurrentUser();
  var opts = options || {};

  var customerNames = {};
  readTable_('Customers').forEach(function (c) { customerNames[String(c.id)] = c.name; });
  var invoiceNos = {};
  readTable_('Invoices').forEach(function (i) { invoiceNos[String(i.id)] = i.invoiceNo; });

  return readTable_('Receipts')
    .filter(function (r) {
      if (opts.customerId && String(r.customerId) !== String(opts.customerId)) return false;
      if (opts.fromDate && String(r.receiptDate) < opts.fromDate) return false;
      if (opts.toDate && String(r.receiptDate) > opts.toDate) return false;
      return true;
    })
    .map(function (r) {
      var row = stripRow_(r);
      row.customerName = customerNames[String(row.customerId)] || '';
      row.invoiceNo = invoiceNos[String(row.invoiceId)] || '';
      row.amount = roundMoney_(Number(row.amount) || 0);
      return row;
    })
    .sort(function (a, b) { return String(b.receiptDate).localeCompare(String(a.receiptDate)); });
}

function getReceipt_(id) {
  var r = readTable_('Receipts').filter(function (x) { return String(x.id) === String(id); })[0];
  return r ? stripRow_(r) : null;
}

/**
 * Recomputes the cached `amountReceived` on an invoice from the receipts ledger, and closes
 * the order once nothing is owed. The ledger is the truth; this column exists only so the
 * invoice list does not have to sum receipts for every row.
 */
function syncInvoiceReceipts_(invoiceId) {
  var total = readTable_('Receipts').reduce(function (s, r) {
    return String(r.invoiceId) === String(invoiceId) ? s + (Number(r.amount) || 0) : s;
  }, 0);

  var invoice = readTable_('Invoices').filter(function (inv) {
    return String(inv.id) === String(invoiceId);
  })[0];
  if (!invoice) return;

  updateRowById_('Invoices', 'id', invoiceId, { amountReceived: roundMoney_(total) },
    'Receipts total recalculated');

  var settled = roundMoney_((Number(invoice.grand) || 0) - total) <= 0.5;
  if (!settled) return;

  // Fully paid and nothing left to ship — the order's work is done.
  var order = readTable_('SalesOrders').filter(function (o) {
    return String(o.id) === String(invoice.salesOrderId);
  })[0];
  if (!order || order.orderStatus !== 'Invoiced') return;
  if (outstandingOrderQty_(order.id, null) > 0) return;

  var unpaid = readTable_('Invoices').some(function (other) {
    if (String(other.salesOrderId) !== String(order.id)) return false;
    if (other.status !== 'Issued') return false;
    if (String(other.id) === String(invoiceId)) return false;
    return roundMoney_((Number(other.grand) || 0) - (Number(other.amountReceived) || 0)) > 0.5;
  });
  if (unpaid) return;

  if ((ORDER_TRANSITIONS[order.orderStatus] || []).indexOf('Closed') !== -1) {
    updateRowById_('SalesOrders', 'id', order.id, {
      orderStatus: 'Closed',
      closedDate: todayIso_()
    }, 'Fully shipped and fully paid');
  }
}

// ----------------------------------------------------------------------------- follow-ups

/**
 * Logs a collection call and, when the customer commits, the promise itself (FR-052). A
 * commitment is an amount *and* a date — either alone cannot be judged later.
 */
function saveFollowup(input) {
  var user = getCurrentUser();
  requireRole_(user, COLLECTION_ROLES);

  var invoice = readTable_('Invoices').filter(function (inv) {
    return String(inv.id) === String(input.invoiceId);
  })[0];
  if (!invoice) throw new Error('Pick the invoice this call was about.');
  if (!String(input.discussion || '').trim()) {
    throw new Error('Write down what was discussed — a follow-up with no notes helps nobody.');
  }

  var commitmentAmount = Number(input.commitmentAmount) || 0;
  var commitmentDate = String(input.commitmentDate || '').slice(0, 10);
  if ((commitmentAmount > 0) !== !!commitmentDate) {
    throw new Error('A commitment needs both an amount and a date. Leave both blank if the ' +
      'customer did not commit.');
  }

  var record = {
    invoiceId: invoice.id,
    customerId: invoice.customerId,
    contactDate: String(input.contactDate || todayIso_()).slice(0, 10),
    contactPerson: String(input.contactPerson || '').trim(),
    discussion: String(input.discussion).trim(),
    commitmentAmount: commitmentAmount,
    commitmentDate: commitmentDate,
    commitmentMet: String(input.commitmentMet || '').trim(),
    nextFollowupDate: String(input.nextFollowupDate || '').slice(0, 10),
    ownerEmail: user.email,
    status: commitmentAmount > 0 ? 'Promised' : 'Open'
  };

  if (input.id) {
    var existing = readTable_('CollectionFollowups').filter(function (f) {
      return String(f.id) === String(input.id);
    })[0];
    if (!existing) throw new Error('That follow-up no longer exists.');
    record.status = String(input.status || existing.status || record.status);
    updateRowById_('CollectionFollowups', 'id', input.id, record, 'Follow-up updated');
    return listFollowups({ invoiceId: invoice.id });
  }

  record.id = generateId_('CF-');
  record.createdAt = todayIso_();
  record.createdBy = user.email;
  appendRow_('CollectionFollowups', record, 'Follow-up logged on ' + invoice.invoiceNo);
  return listFollowups({ invoiceId: invoice.id });
}

function listFollowups(options) {
  getCurrentUser();
  var opts = options || {};
  var today = todayIso_();

  var customerNames = {};
  readTable_('Customers').forEach(function (c) { customerNames[String(c.id)] = c.name; });
  var invoices = {};
  readTable_('Invoices').forEach(function (i) {
    invoices[String(i.id)] = { invoiceNo: i.invoiceNo, grand: i.grand, amountReceived: i.amountReceived };
  });

  return readTable_('CollectionFollowups')
    .filter(function (f) {
      if (opts.invoiceId && String(f.invoiceId) !== String(opts.invoiceId)) return false;
      if (opts.customerId && String(f.customerId) !== String(opts.customerId)) return false;
      if (opts.openOnly && f.status === 'Closed') return false;
      if (opts.mineOnly && String(f.ownerEmail) !== getCurrentUserEmail_()) return false;
      if (opts.dueOnly) {
        if (!f.nextFollowupDate) return false;
        if (daysBetween_(f.nextFollowupDate, today) < 0) return false;
        if (f.status === 'Closed') return false;
      }
      return true;
    })
    .map(function (f) {
      var row = stripRow_(f);
      var invoice = invoices[String(row.invoiceId)] || {};
      row.invoiceNo = invoice.invoiceNo || '';
      row.balanceAmt = roundMoney_((Number(invoice.grand) || 0) - (Number(invoice.amountReceived) || 0));
      row.customerName = customerNames[String(row.customerId)] || '';
      row.commitmentAmount = Number(row.commitmentAmount) || 0;
      row.commitmentOverdue = !!(row.commitmentDate && row.commitmentMet !== 'Yes' &&
        daysBetween_(row.commitmentDate, today) > 0);
      row.followupDue = !!(row.nextFollowupDate && row.status !== 'Closed' &&
        daysBetween_(row.nextFollowupDate, today) >= 0);
      return row;
    })
    .sort(function (a, b) { return String(b.contactDate).localeCompare(String(a.contactDate)); });
}

/**
 * Marks commitments met once the money arrives. Called after every receipt, so nobody has to
 * remember to tick a promise off — and a promise left unticked really is broken.
 */
function settleCommitments_(invoiceId) {
  var received = readTable_('Receipts').reduce(function (s, r) {
    return String(r.invoiceId) === String(invoiceId) ? s + (Number(r.amount) || 0) : s;
  }, 0);

  readTable_('CollectionFollowups').forEach(function (f) {
    if (String(f.invoiceId) !== String(invoiceId)) return;
    if (f.commitmentMet === 'Yes' || f.status === 'Closed') return;
    var promised = Number(f.commitmentAmount) || 0;
    if (promised <= 0 || received + 0.5 < promised) return;
    updateRowById_('CollectionFollowups', 'id', f.id, {
      commitmentMet: 'Yes',
      status: 'Closed'
    }, 'Commitment met by payment');
  });
}

/** Commitments whose date has passed with the money still missing (FR-052). */
function listBrokenCommitments() {
  return listFollowups({ openOnly: true }).filter(function (f) { return f.commitmentOverdue; });
}

/** Calls due today or overdue — the collector's worklist. */
function listDueFollowups() {
  return listFollowups({ dueOnly: true });
}

// ------------------------------------------------------------------------- Tally receipts
//
// D3 again: built, documented, verified by the client. The CSV path below needs no
// connectivity at all and is the fallback PMT can rely on from day one.

var RECEIPT_IMPORT_COLUMNS = ['invoiceNo', 'receiptDate', 'amount', 'mode', 'reference', 'tallyRef'];

function getReceiptImportTemplate() {
  getCurrentUser();
  return RECEIPT_IMPORT_COLUMNS.join(',') + '\n' +
    'INV2609-001,2026-09-05,25000,NEFT/RTGS,UTR123456,VCH/1234';
}

/**
 * Dry run over a receipts CSV — typically a Tally ledger export saved as CSV. Nothing is
 * written; the caller sees exactly what would happen and what would be rejected, because an
 * import that silently drops half its rows is worse than one that refuses.
 */
function previewReceiptImport(csvText) {
  getCurrentUser();
  return analyseReceiptImport_(csvText);
}

function commitReceiptImport(csvText) {
  var user = getCurrentUser();
  requireRole_(user, COLLECTION_ROLES);

  var analysis = analyseReceiptImport_(csvText);
  if (!analysis.valid.length) {
    throw new Error('Nothing to import — every row was rejected. ' +
      (analysis.errors[0] ? analysis.errors[0].message : ''));
  }

  var touchedInvoices = {};
  analysis.valid.forEach(function (row) {
    appendRow_('Receipts', {
      id: generateId_('RCP-'),
      receiptNo: row.receiptNo,
      receiptDate: row.receiptDate,
      customerId: row.customerId,
      invoiceId: row.invoiceId,
      amount: row.amount,
      mode: row.mode,
      reference: row.reference,
      tallyRef: row.tallyRef,
      importedDate: todayIso_(),
      notes: 'Imported from Tally ledger export',
      createdAt: todayIso_(),
      createdBy: user.email
    });
    touchedInvoices[String(row.invoiceId)] = true;
  });

  Object.keys(touchedInvoices).forEach(function (invoiceId) {
    syncInvoiceReceipts_(invoiceId);
    settleCommitments_(invoiceId);
  });

  audit_('Import', 'Receipts', '', 'rowCount', '', analysis.valid.length,
    'Receipt import: ' + analysis.valid.length + ' posted, ' + analysis.errors.length + ' rejected');

  return {
    imported: analysis.valid.length,
    rejected: analysis.errors.length,
    errors: analysis.errors.slice(0, 50)
  };
}

function analyseReceiptImport_(csvText) {
  var rows = parseCsv_(csvText).filter(function (r) {
    return r.some(function (c) { return String(c).trim() !== ''; });
  });
  if (rows.length < 2) throw new Error('The file needs a header row and at least one receipt.');

  var headers = rows[0].map(function (h) { return String(h).trim(); });
  var missing = ['invoiceNo', 'receiptDate', 'amount'].filter(function (c) {
    return headers.indexOf(c) === -1;
  });
  if (missing.length) {
    throw new Error('Missing required column(s): ' + missing.join(', ') +
      '. Expected header: ' + RECEIPT_IMPORT_COLUMNS.join(', '));
  }

  var invoicesByNo = {};
  readTable_('Invoices').forEach(function (inv) {
    if (inv.status === 'Issued') invoicesByNo[String(inv.invoiceNo).trim().toUpperCase()] = inv;
  });

  var receivedByInvoice = {};
  var seenTallyRefs = {};
  readTable_('Receipts').forEach(function (r) {
    receivedByInvoice[String(r.invoiceId)] = (receivedByInvoice[String(r.invoiceId)] || 0) +
      (Number(r.amount) || 0);
    if (String(r.tallyRef || '').trim()) seenTallyRefs[String(r.tallyRef).trim().toUpperCase()] = r.receiptNo;
  });

  var valid = [];
  var errors = [];
  var runningTotals = {};
  var refsInFile = {};

  for (var i = 1; i < rows.length; i++) {
    var cells = rows[i];
    var get = function (col) {
      var idx = headers.indexOf(col);
      return idx === -1 ? '' : String(cells[idx] === undefined ? '' : cells[idx]).trim();
    };
    var lineNo = i + 1;

    var invoiceNo = get('invoiceNo').toUpperCase();
    var invoice = invoicesByNo[invoiceNo];
    if (!invoice) {
      errors.push({ line: lineNo, invoiceNo: get('invoiceNo'), message: 'No issued invoice with that number.' });
      continue;
    }

    var amount = Number(get('amount').replace(/[, ]/g, ''));
    if (isNaN(amount) || amount <= 0) {
      errors.push({ line: lineNo, invoiceNo: get('invoiceNo'), message: 'Amount is not a positive number.' });
      continue;
    }

    var receiptDate = get('receiptDate').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) {
      errors.push({ line: lineNo, invoiceNo: get('invoiceNo'), message: 'Date must be YYYY-MM-DD.' });
      continue;
    }

    // A re-run of the same export must not double-post. The Tally voucher ref is the key.
    var tallyRef = get('tallyRef');
    var refKey = tallyRef.toUpperCase();
    if (tallyRef && seenTallyRefs[refKey]) {
      errors.push({ line: lineNo, invoiceNo: get('invoiceNo'),
        message: 'Already imported as receipt ' + seenTallyRefs[refKey] + '.' });
      continue;
    }
    if (tallyRef && refsInFile[refKey]) {
      errors.push({ line: lineNo, invoiceNo: get('invoiceNo'), message: 'Duplicate Tally reference within this file.' });
      continue;
    }

    var key = String(invoice.id);
    var already = (receivedByInvoice[key] || 0) + (runningTotals[key] || 0);
    var balance = roundMoney_((Number(invoice.grand) || 0) - already);
    if (amount > balance + 0.5) {
      errors.push({ line: lineNo, invoiceNo: get('invoiceNo'),
        message: 'Only ' + balance + ' is outstanding on this invoice.' });
      continue;
    }

    runningTotals[key] = (runningTotals[key] || 0) + amount;
    if (tallyRef) refsInFile[refKey] = true;

    valid.push({
      line: lineNo,
      receiptNo: 'RCP-IMP-' + lineNo + '-' + String(new Date().getTime()).slice(-5),
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      customerId: invoice.customerId,
      receiptDate: receiptDate,
      amount: roundMoney_(amount),
      mode: get('mode') || 'NEFT/RTGS',
      reference: get('reference'),
      tallyRef: tallyRef,
      newBalance: roundMoney_(balance - amount)
    });
  }

  return {
    totalRows: rows.length - 1,
    valid: valid,
    errors: errors,
    totalAmount: roundMoney_(valid.reduce(function (s, r) { return s + r.amount; }, 0))
  };
}

/**
 * Pulls receipts from Tally (FR-055, I02) — the automated version of the CSV import above.
 *
 * Same caveat as the invoice push: Apps Script calls out from Google's network, so this
 * cannot work until PMT expose Tally to the internet, and we cannot test it. It fails loudly
 * and changes nothing rather than half-importing.
 */
function pullReceiptsFromTally(fromDate, toDate) {
  var user = getCurrentUser();
  requireRole_(user, COLLECTION_ROLES);

  var props = PropertiesService.getScriptProperties();
  var endpoint = props.getProperty('TALLY_ENDPOINT');
  if (!endpoint) {
    throw new Error('Tally is not connected yet. Set TALLY_ENDPOINT in Script Properties, or ' +
      'import a CSV export of the ledger instead.');
  }

  var company = props.getProperty('TALLY_COMPANY') || '';
  var from = String(fromDate || todayIso_()).replace(/-/g, '');
  var to = String(toDate || todayIso_()).replace(/-/g, '');

  var request = '' +
    '<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY>' +
    '<EXPORTDATA><REQUESTDESC><REPORTNAME>Voucher Register</REPORTNAME>' +
    '<STATICVARIABLES>' +
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
    (company ? '<SVCURRENTCOMPANY>' + company + '</SVCURRENTCOMPANY>' : '') +
    '<SVFROMDATE>' + from + '</SVFROMDATE><SVTODATE>' + to + '</SVTODATE>' +
    '<VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>' +
    '</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>';

  var response = UrlFetchApp.fetch(endpoint, {
    method: 'post', contentType: 'text/xml', payload: request, muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Tally returned HTTP ' + response.getResponseCode() + '. ' +
      String(response.getContentText() || '').slice(0, 200));
  }

  // Tally's voucher register is turned into the same CSV shape the manual import accepts, so
  // both paths land in one reviewed, idempotent place rather than two.
  //
  // The CSV goes back with the preview because committing takes the text, not the preview:
  // without it the caller would be looking at rows it has no way to import.
  var csv = tallyReceiptsToCsv_(response.getContentText());
  var preview = previewReceiptImport(csv);
  preview.csv = csv;
  return preview;
}

/** Flattens a Tally voucher-register XML export into the receipt import CSV shape. */
function tallyReceiptsToCsv_(xml) {
  var text = String(xml || '');
  var lines = [RECEIPT_IMPORT_COLUMNS.join(',')];
  var vouchers = text.split(/<VOUCHER[\s>]/i).slice(1);

  var pick = function (block, tag) {
    var m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i').exec(block);
    return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
  };

  vouchers.forEach(function (block) {
    var date = pick(block, 'DATE');
    var iso = /^\d{8}$/.test(date)
      ? date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6, 8) : date;
    var amount = Math.abs(Number(pick(block, 'AMOUNT')) || 0);
    var billRef = pick(block, 'BILLALLOCATIONS.LIST') || pick(block, 'NAME');
    var voucherNo = pick(block, 'VOUCHERNUMBER');
    if (!billRef || !amount) return;
    lines.push([billRef, iso, amount, 'NEFT/RTGS', voucherNo, voucherNo]
      .map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','));
  });

  return lines.join('\n');
}

/**
 * Tries the configured Tally endpoint and reports what happened (D3 "Test Connection"). Never
 * throws — the whole point is to show PMT's IT a readable result while they work on it.
 */
function testTallyConnection() {
  var user = getCurrentUser();
  requireRole_(user, [ROLES.MANAGEMENT, ROLES.ERP_ADMIN]);

  var props = PropertiesService.getScriptProperties();
  var endpoint = props.getProperty('TALLY_ENDPOINT');
  if (!endpoint) {
    return { ok: false, configured: false,
      message: 'No TALLY_ENDPOINT is set in Script Properties yet.' };
  }

  try {
    var response = UrlFetchApp.fetch(endpoint, {
      method: 'post', contentType: 'text/xml', muteHttpExceptions: true,
      payload: '<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY>' +
        '<EXPORTDATA><REQUESTDESC><REPORTNAME>List of Companies</REPORTNAME>' +
        '<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>' +
        '</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>'
    });
    var body = String(response.getContentText() || '');
    return {
      ok: response.getResponseCode() === 200,
      configured: true,
      endpoint: endpoint,
      httpStatus: response.getResponseCode(),
      message: response.getResponseCode() === 200
        ? 'Tally answered. Companies visible: ' + (body.match(/<NAME>/gi) || []).length
        : 'Tally endpoint answered with HTTP ' + response.getResponseCode() + '.',
      sample: body.slice(0, 300)
    };
  } catch (e) {
    return {
      ok: false, configured: true, endpoint: endpoint,
      message: 'Could not reach Tally: ' + e.message +
        ' — this usually means the endpoint is not reachable from the public internet.'
    };
  }
}
