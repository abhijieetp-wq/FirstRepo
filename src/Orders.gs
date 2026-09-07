/**
 * Sales orders and commercial control — M09, M10, M20.
 *
 * An order is created by converting a won quotation once the customer's PO arrives, and the
 * PO is checked against the quote rather than trusted (FR-030): value, and the presence of a
 * number and date. A mismatch does not silently pass — it is recorded on the order and
 * surfaced, because unnoticed PO variance is how orders get executed at the wrong price.
 *
 * The lifecycle is the blueprint's eight states (FR-031), and it is a real state machine:
 *   Draft → Approval Pending → Credit Hold → Material Pending → Ready for Dispatch →
 *   Dispatched → Invoiced → Closed
 * Transitions are validated, so an order cannot jump from Draft to Dispatched and leave the
 * commercial checks behind it unperformed.
 *
 * Credit control (FR-032/033/034/035) is the point of the module. Exposure is
 * outstanding invoices + open orders not yet invoiced + this order, measured against the
 * customer's approved limit. Breaching it puts the order on Credit Hold automatically; only
 * Management or ERP Admin can release it, they must give a reason, and the release is
 * written to the Approvals register as well as the audit log.
 */

var ORDER_EDITORS = [ROLES.SALES_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];
var CREDIT_APPROVERS = [ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/**
 * What each state may become. Backward moves are allowed where the business genuinely
 * reverses (a released hold going back to material shortage, for instance); the ones left
 * out are the ones that would skip a control.
 */
var ORDER_TRANSITIONS = {
  'Draft': ['Approval Pending', 'Credit Hold', 'Material Pending', 'Ready for Dispatch'],
  'Approval Pending': ['Credit Hold', 'Material Pending', 'Ready for Dispatch', 'Draft'],
  'Credit Hold': ['Material Pending', 'Ready for Dispatch', 'Draft'],
  'Material Pending': ['Ready for Dispatch', 'Credit Hold'],
  'Ready for Dispatch': ['Dispatched', 'Credit Hold', 'Material Pending'],
  'Dispatched': ['Invoiced'],
  'Invoiced': ['Closed'],
  'Closed': []
};

function listSalesOrders(options) {
  var user = getCurrentUser();
  var opts = options || {};

  var customerNames = {};
  readTable_('Customers').forEach(function (c) { customerNames[String(c.id)] = c.name; });

  var itemCounts = {};
  readTable_('SalesOrderItems').forEach(function (i) {
    var key = String(i.salesOrderId);
    itemCounts[key] = (itemCounts[key] || 0) + 1;
  });

  var rows = readTable_('SalesOrders').map(function (o) {
    var row = stripRow_(o);
    row.customerName = customerNames[String(row.customerId)] || '';
    row.itemCount = itemCounts[String(row.id)] || 0;
    row.creditHold = String(row.creditHold).toUpperCase() === 'TRUE';
    row.overdueDispatch = row.promisedDispatchDate &&
      String(row.promisedDispatchDate) < todayIso_() &&
      ['Dispatched', 'Invoiced', 'Closed'].indexOf(row.orderStatus) === -1;
    return row;
  });

  if (opts.mineOnly) {
    rows = rows.filter(function (r) { return String(r.ownerEmail).toLowerCase() === user.email.toLowerCase(); });
  }
  if (!opts.includeClosed) {
    rows = rows.filter(function (r) { return r.orderStatus !== 'Closed'; });
  }
  if (opts.creditHoldOnly) {
    rows = rows.filter(function (r) { return r.creditHold || r.orderStatus === 'Credit Hold'; });
  }
  return rows.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
}

function getSalesOrder(id) {
  getCurrentUser();
  var o = readTable_('SalesOrders').filter(function (r) { return String(r.id) === String(id); })[0];
  if (!o) throw new Error('Order not found.');
  var row = stripRow_(o);
  row.creditHold = String(row.creditHold).toUpperCase() === 'TRUE';

  row.items = readTable_('SalesOrderItems')
    .filter(function (i) { return String(i.salesOrderId) === String(id); })
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); })
    .map(stripRow_);

  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(row.customerId);
  })[0];
  row.customerName = customer ? customer.name : '';
  row.creditLimit = customer && customer.creditLimit !== '' ? Number(customer.creditLimit) : null;
  row.creditDays = customer && customer.creditDays !== '' ? Number(customer.creditDays) : null;

  row.creditChecks = readTable_('CreditChecks')
    .filter(function (c) { return String(c.salesOrderId) === String(id); })
    .map(stripRow_)
    .sort(function (a, b) { return String(b.checkDate).localeCompare(String(a.checkDate)); });

  row.approvals = readTable_('Approvals')
    .filter(function (a) { return a.relatedType === 'SalesOrder' && String(a.relatedId) === String(id); })
    .map(stripRow_);

  row.allowedTransitions = ORDER_TRANSITIONS[row.orderStatus] || [];
  return row;
}

