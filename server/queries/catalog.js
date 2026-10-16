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
