/**
 * Inventory, reservations, serials and material inward — M12, M13.
 *
 * Stock is never a number someone edits. On-hand is the sum of StockMovements, reserved is
 * the sum of active reservations, and available is the difference — so any figure can be
 * explained by the rows that produced it, and a wrong number is a wrong movement rather than
 * a mystery.
 *
 * The two controls that matter here:
 *
 *   Reservation (FR-037) — stock committed to a sales order cannot be promised again. The
 *   reservation is checked against *available*, not on-hand, so two orders cannot both be
 *   told the same part is free. Cancelling an order releases it.
 *
 *   Inward verification (FR-043) — a GRN records what arrived, but stock does not move until
 *   someone verifies it. Receiving and verifying are separate acts by design: posting stock
 *   on receipt is how unchecked material becomes sellable.
 */

var STORES_ROLES = [ROLES.SALES_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];
var SERIAL_STATUSES = ['In Stock', 'Reserved', 'Dispatched', 'Installed'];

// ------------------------------------------------------------------ stock view

/** Every stocked item with its live position, for the inventory screen (FR-036). */
function listInventory(itemType) {
  getCurrentUser();
  var type = itemType === 'Product' ? 'Product' : 'Spare';
  var tab = type === 'Product' ? 'Products' : 'Spares';

  var onHand = stockOnHandMap_(type);
  var reserved = stockReservedMap_(type);
  var prices = priceMapFor_(type);

  var warehouseNames = {};
  readTable_('Warehouses').forEach(function (w) { warehouseNames[String(w.id)] = w.name; });

  return readTable_(tab)
    .filter(function (r) { return String(r.active).toUpperCase() !== 'FALSE'; })
    .map(function (r) {
      var id = String(r.id);
      var have = onHand[id] || 0;
      var res = reserved[id] || 0;
      var levels = prices[id] || {};
      return {
        id: r.id,
        itemType: type,
        code: type === 'Product' ? r.productCode : r.partNo,
        description: type === 'Product' ? (r.model || r.description) : r.description,
        category: r.category,
        uom: r.uom,
        binId: r.defaultBinId || '',
        warehouse: warehouseNames[String(r.defaultWarehouseId)] || '',
        onHand: have,
        reserved: res,
        available: have - res,
        reorderLevel: r.reorderLevel === '' || r.reorderLevel === undefined ? null : Number(r.reorderLevel),
        belowReorder: r.reorderLevel !== '' && r.reorderLevel !== undefined &&
          (have - res) <= Number(r.reorderLevel),
        stockValue: roundMoney_((levels[SELLING_PRICE_LEVEL] ? levels[SELLING_PRICE_LEVEL].price : 0) * have)
      };
    })
    .sort(function (a, b) { return String(a.code).localeCompare(String(b.code)); });
}

// ------------------------------------------------------------------ reservations

/**
 * Reserves stock for every line on an order (FR-037).
 *
 * Partial reservation is deliberate: reserving what exists and reporting the shortfall is
 * more useful than an all-or-nothing failure, because the shortfall is exactly what
 * procurement needs to know.
 */
