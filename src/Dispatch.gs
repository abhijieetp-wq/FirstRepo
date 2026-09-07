/**
 * Dispatch and logistics — M14.
 *
 * The readiness checklist (FR-045) is the control this module exists for. Every condition
 * that ought to be true before goods leave the building is evaluated from the data rather
 * than ticked by hand: the PO is recorded and matches, credit is clear, the required advance
 * is in, stock is actually reserved, and there is somewhere to ship to. A dispatch that fails
 * any of them is refused — unless Management overrides with a reason, which is written to the
 * approvals register (A09).
 *
 * Posting a dispatch is what moves stock. Until then a dispatch is a plan; afterwards the
 * ledger, the reservations, the serials and the order status all move together, because a
 * half-applied dispatch is worse than none.
 */

var DISPATCH_ROLES = [ROLES.SALES_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];
var DISPATCH_OVERRIDE_ROLES = [ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/**
 * Evaluates dispatch readiness for an order (FR-045). Returns every condition with its
 * verdict, so the screen can show what is blocking rather than a bare "not ready".
 */
function getDispatchReadiness(salesOrderId) {
  getCurrentUser();

  var order = readTable_('SalesOrders').filter(function (o) {
    return String(o.id) === String(salesOrderId);
  })[0];
  if (!order) throw new Error('Order not found.');

  var lines = readTable_('SalesOrderItems').filter(function (i) {
    return String(i.salesOrderId) === String(salesOrderId);
  });

  var unreserved = lines.filter(function (l) {
    return (Number(l.qtyReserved) || 0) < (Number(l.qty) || 0) - (Number(l.qtyDispatched) || 0);
  });

  var advanceRequired = order.advanceRequired === '' || order.advanceRequired === null
    ? 0 : Number(order.advanceRequired);
  var advanceReceived = Number(order.advanceReceived) || 0;

  var shipping = readTable_('CustomerAddresses').filter(function (a) {
    return String(a.id) === String(order.shippingAddressId);
  })[0];

  var checks = [
    {
      key: 'po',
      label: 'Customer PO recorded and matching the quotation',
      pass: !!String(order.poNo || '').trim() && String(order.poVerified).toUpperCase() !== 'FALSE',
      detail: !String(order.poNo || '').trim()
        ? 'No PO number recorded'
        : (String(order.poVerified).toUpperCase() === 'FALSE' ? order.poVarianceNotes : 'PO ' + order.poNo)
    },
    {
      key: 'credit',
      label: 'Credit cleared',
      pass: String(order.creditHold).toUpperCase() !== 'TRUE',
      detail: String(order.creditHold).toUpperCase() === 'TRUE'
        ? (order.creditHoldReason || 'On credit hold') : 'No hold'
    },
    {
      key: 'advance',
      label: 'Required advance received',
      pass: advanceReceived >= advanceRequired,
      detail: advanceRequired > 0
        ? advanceReceived + ' of ' + advanceRequired + ' received'
        : 'No advance required'
    },
    {
      key: 'stock',
      label: 'Stock reserved for every line',
      pass: unreserved.length === 0,
      detail: unreserved.length
        ? unreserved.length + ' line(s) not fully reserved: ' +
          unreserved.map(function (l) { return l.itemCode; }).join(', ')
        : lines.length + ' line(s) reserved'
    },
    {
      key: 'address',
      label: 'Shipping address on the order',
      pass: !!shipping,
      detail: shipping ? [shipping.line1, shipping.city].filter(Boolean).join(', ') : 'No shipping address set'
    }
  ];

  return {
    salesOrderId: salesOrderId,
    orderNo: order.orderNo,
    orderStatus: order.orderStatus,
    checks: checks,
    ready: checks.every(function (c) { return c.pass; }),
    blockers: checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.label; })
  };
}

