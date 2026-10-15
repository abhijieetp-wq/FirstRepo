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

const { generateId } = require('./db.js');

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

  return {
    // ---- the twelve, all async now
    readTable_: (tab) => bound.readTable(tab),
    findRowById_: (tab, id) => bound.findRowById(tab, id),
    findRowsByColumn_: (tab, col, values) => bound.findRowsByColumn(tab, col, values),
    findRowsByIds_: (tab, ids) => bound.findRowsByIds(tab, ids),
    columnMap_: (tab, k, v) => bound.columnMap(tab, k, v),
    appendRow_: (tab, obj, reason) => bound.appendRow(tab, obj, reason),
    appendRows_: (tab, objs, reason) => bound.appendRows(tab, objs, reason),
    updateRowById_: (tab, f, v, patch, reason) => bound.updateRowById(tab, f, v, patch, reason),
    deleteRowById_: (tab, f, v, reason) => bound.deleteRowById(tab, f, v, reason),
    deleteRowsWhere_: (tab, matches, reason) => bound.deleteRowsWhere(tab, matches, reason),
    audit_: (action, table, id, field, oldV, newV, reason) =>
      bound.audit(action, table, id, field, oldV, newV, reason),
    auditMany_: async (entries) => {
      for (const e of (entries || [])) {
        await bound.audit(e.action, e.tableName, e.recordId, e.fieldName,
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
    withTransaction: (fn) => bound.withTransaction(fn),

    // ---- pure helpers that never touched storage
    generateId_: generateId,

    // ---- the database itself, for code written after the migration
    db: bound
  };
}

module.exports = { globalsFor };