/**
 * Converts a won quotation into an order once the customer PO is in hand, and validates the
 * PO against the quote (FR-029, FR-030).
 */
function createOrderFromQuotation(input) {
  var user = getCurrentUser();
  requireRole_(user, ORDER_EDITORS);

  var quote = readTable_('Quotations').filter(function (q) {
    return String(q.id) === String(input.quotationId);
  })[0];
  if (!quote) throw new Error('That quotation no longer exists.');
  if (quote.status !== 'Won') {
    throw new Error('Mark the quotation Won before converting it — an order should follow a ' +
      'decision, not precede it.');
  }

  var already = readTable_('SalesOrders').filter(function (o) {
    return String(o.quotationId) === String(quote.id);
  })[0];
  if (already) throw new Error('Order ' + already.orderNo + ' already exists for this quotation.');

  var poNo = String(input.poNo || '').trim();
  if (!poNo) throw new Error("Enter the customer's PO number.");

  var quoteGrand = Number(quote.grand) || 0;
  var poValue = input.poValue === '' || input.poValue === undefined || input.poValue === null
    ? '' : Number(input.poValue);

  // FR-030: the mismatch is recorded rather than blocking, so the coordinator can proceed
  // knowingly but nobody can later claim the variance went unseen.
  var variance = [];
  if (poValue !== '' && Math.abs(poValue - quoteGrand) > 1) {
    variance.push('PO value ' + poValue.toFixed(2) + ' differs from the quoted ' +
      quoteGrand.toFixed(2) + ' by ' + (poValue - quoteGrand).toFixed(2));
  }
  if (!String(input.poDate || '').trim()) variance.push('No PO date recorded');

  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(quote.customerId);
  })[0];

  var order = {
    id: generateId_('SO-'),
    orderNo: nextSeriesNo_('SalesOrders', 'orderNo', 'SO'),
    date: todayIso_(),
    businessStream: quote.businessStream,
    brand: quote.brand || 'ELGI',
    customerId: quote.customerId,
    quotationId: quote.id,
    poNo: poNo,
    poDate: String(input.poDate || '').slice(0, 10),
    poValue: poValue,
    poAttachmentUrl: String(input.poAttachmentUrl || '').trim(),
    poVerified: variance.length ? 'FALSE' : 'TRUE',
    poVarianceNotes: variance.join('; '),
    billingAddressId: quote.billingAddressId,
    shippingAddressId: quote.shippingAddressId,
    orderStatus: 'Draft',
    paymentTerms: quote.paymentTerms || (customer ? customer.paymentTerms : ''),
    advanceRequired: input.advanceRequired === '' || input.advanceRequired === undefined ? '' : Number(input.advanceRequired),
    advanceReceived: 0,
    promisedDispatchDate: String(input.promisedDispatchDate || '').slice(0, 10),
    subtotal: quote.subtotal,
    discountAmt: quote.discountAmt,
    taxAmt: quote.taxAmt,
    freight: quote.freight || 0,
    grand: quote.grand,
    creditHold: 'FALSE',
    creditHoldReason: '',
    ownerEmail: user.email,
    closedDate: '',
    notes: '',
    createdAt: todayIso_(),
    createdBy: user.email
  };
  appendRow_('SalesOrders', order, 'Order created from quotation ' + quote.quoteNo);

  readTable_('QuotationItems')
    .filter(function (i) { return String(i.quotationId) === String(quote.id); })
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); })
    .forEach(function (qi, idx) {
      appendRow_('SalesOrderItems', {
        id: generateId_('SOI-'),
        salesOrderId: order.id,
        lineNo: idx + 1,
        itemType: qi.itemType,
        itemId: qi.itemId,
        itemCode: qi.itemCode,
        description: qi.description,
        qty: qi.qty,
        uom: qi.uom,
        unitPrice: qi.unitPrice,
        discountPct: qi.discountPct,
        taxPct: qi.taxPct,
        lineTotal: qi.lineTotal,
        qtyReserved: 0,
        qtyDispatched: 0,
        qtyInvoiced: 0
      }, 'Line carried from the quotation');
    });

  // Run the credit check immediately — the answer belongs before anyone plans a dispatch.
  runCreditCheck(order.id);
  return getSalesOrder(order.id);
}

