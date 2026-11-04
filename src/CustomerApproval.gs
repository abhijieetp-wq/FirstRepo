/**
 * New customers, approved by one person.
 *
 * PIE's operations are watched by one person, and a new customer is theirs to accept. Nothing
 * waits on it: a customer added this morning can be quoted this morning, and carries "Pending
 * approval" until the approver says yes or no. Yes stamps who and when. No deactivates the
 * customer (the soft delete deactivateCustomer uses), so it drops out of every picker, while
 * anything already raised against it still resolves.
 *
 * Who approves is a setting (Settings → Users → New customer approvals), never a name in the
 * code. With nobody chosen, Management and ERP Admin can decide, so nothing is left waiting
 * on a person who was never named.
 *
 * How the approver hears of it:
 *   - an e-mail through the ERP's mailbox (Settings → Email): one for a customer added by
 *     hand, and ONE for a bulk upload listing every customer it added, with a link to that
 *     batch in the ERP, where each has a tick box. A mail client will not run tick boxes
 *     inside an e-mail (Gmail and Outlook remove them), so the ticking happens in the ERP.
 *   - a panel on their dashboard and on Customers, with the same tick boxes.
 * Management and ERP Admin see the same list on their dashboard, as a notice only.
 *
 * Whoever added a customer that is rejected is told on their own dashboard, with the reason,
 * until they dismiss it. Not by e-mail: PIE's people have no mailboxes of their own.
 *
 * The e-mail is a courtesy, never a condition: if no mailbox is connected the customer is
 * still saved and the dashboard still asks.
 */

var CUSTOMER_APPROVAL_PROPS = {
  APPROVER: 'CUSTOMER_APPROVER',          // the approver's address in Users: who they are
  MAIL_TO: 'CUSTOMER_APPROVER_MAIL'       // where the e-mail goes, when that is not a mailbox
};

var CUSTOMER_APPROVAL = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected' };

/** The chosen approver, as a user, or null when nobody is chosen or they have left. */
function customerApprover_() {
  var email = String(PropertiesService.getScriptProperties()
    .getProperty(CUSTOMER_APPROVAL_PROPS.APPROVER) || '').trim().toLowerCase();
  if (!email) return null;
  var u = readTable_('Users').filter(function (x) {
    return String(x.email || '').trim().toLowerCase() === email && String(x.active).toUpperCase() !== 'FALSE';
  })[0];
  if (!u) return null;
  var mail = String(PropertiesService.getScriptProperties()
    .getProperty(CUSTOMER_APPROVAL_PROPS.MAIL_TO) || '').trim();
  // Their ERP ID only when it is a mailbox; a made-up one (Settings.gs, ERP_ID_DOMAIN) is not.
  return { email: String(u.email), name: String(u.name || u.email), role: String(u.role || ''),
    mailTo: mail || (isMailbox_(u.email) ? String(u.email) : '') };
}

/** Whether this person decides on new customers: the approver, or with none chosen, Management. */
function canDecideCustomers_(user, approver) {
  if (!user) return false;
  if (approver) return String(user.email || '').trim().toLowerCase() === approver.email.toLowerCase();
  return [ROLES.MANAGEMENT, ROLES.ERP_ADMIN].indexOf(String(user.role)) !== -1;
}

/** Whether this person sees the waiting list at all: whoever decides, and Management. */
function seesCustomerApprovals_(user, approver) {
  return canDecideCustomers_(user, approver) ||
    [ROLES.MANAGEMENT, ROLES.ERP_ADMIN].indexOf(String(user && user.role)) !== -1;
}

/**
 * Stamps a customer about to be created. The approver's own additions need no second look;
 * everybody else's wait. `batch` groups what one save or one upload added, so the e-mail can
 * open exactly those.
 */