function reserveStockForOrder(salesOrderId) {
  var user = getCurrentUser();
  requireRole_(user, STORES_ROLES);

  var order = readTable_('SalesOrders').filter(function (o) {
    return String(o.id) === String(salesOrderId);
  })[0];
  if (!order) throw new Error('Order not found.');

  var lines = readTable_('SalesOrderItems').filter(function (i) {
    return String(i.salesOrderId) === String(salesOrderId);
  });
  if (!lines.length) throw new Error('This order has no lines to reserve.');

  var existing = {};
  readTable_('StockReservations').forEach(function (r) {
    if (String(r.salesOrderId) !== String(salesOrderId)) return;
    if (String(r.status) !== 'Active') return;
    existing[String(r.salesOrderItemId)] = (existing[String(r.salesOrderItemId)] || 0) + (Number(r.qtyReserved) || 0);
  });

  var onHandSpare = stockOnHandMap_('Spare');
  var onHandProduct = stockOnHandMap_('Product');
  var resSpare = stockReservedMap_('Spare');
  var resProduct = stockReservedMap_('Product');

  var reservedNow = [];
  var shortfalls = [];

  lines.forEach(function (line) {
    var want = (Number(line.qty) || 0) - (existing[String(line.id)] || 0);
    if (want <= 0) return;

    var isProduct = line.itemType === 'Product';
    var onHand = (isProduct ? onHandProduct : onHandSpare)[String(line.itemId)] || 0;
    var alreadyReserved = (isProduct ? resProduct : resSpare)[String(line.itemId)] || 0;
    var available = onHand - alreadyReserved;

    var qty = Math.min(want, Math.max(0, available));
    if (qty > 0) {
      appendRow_('StockReservations', {
        id: generateId_('RSV-'),
        salesOrderId: salesOrderId,
        salesOrderItemId: line.id,
        itemType: line.itemType,
        itemId: line.itemId,
        itemCode: line.itemCode,
        qtyReserved: qty,
        warehouseId: 'WH-MAIN',
        status: 'Active',
        reservedBy: user.email,
        reservedDate: todayIso_(),
        releasedDate: '',
        releaseReason: ''
      }, 'Reserved against order ' + order.orderNo);

      updateRowById_('SalesOrderItems', 'id', line.id, {
        qtyReserved: (existing[String(line.id)] || 0) + qty
      }, 'Reservation recorded');

      // Keep the running map honest so later lines see the stock this one just took.
      if (isProduct) resProduct[String(line.itemId)] = alreadyReserved + qty;
      else resSpare[String(line.itemId)] = alreadyReserved + qty;

      reservedNow.push({ itemCode: line.itemCode, qty: qty });
    }
    if (qty < want) {
      shortfalls.push({ itemCode: line.itemCode, shortBy: want - qty, available: Math.max(0, available) });
    }
  });

  // The order's own status should tell the truth about whether material is ready.
  if (['Draft', 'Approval Pending', 'Material Pending'].indexOf(order.orderStatus) !== -1 && !order.creditHold) {
    var target = shortfalls.length ? 'Material Pending' : 'Ready for Dispatch';
    if ((ORDER_TRANSITIONS[order.orderStatus] || []).indexOf(target) !== -1) {
      updateRowById_('SalesOrders', 'id', salesOrderId, { orderStatus: target },
        shortfalls.length ? 'Material short after reservation' : 'All lines reserved');
    }
  }

  return { reserved: reservedNow, shortfalls: shortfalls };
}

function listReservations(options) {
  getCurrentUser();
  var opts = options || {};

  var orderNos = {};
  readTable_('SalesOrders').forEach(function (o) { orderNos[String(o.id)] = o.orderNo; });

  return readTable_('StockReservations')
    .filter(function (r) { return opts.includeReleased || String(r.status) === 'Active'; })
    .map(function (r) {
      var row = stripRow_(r);
      row.orderNo = orderNos[String(row.salesOrderId)] || '';
      return row;
    })
    .sort(function (a, b) { return String(b.reservedDate).localeCompare(String(a.reservedDate)); });
}

/** Releases a reservation — on cancellation, or when stock is needed elsewhere (FR-037). */
function releaseReservation(reservationId, reason) {
  var user = getCurrentUser();
  requireRole_(user, STORES_ROLES);
  if (!String(reason || '').trim()) throw new Error('Give a reason for releasing the reservation.');

  var res = readTable_('StockReservations').filter(function (r) {
    return String(r.id) === String(reservationId);
  })[0];
  if (!res) throw new Error('Reservation not found.');
  if (String(res.status) !== 'Active') throw new Error('That reservation is already ' + res.status + '.');

  updateRowById_('StockReservations', 'id', reservationId, {
    status: 'Released', releasedDate: todayIso_(), releaseReason: reason
  }, 'Reservation released: ' + reason);

  var line = readTable_('SalesOrderItems').filter(function (i) {
    return String(i.id) === String(res.salesOrderItemId);
  })[0];
  if (line) {
    updateRowById_('SalesOrderItems', 'id', line.id, {
      qtyReserved: Math.max(0, (Number(line.qtyReserved) || 0) - (Number(res.qtyReserved) || 0))
    }, 'Reservation released');
  }
  return true;
}

// ------------------------------------------------------------------ serial numbers

