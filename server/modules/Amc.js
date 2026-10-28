/**
 * Converted from src/Amc.gs by migration/to-async.js.
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
 * ERP 2.0's AMC: contracts and the visits they promise.
 *
 * A contract is one machine at one customer: its type (Comprehensive, Non-comprehensive,
 * Labour only, or a Service reminder with no contract behind it), its period, a service every
 * so many months from the first visit, the running hours when it started, the person to ring
 * and the area. Saving it lays out the visits from the first one to the end of the period.
 *
 * A visit that falls due becomes a service job with one press — jobType 'AMC visit', waiting
 * for the service coordinator like any other job (ServiceDesk.gs). From then on the visit's
 * state is read off that job: Call made while the job is open, Done once it is closed, Due
 * again if the job is cancelled. Nothing is copied, so the two cannot disagree.
 *
 * A contract near its end gets a renewal quotation, raised through an AMC renewal enquiry so
 * it prints with the AMC renewal heading and subject (QuotationDocument.gs).
 *
 * The value of a contract is commercial, and service does not see the commercial side
 * (requireCommercial_): it is left out of everything a service user is sent.
 */

var AMC_TYPES = ['Comprehensive', 'Non-comprehensive', 'Labour only', 'Service reminder'];
var AMC_EDITORS = [ROLES.SERVICE_COORDINATOR, ROLES.SALES_COORDINATOR, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];
/** How far ahead "due" looks, in days. ERP 2 offered these four. */
var AMC_WINDOWS = [7, 15, 30, 60];
var AMC_RENEWAL_DAYS = 60;

function amcActive_(row) { return String(row.active).toUpperCase() !== 'FALSE'; }

/** The same day so many months on, or the month's last day when it has fewer days. */
function amcAddMonths_(iso, months) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  var y = Number(m[1]);
  var mo = Number(m[2]) - 1 + Number(months || 0);
  y += Math.floor(mo / 12);
  mo = ((mo % 12) + 12) % 12;
  var last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  var d = Math.min(Number(m[3]), last);
  return y + '-' + ('0' + (mo + 1)).slice(-2) + '-' + ('0' + d).slice(-2);
}

/** The visit dates a contract promises: from the first visit, every N months, to the end. */
function amcSchedule_(firstVisitDate, everyMonths, endDate) {
  var out = [];
  var n = Number(everyMonths) || 0;
  if (!firstVisitDate || n < 1) return out;
  for (var i = 0; i < 60; i++) {
    var d = amcAddMonths_(firstVisitDate, n * i);
    if (!d || (endDate && d > endDate)) break;
    out.push(d);
  }
  return out;
}

/** Where a visit stands, from the service job it became. */
function amcVisitState_(visit, jobsById, today) {
  var job = visit.serviceJobId ? jobsById[String(visit.serviceJobId)] : null;
  if (job) {
    var s = String(job.status || '');
    if (s === 'Completed') return { state: 'Done', job: job, doneDate: String(job.completedDate || '').slice(0, 10) };
    if (s !== 'Cancelled') return { state: 'Call made', job: job };
  }
  return { state: String(visit.dueDate) < today ? 'Overdue' : 'Due', job: null };
}

function requireAmcViewer_(user) {
  requireRole_(user, [ROLES.SERVICE_COORDINATOR, ROLES.SERVICE_ENGINEER, ROLES.SALES_COORDINATOR,
    ROLES.MANAGEMENT, ROLES.ERP_ADMIN]);
}

/**
 * The AMC screen: the visits due within the window (and every overdue one), the contracts,
 * and the renewals coming up.
 *
 * @param options { window: 7 | 15 | 30 | 60 }
 */
