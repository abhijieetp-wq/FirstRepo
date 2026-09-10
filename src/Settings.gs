/**
 * Settings — brand tiles and Admin Controls (D5, FR-062, FR-074).
 *
 * Two jobs on one screen. The brand tiles are the future shape of the product: ELGI is live,
 * Cumi and Champion are the same pattern waiting their turn (D5). Admin Controls are the
 * things the business must be able to change without a developer — people, dropdown lists,
 * lost reasons, warehouses, and the Tally connection.
 *
 * Everything here is Management / ERP Admin only, and that gating is not cosmetic. The web
 * app runs as the *user accessing it*, so any signed-in person could call these functions
 * directly; the role check on the server is the only thing that actually stops them.
 *
 * Tally connection details live in Script Properties, never in the Sheet and never in the
 * repo (D3). A credential, once written, is never read back out — the screen can only report
 * whether one is set and replace it.
 */

var SETTINGS_ROLES = [ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/** Script Property keys the Settings page owns. */
var TALLY_PROPS = {
  ENDPOINT: 'TALLY_ENDPOINT',
  COMPANY: 'TALLY_COMPANY',
  CREDENTIAL: 'TALLY_CREDENTIAL'
};

/** The one payload behind the whole screen. */
function getSettings() {
  var user = getCurrentUser();
  requireRole_(user, SETTINGS_ROLES);

  var props = PropertiesService.getScriptProperties();

  return {
    role: user.role,
    // Live brands first — ELGI leads the tiles even though it sorts last alphabetically.
    brands: readTable_('Brands').map(stripRow_)
      .sort(function (a, b) {
        var aLive = String(a.active).toUpperCase() !== 'FALSE' ? 0 : 1;
        var bLive = String(b.active).toUpperCase() !== 'FALSE' ? 0 : 1;
        if (aLive !== bLive) return aLive - bLive;
        return String(a.name).localeCompare(String(b.name));
      }),
    businessStreams: readTable_('BusinessStreams').map(stripRow_),
    users: readTable_('Users').map(function (u) {
      var row = stripRow_(u);
      row.isSelf = String(row.email).toLowerCase() === String(user.email).toLowerCase();
      return row;
    }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); }),
    configLists: readTable_('ConfigLists').map(stripRow_)
      .sort(function (a, b) {
        if (a.category !== b.category) return String(a.category).localeCompare(String(b.category));
        return (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
      }),
    lostReasons: readTable_('LostReasons').map(stripRow_),
    warehouses: readTable_('Warehouses').map(stripRow_),
    roles: ALL_ROLES,
    // The letterhead and the standing quotation text are edited here, because they change
    // more often than the software does.
    companyProfile: getCompanyProfile(),
    quoteTemplates: listQuoteTemplates({ includeInactive: true }),
    quoteSections: QUOTE_SECTIONS,
    tally: {
      endpoint: props.getProperty(TALLY_PROPS.ENDPOINT) || '',
      company: props.getProperty(TALLY_PROPS.COMPANY) || '',
      // The credential itself never leaves the server — only whether one exists.
      hasCredential: !!props.getProperty(TALLY_PROPS.CREDENTIAL)
    },
    system: {
      spreadsheetName: SpreadsheetApp.getActiveSpreadsheet().getName(),
      spreadsheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
      declaredTabs: Object.keys(SCHEMA).length,
      timeZone: Session.getScriptTimeZone()
    }
  };
}

// -------------------------------------------------------------------------------- people

/**
 * Adds or edits a user (FR-062).
 *
 * Two guards exist so the Settings page cannot lock everyone out of the Settings page: you
 * cannot deactivate or demote yourself, and the last active ERP Admin cannot be removed. Both
 * are recoverable by editing the Users tab in the Sheet directly, but recovering from the
 * Sheet is a bad afternoon, so the app refuses first.
 */
function saveUser(input) {
  var user = getCurrentUser();
  requireRole_(user, SETTINGS_ROLES);

  var email = String(input.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) throw new Error('A valid email address is required.');
  if (!String(input.name || '').trim()) throw new Error('Enter the person’s name.');
  if (ALL_ROLES.indexOf(input.role) === -1) throw new Error('Pick one of the five roles.');

  var users = readTable_('Users');
  var existing = users.filter(function (u) {
    return String(u.email).trim().toLowerCase() === email;
  })[0];

  if (!input.id && existing) {
    throw new Error(email + ' is already on the list. Edit that row instead of adding a second one.');
  }

  var isSelf = email === String(user.email).trim().toLowerCase();
  var goingInactive = input.active === false;

  if (isSelf && goingInactive) {
    throw new Error('You cannot deactivate your own account — you would be locked out immediately.');
  }
  if (isSelf && existing && existing.role === ROLES.ERP_ADMIN && input.role !== ROLES.ERP_ADMIN) {
    throw new Error('You cannot remove your own ERP Admin role. Ask another admin to do it.');
  }

  // The last active ERP Admin is load-bearing.
  if (existing && existing.role === ROLES.ERP_ADMIN &&
      (goingInactive || input.role !== ROLES.ERP_ADMIN)) {
    var otherAdmins = users.filter(function (u) {
      return u.role === ROLES.ERP_ADMIN &&
        String(u.active).toUpperCase() !== 'FALSE' &&
        String(u.email).trim().toLowerCase() !== email;
    });
    if (!otherAdmins.length) {
      throw new Error('This is the only active ERP Admin. Promote someone else first.');
    }
  }

  var record = {
    email: email,
    name: String(input.name).trim(),
    role: input.role,
    businessStream: String(input.businessStream || 'All').trim(),
    active: goingInactive ? 'FALSE' : 'TRUE'
  };

  if (input.id) {
    updateRowById_('Users', 'id', input.id, record, 'User updated');
  } else {
    record.id = generateId_('USR-');
    record.createdAt = todayIso_();
    record.createdBy = user.email;
    appendRow_('Users', record, 'User added');
  }
  return getSettings();
}

