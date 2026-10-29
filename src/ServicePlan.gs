/**
 * ERP 2.0's next-day plan: each engineer's visits for a day, from the service jobs assigned
 * to them, and what is not on the plan yet — jobs nobody has been sent on, jobs with an
 * engineer but no day, and AMC visits falling due with no job made of them.
 *
 * The plan is the jobs themselves, read: there is no plan record to keep in step. Assigning a
 * job, putting it on the day or giving it a time here is ERP 1's own assignment
 * (assignServiceJob) plus the visit's time. The message for the engineers' WhatsApp group is
 * put together on the screen and copied by hand — the ERP sends nothing by itself.
 *
 * Shown on the 2.0 face only. An engineer sees their own day; the coordinator sees everyone's.
 */

function planOpen_(job) { return ['Completed', 'Cancelled'].indexOf(String(job.status || '')) === -1; }

/** "Pune" for a job: its site's city, or the customer's billing city. */
function planCities_(jobs) {
  var addressIds = jobs.map(function (j) { return String(j.siteAddressId || ''); }).filter(Boolean);
  var byId = {};
  if (addressIds.length) findRowsByColumn_('CustomerAddresses', 'id', addressIds).forEach(function (a) { byId[String(a.id)] = a; });
  var customerIds = jobs.map(function (j) { return String(j.customerId || ''); }).filter(Boolean);
  var billing = {};
  if (customerIds.length) {
    findRowsByColumn_('CustomerAddresses', 'customerId', customerIds).forEach(function (a) {
      var k = String(a.customerId);
      if (!billing[k] || String(a.isDefault).toUpperCase() === 'TRUE') billing[k] = a;
    });
  }
  var out = {};
  jobs.forEach(function (j) {
    var a = byId[String(j.siteAddressId || '')] || billing[String(j.customerId || '')];
    out[String(j.id)] = a ? String(a.city || '') : '';
  });
  out.__areas = serviceAreas_();
  return out;
}

function planJob_(j, cities, people) {
  return {
    id: String(j.id), jobNo: String(j.jobNo || ''), jobType: String(j.jobType || 'Installation'),
    urgency: String(j.urgency || 'Normal'), customerName: String(j.customerName || ''), city: cities[String(j.id)] || '',
    machineModel: String(j.machineModel || ''), serialNo: String(j.serialNo || ''), scopeText: String(j.scopeText || ''),
    contactName: String(j.contactName || ''), contactPhone: String(j.contactPhone || ''),
    engineerEmail: String(j.engineerEmail || ''), engineerName: j.engineerEmail ? personLine_(j.engineerEmail, people) : '',
    scheduledDate: String(j.scheduledDate || '').slice(0, 10), scheduledTime: String(j.scheduledTime || ''),
    deskStatus: serviceDeskStatus_(j), date: String(j.date || '').slice(0, 10),
    // The call's area and the coordinator's instruction (ServiceDesk.gs), for the message.
    area: String(j.area || ''), areaType: visitAreaType_(j.area, cities.__areas || []), instruction: String(j.instruction || '')
  };
}

/**
 * The plan for a day.
 *
 * @param options { date: 'yyyy-mm-dd' } — tomorrow unless given.
 */
function getNextDayPlan(options) {
  var user = getCurrentUser();
  requireRole_(user, [ROLES.SERVICE_COORDINATOR, ROLES.SERVICE_ENGINEER, ROLES.SALES_COORDINATOR,
    ROLES.MANAGEMENT, ROLES.ERP_ADMIN]);
  var opts = options || {};
  var today = todayIso_();
  var date = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.date || '')) ? String(opts.date) : addDays_(today, 1);
  var engineerOnly = user.role === ROLES.SERVICE_ENGINEER;
  var me = String(user.email || '').toLowerCase();
  var people = userNameMap_();

  var jobs = readTable_('ServiceJobs').filter(planOpen_);
  var cities = planCities_(jobs);
  var engineers = readTable_('Users').filter(function (u) {
    return String(u.active).toUpperCase() !== 'FALSE' && String(u.role) === ROLES.SERVICE_ENGINEER &&
      (!engineerOnly || String(u.email).toLowerCase() === me);
  }).map(function (u) { return { email: String(u.email), name: String(u.name || u.email) }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });

  var known = {};
  engineers.forEach(function (e) { known[e.email.toLowerCase()] = true; });
  var onDay = jobs.filter(function (j) { return String(j.scheduledDate || '').slice(0, 10) === date && String(j.engineerEmail || ''); });
  // A job given to somebody who has since left Users still goes out; it is shown, under them.
  onDay.forEach(function (j) {
    var e = String(j.engineerEmail).toLowerCase();
    if (!known[e] && (!engineerOnly || e === me)) {
      known[e] = true;
      engineers.push({ email: String(j.engineerEmail), name: personLine_(j.engineerEmail, people) });
    }
  });
  var order = function (a, b) {
    return (a.scheduledTime || '99:99').localeCompare(b.scheduledTime || '99:99') || a.jobNo.localeCompare(b.jobNo);
  };
  var plan = engineers.map(function (e) {
    return {
      email: e.email, name: e.name,
      visits: onDay.filter(function (j) { return String(j.engineerEmail).toLowerCase() === e.email.toLowerCase(); })
        .map(function (j) { return planJob_(j, cities, people); }).sort(order)
    };
  });

  var out = {
    date: date, today: today, plan: plan,
    visits: plan.reduce(function (n, p) { return n + p.visits.length; }, 0),
    canAssign: SERVICE_ASSIGNERS.indexOf(user.role) !== -1,
    engineers: readTable_('Users').filter(function (u) {
      return String(u.active).toUpperCase() !== 'FALSE' && String(u.role) === ROLES.SERVICE_ENGINEER;
    }).map(function (u) { return { email: String(u.email), name: String(u.name || u.email) }; })
  };
  if (engineerOnly) {
    out.unassigned = [];
    out.undated = [];
    out.amcDue = [];
    return out;
  }
  out.unassigned = jobs.filter(function (j) { return !String(j.engineerEmail || ''); })
    .map(function (j) { return planJob_(j, cities, people); })
    .sort(function (a, b) {
      var u = function (x) { return x.urgency === 'Immediate' ? 0 : x.urgency === 'Urgent' ? 1 : 2; };
      return u(a) - u(b) || a.date.localeCompare(b.date);
    });
  out.undated = jobs.filter(function (j) { return String(j.engineerEmail || '') && !String(j.scheduledDate || ''); })
    .map(function (j) { return planJob_(j, cities, people); });
  // AMC visits falling due by that day that nobody has made a job of (Amc.gs).
  out.amcDue = listAmc({ window: 60 }).dues.filter(function (d) {
    return d.state !== 'Call made' && d.dueDate <= date;
  });
  return out;
}

/** The time of a visit on its day, from the plan. Blank takes the time off. */
function setServiceJobTime(id, time) {
  var user = getCurrentUser();
  requireRole_(user, SERVICE_ASSIGNERS);
  var job = findRowById_('ServiceJobs', id);
  if (!job) throw new Error('Service job not found.');
  var t = String(time || '').trim();
  if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error('Give the time as hours and minutes, like 10:30.');
  updateRowById_('ServiceJobs', 'id', id, { scheduledTime: t }, t ? 'Visit time set to ' + t : 'Visit time cleared');
  return { id: String(id), scheduledTime: t };
}