/**
 * Credit exposure (FR-033).
 *
 * Exposure is deliberately broader than unpaid invoices: an order accepted but not yet
 * invoiced is money already committed, so counting only invoices would understate the risk
 * and let a customer quietly exceed their limit through open orders.
 */
function calculateCreditExposure(customerId, excludeOrderId) {
  getCurrentUser();

  var customer = readTable_('Customers').filter(function (c) {
    return String(c.id) === String(customerId);
  })[0];
  if (!customer) throw new Error('Customer not found.');

  var outstanding = 0;
  readTable_('Invoices').forEach(function (inv) {
    if (String(inv.customerId) !== String(customerId)) return;
    var balance = (Number(inv.grand) || 0) - (Number(inv.amountReceived) || 0);
    if (balance > 0) outstanding += balance;
  });

  var openOrders = 0;
  readTable_('SalesOrders').forEach(function (o) {
    if (String(o.customerId) !== String(customerId)) return;
    if (excludeOrderId && String(o.id) === String(excludeOrderId)) return;
    // Once invoiced the value has moved into `outstanding`; counting it here would double it.
    if (['Invoiced', 'Closed'].indexOf(o.orderStatus) !== -1) return;
    openOrders += Number(o.grand) || 0;
  });

  var limit = customer.creditLimit === '' || customer.creditLimit === null
    ? null : Number(customer.creditLimit);

  return {
    customerId: customerId,
    customerName: customer.name,
    creditLimit: limit,
    creditDays: customer.creditDays === '' ? null : Number(customer.creditDays),
    paymentTerms: customer.paymentTerms || '',
    outstandingAmt: roundMoney_(outstanding),
    openOrderExposure: roundMoney_(openOrders),
    existingExposure: roundMoney_(outstanding + openOrders)
  };
}

/**
 * Evaluates one order against the customer's limit and advance rule, records the result, and
 * puts the order on hold when policy is breached (FR-034).
 */
function runCreditCheck(salesOrderId) {
  var user = getCurrentUser();

  var order = readTable_('SalesOrders').filter(function (o) {
    return String(o.id) === String(salesOrderId);
  })[0];
  if (!order) throw new Error('Order not found.');

  var exposure = calculateCreditExposure(order.customerId, salesOrderId);
  var orderValue = Number(order.grand) || 0;
  var totalExposure = exposure.existingExposure + orderValue;
  var limit = exposure.creditLimit;

  var advanceRequired = order.advanceRequired === '' || order.advanceRequired === null
    ? 0 : Number(order.advanceRequired);
  var advanceReceived = Number(order.advanceReceived) || 0;

  var reasons = [];
  if (limit !== null && totalExposure > limit) {
    reasons.push('Exposure ' + roundMoney_(totalExposure) + ' exceeds the approved limit ' + limit);
  }
  if (advanceRequired > advanceReceived) {
    reasons.push('Advance of ' + advanceRequired + ' required, ' + advanceReceived + ' received');
  }

  var result = reasons.length ? 'Hold' : 'Pass';
  var check = {
    id: generateId_('CC-'),
    salesOrderId: salesOrderId,
    customerId: order.customerId,
    checkDate: todayIso_(),
    creditLimit: limit === null ? '' : limit,
    outstandingAmt: exposure.outstandingAmt,
    openOrderExposure: exposure.openOrderExposure,
    currentOrderValue: orderValue,
    totalExposure: roundMoney_(totalExposure),
    availableCredit: limit === null ? '' : roundMoney_(limit - totalExposure),
    advanceRequired: advanceRequired,
    advanceReceived: advanceReceived,
    result: result,
    holdReason: reasons.join('; '),
    releasedBy: '',
    releaseDate: '',
    releaseNotes: ''
  };
  appendRow_('CreditChecks', check, 'Credit check: ' + result);

  if (result === 'Hold') {
    updateRowById_('SalesOrders', 'id', salesOrderId, {
      orderStatus: 'Credit Hold',
      creditHold: 'TRUE',
      creditHoldReason: check.holdReason
    }, 'Automatic credit hold: ' + check.holdReason);

    // The register is what makes the exception auditable, separately from the field change.
    appendRow_('Approvals', {
      id: generateId_('APR-'),
      approvalType: 'Credit Limit Exceeded',
      relatedType: 'SalesOrder',
      relatedId: salesOrderId,
      requestedBy: user.email,
      requestDate: todayIso_(),
      requestReason: check.holdReason,
      contextSummary: 'Limit ' + (limit === null ? 'not set' : limit) +
        ', exposure ' + roundMoney_(totalExposure),
      level1Approver: '', level1Status: 'Pending', level1Date: '', level1Notes: '',
      level2Approver: '', level2Status: '', level2Date: '', level2Notes: '',
      status: 'Pending',
      closedDate: ''
    }, 'Credit hold raised for approval');
  } else if (String(order.creditHold).toUpperCase() === 'TRUE') {
    updateRowById_('SalesOrders', 'id', salesOrderId, {
      creditHold: 'FALSE', creditHoldReason: ''
    }, 'Credit check passed — hold cleared');
  }

  return check;
}

