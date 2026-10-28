/**
 * Converted from src/ServiceDesk.gs by migration/to-async.js.
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

async function serviceDeskJob_(id) {
  var job = await findRowById_('ServiceJobs', id);
  if (!job) throw new Error('Service job not found.');
  return job;
}

/**
 * The engineer's report. Writing it is what moves a job to "Report submitted": the work is
 * done and described, and it waits for the coordinator. It can be corrected until the job is
 * closed.
 */
async function submitServiceReport(id, input) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ROLES);
  var job = await serviceDeskJob_(id);
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
  await updateRowById_('ServiceJobs', 'id', id, patch, 'Engineer report submitted');
  return await getServiceJob(id);
}

/**
 * Closes a job whose report is in. ERP 1's own rule still stands — the customer's photograph
 * of the finished work first — because closing goes through ERP 1's status change.
 */
async function closeServiceJob(id, note) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ASSIGNERS);
  var job = await serviceDeskJob_(id);
  if (serviceDeskStatus_(job) !== 'Report submitted') {
    throw new Error('A job is closed once the engineer’s report is in. This one is ' +
      serviceDeskStatus_(job).toLowerCase() + '.');
  }
  await setServiceJobStatus(id, 'Completed', note);
  await updateRowById_('ServiceJobs', 'id', id, { closedBy: user.email }, 'Closed by ' + user.email);
  return await getServiceJob(id);
}

/** Cancels a job, saying why. A closed job is not cancelled: it happened. */
async function cancelServiceJob(id, reason) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ASSIGNERS);
  var job = await serviceDeskJob_(id);
  var status = String(job.status || '');
  if (status === 'Completed') throw new Error('This job is closed — the work was done, so it cannot be cancelled.');
  if (status === 'Cancelled') throw new Error('This job is already cancelled.');
  var why = String(reason || '').trim();
  if (why.length < 5) throw new Error('Say why the job is cancelled — the customer may ring about it.');
  await updateRowById_('ServiceJobs', 'id', id, {
    status: 'Cancelled', cancelReason: why, cancelledAt: nowIso_(), cancelledBy: user.email
  }, 'Service job cancelled: ' + why);
  return await getServiceJob(id);
}
