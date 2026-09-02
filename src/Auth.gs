/**
 * Identity comes from Session.getActiveUser() (the deployment runs "as user accessing the
 * app", domain-restricted) — there is no separate password system. The Users tab is the
 * authorization list: it maps that email to a name/role/active flag.
 */

var ROLES = {
  COORDINATOR: 'Coordinator',
  WAREHOUSE: 'Warehouse',
  MANAGER: 'Manager'
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
    throw new Error('Your account (' + email + ') is not set up yet. Ask your Manager to add you to the Users tab.');
  }
  if (match.active !== true && String(match.active).toUpperCase() !== 'TRUE') {
    throw new Error('Your account (' + email + ') has been deactivated. Contact your Manager.');
  }
  if ([ROLES.COORDINATOR, ROLES.WAREHOUSE, ROLES.MANAGER].indexOf(match.role) === -1) {
    throw new Error('Your account (' + email + ') has an unrecognized role "' + match.role + '". Ask your Manager to fix the Users tab.');
  }

  return { email: email, name: match.name || email, role: match.role };
}

/** Call at the top of any server function that must be restricted to specific roles. */
function requireRole_(user, allowedRoles) {
  if (allowedRoles.indexOf(user.role) === -1) {
    throw new Error("You don't have permission to do this. Requires: " + allowedRoles.join(' or ') + '.');
  }
}
