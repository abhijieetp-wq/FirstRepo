/**
 * The catalogue scans that were block reads.
 *
 * Three questions the portal asks about 13,587 spares, each of which read the whole Spares tab
 * by column position to avoid building an object per part. That was the right call on a sheet —
 * going through readTable_ meant constructing and normalising 13,587 objects to look at one
 * field on each — and it is exactly what a database does for free: `SELECT one column` reads
 * one column.
 */
'use strict';

/**
 * Every product group any spare belongs to, deduplicated and sorted.
 *
 * A part's productGroup holds several groups separated by commas or semicolons, which is why
 * this cannot be a plain DISTINCT: 'Airend, Filters' is two groups, not one. The splitting
 * stays in JavaScript, as it was, over one column of rows rather than the whole tab.
 *
 * Postgres could do the split too — regexp_split_to_table — and doing it here instead keeps
 * one copy of the rule about what separates two group names. The read is the part that was
 * expensive; the splitting never was.
 */
async function readProductGroups_() {
  var rows = await db.q(
    'SELECT DISTINCT product_group FROM spares' +
    ' WHERE tenant_id = $1 AND product_group IS NOT NULL AND product_group <> $2',
    [db.tenant, '']);

  var seen = {};
  for (var i = 0; i < rows.rows.length; i++) {
    var parts = String(rows.rows[i].product_group || '').split(/\s*[;,]\s*/);
    for (var p = 0; p < parts.length; p++) {
      if (parts[p].trim()) seen[parts[p].trim()] = true;
    }
  }
  return Object.keys(seen).sort();
}

/**
 * How many active spares have fallen under their reorder level.
 *
 * One number on the dashboard that used to cost more than everything else on that screen put
 * together: the whole Spares tab and the whole StockMovements ledger, 13,146 rows out of the
 * 13,225 the entire dashboard touched.
 *
 * The sheet version got that down by reading the catalogue block and skipping the ledger
 * entirely when no part had a level set — which is true of PIE's catalogue today, because the
 * ELGi import carries no reorder levels. Both of those stop being tricks here. The ledger sum
 * is a GROUP BY over the movements of the parts that have a level, and when no part has one
 * the join produces nothing and there is nothing to sum.
 *
 * The fifteen-minute cache in belowReorderCount_ sits in front of this and is left alone. It
 * is still the right thing: the count is advisory, and recomputing it once per dashboard per
 * user is work nobody asked for even when the work is cheap.
 */
async function countBelowReorder_() {
  var rows = await db.q(
    'WITH levels AS (' +
    '  SELECT id, reorder_level FROM spares' +
    '   WHERE tenant_id = $1 AND active IS NOT FALSE AND reorder_level > 0' +
    '), on_hand AS (' +
    '  SELECT m.item_id, sum(m.qty) AS qty FROM stock_movements m' +
    '   JOIN levels l ON l.id = m.item_id' +
    '   WHERE m.tenant_id = $1 AND m.item_type = $2' +
    '   GROUP BY m.item_id' +
    ')' +
    // coalesce, because a part with a level and no movements at all has nothing on hand, and
    // zero is under any positive level. The sheet version got this right by defaulting the
    // map lookup to 0; a plain join would silently drop those parts, which are exactly the
    // ones most worth reordering.
    ' SELECT count(*)::int AS n FROM levels l' +
    '  LEFT JOIN on_hand h ON h.item_id = l.id' +
    '  WHERE coalesce(h.qty, 0) < l.reorder_level',
    [db.tenant, 'Spare']);
  return rows.rows[0].n;
}

/**
 * The catalogue as the spare picker sends it, straight out of a SELECT.
 *
 * One block read of 13,587 rows becomes one query of the nine columns the screen shows. The
 * reason the sheet version read the block by column position — not building an object per part
 * when only nine fields of it are wanted — is what `SELECT` these nine columns does anyway.
 *
 * The column ORDER is the contract. The browser receives arrays, not objects, because the
 * field names repeated 13,587 times were most of the payload, and it reads them positionally
 * against SPARE_PICKER_COLS. So the SELECT lists them in that order deliberately rather than
 * incidentally, and sortng by part number is added: the sheet gave them in row order, which is
 * import order, and a database gives no order at all unless asked.
 */
async function sparePickerRows_(prices, onHand, reserved) {
  var result = await db.q(
    'SELECT id, part_no, description, product_group, category, uom, hsn_code' +
    '  FROM spares' +
    ' WHERE tenant_id = $1 AND active IS NOT FALSE AND id IS NOT NULL AND id <> $2' +
    ' ORDER BY part_no',
    [db.tenant, '']);

  var rows = [];
  for (var i = 0; i < result.rows.length; i++) {
    var r = result.rows[i];
    var id = String(r.id);
    var levels = prices[id] || {};
    rows.push([
      id,
      String(r.part_no || ''),
      String(r.description || ''),
      String(r.product_group || ''),
      String(r.category || ''),
      String(r.uom || 'Nos'),
      String(r.hsn_code || ''),
      levels[SELLING_PRICE_LEVEL] ? levels[SELLING_PRICE_LEVEL].price : null,
      (onHand[id] || 0) - (reserved[id] || 0)
    ]);
  }
  return rows;
}

/**
 * Deletes every spare except the referenced ones, and deactivates those.
 *
 * The sheet had to do this as a block rewrite — filter the rows in memory, blank the range,
 * write the survivors back — because deleting 13,587 rows one at a time does not finish inside
 * an execution. That rewrite is the dangerous kind: there is a moment when the catalogue is
 * blank, and a failure in it loses everything.
 *
 * Two statements, in a transaction, and no such moment.
 */
async function keepOnlyReferencedSpares_(referenced) {
  var keep = Object.keys(referenced || {});

  return await withTransaction(async function (tx) {
    // Deactivated rather than deleted: a quotation or an order names these parts, and those
    // are records of what happened. A part nobody can order again is still a part the document
    // has to be able to resolve.
    if (keep.length) {
      await tx.q('UPDATE spares SET active = FALSE WHERE tenant_id = $1 AND id = ANY($2)',
        [tx.tenant, keep]);
    }
    // `<> ALL` rather than `NOT IN`, which answers nothing at all when the list is empty.
    var gone = await tx.q(
      'DELETE FROM spares WHERE tenant_id = $1 AND id <> ALL($2)', [tx.tenant, keep]);
    void gone;
    return keep.length;
  });
}

/** Empties the catalogue. Only reachable once the documents built on it have gone. */
async function clearAllSpares_() {
  await db.q('DELETE FROM spares WHERE tenant_id = $1', [db.tenant]);
}