function listDispatches(options) {
  getCurrentUser();
  var opts = options || {};

  var orders = {};
  readTable_('SalesOrders').forEach(function (o) {
    orders[String(o.id)] = { orderNo: o.orderNo, customerId: o.customerId, grand: o.grand };
  });
  var customerNames = {};
  readTable_('Customers').forEach(function (c) { customerNames[String(c.id)] = c.name; });

  var invoicedDispatches = {};
  readTable_('Invoices').forEach(function (inv) {
    if (inv.dispatchId) invoicedDispatches[String(inv.dispatchId)] = inv.invoiceNo;
  });

  var itemsByDispatch = {};
  readTable_('DispatchItems').forEach(function (i) {
    var key = String(i.dispatchId);
    (itemsByDispatch[key] = itemsByDispatch[key] || []).push(stripRow_(i));
  });

  return readTable_('Dispatches')
    .filter(function (d) { return opts.includeClosed || d.status !== 'Cancelled'; })
    .map(function (d) {
      var row = stripRow_(d);
      var order = orders[String(row.salesOrderId)] || {};
      row.orderNo = order.orderNo || '';
      row.customerName = customerNames[String(order.customerId)] || '';
      row.orderValue = Number(order.grand) || 0;
      row.items = itemsByDispatch[String(row.id)] || [];
      row.itemCount = row.items.length;
      row.invoiceNo = invoicedDispatches[String(row.id)] || '';
      row.awaitingInvoice = row.status === 'Dispatched' && !row.invoiceNo;
      return row;
    })
    .sort(function (a, b) { return String(b.dispatchDate).localeCompare(String(a.dispatchDate)); });
}

function getDispatch(id) {
  getCurrentUser();
  var d = readTable_('Dispatches').filter(function (r) { return String(r.id) === String(id); })[0];
  if (!d) throw new Error('Dispatch not found.');
  var row = stripRow_(d);

  row.items = readTable_('DispatchItems')
    .filter(function (i) { return String(i.dispatchId) === String(id); })
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); })
    .map(stripRow_);

  var order = readTable_('SalesOrders').filter(function (o) {
    return String(o.id) === String(row.salesOrderId);
  })[0];
  row.orderNo = order ? order.orderNo : '';
  row.orderStatus = order ? order.orderStatus : '';

  if (order) {
    var customer = readTable_('Customers').filter(function (c) {
      return String(c.id) === String(order.customerId);
    })[0];
    row.customerName = customer ? customer.name : '';
  }

  var invoice = readTable_('Invoices').filter(function (inv) {
    return String(inv.dispatchId) === String(id);
  })[0];
  row.invoiceNo = invoice ? invoice.invoiceNo : '';
  row.invoiceId = invoice ? invoice.id : '';
  return row;
}

/**
 * Opens a dispatch against an order, seeded with what is reserved.
 *
 * The readiness check runs here rather than at posting time, so an unready order never gets
 * as far as a packed pallet. An override is possible but is an explicit, recorded act.
 */