function stampNewCustomer_(record, user, approver, batch) {
  if (canDecideCustomers_(user, approver)) {
    record.approvalStatus = CUSTOMER_APPROVAL.APPROVED;
    record.approvedBy = user.email;
    record.approvedAt = nowIso_();
    record.approvalNote = 'Added by the approver';
  } else {
    record.approvalStatus = CUSTOMER_APPROVAL.PENDING;
  }
  record.approvalBatch = batch;
  return record;
}

/** A blank status is a customer from before approvals existed, and counts as approved. */
function customerPending_(c) {
  return String(c.approvalStatus || '') === CUSTOMER_APPROVAL.PENDING && String(c.active).toUpperCase() !== 'FALSE';
}

/** The town a customer is in, from their default address. */
function customerCities_() {
  var out = {};
  readTable_('CustomerAddresses').forEach(function (a) {
    if (String(a.active).toUpperCase() === 'FALSE') return;
    var key = String(a.customerId);
    var isDefault = String(a.isDefault).toUpperCase() === 'TRUE';
    if (!out[key] || isDefault) out[key] = String(a.city || '');
  });
  return out;
}

function customerApprovalRow_(c, cities, names) {
  return {
    id: String(c.id), customerCode: String(c.customerCode || ''), name: String(c.name || ''),
    gstin: String(c.gstin || ''), industry: String(c.industry || ''),
    place: cities[String(c.id)] || String(c.territory || ''),
    createdAt: String(c.createdAt || '').slice(0, 10), createdBy: String(c.createdBy || ''),
    createdByName: personLine_(c.createdBy, names), batch: String(c.approvalBatch || '')
  };
}

/**
 * The customers waiting, for the dashboard and Customers.
 *
 * Anybody may ask; somebody who does not see approvals gets { visible: false } rather than an
 * error, because every screen that draws the panel asks whoever is signed in.
 */
function listCustomerApprovals(options) {
  var user = getCurrentUser();
  var approver = customerApprover_();
  if (!seesCustomerApprovals_(user, approver)) return { visible: false };
  return customerApprovalsFor_(user, approver, (options && options.batch) || '');
}

function customerApprovalsFor_(user, approver, batch) {
  var cities = customerCities_();
  var names = userNameMap_();
  var waiting = readTable_('Customers').filter(customerPending_)
    .sort(function (a, b) {
      return String(b.createdAt || '').localeCompare(String(a.createdAt || '')) ||
        String(a.customerCode || '').localeCompare(String(b.customerCode || ''));
    })
    .map(function (c) { return customerApprovalRow_(c, cities, names); });
  var inBatch = batch ? waiting.filter(function (r) { return r.batch === batch; }) : [];
  return {
    visible: true,
    canDecide: canDecideCustomers_(user, approver),
    approver: approver ? { email: approver.email, name: approver.name } : null,
    waiting: waiting,
    count: waiting.length,
    batch: batch ? { id: batch, count: inBatch.length } : null
  };
}

/**
 * The approver's decision on some of the waiting customers.
 *
 * @param input { ids: [...], outcome: 'Approved' | 'Rejected', note }
 * Only customers still waiting are touched; one decided in another tab a moment ago is left
 * as it was and counted as skipped, rather than flipped the other way.
 */
