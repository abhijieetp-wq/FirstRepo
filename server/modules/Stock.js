/**
 * Converted from src/Stock.gs by migration/to-async.js.
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

/**
 * Turns a list or set of ids into a lookup, or null when the caller wants everything.
 *
 * The ledger has to be read whole either way — on-hand is the sum of every movement ever
 * made and there is no running balance to consult. What this avoids is accumulating a total
 * for all thirteen thousand parts when the caller is going to look at fifty of them.
 */
function stockIdFilter_(onlyIds) {
  if (!onlyIds) return null;
  var wanted = {};
  if (Object.prototype.toString.call(onlyIds) === '[object Array]') {
    onlyIds.forEach(function (id) { wanted[String(id)] = true; });
  } else {
    Object.keys(onlyIds).forEach(function (id) { wanted[String(id)] = true; });
  }
  return wanted;
}

/** { itemId: qty } on-hand for one item type, from a single read of the ledger. */
async function stockOnHandMap_(itemType, onlyIds) {
  var map = {};
  var wanted = stockIdFilter_(onlyIds);
  (await readTable_('StockMovements')).forEach(function (m) {
    if (m.itemType !== itemType) return;
    var id = String(m.itemId);
    if (wanted && !wanted.hasOwnProperty(id)) return;
    map[id] = (map[id] || 0) + (Number(m.qty) || 0);
  });
  return map;
}

/** { itemId: qty } currently reserved against open sales orders. */
async function stockReservedMap_(itemType, onlyIds) {
  var map = {};
  var wanted = stockIdFilter_(onlyIds);
  (await readTable_('StockReservations')).forEach(function (r) {
    if (r.itemType !== itemType) return;
    if (String(r.status) !== 'Active') return;
    var id = String(r.itemId);
    if (wanted && !wanted.hasOwnProperty(id)) return;
    map[id] = (map[id] || 0) + (Number(r.qtyReserved) || 0);
  });
  return map;
}

/**
 * How many active spares have fallen under their reorder level.
 *
 * This is one number on the dashboard, and it used to cost more than everything else on that
 * screen put together. The dashboard read the whole Spares tab and the whole StockMovements
 * ledger to compute it — 13,146 rows out of the 13,225 the entire dashboard touched. The
 * other fourteen tabs, every order, invoice, quotation and customer PIE has, came to 79.
 *
 * Three things make it cheap now.
 *
 * It reads the block and indexes by column position rather than going through readTable_,
 * which would build and normalise an object for all 13,146 rows to look at one field on
 * each. Same single round trip, a fraction of the work — the same bargain priceMapFor_
 * already makes for its own reasons.
 *
 * It only touches the ledger if some part actually has a reorder level set. Today none do:
 * the imported ELGi catalogue carries no reorder levels, so the honest answer is zero and
 * the entire StockMovements read is skipped to produce it. When PIE starts setting levels on
 * the fast movers it will be a handful of parts, not thirteen thousand, and only those ids
 * are summed.
 *
 * And the answer is cached in the *script* cache, so it is computed at most once every
 * fifteen minutes for the whole company rather than once per user per dashboard build. The
 * dashboard's own two-minute per-user cache sits on top of this one.
 *
 * Fifteen minutes of staleness is the right trade for an advisory count. Nobody reorders
 * differently because a tile was a quarter of an hour behind, and the alternative was every
 * person opening the portal paying for a full catalogue scan.
 */
var BELOW_REORDER_KEY_ = 'stock:belowReorder:Spare';
var BELOW_REORDER_SECONDS_ = 900;

async function belowReorderCount_() {
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (err) { cache = null; }

  if (cache) {
    var hit = cache.get(BELOW_REORDER_KEY_);
    // Zero is a real answer and '0' is falsy as a string in no useful sense here, so test
    // for absence rather than truthiness — the common case is exactly zero.
    if (hit !== null && hit !== undefined && hit !== '') {
      var cached = Number(hit);
      if (!isNaN(cached)) return cached;
    }
  }

  var count = await countBelowReorder_();
  if (cache) {
    try { cache.put(BELOW_REORDER_KEY_, String(count), BELOW_REORDER_SECONDS_); } catch (e) {
      /* over quota or unavailable — the number is still correct, just recomputed next time */
    }
  }
  return count;
}

/** The actual scan, without the cache in front of it. Exposed for tests and for a refresh. */
async function countBelowReorder_() {
  var sheet = getSheet_('Spares');
  if (!sheet) return 0;
  var headers = getHeaders_(sheet, 'Spares');
  var lastRow = sheetRows_('Spares', sheet);
  if (lastRow < 2 || !headers.length) return 0;

  var ci = {};
  headers.forEach(function (h, i) { ci[h] = i; });
  if (ci.reorderLevel === undefined || ci.id === undefined) return 0;

  var block = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();

  // Only the parts that carry a level can possibly be under it. On the current catalogue
  // this leaves the list empty, which is why the ledger below is never read.
  var wanted = {};
  var any = false;
  for (var r = 0; r < block.length; r++) {
    var row = block[r];
    var level = Number(row[ci.reorderLevel]);
    if (!(level > 0)) continue;
    if (ci.active !== undefined && String(row[ci.active]).toUpperCase() === 'FALSE') continue;
    wanted[String(row[ci.id])] = level;
    any = true;
  }
  if (!any) return 0;

  var onHand = {};
  (await readTable_('StockMovements')).forEach(function (m) {
    if (m.itemType !== 'Spare') return;
    var id = String(m.itemId);
    if (!wanted.hasOwnProperty(id)) return;
    onHand[id] = (onHand[id] || 0) + (Number(m.qty) || 0);
  });

  var count = 0;
  Object.keys(wanted).forEach(function (id) {
    if ((onHand[id] || 0) < wanted[id]) count++;
  });
  return count;
}

/** On-hand / reserved / available for one item — what quotations must show (FR-025). */
async function getAvailability(itemType, itemId) {
  getCurrentUser();
  var onHand = (await stockOnHandMap_(itemType))[String(itemId)] || 0;
  var reserved = (await stockReservedMap_(itemType))[String(itemId)] || 0;
  return { onHand: onHand, reserved: reserved, available: onHand - reserved };
}

/**
 * Appends a stock movement. Adjustments need a reason — that is the audit requirement
 * behind approval A08, and the reason is written to both the ledger row and the AuditLog.
 */
async function recordStockMovement(input) {
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
  await appendRow_('StockMovements', record, movementType + ': ' + record.notes);
  return record;
}

/** The movement history behind an item's current number. */
async function getStockLedger(itemType, itemId) {
  getCurrentUser();
  return (await readTable_('StockMovements'))
    .filter(function (m) { return m.itemType === itemType && String(m.itemId) === String(itemId); })
    .sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); })
    .map(stripRow_);
}
