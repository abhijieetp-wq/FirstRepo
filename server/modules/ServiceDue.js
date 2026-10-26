/**
 * Converted from src/ServiceDue.gs by migration/to-async.js.
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
 * Service due calls — PIE's weekly round of the machines it has sold.
 *
 * Every week ELGi's Service Due Report (SDR) lists the machines in PIE's territory that are
 * due for service or parts: four or five hundred of them. The spares coordinators ring each
 * customer and ask whether they need service or spares. Whatever the answer, a spares
 * quotation goes to them by e-mail, and is followed up — once, or five or six times — until
 * the coordinator can tell whether the customer will buy. Then it ends one of three ways:
 *
 *   PO received   the customer ordered;
 *   Not closed    the coordinator could not close it — and says why;
 *   PO rejected   the PO did not go through — and says why.
 *
 * The two reasons are the point of the exercise for management, so they are compulsory, they
 * stand out on the screen, and they are highlighted in the Excel report.
 *
 * One row per machine (ServiceDueCalls), because the report is per machine and a spares
 * quotation is for one machine — its fab number and model print at the head of the annexure.
 * A customer with seven machines is seven rows; the screen offers to record one call or
 * follow-up against all of them at once.
 *
 * A machine stays one piece of work across weeks. Next week's report lists most of the same
 * machines again; uploading it refreshes what is due on the rows still open and adds the new
 * ones, rather than starting the round again. A machine closed in the last 30 days is not put
 * back on the list; one closed earlier comes back as new work, showing how it ended last time.
 */

/** Who works the list: the people who raise spares quotations. */
var SERVICE_DUE_EDITORS = [ROLES.SALES_COORDINATOR, ROLES.SALES_ENGINEER, ROLES.MANAGEMENT,
  ROLES.ERP_ADMIN];

/** How the customer answered the call. */
var SERVICE_DUE_RESPONSES = ['Needs spares', 'Needs service', 'Needs service and spares',
  'Not now', 'Not reachable', 'Wrong number'];

/** How a follow-up was made. */
var SERVICE_DUE_MODES = ['Call', 'E-mail', 'WhatsApp', 'Visit'];

/** The three ways a call ends. */
var SERVICE_DUE_OUTCOMES = ['PO received', 'Not closed', 'PO rejected'];

/** Where a call stands, in the order it moves. Derived, never typed (serviceDueStatus_). */
var SERVICE_DUE_STATUSES = ['To call', 'Called', 'Quotation prepared', 'Quotation sent',
  'Following up', 'PO received', 'Not closed', 'PO rejected'];

/** PIE's own practice: five or six follow-ups is when to decide. */
var SERVICE_DUE_FOLLOW_UP_LIMIT = 6;

/** A machine closed this recently is not put back on the list by next week's report. */
var SERVICE_DUE_RECLOSE_DAYS = 30;

/** The parts the report gives a due date for, in its order, and what to call them. */
var SERVICE_DUE_PARTS = [['AF', 'AF'], ['OF', 'OF'], ['OIL', 'Oil'], ['AOS', 'AOS'],
  ['VALVEKIT', 'Valve kit'], ['RGT', 'RGT'], ['PF', 'PF'], ['FF', 'FF'], ['CF', 'CF']];

// ------------------------------------------------------------------ reading the list

/**
 * Everything the screen needs in one call: the weekly lists, the calls the filter asks for
 * with where each stands, the coordinators, and the choices the forms offer.
 *
 * filter.listId  one week's list, or '' for every week
 * filter.view    'open' (default), 'closed' or 'all'
 */
async function getServiceDueScreen(filter) {
  var user = requireServiceDueUser_();
  var f = filter || {};
  var view = ['open', 'closed', 'all'].indexOf(f.view) !== -1 ? f.view : 'open';
  var listId = String(f.listId || '');

  var lists = (await readTable_('ServiceDueLists')).map(stripRow_)
    .sort(function (a, b) { return String(b.listDate).localeCompare(String(a.listDate)); });

  var calls = (await readTable_('ServiceDueCalls')).filter(function (c) {
    if (listId && serviceDueListIds_(c).indexOf(listId) === -1) return false;
    var closed = !!String(c.outcome || '');
    if (view === 'open' && closed) return false;
    if (view === 'closed' && !closed) return false;
    return true;
  });

  var rows = await serviceDueRows_(calls);
  var people = await listPeople();
  return {
    lists: lists,
    calls: rows,
    coordinators: people.coordinators.concat(people.management),
    statuses: SERVICE_DUE_STATUSES,
    responses: SERVICE_DUE_RESPONSES,
    modes: SERVICE_DUE_MODES,
    followUpLimit: SERVICE_DUE_FOLLOW_UP_LIMIT,
    me: user.email,
    canEdit: SERVICE_DUE_EDITORS.indexOf(user.role) !== -1
  };
}