function decideCustomers(input) {
  var user = getCurrentUser();
  var approver = customerApprover_();
  if (!canDecideCustomers_(user, approver)) {
    throw new Error(approver ? 'New customers are approved by ' + approver.name + '.'
      : 'Only Management can approve new customers.');
  }
  var o = input || {};
  var outcome = String(o.outcome || '');
  if (outcome !== CUSTOMER_APPROVAL.APPROVED && outcome !== CUSTOMER_APPROVAL.REJECTED) {
    throw new Error('Approve or reject: nothing else.');
  }
  var ids = (o.ids || []).map(String).filter(Boolean);
  if (!ids.length) throw new Error('Tick at least one customer first.');
  var note = String(o.note || '').trim();

  var byId = {};
  readTable_('Customers').forEach(function (c) { byId[String(c.id)] = c; });
  var done = 0;
  var skipped = 0;
  var creators = {};
  var names = userNameMap_();
  var at = nowIso_();
  for (var id of ids) {
    var c = byId[id];
    if (!c || !customerPending_(c)) { skipped++; continue; }
    var by = String(c.createdBy || '').trim().toLowerCase();
    if (outcome === CUSTOMER_APPROVAL.REJECTED && by && by !== String(user.email).trim().toLowerCase()) {
      creators[personLine_(c.createdBy, names)] = true;
    }
    var patch = { approvalStatus: outcome, approvedBy: user.email, approvedAt: at, approvalNote: note };
    if (outcome === CUSTOMER_APPROVAL.REJECTED) patch.active = 'FALSE';
    updateRowById_('Customers', 'id', id, patch,
      (outcome === CUSTOMER_APPROVAL.APPROVED ? 'New customer approved by ' : 'New customer rejected by ') +
      user.email + (note ? ': ' + note : ''));
    done++;
  }
  var out = customerApprovalsFor_(user, approver, String(o.batch || ''));
  out.decided = done;
  out.skipped = skipped;
  out.outcome = outcome;
  // Who will see the rejection on their dashboard, for the message after it.
  out.creators = Object.keys(creators).sort();
  return out;
}

// ------------------------------------------------------------- the rejection, on the desk

/**
 * Customers this person added that were rejected and they have not yet dismissed, for their
 * dashboard: what, who rejected it, when, and why. One they rejected themselves is not news.
 */
function rejectedCustomerNotices_(user) {
  var me = String(user.email || '').trim().toLowerCase();
  var names = userNameMap_();
  return readTable_('Customers').filter(function (c) {
    return String(c.approvalStatus || '') === CUSTOMER_APPROVAL.REJECTED && !String(c.rejectionSeenAt || '') &&
      String(c.createdBy || '').trim().toLowerCase() === me && String(c.approvedBy || '').trim().toLowerCase() !== me;
  }).sort(function (a, b) { return String(b.approvedAt || '').localeCompare(String(a.approvedAt || '')); })
    .map(function (c) {
      return { id: String(c.id), customerCode: String(c.customerCode || ''), name: String(c.name || ''),
        by: personLine_(c.approvedBy, names), at: String(c.approvedAt || '').slice(0, 10), note: String(c.approvalNote || '') };
    });
}

/** "Got it": the notice leaves this person's dashboard. Only their own; the rejection stays. */
function dismissRejectedCustomers(ids) {
  var user = getCurrentUser();
  var mine = {};
  rejectedCustomerNotices_(user).forEach(function (n) { mine[n.id] = true; });
  var at = nowIso_();
  for (var id of (ids || []).map(String)) {
    if (!mine[id]) continue;
    updateRowById_('Customers', 'id', id, { rejectionSeenAt: at }, 'Rejection seen by ' + user.email);
  }
  return rejectedCustomerNotices_(user);
}

// ---------------------------------------------------------------------------------- e-mail