/** Compressor serials, tracked from inward through dispatch and installation (FR-038). */
function listSerialNumbers(options) {
  getCurrentUser();
  var opts = options || {};
  var productNames = {};
  readTable_('Products').forEach(function (p) { productNames[String(p.id)] = p.model || p.productCode; });

  return readTable_('SerialNumbers')
    .filter(function (s) { return !opts.status || s.status === opts.status; })
    .map(function (s) {
      var row = stripRow_(s);
      row.productName = productNames[String(row.productId)] || '';
      return row;
    })
    .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
}

function saveSerialNumber(input) {
  var user = getCurrentUser();
  requireRole_(user, STORES_ROLES);

  var serialNo = String(input.serialNo || '').trim();
  if (!serialNo) throw new Error('Enter the serial number.');
  if (!input.productId) throw new Error('Pick which product this serial belongs to.');

  var clash = readTable_('SerialNumbers').filter(function (s) {
    return String(s.serialNo).trim().toLowerCase() === serialNo.toLowerCase() &&
      String(s.id) !== String(input.id || '');
  })[0];
  if (clash) throw new Error('Serial ' + serialNo + ' is already recorded. Serials must be unique.');

  var product = readTable_('Products').filter(function (p) {
    return String(p.id) === String(input.productId);
  })[0];

  var status = String(input.status || 'In Stock').trim();
  if (SERIAL_STATUSES.indexOf(status) === -1) {
    throw new Error('Serial status must be one of: ' + SERIAL_STATUSES.join(', ') + '.');
  }

  var record = {
    productId: String(input.productId),
    productCode: product ? product.productCode : '',
    serialNo: serialNo,
    status: status,
    warehouseId: String(input.warehouseId || 'WH-MAIN').trim(),
    grnId: String(input.grnId || '').trim(),
    salesOrderId: String(input.salesOrderId || '').trim(),
    dispatchId: String(input.dispatchId || '').trim(),
    invoiceNo: String(input.invoiceNo || '').trim(),
    installedBaseId: String(input.installedBaseId || '').trim(),
    notes: String(input.notes || '').trim()
  };

  if (input.id) {
    record.id = input.id;
    updateRowById_('SerialNumbers', 'id', input.id, record, 'Serial updated');
  } else {
    record.id = generateId_('SN-');
    record.createdAt = todayIso_();
    appendRow_('SerialNumbers', record, 'Serial recorded');
  }
  return record;
}

// ------------------------------------------------------------------ material inward

function listGRNs(options) {
  getCurrentUser();
  var opts = options || {};

  var itemsByGrn = {};
  readTable_('GRNItems').forEach(function (i) {
    var key = String(i.grnId);
    (itemsByGrn[key] = itemsByGrn[key] || []).push(stripRow_(i));
  });

  return readTable_('GRNs')
    .filter(function (g) { return opts.includeVerified || g.verificationStatus !== 'Verified'; })
    .map(function (g) {
      var row = stripRow_(g);
      row.items = itemsByGrn[String(row.id)] || [];
      row.itemCount = row.items.length;
      return row;
    })
    .sort(function (a, b) { return String(b.grnDate).localeCompare(String(a.grnDate)); });
}

function getGRN(id) {
  getCurrentUser();
  var g = readTable_('GRNs').filter(function (r) { return String(r.id) === String(id); })[0];
  if (!g) throw new Error('GRN not found.');
  var row = stripRow_(g);
  row.items = readTable_('GRNItems')
    .filter(function (i) { return String(i.grnId) === String(id); })
    .sort(function (a, b) { return (Number(a.lineNo) || 0) - (Number(b.lineNo) || 0); })
    .map(stripRow_);
  return row;
}

function saveGRN(input) {
  var user = getCurrentUser();
  requireRole_(user, STORES_ROLES);
  if (!String(input.supplierName || '').trim()) throw new Error('Enter who the material came from.');

  var record = {
    grnDate: String(input.grnDate || todayIso_()).slice(0, 10),
    poRef: String(input.poRef || '').trim(),
    supplierName: String(input.supplierName || '').trim(),
    invoiceRef: String(input.invoiceRef || '').trim(),
    receivedBy: String(input.receivedBy || user.email).trim(),
    checkedBy: String(input.checkedBy || '').trim(),
    notes: String(input.notes || '').trim()
  };

  if (input.id) {
    var existing = readTable_('GRNs').filter(function (g) { return String(g.id) === String(input.id); })[0];
    if (existing && existing.verificationStatus === 'Verified') {
      throw new Error('This GRN is verified and its stock has been posted. It cannot be edited.');
    }
    record.id = input.id;
    updateRowById_('GRNs', 'id', input.id, record, 'GRN updated');
  } else {
    record.id = generateId_('GRN-');
    record.grnNo = nextSeriesNo_('GRNs', 'grnNo', 'GRN');
    record.verificationStatus = 'Pending';
    record.verificationDate = '';
    record.verifiedBy = '';
    record.createdAt = todayIso_();
    record.createdBy = user.email;
    appendRow_('GRNs', record, 'GRN opened');
  }
  return getGRN(record.id);
}

