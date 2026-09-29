/**
 * Changing the address a person is known by, without stranding everything they have done.
 *
 * PIE's employees have no company mailboxes, so their user rows were set up with personal
 * addresses — and the portal then wrote that address into every record they touched. It is not
 * a login (that is the username), it is not where anything is sent (the only message this
 * system sends goes to a customer, from the office account), and since the letterhead fix it
 * reaches no customer either. What it is, is the name the data calls them by: thirty-odd
 * columns across the sheet hold it, from preparedBy on a quotation to verifiedBy on a GRN.
 *
 * Which is why editing the Users row is not the way to change it. Settings would let you retype
 * the address and change exactly one cell; every record already written would keep pointing at
 * the old one. The name lookup would stop resolving them — and print the raw old address in its
 * place, which is the leak you were closing — and "only mine" would stop matching their own past
 * work. The row and the history have to move together or not at all.
 *
 * So: this. It reads what would change before it changes anything, the way the Tally imports do,
 * because a rename across thirty tables is not something to find out about afterwards.
 *
 * The audit log moves too, which deserves saying out loud. An audit log is not normally a thing
 * to rewrite. But it records who did something, and leaving it behind would leave a log
 * attributing work to an address no user has — unreadable, and still carrying the personal
 * address this exists to remove. The rename does not change what happened, only how the person
 * who did it is spelled, and the rename itself is logged.
 */

var USER_EMAIL_ROLES = [ROLES.ERP_ADMIN];

/**
 * Column names that hold a portal user's address, listed by what they are called rather than
 * one by one.
 *
 * A hard-coded list of thirty-four tables would be correct the day it was written and wrong the
 * first time somebody adds a column — and the failure would be silent, which is the worst kind:
 * a rename that quietly misses a column leaves the old address in the sheet and nobody finds out
 * until it prints. Reading the pattern out of SCHEMA means a new `somethingBy` column is covered
 * by having been declared.
 */
var USER_EMAIL_EXTRA_COLUMNS_ = ['ownerEmail', 'userEmail', 'salesEngineerEmail',
  'engineerEmail', 'assignedSalesperson', 'level1Approver', 'level2Approver'];

/**
 * Addresses that look like a user's and are not.
 *
 * contactEmail is the customer's own contact, CustomerContacts.email likewise, CompanyProfile's
 * is the letterhead, and Sessions.googleEmail is which Google account opened the browser — a
 * different thing from the row address, and the one that must not be touched or the gate stops
 * recognising a live session.
 */
var USER_EMAIL_NEVER_ = {
  'contactEmail': true,
  'CustomerContacts.email': true,
  'CompanyProfile.email': true,
  'Sessions.googleEmail': true
};

/** Tabs that hold configuration rather than work, whose columns are labels, not addresses. */
var USER_EMAIL_SKIP_TABS_ = { ConfigLists: true };

function userIdentityColumns_() {
  var out = [];
  Object.keys(SCHEMA).forEach(function (tab) {
    if (USER_EMAIL_SKIP_TABS_[tab]) return;
    (SCHEMA[tab].columns || []).forEach(function (col) {
      if (USER_EMAIL_NEVER_[col] || USER_EMAIL_NEVER_[tab + '.' + col]) return;
      var looksLikeActor = /By$/.test(col) ||
        USER_EMAIL_EXTRA_COLUMNS_.indexOf(col) !== -1 ||
        (tab === 'Users' && col === 'email');
      if (looksLikeActor) out.push({ tab: tab, column: col });
    });
  });
  return out;
}

/**
 * How many cells in one column hold this address.
 *
 * One column read rather than the whole tab: thirty-four tables read whole is thirty-four
 * round trips against tabs that are mostly irrelevant, and on Apps Script the trips are the
 * cost. A tab the sheet does not have yet is not an error — a sheet set up before a feature
 * shipped simply has nothing to rename in it.
 */
function userEmailMatches_(tab, column, address) {
  var sheet;
  try { sheet = getSheet_(tab); } catch (err) { return []; }
  if (!sheet) return [];
  var headers = getHeaders_(sheet, tab);
  var col = headers.indexOf(column);
  var lastRow = sheet.getLastRow();
  if (col === -1 || lastRow < 2) return [];

  var values = sheet.getRange(2, col + 1, lastRow - 1, 1).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toLowerCase() === address) rows.push(i + 2);
  }
  return rows;
}

/**
 * Writes the new address into the rows that hold the old one — and into no others.
 *
 * Read the column, change the cells that match, write the column back: one round trip each way,
 * whatever the shape of the matches.
 *
 * Not rowRuns_, which is what this did first and which quietly corrupted the sheet. That helper
 * collapses near-neighbours into one span and, past a certain number of runs, collapses the lot
 * into a single span from the first match to the last — deliberately, because it exists for
 * reads, where fetching a few extra rows costs nothing and saves a trip. Writing a span does not
 * read that way: every non-matching row inside it is overwritten. Renaming one coordinator whose
 * quotations sat either side of a colleague's rewrote the colleague's too, and the sheet would
 * have said the wrong person prepared it with no trace of the change.
 */