async function listAmc(options) {
  var user = getCurrentUser();
  requireAmcViewer_(user);
  var opts = options || {};
  var windowDays = AMC_WINDOWS.indexOf(Number(opts.window)) !== -1 ? Number(opts.window) : 30;
  var money = !isServiceOnly_(user);
  var today = todayIso_();
  var horizon = addDays_(today, windowDays);
  var people = await userNameMap_();

  var contracts = (await readTable_('AmcContracts')).filter(amcActive_);
  var byContract = {};
  contracts.forEach(function (c) { byContract[String(c.id)] = c; });
  var visits = (await readTable_('AmcVisits')).filter(function (v) { return byContract[String(v.contractId)]; });
  var jobIds = visits.map(function (v) { return String(v.serviceJobId || ''); }).filter(Boolean);
  var jobsById = {};
  if (jobIds.length) (await findRowsByColumn_('ServiceJobs', 'id', jobIds)).forEach(function (j) { jobsById[String(j.id)] = j; });
  var quoteIds = contracts.map(function (c) { return String(c.renewalQuotationId || ''); }).filter(Boolean);
  var quotes = {};
  if (quoteIds.length) (await findRowsByColumn_('Quotations', 'id', quoteIds)).forEach(function (q) { quotes[String(q.id)] = q; });

  var perContract = {};
  var dues = [];
  visits.forEach(function (v) {
    var c = byContract[String(v.contractId)];
    var st = amcVisitState_(v, jobsById, today);
    var k = String(c.id);
    perContract[k] = perContract[k] || { total: 0, done: 0, next: '' };
    perContract[k].total++;
    if (st.state === 'Done') perContract[k].done++;
    else if (!perContract[k].next || String(v.dueDate) < perContract[k].next) perContract[k].next = String(v.dueDate).slice(0, 10);
    if (st.state === 'Done') return;
    if (String(v.dueDate) > horizon) return;
    dues.push({
      id: String(v.id), contractId: k, contractNo: String(c.contractNo || ''), customerName: String(c.customerName || ''),
      machineModel: String(c.machineModel || ''), serialNo: String(c.serialNo || ''), amcType: String(c.amcType || ''),
      endDate: String(c.endDate || '').slice(0, 10), area: String(c.area || ''),
      visitNo: Number(v.visitNo) || 0, dueDate: String(v.dueDate).slice(0, 10), state: st.state,
      jobId: st.job ? String(st.job.id) : '', jobNo: st.job ? String(st.job.jobNo || '') : '',
      engineer: st.job && st.job.engineerEmail ? personLine_(st.job.engineerEmail, people) : ''
    });
  });
  dues.forEach(function (d) { d.visitOf = (perContract[d.contractId] || {}).total || 0; });
  dues.sort(function (a, b) { return a.dueDate.localeCompare(b.dueDate) || a.customerName.localeCompare(b.customerName); });

  var rows = contracts.map(function (c) {
    var k = String(c.id);
    var end = String(c.endDate || '').slice(0, 10);
    var left = end ? daysBetween_(today, end) : 0;
    var q = quotes[String(c.renewalQuotationId || '')];
    return {
      id: k, contractNo: String(c.contractNo || ''), customerId: String(c.customerId || ''),
      customerName: String(c.customerName || ''), machineModel: String(c.machineModel || ''),
      serialNo: String(c.serialNo || ''), amcType: String(c.amcType || ''),
      startDate: String(c.startDate || '').slice(0, 10), endDate: end,
      everyMonths: Number(c.everyMonths) || 0, firstVisitDate: String(c.firstVisitDate || '').slice(0, 10),
      contractValue: money ? (c.contractValue === '' || c.contractValue === null ? '' : Number(c.contractValue) || 0) : '',
      runningHours: String(c.runningHours || ''), contactName: String(c.contactName || ''),
      contactPhone: String(c.contactPhone || ''), area: String(c.area || ''),
      ownerEmail: String(c.ownerEmail || ''), ownerName: personLine_(c.ownerEmail, people), notes: String(c.notes || ''),
      visitsDone: (perContract[k] || {}).done || 0, visitsTotal: (perContract[k] || {}).total || 0,
      nextVisit: (perContract[k] || {}).next || '',
      state: !end ? 'Active' : left < 0 ? 'Ended' : left <= AMC_RENEWAL_DAYS ? 'Ends in ' + left + ' days' : 'Active',
      daysLeft: left,
      renewal: q ? { quotationId: String(q.id), quoteNo: String(q.quoteNo || ''), status: String(q.status || '') } : null
    };
  }).sort(function (a, b) { return a.customerName.localeCompare(b.customerName) || a.endDate.localeCompare(b.endDate); });

  // A service reminder is not a contract and is not renewed.
  var renewals = rows.filter(function (c) {
    return c.amcType !== 'Service reminder' && c.endDate && c.daysLeft <= AMC_RENEWAL_DAYS && c.daysLeft >= -30;
  }).sort(function (a, b) { return a.endDate.localeCompare(b.endDate); });
  var running = rows.filter(function (c) { return c.daysLeft >= 0 || !c.endDate; });
  var month = today.slice(0, 7);

  return {
    window: windowDays, windows: AMC_WINDOWS, types: AMC_TYPES, today: today, money: money,
    canEdit: AMC_EDITORS.indexOf(user.role) !== -1,
    canRenew: ENQUIRY_EDITORS.indexOf(user.role) !== -1 && streamAllowed_(user, STREAM_SPARE),
    canMakeCall: SERVICE_ASSIGNERS.indexOf(user.role) !== -1 || user.role === ROLES.SALES_COORDINATOR,
    kpis: {
      active: running.length,
      valueAYear: money ? running.reduce(function (s, c) { return s + (Number(c.contractValue) || 0); }, 0) : '',
      dueThisMonth: visits.filter(function (v) {
        return String(v.dueDate).slice(0, 7) === month && amcVisitState_(v, jobsById, today).state !== 'Done';
      }).length,
      overdue: dues.filter(function (d) { return d.state === 'Overdue'; }).length,
      renewals: renewals.filter(function (c) { return c.daysLeft >= 0; }).length
    },
    dues: dues, contracts: rows, renewals: renewals
  };
}

