/**
 * Billing and invoicing — M15.
 *
 * An invoice is raised from what actually left the building, not from what was ordered
 * (FR-048). The dispatch is therefore the source of the lines and the quantities; the order
 * supplies the prices, taxes and terms. That separation is the whole point: short shipments
 * invoice short, and nobody has to remember to edit the quantities by hand.
 *
 * Tally is the accounting system of record for the finished document (D3). This module writes
 * every invoice with `tallySyncStatus = Pending` and provides the hooks to mark it Synced or
 * Failed. The push itself is built and documented here but must be verified by the client's
 * IT on their own network — Apps Script calls out from Google's servers, not from the office
 * LAN, so we cannot integration-test it from here. Everything downstream (ageing, collections,
 * the dispatched-not-invoiced control) works with zero Tally connectivity.
 */

var BILLING_ROLES = [ROLES.SALES_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];
var BILLING_CANCEL_ROLES = [ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

var INVOICE_STATUSES = ['Draft', 'Issued', 'Cancelled'];
var TALLY_SYNC_STATUSES = ['Pending', 'Synced', 'Failed', 'Not Required'];

/** Days of credit implied by a payment-terms code, used only when the customer has none set. */
var TERM_CREDIT_DAYS = { ADV100: 0, ADV_PART: 0, NET30: 30, NET45: 45, NET60: 60 };

function listInvoices(options) {
  getCurrentUser();
  var opts = options || {};

  var customerNames = {};
  readTable_('Customers').forEach(function (c) { customerNames[String(c.id)] = c.name; });
  var orderNos = {};
  readTable_('SalesOrders').forEach(function (o) { orderNos[String(o.id)] = o.orderNo; });
  var dispatchNos = {};
  readTable_('Dispatches').forEach(function (d) { dispatchNos[String(d.id)] = d.dispatchNo; });

  var receiptsByInvoice = {};
  readTable_('Receipts').forEach(function (r) {
    var key = String(r.invoiceId);
    receiptsByInvoice[key] = (receiptsByInvoice[key] || 0) + (Number(r.amount) || 0);
  });

  var today = todayIso_();

  return readTable_('Invoices')
    .filter(function (inv) {
      if (!opts.includeCancelled && inv.status === 'Cancelled') return false;
      if (opts.businessStream && inv.businessStream !== opts.businessStream) return false;
      if (opts.customerId && String(inv.customerId) !== String(opts.customerId)) return false;
      if (opts.unpaidOnly) {
        var bal = (Number(inv.grand) || 0) - (Number(inv.amountReceived) || 0);
        if (bal <= 0.5) return false;
      }
      return true;
    })
    .map(function (inv) {
      var row = stripRow_(inv);
      row.customerName = customerNames[String(row.customerId)] || '';
      row.orderNo = orderNos[String(row.salesOrderId)] || '';
      row.dispatchNo = dispatchNos[String(row.dispatchId)] || '';
      // Receipts are the ledger; amountReceived on the invoice is a cached total.
      row.receivedAmt = roundMoney_(receiptsByInvoice[String(row.id)] || Number(row.amountReceived) || 0);
      row.balanceAmt = roundMoney_((Number(row.grand) || 0) - row.receivedAmt);
      row.overdueDays = row.dueDate && row.balanceAmt > 0.5 ? daysBetween_(row.dueDate, today) : 0;
      return row;
    })
    .sort(function (a, b) { return String(b.invoiceDate).localeCompare(String(a.invoiceDate)); });
}

function getInvoice(id) {
  getCurrentUser();
  var inv = readTable_('Invoices').filter(function (r) { return String(r.id) === String(id); })[0];
  if (!inv) throw new Error('Invoice not found.');
  var row = stripRow_(inv);

  row.items = readTable_('InvoiceItems')
    .filter(function (i) { return String(i.invoiceId) === String(id); })
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); })
    .map(stripRow_);

  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(row.customerId);
  })[0];
  row.customerName = customer ? customer.name : '';
  row.customerGstin = customer ? customer.gstin : '';

  var address = readTable_('CustomerAddresses').filter(function (a) {
    return String(a.id) === String(row.billingAddressId);
  })[0];
  row.billingAddress = address
    ? [address.line1, address.line2, address.city, address.state, address.pincode]
        .filter(Boolean).join(', ')
    : '';

  var order = readTable_('SalesOrders').filter(function (o) {
    return String(o.id) === String(row.salesOrderId);
  })[0];
  row.orderNo = order ? order.orderNo : '';
  row.poNo = order ? order.poNo : '';

  var dispatch = readTable_('Dispatches').filter(function (d) {
    return String(d.id) === String(row.dispatchId);
  })[0];
  row.dispatchNo = dispatch ? dispatch.dispatchNo : '';
  row.lrNumber = dispatch ? dispatch.lrNumber : '';

  row.receipts = readTable_('Receipts')
    .filter(function (r) { return String(r.invoiceId) === String(id); })
    .map(stripRow_)
    .sort(function (a, b) { return String(a.receiptDate).localeCompare(String(b.receiptDate)); });
  row.receivedAmt = roundMoney_(row.receipts.reduce(function (s, r) {
    return s + (Number(r.amount) || 0);
  }, 0));
  row.balanceAmt = roundMoney_((Number(row.grand) || 0) - row.receivedAmt);
  return row;
}