function rewriteUserEmailColumn_(tab, column, oldEmail, newEmail) {
  var sheet;
  try { sheet = getSheet_(tab); } catch (err) { return 0; }
  if (!sheet) return 0;
  var headers = getHeaders_(sheet, tab);
  var col = headers.indexOf(column);
  var lastRow = sheet.getLastRow();
  if (col === -1 || lastRow < 2) return 0;

  var range = sheet.getRange(2, col + 1, lastRow - 1, 1);
  var values = range.getValues();
  var changed = 0;
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toLowerCase() !== oldEmail) continue;
    values[i][0] = newEmail;
    changed++;
  }
  if (!changed) return 0;

  range.setValues(values);
  invalidateTable_(tab);
  return changed;
}

/** The user being renamed, and the complaints that stop it before anything is written. */
function userEmailChangePlan_(input) {
  var userId = String((input && input.userId) || '').trim();
  var newEmail = String((input && input.newEmail) || '').trim().toLowerCase();

  if (!userId) throw new Error('Which user? None was named.');
  if (!newEmail || newEmail.indexOf('@') === -1) {
    throw new Error('A valid address is required. It need not be a real mailbox — nothing is ' +
      'ever sent to it — but it has to be in the shape of one.');
  }

  var users = readTable_('Users');
  var target = users.filter(function (u) { return String(u.id) === userId; })[0];
  if (!target) throw new Error('That user is not on the list.');

  var oldEmail = String(target.email || '').trim().toLowerCase();
  if (!oldEmail) throw new Error('That user has no address to change.');
  if (oldEmail === newEmail) {
    throw new Error('That is already their address. Nothing to change.');
  }

  var clash = users.filter(function (u) {
    return String(u.id) !== userId && String(u.email).trim().toLowerCase() === newEmail;
  })[0];
  if (clash) {
    throw new Error(newEmail + ' already belongs to ' + (clash.name || 'another user') +
      '. Two people cannot share one address — it is what tells their work apart.');
  }

  return { user: target, oldEmail: oldEmail, newEmail: newEmail };
}

/**
 * What the rename would touch, changing nothing.
 *
 * Reported per tab rather than as one total, because the number that matters to somebody about
 * to press the button is not "412 cells" but which parts of their business are involved.
 */
function previewUserEmailChange(input) {
  var actor = getCurrentUser();
  requireRole_(actor, USER_EMAIL_ROLES);
  var plan = userEmailChangePlan_(input);

  var tabs = {};
  var total = 0;
  userIdentityColumns_().forEach(function (spec) {
    var rows = userEmailMatches_(spec.tab, spec.column, plan.oldEmail);
    if (!rows.length) return;
    if (!tabs[spec.tab]) tabs[spec.tab] = { tab: spec.tab, columns: [], rows: 0 };
    tabs[spec.tab].columns.push(spec.column);
    tabs[spec.tab].rows += rows.length;
    total += rows.length;
  });

  var where = Object.keys(tabs).map(function (t) { return tabs[t]; })
    .sort(function (a, b) { return b.rows - a.rows; });

  return {
    userId: String(plan.user.id),
    name: String(plan.user.name || ''),
    username: String(plan.user.username || ''),
    oldEmail: plan.oldEmail,
    newEmail: plan.newEmail,
    total: total,
    where: where,
    // Said here rather than only in the code, because whoever presses the button is the one
    // who should know the log moves with the work.
    notes: ['Their sessions end, so they sign in again — with the same username and password.',
            'The audit log is rewritten too, so past entries still name them.',
            'Nothing is ever sent to this address; it is how the records know who they are.']
  };
}

/**
 * Does it, under the lock.
 *
 * The Users row goes last. If anything fails partway, the row still holds the old address,
 * which is the state the preview describes and the rename can simply be run again — whereas a
 * row moved first with the history half-moved is a person whose work is split across two names.
 */
function changeUserEmail(input) {
  var actor = getCurrentUser();
  requireRole_(actor, USER_EMAIL_ROLES);
  var plan = userEmailChangePlan_(input);

  var lock = acquireLock_(20000, 'renaming a user');
  try {
    var changed = [];
    var total = 0;
    userIdentityColumns_().forEach(function (spec) {
      if (spec.tab === 'Users' && spec.column === 'email') return;   // last, below
      var n = rewriteUserEmailColumn_(spec.tab, spec.column, plan.oldEmail, plan.newEmail);
      if (!n) return;
      total += n;
      changed.push(spec.tab + '.' + spec.column + ' (' + n + ')');
    });

    total += rewriteUserEmailColumn_('Users', 'email', plan.oldEmail, plan.newEmail);

    // Sessions carry the address and the cache carries the user built from it, so a live
    // session would go on asking for a row that no longer answers to that name. Ending them is
    // both the correct thing and the cheap one: they sign in again, unchanged.
    forgetSessionsFor_(plan.oldEmail);
    forgetSessionsFor_(plan.newEmail);

    audit_('RENAME', 'Users', String(plan.user.id), 'email', plan.oldEmail, plan.newEmail,
      'Address changed by ' + actor.email + ' across ' + total + ' cells: ' +
      changed.join(', '));

    return {
      name: String(plan.user.name || ''),
      oldEmail: plan.oldEmail,
      newEmail: plan.newEmail,
      total: total,
      changed: changed
    };
  } finally {
    lock.releaseLock();
  }
}