/** One call, with its follow-ups, the customer's contacts and the same customer's other machines. */
async function getServiceDueCall(callId) {
  requireServiceDueUser_();
  var call = await findRowById_('ServiceDueCalls', callId);
  if (!call) throw new Error('That call is no longer on the list.');

  var row = (await serviceDueRows_([call]))[0];
  row.followUps = (await readTable_('ServiceDueFollowUps'))
    .filter(function (u) { return String(u.callId) === String(callId); })
    .map(stripRow_)
    .sort(function (a, b) { return (Number(a.followUpNo) || 0) - (Number(b.followUpNo) || 0); });

  row.contacts = call.customerId ? (await readTable_('CustomerContacts'))
    .filter(function (c) {
      return String(c.customerId) === String(call.customerId) &&
        String(c.active).toUpperCase() !== 'FALSE';
    })
    .map(function (c) {
      return { id: String(c.id), name: String(c.name || ''), phone: String(c.phone || ''),
               email: String(c.email || ''), designation: String(c.designation || ''),
               isPrimary: String(c.isPrimary).toUpperCase() === 'TRUE' };
    }) : [];

  // The same customer's other machines still open on the list, so one call to them can be
  // recorded once rather than seven times.
  var key = serviceDueCustomerKey_(call);
  row.siblings = (await readTable_('ServiceDueCalls'))
    .filter(function (c) {
      return String(c.id) !== String(callId) && !String(c.outcome || '') &&
        serviceDueCustomerKey_(c) === key;
    })
    .map(function (c) {
      return { id: String(c.id), fabNo: String(c.fabNo || ''),
               productModel: String(c.productModel || ''), dueParts: String(c.dueParts || '') };
    });
  return row;
}

// ------------------------------------------------------------------ the weekly upload

/**
 * One week's Service Due Report, already read from the Excel file by the browser.
 *
 * input.listDate  the week the report is for (yyyy-MM-dd)
 * input.fileName  the file it came from, for the record
 * input.rows      one object per machine: fabNo, productModel, customerName, dealerName,
 *                 warrantyType, amcType, ... and dueDates { AF: 'yyyy-MM-dd', ... }
 */
