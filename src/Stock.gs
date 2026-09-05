/**
 * Stock as an append-only ledger (FR-036, FR-037).
 *
 * There is no "current stock" cell anywhere. On-hand is the sum of StockMovements; reserved
 * is the sum of active StockReservations; available = on-hand − reserved. Corrections are
 * new movements, so history is never rewritten and a wrong number can always be explained by
 * reading the rows that produced it.
 *
 * Movement types (qty is signed — positive adds, negative removes):
 *   Opening    — opening balance when a part is first set up
 *   Inward     — goods received (GRN)
 *   Dispatch   — goods shipped
 *   Adjustment — physical count correction; requires a reason (A08)
 *   Return     — customer//supplier return
 */

var MOVEMENT_TYPES = ['Opening', 'Inward', 'Dispatch', 'Adjustment', 'Return'];

/** { itemId: qty } on-hand for one item type, from a single read of the ledger. */
function stockOnHandMap_(itemType) {
  var map = {};
  readTable_('StockMovements').forEach(function (m) {
    if (m.itemType !== itemType) return;
    var id = String(m.itemId);
    map[id] = (map[id] || 0) + (Number(m.qty) || 0);
  });
  return map;
}

/** { itemId: qty } currently reserved against open sales orders. */
function stockReservedMap_(itemType) {
  var map = {};
  readTable_('StockReservations').forEach(function (r) {
    if (r.itemType !== itemType) return;
    if (String(r.status) !== 'Active') return;
    var id = String(r.itemId);
    map[id] = (map[id] || 0) + (Number(r.qtyReserved) || 0);
  });
  return map;
}

/** On-hand / reserved / available for one item — what quotations must show (FR-025). */
function getAvailability(itemType, itemId) {
  getCurrentUser();
  var onHand = stockOnHandMap_(itemType)[String(itemId)] || 0;
  var reserved = stockReservedMap_(itemType)[String(itemId)] || 0;
  return { onHand: onHand, reserved: reserved, available: onHand - reserved };
}

/**
 * Appends a stock movement. Adjustments need a reason — that is the audit requirement
 * behind approval A08, and the reason is written to both the ledger row and the AuditLog.
 */
function recordStockMovement(input) {
  var user = getCurrentUser();
  requireRole_(user, [ROLES.SALES_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN]);

  var itemType = String(input.itemType || '').trim();
  var itemId = String(input.itemId || '').trim();
  var movementType = String(input.movementType || '').trim();
  var qty = Number(input.qty);

  if (['Product', 'Spare'].indexOf(itemType) === -1) throw new Error('itemType must be Product or Spare.');
  if (!itemId) throw new Error('itemId is required.');
  if (MOVEMENT_TYPES.indexOf(movementType) === -1) {
    throw new Error('movementType must be one of: ' + MOVEMENT_TYPES.join(', ') + '.');
  }
  if (isNaN(qty) || qty === 0) throw new Error('Quantity must be a non-zero number.');
  if (movementType === 'Adjustment' && !String(input.notes || '').trim()) {
    throw new Error('A stock adjustment needs a reason.');
  }

  var record = {
    id: generateId_('MOV-'),
    timestamp: Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd HH:mm:ss'),
    movementDate: String(input.movementDate || todayIso_()).slice(0, 10),
    itemType: itemType,
    itemId: itemId,
    itemCode: String(input.itemCode || '').trim(),
    movementType: movementType,
    qty: qty,
    warehouseId: String(input.warehouseId || 'WH-MAIN').trim(),
    binId: String(input.binId || '').trim(),
    serialNo: String(input.serialNo || '').trim(),
    referenceType: String(input.referenceType || '').trim(),
    referenceId: String(input.referenceId || '').trim(),
    enteredBy: user.email,
    notes: String(input.notes || '').trim()
  };
  appendRow_('StockMovements', record, movementType + ': ' + record.notes);
  return record;
}

/** The movement history behind an item's current number. */
function getStockLedger(itemType, itemId) {
  getCurrentUser();
  return readTable_('StockMovements')
    .filter(function (m) { return m.itemType === itemType && String(m.itemId) === String(itemId); })
    .sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); })
    .map(stripRow_);
}