/** One contract with all its visits, for its window. */
async function getAmcContract(id) {
  var user = getCurrentUser();
  requireAmcViewer_(user);
  var c = await findRowById_('AmcContracts', id);
  if (!c || !amcActive_(c)) throw new Error('That AMC contract is no longer there.');
  var visits = await findRowsByColumn_('AmcVisits', 'contractId', [String(id)]);
  var jobIds = visits.map(function (v) { return String(v.serviceJobId || ''); }).filter(Boolean);
  var jobsById = {};
  if (jobIds.length) (await findRowsByColumn_('ServiceJobs', 'id', jobIds)).forEach(function (j) { jobsById[String(j.id)] = j; });
  var today = todayIso_();
  var row = stripRow_(c);
  if (isServiceOnly_(user)) row.contractValue = '';
  row.startDate = String(row.startDate || '').slice(0, 10);
  row.endDate = String(row.endDate || '').slice(0, 10);
  row.firstVisitDate = String(row.firstVisitDate || '').slice(0, 10);
  row.visits = visits.map(function (v) {
    var st = amcVisitState_(v, jobsById, today);
    return { id: String(v.id), visitNo: Number(v.visitNo) || 0, dueDate: String(v.dueDate).slice(0, 10), state: st.state,
      jobId: st.job ? String(st.job.id) : '', jobNo: st.job ? String(st.job.jobNo || '') : '', doneDate: st.doneDate || '' };
  }).sort(function (a, b) { return a.visitNo - b.visitNo; });
  return row;
}

/**
 * Adds or changes a contract. A new one gets its visits laid out; a changed schedule moves the
 * visits nobody has acted on yet and leaves alone the ones already made into a job.
 */
