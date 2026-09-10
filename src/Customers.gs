/**
 * Customer master — FR-001, FR-002, FR-003.
 *
 * One customer record is shared by both business streams and every downstream module, so
 * this is deliberately three tables rather than one wide row:
 *   Customers          identity + commercial profile
 *   CustomerContacts   purchase / maintenance / accounts / owner contacts (FR-002)
 *   CustomerAddresses  multiple billing and shipping addresses (FR-002)
 *
 * Field-level control (FR-003, FR-062): the commercial profile — credit limit, credit days,
 * payment terms, advance rule, risk status — is what the credit check later enforces, so
 * only Management and ERP Admin may set it. Everyone else can maintain the rest of the
 * record; submitted commercial values from them are ignored rather than rejected, so a
 * coordinator editing a phone number never trips over a permission error.
 */

var COMMERCIAL_FIELDS = ['paymentTerms', 'creditLimit', 'creditDays', 'advanceRule', 'riskStatus'];
var CONTACT_ROLES = ['Purchase', 'Maintenance', 'Accounts', 'Owner', 'Other'];
var ADDRESS_TYPES = ['Billing', 'Shipping'];

/** Everyone signed in may read customers; only these roles may create or edit them. */
var CUSTOMER_EDITORS = [ROLES.SALES_COORDINATOR, ROLES.SALES_ENGINEER, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

function canEditCommercials_(user) {
  return MASTER_EDITORS.indexOf(user.role) !== -1;
}

/** Customers with their contacts and addresses nested, in one pass over each table. */
function listCustomers(includeInactive) {
  getCurrentUser();

  var contactsByCustomer = {};
  readTable_('CustomerContacts').forEach(function (c) {
    if (String(c.active).toUpperCase() === 'FALSE') return;
    var key = String(c.customerId);
    (contactsByCustomer[key] = contactsByCustomer[key] || []).push(stripRow_(c));
  });

  var addressesByCustomer = {};
  readTable_('CustomerAddresses').forEach(function (a) {
    if (String(a.active).toUpperCase() === 'FALSE') return;
    var key = String(a.customerId);
    (addressesByCustomer[key] = addressesByCustomer[key] || []).push(stripRow_(a));
  });

  return readTable_('Customers')
    .filter(function (c) { return includeInactive || String(c.active).toUpperCase() !== 'FALSE'; })
    .map(function (c) {
      var row = stripRow_(c);
      var id = String(row.id);
      row.contacts = contactsByCustomer[id] || [];
      row.addresses = addressesByCustomer[id] || [];
      row.primaryContact = row.contacts.filter(function (x) {
        return String(x.isPrimary).toUpperCase() === 'TRUE';
      })[0] || row.contacts[0] || null;
      return row;
    });
}

/**
 * Duplicate detection (FR-001). GSTIN is the strong signal — it is legally unique, so a
 * match is treated as the same company. Name and phone matches are advisory: they are
 * returned as warnings for the user to judge rather than blocking the save.
 */
function findDuplicateCustomers(input, excludeId) {
  getCurrentUser();
  var gstin = String(input.gstin || '').trim().toUpperCase();
  var name = String(input.name || '').trim().toLowerCase();
  var phone = normalizePhone_(input.phone);

  var contactPhones = {};
  if (phone) {
    readTable_('CustomerContacts').forEach(function (c) {
      if (normalizePhone_(c.phone) === phone) contactPhones[String(c.customerId)] = true;
    });
  }

  var hits = [];
  readTable_('Customers').forEach(function (c) {
    if (excludeId && String(c.id) === String(excludeId)) return;
    var reasons = [];
    if (gstin && String(c.gstin).trim().toUpperCase() === gstin) reasons.push('same GSTIN');
    if (name && String(c.name).trim().toLowerCase() === name) reasons.push('same name');
    if (phone && contactPhones[String(c.id)]) reasons.push('same phone number');
    if (reasons.length) {
      hits.push({
        id: c.id, customerCode: c.customerCode, name: c.name, gstin: c.gstin,
        blocking: reasons.indexOf('same GSTIN') !== -1, reasons: reasons.join(', ')
      });
    }
  });
  return hits;
}

function saveCustomer(input) {
  var user = getCurrentUser();
  requireRole_(user, CUSTOMER_EDITORS);

  var name = String(input.name || '').trim();
  if (!name) throw new Error('Customer name is required.');

  var gstin = String(input.gstin || '').trim().toUpperCase();
  if (gstin && !/^[0-9A-Z]{15}$/.test(gstin)) {
    throw new Error('GSTIN should be 15 characters (letters and digits). Leave it blank if not known yet.');
  }

  var blocking = findDuplicateCustomers(input, input.id).filter(function (d) { return d.blocking; });
  if (blocking.length) {
    throw new Error('GSTIN ' + gstin + ' already belongs to "' + blocking[0].name +
      '" (' + blocking[0].customerCode + '). Edit that customer instead of creating a second record.');
  }

  var record = {
    name: name,
    legalName: String(input.legalName || '').trim(),
    gstin: gstin,
    pan: String(input.pan || '').trim().toUpperCase(),
    industry: String(input.industry || '').trim(),
    segment: String(input.segment || '').trim(),
    assignedSalesperson: String(input.assignedSalesperson || '').trim(),
    territory: String(input.territory || '').trim(),
    brand: String(input.brand || defaultBrand_()).trim(),
    notes: String(input.notes || '').trim(),
    active: input.active === false ? 'FALSE' : 'TRUE'
  };

  // Commercial terms only move when an authorized role submits them (FR-003).
  if (canEditCommercials_(user)) {
    record.paymentTerms = String(input.paymentTerms || '').trim();
    record.creditLimit = numberOrBlank_(input.creditLimit);
    record.creditDays = numberOrBlank_(input.creditDays);
    record.advanceRule = String(input.advanceRule || '').trim();
    record.riskStatus = String(input.riskStatus || '').trim();
  }

  if (input.id) {
    record.id = input.id;
    updateRowById_('Customers', 'id', input.id, record, 'Customer updated');
  } else {
    record.id = generateId_('CUS-');
    record.customerCode = nextCustomerCode_();
    record.createdAt = todayIso_();
    record.createdBy = user.email;
    appendRow_('Customers', record, 'Customer created');
  }
  return record;
}

/** Soft delete — orders, invoices and history all reference this record (FR-001). */
function deactivateCustomer(id, reason) {
  var user = getCurrentUser();
  requireRole_(user, [ROLES.MANAGEMENT, ROLES.ERP_ADMIN]);
  if (!String(reason || '').trim()) throw new Error('A reason is required to deactivate a customer.');
  updateRowById_('Customers', 'id', id, { active: 'FALSE' }, reason);
  return true;
}

// ------------------------------------------------------------------ contacts

function saveCustomerContact(input) {
  var user = getCurrentUser();
  requireRole_(user, CUSTOMER_EDITORS);
  if (!input.customerId) throw new Error('customerId is required.');
  var name = String(input.name || '').trim();
  if (!name) throw new Error('Contact name is required.');

  var record = {
    customerId: String(input.customerId),
    name: name,
    contactRole: String(input.contactRole || 'Other').trim(),
    designation: String(input.designation || '').trim(),
    phone: String(input.phone || '').trim(),
    email: String(input.email || '').trim(),
    isPrimary: input.isPrimary ? 'TRUE' : 'FALSE',
    active: 'TRUE'
  };

  // Only one primary per customer, so promoting one demotes the rest.
  if (record.isPrimary === 'TRUE') {
    readTable_('CustomerContacts').forEach(function (c) {
      if (String(c.customerId) !== record.customerId) return;
      if (String(c.id) === String(input.id || '')) return;
      if (String(c.isPrimary).toUpperCase() === 'TRUE') {
        updateRowById_('CustomerContacts', 'id', c.id, { isPrimary: 'FALSE' }, 'Another contact was made primary');
      }
    });
  }

  if (input.id) {
    record.id = input.id;
    updateRowById_('CustomerContacts', 'id', input.id, record, 'Contact updated');
  } else {
    record.id = generateId_('CON-');
    appendRow_('CustomerContacts', record, 'Contact added');
  }
  return record;
}

function deleteCustomerContact(id) {
  var user = getCurrentUser();
  requireRole_(user, CUSTOMER_EDITORS);
  updateRowById_('CustomerContacts', 'id', id, { active: 'FALSE' }, 'Contact removed');
  return true;
}

// ------------------------------------------------------------------ addresses

function saveCustomerAddress(input) {
  var user = getCurrentUser();
  requireRole_(user, CUSTOMER_EDITORS);
  if (!input.customerId) throw new Error('customerId is required.');
  var line1 = String(input.line1 || '').trim();
  if (!line1) throw new Error('Address line 1 is required.');
  var addressType = String(input.addressType || 'Billing').trim();
  if (ADDRESS_TYPES.indexOf(addressType) === -1) throw new Error('Address type must be Billing or Shipping.');

  var record = {
    customerId: String(input.customerId),
    addressType: addressType,
    label: String(input.label || '').trim(),
    line1: line1,
    line2: String(input.line2 || '').trim(),
    city: String(input.city || '').trim(),
    state: String(input.state || '').trim(),
    pincode: String(input.pincode || '').trim(),
    gstin: String(input.gstin || '').trim().toUpperCase(),
    isDefault: input.isDefault ? 'TRUE' : 'FALSE',
    active: 'TRUE'
  };

  // One default per address type, so orders and invoices always resolve to exactly one.
  if (record.isDefault === 'TRUE') {
    readTable_('CustomerAddresses').forEach(function (a) {
      if (String(a.customerId) !== record.customerId) return;
      if (String(a.addressType) !== addressType) return;
      if (String(a.id) === String(input.id || '')) return;
      if (String(a.isDefault).toUpperCase() === 'TRUE') {
        updateRowById_('CustomerAddresses', 'id', a.id, { isDefault: 'FALSE' },
          'Another ' + addressType.toLowerCase() + ' address was made default');
      }
    });
  }

  if (input.id) {
    record.id = input.id;
    updateRowById_('CustomerAddresses', 'id', input.id, record, 'Address updated');
  } else {
    record.id = generateId_('ADR-');
    appendRow_('CustomerAddresses', record, 'Address added');
  }
  return record;
}

function deleteCustomerAddress(id) {
  var user = getCurrentUser();
  requireRole_(user, CUSTOMER_EDITORS);
  updateRowById_('CustomerAddresses', 'id', id, { active: 'FALSE' }, 'Address removed');
  return true;
}

// ------------------------------------------------------------------ helpers

/** Sequential, human-readable, never reused — CUST-0001 and upward. */
function nextCustomerCode_() {
  var highest = 0;
  readTable_('Customers').forEach(function (c) {
    var m = /^CUST-(\d+)$/.exec(String(c.customerCode || '').trim());
    if (m) highest = Math.max(highest, Number(m[1]));
  });
  return 'CUST-' + String(highest + 1).padStart(4, '0');
}

/** Strips spaces, dashes and an Indian country code so 98220-12345 matches +91 9822012345. */
function normalizePhone_(phone) {
  var digits = String(phone || '').replace(/\D/g, '');
  if (digits.length > 10 && digits.slice(0, 2) === '91') digits = digits.slice(2);
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function numberOrBlank_(v) {
  if (v === '' || v === null || v === undefined) return '';
  var n = Number(v);
  return isNaN(n) ? '' : n;
}