function createDispatch(input) {
  var user = getCurrentUser();
  requireRole_(user, DISPATCH_ROLES);

  var order = readTable_('SalesOrders').filter(function (o) {
    return String(o.id) === String(input.salesOrderId);
  })[0];
  if (!order) throw new Error('Order not found.');

  var readiness = getDispatchReadiness(input.salesOrderId);
  var override = !!input.overrideReason;

  if (!readiness.ready && !override) {
    throw new Error('This order is not ready to dispatch: ' + readiness.blockers.join('; ') +
      '. Management can override with a reason.');
  }
  if (!readiness.ready && override) {
    requireRole_(user, DISPATCH_OVERRIDE_ROLES);
    if (!String(input.overrideReason).trim()) {
      throw new Error('A reason is required to dispatch against an incomplete checklist.');
    }
  }

  var dispatch = {
    id: generateId_('DSP-'),
    dispatchNo: nextSeriesNo_('Dispatches', 'dispatchNo', 'DSP'),
    salesOrderId: input.salesOrderId,
    dispatchDate: String(input.dispatchDate || todayIso_()).slice(0, 10),
    checklistComplete: readiness.ready ? 'TRUE' : 'FALSE',
    checklistNotes: readiness.ready ? '' : 'Overridden: ' + (input.overrideReason || ''),
    transporterName: String(input.transporterName || '').trim(),
    lrNumber: String(input.lrNumber || '').trim(),
    lrDate: String(input.lrDate || '').slice(0, 10),
    ewayBillNo: String(input.ewayBillNo || '').trim(),
    packingListRef: String(input.packingListRef || '').trim(),
    certificatesRef: String(input.certificatesRef || '').trim(),
    deliveryChallanNo: String(input.deliveryChallanNo || '').trim(),
    dispatchedBy: user.email,
    podRef: '', podDate: '',
    deliveryConfirmed: 'No', deliveryConfirmedDate: '', serviceNotified: 'No',
    status: 'Planned',
    createdAt: todayIso_(),
    createdBy: user.email
  };
  appendRow_('Dispatches', dispatch, 'Dispatch opened for order ' + order.orderNo);

  if (!readiness.ready) {
    appendRow_('Approvals', {
      id: generateId_('APR-'),
      approvalType: 'Dispatch Exception',
      relatedType: 'Dispatch',
      relatedId: dispatch.id,
      requestedBy: user.email,
      requestDate: todayIso_(),
      requestReason: input.overrideReason,
      contextSummary: 'Unmet: ' + readiness.blockers.join('; '),
      level1Approver: user.email, level1Status: 'Approved', level1Date: todayIso_(),
      level1Notes: input.overrideReason,
      level2Approver: '', level2Status: '', level2Date: '', level2Notes: '',
      status: 'Approved', closedDate: todayIso_()
    }, 'Dispatch override recorded');
  }

  // Seed the lines from what is reserved — the realistic default for what will ship.
  var lines = readTable_('SalesOrderItems')
    .filter(function (i) { return String(i.salesOrderId) === String(input.salesOrderId); })
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); });

  lines.forEach(function (line, idx) {
    var outstanding = (Number(line.qty) || 0) - (Number(line.qtyDispatched) || 0);
    var qty = Math.min(outstanding, Number(line.qtyReserved) || 0);
    if (qty <= 0) return;
    appendRow_('DispatchItems', {
      id: generateId_('DSPI-'),
      dispatchId: dispatch.id,
      salesOrderItemId: line.id,
      lineNo: idx + 1,
      itemType: line.itemType,
      itemId: line.itemId,
      itemCode: line.itemCode,
      description: line.description,
      qtyDispatched: qty,
      serialNos: '',
      binId: '',
      notes: ''
    }, 'Line seeded from the reservation');
  });

  return getDispatch(dispatch.id);
}

function saveDispatchDetails(input) {
  var user = getCurrentUser();
  requireRole_(user, DISPATCH_ROLES);

  var dispatch = readTable_('Dispatches').filter(function (d) {
    return String(d.id) === String(input.id);
  })[0];
  if (!dispatch) throw new Error('Dispatch not found.');
  if (dispatch.status === 'Dispatched') {
    throw new Error('This dispatch has been posted. Correct it with a stock adjustment rather than an edit.');
  }

  updateRowById_('Dispatches', 'id', input.id, {
    dispatchDate: String(input.dispatchDate || dispatch.dispatchDate).slice(0, 10),
    transporterName: String(input.transporterName || '').trim(),
    lrNumber: String(input.lrNumber || '').trim(),
    lrDate: String(input.lrDate || '').slice(0, 10),
    ewayBillNo: String(input.ewayBillNo || '').trim(),
    packingListRef: String(input.packingListRef || '').trim(),
    certificatesRef: String(input.certificatesRef || '').trim(),
    deliveryChallanNo: String(input.deliveryChallanNo || '').trim()
  }, 'Dispatch details updated');
  return getDispatch(input.id);
}

