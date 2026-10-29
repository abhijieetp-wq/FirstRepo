/**
 * ERP 2.0's service desk: ERP 2's statuses for a service job, over ERP 1's.
 *
 *   New → Assigned → In progress → Report submitted → Closed        (or Cancelled, with a reason)
 *
 * ERP 1's own status column keeps ERP 1's values — Unassigned, Assigned, Scheduled,
 * In Progress, Completed, Cancelled — so its screens, filters and rules read every job exactly
 * as before. The 2.0 name is worked out from it:
 *
 *   New               Unassigned
 *   Assigned          Assigned or Scheduled
 *   In progress       In Progress
 *   Report submitted  the engineer's report is in, and nobody has closed the job yet
 *   Closed            Completed — by the coordinator, once the report is in (and the customer's
 *                     photograph, ERP 1's rule)
 *   Cancelled         Cancelled — with the reason, which 2.0 asks for
 *
 * "Report submitted" is the one ERP 1 had no word for: the engineer has done the work and
 * written it up, and the coordinator has not yet looked. Keeping it apart is what lets a
 * coordinator see which jobs are waiting on them rather than on the engineer.
 */

var SERVICE_DESK_STATUSES = ['New', 'Assigned', 'In progress', 'Report submitted', 'Closed', 'Cancelled'];

/** ERP 2's call types. ERP 1 logs Breakdown and raises Installation from a delivery. */
var SERVICE_CALL_TYPES = ['Breakdown', 'AMC visit', 'Regular service', 'Spare change', 'Installation', 'Commissioning'];
/** ERP 2's reasons for moving a visit to another day. */
var SERVICE_RESCHEDULE_REASONS = ['Customer not available', 'Engineer on another breakdown', 'Spares not available',
  'Travel / weather', 'Customer asked for new date', 'Other'];

/** The 2.0 name for a job's state. */
function serviceDeskStatus_(job) {
  var s = String(job && job.status || '');
  if (s === 'Cancelled') return 'Cancelled';
  if (s === 'Completed') return 'Closed';
  if (String(job.reportSubmittedAt || '').trim()) return 'Report submitted';
  if (s === 'In Progress') return 'In progress';
  if (s === 'Assigned' || s === 'Scheduled') return 'Assigned';
  if (s === 'Unassigned') return 'New';
  // A row with no status at all, from before statuses were kept: whether anybody is going.
  return String(job.engineerEmail || '').trim() ? 'Assigned' : 'New';
}

/** The engineer on the job, or somebody who allocates the work. */
function requireJobHand_(user, job) {
  if (SERVICE_ASSIGNERS.indexOf(user.role) !== -1) return;
  if (user.role === ROLES.SERVICE_ENGINEER &&
      String(job.engineerEmail || '').toLowerCase() === String(user.email || '').toLowerCase()) return;
  throw new Error('Only the engineer on this job, or the service coordinator, can do that.');
}

function serviceDeskJob_(id) {
  var job = findRowById_('ServiceJobs', id);
  if (!job) throw new Error('Service job not found.');
  return job;
}

/**
 * The engineer's report. Writing it is what moves a job to "Report submitted": the work is
 * done and described, and it waits for the coordinator. It can be corrected until the job is
 * closed.
 */
function submitServiceReport(id, input) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ROLES);
  var job = serviceDeskJob_(id);
  requireJobHand_(user, job);
  var status = String(job.status || '');
  if (status === 'Completed' || status === 'Cancelled') {
    throw new Error('This job is ' + serviceDeskStatus_(job).toLowerCase() + '. Its report can no longer change.');
  }
  if (!String(job.engineerEmail || '').trim()) throw new Error('Name the engineer who went before writing the report.');

  var r = input || {};
  var visitDate = String(r.visitDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) throw new Error('Give the date of the visit.');
  if (visitDate > todayIso_()) throw new Error('The visit date cannot be in the future.');
  var workDone = String(r.workDone || '').trim();
  if (workDone.length < 5) throw new Error('Say what work was done — this is what the customer is told.');
  var number = function (v, what) {
    if (v === '' || v === null || v === undefined) return '';
    var n = Number(v);
    if (isNaN(n) || n < 0) throw new Error(what + ' must be a number, not below zero.');
    return n;
  };
  var hoursSpent = number(r.hoursSpent, 'Hours spent');
  if (hoursSpent === '') throw new Error('Give the hours spent on site.');
  var runningHours = number(r.runningHours, 'The machine’s running hours');
  var rootCause = String(r.rootCause || '').trim();
  if (String(job.jobType) === 'Breakdown' && rootCause.length < 3) {
    throw new Error('Say what caused the breakdown — it is what stops it happening again.');
  }
  var handed = String(r.handedOverRunning || '').trim();
  if (['Yes', 'No'].indexOf(handed) === -1) throw new Error('Say whether the machine was handed over running.');

  var patch = {
    visitDate: visitDate, hoursSpent: hoursSpent, runningHours: runningHours, workDone: workDone,
    rootCause: rootCause, customerRemarks: String(r.customerRemarks || '').trim(), handedOverRunning: handed,
    reportSubmittedAt: nowIso_(), reportSubmittedBy: user.email
  };
  // The work has happened, whatever the status said before it.
  if (status !== 'In Progress') patch.status = 'In Progress';
  updateRowById_('ServiceJobs', 'id', id, patch, 'Engineer report submitted');
  return getServiceJob(id);
}