/**
 * Releases a hold with a reason (FR-035). Restricted to Management and ERP Admin, and the
 * reason is mandatory — an untraceable override is the thing this control exists to prevent.
 */
function releaseCreditHold(salesOrderId, reason, nextStatus) {
  var user = getCurrentUser();
  requireRole_(user, CREDIT_APPROVERS);
  if (!String(reason || '').trim()) {
    throw new Error('A reason is required to release a credit hold.');
  }

  var order = readTable_('SalesOrders').filter(function (o) {
    return String(o.id) === String(salesOrderId);
  })[0];
  if (!order) throw new Error('Order not found.');

  var target = String(nextStatus || 'Material Pending').trim();
  if ((ORDER_TRANSITIONS['Credit Hold'] || []).indexOf(target) === -1) {
    throw new Error('A released order can move to: ' + ORDER_TRANSITIONS['Credit Hold'].join(', ') + '.');
  }

  updateRowById_('SalesOrders', 'id', salesOrderId, {
    orderStatus: target,
    creditHold: 'FALSE',
    creditHoldReason: ''
  }, 'Credit hold released by ' + user.email + ': ' + reason);

  readTable_('CreditChecks')
    .filter(function (c) { return String(c.salesOrderId) === String(salesOrderId) && c.result === 'Hold' && !c.releasedBy; })
    .forEach(function (c) {
      updateRowById_('CreditChecks', 'id', c.id, {
        releasedBy: user.email, releaseDate: todayIso_(), releaseNotes: reason
      }, 'Hold released');
    });

  readTable_('Approvals')
    .filter(function (a) {
      return a.relatedType === 'SalesOrder' && String(a.relatedId) === String(salesOrderId) &&
        a.status === 'Pending';
    })
    .forEach(function (a) {
      updateRowById_('Approvals', 'id', a.id, {
        level1Approver: user.email, level1Status: 'Approved', level1Date: todayIso_(),
        level1Notes: reason, status: 'Approved', closedDate: todayIso_()
      }, 'Credit hold approved');
    });

  return getSalesOrder(salesOrderId);
}

