/**
 * ERP 2.0's form builder: fields Management adds to a form without a code change — on the
 * form, in the record, and as a list column when ticked. ERP 2's types: text, number, date,
 * dropdown, long text, yes / no; each can be required.
 *
 * The forms: spare enquiries, compressor leads, service jobs, customers, AMC contracts,
 * visits and tasks. A field belongs to one form; its values are kept apart from ERP 1's
 * records (FormFieldValues), so nothing ERP 1 reads or prints changes. Taking a field off the
 * form keeps the values already entered, as ERP 2 does.
 *
 * Who sees and fills a form's fields follows the record: whoever may open it sees them,
 * whoever may change it fills them. Shown on the 2.0 face only.
 */

var FORM_FIELD_TYPES = ['text', 'number', 'date', 'select', 'textarea', 'checkbox'];
var FORM_FIELD_FORMS = {
  enquiry: { label: 'Spare enquiries', table: 'SpareEnquiries' },
  lead: { label: 'Compressor leads', table: 'Leads' },
  service: { label: 'Service jobs', table: 'ServiceJobs' },
  customer: { label: 'Customers', table: 'Customers' },
  amc: { label: 'AMC contracts', table: 'AmcContracts' },
  visit: { label: 'Visits', table: 'SalesVisits' },
  task: { label: 'Tasks', table: 'Tasks' }
};

function formFieldsForm_(form) {
  var spec = FORM_FIELD_FORMS[String(form || '')];
  if (!spec) throw new Error('There is no form called that.');
  return spec;
}

/** May this person see the fields on this form's records, and fill them? */
function formFieldsAccess_(form, user, record) {
  var role = String(user.role);
  var any = function (list) { return list.indexOf(role) !== -1; };
  switch (form) {
    case 'enquiry': {
      var spare = !isServiceOnly_(user) && streamAllowed_(user, STREAM_SPARE);
      return { see: spare, fill: spare && any(ENQUIRY_EDITORS) };
    }
    case 'lead': {
      var comp = !isServiceOnly_(user) && streamAllowed_(user, STREAM_COMPRESSOR);
      return { see: comp, fill: comp && any(LEAD_EDITORS) };
    }
    case 'customer': return { see: !isServiceOnly_(user), fill: any(CUSTOMER_EDITORS) };
    case 'service': return { see: any(SERVICE_ROLES), fill: any(SERVICE_ROLES) };
    case 'amc': return { see: any(AMC_EDITORS.concat([ROLES.SERVICE_ENGINEER])), fill: any(AMC_EDITORS) };
    case 'visit': {
      var mine = !record || visitMine_(record, user);
      return { see: any(VISIT_PLANNERS) && mine, fill: any(VISIT_PLANNERS) && mine };
    }
    case 'task': {
      if (!record) return { see: true, fill: true };
      return { see: taskSees_(record, user), fill: taskMayTick_(record, user) };
    }
  }
  return { see: false, fill: false };
}

function formFieldRows_() {
  try { return readTable_('FormFields'); } catch (err) { return []; }
}

function formFieldOut_(f) {
  return {
    key: String(f.fieldKey), label: String(f.label || ''), type: String(f.type || 'text'),
    options: String(f.options || '').split('\n').map(function (o) { return o.trim(); }).filter(Boolean),
    required: String(f.isRequired).toUpperCase() === 'TRUE', inList: String(f.isListColumn).toUpperCase() === 'TRUE'
  };
}

/** Every form's fields, in order, for the forms on screen. */
function getFormFields() {
  var user = getCurrentUser();
  var fields = {};
  Object.keys(FORM_FIELD_FORMS).forEach(function (k) { fields[k] = []; });
  formFieldRows_().filter(function (f) { return String(f.active).toUpperCase() !== 'FALSE' && fields[String(f.form)]; })
    .sort(function (a, b) { return (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0); })
    .forEach(function (f) { fields[String(f.form)].push(formFieldOut_(f)); });
  return {
    forms: Object.keys(FORM_FIELD_FORMS).map(function (k) { return { key: k, label: FORM_FIELD_FORMS[k].label }; }),
    types: FORM_FIELD_TYPES, fields: fields, canEdit: MASTER_EDITORS.indexOf(String(user.role)) !== -1
  };
}