/**
 * Raises an invoice from a posted dispatch (FR-048).
 *
 * Quantities come from the dispatch, prices and taxes from the matching order line. A
 * dispatch can be invoiced once; a second call is refused rather than quietly creating a
 * duplicate document that Tally would then have to reconcile.
 */
function createInvoiceFromDispatch(input) {
  var user = getCurrentUser();
  requireRole_(user, BILLING_ROLES);

  var dispatchId = input && input.dispatchId;
  var dispatch = readTable_('Dispatches').filter(function (d) {
    return String(d.id) === String(dispatchId);
  })[0];
  if (!dispatch) throw new Error('Dispatch not found.');
  if (dispatch.status !== 'Dispatched') {
    throw new Error('Post the dispatch before invoicing it — the invoice bills what actually shipped.');
  }

  var existing = readTable_('Invoices').filter(function (inv) {
    return String(inv.dispatchId) === String(dispatchId) && inv.status !== 'Cancelled';
  })[0];
  if (existing) {
    throw new Error('Dispatch ' + dispatch.dispatchNo + ' is already invoiced as ' + existing.invoiceNo + '.');
  }

  var order = readTable_('SalesOrders').filter(function (o) {
    return String(o.id) === String(dispatch.salesOrderId);
  })[0];
  if (!order) throw new Error('The order behind this dispatch no longer exists.');

  var orderLines = {};
  readTable_('SalesOrderItems').forEach(function (l) {
    if (String(l.salesOrderId) === String(order.id)) orderLines[String(l.id)] = l;
  });

  var dispatchItems = readTable_('DispatchItems')
    .filter(function (i) { return String(i.dispatchId) === String(dispatchId); })
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); });
  if (!dispatchItems.length) throw new Error('This dispatch has no lines to invoice.');

  var invoiceDate = String((input && input.invoiceDate) || todayIso_()).slice(0, 10);
  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(order.customerId);
  })[0];

  var invoiceId = generateId_('INV-');
  var lines = [];
  var subtotal = 0, discountAmt = 0, taxAmt = 0;

  dispatchItems.forEach(function (item, idx) {
    var qty = Number(item.qtyDispatched) || 0;
    if (qty <= 0) return;
    var source = orderLines[String(item.salesOrderItemId)] || {};

    var unitPrice = Number(source.unitPrice) || 0;
    var discountPct = Number(source.discountPct) || 0;
    var taxPct = Number(source.taxPct) || 0;
    var gross = unitPrice * qty;
    var discount = gross * discountPct / 100;
    var net = gross - discount;
    var tax = net * taxPct / 100;

    subtotal += gross;
    discountAmt += discount;
    taxAmt += tax;

    lines.push({
      id: generateId_('INVI-'),
      invoiceId: invoiceId,
      lineNo: idx + 1,
      itemType: item.itemType,
      itemId: item.itemId,
      itemCode: item.itemCode,
      description: item.description,
      qty: qty,
      uom: source.uom || '',
      unitPrice: unitPrice,
      discountPct: discountPct,
      taxPct: taxPct,
      lineTotal: roundMoney_(net + tax)
    });
  });

  if (!lines.length) throw new Error('Every line on this dispatch has zero quantity.');

  // Freight rides on the order, so it belongs on the invoice that closes the order out.
  var remainingLines = outstandingOrderQty_(order.id, dispatchId);
  var freight = remainingLines === 0 ? (Number(order.freight) || 0) : 0;
  var grand = roundMoney_(subtotal - discountAmt + taxAmt + freight);

  var paymentTerms = order.paymentTerms || (customer && customer.paymentTerms) || '';
  var creditDays = customer && customer.creditDays !== '' && customer.creditDays !== null
    ? Number(customer.creditDays)
    : (TERM_CREDIT_DAYS[paymentTerms] !== undefined ? TERM_CREDIT_DAYS[paymentTerms] : 0);

  appendRow_('Invoices', {
    id: invoiceId,
    invoiceNo: nextSeriesNo_('Invoices', 'invoiceNo', 'INV'),
    invoiceDate: invoiceDate,
    salesOrderId: order.id,
    dispatchId: dispatchId,
    customerId: order.customerId,
    billingAddressId: order.billingAddressId,
    businessStream: order.businessStream,
    brand: order.brand,
    subtotal: roundMoney_(subtotal),
    discountAmt: roundMoney_(discountAmt),
    taxAmt: roundMoney_(taxAmt),
    freight: roundMoney_(freight),
    grand: grand,
    amountReceived: 0,
    paymentTerms: paymentTerms,
    dueDate: addDays_(invoiceDate, creditDays),
    warrantyTerms: String((input && input.warrantyTerms) || '').trim(),
    status: 'Draft',
    tallySyncStatus: 'Pending',
    tallySyncDate: '',
    tallySyncError: '',
    notes: String((input && input.notes) || '').trim(),
    createdAt: todayIso_(),
    createdBy: user.email
  }, 'Invoice raised from dispatch ' + dispatch.dispatchNo);

  lines.forEach(function (line) {
    appendRow_('InvoiceItems', line, 'Invoice line from the dispatch');
  });

  return getInvoice(invoiceId);
}

