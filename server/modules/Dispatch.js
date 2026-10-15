/**
 * Converted from src/Dispatch.gs by migration/to-async.js.
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
async function getDispatchReadiness(salesOrderId) {
  getCurrentUser();

  var order = (await readTable_('SalesOrders')).filter(function (o) {
    return String(o.id) === String(salesOrderId);
  })[0];
  if (!order) throw new Error('Order not found.');

  var lines = (await readTable_('SalesOrderItems')).filter(function (i) {
    return String(i.salesOrderId) === String(salesOrderId);
  });

  var unreserved = lines.filter(function (l) {
    return (Number(l.qtyReserved) || 0) < (Number(l.qty) || 0) - (Number(l.qtyDispatched) || 0);
  });

  var advanceRequired = order.advanceRequired === '' || order.advanceRequired === null
    ? 0 : Number(order.advanceRequired);
  var advanceReceived = Number(order.advanceReceived) || 0;

  var shipping = (await readTable_('CustomerAddresses')).filter(function (a) {
    return String(a.id) === String(order.shippingAddressId);
  })[0];
  var customer = await findRowById_('Customers', order.customerId);
  var customerName = customer && customer.name ? customer.name : '';

  // Which of these stop a dispatch and which only warn is PIE's call, not a property of the
  // check. Only credit does both — an order on hold is a decision Management has taken and no
  // amount of the warehouse being ready overrides it. The address stops the goods leaving
  // rather than the paperwork starting: a coordinator can prepare a dispatch while somebody
  // chases the address, but a consignment with nowhere to go cannot be posted.
  //
  // The rest advise. PIE ship before the advance lands, and the warehouse knows what is on the
  // shelf better than the reservation does — a check that refuses what the business routinely
  // and deliberately does is not a control, it is a thing people learn to override, and an
  // override everybody uses protects nothing.
  var checks = [
    {
      key: 'po',
      blocks: '',
      label: 'Customer PO recorded and matching the quotation',
      pass: !!String(order.poNo || '').trim() && String(order.poVerified).toUpperCase() !== 'FALSE',
      detail: !String(order.poNo || '').trim()
        ? 'No PO number recorded'
        : (String(order.poVerified).toUpperCase() === 'FALSE' ? order.poVarianceNotes : 'PO ' + order.poNo)
    },
    {
      key: 'credit',
      blocks: 'create',
      label: 'Credit cleared',
      pass: String(order.creditHold).toUpperCase() !== 'TRUE',
      detail: String(order.creditHold).toUpperCase() === 'TRUE'
        ? (order.creditHoldReason || 'On credit hold') : 'No hold'
    },
    {
      key: 'advance',
      blocks: '',
      label: 'Required advance received',
      pass: advanceReceived >= advanceRequired,
      detail: advanceRequired > 0
        ? advanceReceived + ' of ' + advanceRequired + ' received'
        : 'No advance required'
    },
    {
      key: 'stock',
      blocks: '',
      label: 'Stock reserved for every line',
      pass: unreserved.length === 0,
      detail: unreserved.length
        ? unreserved.length + ' line(s) not fully reserved: ' +
          unreserved.map(function (l) { return l.itemCode; }).join(', ')
        : lines.length + ' line(s) reserved'
    },
    {
      key: 'address',
      blocks: 'post',
      label: 'Shipping address on the order',
      pass: !!shipping,
      detail: shipping
        ? [shipping.line1, shipping.city].filter(Boolean).join(', ')
        : 'The customer record' + (customerName ? ' for ' + customerName : '') +
          ' has no address on it. Open Customers \u2192 ' + (customerName || 'that customer') +
          ' \u2192 Addresses and add one.'
    }
  ];

  var failedBlocking = function (when) {
    return checks.filter(function (c) {
      return !c.pass && (c.blocks === when || (when === 'post' && c.blocks === 'create'));
    });
  };
  var names = function (list) { return list.map(function (c) { return c.label; }); };

  return {
    salesOrderId: salesOrderId,
    orderNo: order.orderNo,
    orderStatus: order.orderStatus,
    checks: checks,
    // Everything green. Still worth reporting even though most of it no longer refuses
    // anything: a coordinator about to ship should see what is not in order, and deciding to
    // ship anyway is a different thing from not having been told.
    ready: checks.every(function (c) { return c.pass; }),
    blockers: names(checks.filter(function (c) { return !c.pass; })),
    // What actually stops each step. Anything blocking creation blocks posting too — the truck
    // cannot leave for a reason that was serious enough to stop the paperwork.
    stopsDispatch: names(failedBlocking('create')),
    stopsPosting: names(failedBlocking('post')),
    warnings: names(checks.filter(function (c) { return !c.pass && !c.blocks; }))
  };
}

async function listDispatches(options) {
  var user = getCurrentUser();
  requireCommercial_(user, 'Dispatches');
  var opts = options || {};

  // A dispatch has no stream of its own; it belongs to the stream its order belongs to.
  var orders = {};
  (await readTable_('SalesOrders')).forEach(function (o) {
    orders[String(o.id)] = { orderNo: o.orderNo, customerId: o.customerId, grand: o.grand,
      businessStream: o.businessStream };
  });
  var customerNames = {};
  (await readTable_('Customers')).forEach(function (c) { customerNames[String(c.id)] = c.name; });

  var invoicedDispatches = {};
  (await readTable_('Invoices')).forEach(function (inv) {
    if (inv.dispatchId) invoicedDispatches[String(inv.dispatchId)] = inv.invoiceNo;
  });

  var itemsByDispatch = {};
  (await readTable_('DispatchItems')).forEach(function (i) {
    var key = String(i.dispatchId);
    (itemsByDispatch[key] = itemsByDispatch[key] || []).push(stripRow_(i));
  });

  return (await readTable_('Dispatches'))
    .filter(function (d) { return opts.includeClosed || d.status !== 'Cancelled'; })
    .filter(function (d) {
      var o = orders[String(d.salesOrderId)];
      return streamAllowed_(user, o && o.businessStream);
    })
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

async function getDispatch(id) {
  var reader = getCurrentUser();
  var d = (await readTable_('Dispatches')).filter(function (r) { return String(r.id) === String(id); })[0];
  if (!d) throw new Error('Dispatch not found.');
  var parent = d.salesOrderId ? await findRowById_('SalesOrders', d.salesOrderId) : null;
  requireCommercial_(reader, 'A dispatch');
  requireStream_(reader, parent && parent.businessStream, 'This dispatch');
  var row = stripRow_(d);

  row.items = (await readTable_('DispatchItems'))
    .filter(function (i) { return String(i.dispatchId) === String(id); })
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); })
    .map(stripRow_);

  var order = (await readTable_('SalesOrders')).filter(function (o) {
    return String(o.id) === String(row.salesOrderId);
  })[0];
  row.orderNo = order ? order.orderNo : '';
  row.orderStatus = order ? order.orderStatus : '';

  if (order) {
    var customer = (await readTable_('Customers')).filter(function (c) {
      return String(c.id) === String(order.customerId);
    })[0];
    row.customerName = customer ? customer.name : '';
  }

  var invoice = (await readTable_('Invoices')).filter(function (inv) {
    return String(inv.dispatchId) === String(id);
  })[0];
  row.invoiceNo = invoice ? invoice.invoiceNo : '';
  row.invoiceId = invoice ? invoice.id : '';

  // The photographs the customer sent back, and the job they triggered.
  row.proofs = await listPodPhotos(id);
  var job = (await findRowsByColumn_('ServiceJobs', 'dispatchId', [String(id)]))
    .filter(function (j) { return j.status !== 'Cancelled'; })[0];
  row.serviceJob = job ? stripRow_(job) : null;
  return row;
}

/**
 * Opens a dispatch against an order, seeded with what is reserved.
 *
 * The readiness check runs here rather than at posting time, so an unready order never gets
 * as far as a packed pallet. An override is possible but is an explicit, recorded act.
 */