function saveDispatchItem(input) {
  var user = getCurrentUser();
  requireRole_(user, DISPATCH_ROLES);

  var dispatch = readTable_('Dispatches').filter(function (d) {
    return String(d.id) === String(input.dispatchId);
  })[0];
  if (!dispatch) throw new Error('Dispatch not found.');
  if (dispatch.status === 'Dispatched') throw new Error('This dispatch has been posted and cannot be changed.');

  var qty = Number(input.qtyDispatched);
  if (isNaN(qty) || qty <= 0) throw new Error('Dispatch quantity must be greater than zero.');

  var line = readTable_('SalesOrderItems').filter(function (i) {
    return String(i.id) === String(input.salesOrderItemId);
  })[0];
  if (line) {
    var outstanding = (Number(line.qty) || 0) - (Number(line.qtyDispatched) || 0);
    if (qty > outstanding) {
      throw new Error('Only ' + outstanding + ' of ' + line.itemCode + ' remain to dispatch on this order.');
    }
  }

  updateRowById_('DispatchItems', 'id', input.id, {
    qtyDispatched: qty,
    serialNos: String(input.serialNos || '').trim(),
    binId: String(input.binId || '').trim(),
    notes: String(input.notes || '').trim()
  }, 'Dispatch line updated');
  return getDispatch(input.dispatchId);
}

function deleteDispatchItem(id) {
  var user = getCurrentUser();
  requireRole_(user, DISPATCH_ROLES);
  var line = readTable_('DispatchItems').filter(function (i) { return String(i.id) === String(id); })[0];
  if (!line) throw new Error('That line no longer exists.');

  var dispatch = readTable_('Dispatches').filter(function (d) {
    return String(d.id) === String(line.dispatchId);
  })[0];
  if (dispatch && dispatch.status === 'Dispatched') {
    throw new Error('This dispatch has been posted and cannot be changed.');
  }
  deleteRowById_('DispatchItems', 'id', id, 'Dispatch line removed');
  return getDispatch(line.dispatchId);
}

/**
 * Posts the dispatch: stock leaves, reservations are consumed, serials move, and the order
 * becomes Dispatched. These belong together — a dispatch that reduced stock without
 * consuming its reservation would double-count the commitment.
 */