async function importServiceDueList(input) {
  var user = requireServiceDueEditor_();
  var listDate = String(input && input.listDate || '').slice(0, 10) || todayIso_();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(listDate)) throw new Error('Pick the week the list is for.');
  var rows = (input && input.rows) || [];
  if (!rows.length) throw new Error('That file has no machines in it.');
  if (rows.length > 5000) throw new Error('That is ' + rows.length + ' rows — more than a weekly ' +
    'list. Check it is the Service Due Report.');

  var customers = await readTable_('Customers');
  var byName = {};
  customers.forEach(function (c) {
    var k = serviceDueNameKey_(c.name);
    if (k && !byName[k]) byName[k] = String(c.id);
    var lk = serviceDueNameKey_(c.legalName);
    if (lk && !byName[lk]) byName[lk] = String(c.id);
  });

  var existing = await readTable_('ServiceDueCalls');
  var openByFab = {};
  var lastClosedByFab = {};
  existing.forEach(function (c) {
    var fab = String(c.fabNo || '').trim().toUpperCase();
    if (!fab) return;
    if (!String(c.outcome || '')) { openByFab[fab] = c; return; }
    var was = lastClosedByFab[fab];
    if (!was || String(c.outcomeDate || '') > String(was.outcomeDate || '')) lastClosedByFab[fab] = c;
  });

  var listId = generateId_('SDL-');
  var now = nowIso_();
  var creates = [];
  var updates = [];
  var skipped = { dealer: 0, noFab: 0, duplicate: 0, recentlyClosed: 0 };
  var seen = {};
  var unmatched = {};

  rows.forEach(function (r) {
    var fab = String(r.fabNo || '').trim().toUpperCase();
    if (!fab) { skipped.noFab++; return; }
    if (seen[fab]) { skipped.duplicate++; return; }
    seen[fab] = true;
    // Machines the report still has registered to PIE itself — stock, demonstration units —
    // have nobody to ring.
    if (serviceDueIsDealer_(r.customerName, r.dealerName)) { skipped.dealer++; return; }

    var machine = serviceDueMachine_(r, listDate);
    var open = openByFab[fab];
    if (open) {
      var ids = serviceDueListIds_(open);
      if (ids.indexOf(listId) === -1) ids.push(listId);
      machine.id = String(open.id);
      machine.lastListId = listId;
      machine.lastListDate = listDate;
      machine.listIds = ids.join(',');
      machine.listedCount = (Number(open.listedCount) || 1) + 1;
      // A customer linked by hand stays linked; one found by name now is filled in.
      if (!String(open.customerId || '')) machine.customerId = byName[serviceDueNameKey_(r.customerName)] || '';
      machine.updatedAt = now;
      machine.updatedBy = user.email;
      updates.push(machine);
      return;
    }

    var closed = lastClosedByFab[fab];
    if (closed && String(closed.outcomeDate || '') &&
        daysBetween_(String(closed.outcomeDate), listDate) <= SERVICE_DUE_RECLOSE_DAYS) {
      skipped.recentlyClosed++;
      return;
    }

    var customerId = byName[serviceDueNameKey_(r.customerName)] || '';
    // Counted once however the report spells them, under the first spelling it uses.
    var nameKey = serviceDueNameKey_(r.customerName);
    if (!customerId && nameKey && !unmatched[nameKey]) unmatched[nameKey] = String(r.customerName || '').trim();
    machine.id = generateId_('SDC-');
    machine.firstListId = listId;
    machine.lastListId = listId;
    machine.listIds = listId;
    machine.firstListDate = listDate;
    machine.lastListDate = listDate;
    machine.listedCount = 1;
    machine.customerId = customerId;
    machine.ownerEmail = user.email;
    machine.followUpCount = 0;
    machine.previousOutcome = closed ? serviceDueOutcomeText_(closed) : '';
    machine.createdAt = now;
    machine.createdBy = user.email;
    machine.updatedAt = now;
    machine.updatedBy = user.email;
    creates.push(machine);
  });

  var skippedCount = skipped.dealer + skipped.noFab + skipped.duplicate + skipped.recentlyClosed;
  await appendRow_('ServiceDueLists', {
    id: listId,
    listNo: 'SDR-' + listDate,
    listDate: listDate,
    fileName: String(input.fileName || '').slice(0, 200),
    machineCount: rows.length,
    addedCount: creates.length,
    carriedCount: updates.length,
    skippedCount: skippedCount,
    notes: '',
    createdAt: now,
    createdBy: user.email
  }, 'Service due list uploaded');
  if (creates.length) await appendRows_('ServiceDueCalls', creates, 'Service due list uploaded');
  if (updates.length) await updateServiceDueRows_(updates);

  return {
    listId: listId,
    listDate: listDate,
    machines: rows.length,
    added: creates.length,
    carried: updates.length,
    skipped: skipped,
    unmatchedCustomers: Object.keys(unmatched).map(function (k) { return unmatched[k]; }).sort()
  };
}

/**
 * Writes the refreshed machine details onto the calls still open. Every row carries the same
 * fields. One statement on the server (server/queries/servicedue.js); one row at a time here.
 */
async function updateServiceDueRows_(rows) {
  for (var r of rows) {
    var patch = {};
    Object.keys(r).forEach(function (k) { if (k !== 'id') patch[k] = r[k]; });
    await updateRowById_('ServiceDueCalls', 'id', r.id, patch, 'Service due list refreshed');
  }
}

/** The machine's details off one report row, ready to store. */
function serviceDueMachine_(r, listDate) {
  var due = serviceDueParts_(r.dueDates || {}, listDate);
  var flag = function (v) { return /^(1|yes|true|y)$/i.test(String(v || '').trim()) ? 'TRUE' : 'FALSE'; };
  var day = function (v) { var d = String(v || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : ''; };
  var text = function (v, n) { return String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 200); };
  return {
    fabNo: text(r.fabNo, 40).toUpperCase(),
    productModel: text(r.productModel, 120),
    productGroup: text(r.productGroup, 60),
    sdrCustomerName: text(r.customerName, 200),
    warrantyType: text(r.warrantyType, 60),
    amcType: text(r.amcType, 40),
    category: text(r.category, 120),
    segment: text(r.segment, 120),
    callType: text(r.callType, 60),
    serviceEngineer: text(r.serviceEngineer, 120),
    lastServiceCall: text(r.lastServiceCall, 40),
    lastServiceComment: text(r.lastServiceComment, 300),
    commissionDate: day(r.commissionDate),
    installInvoiceDate: day(r.invoiceDate),
    hmrDate: day(r.hmrDate),
    totalHours: text(r.totalHours, 20),
    runningHoursPerDay: text(r.runningHoursPerDay, 20),
    dueParts: due.summary,
    dueDetail: due.detail,
    overdue: flag(r.overdue) === 'TRUE' || due.overdue ? 'TRUE' : 'FALSE',
    dueThisMonth: flag(r.dueThisMonth),
    dueNextMonth: flag(r.dueNextMonth)
  };
}

