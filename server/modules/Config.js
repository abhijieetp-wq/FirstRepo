/**
 * Converted from src/Config.gs by migration/to-async.js.
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
 * Admin-maintainable dropdown lists (FR-074).
 *
 * Lead sources, industries, payment terms, urgency levels and similar controlled lists live
 * in the ConfigLists tab so the business can change them without a code change. Everything
 * that offers a dropdown reads from here.
 */

/** { Industry: [{code,label}], PaymentTerms: [...], ... } — active entries, in sort order. */
async function getConfigLists() {
  getCurrentUser();
  var grouped = {};
  (await readTable_('ConfigLists'))
    .filter(function (r) { return String(r.active).toUpperCase() !== 'FALSE'; })
    .sort(function (a, b) { return (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0); })
    .forEach(function (r) {
      var cat = String(r.category || '').trim();
      if (!cat) return;
      (grouped[cat] = grouped[cat] || []).push({ code: r.code, label: r.label });
    });
  return grouped;
}

/** Adds or updates one list entry. Configuration is ERP Admin / Management only. */
async function saveConfigListItem(input) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);

  var category = String(input.category || '').trim();
  var label = String(input.label || '').trim();
  if (!category || !label) throw new Error('Category and label are required.');

  var record = {
    category: category,
    code: String(input.code || label.toUpperCase().replace(/[^A-Z0-9]+/g, '_')).trim(),
    label: label,
    sortOrder: input.sortOrder === '' || input.sortOrder === undefined || input.sortOrder === null
      ? '' : Number(input.sortOrder),
    active: input.active === false ? 'FALSE' : 'TRUE'
  };

  if (input.id) {
    record.id = input.id;
    await updateRowById_('ConfigLists', 'id', input.id, record, 'List item updated');
  } else {
    record.id = generateId_('CL-');
    await appendRow_('ConfigLists', record, 'List item added');
  }
  return record;
}

/** The list of active users, for "assigned salesperson" style pickers. */
async function listActiveUsers() {
  getCurrentUser();
  return (await readTable_('Users'))
    .filter(function (u) { return String(u.active).toUpperCase() !== 'FALSE'; })
    .map(function (u) { return { email: u.email, name: u.name, role: u.role }; });
}