async function saveAmcContract(input) {
  var user = getCurrentUser();
  requireRole_(user, AMC_EDITORS);
  var i = input || {};
  var existing = i.id ? await findRowById_('AmcContracts', i.id) : null;
  if (i.id && (!existing || !amcActive_(existing))) throw new Error('That AMC contract is no longer there.');

  var customerId = String(i.customerId || '').trim();
  var customer = customerId ? await findRowById_('Customers', customerId) : null;
  if (!customer) throw new Error('Pick the customer.');
  var serialNo = String(i.serialNo || '').trim();
  if (!serialNo) throw new Error('Give the machine’s serial (fab) number — a contract is for one machine.');
  var amcType = AMC_TYPES.filter(function (t) { return t.toLowerCase() === String(i.amcType || '').trim().toLowerCase(); })[0];
  if (!amcType) throw new Error('The type must be one of: ' + AMC_TYPES.join(', ') + '.');
  var startDate = String(i.startDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('Give the date the contract starts.');
  var endDate = String(i.endDate || '').slice(0, 10) || addDays_(amcAddMonths_(startDate, 12), -1);
  if (endDate < startDate) throw new Error('The contract cannot end before it starts.');
  var everyMonths = Math.round(Number(i.everyMonths));
  if (!(everyMonths >= 1 && everyMonths <= 24)) throw new Error('Service every 1 to 24 months.');
  // Unless given, the first visit closes the first period — a year of quarterly service is the
  // four visits ending on the contract's last day, as ERP 2 laid them out.
  var firstVisitDate = String(i.firstVisitDate || '').slice(0, 10) || addDays_(amcAddMonths_(startDate, everyMonths), -1);
  if (firstVisitDate < startDate || firstVisitDate > endDate) throw new Error('The first visit has to fall within the contract.');
  // The value is the sales side's to set: a service user's save leaves whatever is there.
  var value = existing ? existing.contractValue : '';
  if (!isServiceOnly_(user) && i.contractValue !== undefined) {
    value = i.contractValue === '' || i.contractValue === null ? '' : Number(i.contractValue);
    if (value !== '' && (isNaN(value) || value < 0)) throw new Error('The contract value must be a number, not below zero.');
  }

  var now = nowIso_();
  // A field the caller did not send is kept as it is, so a save from somewhere that only knows
  // the schedule does not wipe the contact.
  var keep = function (field) {
    return String(i[field] !== undefined ? i[field] || '' : existing ? existing[field] || '' : '').trim();
  };
  var record = {
    customerId: customerId, customerName: String(customer.name || ''),
    machineModel: keep('machineModel'), serialNo: serialNo, amcType: amcType,
    startDate: startDate, endDate: endDate, everyMonths: everyMonths, firstVisitDate: firstVisitDate,
    contractValue: value, runningHours: keep('runningHours'),
    contactName: keep('contactName'), contactPhone: keep('contactPhone'), area: keep('area'),
    ownerEmail: keep('ownerEmail') || user.email, notes: keep('notes'), updatedAt: now, updatedBy: user.email
  };

  var id;
  if (existing) {
    id = String(existing.id);
    await updateRowById_('AmcContracts', 'id', id, record, 'AMC contract changed');
  } else {
    id = generateId_('AMC-');
    record.id = id;
    record.contractNo = String(i.contractNo || '').trim() || await nextSeriesNo_('AmcContracts', 'contractNo', 'AMC');
    record.active = 'TRUE';
    record.createdAt = now;
    record.createdBy = user.email;
    await appendRow_('AmcContracts', record, 'AMC contract added');
  }
  if (existing && String(i.contractNo || '').trim() && String(i.contractNo).trim() !== String(existing.contractNo)) {
    await updateRowById_('AmcContracts', 'id', id, { contractNo: String(i.contractNo).trim() }, 'AMC contract number changed');
  }
  await amcLayVisits_(id, firstVisitDate, everyMonths, endDate);
  return await getAmcContract(id);
}

/**
 * The visits for a schedule. Visits already made into a job stay as they are, with their
 * numbers; the ones nobody has touched are laid out again from the schedule.
 */
async function amcLayVisits_(contractId, firstVisitDate, everyMonths, endDate) {
  var visits = await findRowsByColumn_('AmcVisits', 'contractId', [String(contractId)]);
  var kept = visits.filter(function (v) { return String(v.serviceJobId || ''); });
  var keptDates = {};
  kept.forEach(function (v) { keptDates[String(v.dueDate).slice(0, 10)] = true; });
  for (var v of visits) {
    if (!String(v.serviceJobId || '')) await deleteRowById_('AmcVisits', 'id', String(v.id), 'AMC visit laid out again');
  }
  var dates = amcSchedule_(firstVisitDate, everyMonths, endDate).filter(function (d) { return !keptDates[d]; });
  var all = kept.map(function (v) { return { date: String(v.dueDate).slice(0, 10), row: v }; })
    .concat(dates.map(function (d) { return { date: d, row: null }; }))
    .sort(function (a, b) { return a.date.localeCompare(b.date); });
  var n = 0;
  for (var x of all) {
    n++;
    if (x.row) {
      if (Number(x.row.visitNo) !== n) await updateRowById_('AmcVisits', 'id', String(x.row.id), { visitNo: n }, 'AMC visit renumbered');
    } else {
      await appendRow_('AmcVisits', { id: generateId_('AMV-'), contractId: String(contractId), visitNo: n, dueDate: x.date,
        serviceJobId: '', notes: '', createdAt: nowIso_() }, 'AMC visit laid out');
    }
  }
}

/** Takes a contract off the list. Refused once a visit has become a job: that happened. */
async function deleteAmcContract(id) {
  var user = getCurrentUser();
  requireRole_(user, AMC_EDITORS);
  var c = await findRowById_('AmcContracts', id);
  if (!c || !amcActive_(c)) throw new Error('That AMC contract is no longer there.');
  var worked = (await findRowsByColumn_('AmcVisits', 'contractId', [String(id)])).filter(function (v) { return String(v.serviceJobId || ''); });
  if (worked.length) {
    throw new Error('A visit on this contract has already become a service job, so the contract stays on record. ' +
      'Change its end date instead if it has stopped.');
  }
  await updateRowById_('AmcContracts', 'id', id, { active: 'FALSE', updatedAt: nowIso_(), updatedBy: user.email }, 'AMC contract deleted');
  return { deleted: true, contractNo: String(c.contractNo || '') };
}

/**
 * A due visit, made into a service job for the coordinator to send somebody — the same queue
 * as every other job. The visit keeps the job's id and reads its state from it.
 */
async function makeAmcVisitCall(visitId) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ASSIGNERS.concat([ROLES.SALES_COORDINATOR]));
  var visit = await findRowById_('AmcVisits', visitId);
  if (!visit) throw new Error('That AMC visit is no longer there.');
  var c = await findRowById_('AmcContracts', visit.contractId);
  if (!c || !amcActive_(c)) throw new Error('That AMC contract is no longer there.');
  if (String(visit.serviceJobId || '')) {
    var had = await findRowById_('ServiceJobs', visit.serviceJobId);
    if (had && String(had.status) !== 'Cancelled') {
      throw new Error('This visit is already job ' + had.jobNo + '.');
    }
  }
  var total = (await findRowsByColumn_('AmcVisits', 'contractId', [String(c.id)])).length;
  var job = {
    id: generateId_('SVJ-'),
    jobNo: await nextSeriesNo_('ServiceJobs', 'jobNo', 'SVJ'),
    date: todayIso_(), dispatchId: '', salesOrderId: '',
    customerId: String(c.customerId || ''), customerName: String(c.customerName || ''),
    machineModel: String(c.machineModel || ''), serialNo: String(c.serialNo || ''), siteAddressId: '',
    engineerEmail: '', status: 'Unassigned', jobType: 'AMC visit', urgency: 'Normal', reportedBy: '',
    contactName: String(c.contactName || ''), contactPhone: String(c.contactPhone || ''), contactEmail: '',
    handedOverBy: user.email,
    scopeText: 'AMC visit ' + visit.visitNo + ' of ' + total + ' — ' + c.amcType + ' ' +
      (c.amcType === 'Service reminder' ? '' : 'contract ') + c.contractNo + ', due ' + ddmmyyyy_(String(visit.dueDate).slice(0, 10)) +
      (c.area ? ' · ' + c.area : ''),
    scheduledDate: '', completedDate: '', notes: ''
  };
  await appendRow_('ServiceJobs', job, 'AMC visit made into a service job');
  await updateRowById_('AmcVisits', 'id', String(visit.id), { serviceJobId: job.id }, 'AMC visit called as ' + job.jobNo);
  return { jobId: job.id, jobNo: job.jobNo };
}