/**
 * Closes a job whose report is in. ERP 1's own rule still stands — the customer's photograph
 * of the finished work first — because closing goes through ERP 1's status change.
 */
function closeServiceJob(id, note) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ASSIGNERS);
  var job = serviceDeskJob_(id);
  if (serviceDeskStatus_(job) !== 'Report submitted') {
    throw new Error('A job is closed once the engineer’s report is in. This one is ' +
      serviceDeskStatus_(job).toLowerCase() + '.');
  }
  setServiceJobStatus(id, 'Completed', note);
  updateRowById_('ServiceJobs', 'id', id, { closedBy: user.email }, 'Closed by ' + user.email);
  return getServiceJob(id);
}

/** Cancels a job, saying why. A closed job is not cancelled: it happened. */
function cancelServiceJob(id, reason) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ASSIGNERS);
  var job = serviceDeskJob_(id);
  var status = String(job.status || '');
  if (status === 'Completed') throw new Error('This job is closed — the work was done, so it cannot be cancelled.');
  if (status === 'Cancelled') throw new Error('This job is already cancelled.');
  var why = String(reason || '').trim();
  if (why.length < 5) throw new Error('Say why the job is cancelled — the customer may ring about it.');
  updateRowById_('ServiceJobs', 'id', id, {
    status: 'Cancelled', cancelReason: why, cancelledAt: nowIso_(), cancelledBy: user.email
  }, 'Service job cancelled: ' + why);
  return getServiceJob(id);
}

// ------------------------------------------------------------------ calls: area, instruction, reschedules (2.0)

/** The areas, each Local or Outstation — the same list as the sales visit plans (VisitPlans.gs). */
function serviceAreas_() { return visitAreas_(visitConfig_()); }

function serviceAreaCheck_(area) {
  if (!serviceAreas_().some(function (a) { return a.name.toLowerCase() === String(area).toLowerCase(); })) {
    throw new Error('Pick the area from the list. Management keeps the list on Visit plans → Areas.');
  }
}

function serviceRescheduleRows_() {
  try { return readTable_('ServiceJobReschedules'); } catch (err) { return []; }
}

function serviceRescheduleCounts_() {
  var out = {};
  serviceRescheduleRows_().forEach(function (r) { var k = String(r.serviceJobId); out[k] = (out[k] || 0) + 1; });
  return out;
}

function serviceReschedulesFor_(id) {
  var people = userNameMap_();
  return serviceRescheduleRows_().filter(function (r) { return String(r.serviceJobId) === String(id); })
    .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); })
    .map(function (r) {
      return { fromDate: String(r.fromDate || '').slice(0, 10), toDate: String(r.toDate || '').slice(0, 10), reason: String(r.reason || ''),
        note: String(r.note || ''), byName: personLine_(r.createdBy, people), day: taskDay_(r.createdAt) };
    });
}

/** What the 2.0 call form and job window offer: call types, areas, reschedule reasons. */
function getServiceCallLists() {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ROLES.concat([ROLES.SERVICE_ENGINEER]));
  return { callTypes: SERVICE_CALL_TYPES, areas: serviceAreas_(), reasons: SERVICE_RESCHEDULE_REASONS,
    canAssign: SERVICE_ASSIGNERS.indexOf(user.role) !== -1 };
}

/** The call's area and the instruction to the engineer. Whoever allocates the work. */
function setServiceJobDetails(id, input) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ASSIGNERS);
  var job = findRowById_('ServiceJobs', id);
  if (!job) throw new Error('Service job not found.');
  var i = input || {};
  var area = String(i.area || '').trim();
  if (area) serviceAreaCheck_(area);
  var instruction = String(i.instruction || '').trim();
  if (instruction.length > 500) throw new Error('Keep the instruction under 500 characters.');
  updateRowById_('ServiceJobs', 'id', id, { area: area, instruction: instruction }, 'Area and instruction set');
  return getServiceJob(id);
}

/**
 * Moves an assigned visit to another day, with the reason, kept as history: ERP 2's
 * reschedule. The time of day is cleared, since it was for the old day.
 */
function rescheduleServiceJob(id, toDate, reason, note) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ASSIGNERS);
  var job = findRowById_('ServiceJobs', id);
  if (!job) throw new Error('Service job not found.');
  if (['Completed', 'Cancelled'].indexOf(String(job.status)) !== -1) throw new Error('A closed or cancelled job is not rescheduled.');
  var from = String(job.scheduledDate || '').slice(0, 10);
  if (!from) throw new Error('This job has no day yet. Give it one by assigning it.');
  var to = String(toDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('Give the new date.');
  if (to === from) throw new Error('That is the day it is already on.');
  if (to < todayIso_()) throw new Error('Move it to today or later.');
  var why = String(reason || '').trim();
  if (SERVICE_RESCHEDULE_REASONS.indexOf(why) === -1) throw new Error('Pick the reason it is moving.');
  var more = String(note || '').trim();
  if (why === 'Other' && more.length < 5) throw new Error('Say what the other reason is.');
  appendRow_('ServiceJobReschedules', { id: generateId_('RS-'), serviceJobId: String(id), fromDate: from, toDate: to,
    reason: why, note: more, createdAt: nowIso_(), createdBy: user.email }, 'Visit rescheduled');
  updateRowById_('ServiceJobs', 'id', id, { scheduledDate: to, scheduledTime: '' }, 'Rescheduled from ' + from + ' to ' + to + ': ' + why);
  return getServiceJob(id);
}