function saveGRNItem(input) {
  var user = getCurrentUser();
  requireRole_(user, STORES_ROLES);
  if (!input.grnId) throw new Error('grnId is required.');

  var grn = readTable_('GRNs').filter(function (g) { return String(g.id) === String(input.grnId); })[0];
  if (!grn) throw new Error('GRN not found.');
  if (grn.verificationStatus === 'Verified') {
    throw new Error('This GRN is verified and its stock has been posted. It cannot be changed.');
  }

  var itemType = String(input.itemType || 'Spare').trim();
  if (['Spare', 'Product'].indexOf(itemType) === -1) throw new Error('itemType must be Spare or Product.');
  if (!input.itemId) throw new Error('Pick the item received.');

  var qtyReceived = Number(input.qtyReceived);
  if (isNaN(qtyReceived) || qtyReceived <= 0) throw new Error('Received quantity must be greater than zero.');
  var qtyAccepted = input.qtyAccepted === '' || input.qtyAccepted === undefined
    ? qtyReceived : Number(input.qtyAccepted);
  if (isNaN(qtyAccepted) || qtyAccepted < 0 || qtyAccepted > qtyReceived) {
    throw new Error('Accepted quantity must be between zero and the quantity received.');
  }

  var master = masterRecordFor_(itemType, input.itemId);
  var existing = readTable_('GRNItems').filter(function (i) {
    return String(i.grnId) === String(input.grnId);
  });

  var record = {
    grnId: String(input.grnId),
    lineNo: input.id ? Number(input.lineNo) : existing.length + 1,
    itemType: itemType,
    itemId: String(input.itemId),
    itemCode: master ? (master.partNo || master.productCode) : '',
    description: master ? (master.description || master.model) : '',
    qtyReceived: qtyReceived,
    qtyAccepted: qtyAccepted,
    qtyRejected: roundMoney_(qtyReceived - qtyAccepted),
    condition: String(input.condition || 'Good').trim(),
    serialNos: String(input.serialNos || '').trim(),
    warehouseId: String(input.warehouseId || 'WH-MAIN').trim(),
    binId: String(input.binId || '').trim(),
    notes: String(input.notes || '').trim()
  };

  if (input.id) {
    record.id = input.id;
    updateRowById_('GRNItems', 'id', input.id, record, 'GRN line updated');
  } else {
    record.id = generateId_('GRNI-');
    appendRow_('GRNItems', record, 'Material line received');
  }
  return getGRN(input.grnId);
}

function deleteGRNItem(id) {
  var user = getCurrentUser();
  requireRole_(user, STORES_ROLES);
  var line = readTable_('GRNItems').filter(function (i) { return String(i.id) === String(id); })[0];
  if (!line) throw new Error('That line no longer exists.');

  var grn = readTable_('GRNs').filter(function (g) { return String(g.id) === String(line.grnId); })[0];
  if (grn && grn.verificationStatus === 'Verified') {
    throw new Error('This GRN is verified. Its lines cannot be removed.');
  }
  deleteRowById_('GRNItems', 'id', id, 'GRN line removed');
  return getGRN(line.grnId);
}

/**
 * Verifies a GRN and only then posts stock (FR-043).
 *
 * This is the control the whole module is built around: receiving material and making it
 * sellable are two decisions, taken by two people. The verifier cannot be the receiver, and
 * only accepted quantities move — rejected material never becomes stock.
 */
