/**
 * Admin-maintainable dropdown lists (FR-074).
 *
 * Lead sources, industries, payment terms, urgency levels and similar controlled lists live
 * in the ConfigLists tab so the business can change them without a code change. Everything
 * that offers a dropdown reads from here.
 */

/** { Industry: [{code,label}], PaymentTerms: [...], ... } — active entries, in sort order. */
function getConfigLists() {
  getCurrentUser();
  var grouped = {};
  readTable_('ConfigLists')
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
function saveConfigListItem(input) {
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
    updateRowById_('ConfigLists', 'id', input.id, record, 'List item updated');
  } else {
    record.id = generateId_('CL-');
    appendRow_('ConfigLists', record, 'List item added');
  }
  return record;
}

/** The list of active users, for "assigned salesperson" style pickers. */
function listActiveUsers() {
  getCurrentUser();
  return readTable_('Users')
    .filter(function (u) { return String(u.active).toUpperCase() !== 'FALSE'; })
    .map(function (u) { return { email: u.email, name: u.name, role: u.role }; });
}
