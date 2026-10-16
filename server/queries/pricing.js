/**
 * The price list, as queries rather than as a block of cells.
 *
 * These three functions replace the ones in modules/Pricing.js. They are loaded after it, so
 * these definitions win; the faithful translations stay in that file as the specification
 * these have to reproduce, which is the point of keeping both.
 *
 * WHY THESE THREE FIRST. PriceList is the largest table PIE has — two rows for each of 13,587
 * parts — and all three of these read the whole thing. `priceMapFor_` built an object for every
 * part in the catalogue to answer a question about fifty of them; `getEffectivePrices_` read
 * one column of 27,000 cells to find the two rows that mattered; `savePricesBulk_` rewrote
 * every row in the table to close a handful. On a spreadsheet those were the fastest shapes
 * available, because a round trip cost more than any amount of arithmetic and there was no way
 * to ask for "the rows where itemId is one of these fifty". On Postgres that question is an
 * index lookup, so the clever shapes become plain ones and get faster at the same time.
 *
 * THE EFFECTIVE-DATING RULE IS THE WHOLE OF THE DIFFICULTY, and it is unchanged: a price row
 * is in force on a date when it is not marked inactive, its effectiveFrom is blank or on or
 * before that date, and its effectiveTo is blank or on or after it. Blank means open-ended at
 * both ends. Where two rows somehow overlap, the later effectiveFrom wins.
 *
 * ONE DELIBERATE CHANGE, in the tie-break. On the sheet, two rows with the SAME effectiveFrom
 * were settled by which sat lower in the grid, because the comparison was a strict `<` and the
 * loop ran top to bottom. Rows are appended, so lower meant written later — and that is what
 * these order by, `created_at` descending. It is the same rule stated precisely rather than as
 * a side effect of row position, and unlike row position it survives a bulk load rewriting the
 * block. `id` breaks a remaining tie so the answer is at least stable between two runs, which
 * the sheet's never was.
 */
'use strict';

/**
 * Rows in force on a date, newest-winning, for one item type.
 *
 * Shared by both readers because they differ only in what they filter and how they shape the
 * answer. The ordering does the conflict resolution: oldest first, so a later row simply
 * overwrites an earlier one as the map is built, which is exactly what the sheet's `<`
 * comparison worked out the long way round.
 */
async function effectivePriceRows_(itemType, when, opts) {
  var o = opts || {};
  var params = [db.tenant, itemType, when];
  var sql =
    'SELECT item_id, price_level, price, min_price, max_discount_pct,' +
    '       effective_from, id' +
    '  FROM price_list' +
    ' WHERE tenant_id = $1' +
    '   AND item_type = $2' +
    // Blank active was never FALSE, so it counts as in force. `IS NOT FALSE` covers both the
    // true rows and the ones where nobody said.
    '   AND active IS NOT FALSE' +
    '   AND (effective_from IS NULL OR effective_from <= $3)' +
    '   AND (effective_to   IS NULL OR effective_to   >= $3)';

  if (o.priceLevel) {
    params.push(o.priceLevel);
    sql += ' AND price_level = $' + params.length;
  }
  if (o.itemIds) {
    params.push(o.itemIds);
    sql += ' AND item_id = ANY($' + params.length + ')';
  }
  sql += ' ORDER BY effective_from ASC NULLS FIRST, created_at ASC NULLS FIRST, id ASC';

  var result = await db.q(sql, params);
  return result.rows;
}

/** The shape every caller wants out of a price row. Nulls where the sheet had blanks. */
function priceEntry_(row) {
  return {
    price: Number(row.price) || 0,
    minPrice: row.min_price === null || row.min_price === undefined ? null : Number(row.min_price),
    maxDiscountPct: row.max_discount_pct === null || row.max_discount_pct === undefined
      ? null : Number(row.max_discount_pct),
    effectiveFrom: String(row.effective_from || '').slice(0, 10),
    priceId: row.id
  };
}