/** Moves an order through the lifecycle, refusing transitions that would skip a control. */
function setOrderStatus(salesOrderId, status, note) {
  var user = getCurrentUser();
  requireRole_(user, ORDER_EDITORS);

  var order = readTable_('SalesOrders').filter(function (o) {
    return String(o.id) === String(salesOrderId);
  })[0];
  if (!order) throw new Error('Order not found.');
  if (ORDER_STATUSES.indexOf(status) === -1) {
    throw new Error('Status must be one of: ' + ORDER_STATUSES.join(', ') + '.');
  }

  var allowed = ORDER_TRANSITIONS[order.orderStatus] || [];
  if (allowed.indexOf(status) === -1) {
    throw new Error('An order that is ' + order.orderStatus + ' can only move to: ' +
      (allowed.length ? allowed.join(', ') : 'nothing — it is complete') + '.');
  }

  // Dispatch is the gate the credit control exists to defend (FR-034).
  if (status === 'Ready for Dispatch' || status === 'Dispatched') {
    if (String(order.creditHold).toUpperCase() === 'TRUE') {
      throw new Error('This order is on credit hold. It must be released by Management before dispatch.');
    }
    var check = runCreditCheck(salesOrderId);
    if (check.result === 'Hold') {
      throw new Error('Credit check failed: ' + check.holdReason +
        '. The order has been placed on hold and needs Management release.');
    }
  }

  var patch = { orderStatus: status };
  if (status === 'Closed') patch.closedDate = todayIso_();
  if (note) patch.notes = String(note).trim();

  updateRowById_('SalesOrders', 'id', salesOrderId, patch,
    'Status ' + order.orderStatus + ' → ' + status + (note ? ': ' + note : ''));
  return getSalesOrder(salesOrderId);
}

/** PO details and dispatch promise — the fields a coordinator maintains on an open order. */
function saveOrderDetails(input) {
  var user = getCurrentUser();
  requireRole_(user, ORDER_EDITORS);

  var order = readTable_('SalesOrders').filter(function (o) {
    return String(o.id) === String(input.id);
  })[0];
  if (!order) throw new Error('Order not found.');
  if (order.orderStatus === 'Closed') throw new Error('A closed order cannot be edited.');

  var quote = readTable_('Quotations').filter(function (q) {
    return String(q.id) === String(order.quotationId);
  })[0];
  var quoteGrand = quote ? Number(quote.grand) || 0 : Number(order.grand) || 0;
  var poValue = input.poValue === '' || input.poValue === undefined || input.poValue === null
    ? '' : Number(input.poValue);

  var variance = [];
  if (poValue !== '' && Math.abs(poValue - quoteGrand) > 1) {
    variance.push('PO value ' + poValue.toFixed(2) + ' differs from the quoted ' +
      quoteGrand.toFixed(2) + ' by ' + (poValue - quoteGrand).toFixed(2));
  }
  if (!String(input.poDate || '').trim()) variance.push('No PO date recorded');

  var advanceReceived = input.advanceReceived === '' || input.advanceReceived === undefined
    ? Number(order.advanceReceived) || 0 : Number(input.advanceReceived);

  updateRowById_('SalesOrders', 'id', input.id, {
    poNo: String(input.poNo || '').trim(),
    poDate: String(input.poDate || '').slice(0, 10),
    poValue: poValue,
    poAttachmentUrl: String(input.poAttachmentUrl || '').trim(),
    poVerified: variance.length ? 'FALSE' : 'TRUE',
    poVarianceNotes: variance.join('; '),
    promisedDispatchDate: String(input.promisedDispatchDate || '').slice(0, 10),
    paymentTerms: String(input.paymentTerms || '').trim(),
    advanceRequired: input.advanceRequired === '' || input.advanceRequired === undefined
      ? '' : Number(input.advanceRequired),
    advanceReceived: advanceReceived,
    notes: String(input.notes || '').trim()
  }, 'Order details updated');

  // Advance and value changes move the credit answer, so re-evaluate rather than go stale.
  runCreditCheck(input.id);
  return getSalesOrder(input.id);
}

/** Quotations that are Won and not yet converted — what the "create order" picker offers. */
function listConvertibleQuotations() {
  getCurrentUser();
  var converted = {};
  readTable_('SalesOrders').forEach(function (o) { converted[String(o.quotationId)] = true; });

  var customerNames = {};
  readTable_('Customers').forEach(function (c) { customerNames[String(c.id)] = c.name; });

  return readTable_('Quotations')
    .filter(function (q) { return q.status === 'Won' && !converted[String(q.id)]; })
    .map(function (q) {
      return {
        id: q.id, quoteNo: q.quoteNo, revision: q.revision, date: q.date,
        customerId: q.customerId, customerName: customerNames[String(q.customerId)] || '',
        businessStream: q.businessStream, grand: Number(q.grand) || 0
      };
    });
}
