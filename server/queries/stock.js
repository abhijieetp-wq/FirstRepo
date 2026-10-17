/**
 * The two reads that still went through the whole ledger.
 *
 * On-hand is the sum of every StockMovement ever made and reserved is the sum of the
 * active StockReservations — there is no running balance anywhere, on purpose: a stock
 * figure that cannot be explained by reading the rows that produced it is a stock figure
 * nobody can argue with. That design is right and is not changing. What was wrong is
 * where the summing happened.
 *
 * On a sheet there was no choice: read the tab, add up the column. On a database, summing
 * by a key is the one thing it is best at, and asking for one part's balance by fetching
 * every movement ever recorded is the last read of this shape left in the portal. The
 * speed test has been naming it for days:
 *
 *   "getAvailability reads the whole movements ledger twice, for one part, because
 *    stockOnHandMap_ and stockReservedMap_ still sum every row in JavaScript."
 *
 * Twice, because availability is on-hand minus reserved and each half read its own table
 * whole.
 *
 * BEHAVIOUR IS UNCHANGED, and the parts worth saying out loud:
 *
 *   - a part with no movements is absent from the map, not zero. Callers distinguish the
 *     two: an absent part has never moved, a zero one moved and came back to nothing.
 *   - onlyIds may be an array or an object used as a set, because both are passed.
 *   - a qty that is not a number counted as zero, and still does. The column is numeric
 *     so the database will not hold anything else, but a row written before the type was
 *     tightened would have, and COALESCE keeps the arithmetic the same either way.
 *
 * ONE DIFFERENCE, deliberate. The sheet added quantities as JavaScript doubles, so 0.1 + 0.2
 * litres of oil came to 0.30000000000000004. NUMERIC adds them exactly and says 0.3. Every
 * whole-unit quantity — which is nearly all of PIE's ledger — sums identically either way;
 * where a fraction is involved, the database is the one that is right.
 */
'use strict';

/** The ids a caller wants, as a list, or null for all of them. */
function stockWanted_(onlyIds) {
  if (!onlyIds) return null;
  var list = Object.prototype.toString.call(onlyIds) === '[object Array]'
    ? onlyIds : Object.keys(onlyIds);
  var out = [];
  var seen = Object.create(null);
  for (var i = 0; i < list.length; i++) {
    var id = String(list[i]);
    if (seen[id]) continue;
    seen[id] = true;
    out.push(id);
  }
  return out;
}

/** Shared shape: sum one column by item_id, for one item type, optionally for some ids. */
async function stockSumBy_(table, column, itemType, onlyIds, extraWhere) {
  var wanted = stockWanted_(onlyIds);
  // An explicit empty list means the caller wants nothing, which is not the same as all.
  // ANY('{}') would match nothing and give the same answer; this just skips the trip.
  if (wanted && !wanted.length) return {};

  var params = [db.tenant, String(itemType)];
  var sql = 'SELECT item_id, COALESCE(sum(' + column + '), 0) AS total FROM ' + table +
    ' WHERE tenant_id = $1 AND item_type = $2' + (extraWhere || '');
  if (wanted) {
    params.push(wanted);
    sql += ' AND item_id::text = ANY($' + params.length + ')';
  }
  sql += ' GROUP BY item_id';

  var rows = await db.q(sql, params);
  var map = {};
  for (var i = 0; i < rows.rows.length; i++) {
    var r = rows.rows[i];
    map[String(r.item_id)] = Number(r.total) || 0;
  }
  return map;
}

/** { itemId: qty } on-hand for one item type. */
async function stockOnHandMap_(itemType, onlyIds) {
  return stockSumBy_('stock_movements', 'qty', itemType, onlyIds, '');
}

/** { itemId: qty } currently reserved against open sales orders. */
async function stockReservedMap_(itemType, onlyIds) {
  // 'Active' is the portal's own word for a reservation that still holds; a released or
  // consumed one is a row that stays for the history and must not count.
  return stockSumBy_('stock_reservations', 'qty_reserved', itemType, onlyIds,
    " AND status = 'Active'");
}

/**
 * On-hand / reserved / available for one item — what quotations must show (FR-025).
 *
 * The faithful translation asks both maps for every part of the type and then looks at one
 * of them, which on a sheet cost nothing extra: the tab was read whole either way. Here it
 * would group thirteen thousand parts to answer about one, so the one id is passed down and
 * the database sums a handful of rows instead.
 */
async function getAvailability(itemType, itemId) {
  getCurrentUser();
  var id = String(itemId);
  var onHand = (await stockOnHandMap_(itemType, [id]))[id] || 0;
  var reserved = (await stockReservedMap_(itemType, [id]))[id] || 0;
  return { onHand: onHand, reserved: reserved, available: onHand - reserved };
}