/**
 * { itemId: { PIE: {...}, ELGI: {...} } } for one item type.
 *
 * Was: read every column of every price row, reject most of them on an itemType comparison,
 * build an object for each survivor. The narrowing the comment there describes — rejecting a
 * row of the wrong type on one comparison — is what an index does without reading the row at
 * all.
 */
async function priceMapFor_(itemType, asOf, onlyIds) {
  var when = asOf || todayIso_();
  var ids = null;
  if (onlyIds) {
    // Either a list or a set already keyed by id, because both callers exist.
    ids = Object.prototype.toString.call(onlyIds) === '[object Array]'
      ? onlyIds.map(function (id) { return String(id); })
      : Object.keys(onlyIds);
    // An explicit empty selection means nothing was asked for, not everything.
    if (!ids.length) return {};
  }

  var rows = await effectivePriceRows_(itemType, when, { itemIds: ids });
  var map = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var key = String(r.item_id);
    if (!map[key]) map[key] = {};
    // Ascending order means this row is at least as recent as whatever is already here, so
    // overwriting is the newest-wins rule.
    map[key][r.price_level] = priceEntry_(r);
  }
  return map;
}

/**
 * The price in force for each of several items at one level.
 *
 * Was: read the itemId column whole, find the handful of row numbers that matched, then fetch
 * those rows in runs because a part's two prices sit a catalogue apart after a bulk import.
 * All of that was working around the absence of `WHERE item_id = ANY(...)`.
 */
async function getEffectivePrices_(itemType, itemIds, priceLevel, asOf) {
  var want = [];
  (itemIds || []).forEach(function (v) { want.push(String(v)); });
  if (!want.length) return {};

  var rows = await effectivePriceRows_(itemType, asOf || todayIso_(),
    { priceLevel: priceLevel, itemIds: want });

  var out = {};
  for (var i = 0; i < rows.length; i++) {
    out[String(rows[i].item_id)] = priceEntry_(rows[i]);
  }
  return out;
}

/**
 * Sets many prices at once: supersede what is in force, append what is new, skip what already
 * matches.
 *
 * This is the one that changes shape most, and it is the one that was hurting most. A full
 * catalogue load is 27,000 entries; the sheet version read the entire price list, edited the
 * block in memory and wrote all 27,000 rows back to close a few hundred. Here the closing is
 * one UPDATE against the rows that need closing and the appending is one INSERT, both inside a
 * transaction, so a failure half way leaves the price list as it was rather than half closed.
 *
 * The three-way decision — unchanged, supersede, or new — is made in SQL against the entries
 * passed in, unnested into a table to join on. Doing it in JavaScript would mean fetching the
 * open rows for 27,000 keys first, which is the read this is trying not to do.
 */
