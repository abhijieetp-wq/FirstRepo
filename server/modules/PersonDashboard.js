/**
 * Converted from src/PersonDashboard.gs by migration/to-async.js.
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
 * ERP 2.0's dashboard per person: what is on this person's desk today, in the order they
 * would work it. Shown above ERP 1's control tower on the 2.0 face (JavaScript.html,
 * FACE_V2); the control tower, with its nine checks and its charts, is unchanged under it.
 *
 * One section per position, all of it read from what ERP 1 already keeps:
 *
 *   - Sales Coordinator: their open enquiries (the enquiry board's cards they own), the
 *     follow-ups due, the offers waiting for the customer's answer, the drafts for customers
 *     they look after, their orders this month, and their SDR calls.
 *   - Sales Engineer: the leads they found, the follow-ups due on them, their offers out, and
 *     what was won from them this month.
 *   - Service Coordinator: jobs to assign, visits today and tomorrow, breakdowns open.
 *   - Service Engineer: their visits today and tomorrow, open jobs, and the enquiries and leads
 *     they passed to sales — counts only, because service does not see the commercial side
 *     (requireCommercial_), here or anywhere.
 *   - Management and ERP Admin: the team, one row a person, and any person's own dashboard
 *     by picking them.
 *   - Everybody: a tile for their tasks, open and overdue, and their score this month
 *     (Tasks.gs). Management's counts everybody's.
 *   - Management and the sales side: a tile for escalated deals waiting for a decision
 *     (Escalations.gs).
 *
 * Nothing here writes. A figure is a count, a value and where to go to act on it.
 */

/** Which section a role gets. */
var PD_KIND = {
  'Sales Coordinator': 'coordinator',
  'Sales Engineer': 'salesEngineer',
  'Service Coordinator': 'serviceCoordinator',
  'Service Engineer': 'serviceEngineer',
  'Management': 'boss',
  'ERP Admin': 'boss'
};

/** Offers out with the customer, by ERP 1's statuses (Negotiating reads as sent). */
var PD_OUT_STATUSES = ['Submitted', 'Negotiating'];

/**
 * The person's dashboard.
 *
 * @param options { as: email } — Management and ERP Admin may look at anybody's; everybody
 *        else always gets their own, whatever they ask for.
 */