async function createDispatch(input) {
  var user = getCurrentUser();
  requireRole_(user, DISPATCH_ROLES);

  var order = (await readTable_('SalesOrders')).filter(function (o) {
    return String(o.id) === String(input.salesOrderId);
  })[0];
  if (!order) throw new Error('Order not found.');

  var readiness = await getDispatchReadiness(input.salesOrderId);
  var override = !!input.overrideReason;

  // Only the blocking failures refuse. The rest are recorded on the dispatch and shown on the
  // screen, so what was not in order when it went out is answerable afterwards.
  if (readiness.stopsDispatch.length && !override) {
    throw new Error('This order cannot be dispatched: ' + readiness.stopsDispatch.join('; ') +
      '. Management can override with a reason.');
  }
  if (readiness.stopsDispatch.length && override) {
    requireRole_(user, DISPATCH_OVERRIDE_ROLES);
    if (!String(input.overrideReason).trim()) {
      throw new Error('A reason is required to dispatch against a blocking check.');
    }
  }

  var dispatch = {
    id: generateId_('DSP-'),
    dispatchNo: await nextSeriesNo_('Dispatches', 'dispatchNo', 'DSP'),
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
  await appendRow_('Dispatches', dispatch, 'Dispatch opened for order ' + order.orderNo);

  if (!readiness.ready) {
    await appendRow_('Approvals', {
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
  var lines = (await readTable_('SalesOrderItems'))
    .filter(function (i) { return String(i.salesOrderId) === String(input.salesOrderId); })
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); });

  for (var idx = 0; idx < lines.length; idx++) {
    var line = lines[idx];
    var outstanding = (Number(line.qty) || 0) - (Number(line.qtyDispatched) || 0);
    var qty = Math.min(outstanding, Number(line.qtyReserved) || 0);
    if (qty <= 0) continue;
    await appendRow_('DispatchItems', {
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
  }

  return await getDispatch(dispatch.id);
}

async function saveDispatchDetails(input) {
  var user = getCurrentUser();
  requireRole_(user, DISPATCH_ROLES);

  var dispatch = (await readTable_('Dispatches')).filter(function (d) {
    return String(d.id) === String(input.id);
  })[0];
  if (!dispatch) throw new Error('Dispatch not found.');
  if (dispatch.status === 'Dispatched') {
    throw new Error('This dispatch has been posted. Correct it with a stock adjustment rather than an edit.');
  }

  await updateRowById_('Dispatches', 'id', input.id, {
    dispatchDate: String(input.dispatchDate || dispatch.dispatchDate).slice(0, 10),
    transporterName: String(input.transporterName || '').trim(),
    lrNumber: String(input.lrNumber || '').trim(),
    lrDate: String(input.lrDate || '').slice(0, 10),
    ewayBillNo: String(input.ewayBillNo || '').trim(),
    packingListRef: String(input.packingListRef || '').trim(),
    certificatesRef: String(input.certificatesRef || '').trim(),
    deliveryChallanNo: String(input.deliveryChallanNo || '').trim()
  }, 'Dispatch details updated');
  return await getDispatch(input.id);
}

async function saveDispatchItem(input) {
  var user = getCurrentUser();
  requireRole_(user, DISPATCH_ROLES);

  var dispatch = (await readTable_('Dispatches')).filter(function (d) {
    return String(d.id) === String(input.dispatchId);
  })[0];
  if (!dispatch) throw new Error('Dispatch not found.');
  if (dispatch.status === 'Dispatched') throw new Error('This dispatch has been posted and cannot be changed.');

  var qty = Number(input.qtyDispatched);
  if (isNaN(qty) || qty <= 0) throw new Error('Dispatch quantity must be greater than zero.');

  var line = (await readTable_('SalesOrderItems')).filter(function (i) {
    return String(i.id) === String(input.salesOrderItemId);
  })[0];
  if (line) {
    var outstanding = (Number(line.qty) || 0) - (Number(line.qtyDispatched) || 0);
    if (qty > outstanding) {
      throw new Error('Only ' + outstanding + ' of ' + line.itemCode + ' remain to dispatch on this order.');
    }
  }

  await updateRowById_('DispatchItems', 'id', input.id, {
    qtyDispatched: qty,
    serialNos: String(input.serialNos || '').trim(),
    binId: String(input.binId || '').trim(),
    notes: String(input.notes || '').trim()
  }, 'Dispatch line updated');
  return await getDispatch(input.dispatchId);
}

async function deleteDispatchItem(id) {
  var user = getCurrentUser();
  requireRole_(user, DISPATCH_ROLES);
  var line = (await readTable_('DispatchItems')).filter(function (i) { return String(i.id) === String(id); })[0];
  if (!line) throw new Error('That line no longer exists.');

  var dispatch = (await readTable_('Dispatches')).filter(function (d) {
    return String(d.id) === String(line.dispatchId);
  })[0];
  if (dispatch && dispatch.status === 'Dispatched') {
    throw new Error('This dispatch has been posted and cannot be changed.');
  }
  await deleteRowById_('DispatchItems', 'id', id, 'Dispatch line removed');
  return await getDispatch(line.dispatchId);
}

/**
 * Posts the dispatch: stock leaves, reservations are consumed, serials move, and the order
 * becomes Dispatched. These belong together — a dispatch that reduced stock without
 * consuming its reservation would double-count the commitment.
 */
async function postDispatch(dispatchId) {
  var user = getCurrentUser();
  requireRole_(user, DISPATCH_ROLES);

  var dispatch = (await readTable_('Dispatches')).filter(function (d) {
    return String(d.id) === String(dispatchId);
  })[0];
  if (!dispatch) throw new Error('Dispatch not found.');
  if (dispatch.status === 'Dispatched') throw new Error('This dispatch has already been posted.');

  var items = (await readTable_('DispatchItems')).filter(function (i) {
    return String(i.dispatchId) === String(dispatchId);
  });
  if (!items.length) throw new Error('Nothing is on this dispatch to send.');

  var order = (await readTable_('SalesOrders')).filter(function (o) {
    return String(o.id) === String(dispatch.salesOrderId);
  })[0];
  if (order && String(order.creditHold).toUpperCase() === 'TRUE') {
    throw new Error('This order is on credit hold. It cannot be dispatched until Management releases it.');
  }

  // Preparing a dispatch without a delivery address is allowed — somebody can be chasing it
  // while the warehouse packs. Sending one is not: this is the moment the goods physically
  // leave, and the challan that travels with them has to say where they are going.
  if (order && !String(order.shippingAddressId || '').trim()) {
    throw new Error('This order has no delivery address, so there is nowhere to send it. ' +
      'Add one on the customer and set it on the order first.');
  }

  var reservations = (await readTable_('StockReservations')).filter(function (r) {
    return String(r.salesOrderId) === String(dispatch.salesOrderId) && String(r.status) === 'Active';
  });

  for (var item of items) {
    var qty = Number(item.qtyDispatched) || 0;
    if (qty <= 0) continue;

    // Stock out.
    await recordStockMovement({
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
    var against = reservations
      .filter(function (r) { return String(r.salesOrderItemId) === String(item.salesOrderItemId); });
    for (var r of against) {
      if (remaining <= 0) continue;
      var take = Math.min(remaining, Number(r.qtyReserved) || 0);
      remaining -= take;
      await updateRowById_('StockReservations', 'id', r.id, {
        status: take >= (Number(r.qtyReserved) || 0) ? 'Consumed' : 'Active',
        qtyReserved: Math.max(0, (Number(r.qtyReserved) || 0) - take),
        releasedDate: todayIso_(),
        releaseReason: 'Consumed by dispatch ' + dispatch.dispatchNo
      }, 'Reservation consumed on dispatch');
    }

    var line = (await readTable_('SalesOrderItems')).filter(function (l) {
      return String(l.id) === String(item.salesOrderItemId);
    })[0];
    if (line) {
      await updateRowById_('SalesOrderItems', 'id', line.id, {
        qtyDispatched: (Number(line.qtyDispatched) || 0) + qty,
        qtyReserved: Math.max(0, (Number(line.qtyReserved) || 0) - qty)
      }, 'Dispatched ' + qty);
    }

    // Serials follow the goods (FR-038).
    if (String(item.serialNos || '').trim()) {
      for (var sn of String(item.serialNos).split(/[,\n]/)) {
        var serial = sn.trim();
        if (!serial) continue;
        var record = (await readTable_('SerialNumbers')).filter(function (s) {
          return String(s.serialNo).trim().toLowerCase() === serial.toLowerCase();
        })[0];
        if (record) {
          await updateRowById_('SerialNumbers', 'id', record.id, {
            status: 'Dispatched',
            salesOrderId: dispatch.salesOrderId,
            dispatchId: dispatchId
          }, 'Dispatched on ' + dispatch.dispatchNo);
        }
      }
    }
  }

  await updateRowById_('Dispatches', 'id', dispatchId, { status: 'Dispatched' },
    'Dispatch posted — stock released');

  if (order && (ORDER_TRANSITIONS[order.orderStatus] || []).indexOf('Dispatched') !== -1) {
    await updateRowById_('SalesOrders', 'id', order.id, { orderStatus: 'Dispatched' },
      'Dispatch ' + dispatch.dispatchNo + ' posted');
  }

  return await getDispatch(dispatchId);
}

/**
 * Proof of delivery, and the handoff to service.
 *
 * This is the end of PIE's process: the customer's photograph comes back, and the engineer is
 * told to go and fit what arrived. `serviceNotified` sat on this table from the beginning and
 * nothing ever set it, so the last step happened entirely on WhatsApp with no record of it.
 * Confirming a delivery now raises the job — with the customer, the machine and the parts that
 * were actually dispatched — and names the engineer if one has been chosen.
 */
async function confirmDelivery(dispatchId, input) {
  var user = getCurrentUser();
  requireRole_(user, DISPATCH_ROLES);

  var dispatch = (await readTable_('Dispatches')).filter(function (d) {
    return String(d.id) === String(dispatchId);
  })[0];
  if (!dispatch) throw new Error('Dispatch not found.');
  if (dispatch.status !== 'Dispatched') throw new Error('Post the dispatch before confirming delivery.');

  // The photograph is the proof. Confirming without one is allowed — a customer who rings
  // instead of sending a picture is still a delivery — but it is worth saying so.
  var proofs = await listPodPhotos(dispatchId);

  await updateRowById_('Dispatches', 'id', dispatchId, {
    deliveryConfirmed: 'Yes',
    deliveryConfirmedDate: String((input && input.date) || todayIso_()).slice(0, 10),
    podRef: String((input && input.podRef) || '').trim() ||
      (proofs.length ? proofs.length + ' photo' + (proofs.length === 1 ? '' : 's') + ' on file' : ''),
    podDate: String((input && input.date) || todayIso_()).slice(0, 10)
  }, 'Delivery confirmed by the customer');

  var job = await raiseServiceJob_(dispatch, input && input.engineerEmail, user);
  await updateRowById_('Dispatches', 'id', dispatchId, { serviceNotified: 'Yes' },
    'Service job ' + job.jobNo + ' raised');

  var result = await getDispatch(dispatchId);
  result.serviceJob = job;
  result.proofCount = proofs.length;
  return result;
}

/** Orders that can be dispatched now — what the "new dispatch" picker offers. */
async function listDispatchableOrders() {
  getCurrentUser();
  var customerNames = {};
  (await readTable_('Customers')).forEach(function (c) { customerNames[String(c.id)] = c.name; });

  var candidates = (await readTable_('SalesOrders'))
    .filter(function (o) {
      return ['Material Pending', 'Ready for Dispatch'].indexOf(o.orderStatus) !== -1;
    });

  var out = [];
  for (var o of candidates) {
    var readiness = await getDispatchReadiness(o.id);
    out.push({
      id: o.id, orderNo: o.orderNo, date: o.date,
      customerName: customerNames[String(o.customerId)] || '',
      grand: Number(o.grand) || 0,
      orderStatus: o.orderStatus,
      ready: readiness.ready,
      blockers: readiness.blockers
    });
  }
  return out;
}