/**
 * Which parts are due, in words a coordinator can read down the phone: "Overdue: AF, OF, Oil
 * · This month: AOS · Next month: RGT", and every part's date for the detail view.
 */
function serviceDueParts_(dueDates, listDate) {
  var groups = { overdue: [], now: [], next: [] };
  var detail = [];
  var ym = function (d) { return String(d).slice(0, 7); };
  var nextMonth = (function () {
    var y = Number(listDate.slice(0, 4)), m = Number(listDate.slice(5, 7));
    m++; if (m > 12) { m = 1; y++; }
    return y + '-' + (m < 10 ? '0' : '') + m;
  })();
  SERVICE_DUE_PARTS.forEach(function (p) {
    var d = String(dueDates[p[0]] || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    detail.push(p[1] + ' ' + d);
    if (d < listDate) groups.overdue.push(p[1]);
    else if (ym(d) === ym(listDate)) groups.now.push(p[1]);
    else if (ym(d) === nextMonth) groups.next.push(p[1]);
  });
  var parts = [];
  if (groups.overdue.length) parts.push('Overdue: ' + groups.overdue.join(', '));
  if (groups.now.length) parts.push('This month: ' + groups.now.join(', '));
  if (groups.next.length) parts.push('Next month: ' + groups.next.join(', '));
  return { summary: parts.join(' · '), detail: detail.join(' | '), overdue: groups.overdue.length > 0 };
}

// ------------------------------------------------------------------ working a call

/**
 * The call itself, and the details around it: who it is with, which customer record it is,
 * whose call it is. alsoIds records the same call against the customer's other machines.
 */
async function saveServiceDueCall(input) {
  var user = requireServiceDueEditor_();
  var call = await findRowById_('ServiceDueCalls', input.id);
  if (!call) throw new Error('That call is no longer on the list.');

  var patch = { updatedAt: nowIso_(), updatedBy: user.email };
  if (input.customerId !== undefined) {
    var cid = String(input.customerId || '').trim();
    if (cid && !await findRowById_('Customers', cid)) throw new Error('That customer no longer exists.');
    patch.customerId = cid;
  }
  if (input.ownerEmail !== undefined) patch.ownerEmail = String(input.ownerEmail || '').trim();

  var logsCall = input.callDate !== undefined || input.callResponse !== undefined;
  if (logsCall) {
    var response = String(input.callResponse || '').trim();
    if (SERVICE_DUE_RESPONSES.indexOf(response) === -1) {
      throw new Error('Pick what the customer said.');
    }
    patch.callDate = String(input.callDate || todayIso_()).slice(0, 10);
    patch.callResponse = response;
    patch.callNotes = String(input.callNotes || '').trim();
    patch.contactId = String(input.contactId || '').trim();
    patch.contactName = String(input.contactName || '').trim();
  }

  var ids = [String(call.id)].concat(logsCall ? await serviceDueSiblings_(call, input.alsoIds) : []);
  for (var id of ids) {
    var p = Object.assign({}, patch);
    // The customer and the owner belong to this machine's row; only the call is shared.
    if (id !== String(call.id)) { delete p.customerId; delete p.ownerEmail; }
    await updateRowById_('ServiceDueCalls', 'id', id, p, logsCall ? 'Service due call logged' : 'Service due call updated');
  }
  return await getServiceDueCall(call.id);
}

/** Gives several calls to one coordinator, from the list's tick boxes. */
async function assignServiceDueCalls(callIds, ownerEmail) {
  var user = requireServiceDueEditor_();
  var to = String(ownerEmail || '').trim();
  if (!to) throw new Error('Pick who the calls are for.');
  var ids = (callIds || []).map(String);
  if (!ids.length) throw new Error('Tick the calls to hand over first.');
  var now = nowIso_();
  for (var id of ids) {
    await updateRowById_('ServiceDueCalls', 'id', id, { ownerEmail: to, updatedAt: now, updatedBy: user.email },
      'Service due calls assigned');
  }
  return { assigned: ids.length, ownerEmail: to };
}

/** One follow-up, numbered on from the last. */
async function addServiceDueFollowUp(input) {
  var user = requireServiceDueEditor_();
  var call = await findRowById_('ServiceDueCalls', input.callId);
  if (!call) throw new Error('That call is no longer on the list.');
  if (String(call.outcome || '')) throw new Error('This call is closed. Reopen it to follow up again.');
  var notes = String(input.notes || '').trim();
  if (!notes) throw new Error('Write what was said on the follow-up.');
  var mode = String(input.mode || 'Call').trim();
  if (SERVICE_DUE_MODES.indexOf(mode) === -1) throw new Error('Pick how the follow-up was made.');
  var date = String(input.followUpDate || todayIso_()).slice(0, 10);
  var next = String(input.nextFollowUpDate || '').slice(0, 10);
  if (next && next < date) throw new Error('The next follow-up cannot be before this one.');

  var ids = [String(call.id)].concat(await serviceDueSiblings_(call, input.alsoIds));
  var all = await readTable_('ServiceDueFollowUps');
  var now = nowIso_();
  for (var id of ids) {
    var count = all.filter(function (u) { return String(u.callId) === id; }).length;
    await appendRow_('ServiceDueFollowUps', {
      id: generateId_('SDF-'),
      callId: id,
      followUpNo: count + 1,
      followUpDate: date,
      mode: mode,
      contactName: String(input.contactName || '').trim(),
      notes: notes,
      response: String(input.response || '').trim(),
      nextFollowUpDate: next,
      createdAt: now,
      createdBy: user.email
    }, 'Service due follow-up ' + (count + 1));
    await updateRowById_('ServiceDueCalls', 'id', id, {
      followUpCount: count + 1, lastFollowUpDate: date, nextFollowUpDate: next,
      updatedAt: now, updatedBy: user.email
    }, 'Service due follow-up ' + (count + 1));
  }
  return await getServiceDueCall(call.id);
}

/**
 * How it ended. The two that are not a sale must say why: those reasons are what management
 * reads the report for.
 */
async function closeServiceDueCall(input) {
  var user = requireServiceDueEditor_();
  var call = await findRowById_('ServiceDueCalls', input.id);
  if (!call) throw new Error('That call is no longer on the list.');
  var outcome = String(input.outcome || '').trim();
  if (SERVICE_DUE_OUTCOMES.indexOf(outcome) === -1) {
    throw new Error('Pick how it ended: ' + SERVICE_DUE_OUTCOMES.join(', ') + '.');
  }
  var reason = String(input.reason || '').replace(/\s+/g, ' ').trim();
  if (outcome !== 'PO received' && (reason.length < 5 || !/[A-Za-z]{2,}/.test(reason))) {
    throw new Error(outcome === 'Not closed'
      ? 'Write why this customer could not be closed — that is what the report is read for.'
      : 'Write why the PO was rejected — that is what the report is read for.');
  }
  var patch = {
    outcome: outcome,
    outcomeDate: String(input.outcomeDate || todayIso_()).slice(0, 10),
    poNo: outcome === 'Not closed' ? '' : String(input.poNo || '').trim(),
    poDate: outcome === 'Not closed' ? '' : String(input.poDate || '').slice(0, 10),
    poValue: outcome === 'Not closed' || input.poValue === '' || input.poValue === undefined
      ? '' : Number(input.poValue) || 0,
    notClosedReason: outcome === 'Not closed' ? reason : '',
    poRejectedReason: outcome === 'PO rejected' ? reason : '',
    nextFollowUpDate: '',
    updatedAt: nowIso_(),
    updatedBy: user.email
  };
  if (outcome === 'PO received' && !patch.poNo) throw new Error('Enter the PO number.');

  var ids = [String(call.id)].concat(await serviceDueSiblings_(call, input.alsoIds));
  for (var id of ids) {
    await updateRowById_('ServiceDueCalls', 'id', id, patch, 'Service due call closed: ' + outcome);
  }
  return await getServiceDueCall(call.id);
}

/** Back to open, for a call closed by mistake. The reasons it carried are cleared. */
async function reopenServiceDueCall(callId) {
  var user = requireServiceDueEditor_();
  var call = await findRowById_('ServiceDueCalls', callId);
  if (!call) throw new Error('That call is no longer on the list.');
  await updateRowById_('ServiceDueCalls', 'id', callId, {
    outcome: '', outcomeDate: '', poNo: '', poDate: '', poValue: '', notClosedReason: '',
    poRejectedReason: '', updatedAt: nowIso_(), updatedBy: user.email
  }, 'Service due call reopened');
  return await getServiceDueCall(callId);
}

/**
 * The spares quotation that goes to the customer after the call. Every spares offer starts
 * from an enquiry, so this logs one — the machine's fab number and model, what is due — and
 * raises the quotation from it, then opens it like any other.
 */
async function prepareServiceDueQuotation(callId) {
  requireServiceDueEditor_();
  var call = await findRowById_('ServiceDueCalls', callId);
  if (!call) throw new Error('That call is no longer on the list.');
  if (String(call.quotationId || '')) return { quotationId: String(call.quotationId), existing: true };
  if (!String(call.customerId || '')) {
    throw new Error(String(call.sdrCustomerName || 'This customer') + ' is not linked to a ' +
      'customer record yet. Pick them under Customer first — add them in Customers if they are new.');
  }
  var customer = await findRowById_('Customers', call.customerId);
  var enquiry = await saveSpareEnquiry({
    customerId: call.customerId,
    customerName: customer ? customer.name : call.sdrCustomerName,
    contactId: call.contactId || '',
    contactName: call.contactName || '',
    productModel: call.productModel,
    serialNo: call.fabNo,
    requirementText: 'Service due list ' + ddmmyyyy_(call.lastListDate || call.firstListDate) +
      (call.dueParts ? ' — ' + call.dueParts : '') +
      (call.callResponse ? '. Customer: ' + call.callResponse : ''),
    urgency: 'Normal',
    source: 'Service Due List',
    ownerEmail: call.ownerEmail || ''
  });
  var quote = await createQuotationFromEnquiry(enquiry.id);
  var quotationId = String(quote && quote.id || '');
  await updateRowById_('ServiceDueCalls', 'id', callId, {
    spareEnquiryId: enquiry.id, quotationId: quotationId, updatedAt: nowIso_(),
    updatedBy: getCurrentUser().email
  }, 'Service due quotation raised');
  return { quotationId: quotationId, quoteNo: quote ? quote.quoteNo : '', existing: false };
}

/** A quotation already made for this machine, tied to the call by its number. */
async function linkServiceDueQuotation(callId, quoteNo) {
  var user = requireServiceDueEditor_();
  var call = await findRowById_('ServiceDueCalls', callId);
  if (!call) throw new Error('That call is no longer on the list.');
  var no = String(quoteNo || '').trim().toUpperCase();
  if (!no) throw new Error('Type the quotation number.');
  var matches = (await readTable_('Quotations')).filter(function (q) {
    return String(q.quoteNo || '').trim().toUpperCase() === no;
  }).sort(function (a, b) {
    return (Number(String(b.revision).replace(/\D/g, '')) || 0) -
      (Number(String(a.revision).replace(/\D/g, '')) || 0);
  });
  if (!matches.length) throw new Error('No quotation numbered ' + quoteNo + '.');
  var q = matches[0];
  if (String(call.customerId || '') && String(q.customerId) !== String(call.customerId)) {
    throw new Error(q.quoteNo + ' is for a different customer.');
  }
  await updateRowById_('ServiceDueCalls', 'id', callId, {
    quotationId: String(q.id), spareEnquiryId: String(q.spareEnquiryId || ''),
    customerId: String(call.customerId || q.customerId), updatedAt: nowIso_(), updatedBy: user.email
  }, 'Service due quotation linked');
  return await getServiceDueCall(callId);
}

// ------------------------------------------------------------------ the report

/**
 * Every call the filter covers, laid out for Excel: one row per machine with the call, the
 * quotation, each follow-up and how it ended, and a summary by coordinator. The browser
 * writes the .xlsx, highlighting the two reasons.
 */
async function exportServiceDueReport(filter) {
  var screen = await getServiceDueScreen(filter);
  var calls = screen.calls;
  var f = filter || {};
  if (f.status) calls = calls.filter(function (c) { return c.status === f.status; });
  if (f.ownerEmail) calls = calls.filter(function (c) { return c.ownerEmail === f.ownerEmail; });

  var ids = {};
  calls.forEach(function (c) { ids[c.id] = true; });
  var followUps = {};
  (await readTable_('ServiceDueFollowUps')).forEach(function (u) {
    if (!ids[String(u.callId)]) return;
    (followUps[String(u.callId)] = followUps[String(u.callId)] || []).push(u);
  });
  var most = SERVICE_DUE_FOLLOW_UP_LIMIT;
  Object.keys(followUps).forEach(function (k) {
    followUps[k].sort(function (a, b) { return (Number(a.followUpNo) || 0) - (Number(b.followUpNo) || 0); });
    most = Math.max(most, followUps[k].length);
  });

  var headers = ['First listed', 'Last listed', 'Times listed', 'Fab No', 'Model', 'Customer (SDR)',
    'Customer', 'Warranty', 'AMC', 'Category', 'Due parts', 'Overdue', 'Coordinator',
    'Call date', 'Spoke to', 'Customer said', 'Call notes', 'Enquiry No', 'Quotation No',
    'Quotation date', 'Quotation value', 'Quotation status', 'Sent to customer', 'Follow-ups'];
  for (var n = 1; n <= most; n++) {
    headers.push('Follow-up ' + n + ' date', 'Follow-up ' + n + ' notes');
  }
  headers.push('Next follow-up', 'Status', 'Closed on', 'PO No', 'PO date', 'PO value',
    'Reason not closed', 'Reason PO rejected');

  var people = {};
  screen.coordinators.forEach(function (p) { people[p.email] = p.name; });
  var rows = calls.map(function (c) {
    var row = [c.firstListDate, c.lastListDate, Number(c.listedCount) || 1, c.fabNo, c.productModel,
      c.sdrCustomerName, c.customerName, c.warrantyType, c.amcType, c.category, c.dueParts,
      c.overdue === 'TRUE' ? 'Yes' : '', people[c.ownerEmail] || c.ownerEmail, c.callDate,
      c.contactName, c.callResponse, c.callNotes, c.enquiryNo, c.quoteNo, c.quoteDate,
      c.quoteValue === '' ? '' : Number(c.quoteValue) || 0, c.quoteStatus, c.sentDate,
      Number(c.followUpCount) || 0];
    var list = followUps[c.id] || [];
    for (var i = 0; i < most; i++) {
      var u = list[i];
      row.push(u ? String(u.followUpDate || '').slice(0, 10) : '',
        u ? [u.mode, u.notes, u.response].filter(Boolean).join(' — ') : '');
    }
    row.push(c.nextFollowUpDate, c.status, c.outcomeDate, c.poNo, c.poDate,
      c.poValue === '' ? '' : Number(c.poValue) || 0, c.notClosedReason, c.poRejectedReason);
    return row;
  });

  // How each coordinator's round is going.
  var summaryHeaders = ['Coordinator'].concat(SERVICE_DUE_STATUSES, ['Total', 'PO received of closed']);
  var byOwner = {};
  calls.forEach(function (c) {
    var k = c.ownerEmail || '';
    var s = byOwner[k] = byOwner[k] || {};
    s[c.status] = (s[c.status] || 0) + 1;
  });
  var summary = Object.keys(byOwner).sort().map(function (k) {
    var s = byOwner[k];
    var total = 0, closed = 0;
    var line = [people[k] || k || 'Nobody'];
    SERVICE_DUE_STATUSES.forEach(function (st) { line.push(s[st] || 0); total += s[st] || 0; });
    closed = (s['PO received'] || 0) + (s['Not closed'] || 0) + (s['PO rejected'] || 0);
    line.push(total, closed ? Math.round((s['PO received'] || 0) * 100 / closed) + '%' : '');
    return line;
  });

  return {
    generatedAt: nowIso_(),
    headers: headers,
    rows: rows,
    // Which columns the reasons are in, so the workbook can pick them out.
    reasonColumns: [headers.indexOf('Reason not closed'), headers.indexOf('Reason PO rejected')],
    statusColumn: headers.indexOf('Status'),
    summaryHeaders: summaryHeaders,
    summary: summary
  };
}

// ------------------------------------------------------------------ internals

function requireServiceDueUser_() {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_DUE_EDITORS);
  requireStream_(user, STREAM_SPARE, 'The service due list');
  return user;
}

