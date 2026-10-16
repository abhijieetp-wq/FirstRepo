/**
 * The twelve old names, pointing at the new database.
 *
 * Every converted module still calls `readTable_('Spares')` and `audit_(...)`, exactly as it
 * did on Apps Script. Nothing was renamed, and that was the single most useful decision in
 * this migration: it kept the diff to `async` and `await`, which a person can read line by
 * line, instead of tangling 967 renames into the same change. The names are satisfied here.
 *
 * Why the modules keep sharing one scope rather than becoming proper CommonJS files: on Apps
 * Script every .gs sees every other, and the code is written that way throughout — SCHEMA,
 * ROLES, the helpers, all just there. Rewriting 43 files to import each other is weeks of
 * churn that changes no behaviour and risks a great deal. So they are loaded into one `vm`
 * context with these functions injected, which is how the test harness has always run them.
 *
 * It can be dissolved later, file by file, once everything works. It is not load-bearing
 * cleverness — it is a dozen lines standing where a dozen lines used to be.
 */
'use strict';

const { generateId, mapFor } = require('./db.js');
const helpers = require('./helpers.js');

/**
 * Builds the globals a converted module expects, bound to one database and one user.
 *
 * `actor` matters: the audit trail records who did a thing, and on Apps Script that came
 * from the session the request arrived with. Here it is passed in per request, for the same
 * reason — the process runs as nobody in particular.
 */
function globalsFor(db, actor) {
  const bound = Object.create(db);
  bound.actor = actor || 'system';

  /**
   * The connection everything below runs on, which is the pool until a transaction opens.
   *
   * This was `bound` everywhere, and it meant `withTransaction` did nothing. db.js hands its
   * callback a copy of itself bound to the one connection holding the transaction, and the
   * shim threw that copy away and kept calling `bound` — so a BEGIN was issued on one
   * connection while every statement inside ran on another from the pool. Reads could not see
   * the transaction's own writes, a nested withTransaction opened a second independent
   * transaction and committed it, and a rollback rolled back nothing but the BEGIN.
   *
   * Found by a test that opened a transaction, wrote prices, threw, and then found the prices
   * still there. The shape of the bug is why it is worth naming: everything reported success.
   *
   * One of these per request, because globalsFor is per request. Two requests never share it,
   * which is what makes a single mutable reference safe here — within a request the awaits
   * make execution sequential.
   */
  let current = bound;
  const on = () => current;

  return {
    // ---- the twelve, all async now
    readTable_: (tab) => on().readTable(tab),
    findRowById_: (tab, id) => on().findRowById(tab, id),
    findRowsByColumn_: (tab, col, values) => on().findRowsByColumn(tab, col, values),
    findRowsByIds_: (tab, ids) => on().findRowsByIds(tab, ids),
    columnMap_: (tab, k, v) => on().columnMap(tab, k, v),
    appendRow_: (tab, obj, reason) => on().appendRow(tab, obj, reason),
    appendRows_: (tab, objs, reason) => on().appendRows(tab, objs, reason),
    updateRowById_: (tab, f, v, patch, reason) => on().updateRowById(tab, f, v, patch, reason),
    deleteRowById_: (tab, f, v, reason) => on().deleteRowById(tab, f, v, reason),
    deleteRowsWhere_: (tab, matches, reason) => on().deleteRowsWhere(tab, matches, reason),
    audit_: (action, table, id, field, oldV, newV, reason) =>
      on().audit(action, table, id, field, oldV, newV, reason),
    auditMany_: async (entries) => {
      for (const e of (entries || [])) {
        await on().audit(e.action, e.tableName, e.recordId, e.fieldName,
          e.oldValue, e.newValue, e.reason);
      }
    },

    // ---- the ones that no longer do anything
    //
    // A database has no header row to cache, no height to measure and no request-scoped
    // block to keep in step. These are no-ops rather than deletions so that the converted
    // modules keep loading while the calls are removed file by file; every one that remains
    // is dead weight, and `node migration/dead-shims.js` will eventually count them down to
    // zero. Leaving them as no-ops is honest. Leaving them doing something would not be.
    invalidateTable_: () => {},
    invalidateHeaders_: () => {},

    /**
     * Adding a column to a tab, which the database does not need adding to.
     *
     * applyBuildUpdates_ runs this on the first load after a deployment, because on a
     * spreadsheet a build that writes a new field has nowhere to put it until somebody adds
     * the column. Here the columns come from the generated DDL and are there before the
     * first row is. Left as a no-op rather than removed from the caller: that caller also
     * installs standard quotation text and backfills usernames, and both of those still
     * matter.
     *
     * Without this it reached SpreadsheetApp, was refused, and logged "a module reaching for
     * one has not been migrated" on every restart — which is not true of this one. A warning
     * that is wrong is worse than no warning, because the next real one looks like it.
     */
    addMissingColumnsEverywhere_: () => 0,
    noteRowCount_: () => {},
    rememberSheet_: (name, sheet) => sheet,
    cacheRowWritten_: () => {},
    cacheRowAppended_: () => {},
    cacheRowRemoved_: () => {},

    /**
     * Locking is now a transaction, which is a stronger promise than the sheet could make.
     *
     * LockService serialised writers and nothing more: a dispatch that decremented stock,
     * updated the order and then failed left the first two done with no way back. Here the
     * work either all happens or none of it does. The old shape is kept so callers need not
     * change, and releaseLock is a no-op because the transaction ends with the request.
     */
    acquireLock_: () => ({ releaseLock: () => {} }),

    /**
     * Opens a transaction and points everything above at it until the callback finishes.
     *
     * Nested calls join the outer transaction rather than opening a second one — db.js already
     * does that, and this is what lets it: an inner call sees `current` is already scoped and
     * passes it straight through. So a query file can wrap its own writes in withTransaction
     * without caring whether the request already opened one, which is the only way code that
     * is called from several places can be safe on its own.
     *
     * `current` is restored in a finally, so a throw inside the callback leaves the following
     * statements in the request running on the pool rather than on a released connection.
     */
    withTransaction: async (fn) => {
      const outer = current;
      try {
        return await outer.withTransaction(async (scoped) => {
          current = scoped;
          return await fn(scoped);
        });
      } finally {
        current = outer;
      }
    },

    // ---- pure helpers that never touched storage
    //
    // The four from SheetService.gs are copied verbatim in helpers.js rather than left
    // behind with the rest of that file. 61 call sites across the converted modules need
    // them, and the portal fell over on the first one — "stripRow_ is not defined" — the
    // moment it was run against Postgres for real.
    generateId_: generateId,
    stripRow_: helpers.stripRow_,
    inr_: helpers.inr_,
    rowRuns_: helpers.rowRuns_,

    /**
     * Tab name and portal field names to table name and column names.
     *
     * Only a hand-written query in server/queries/ needs this: it is writing SQL and has to
     * know that `SpareEnquiries.createdBy` is `spare_enquiries.created_by`. Nothing generated
     * uses it. Exposed rather than re-derived in each query file so there is one answer to
     * what a column is called, and it is the one db.js uses.
     *
     * It throws for a tab Schema.gs does not declare, which is the right answer — a query
     * naming a tab that does not exist is a mistake, not an empty result.
     */
    mapFor_: mapFor,

    // ---- the database itself, for code written after the migration
    //
    // A getter, so code reaching for `db` inside a transaction gets the transaction. A plain
    // property would hand out the pool and quietly leave that code outside it.
    get db() { return current; }
  };
}

module.exports = { globalsFor };