/**
 * Issues a draft invoice: the document becomes final, the serials pick up the invoice number,
 * and the order moves to Invoiced (or Closed once nothing is left to ship).
 */
function issueInvoice(invoiceId) {
  var user = getCurrentUser();
  requireRole_(user, BILLING_ROLES);

  var invoice = readTable_('Invoices').filter(function (inv) {
    return String(inv.id) === String(invoiceId);
  })[0];
  if (!invoice) throw new Error('Invoice not found.');
  if (invoice.status === 'Cancelled') throw new Error('This invoice was cancelled.');
  if (invoice.status === 'Issued') throw new Error('This invoice has already been issued.');

  updateRowById_('Invoices', 'id', invoiceId, { status: 'Issued' }, 'Invoice issued');

  var lines = readTable_('InvoiceItems').filter(function (i) {
    return String(i.invoiceId) === String(invoiceId);
  });
  lines.forEach(function (line) {
    var orderLine = readTable_('SalesOrderItems').filter(function (l) {
      return String(l.salesOrderId) === String(invoice.salesOrderId) &&
        String(l.itemId) === String(line.itemId);
    })[0];
    if (orderLine) {
      updateRowById_('SalesOrderItems', 'id', orderLine.id, {
        qtyInvoiced: (Number(orderLine.qtyInvoiced) || 0) + (Number(line.qty) || 0)
      }, 'Invoiced ' + line.qty);
    }
  });

  // Serials carry the invoice number into the installed base (FR-038, FR-056).
  readTable_('SerialNumbers').forEach(function (s) {
    if (String(s.dispatchId) === String(invoice.dispatchId) && s.dispatchId) {
      updateRowById_('SerialNumbers', 'id', s.id, { invoiceNo: invoice.invoiceNo },
        'Invoiced on ' + invoice.invoiceNo);
    }
  });

  // The order becomes Invoiced. Closing it is a separate, deliberate act once the money is in,
  // so an unpaid order never disappears from the collections worklist.
  var order = readTable_('SalesOrders').filter(function (o) {
    return String(o.id) === String(invoice.salesOrderId);
  })[0];
  if (order && (ORDER_TRANSITIONS[order.orderStatus] || []).indexOf('Invoiced') !== -1) {
    updateRowById_('SalesOrders', 'id', order.id, { orderStatus: 'Invoiced' },
      'Invoice ' + invoice.invoiceNo + ' issued');
  }

  return getInvoice(invoiceId);
}

