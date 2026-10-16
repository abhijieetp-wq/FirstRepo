/**
 * The catalogue import's two writes, as statements.
 *
 * A full ELGi load is 13,587 parts, and the sheet version wrote it by rewriting blocks: read
 * every existing row, edit the ones that changed in memory, write all of them back; then
 * append the new ones. That is why the import had to be driven in chunks from the browser at
 * all, and why a chunk failing with a 503 — which happened repeatedly during PIE's own load —
 * left the operator guessing which rows had landed.
 *
 * ONE COUPLING GOES AWAY HERE, AND IT WAS A REAL HAZARD. The sheet version addressed each
 * changed row as `block[u.rowIndex]`, where rowIndex is a row's position in what
 * `readTable_(tab)` returned. That worked only because a block read and readTable_ walk the
 * sheet in the same order. A database returns rows in no particular order unless asked, so the
 * same code against Postgres would have written one part's description onto another's — the
 * quietest possible corruption, and across thousands of rows at once. This addresses rows by
 * `id`, which analyseImport_ already carries alongside rowIndex. rowIndex is simply unused
 * now; it stays in the analysis object because the preview returns that object and changing
 * its shape is a change to the browser for no gain.
 */
'use strict';

async function writeCatalogRows_(spec, analysis, user) {
  if (!analysis.updates.length && !analysis.creates.length) return;

  var m = mapFor_(spec.tab);

  return await withTransaction(async function (tx) {
    if (analysis.updates.length) await updateCatalogRows_(tx, m, spec, analysis.updates);
    if (analysis.creates.length) await insertCatalogRows_(tx, m, spec, analysis.creates, user);
  });
}

/**
 * Changes the rows whose codes were already in the catalogue.
 *
 * Only the master fields the file actually filled in, which is the same rule as before: a
 * blank cell in the CSV means "ELGi did not say", not "clear what we have". What makes that
 * awkward in SQL is that the set of columns to write differs per row — one line may carry a
 * description and no HSN, the next the reverse.
 *
 * So it is one statement per DISTINCT SET of filled columns, not one per row. That is worth
 * only as much as the number of shapes is small, so it was measured rather than assumed:
 * across the ELGi files PIE actually loaded — 27,363 rows — there are ELEVEN shapes, and one
 * of them covers 86% of the rows. Eleven statements instead of 27,363, against a sheet version
 * that rewrote every row in the tab to change any of them.
 *
 * The bound is 2^11, one per subset of the master fields, and a pathological file with blanks
 * scattered at random would approach it. Even then it is hundreds of statements rather than
 * tens of thousands, and the shape comes from which columns a supplier's export has rather
 * than from the part, which is why the real files cluster so tightly.
 */
async function updateCatalogRows_(tx, m, spec, updates) {
  var groups = {};
  for (var i = 0; i < updates.length; i++) {
    var u = updates[i];
    var fields = [];
    for (var f = 0; f < spec.masterFields.length; f++) {
      var name = spec.masterFields[f];
      if (!m.toDb[name]) continue;
      if (u.values[name] === undefined || u.values[name] === '') continue;
      fields.push(name);
    }
    // The shape of this row's update. Rows sharing a shape share a statement.
    var key = fields.join(',');
    (groups[key] = groups[key] || { fields: fields, rows: [] }).rows.push(u);
  }

  for (var key of Object.keys(groups)) {
    var g = groups[key];
    // $2 is the ids; each field gets an array after it, unnested alongside them so a row's
    // values stay with its id.
    var params = [tx.tenant, g.rows.map(function (u) { return String(u.id); })];
    var cols = ['id'];
    var types = ['text'];
    for (var k = 0; k < g.fields.length; k++) {
      var name = g.fields[k];
      params.push(g.rows.map(function (u) { return u.values[name]; }));
      cols.push(m.toDb[name]);
      // Written as text and cast by the column's own type on assignment, so a NUMERIC column
      // gets a number and a DATE a date without this having to know which is which.
      types.push('text');
    }

    var selectList = cols.map(function (c, idx) {
      return '$' + (idx + 2) + '::' + types[idx] + '[]';
    }).join(', ');
    var asList = cols.map(function (c) { return 'v_' + c; }).join(', ');
    var sets = g.fields.map(function (name) {
      var c = m.toDb[name];
      return c + ' = w.v_' + c + '::' + columnType_(m, name);
    });
    // A code in the imported catalogue is a live item. Without this, a row deactivated by the
    // pre-import clear-out was updated with the real description and price and then stayed
    // invisible, so the part looked missing from a catalogue that had just loaded it.
    if (m.toDb.active) sets.push('active = TRUE');

    await tx.q(
      'UPDATE ' + m.table + ' t SET ' + sets.join(', ') +
      '  FROM (SELECT * FROM unnest(' + selectList + ') AS u(' + asList + ')) w' +
      ' WHERE t.tenant_id = $1 AND t.id = w.v_id',
      params);
  }
}

/** The declared type of one portal field, for the cast above. */
function columnType_(m, field) {
  var t = m.kind[field] || 'TEXT';
  // NUMERIC(14,2) and friends cast by their own name; BOOLEAN and DATE likewise. TEXT needs
  // no cast at all but naming it keeps the statement uniform.
  return t;
}

/**
 * Adds the codes that were not there.
 *
 * The defaults are the same six the sheet version filled in, and `brand` is still asked once
 * rather than once per part — it cannot change during a write, and on the sheet asking it
 * 13,587 times was a measurable part of the load.
 */
async function insertCatalogRows_(tx, m, spec, creates, user) {
  var brand = await defaultBrand_();
  var today = todayIso_();

  // Every column the spec declares, so one statement covers every new row whatever each one
  // filled in — a blank is a blank in the sheet version too, not an absent column.
  var cols = m.columns.filter(function (c) { return !!m.toDb[c]; });
  var values = cols.map(function (c) {
    return creates.map(function (item) {
      if (c === 'id') return item.id;
      if (c === 'brand') return brand;
      if (c === 'active') return 'TRUE';
      if (c === 'createdAt') return today;
      if (c === 'createdBy') return user.email;
      if (c === 'defaultWarehouseId') return 'WH-MAIN';
      return item.values[c] === undefined ? '' : item.values[c];
    });
  });

  var params = [tx.tenant].concat(values);
  var unnested = cols.map(function (c, i) { return '$' + (i + 2) + '::text[]'; }).join(', ');
  var asList = cols.map(function (c) { return 'v_' + m.toDb[c]; }).join(', ');
  var selected = cols.map(function (c) {
    // '' is a blank cell, and a blank cell in a NUMERIC or DATE or BOOLEAN column is NULL
    // rather than a cast failure. db.js's coerce does exactly this on the row-at-a-time path;
    // this is the same rule written once in SQL for the bulk path.
    var t = columnType_(m, c);
    if (t === 'TEXT') return 'w.v_' + m.toDb[c];
    return 'nullif(w.v_' + m.toDb[c] + ', \'\')::' + t;
  }).join(', ');

  await tx.q(
    'INSERT INTO ' + m.table + ' (tenant_id, ' + cols.map(function (c) { return m.toDb[c]; })
      .join(', ') + ')' +
    ' SELECT $1, ' + selected +
    '   FROM (SELECT * FROM unnest(' + unnested + ') AS u(' + asList + ')) w',
    params);
}