function requireServiceDueEditor_() {
  return requireServiceDueUser_();
}

/**
 * The calls as the screen shows them: where each stands, its customer's name, and the
 * quotation's number, value and whether it has gone out.
 */
async function serviceDueRows_(calls) {
  if (!calls.length) return [];
  var customers = {};
  (await readTable_('Customers')).forEach(function (c) { customers[String(c.id)] = c; });
  var quoteIds = calls.map(function (c) { return String(c.quotationId || ''); }).filter(Boolean);
  var quotes = {};
  if (quoteIds.length) {
    (await findRowsByColumn_('Quotations', 'id', quoteIds)).forEach(function (q) { quotes[String(q.id)] = q; });
  }
  var enquiryIds = calls.map(function (c) { return String(c.spareEnquiryId || ''); }).filter(Boolean);
  var enquiries = {};
  if (enquiryIds.length) {
    (await findRowsByColumn_('SpareEnquiries', 'id', enquiryIds)).forEach(function (e) { enquiries[String(e.id)] = e; });
  }
  // An order raised from the quotation is a PO received, whether or not the call was closed.
  var orders = {};
  if (quoteIds.length) {
    (await findRowsByColumn_('SalesOrders', 'quotationId', quoteIds)).forEach(function (o) {
      orders[String(o.quotationId)] = o;
    });
  }

  return calls.map(function (c) {
    var row = stripRow_(c);
    var q = quotes[String(c.quotationId || '')] || null;
    var order = q ? orders[String(q.id)] || null : null;
    var customer = customers[String(c.customerId || '')];
    row.customerName = customer ? String(customer.name || '') : '';
    row.quoteNo = q ? String(q.quoteNo || '') + (q.revision && q.revision !== 'R0' ? ' ' + q.revision : '') : '';
    row.quoteDate = q ? String(q.date || '').slice(0, 10) : '';
    row.quoteValue = q ? (q.grand === '' || q.grand === undefined ? '' : Number(q.grand) || 0) : '';
    row.quoteStatus = q ? String(q.status || '') : '';
    row.sentDate = q ? String(q.submittedDate || q.emailSentDate || '').slice(0, 10) : '';
    row.enquiryNo = enquiries[String(c.spareEnquiryId || '')]
      ? String(enquiries[String(c.spareEnquiryId)].enquiryNo || '') : '';
    row.orderNo = order ? String(order.orderNo || '') : '';
    if (!row.outcome && order) {
      // Recorded on the quotation rather than here: shown as what it is.
      row.poNo = row.poNo || String(order.poNo || '');
      row.poDate = row.poDate || String(order.poDate || '').slice(0, 10);
    }
    row.status = serviceDueStatus_(c, q, order);
    row.followUpCount = Number(c.followUpCount) || 0;
    row.listedCount = Number(c.listedCount) || 1;
    return row;
  });
}