function saveInvoiceDetails(input) {
  var user = getCurrentUser();
  requireRole_(user, BILLING_ROLES);

  var invoice = readTable_('Invoices').filter(function (inv) {
    return String(inv.id) === String(input.id);
  })[0];
  if (!invoice) throw new Error('Invoice not found.');
  if (invoice.status === 'Issued') {
    throw new Error('An issued invoice cannot be edited. Cancel it and raise a fresh one.');
  }

  var invoiceDate = String(input.invoiceDate || invoice.invoiceDate).slice(0, 10);
  updateRowById_('Invoices', 'id', input.id, {
    invoiceDate: invoiceDate,
    dueDate: String(input.dueDate || invoice.dueDate).slice(0, 10),
    paymentTerms: String(input.paymentTerms || invoice.paymentTerms || '').trim(),
    warrantyTerms: String(input.warrantyTerms || '').trim(),
    notes: String(input.notes || '').trim()
  }, 'Invoice details updated');
  return getInvoice(input.id);
}

/**
 * Cancels an invoice. Nothing is deleted — the number stays in the register with a reason, so
 * the series has no silent gaps when it is reconciled against Tally.
 */
function cancelInvoice(invoiceId, reason) {
  var user = getCurrentUser();
  requireRole_(user, BILLING_CANCEL_ROLES);

  if (!String(reason || '').trim()) throw new Error('A reason is required to cancel an invoice.');

  var invoice = readTable_('Invoices').filter(function (inv) {
    return String(inv.id) === String(invoiceId);
  })[0];
  if (!invoice) throw new Error('Invoice not found.');
  if (invoice.status === 'Cancelled') throw new Error('This invoice is already cancelled.');

  var received = readTable_('Receipts').reduce(function (s, r) {
    return String(r.invoiceId) === String(invoiceId) ? s + (Number(r.amount) || 0) : s;
  }, 0);
  if (received > 0) {
    throw new Error('Payments totalling ' + roundMoney_(received) +
      ' are recorded against this invoice. Reverse them before cancelling.');
  }

  // Give back the invoiced quantity so the order can be billed again.
  if (invoice.status === 'Issued') {
    readTable_('InvoiceItems').forEach(function (line) {
      if (String(line.invoiceId) !== String(invoiceId)) return;
      var orderLine = readTable_('SalesOrderItems').filter(function (l) {
        return String(l.salesOrderId) === String(invoice.salesOrderId) &&
          String(l.itemId) === String(line.itemId);
      })[0];
      if (orderLine) {
        updateRowById_('SalesOrderItems', 'id', orderLine.id, {
          qtyInvoiced: Math.max(0, (Number(orderLine.qtyInvoiced) || 0) - (Number(line.qty) || 0))
        }, 'Invoice cancelled');
      }
    });
  }

  updateRowById_('Invoices', 'id', invoiceId, {
    status: 'Cancelled',
    tallySyncStatus: 'Not Required',
    notes: [invoice.notes, 'Cancelled: ' + reason].filter(Boolean).join(' | ')
  }, 'Invoice cancelled: ' + reason);
  return getInvoice(invoiceId);
}

/**
 * The dispatched-not-invoiced control (FR-049). Goods that have left without a bill are the
 * most expensive thing to discover late, so this is a standing report rather than a filter
 * somebody has to remember to apply.
 */
