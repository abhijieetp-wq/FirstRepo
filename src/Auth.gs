/**
 * The Users tab is the authorization list: email → name/role/businessStream/active.
 *
 * Identity used to come from Session.getActiveUser(), with the app running as whoever opened
 * it. That also required every person's Google account to hold access to the spreadsheet, so
 * anybody could open it in Drive and read everything with none of the rules below applying.
 * The app now runs as its owner, the sheet is shared with nobody, and the caller proves who
 * they are with a password — see Session.gs. `email` is still the identity; it simply no
 * longer has to be a Google account.
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
  // Who a service job goes to is not the sales side's call. The sales coordinator tells the
  // service coordinator that a delivery has landed and installation is needed; the service
  // coordinator decides which engineer goes.
  SERVICE_COORDINATOR: 'Service Coordinator',
  SERVICE_ENGINEER: 'Service Engineer',
  MANAGEMENT: 'Management',
  ERP_ADMIN: 'ERP Admin'
};

var ALL_ROLES = [ROLES.SALES_COORDINATOR, ROLES.SALES_ENGINEER, ROLES.SERVICE_COORDINATOR,
  ROLES.SERVICE_ENGINEER, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/**
 * Two different questions about the catalogue, and they deserve two different answers.
 *
 * Adding a part and pricing it is ordinary work. A coordinator half way through an offer who
 * finds the part is not listed should not have to stop and find a manager — that is the
 * bottleneck this system exists to remove, and every change is audited anyway.
 *
 * Removing a part, importing over the whole catalogue, or editing the dropdowns the rest of
 * the system is built on is not ordinary work. A mistake there is felt by everybody and is
 * hard to see, so it stays with Management.
 */
var CATALOG_EDITORS = [ROLES.SALES_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/** Roles allowed to remove from the masters, import over them, or change the config lists. */
var MASTER_EDITORS = [ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

/**
 * The service office, and what it is not.
 *
 * Service picks a customer up after the goods have landed: the sales coordinator hands the
 * customer over, service installs, writes the report, and then carries the relationship for
 * breakdowns. What they never need is the commercial side of it — the quotation, the
 * discount, the order value, what the customer owes. A coordinator who only has to decide
 * which engineer goes out has no business reading a price list.
 */
var SERVICE_SIDE = [ROLES.SERVICE_COORDINATOR, ROLES.SERVICE_ENGINEER];

/** Everything commercial: quotations, orders, dispatch, invoices, collections, masters. */
var COMMERCIAL_SIDE = [ROLES.SALES_COORDINATOR, ROLES.SALES_ENGINEER, ROLES.MANAGEMENT,
  ROLES.ERP_ADMIN];

/** True for somebody whose work begins at the handover and ends at the machine. */
function isServiceOnly_(user) {
  return !!user && SERVICE_SIDE.indexOf(user.role) !== -1;
}

/**
 * Refuses the commercial side to the service office.
 *
 * Named for what the screen is rather than for the role, because the person reading the
 * message wants to know why they cannot see a thing, not which list they are missing from.
 */
function requireCommercial_(user, what) {
  if (!isServiceOnly_(user)) return;
  throw new Error((what || 'That') + ' is sales work. Service sees the jobs handed over to ' +
    'it, the machine and the customer\u2019s contact \u2014 not the commercial side of the ' +
    'order.');
}

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

/**
 * Turns a Users row into the object every server function works with.
 *
 * Kept separate from whoever is asking, so that signing in and being signed in build the
 * same thing from the same rules — a role alias resolved at login and not afterwards would
 * be a difference nobody would find until it mattered.
 */
function userFromRow_(match) {
  var email = String(match.email);
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

/**
 * Who this request is for.
 *
 * Identity used to come from Google, because the web app ran as whoever opened it — which
 * also meant handing every user access to the spreadsheet itself. It now runs as its owner,
 * the sheet is shared with nobody, and the caller proves who they are with a token that
 * `call` has already checked before anything else runs. So this reads what that established
 * rather than asking Google, and the hundred and eighty places that call it are unchanged.
 */
function getCurrentUser() {
  if (CURRENT_USER_) return CURRENT_USER_;
  throw new Error('SESSION_ENDED');
}

/** Call at the top of any server function that must be restricted to specific roles. */
function requireRole_(user, allowedRoles) {
  if (allowedRoles.indexOf(user.role) === -1) {
    throw new Error("You don't have permission to do this. Requires: " + allowedRoles.join(' or ') + '.');
  }
}