/** Where a call stands, from what has happened to it. */
function serviceDueStatus_(call, quote, order) {
  var outcome = String(call.outcome || '');
  if (outcome) return outcome;
  if (order || (quote && String(quote.status) === 'Won')) return 'PO received';
  var sent = quote && (quote.submittedDate || quote.emailSentDate ||
    ['Submitted', 'Negotiating'].indexOf(String(quote.status)) !== -1);
  if (sent && (Number(call.followUpCount) || 0) > 0) return 'Following up';
  if (sent) return 'Quotation sent';
  if (quote) return 'Quotation prepared';
  if (String(call.callDate || '')) return 'Called';
  return 'To call';
}

/** The weekly lists a call has been on. */
function serviceDueListIds_(call) {
  return String(call.listIds || call.firstListId || '').split(',')
    .map(function (s) { return s.trim(); }).filter(Boolean);
}

/** One customer, however the report spells them: the linked record, or the name it gives. */
function serviceDueCustomerKey_(call) {
  return String(call.customerId || '') || 'name:' + serviceDueNameKey_(call.sdrCustomerName);
}

/**
 * A company name reduced to what identifies it: "M/s. Testwell Agro Foods Pvt. Ltd." and
 * "TESTWELL AGRO FOODS PRIVATE LIMITED" are the same customer.
 */