// -------------------------------------------------------------- lists, reasons, locations

function saveLostReason(input) {
  var user = getCurrentUser();
  requireRole_(user, SETTINGS_ROLES);

  var text = String(input.reasonText || '').trim();
  if (!text) throw new Error('Enter the reason text.');

  var record = {
    reasonText: text,
    appliesTo: String(input.appliesTo || 'All').trim(),
    active: input.active === false ? 'FALSE' : 'TRUE'
  };

  if (input.id) {
    updateRowById_('LostReasons', 'id', input.id, record, 'Lost reason updated');
  } else {
    record.id = generateId_('LR-');
    appendRow_('LostReasons', record, 'Lost reason added');
  }
  return getSettings();
}

function saveWarehouse(input) {
  var user = getCurrentUser();
  requireRole_(user, SETTINGS_ROLES);

  var code = String(input.code || '').trim().toUpperCase();
  var name = String(input.name || '').trim();
  if (!code || !name) throw new Error('Both a code and a name are required.');

  var clash = readTable_('Warehouses').filter(function (w) {
    return String(w.code).trim().toUpperCase() === code && String(w.id) !== String(input.id || '');
  })[0];
  if (clash) throw new Error('The code ' + code + ' is already used by ' + clash.name + '.');

  var record = {
    code: code,
    name: name,
    type: String(input.type || 'Warehouse').trim(),
    parentId: String(input.parentId || '').trim(),
    address: String(input.address || '').trim(),
    active: input.active === false ? 'FALSE' : 'TRUE'
  };

  if (input.id) {
    updateRowById_('Warehouses', 'id', input.id, record, 'Location updated');
  } else {
    record.id = generateId_('WH-');
    appendRow_('Warehouses', record, 'Location added');
  }
  return getSettings();
}

/**
 * Turns a brand on or off (D5). Only the name and accent colour are editable — a brand's id
 * is referenced by data, so it is never rewritten from here.
 */
function saveBrand(input) {
  var user = getCurrentUser();
  requireRole_(user, SETTINGS_ROLES);

  var brand = readTable_('Brands').filter(function (b) {
    return String(b.id) === String(input.id);
  })[0];
  if (!brand) throw new Error('Brand not found.');

  if (brand.name === 'ELGI' && input.active === false) {
    throw new Error('ELGI is the live brand and cannot be switched off.');
  }

  updateRowById_('Brands', 'id', input.id, {
    name: String(input.name || brand.name).trim(),
    accentColor: String(input.accentColor || brand.accentColor).trim(),
    active: input.active === false ? 'FALSE' : 'TRUE'
  }, 'Brand updated');
  return getSettings();
}

// --------------------------------------------------------------------------------- Tally

/**
 * Stores the Tally connection in Script Properties (D3). Nothing here is written to the
 * Sheet, so it never rides along in an export, and nothing is committed to the repo.
 *
 * A blank credential leaves the stored one alone; clearing it is a separate, explicit act,
 * because "I left the password box empty" should never silently delete a working password.
 */
function saveTallySettings(input) {
  var user = getCurrentUser();
  requireRole_(user, SETTINGS_ROLES);

  var endpoint = String(input.endpoint || '').trim();
  if (endpoint && !/^https?:\/\//i.test(endpoint)) {
    throw new Error('The endpoint must start with http:// or https://');
  }

  var props = PropertiesService.getScriptProperties();
  props.setProperty(TALLY_PROPS.ENDPOINT, endpoint);
  props.setProperty(TALLY_PROPS.COMPANY, String(input.company || '').trim());

  if (input.clearCredential) {
    props.deleteProperty(TALLY_PROPS.CREDENTIAL);
  } else if (String(input.credential || '').trim()) {
    props.setProperty(TALLY_PROPS.CREDENTIAL, String(input.credential).trim());
  }

  // The endpoint is recorded; the credential deliberately is not, in the audit trail either.
  audit_('Update', 'ScriptProperties', 'Tally', 'endpoint', '', endpoint,
    'Tally connection updated by ' + user.email);

  return getSettings();
}

// -------------------------------------------------------------------------------- system

/**
 * Re-runs the schema migrator from the UI so an admin does not have to open the script
 * editor. setupSheet() only ever adds missing tabs and appends missing columns, so running
 * it again is safe at any time.
 */
function runSetupFromSettings() {
  var user = getCurrentUser();
  requireRole_(user, [ROLES.ERP_ADMIN]);
  var report = setupSheet();
  audit_('Setup', 'Schema', '', '', '', '', 'setupSheet() run from Settings by ' + user.email);
  return report;
}

/** The most recent audit entries, newest first (FR-061). */
function listAuditLog(options) {
  var user = getCurrentUser();
  requireRole_(user, SETTINGS_ROLES);
  var opts = options || {};
  var limit = Math.min(Number(opts.limit) || 100, 500);

  var rows = readTable_(AUDIT_TAB).map(stripRow_);
  if (opts.table) {
    rows = rows.filter(function (r) { return r.tableName === opts.table; });
  }
  if (opts.userEmail) {
    rows = rows.filter(function (r) {
      return String(r.userEmail || '').toLowerCase().indexOf(String(opts.userEmail).toLowerCase()) !== -1;
    });
  }
  return rows.reverse().slice(0, limit);
}
