/**
 * Identity comes from Session.getActiveUser() (the deployment runs "as user accessing the
 * app", domain-restricted) — there is no separate password system. The Users tab is the
 * authorization list: email → name/role/businessStream/active.
 *
 * Roles (D4 — five, collapsed from the blueprint's eleven):
 *   Sales Coordinator — quotations, orders, stores/dispatch/billing/collection operations
 *   Sales Engineer    — compressor leads, site visits, technical selection, own opportunities
 *   Service Engineer  — installation, warranty, service (Phase 2 surface)
 *   Management        — approves exceptions (discount, credit, dispatch), full visibility
 *   ERP Admin         — everything, plus masters, users and configuration
 *
 * businessStream (D2) scopes a user to Compressor Sales or Spare Sales; Management and
 * ERP Admin carry "All". Nothing filters by it yet — the field exists so that filtering can
 * be switched on without a migration.
 */

var ROLES = {
  SALES_COORDINATOR: 'Sales Coordinator',
  SALES_ENGINEER: 'Sales Engineer',
  SERVICE_ENGINEER: 'Service Engineer',
  MANAGEMENT: 'Management',
  ERP_ADMIN: 'ERP Admin'
};

var ALL_ROLES = [ROLES.SALES_COORDINATOR, ROLES.SALES_ENGINEER, ROLES.SERVICE_ENGINEER,
  ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/** Roles allowed to maintain the Product/Spare masters and pricing (FR-062). */
var MASTER_EDITORS = [ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/** Roles that approve exceptions — discount, credit release, dispatch deviation (A01–A11). */
var APPROVERS = [ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/**
 * Accepts the pre-D4 role names so a half-migrated Users tab can still sign in. setupSheet()
 * rewrites these values; this map only prevents a lockout in between.
 */
var LEGACY_ROLE_ALIASES = {
  'Coordinator': ROLES.SALES_COORDINATOR,
  'Warehouse': ROLES.SALES_COORDINATOR,
  'Manager': ROLES.MANAGEMENT,
  'Admin': ROLES.ERP_ADMIN
};

function getCurrentUserEmail_() {
  var email = Session.getActiveUser().getEmail();
  if (!email) {
    throw new Error('Could not identify your Google account. Make sure you opened this app while logged into your Workspace account.');
  }
  return email;
}

/** Looks up the caller in the Users tab. Throws if they're missing or deactivated. */
function getCurrentUser() {
  var email = getCurrentUserEmail_();
  var users = readTable_('Users');
  var match = users.filter(function (u) {
    return String(u.email).toLowerCase() === email.toLowerCase();
  })[0];

  if (!match) {
    throw new Error('Your account (' + email + ') is not set up yet. Ask your ERP Admin to add you to the Users tab.');
  }
  if (match.active !== true && String(match.active).toUpperCase() !== 'TRUE') {
    throw new Error('Your account (' + email + ') has been deactivated. Contact your ERP Admin.');
  }

  var role = String(match.role).trim();
  if (LEGACY_ROLE_ALIASES[role]) role = LEGACY_ROLE_ALIASES[role];
  if (ALL_ROLES.indexOf(role) === -1) {
    throw new Error('Your account (' + email + ') has an unrecognized role "' + match.role +
      '". Valid roles are: ' + ALL_ROLES.join(', ') + '.');
  }

  var crossStream = (role === ROLES.ERP_ADMIN || role === ROLES.MANAGEMENT);
  return {
    email: email,
    name: match.name || email,
    role: role,
    businessStream: crossStream ? 'All' : (match.businessStream || 'Spare Sales')
  };
}

/** Call at the top of any server function that must be restricted to specific roles. */
function requireRole_(user, allowedRoles) {
  if (allowedRoles.indexOf(user.role) === -1) {
    throw new Error("You don't have permission to do this. Requires: " + allowedRoles.join(' or ') + '.');
  }
}