function serviceDueNameKey_(name) {
  return String(name || '').toUpperCase()
    .replace(/^M\/?S\.?\s+/, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\b(PRIVATE|PVT|LIMITED|LTD|LLP|CO|COMPANY|THE|AND)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** A machine the report still has against PIE itself. */
function serviceDueIsDealer_(customerName, dealerName) {
  var dealer = serviceDueNameKey_(String(dealerName || '').split(' - ')[0]);
  var who = serviceDueNameKey_(customerName);
  if (!who) return false;
  if (dealer && who.indexOf(dealer) === 0) return true;
  return /^PREMIER INDIA ENTERPRISE/.test(who);
}

/**
 * The same customer's other open machines among the ones asked for — never another
 * customer's, and never one already closed, whatever the browser sent.
 */
async function serviceDueSiblings_(call, alsoIds) {
  var wanted = (alsoIds || []).map(String).filter(function (id) { return id && id !== String(call.id); });
  if (!wanted.length) return [];
  var key = serviceDueCustomerKey_(call);
  return (await findRowsByColumn_('ServiceDueCalls', 'id', wanted))
    .filter(function (c) { return !String(c.outcome || '') && serviceDueCustomerKey_(c) === key; })
    .map(function (c) { return String(c.id); });
}

/** "PO received 12-10-2026", "Not closed 12-10-2026: no budget this quarter". */
function serviceDueOutcomeText_(call) {
  var reason = call.notClosedReason || call.poRejectedReason || '';
  return String(call.outcome || '') + ' ' + ddmmyyyy_(call.outcomeDate) + (reason ? ': ' + reason : '');
}

// daysBetween_ is Billing.gs's: whole days from one ISO date to another.