async function getPersonDashboard(options) {
  var user = getCurrentUser();
  var opts = options || {};
  var boss = PD_KIND[user.role] === 'boss';
  var wanted = String(opts.as || '').trim().toLowerCase();
  var person = user;
  if (wanted && wanted !== String(user.email).toLowerCase()) {
    if (!boss) throw new Error('Only Management can look at somebody else’s dashboard.');
    person = (await readTable_('Users')).filter(function (u) {
      return String(u.email || '').toLowerCase() === wanted;
    })[0];
    if (!person) throw new Error('There is nobody with that address in Users.');
  }

  var kind = PD_KIND[person.role] || 'coordinator';
  var today = todayIso_();
  var ctx = {
    viewer: user, person: person, email: String(person.email || '').toLowerCase(),
    today: today, tomorrow: addDays_(today, 1), month: today.slice(0, 7),
    people: await userNameMap_()
  };

  var out = {
    person: { email: String(person.email || ''), name: String(person.name || person.email || ''),
      role: String(person.role || ''), stream: String(person.businessStream || '') },
    self: ctx.email === String(user.email).toLowerCase(),
    kind: kind, today: today, tiles: [], lists: []
  };
  if (kind === 'coordinator') await pdCoordinator_(ctx, out);
  else if (kind === 'salesEngineer') await pdSalesEngineer_(ctx, out);
  else if (kind === 'serviceCoordinator') await pdServiceCoordinator_(ctx, out);
  else if (kind === 'serviceEngineer') await pdServiceEngineer_(ctx, out);
  else await pdBoss_(ctx, out);
  await pdTasks_(ctx, out, kind === 'boss');
  if (kind === 'boss' || kind === 'coordinator' || kind === 'salesEngineer') await pdEscalations_(ctx, out, kind === 'boss');

  if (boss) {
    out.canViewAs = true;
    out.everyone = (await readTable_('Users')).filter(function (u) {
      return String(u.active).toUpperCase() !== 'FALSE' && PD_KIND[u.role];
    }).map(function (u) {
      return { email: String(u.email), name: String(u.name || u.email), role: String(u.role) };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  return out;
}

/**
 * The tasks tile (Tasks.gs): the person's open tasks, how many are overdue and their score
 * this month. For Management, everybody's overdue tasks and the team's score.
 */
async function pdTasks_(ctx, out, everyone) {
  var t = await taskSummary_(ctx.email, everyone);
  if (!t) return;
  var score = t.score === null ? 'no score yet' : 'score ' + t.score + '%';
  out.tiles.push(everyone
    ? { key: 'tasks', label: 'Tasks overdue', value: String(t.overdue), sub: t.open + ' open · team ' + score + ' this month',
      tone: t.overdue ? 'bad' : '', go: 'tasks' }
    : { key: 'tasks', label: 'My tasks', value: String(t.open), sub: t.overdue + ' overdue · ' + score + ' this month',
      tone: t.overdue ? 'bad' : '', go: 'tasks' });
}

/**
 * The escalations tile (Escalations.gs). Management: every deal waiting for a decision. The
 * sales side: what was escalated to them, shown only when something waits on them or theirs
 * waits on somebody.
 */
async function pdEscalations_(ctx, out, everyone) {
  var x = await escSummary_(ctx.email, everyone);
  if (everyone) {
    out.tiles.push({ key: 'escalations', label: 'Waiting for a decision', value: String(x.toThem),
      sub: x.waitingLong ? x.waitingLong + ' waiting over 3 days' : 'escalated deals', tone: x.waitingLong ? 'warn' : '', go: 'escalations' });
  } else if (x.toThem || x.theirs) {
    out.tiles.push({ key: 'escalations', label: 'Escalated to you', value: String(x.toThem),
      sub: x.theirs + ' of yours waiting for a decision', tone: x.toThem ? 'warn' : '', go: 'escalations' });
  }
}

// ------------------------------------------------------------------ shared readings

function pdSame_(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
function pdSum_(rows, f) { return rows.reduce(function (s, r) { return s + (Number(f(r)) || 0); }, 0); }

/** The desks a person works: their stream, or both. */
function pdDesks_(person) {
  var s = String(person.businessStream || '');
  if (s === STREAM_SPARE || s === STREAM_COMPRESSOR) return [s];
  return [STREAM_SPARE, STREAM_COMPRESSOR];
}

/**
 * The enquiry board's cards on the desks both the viewer and the person work. The board is
 * the one place that already knows where every enquiry stands, so it is read rather than
 * worked out a second time.
 */
async function pdBoardCards_(ctx) {
  var cards = [];
  // A loop, not forEach: reading the board waits on the database on the server.
  for (var stream of pdDesks_(ctx.person)) {
    if (!streamAllowed_(ctx.viewer, stream)) continue;
    var board = await getEnquiryBoard({ stream: stream });
    board.cards.forEach(function (c) { c.stream = board.stream; cards.push(c); });
  }
  return cards;
}

/** The newest revision of every quotation, read once. */
async function pdQuotes_() {
  var all = await readTable_('Quotations');
  var current = supersededFilter_(all);
  return all.filter(function (q) { return current(q) && String(q.status) !== 'Revised'; });
}

async function pdCustomerNames_() {
  var out = {};
  (await readTable_('Customers')).forEach(function (c) { out[String(c.id)] = c; });
  return out;
}

/** Orders this month, cancelled ones aside, with the quotation each came from. */
async function pdOrdersThisMonth_(ctx) {
  return (await readTable_('SalesOrders')).filter(function (o) {
    return String(o.date || '').slice(0, 7) === ctx.month && String(o.orderStatus) !== 'Cancelled';
  });
}

/** One line on a list: what, where it stands, and what opens it. */
function pdRow_(title, sub, right, rightSub, tone, open) {
  return { title: title || '—', sub: sub || '', right: right || '', rightSub: rightSub || '', tone: tone || '', open: open || null };
}

function pdQuoteRow_(q, customers, ctx, mode) {
  var c = customers[String(q.customerId)] || {};
  var late = q.validUntil && String(q.validUntil) < ctx.today;
  return pdRow_(c.name, q.quoteNo + (q.revision && q.revision !== 'R0' ? ' ' + q.revision : '') +
      (mode === 'approve' ? ' · by ' + personLine_(q.preparedBy, ctx.people) : ' · ' + String(q.businessStream || '')),
    q.grand === '' ? '' : Number(q.grand) || 0,
    mode === 'approve' ? 'prepared ' + ddmmyyyy_(String(q.date || '').slice(0, 10))
      : (late ? 'validity ran out ' : 'valid till ') + ddmmyyyy_(String(q.validUntil || '').slice(0, 10)),
    late ? 'bad' : '', { kind: 'quotation', id: String(q.id) });
}

// ------------------------------------------------------------------ the five sections

async function pdCoordinator_(ctx, out) {
  var cards = (await pdBoardCards_(ctx)).filter(function (c) { return pdSame_(c.ownerEmail, ctx.email); });
  var open = cards.filter(function (c) { return c.stage !== 'lost' && c.stage !== 'dispatched'; });
  var due = open.filter(function (c) { return c.followUp && c.followUp <= ctx.tomorrow; })
    .sort(function (a, b) { return String(a.followUp).localeCompare(String(b.followUp)); });
  var late = due.filter(function (c) { return c.followUp < ctx.today; });

  var quotes = await pdQuotes_();
  var customers = await pdCustomerNames_();
  var waiting = quotes.filter(function (q) {
    return PD_OUT_STATUSES.indexOf(String(q.status)) !== -1 && pdSame_(q.preparedBy, ctx.email);
  }).sort(function (a, b) { return String(a.validUntil || '').localeCompare(String(b.validUntil || '')); });
  // Drafts for the customers this person looks after, or their own where nobody is named:
  // the offers that wait on them before they can go out (quoteApprovalRule_).
  var toApprove = quotes.filter(function (q) {
    if (String(q.status) !== 'Draft' || !(Number(q.grand) > 0)) return false;
    var incharge = coordinatorInCharge_(customers[String(q.customerId)]);
    return incharge ? pdSame_(incharge, ctx.email) : pdSame_(q.preparedBy, ctx.email);
  }).sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });

  var mineQuote = {};
  quotes.forEach(function (q) { if (pdSame_(q.preparedBy, ctx.email)) mineQuote[String(q.id)] = true; });
  var orders = (await pdOrdersThisMonth_(ctx)).filter(function (o) {
    return o.quotationId ? mineQuote[String(o.quotationId)] : pdSame_(o.ownerEmail, ctx.email);
  });

  var sdr = [];
  var sdrDue = [];
  if (pdDesks_(ctx.person).indexOf(STREAM_SPARE) !== -1 && streamAllowed_(ctx.viewer, STREAM_SPARE)) {
    (await readTable_('ServiceDueCalls')).forEach(function (c) {
      if (!pdSame_(c.ownerEmail, ctx.email) || String(c.outcome || '')) return;
      if (!String(c.callDate || '')) sdr.push(c);
      else if (c.nextFollowUpDate && String(c.nextFollowUpDate) <= ctx.today) sdrDue.push(c);
    });
  }

  out.tiles = [
    { key: 'open', label: 'My open enquiries', value: String(open.length), money: pdSum_(open, function (c) { return c.value; }), sub: 'in play', go: 'enquiries' },
    { key: 'due', label: 'Follow-ups due', value: String(due.length), sub: late.length ? late.length + ' past their date' : 'today and tomorrow', tone: late.length ? 'bad' : due.length ? 'warn' : '' },
    { key: 'waiting', label: 'Waiting for the customer’s answer', value: String(waiting.length), money: pdSum_(waiting, function (q) { return q.grand; }), sub: 'offered', go: 'quotations' },
    { key: 'approve', label: 'Drafts to approve and send', value: String(toApprove.length), sub: 'customers I look after', tone: toApprove.length ? 'warn' : '', go: 'quotations' },
    { key: 'orders', label: 'My orders this month', value: String(orders.length), money: pdSum_(orders, function (o) { return o.grand; }), sub: 'booked', go: 'orders' }
  ];
  if (sdr.length || sdrDue.length) {
    out.tiles.push({ key: 'sdr', label: 'SDR calls to make', value: String(sdr.length), sub: sdrDue.length + ' follow-ups due', tone: sdrDue.length ? 'warn' : '', go: 'servicedue' });
  }

  out.lists.push({ key: 'due', title: 'Follow-ups due', count: due.length, empty: 'Nothing due today or tomorrow.',
    rows: due.slice(0, 8).map(function (c) { return pdCardRow_(c, ctx); }) });
  out.lists.push({ key: 'approve', title: 'Drafts to approve and send', count: toApprove.length,
    empty: 'No drafts waiting on you.',
    rows: toApprove.slice(0, 8).map(function (q) { return pdQuoteRow_(q, customers, ctx, 'approve'); }) });
  out.lists.push({ key: 'waiting', title: 'Waiting for the customer’s answer', count: waiting.length,
    empty: 'No offers out with customers.',
    rows: waiting.slice(0, 8).map(function (q) { return pdQuoteRow_(q, customers, ctx, 'waiting'); }) });
}

/** A board card as a line on a list. */
function pdCardRow_(c, ctx) {
  var late = c.followUp && c.followUp < ctx.today;
  return pdRow_(c.customerName, c.no + ' · ' + (c.what || c.stream || ''), c.value,
    (c.followUpLabel || 'Due') + ' ' + ddmmyyyy_(c.followUp), late ? 'bad' : 'warn',
    c.kind === 'quotation' ? { kind: 'quotation', id: c.id } : { kind: c.kind, id: c.id });
}

async function pdSalesEngineer_(ctx, out) {
  var leads = (await readTable_('Leads')).filter(function (l) { return pdSame_(l.salesEngineerEmail, ctx.email); });
  var openLeads = leads.filter(function (l) { return ['Converted', 'Disqualified'].indexOf(String(l.status)) === -1; });
  var due = openLeads.filter(function (l) { return l.nextActionDate && String(l.nextActionDate) <= ctx.tomorrow; })
    .sort(function (a, b) { return String(a.nextActionDate).localeCompare(String(b.nextActionDate)); });
  var opps = (await readTable_('Opportunities')).filter(function (o) { return pdSame_(o.salesEngineerEmail, ctx.email); });
  var oppIds = {};
  opps.forEach(function (o) { oppIds[String(o.id)] = true; });
  var quotes = await pdQuotes_();
  var customers = await pdCustomerNames_();
  var mine = quotes.filter(function (q) { return pdSame_(q.preparedBy, ctx.email) || oppIds[String(q.opportunityId)]; });
  var mineIds = {};
  mine.forEach(function (q) { mineIds[String(q.id)] = true; });
  var waiting = mine.filter(function (q) { return PD_OUT_STATUSES.indexOf(String(q.status)) !== -1; });
  var won = (await pdOrdersThisMonth_(ctx)).filter(function (o) { return mineIds[String(o.quotationId)]; });
  var openOpps = opps.filter(function (o) { return ['Won', 'Lost'].indexOf(String(o.stage)) === -1; });

  out.tiles = [
    { key: 'leads', label: 'Leads I found, still open', value: String(openLeads.length + openOpps.length), sub: openOpps.length + ' in the pipeline', go: 'compressor' },
    { key: 'due', label: 'Follow-ups due', value: String(due.length), sub: 'today and tomorrow', tone: due.some(function (l) { return String(l.nextActionDate) < ctx.today; }) ? 'bad' : due.length ? 'warn' : '' },
    { key: 'waiting', label: 'Offers out with customers', value: String(waiting.length), money: pdSum_(waiting, function (q) { return q.grand; }), sub: 'offered', go: 'quotations' },
    { key: 'won', label: 'Won this month', value: String(won.length), money: pdSum_(won, function (o) { return o.grand; }), sub: 'from my leads and offers' }
  ];
  out.lists.push({ key: 'due', title: 'Follow-ups due', count: due.length, empty: 'Nothing due today or tomorrow.',
    rows: due.slice(0, 8).map(function (l) {
      var c = customers[String(l.customerId)] || {};
      return pdRow_(c.name || l.customerName, String(l.leadNo || '') + ' · ' + String(l.requirementSummary || ''), '',
        'next action ' + ddmmyyyy_(String(l.nextActionDate).slice(0, 10)), String(l.nextActionDate) < ctx.today ? 'bad' : 'warn',
        { kind: 'lead', id: String(l.id) });
    }) });
  out.lists.push({ key: 'waiting', title: 'Offers out with customers', count: waiting.length, empty: 'No offers out.',
    rows: waiting.slice(0, 8).map(function (q) { return pdQuoteRow_(q, customers, ctx, 'waiting'); }) });
}

async function pdJobs_() {
  try { return await readTable_('ServiceJobs'); } catch (err) { return []; }
}
function pdJobOpen_(j) { return ['Completed', 'Cancelled'].indexOf(String(j.status)) === -1; }
function pdJobRow_(j, ctx, showEngineer) {
  return pdRow_(String(j.customerName || ''), String(j.jobNo || '') + ' · ' + (j.jobType || 'Installation') + ' · ' +
      [j.machineModel, j.serialNo].filter(Boolean).join(' '),
    showEngineer ? (j.engineerEmail ? personLine_(j.engineerEmail, ctx.people) : 'Not assigned') : serviceDeskStatus_(j),
    j.scheduledDate ? ddmmyyyy_(String(j.scheduledDate).slice(0, 10)) : String(j.urgency || ''),
    String(j.urgency) === 'Immediate' || (!j.engineerEmail && showEngineer) ? 'bad' : '',
    { kind: 'job', id: String(j.id) });
}

async function pdServiceCoordinator_(ctx, out) {
  var jobs = await pdJobs_();
  var open = jobs.filter(pdJobOpen_);
  var fresh = open.filter(function (j) { return String(j.status) === 'Unassigned' || !String(j.engineerEmail || ''); });
  var soon = open.filter(function (j) {
    var d = String(j.scheduledDate || '').slice(0, 10);
    return d === ctx.today || d === ctx.tomorrow;
  }).sort(function (a, b) { return String(a.scheduledDate).localeCompare(String(b.scheduledDate)); });
  var breakdowns = open.filter(function (j) { return String(j.jobType) === 'Breakdown'; });
  var done = jobs.filter(function (j) { return String(j.status) === 'Completed' && String(j.completedDate || '').slice(0, 7) === ctx.month; });
  // The engineer has written the job up; it waits on the coordinator (ServiceDesk.gs).
  var reports = open.filter(function (j) { return serviceDeskStatus_(j) === 'Report submitted'; });
  out.tiles = [
    { key: 'open', label: 'Open jobs', value: String(open.length), sub: done.length + ' closed this month', go: 'service' },
    { key: 'fresh', label: 'Waiting for an engineer', value: String(fresh.length), sub: 'assign them', tone: fresh.length ? 'warn' : '', go: 'service' },
    { key: 'reports', label: 'Reports in, to close', value: String(reports.length), sub: 'you close these', tone: reports.length ? 'warn' : '', go: 'service' },
    { key: 'soon', label: 'Visits today and tomorrow', value: String(soon.length), sub: pdEngineerCount_(soon) + ' engineers out', go: 'service' },
    { key: 'breakdowns', label: 'Breakdowns open', value: String(breakdowns.length), sub: 'machines stopped', tone: breakdowns.length ? 'bad' : '', go: 'service' }
  ];
  // AMC visits falling due this week that nobody has made a job of yet (Amc.gs).
  var amcDue = (await listAmc({ window: 7 })).dues.filter(function (d) { return d.state !== 'Call made'; });
  var amcLate = amcDue.filter(function (d) { return d.state === 'Overdue'; }).length;
  out.tiles.push({ key: 'amc', label: 'AMC visits due', value: String(amcDue.length), sub: amcLate + ' overdue, this week’s too',
    tone: amcLate ? 'bad' : amcDue.length ? 'warn' : '', go: 'amc' });
  out.lists.push({ key: 'fresh', title: 'New jobs to assign', count: fresh.length, empty: 'Every job has an engineer.',
    rows: fresh.slice(0, 8).map(function (j) { return pdJobRow_(j, ctx, true); }) });
  out.lists.push({ key: 'reports', title: 'Reports in, to close', count: reports.length, empty: 'No reports waiting.',
    rows: reports.slice(0, 8).map(function (j) { return pdJobRow_(j, ctx, true); }) });
  out.lists.push({ key: 'soon', title: 'Visits today and tomorrow', count: soon.length, empty: 'Nothing scheduled.',
    rows: soon.slice(0, 8).map(function (j) { return pdJobRow_(j, ctx, true); }) });
  out.lists.push({ key: 'breakdowns', title: 'Breakdowns open', count: breakdowns.length, empty: 'No machine is down.',
    rows: breakdowns.slice(0, 8).map(function (j) { return pdJobRow_(j, ctx, true); }) });
}

function pdEngineerCount_(jobs) {
  var seen = {};
  jobs.forEach(function (j) { if (j.engineerEmail) seen[String(j.engineerEmail).toLowerCase()] = true; });
  return Object.keys(seen).length;
}

async function pdServiceEngineer_(ctx, out) {
  var mine = (await pdJobs_()).filter(function (j) { return pdSame_(j.engineerEmail, ctx.email); });
  var open = mine.filter(pdJobOpen_);
  var today = open.filter(function (j) { return String(j.scheduledDate || '').slice(0, 10) === ctx.today; });
  var tomorrow = open.filter(function (j) { return String(j.scheduledDate || '').slice(0, 10) === ctx.tomorrow; });
  var done = mine.filter(function (j) { return String(j.status) === 'Completed' && String(j.completedDate || '').slice(0, 7) === ctx.month; });
  var raised = (await readTable_('SpareEnquiries')).filter(function (e) {
    return pdSame_(e.serviceEngineerEmail, ctx.email) && String(e.date || '').slice(0, 7) === ctx.month;
  });
  var passed = (await readTable_('Leads')).filter(function (l) {
    return pdSame_(l.serviceEngineerEmail, ctx.email) && String(l.date || '').slice(0, 7) === ctx.month;
  });
  // Visited, not yet written up: the report is what lets the coordinator close the job.
  var toWrite = open.filter(function (j) { return serviceDeskStatus_(j) === 'In progress'; });
  out.tiles = [
    { key: 'today', label: 'Visits today', value: String(today.length), sub: tomorrow.length + ' tomorrow', go: 'service' },
    { key: 'open', label: 'My open jobs', value: String(open.length), sub: done.length + ' closed this month', go: 'service' },
    { key: 'write', label: 'Reports to write', value: String(toWrite.length), sub: 'jobs in progress', tone: toWrite.length ? 'warn' : '', go: 'service' },
    { key: 'raised', label: 'Spare enquiries I raised', value: String(raised.length), sub: 'this month' },
    { key: 'passed', label: 'Compressor leads I passed on', value: String(passed.length), sub: 'this month' }
  ];
  out.lists.push({ key: 'today', title: 'Today', count: today.length, empty: 'No visits today.',
    rows: today.map(function (j) { return pdJobRow_(j, ctx, false); }) });
  out.lists.push({ key: 'tomorrow', title: 'Tomorrow', count: tomorrow.length, empty: 'Nothing planned for tomorrow yet.',
    rows: tomorrow.map(function (j) { return pdJobRow_(j, ctx, false); }) });
}

/**
 * The team, one row a person: what each has open, what is late, what is out with customers
 * and what they booked this month. Pressing a name opens that person's own dashboard.
 */
async function pdBoss_(ctx, out) {
  var users = (await readTable_('Users')).filter(function (u) {
    return String(u.active).toUpperCase() !== 'FALSE' && ['Sales Coordinator', 'Sales Engineer'].indexOf(String(u.role)) !== -1;
  });
  var cards = [];
  for (var s of [STREAM_SPARE, STREAM_COMPRESSOR]) {
    if (!streamAllowed_(ctx.viewer, s)) continue;
    var board = await getEnquiryBoard({ stream: s });
    board.cards.forEach(function (c) { c.stream = board.stream; cards.push(c); });
  }
  var quotes = await pdQuotes_();
  var byQuote = {};
  quotes.forEach(function (q) { byQuote[String(q.id)] = q; });
  var orders = await pdOrdersThisMonth_(ctx);
  var calls = [];
  try { calls = await readTable_('ServiceDueCalls'); } catch (err) { calls = []; }

  out.team = users.map(function (u) {
    var e = String(u.email).toLowerCase();
    // The desks the person works, so the row says what their own dashboard says.
    var desks = pdDesks_(u);
    var mine = cards.filter(function (c) {
      return pdSame_(c.ownerEmail, e) && desks.indexOf(c.stream) !== -1 && c.stage !== 'lost' && c.stage !== 'dispatched';
    });
    var late = mine.filter(function (c) { return c.followUp && c.followUp < ctx.today; });
    var waiting = quotes.filter(function (q) { return pdSame_(q.preparedBy, e) && PD_OUT_STATUSES.indexOf(String(q.status)) !== -1; });
    var booked = orders.filter(function (o) {
      var q = byQuote[String(o.quotationId)];
      return q ? pdSame_(q.preparedBy, e) : pdSame_(o.ownerEmail, e);
    });
    var sdr = calls.filter(function (c) { return pdSame_(c.ownerEmail, e) && !String(c.outcome || '') && !String(c.callDate || ''); });
    return {
      email: String(u.email), name: String(u.name || u.email), role: String(u.role),
      open: mine.length, openValue: pdSum_(mine, function (c) { return c.value; }),
      late: late.length,
      waiting: waiting.length, waitingValue: pdSum_(waiting, function (q) { return q.grand; }),
      booked: booked.length, bookedValue: pdSum_(booked, function (o) { return o.grand; }),
      sdr: sdr.length
    };
  }).sort(function (a, b) { return b.openValue - a.openValue || a.name.localeCompare(b.name); });

  var open = cards.filter(function (c) { return c.stage !== 'lost' && c.stage !== 'dispatched'; });
  var late = open.filter(function (c) { return c.followUp && c.followUp < ctx.today; });
  var waiting = quotes.filter(function (q) { return PD_OUT_STATUSES.indexOf(String(q.status)) !== -1; });
  out.tiles = [
    { key: 'open', label: 'Open enquiries', value: String(open.length), money: pdSum_(open, function (c) { return c.value; }), sub: 'in play, both desks', go: 'enquiries' },
    { key: 'late', label: 'Follow-ups past their date', value: String(late.length), sub: 'across the team', tone: late.length ? 'bad' : '' },
    { key: 'waiting', label: 'Waiting for customers’ answers', value: String(waiting.length), money: pdSum_(waiting, function (q) { return q.grand; }), sub: 'offered', go: 'quotations' },
    { key: 'orders', label: 'Orders this month', value: String(orders.length), money: pdSum_(orders, function (o) { return o.grand; }), sub: 'booked', go: 'orders' }
  ];
}