function listDispatchedNotInvoiced() {
  getCurrentUser();

  var invoicedDispatches = {};
  readTable_('Invoices').forEach(function (inv) {
    if (inv.dispatchId && inv.status !== 'Cancelled') invoicedDispatches[String(inv.dispatchId)] = true;
  });

  var orders = {};
  readTable_('SalesOrders').forEach(function (o) { orders[String(o.id)] = o; });
  var customerNames = {};
  readTable_('Customers').forEach(function (c) { customerNames[String(c.id)] = c.name; });

  var valueByDispatch = {};
  var orderLines = {};
  readTable_('SalesOrderItems').forEach(function (l) { orderLines[String(l.id)] = l; });
  readTable_('DispatchItems').forEach(function (i) {
    var source = orderLines[String(i.salesOrderItemId)] || {};
    var net = (Number(i.qtyDispatched) || 0) * (Number(source.unitPrice) || 0);
    net -= net * (Number(source.discountPct) || 0) / 100;
    var key = String(i.dispatchId);
    valueByDispatch[key] = (valueByDispatch[key] || 0) + net;
  });

  var today = todayIso_();

  return readTable_('Dispatches')
    .filter(function (d) {
      return d.status === 'Dispatched' && !invoicedDispatches[String(d.id)];
    })
    .map(function (d) {
      var order = orders[String(d.salesOrderId)] || {};
      return {
        dispatchId: d.id,
        dispatchNo: d.dispatchNo,
        dispatchDate: d.dispatchDate,
        daysPending: daysBetween_(d.dispatchDate, today),
        salesOrderId: d.salesOrderId,
        orderNo: order.orderNo || '',
        customerName: customerNames[String(order.customerId)] || '',
        uninvoicedValue: roundMoney_(valueByDispatch[String(d.id)] || 0),
        lrNumber: d.lrNumber || ''
      };
    })
    .sort(function (a, b) { return b.daysPending - a.daysPending; });
}

/** Posted dispatches with no invoice — what the "raise invoice" picker offers. */
function listInvoiceableDispatches() {
  return listDispatchedNotInvoiced();
}

// ---------------------------------------------------------------------------- Tally handoff
//
// D3: we build the sync and hand it over. The client's IT points it at their Tally endpoint
// and verifies it on their own network. Until then invoices sit at Pending and nothing else
// in the ERP depends on Tally being reachable.

/**
 * Builds the Tally XML for an invoice (a Sales voucher). Kept as a pure function so the
 * client's IT can inspect and test the payload without posting anything.
 */
function buildTallyInvoiceXml(invoiceId) {
  var invoice = getInvoice(invoiceId);
  var esc = function (v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var tallyDate = String(invoice.invoiceDate).replace(/-/g, '');

  var entries = invoice.items.map(function (line) {
    return '' +
      '<ALLINVENTORYENTRIES.LIST>' +
      '<STOCKITEMNAME>' + esc(line.itemCode) + '</STOCKITEMNAME>' +
      '<ACTUALQTY>' + esc(line.qty) + '</ACTUALQTY>' +
      '<BILLEDQTY>' + esc(line.qty) + '</BILLEDQTY>' +
      '<RATE>' + esc(line.unitPrice) + '</RATE>' +
      '<AMOUNT>' + esc(line.lineTotal) + '</AMOUNT>' +
      '</ALLINVENTORYENTRIES.LIST>';
  }).join('');

  return '' +
    '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY>' +
    '<IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA>' +
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">' +
    '<VOUCHER VCHTYPE="Sales" ACTION="Create">' +
    '<DATE>' + esc(tallyDate) + '</DATE>' +
    '<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>' +
    '<VOUCHERNUMBER>' + esc(invoice.invoiceNo) + '</VOUCHERNUMBER>' +
    '<PARTYLEDGERNAME>' + esc(invoice.customerName) + '</PARTYLEDGERNAME>' +
    '<REFERENCE>' + esc(invoice.poNo) + '</REFERENCE>' +
    entries +
    '</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
}

/**
 * Pushes one invoice to Tally (FR-050, I01).
 *
 * Requires `TALLY_ENDPOINT` in Script Properties. Apps Script sends this from Google's
 * network, so the endpoint must be reachable from the internet, not just from the office LAN.
 * Failures are recorded on the invoice and are never fatal: the invoice stands, the ERP keeps
 * working, and the row can be retried or reconciled by hand.
 */
function pushInvoiceToTally(invoiceId) {
  var user = getCurrentUser();
  requireRole_(user, BILLING_ROLES);

  var endpoint = PropertiesService.getScriptProperties().getProperty('TALLY_ENDPOINT');
  if (!endpoint) {
    updateRowById_('Invoices', 'id', invoiceId, {
      tallySyncStatus: 'Failed',
      tallySyncDate: todayIso_(),
      tallySyncError: 'No TALLY_ENDPOINT configured in Script Properties.'
    }, 'Tally sync skipped — not configured');
    throw new Error('Tally is not connected yet. Set TALLY_ENDPOINT in Script Properties, ' +
      'or record the invoice in Tally manually.');
  }

  var invoice = readTable_('Invoices').filter(function (inv) {
    return String(inv.id) === String(invoiceId);
  })[0];
  if (!invoice) throw new Error('Invoice not found.');
  if (invoice.status !== 'Issued') throw new Error('Issue the invoice before sending it to Tally.');

  try {
    var response = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      contentType: 'text/xml',
      payload: buildTallyInvoiceXml(invoiceId),
      muteHttpExceptions: true
    });
    var body = String(response.getContentText() || '');
    var ok = response.getResponseCode() === 200 && !/<LINEERROR>/i.test(body);

    updateRowById_('Invoices', 'id', invoiceId, {
      tallySyncStatus: ok ? 'Synced' : 'Failed',
      tallySyncDate: todayIso_(),
      tallySyncError: ok ? '' : body.slice(0, 500)
    }, ok ? 'Invoice synced to Tally' : 'Tally rejected the voucher');

    if (!ok) throw new Error('Tally rejected the voucher: ' + body.slice(0, 200));
  } catch (e) {
    updateRowById_('Invoices', 'id', invoiceId, {
      tallySyncStatus: 'Failed',
      tallySyncDate: todayIso_(),
      tallySyncError: String(e.message).slice(0, 500)
    }, 'Tally sync failed');
    throw e;
  }

  return getInvoice(invoiceId);
}