/** "Warranty end" → "warranty_end": a field's key, kept when its label changes. */
function formFieldKey_(label, taken) {
  var base = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
  var key = base;
  var n = 2;
  while (taken[key]) key = base + '_' + n++;
  taken[key] = true;
  return key;
}

/**
 * A form's fields, as the builder lists them: order, labels, types, options, required, list
 * column. A field left out is taken off the form; its values stay, and come back if a field of
 * the same name is added again.
 *
 * @param list [{ key?, label, type, options: [..] or 'a, b', required, inList }]
 */
function saveFormFields(form, list) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  formFieldsForm_(form);
  var rows = formFieldRows_().filter(function (f) { return String(f.form) === String(form); });
  var byKey = {};
  var taken = {};
  rows.forEach(function (f) { byKey[String(f.fieldKey)] = f; taken[String(f.fieldKey)] = true; });
  var seenLabels = {};
  var usedKeys = {};
  var clean = (list || []).map(function (f) {
    var label = String((f && f.label) || '').trim();
    if (!label) throw new Error('Every field needs a label.');
    if (label.length > 60) throw new Error('Keep a field’s label under 60 characters.');
    if (seenLabels[label.toLowerCase()]) throw new Error('“' + label + '” is on the form twice.');
    seenLabels[label.toLowerCase()] = true;
    var type = String((f && f.type) || 'text');
    if (FORM_FIELD_TYPES.indexOf(type) === -1) throw new Error('A field is text, a number, a date, a dropdown, long text or yes / no.');
    var options = Array.isArray(f.options) ? f.options : String(f.options || '').split(/[,\n]/);
    options = options.map(function (o) { return String(o).trim(); }).filter(Boolean);
    if (type === 'select' && !options.length) throw new Error('Give “' + label + '” the choices for its dropdown.');
    var key = String((f && f.key) || '');
    // A field taken off and added back under the same name is the same field: its values return.
    if (!key || !byKey[key]) {
      var back = rows.filter(function (r) { return String(r.active).toUpperCase() === 'FALSE' && String(r.label).trim().toLowerCase() === label.toLowerCase(); })[0];
      key = back ? String(back.fieldKey) : '';
    }
    if (usedKeys[key]) key = '';
    if (key) usedKeys[key] = true;
    return { key: key && byKey[key] ? key : '', label: label, type: type, options: type === 'select' ? options : [],
      required: !!(f && f.required), inList: !!(f && f.inList) };
  });
  var now = nowIso_();
  var kept = {};
  var order = 0;
  for (var f of clean) {
    order++;
    var record = { label: f.label, type: f.type, options: f.options.join('\n'), isRequired: f.required ? 'TRUE' : 'FALSE',
      isListColumn: f.inList ? 'TRUE' : 'FALSE', sortOrder: order, active: 'TRUE', updatedAt: now, updatedBy: user.email };
    if (f.key) {
      kept[f.key] = true;
      updateRowById_('FormFields', 'id', byKey[f.key].id, record, 'Form field changed');
    } else {
      record.id = generateId_('FF-');
      record.form = String(form);
      record.fieldKey = formFieldKey_(f.label, taken);
      kept[record.fieldKey] = true;
      record.createdAt = now;
      record.createdBy = user.email;
      appendRow_('FormFields', record, 'Form field added to ' + form);
    }
  }
  for (var r of rows) {
    if (kept[String(r.fieldKey)] || String(r.active).toUpperCase() === 'FALSE') continue;
    updateRowById_('FormFields', 'id', r.id, { active: 'FALSE', updatedAt: now, updatedBy: user.email }, 'Form field taken off the form');
  }
  return getFormFields().fields[form];
}