async function savePricesBulk_(entries, reason) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  if (!entries || !entries.length) return 0;

  var today = todayIso_();
  var wanted = entries.map(function (e) {
    var price = Number(e.price);
    if (isNaN(price) || price < 0) throw new Error('A valid price is required for ' + e.itemCode + '.');
    if (PRICE_LEVELS.indexOf(e.priceLevel) === -1) {
      throw new Error('Unknown price level "' + e.priceLevel + '".');
    }
    return {
      itemType: e.itemType, itemId: String(e.itemId), itemCode: String(e.itemCode || ''),
      priceLevel: e.priceLevel, price: price,
      effectiveFrom: String(e.effectiveFrom || today).slice(0, 10)
    };
  });

  // The same item and level twice in one call is a contradiction the sheet version resolved by
  // accident — it processed both and the second closed the first. Resolving it deliberately:
  // the last one given wins, which is what a reader of the input would assume.
  var byKey = {};
  wanted.forEach(function (w) { byKey[w.itemType + '|' + w.itemId + '|' + w.priceLevel] = w; });
  var unique = Object.keys(byKey).map(function (k) { return byKey[k]; });

  var itemTypes = unique.map(function (w) { return w.itemType; });
  var itemIds = unique.map(function (w) { return w.itemId; });
  var levels = unique.map(function (w) { return w.priceLevel; });
  var prices = unique.map(function (w) { return w.price; });
  var froms = unique.map(function (w) { return w.effectiveFrom; });
  var codes = unique.map(function (w) { return w.itemCode; });

  return await withTransaction(async function (tx) {
    // The entries, as a table to join against. Everything below is one statement over all of
    // them rather than one statement each.
    var asked =
      'SELECT * FROM unnest($2::text[], $3::text[], $4::text[], $5::numeric[], $6::date[],' +
      '                     $7::text[])' +
      '         AS w(item_type, item_id, price_level, price, effective_from, item_code)';

    // In force on the date this price starts, by the same rule the readers use.
    var standing =
      'SELECT p.id, p.price, w.item_type, w.item_id, w.price_level, w.effective_from, w.price AS asked' +
      '  FROM price_list p' +
      '  JOIN asked w ON p.item_type = w.item_type AND p.item_id = w.item_id' +
      '              AND p.price_level = w.price_level' +
      ' WHERE p.tenant_id = $1' +
      '   AND p.active IS NOT FALSE' +
      '   AND (p.effective_from IS NULL OR p.effective_from <= w.effective_from)' +
      '   AND (p.effective_to   IS NULL OR p.effective_to   >= w.effective_from)';

    // A price already in force at the same number needs nothing done: no row closed, no row
    // appended. The sheet version made this decision too, and had to read the whole list a
    // second time to do it.
    var closing = await tx.q(
      'WITH asked AS (' + asked + '), standing AS (' + standing + '),' +
      '     unchanged AS (SELECT item_type, item_id, price_level FROM standing' +
      '                    WHERE price = asked)' +
      ' UPDATE price_list p' +
      '    SET effective_to = s.effective_from - 1' +
      '   FROM standing s' +
      '  WHERE p.tenant_id = $1 AND p.id = s.id' +
      '    AND s.price <> s.asked' +
      '    AND NOT EXISTS (SELECT 1 FROM unchanged u' +
      '                     WHERE u.item_type = s.item_type AND u.item_id = s.item_id' +
      '                       AND u.price_level = s.price_level)' +
      ' RETURNING p.id',
      [tx.tenant, itemTypes, itemIds, levels, prices, froms, codes]);
    var superseded = closing.rowCount;

    // What is left to write: everything asked for except the entries that were already in
    // force at that price.
    var ids = unique.map(function () { return generateId_('PRC-'); });
    var appended = await tx.q(
      'WITH asked AS (' +
      '  SELECT * FROM unnest($2::text[], $3::text[], $4::text[], $5::numeric[], $6::date[],' +
      '                       $7::text[], $8::text[])' +
      '           AS w(item_type, item_id, price_level, price, effective_from, item_code, id)' +
      ')' +
      ' INSERT INTO price_list (tenant_id, id, item_type, item_id, item_code, price_level,' +
      '                         price, currency, effective_from, effective_to, approved_by,' +
      '                         active, created_at, created_by)' +
      ' SELECT $1, w.id, w.item_type, w.item_id, w.item_code, w.price_level, w.price, $9,' +
      '        w.effective_from, NULL, $10, TRUE, now(), $10' +
      '   FROM asked w' +
      '  WHERE NOT EXISTS (' +
      '     SELECT 1 FROM price_list p' +
      '      WHERE p.tenant_id = $1 AND p.item_type = w.item_type AND p.item_id = w.item_id' +
      '        AND p.price_level = w.price_level AND p.price = w.price' +
      '        AND p.active IS NOT FALSE' +
      '        AND (p.effective_from IS NULL OR p.effective_from <= w.effective_from)' +
      '        AND (p.effective_to   IS NULL OR p.effective_to   >= w.effective_from))' +
      ' RETURNING id',
      [tx.tenant, itemTypes, itemIds, levels, prices, froms, codes, ids, 'INR', user.email]);

    if (!appended.rowCount) return 0;

    // One audit line for the batch: 27,000 would bury everything else in the log.
    await tx.audit('Update', 'PriceList', '(bulk)', '', '',
      appended.rowCount + ' price(s), ' + superseded + ' superseded', reason || 'Bulk price load');
    return appended.rowCount;
  });
}
