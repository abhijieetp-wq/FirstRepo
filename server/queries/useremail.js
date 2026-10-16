/**
 * Renaming a user, as two statements instead of thirty-four column rewrites.
 *
 * Changing somebody's address has to reach every row that records who did a thing — 34 tables,
 * one column at a time. On the sheet each of those was: read the whole column, change the
 * cells that match in memory, write the whole column back. Two round trips per column, 68 in
 * total, and the read-modify-write had already corrupted the sheet once: an earlier version
 * used rowRuns_ to write only the matching rows, and that helper collapses near neighbours
 * into one span, so renaming one coordinator whose quotations sat either side of a colleague's
 * rewrote the colleague's too. The sheet then said the wrong person prepared a quotation, with
 * no trace of the change.
 *
 * An UPDATE cannot do that. It touches the rows that match and no others, and there is no
 * window in which the column is partly written.
 */
'use strict';

/**
 * Which rows in one column hold this address.
 *
 * Was a list of sheet row numbers, and the one caller only ever took `.length` of it. There
 * are no row numbers here, so it returns ids: `.length` behaves identically, and anything that
 * later wants to know WHICH rows gets a real answer instead of a position in a grid that has
 * been resorted since.
 *
 * A tab the schema declares but the database has not got is not an error, same as before: a
 * sheet set up before a feature shipped simply had nothing in it to rename. That was a missing
 * tab then; here it would be a missing table, which means the schema moved on without a
 * migration, and the rename should still report on the 33 tables that do exist.
 */
async function userEmailMatches_(tab, column, address) {
  var m = null;
  try { m = mapFor_(tab); } catch (err) { return []; }
  if (!m || !m.toDb[column]) return [];

  try {
    var rows = await db.q(
      'SELECT id FROM ' + m.table +
      ' WHERE tenant_id = $1 AND lower(btrim(' + m.toDb[column] + '::text)) = $2',
      [db.tenant, String(address || '').trim().toLowerCase()]);
    return rows.rows.map(function (r) { return r.id; });
  } catch (err) {
    // 42P01 is "relation does not exist", which is the missing-tab case above. Anything else
    // is a real failure and must not be swallowed — the old `catch { return [] }` would have
    // reported "nothing to rename" for a permissions error or a dropped column, and the
    // rename would then have claimed success having changed nothing.
    if (err && err.code === '42P01') return [];
    throw err;
  }
}

/**
 * Writes the new address into the rows that hold the old one, and into no others.
 *
 * The audit trail is deliberately one line for the column rather than one per row. A rename
 * can touch thousands of rows across 34 tables, and a row-by-row trail would bury every other
 * entry in the log — which is the same decision savePricesBulk_ makes and for the same reason.
 * The old value is recoverable from that one line: it names the column, the old address and
 * the new one.
 */
async function rewriteUserEmailColumn_(tab, column, oldEmail, newEmail) {
  var m = null;
  try { m = mapFor_(tab); } catch (err) { return 0; }
  if (!m || !m.toDb[column]) return 0;

  var col = m.toDb[column];
  var changed;
  try {
    changed = await db.q(
      'UPDATE ' + m.table + ' SET ' + col + ' = $3' +
      ' WHERE tenant_id = $1 AND lower(btrim(' + col + '::text)) = $2',
      [db.tenant, String(oldEmail || '').trim().toLowerCase(), newEmail]);
  } catch (err) {
    if (err && err.code === '42P01') return 0;
    throw err;
  }
  if (!changed.rowCount) return 0;

  await audit_('Update', tab, '(bulk)', column, oldEmail, newEmail,
    changed.rowCount + ' row(s) renamed');
  return changed.rowCount;
}