/** Where the ERP lives, for the link in the e-mail; blank when it cannot tell. */
function customerApprovalLink_(batch) {
  var base = '';
  try { base = String(ScriptApp.getService().getUrl() || ''); } catch (err) { base = ''; }
  if (!/^https?:\/\//i.test(base) || /\/exec$/.test(base)) return '';
  return base.replace(/\/+$/, '') + '/customers?approve=' + encodeURIComponent(batch);
}

function customerMailEscape_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The e-mail itself, built apart from sending so a test can read it. One message whatever
 * the number of customers: a bulk upload of forty is one e-mail listing forty.
 */
function customerApprovalMail_(records, user, approver, how, batch) {
  var names = userNameMap_();
  var who = personLine_(user.email, names) || user.email;
  var n = records.length;
  var appName = 'ERP';
  try { appName = getCompanyProfile().appName || appName; } catch (err) { /* pre-setup */ }
  var link = customerApprovalLink_(batch);
  var subject = n === 1
    ? 'New customer to approve: ' + records[0].name + (records[0].customerCode ? ' (' + records[0].customerCode + ')' : '')
    : n + ' new customers to approve, from ' + (how === 'upload' ? 'a bulk upload' : 'one save');
  var lead = who + ' added ' + (n === 1 ? 'a new customer' : n + ' new customers') + ' to ' + appName +
    (how === 'upload' ? ' with a bulk upload' : '') + ' on ' + pdDay_(todayIso_()) + '. ' +
    (n === 1 ? 'It can' : 'They can') + ' be used already, and show' + (n === 1 ? 's' : '') +
    ' "Pending approval" until you decide.';
  var line = function (r) {
    return [r.customerCode, r.name, r.gstin ? 'GSTIN ' + r.gstin : 'no GSTIN', r.place].filter(Boolean).join('  ·  ');
  };
  var body = 'Dear ' + approver.name + ',\n\n' + lead + '\n\n' +
    records.map(function (r, i) { return '  ' + (i + 1) + '. ' + line(r); }).join('\n') + '\n\n' +
    (link ? (n === 1 ? 'Approve or reject it here:\n' : 'Tick the ones to approve or reject here:\n') + link + '\n'
      : 'Open ' + appName + ', go to Customers, and tick the ones to approve or reject.\n') +
    '\n' + appName + '\n';

  var cell = 'padding:8px 10px;border-bottom:1px solid #e5e7eb;font:14px Arial,sans-serif;color:#111827;vertical-align:top;';
  var head = 'padding:8px 10px;border-bottom:2px solid #d1d5db;font:600 12px Arial,sans-serif;color:#4b5563;text-align:left;';
  var html = '<div style="font:14px Arial,sans-serif;color:#111827;max-width:680px;">' +
    '<p>Dear ' + customerMailEscape_(approver.name) + ',</p><p>' + customerMailEscape_(lead) + '</p>' +
    '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:12px 0 18px;">' +
    '<tr><th style="' + head + '">#</th><th style="' + head + '">Code</th><th style="' + head + '">Customer</th>' +
    '<th style="' + head + '">GSTIN</th><th style="' + head + '">Place</th></tr>' +
    records.map(function (r, i) {
      return '<tr><td style="' + cell + 'color:#6b7280;">' + (i + 1) + '</td><td style="' + cell + 'font-family:monospace;">' +
        customerMailEscape_(r.customerCode) + '</td><td style="' + cell + '"><b>' + customerMailEscape_(r.name) + '</b>' +
        (r.industry ? '<br><span style="color:#6b7280;font-size:12px;">' + customerMailEscape_(r.industry) + '</span>' : '') +
        '</td><td style="' + cell + 'font-family:monospace;">' + (r.gstin ? customerMailEscape_(r.gstin) : '<span style="color:#b45309;">none</span>') +
        '</td><td style="' + cell + '">' + customerMailEscape_(r.place) + '</td></tr>';
    }).join('') + '</table>' +
    (link
      ? '<p><a href="' + customerMailEscape_(link) + '" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;' +
        'padding:11px 18px;border-radius:6px;font:600 14px Arial,sans-serif;">' +
        (n === 1 ? 'Approve or reject' : 'Tick whom to approve or reject') + '</a></p>' +
        '<p style="color:#6b7280;font-size:12px;">The link opens ' + (n === 1 ? 'this customer' : 'these ' + n + ' customers') +
        ' in ' + customerMailEscape_(appName) + ', each with a tick box.</p>'
      : '<p>Open ' + customerMailEscape_(appName) + ', go to Customers, and tick the ones to approve or reject.</p>') +
    '<p style="color:#6b7280;">' + customerMailEscape_(appName) + '</p></div>';

  return { to: approver.mailTo, subject: subject, body: body, htmlBody: html, name: appName };
}

/**
 * Tells the approver about what was just added. Never throws: the customers are saved
 * whatever the mailbox says, and what happened is returned for the screen to say.
 *
 * @return { emailed: address | '', reason: why not, '' when it went }
 */
function notifyNewCustomers_(records, user, approver, how, batch) {
  var pending = records.filter(function (r) { return r.approvalStatus === CUSTOMER_APPROVAL.PENDING; });
  if (!pending.length) return { emailed: '', reason: '' };
  if (!approver) return { emailed: '', reason: 'No approver is chosen yet (Settings → Users), so Management decide on the dashboard.' };
  if (!approver.mailTo) {
    return { emailed: '', reason: approver.name + ' has no e-mail address set (Settings → Users → New customer approvals), so it waits on their dashboard.' };
  }
  var cities = customerCities_();
  var names = userNameMap_();
  var rows = pending.map(function (r) { return customerApprovalRow_(r, cities, names); });
  try {
    MailApp.sendEmail(customerApprovalMail_(rows, user, approver, how, batch));
    return { emailed: approver.mailTo, reason: '' };
  } catch (err) {
    var why = String((err && err.message) || err);
    audit_('Notify', 'Customers', batch, 'approvalEmail', '', '', 'Approval e-mail not sent: ' + why);
    return { emailed: '', reason: why };
  }
}

// -------------------------------------------------------------------------------- settings

/**
 * Chooses the approver. `email` is their address in Users; `mailTo` is where the e-mail goes
 * when that address is not a mailbox anybody reads (a Users address need not be one). Blank
 * clears the choice and Management decide.
 */
function saveCustomerApprover(input) {
  var user = getCurrentUser();
  requireRole_(user, SETTINGS_ROLES);
  var o = input || {};
  var email = String(o.email || '').trim();
  var mailTo = String(o.mailTo || '').trim();
  var props = PropertiesService.getScriptProperties();
  var before = String(props.getProperty(CUSTOMER_APPROVAL_PROPS.APPROVER) || '');
  if (!email) {
    props.deleteProperty(CUSTOMER_APPROVAL_PROPS.APPROVER);
    props.deleteProperty(CUSTOMER_APPROVAL_PROPS.MAIL_TO);
  } else {
    var u = readTable_('Users').filter(function (x) {
      return String(x.email || '').trim().toLowerCase() === email.toLowerCase();
    })[0];
    if (!u) throw new Error('There is nobody with that address in Users.');
    if (String(u.active).toUpperCase() === 'FALSE') throw new Error(String(u.name || email) + ' is not an active user.');
    if (mailTo && !isMailbox_(mailTo)) throw new Error('That does not look like an e-mail address anybody reads: ' + mailTo);
    props.setProperty(CUSTOMER_APPROVAL_PROPS.APPROVER, String(u.email));
    if (mailTo) props.setProperty(CUSTOMER_APPROVAL_PROPS.MAIL_TO, mailTo);
    else props.deleteProperty(CUSTOMER_APPROVAL_PROPS.MAIL_TO);
    email = String(u.email);
  }
  audit_('Update', 'ScriptProperties', 'CustomerApprover', 'approver', before, email,
    'New customer approver ' + (email ? 'set' : 'cleared') + ' by ' + user.email);
  return customerApprovalSettings_();
}

function customerApprovalSettings_() {
  var props = PropertiesService.getScriptProperties();
  return {
    approver: String(props.getProperty(CUSTOMER_APPROVAL_PROPS.APPROVER) || ''),
    mailTo: String(props.getProperty(CUSTOMER_APPROVAL_PROPS.MAIL_TO) || '')
  };
}

/** A renamed user who approves keeps approving (UserEmail.gs). */
function renameCustomerApprover_(oldEmail, newEmail) {
  var props = PropertiesService.getScriptProperties();
  var now = String(props.getProperty(CUSTOMER_APPROVAL_PROPS.APPROVER) || '');
  if (now && now.trim().toLowerCase() === String(oldEmail || '').trim().toLowerCase()) {
    props.setProperty(CUSTOMER_APPROVAL_PROPS.APPROVER, String(newEmail));
  }
}