/** Marks an invoice as entered in Tally by hand — the fallback while the sync is unverified. */
function markInvoiceSyncedManually(invoiceId, reference) {
  var user = getCurrentUser();
  requireRole_(user, BILLING_ROLES);
  var patch = { tallySyncStatus: 'Synced', tallySyncDate: todayIso_(), tallySyncError: '' };
  if (String(reference || '').trim()) patch.notes = 'Tally ref: ' + String(reference).trim();

  updateRowById_('Invoices', 'id', invoiceId, patch,
    'Marked as entered in Tally by ' + user.email);
  return getInvoice(invoiceId);
}

/** Invoices still waiting on Tally — the reconciliation worklist. */
function listTallySyncQueue() {
  getCurrentUser();
  return listInvoices({ includeCancelled: false }).filter(function (inv) {
    return inv.status === 'Issued' && ['Synced', 'Not Required'].indexOf(inv.tallySyncStatus) === -1;
  });
}

// ---------------------------------------------------------------------------------- helpers

/** Order quantity still to ship, optionally counting a dispatch that is about to be invoiced. */
function outstandingOrderQty_(salesOrderId, includeDispatchId) {
  var pending = {};
  readTable_('DispatchItems').forEach(function (i) {
    if (includeDispatchId && String(i.dispatchId) === String(includeDispatchId)) {
      pending[String(i.salesOrderItemId)] = (pending[String(i.salesOrderItemId)] || 0) +
        (Number(i.qtyDispatched) || 0);
    }
  });

  var remaining = 0;
  readTable_('SalesOrderItems').forEach(function (l) {
    if (String(l.salesOrderId) !== String(salesOrderId)) return;
    var shipped = (Number(l.qtyDispatched) || 0) + (pending[String(l.id)] || 0);
    remaining += Math.max(0, (Number(l.qty) || 0) - shipped);
  });
  return remaining;
}

/** Whole days from an ISO date to another; negative when the first date is later. */
function daysBetween_(fromIso, toIso) {
  if (!fromIso || !toIso) return 0;
  var from = new Date(String(fromIso).slice(0, 10) + 'T00:00:00Z').getTime();
  var to = new Date(String(toIso).slice(0, 10) + 'T00:00:00Z').getTime();
  if (isNaN(from) || isNaN(to)) return 0;
  return Math.round((to - from) / 86400000);
}

// `addDays_` and `roundMoney_` live in Quotations.gs — Apps Script shares one global scope.