function verifyGRN(grnId, notes) {
  var user = getCurrentUser();
  requireRole_(user, STORES_ROLES);

  var grn = readTable_('GRNs').filter(function (g) { return String(g.id) === String(grnId); })[0];
  if (!grn) throw new Error('GRN not found.');
  if (grn.verificationStatus === 'Verified') throw new Error('This GRN is already verified.');

  var lines = readTable_('GRNItems').filter(function (i) { return String(i.grnId) === String(grnId); });
  if (!lines.length) throw new Error('Add what was received before verifying.');

  var accepted = lines.filter(function (l) { return (Number(l.qtyAccepted) || 0) > 0; });
  if (!accepted.length) throw new Error('Nothing on this GRN was accepted, so there is no stock to post.');

  // A second pair of eyes is the point of the check (D016).
  if (String(grn.receivedBy).toLowerCase() === user.email.toLowerCase() && currentUserIsNotAdmin_(user)) {
    throw new Error('The person who received the material should not also verify it. ' +
      'Ask a colleague, or have Management verify it.');
  }

  accepted.forEach(function (line) {
    recordStockMovement({
      itemType: line.itemType,
      itemId: line.itemId,
      itemCode: line.itemCode,
      movementType: 'Inward',
      qty: Number(line.qtyAccepted),
      warehouseId: line.warehouseId,
      binId: line.binId,
      referenceType: 'GRN',
      referenceId: grnId,
      notes: 'GRN ' + grn.grnNo + ' verified'
    });

    // Compressor serials become trackable assets the moment they are accepted (FR-038).
    if (line.itemType === 'Product' && String(line.serialNos || '').trim()) {
      String(line.serialNos).split(/[,\n]/).forEach(function (sn) {
        var serial = sn.trim();
        if (!serial) return;
        var clash = readTable_('SerialNumbers').filter(function (s) {
          return String(s.serialNo).trim().toLowerCase() === serial.toLowerCase();
        })[0];
        if (clash) return;
        appendRow_('SerialNumbers', {
          id: generateId_('SN-'),
          productId: line.itemId,
          productCode: line.itemCode,
          serialNo: serial,
          status: 'In Stock',
          warehouseId: line.warehouseId,
          grnId: grnId,
          salesOrderId: '', dispatchId: '', invoiceNo: '', installedBaseId: '',
          notes: 'Created from GRN ' + grn.grnNo,
          createdAt: todayIso_()
        }, 'Serial received on GRN ' + grn.grnNo);
      });
    }
  });

  updateRowById_('GRNs', 'id', grnId, {
    verificationStatus: 'Verified',
    verifiedBy: user.email,
    verificationDate: todayIso_(),
    notes: String(notes || grn.notes || '').trim()
  }, 'GRN verified — stock posted');

  return getGRN(grnId);
}

/** Management and ERP Admin can verify their own receipt; the segregation is for everyone else. */
function currentUserIsNotAdmin_(user) {
  return [ROLES.MANAGEMENT, ROLES.ERP_ADMIN].indexOf(user.role) === -1;
}

// ------------------------------------------------------------------ warehouses and bins

function listWarehouses() {
  getCurrentUser();
  return readTable_('Warehouses')
    .filter(function (w) { return String(w.active).toUpperCase() !== 'FALSE'; })
    .map(stripRow_);
}

// saveWarehouse() lives in Settings.gs, which owns warehouse maintenance and adds the
// duplicate-code check and the active flag. Apps Script shares one global scope, so a second
// definition here would silently win or lose depending on file order.

/** Items for the inward and adjustment pickers, kept small on purpose. */
function searchStockItems(itemType, query) {
  getCurrentUser();
  var type = itemType === 'Product' ? 'Product' : 'Spare';
  var q = String(query || '').trim().toLowerCase();
  var tab = type === 'Product' ? 'Products' : 'Spares';

  return readTable_(tab)
    .filter(function (r) {
      if (String(r.active).toUpperCase() === 'FALSE') return false;
      if (!q) return true;
      var code = type === 'Product' ? r.productCode : r.partNo;
      var desc = type === 'Product' ? (r.model || r.description) : r.description;
      return String(code).toLowerCase().indexOf(q) !== -1 ||
        String(desc).toLowerCase().indexOf(q) !== -1;
    })
    .slice(0, 40)
    .map(function (r) {
      return {
        id: r.id,
        code: type === 'Product' ? r.productCode : r.partNo,
        description: type === 'Product' ? (r.model || r.description) : r.description,
        uom: r.uom
      };
    });
}