/** The values held for these records on this form, read by record rather than the whole table. */
function formFieldValueRows_(form, recordIds) {
  var rows;
  try { rows = findRowsByColumn_('FormFieldValues', 'recordId', recordIds.map(String)); } catch (err) { return []; }
  return rows.filter(function (r) { return String(r.form) === String(form); });
}

/**
 * The values of a form's fields on some records: { recordId: { key: value } }. Records this
 * person may not open are left out.
 */
function getCustomValues(form, recordIds) {
  var user = getCurrentUser();
  var spec = formFieldsForm_(form);
  var ids = (recordIds || []).map(String).filter(Boolean);
  if (!formFieldsAccess_(form, user, null).see || !ids.length) return {};
  var allowed = {};
  if (form === 'task' || form === 'visit') {
    findRowsByColumn_(spec.table, 'id', ids).forEach(function (r) {
      if (formFieldsAccess_(form, user, r).see) allowed[String(r.id)] = true;
    });
  } else {
    ids.forEach(function (id) { allowed[id] = true; });
  }
  var want = {};
  ids.forEach(function (id) { if (allowed[id]) want[id] = true; });
  var out = {};
  if (!Object.keys(want).length) return out;
  formFieldValueRows_(form, Object.keys(want)).forEach(function (v) {
    var id = String(v.recordId);
    if (!want[id]) return;
    (out[id] = out[id] || {})[String(v.fieldKey)] = String(v.value === null || v.value === undefined ? '' : v.value);
  });
  return out;
}

/**
 * Fills a record's fields. Each value is checked against its field's type; a required field
 * left empty is refused. Fields not on the form are ignored.
 */
function saveCustomValues(form, recordId, values) {
  var user = getCurrentUser();
  var spec = formFieldsForm_(form);
  var record = findRowById_(spec.table, recordId);
  if (!record) throw new Error('That record is no longer there.');
  if (!formFieldsAccess_(form, user, record).fill) throw new Error('You cannot change this record’s details.');
  var fields = getFormFields().fields[form];
  var existing = {};
  formFieldValueRows_(form, [recordId]).forEach(function (r) {
    if (String(r.recordId) === String(recordId)) existing[String(r.fieldKey)] = r;
  });
  var was = function (key) {
    var row = existing[key];
    return row ? String(row.value === null || row.value === undefined ? '' : row.value) : '';
  };
  var v = values || {};
  var missing = [];
  var clean = {};
  fields.forEach(function (f) {
    var raw = v[f.key];
    var s = f.type === 'checkbox' ? (raw === true || String(raw).toUpperCase() === 'TRUE' ? 'TRUE' : '') : String(raw === null || raw === undefined ? '' : raw).trim();
    if (!s) { if (f.required) missing.push(f.label); clean[f.key] = ''; return; }
    clean[f.key] = s;
    // What a record already holds stays as it is — a choice since taken off the list, or a
    // value from before the field's type changed — so the record can still be saved.
    if (s === was(f.key)) return;
    if (f.type === 'number' && !isFinite(Number(s))) throw new Error('“' + f.label + '” is a number.');
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('“' + f.label + '” is a date.');
    if (f.type === 'select' && f.options.indexOf(s) === -1) throw new Error('Pick “' + f.label + '” from its list.');
    if (s.length > 2000) throw new Error('Keep “' + f.label + '” under 2,000 characters.');
  });
  if (missing.length) throw new Error('Fill in: ' + missing.join(', ') + '.');
  var now = nowIso_();
  for (var key of Object.keys(clean)) {
    var row = existing[key];
    if (row) {
      if (was(key) === clean[key]) continue;
      updateRowById_('FormFieldValues', 'id', row.id, { value: clean[key], updatedAt: now, updatedBy: user.email }, 'Custom field changed');
    } else if (clean[key] !== '') {
      appendRow_('FormFieldValues', { id: generateId_('FV-'), form: String(form), recordId: String(recordId), fieldKey: key, value: clean[key],
        updatedAt: now, updatedBy: user.email }, 'Custom field filled');
    }
  }
  return getCustomValues(form, [recordId])[String(recordId)] || {};
}