/**
 * The renewal offer for a contract near its end: an AMC renewal enquiry on the spares desk,
 * and the quotation raised from it, so it prints with the AMC renewal heading and subject.
 * Pressing it twice opens the one already made.
 */
async function prepareAmcRenewal(contractId) {
  var user = getCurrentUser();
  requireRole_(user, ENQUIRY_EDITORS);
  requireStream_(user, STREAM_SPARE, 'An AMC renewal offer');
  var c = await findRowById_('AmcContracts', contractId);
  if (!c || !amcActive_(c)) throw new Error('That AMC contract is no longer there.');
  if (c.amcType === 'Service reminder') throw new Error('A service reminder is not a contract, so there is nothing to renew.');
  if (String(c.renewalQuotationId || '')) {
    var had = await findRowById_('Quotations', c.renewalQuotationId);
    if (had) return { quotationId: String(had.id), quoteNo: String(had.quoteNo || ''), existing: true };
  }
  var enquiry = await saveSpareEnquiry({
    customerId: c.customerId, customerName: c.customerName,
    contactName: c.contactName || '', contactPhone: c.contactPhone || '',
    productModel: c.machineModel || '', serialNo: c.serialNo || '',
    requirementText: 'AMC renewal — ' + c.amcType + ' contract ' + c.contractNo + ', ends ' +
      ddmmyyyy_(String(c.endDate || '').slice(0, 10)) +
      (c.contractValue !== '' && c.contractValue !== null ? '. Current value ' + c.contractValue + ' a year' : ''),
    urgency: 'Normal', source: 'AMC contract', ownerEmail: c.ownerEmail || user.email, enquiryType: 'AMC renewal'
  });
  var quote = await createQuotationFromEnquiry(enquiry.id);
  await updateRowById_('AmcContracts', 'id', String(c.id), {
    renewalEnquiryId: enquiry.id, renewalQuotationId: String(quote.id), updatedAt: nowIso_(), updatedBy: user.email
  }, 'AMC renewal quotation raised');
  return { quotationId: String(quote.id), quoteNo: String(quote.quoteNo || ''), existing: false };
}

/** The customer's machines we already know of, to pick one for a contract. */
async function listAmcMachines(customerId) {
  var user = getCurrentUser();
  requireRole_(user, AMC_EDITORS);
  var out = {};
  var add = function (serial, model, from) {
    var s = String(serial || '').trim();
    if (!s || out[s.toUpperCase()]) return;
    out[s.toUpperCase()] = { serialNo: s, machineModel: String(model || '').trim(), from: from };
  };
  var id = String(customerId || '');
  try { (await readTable_('InstalledBase')).forEach(function (m) { if (String(m.customerId) === id) add(m.serialNo, m.productModel, 'Installed base'); }); } catch (err) { /* optional */ }
  try { (await readTable_('ServiceDueCalls')).forEach(function (c) { if (String(c.customerId) === id) add(c.fabNo, c.productModel, 'ELGi’s service due list'); }); } catch (err) { /* optional */ }
  (await readTable_('ServiceJobs')).forEach(function (j) { if (String(j.customerId) === id) add(j.serialNo, j.machineModel, 'A service job'); });
  return Object.keys(out).map(function (k) { return out[k]; });
}