function postDispatch(dispatchId) {
  var user = getCurrentUser();
  requireRole_(user, DISPATCH_ROLES);

  var dispatch = readTable_('Dispatches').filter(function (d) {
    return String(d.id) === String(dispatchId);
  })[0];
  if (!dispatch) throw new Error('Dispatch not found.');
  if (dispatch.status === 'Dispatched') throw new Error('This dispatch has already been posted.');

  var items = readTable_('DispatchItems').filter(function (i) {
    return String(i.dispatchId) === String(dispatchId);
  });
  if (!items.length) throw new Error('Nothing is on this dispatch to send.');

  var order = readTable_('SalesOrders').filter(function (o) {
    return String(o.id) === String(dispatch.salesOrderId);
  })[0];
  if (order && String(order.creditHold).toUpperCase() === 'TRUE') {
    throw new Error('This order is on credit hold. It cannot be dispatched until Management releases it.');
  }

  var reservations = readTable_('StockReservations').filter(function (r) {
    return String(r.salesOrderId) === String(dispatch.salesOrderId) && String(r.status) === 'Active';
  });

  items.forEach(function (item) {
    var qty = Number(item.qtyDispatched) || 0;
    if (qty <= 0) return;

    // Stock out.
    recordStockMovement({
      itemType: item.itemType,
      itemId: item.itemId,
      itemCode: item.itemCode,
      movementType: 'Dispatch',
      qty: -qty,
      binId: item.binId,
      referenceType: 'Dispatch',
      referenceId: dispatchId,
      notes: 'Dispatch ' + dispatch.dispatchNo
    });

    // Consume the matching reservation so the commitment is not counted twice.
    var remaining = qty;
    reservations
      .filter(function (r) { return String(r.salesOrderItemId) === String(item.salesOrderItemId); })
      .forEach(function (r) {
        if (remaining <= 0) return;
        var take = Math.min(remaining, Number(r.qtyReserved) || 0);
        remaining -= take;
        updateRowById_('StockReservations', 'id', r.id, {
          status: take >= (Number(r.qtyReserved) || 0) ? 'Consumed' : 'Active',
          qtyReserved: Math.max(0, (Number(r.qtyReserved) || 0) - take),
          releasedDate: todayIso_(),
          releaseReason: 'Consumed by dispatch ' + dispatch.dispatchNo
        }, 'Reservation consumed on dispatch');
      });

    var line = readTable_('SalesOrderItems').filter(function (l) {
      return String(l.id) === String(item.salesOrderItemId);
    })[0];
    if (line) {
      updateRowById_('SalesOrderItems', 'id', line.id, {
        qtyDispatched: (Number(line.qtyDispatched) || 0) + qty,
        qtyReserved: Math.max(0, (Number(line.qtyReserved) || 0) - qty)
      }, 'Dispatched ' + qty);
    }

    // Serials follow the goods (FR-038).
    if (String(item.serialNos || '').trim()) {
      String(item.serialNos).split(/[,\n]/).forEach(function (sn) {
        var serial = sn.trim();
        if (!serial) return;
        var record = readTable_('SerialNumbers').filter(function (s) {
          return String(s.serialNo).trim().toLowerCase() === serial.toLowerCase();
        })[0];
        if (record) {
          updateRowById_('SerialNumbers', 'id', record.id, {
            status: 'Dispatched',
            salesOrderId: dispatch.salesOrderId,
            dispatchId: dispatchId
          }, 'Dispatched on ' + dispatch.dispatchNo);
        }
      });
    }
  });

  updateRowById_('Dispatches', 'id', dispatchId, { status: 'Dispatched' },
    'Dispatch posted — stock released');

  if (order && (ORDER_TRANSITIONS[order.orderStatus] || []).indexOf('Dispatched') !== -1) {
    updateRowById_('SalesOrders', 'id', order.id, { orderStatus: 'Dispatched' },
      'Dispatch ' + dispatch.dispatchNo + ' posted');
  }

  return getDispatch(dispatchId);
}

/** Proof of delivery, and the flag the service handoff will hang off in Phase 2 (FR-047). */
function confirmDelivery(dispatchId, input) {
  var user = getCurrentUser();
  requireRole_(user, DISPATCH_ROLES);

  var dispatch = readTable_('Dispatches').filter(function (d) {
    return String(d.id) === String(dispatchId);
  })[0];
  if (!dispatch) throw new Error('Dispatch not found.');
  if (dispatch.status !== 'Dispatched') throw new Error('Post the dispatch before confirming delivery.');

  updateRowById_('Dispatches', 'id', dispatchId, {
    deliveryConfirmed: 'Yes',
    deliveryConfirmedDate: String((input && input.date) || todayIso_()).slice(0, 10),
    podRef: String((input && input.podRef) || '').trim(),
    podDate: String((input && input.date) || todayIso_()).slice(0, 10)
  }, 'Delivery confirmed by the customer');
  return getDispatch(dispatchId);
}

/** Orders that can be dispatched now — what the "new dispatch" picker offers. */
function listDispatchableOrders() {
  getCurrentUser();
  var customerNames = {};
  readTable_('Customers').forEach(function (c) { customerNames[String(c.id)] = c.name; });

  return readTable_('SalesOrders')
    .filter(function (o) {
      return ['Material Pending', 'Ready for Dispatch'].indexOf(o.orderStatus) !== -1;
    })
    .map(function (o) {
      var readiness = getDispatchReadiness(o.id);
      return {
        id: o.id, orderNo: o.orderNo, date: o.date,
        customerName: customerNames[String(o.customerId)] || '',
        grand: Number(o.grand) || 0,
        orderStatus: o.orderStatus,
        ready: readiness.ready,
        blockers: readiness.blockers
      };
    });
}
