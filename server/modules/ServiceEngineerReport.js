/**
 * Converted from src/ServiceEngineerReport.gs by migration/to-async.js.
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
 * ERP 2.0's service engineer report: what each service engineer did in a period, ERP 2's
 * columns, read from the service jobs and what ERP 1 already records.
 *
 *   Assigned        jobs with the engineer whose visit day (or, with no day yet, the day the
 *                   call came in) falls in the period — ERP 1 keeps no "assigned at" time
 *   Attended        the engineer's report submitted in the period (ServiceDesk.gs)
 *   Closed          completed in the period
 *   Rescheduled     reschedules in the period, and on how many jobs (ServiceDesk.gs)
 *   Pending now     open, report not in yet
 *   Local / Outstation   the assigned jobs by their area's kind; jobs with no area apart
 *   Hours           on site, from the reports attended, by Local and Outstation
 *   Days to attend  from the call coming in to the report, on average
 *   AMC visits      AMC visit jobs closed in the period
 *   Spare enquiries and compressor leads the engineer passed on in the period (EngineerLeads.gs),
 *                   with their value for those who see money
 *
 * Service Coordinator, Management and ERP Admin see every engineer; a service engineer sees
 * their own line. Service never sees money (isServiceOnly_). Shown on the 2.0 face only.
 */

var ENGINEER_REPORT_ROLES = [ROLES.SERVICE_COORDINATOR, ROLES.SERVICE_ENGINEER, ROLES.MANAGEMENT, ROLES.ERP_ADMIN];

function engRepIn_(day, p) { var d = String(day || '').slice(0, 10); return !!d && d >= p.from && d <= p.to; }

/**
 * The report for a period.
 *
 * @param options { period: 'month'|'lastmonth'|'quarter'|'fy'|'custom', from, to }
 */
async function getServiceEngineerReport(options) {
  var user = getCurrentUser();
  requireRole_(user, ENGINEER_REPORT_ROLES);
  var today = todayIso_();
  var p = taskPeriod_(options || {}, today);
  var money = !isServiceOnly_(user);
  var own = user.role === ROLES.SERVICE_ENGINEER;
  var areas = await serviceAreas_();
  var jobs = await readTable_('ServiceJobs');
  var moves = await serviceRescheduleRows_();
  var jobById = {};
  jobs.forEach(function (j) { jobById[String(j.id)] = j; });
  var enquiries = [];
  var leads = [];
  try { enquiries = await readTable_('SpareEnquiries'); } catch (err) { enquiries = []; }
  try { leads = await readTable_('Leads'); } catch (err) { leads = []; }
  // What an enquiry is worth, for those who see money: its newest live quotation, or nothing.
  var quoteValue = {};
  if (money) {
    try {
      (await readTable_('Quotations')).forEach(function (q) {
        if (String(q.status) === 'Revised') return;
        var k = String(q.spareEnquiryId || '');
        if (k && (!quoteValue[k] || String(q.date) > quoteValue[k].date)) quoteValue[k] = { date: String(q.date), grand: Number(q.grand) || 0 };
      });
    } catch (err) { /* values are a courtesy */ }
  }

  var engineers = (await readTable_('Users')).filter(function (u) {
    return String(u.role) === ROLES.SERVICE_ENGINEER && (String(u.active).toUpperCase() !== 'FALSE' ||
      jobs.some(function (j) { return taskSame_(j.engineerEmail, u.email); })) && (!own || taskSame_(u.email, user.email));
  }).map(function (u) { return { email: String(u.email), name: String(u.name || u.email) }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });

  var rows = engineers.map(function (e) {
    var mine = jobs.filter(function (j) { return taskSame_(j.engineerEmail, e.email); });
    var assigned = mine.filter(function (j) { return engRepIn_(j.scheduledDate || j.date, p); });
    var attended = mine.filter(function (j) { return engRepIn_(taskDay_(j.reportSubmittedAt), p); });
    var closed = mine.filter(function (j) { return String(j.status) === 'Completed' && engRepIn_(j.completedDate, p); });
    var moved = moves.filter(function (m) { var j = jobById[String(m.serviceJobId)]; return j && taskSame_(j.engineerEmail, e.email) && engRepIn_(taskDay_(m.createdAt), p); });
    var movedJobs = {};
    moved.forEach(function (m) { movedJobs[String(m.serviceJobId)] = true; });
    var kind = function (j) { return visitAreaType_(j.area, areas); };
    var hours = function (list, type) {
      return list.filter(function (j) { return kind(j) === type; }).reduce(function (s, j) { return s + (Number(j.hoursSpent) || 0); }, 0);
    };
    var tat = attended.map(function (j) { return daysBetween_(String(j.date || '').slice(0, 10), taskDay_(j.reportSubmittedAt)); });
    var passed = enquiries.filter(function (x) { return taskSame_(x.serviceEngineerEmail, e.email) && engRepIn_(x.date, p); });
    var passedLeads = leads.filter(function (x) { return taskSame_(x.serviceEngineerEmail, e.email) && engRepIn_(x.date, p); });
    var row = {
      email: e.email, name: e.name,
      assigned: assigned.length, attended: attended.length, closed: closed.length,
      rescheduled: moved.length, rescheduledJobs: Object.keys(movedJobs).length,
      pending: mine.filter(function (j) {
        return ['Completed', 'Cancelled'].indexOf(String(j.status)) === -1 && !String(j.reportSubmittedAt || '').trim();
      }).length,
      local: assigned.filter(function (j) { return kind(j) === 'Local'; }).length,
      outstation: assigned.filter(function (j) { return kind(j) === 'Outstation'; }).length,
      noArea: assigned.filter(function (j) { return !kind(j); }).length,
      hoursLocal: hours(attended, 'Local'), hoursOutstation: hours(attended, 'Outstation'), hoursNoArea: hours(attended, ''),
      daysToAttend: tat.length ? Math.round(tat.reduce(function (a, b) { return a + b; }, 0) / tat.length * 10) / 10 : null,
      amcVisits: closed.filter(function (j) { return String(j.jobType) === 'AMC visit'; }).length,
      spareEnquiries: passed.length, leads: passedLeads.length
    };
    if (money) {
      row.spareValue = passed.reduce(function (s, x) { return s + ((quoteValue[String(x.id)] || {}).grand || 0); }, 0);
    }
    return row;
  });
  var sum = function (k) { return rows.reduce(function (s, r) { return s + (Number(r[k]) || 0); }, 0); };
  var totals = {};
  ['assigned', 'attended', 'closed', 'rescheduled', 'rescheduledJobs', 'pending', 'local', 'outstation', 'noArea', 'hoursLocal',
    'hoursOutstation', 'hoursNoArea', 'amcVisits', 'spareEnquiries', 'leads'].forEach(function (k) { totals[k] = sum(k); });
  if (money) totals.spareValue = sum('spareValue');
  return { period: p, periods: TASK_PERIODS, today: today, money: money, own: own, rows: rows, totals: totals };
}
