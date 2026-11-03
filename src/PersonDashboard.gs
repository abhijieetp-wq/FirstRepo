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
 *   - A tile for this week's customer visits, visited of planned (VisitPlans.gs).
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

/** How each period reads in a tile: "My orders this month", "Won last month". */
var PD_PERIOD_WORDS = { month: 'this month', lastmonth: 'last month', quarter: 'this quarter', fy: 'this financial year', custom: 'in the range' };

/** A day inside the dashboard's period. */
function pdIn_(day, ctx) { var d = String(day || '').slice(0, 10); return !!d && d >= ctx.period.from && d <= ctx.period.to; }

/** Offers out with the customer, by ERP 1's statuses (Negotiating reads as sent). */
var PD_OUT_STATUSES = ['Submitted', 'Negotiating'];

/**
 * The person's dashboard.
 *
 * @param options { as: email } — Management and ERP Admin may look at anybody's; everybody
 *        else always gets their own, whatever they ask for.
 */
function getPersonDashboard(options) {
  var user = getCurrentUser();
  var opts = options || {};
  var boss = PD_KIND[user.role] === 'boss';
  var wanted = String(opts.as || '').trim().toLowerCase();
  var person = user;
  if (wanted && wanted !== String(user.email).toLowerCase()) {
    if (!boss) throw new Error('Only Management can look at somebody else’s dashboard.');
    person = readTable_('Users').filter(function (u) {
      return String(u.email || '').toLowerCase() === wanted;
    })[0];
    if (!person) throw new Error('There is nobody with that address in Users.');
  }

  var kind = PD_KIND[person.role] || 'coordinator';
  var today = todayIso_();
  // ERP 2's period selector: what "this month" means on the desk (Tasks.gs's periods).
  var period = taskPeriod_(opts, today);
  var ctx = {
    viewer: user, person: person, email: String(person.email || '').toLowerCase(),
    today: today, tomorrow: addDays_(today, 1), month: today.slice(0, 7),
    period: period, word: PD_PERIOD_WORDS[period.key] || 'in the period',
    people: userNameMap_()
  };

  var out = {
    person: { email: String(person.email || ''), name: String(person.name || person.email || ''),
      role: String(person.role || ''), stream: String(person.businessStream || '') },
    self: ctx.email === String(user.email).toLowerCase(),
    kind: kind, today: today, tiles: [], lists: [],
    period: period, periods: TASK_PERIODS, periodWord: ctx.word
  };
  if (kind === 'coordinator') pdCoordinator_(ctx, out);
  else if (kind === 'salesEngineer') pdSalesEngineer_(ctx, out);
  else if (kind === 'serviceCoordinator') pdServiceCoordinator_(ctx, out);
  else if (kind === 'serviceEngineer') pdServiceEngineer_(ctx, out);
  else pdBoss_(ctx, out);
  // Management's tasks, escalations and visits are among the demo's eight tiles (pdBoss_).
  if (kind !== 'boss') {
    pdTasks_(ctx, out, false);
    if (kind === 'coordinator' || kind === 'salesEngineer') pdEscalations_(ctx, out, false);
    if (kind === 'coordinator' || kind === 'salesEngineer') pdVisits_(ctx, out, kind);
  }
  pdTaskList_(ctx, out, kind === 'boss');

  if (boss) {
    out.canViewAs = true;
    out.everyone = readTable_('Users').filter(function (u) {
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
function pdTasks_(ctx, out, everyone) {
  var t = taskSummary_(ctx.email, everyone, ctx.period);
  if (!t) return;
  var score = t.score === null ? 'no score yet' : 'score ' + t.score + '%';
  out.tiles.push(everyone
    ? { key: 'tasks', label: 'Tasks overdue', value: String(t.overdue), sub: t.open + ' open · team ' + score + ' ' + ctx.word,
      tone: t.overdue ? 'bad' : '', go: 'tasks' }
    : { key: 'tasks', label: 'My tasks', value: String(t.open), sub: t.overdue + ' overdue · ' + score + ' ' + ctx.word,
      tone: t.overdue ? 'bad' : '', go: 'tasks' });
}

/**
 * The escalations tile (Escalations.gs). Management: every deal waiting for a decision. The
 * sales side: what was escalated to them, shown only when something waits on them or theirs
 * waits on somebody.
 */
function pdEscalations_(ctx, out, everyone) {
  var x = escSummary_(ctx.email, everyone);
  if (everyone) {
    out.tiles.push({ key: 'escalations', label: 'Waiting for a decision', value: String(x.toThem),
      sub: x.waitingLong ? x.waitingLong + ' waiting over 3 days' : 'escalated deals', tone: x.waitingLong ? 'warn' : '', go: 'escalations' });
  } else if (x.toThem || x.theirs) {
    out.tiles.push({ key: 'escalations', label: 'Escalated to you', value: String(x.toThem),
      sub: x.theirs + ' of yours waiting for a decision', tone: x.toThem ? 'warn' : '', go: 'escalations' });
  }
}

/**
 * The visits tile (VisitPlans.gs): this week's visits, Monday to Sunday. A sales engineer
 * always has it; a coordinator when they have visits planned; Management, the team's.
 */
function pdVisits_(ctx, out, kind) {
  var x = visitSummary_(ctx.email, kind === 'boss');
  if (!x || (kind === 'coordinator' && !x.planned)) return;
  out.tiles.push({ key: 'visits', label: kind === 'boss' ? 'Team visits this week' : 'Visits this week',
    value: x.visited + ' of ' + x.planned,
    sub: (kind === 'boss' ? '' : x.today + ' planned today · ') + x.enquiries + (x.enquiries === 1 ? ' enquiry' : ' enquiries') + ' made',
    go: 'visits' });
}

/**
 * The demo's tasks panel: tasks overdue or due today. The person's own; for Management,
 * everybody's, each with whose it is.
 */
function pdTaskList_(ctx, out, everyone) {
  var all = [];
  try { all = readTable_('Tasks').filter(taskLive_); } catch (err) { return; }
  var scoring = taskScoring_();
  var rows = all.filter(function (t) {
    if (!everyone && !pdSame_(t.assigneeEmail, ctx.email)) return false;
    var s = taskState_(t, scoring, ctx.today).state;
    return s === 'overdue' || s === 'today';
  }).sort(function (a, b) { return String(a.dueDate).localeCompare(String(b.dueDate)) || String(a.title).localeCompare(String(b.title)); });
  out.lists.push({ key: 'tasks', title: everyone ? 'Overdue and due today' : 'My tasks', count: rows.length,
    empty: 'Nothing overdue or due today.', addTask: true,
    rows: rows.slice(0, 8).map(function (t) {
      var due = String(t.dueDate || '').slice(0, 10);
      var over = due < ctx.today;
      return pdRow_(String(t.title || ''), (everyone ? personLine_(t.assigneeEmail, ctx.people) + ' · ' : '') + String(t.priority || 'Normal'),
        '', over ? pdDay_(due) : 'Today', '', { kind: 'task', id: String(t.id) }, over ? 'bad' : 'warn');
    }) });
}

/** A day as the demo writes it on a panel: "09 Oct", with the year only when it is not this one. */
var PD_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function pdDay_(iso) {
  var d = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return d.slice(8, 10) + ' ' + PD_MONTHS[Number(d.slice(5, 7)) - 1] + (d.slice(0, 4) !== todayIso_().slice(0, 4) ? ' ' + d.slice(0, 4) : '');
}

/** AMC visits overdue or due within a week (Amc.gs), for whoever may see them. */
function pdAmcDues_() {
  try { return listAmc({ window: 7 }).dues; } catch (err) { return []; }
}

function pdAmcRow_(d, ctx) {
  var late = d.state === 'Overdue';
  var lateBy = late ? daysBetween_(d.dueDate, ctx.today) : 0;
  return pdRow_(d.customerName, [d.serialNo || d.machineModel, 'AMC visit ' + d.visitNo + ' of ' + (d.visitOf || d.visitNo), d.amcType].filter(Boolean).join(' · '),
    pdDay_(d.dueDate) + (late ? ' · ' + lateBy + ' d late' : ''),
    d.state === 'Call made' ? 'Call made' : 'Make a call', late ? 'bad' : '',
    { kind: 'amc', id: d.contractId }, d.state === 'Call made' ? 'service' : 'warn');
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
function pdBoardCards_(ctx) {
  var cards = [];
  // A loop, not forEach: reading the board waits on the database on the server.
  for (var stream of pdDesks_(ctx.person)) {
    if (!streamAllowed_(ctx.viewer, stream)) continue;
    var board = getEnquiryBoard({ stream: stream });
    board.cards.forEach(function (c) { c.stream = board.stream; cards.push(c); });
  }
  return cards;
}

/** The newest revision of every quotation, read once. */
function pdQuotes_() {
  var all = readTable_('Quotations');
  var current = supersededFilter_(all);
  return all.filter(function (q) { return current(q) && String(q.status) !== 'Revised'; });
}

function pdCustomerNames_() {
  var out = {};
  readTable_('Customers').forEach(function (c) { out[String(c.id)] = c; });
  return out;
}

/** Orders this month, cancelled ones aside, with the quotation each came from. */
function pdOrdersThisMonth_(ctx) {
  return readTable_('SalesOrders').filter(function (o) {
    return pdIn_(o.date, ctx) && String(o.orderStatus) !== 'Cancelled';
  });
}

/** One line on a list: what, where it stands, and what opens it. */
function pdRow_(title, sub, right, rightSub, tone, open, chip) {
  // `chip`: show rightSub as a chip of that tone (bad, warn, good, service), as the demo does.
  return { title: title || '—', sub: sub || '', right: right || '', rightSub: rightSub || '', tone: tone || '', open: open || null,
    chip: chip || '' };
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

function pdCoordinator_(ctx, out) {
  var cards = pdBoardCards_(ctx).filter(function (c) { return pdSame_(c.ownerEmail, ctx.email); });
  var open = cards.filter(function (c) { return c.stage !== 'lost' && c.stage !== 'dispatched'; });
  var due = open.filter(function (c) { return c.followUp && c.followUp <= ctx.tomorrow; })
    .sort(function (a, b) { return String(a.followUp).localeCompare(String(b.followUp)); });
  var late = due.filter(function (c) { return c.followUp < ctx.today; });

  var quotes = pdQuotes_();
  var customers = pdCustomerNames_();
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
  var orders = pdOrdersThisMonth_(ctx).filter(function (o) {
    return o.quotationId ? mineQuote[String(o.quotationId)] : pdSame_(o.ownerEmail, ctx.email);
  });

  var sdr = [];
  var sdrDue = [];
  if (pdDesks_(ctx.person).indexOf(STREAM_SPARE) !== -1 && streamAllowed_(ctx.viewer, STREAM_SPARE)) {
    readTable_('ServiceDueCalls').forEach(function (c) {
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
    { key: 'orders', label: 'My orders ' + ctx.word, value: String(orders.length), money: pdSum_(orders, function (o) { return o.grand; }), sub: 'booked', go: 'orders' }
  ];
  if (sdr.length || sdrDue.length) {
    out.tiles.push({ key: 'sdr', label: 'SDR calls to make', value: String(sdr.length), sub: sdrDue.length + ' follow-ups due', tone: sdrDue.length ? 'warn' : '', go: 'servicedue' });
  }

  // ERP 2: the spare enquiries a service engineer raised, still waiting for this coordinator
  // to work them — nothing quoted yet.
  var fromEngineers = [];
  if (pdDesks_(ctx.person).indexOf(STREAM_SPARE) !== -1 && streamAllowed_(ctx.viewer, STREAM_SPARE)) {
    var quoted = {};
    quotes.forEach(function (q) { if (q.spareEnquiryId) quoted[String(q.spareEnquiryId)] = true; });
    fromEngineers = readTable_('SpareEnquiries').filter(function (e) {
      return String(e.serviceEngineerEmail || '') && pdSame_(e.ownerEmail, ctx.email) && !quoted[String(e.id)] &&
        ['New', 'Identifying', ''].indexOf(String(e.status || '')) !== -1;
    }).sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
  }
  if (fromEngineers.length) {
    out.tiles.push({ key: 'engineer', label: 'Raised by service engineers', value: String(fromEngineers.length), sub: 'waiting for you',
      tone: 'warn', go: 'enquiries' });
  }

  out.lists.push({ key: 'due', title: 'Follow-ups due', count: due.length, empty: 'Nothing due today or tomorrow.',
    rows: due.slice(0, 8).map(function (c) { return pdCardRow_(c, ctx); }) });
  if (fromEngineers.length) {
    out.lists.push({ key: 'engineer', title: 'Raised by service engineers, waiting for you', count: fromEngineers.length, empty: '',
      rows: fromEngineers.slice(0, 8).map(function (e) {
        var c = customers[String(e.customerId)] || {};
        var waitDays = daysBetween_(String(e.date || '').slice(0, 10), ctx.today);
        return pdRow_(c.name || e.customerName, String(e.enquiryNo || '') + ' · from ' + personLine_(e.serviceEngineerEmail, ctx.people) +
          (e.productModel ? ' · ' + e.productModel : ''), '', waitDays + (waitDays === 1 ? ' day' : ' days') + ' waiting',
          waitDays > 2 ? 'bad' : 'warn', { kind: 'enquiry', id: String(e.id) });
      }) });
  }
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

function pdSalesEngineer_(ctx, out) {
  var leads = readTable_('Leads').filter(function (l) { return pdSame_(l.salesEngineerEmail, ctx.email); });
  var openLeads = leads.filter(function (l) { return ['Converted', 'Disqualified'].indexOf(String(l.status)) === -1; });
  var due = openLeads.filter(function (l) { return l.nextActionDate && String(l.nextActionDate) <= ctx.tomorrow; })
    .sort(function (a, b) { return String(a.nextActionDate).localeCompare(String(b.nextActionDate)); });
  var opps = readTable_('Opportunities').filter(function (o) { return pdSame_(o.salesEngineerEmail, ctx.email); });
  var oppIds = {};
  opps.forEach(function (o) { oppIds[String(o.id)] = true; });
  var quotes = pdQuotes_();
  var customers = pdCustomerNames_();
  var mine = quotes.filter(function (q) { return pdSame_(q.preparedBy, ctx.email) || oppIds[String(q.opportunityId)]; });
  var mineIds = {};
  mine.forEach(function (q) { mineIds[String(q.id)] = true; });
  var waiting = mine.filter(function (q) { return PD_OUT_STATUSES.indexOf(String(q.status)) !== -1; });
  var won = pdOrdersThisMonth_(ctx).filter(function (o) { return mineIds[String(o.quotationId)]; });
  var openOpps = opps.filter(function (o) { return ['Won', 'Lost'].indexOf(String(o.stage)) === -1; });

  out.tiles = [
    { key: 'leads', label: 'Leads I found, still open', value: String(openLeads.length + openOpps.length), sub: openOpps.length + ' in the pipeline', go: 'compressor' },
    { key: 'due', label: 'Follow-ups due', value: String(due.length), sub: 'today and tomorrow', tone: due.some(function (l) { return String(l.nextActionDate) < ctx.today; }) ? 'bad' : due.length ? 'warn' : '' },
    { key: 'waiting', label: 'Offers out with customers', value: String(waiting.length), money: pdSum_(waiting, function (q) { return q.grand; }), sub: 'offered', go: 'quotations' },
    { key: 'won', label: 'Won ' + ctx.word, value: String(won.length), money: pdSum_(won, function (o) { return o.grand; }), sub: 'from my leads and offers' }
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
  // ERP 2: today's sales visits (VisitPlans.gs).
  var visits = [];
  try {
    visits = readTable_('SalesVisits').filter(function (v) {
      return String(v.active).toUpperCase() !== 'FALSE' && pdSame_(v.engineerEmail, ctx.email) && String(v.visitDate || '').slice(0, 10) === ctx.today;
    });
  } catch (err) { visits = []; }
  var areas = visitAreas_(visitConfig_());
  out.lists.unshift({ key: 'visits', title: 'Today’s visits', count: visits.length, empty: 'No visits planned today.',
    rows: visits.map(function (v) {
      var type = visitAreaType_(v.area, areas);
      return pdRow_(String(v.customerName || ''), [v.purpose, v.area ? v.area + (type ? ' (' + type + ')' : '') : ''].filter(Boolean).join(' · '),
        '', String(v.status || 'Planned'), String(v.status) === 'Not visited' ? 'bad' : String(v.status || 'Planned') === 'Planned' ? 'warn' : '',
        { kind: 'visits', id: String(v.id) });
    }) });
}

function pdJobs_() {
  try { return readTable_('ServiceJobs'); } catch (err) { return []; }
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

function pdServiceCoordinator_(ctx, out) {
  var jobs = pdJobs_();
  var open = jobs.filter(pdJobOpen_);
  var fresh = open.filter(function (j) { return String(j.status) === 'Unassigned' || !String(j.engineerEmail || ''); });
  var soon = open.filter(function (j) {
    var d = String(j.scheduledDate || '').slice(0, 10);
    return d === ctx.today || d === ctx.tomorrow;
  }).sort(function (a, b) { return String(a.scheduledDate).localeCompare(String(b.scheduledDate)); });
  var breakdowns = open.filter(function (j) { return String(j.jobType) === 'Breakdown'; });
  var done = jobs.filter(function (j) { return String(j.status) === 'Completed' && pdIn_(j.completedDate, ctx); });
  // The engineer has written the job up; it waits on the coordinator (ServiceDesk.gs).
  var reports = open.filter(function (j) { return serviceDeskStatus_(j) === 'Report submitted'; });
  out.tiles = [
    { key: 'open', label: 'Open jobs', value: String(open.length), sub: done.length + ' closed ' + ctx.word, go: 'service' },
    { key: 'fresh', label: 'Waiting for an engineer', value: String(fresh.length), sub: 'assign them', tone: fresh.length ? 'warn' : '', go: 'service' },
    { key: 'reports', label: 'Reports in, to close', value: String(reports.length), sub: 'you close these', tone: reports.length ? 'warn' : '', go: 'service' },
    { key: 'soon', label: 'Visits today and tomorrow', value: String(soon.length), sub: pdEngineerCount_(soon) + ' engineers out', go: 'service' },
    { key: 'breakdowns', label: 'Breakdowns open', value: String(breakdowns.length), sub: 'machines stopped', tone: breakdowns.length ? 'bad' : '', go: 'service' }
  ];
  // AMC visits falling due this week that nobody has made a job of yet (Amc.gs).
  var amcAll = pdAmcDues_();
  var amcDue = amcAll.filter(function (d) { return d.state !== 'Call made'; });
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
  out.lists.push({ key: 'amc', title: 'AMC and service dues (overdue + 7 days)', count: amcAll.length, empty: 'No visits due.',
    rows: amcAll.slice(0, 8).map(function (d) { return pdAmcRow_(d, ctx); }) });
}

function pdEngineerCount_(jobs) {
  var seen = {};
  jobs.forEach(function (j) { if (j.engineerEmail) seen[String(j.engineerEmail).toLowerCase()] = true; });
  return Object.keys(seen).length;
}

function pdServiceEngineer_(ctx, out) {
  var mine = pdJobs_().filter(function (j) { return pdSame_(j.engineerEmail, ctx.email); });
  var open = mine.filter(pdJobOpen_);
  var today = open.filter(function (j) { return String(j.scheduledDate || '').slice(0, 10) === ctx.today; });
  var tomorrow = open.filter(function (j) { return String(j.scheduledDate || '').slice(0, 10) === ctx.tomorrow; });
  var done = mine.filter(function (j) { return String(j.status) === 'Completed' && pdIn_(j.completedDate, ctx); });
  var raised = readTable_('SpareEnquiries').filter(function (e) {
    return pdSame_(e.serviceEngineerEmail, ctx.email) && pdIn_(e.date, ctx);
  });
  var passed = readTable_('Leads').filter(function (l) {
    return pdSame_(l.serviceEngineerEmail, ctx.email) && pdIn_(l.date, ctx);
  });
  // Visited, not yet written up: the report is what lets the coordinator close the job.
  var toWrite = open.filter(function (j) { return serviceDeskStatus_(j) === 'In progress'; });
  out.tiles = [
    { key: 'today', label: 'Visits today', value: String(today.length), sub: tomorrow.length + ' tomorrow', go: 'service' },
    { key: 'open', label: 'My open jobs', value: String(open.length), sub: done.length + ' closed ' + ctx.word, go: 'service' },
    { key: 'write', label: 'Reports to write', value: String(toWrite.length), sub: 'jobs in progress', tone: toWrite.length ? 'warn' : '', go: 'service' },
    { key: 'raised', label: 'Spare enquiries I raised', value: String(raised.length), sub: ctx.word },
    { key: 'passed', label: 'Compressor leads I passed on', value: String(passed.length), sub: ctx.word }
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
function pdBoss_(ctx, out) {
  var users = readTable_('Users').filter(function (u) {
    return String(u.active).toUpperCase() !== 'FALSE' && ['Sales Coordinator', 'Sales Engineer'].indexOf(String(u.role)) !== -1;
  });
  var cards = [];
  for (var s of [STREAM_SPARE, STREAM_COMPRESSOR]) {
    if (!streamAllowed_(ctx.viewer, s)) continue;
    var board = getEnquiryBoard({ stream: s });
    board.cards.forEach(function (c) { c.stream = board.stream; cards.push(c); });
  }
  var quotes = pdQuotes_();
  var byQuote = {};
  quotes.forEach(function (q) { byQuote[String(q.id)] = q; });
  var orders = pdOrdersThisMonth_(ctx);
  var calls = [];
  try { calls = readTable_('ServiceDueCalls'); } catch (err) { calls = []; }

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

  pdBossDesk_(ctx, out, cards, quotes, orders);
}

/**
 * Management's desk as the 2.0 demo draws it: eight tiles for the work in the period (the
 * money ones above them come from the control tower, getDashboard), and the panels —
 * decisions waiting, follow-ups due across the team, AMC dues and installations coming up.
 * The nine checks and the receivables ageing are the control tower's too.
 */
function pdBossDesk_(ctx, out, cards, quotes, orders) {
  var customers = pdCustomerNames_();
  var allowed = { };
  allowed[STREAM_SPARE] = streamAllowed_(ctx.viewer, STREAM_SPARE);
  allowed[STREAM_COMPRESSOR] = streamAllowed_(ctx.viewer, STREAM_COMPRESSOR);

  var received = cards.filter(function (c) { return pdIn_(c.date, ctx); });
  var nUnit = received.filter(function (c) { return c.stream === STREAM_COMPRESSOR; }).length;
  var sent = quotes.filter(function (q) {
    return allowed[String(q.businessStream)] !== false && String(q.status) !== 'Draft' && pdIn_(q.submittedDate || q.emailSentDate, ctx);
  });
  var declined = quotes.filter(function (q) { return String(q.status) === 'Lost' && pdIn_(q.lostDate, ctx); });
  var lost = cards.filter(function (c) { return c.stage === 'lost' && pdIn_(c.lastDate, ctx); });

  var escOpen = escRows_().filter(function (e) { return String(e.status) === 'Open'; })
    .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); })
    .map(function (e) { return escOut_(e, ctx.viewer, ctx.people, ctx.today); });
  var escLong = escOpen.filter(function (e) { return e.waitingDays > 3; }).length;

  var jobs = pdJobs_();
  var jobsIn = jobs.filter(function (j) { return pdIn_(j.date || j.createdAt, ctx); });
  var jobsOpen = jobs.filter(pdJobOpen_);
  var jobsClosed = jobsIn.filter(function (j) { return String(j.status) === 'Completed'; });
  var amc = pdAmcDues_();
  var amcLate = amc.filter(function (d) { return d.state === 'Overdue'; }).length;
  var visits = visitSummary_(ctx.email, true) || { planned: 0, visited: 0, enquiries: 0 };
  var tasks = taskSummary_(ctx.email, true, ctx.period) || { open: 0, overdue: 0, score: null };

  out.tiles = [
    { key: 'enquiries', label: 'Enquiries received', value: String(received.length),
      sub: nUnit + ' compressor · ' + (received.length - nUnit) + ' spares', go: allowed[STREAM_COMPRESSOR] ? 'compressor' : 'enquiries' },
    { key: 'quotes', label: 'Quotations sent', value: String(sent.length), money: pdSum_(sent, function (q) { return q.grand; }),
      sub: 'offered · ' + declined.length + ' declined', go: 'quotations' },
    { key: 'orders', label: 'Orders won', value: String(orders.length), valueMoney: pdSum_(orders, function (o) { return o.grand; }),
      sub: orders.length + ' won · ' + lost.length + ' lost', go: 'orders' },
    { key: 'escalations', label: 'Escalated, open now', value: String(escOpen.length), money: pdSum_(escOpen, function (e) { return e.value; }),
      sub: 'waiting for a decision' + (escLong ? ' · ' + escLong + ' over 3 days' : ''), tone: escOpen.length ? 'warn' : '', go: 'escalations' },
    { key: 'service', label: 'Service calls', value: String(jobsIn.length),
      sub: jobsClosed.length + ' closed · ' + jobsOpen.length + ' open now', go: 'service' },
    { key: 'amc', label: 'AMC dues, next 7 days', value: String(amc.length), sub: amcLate + ' overdue',
      tone: amcLate ? 'warn' : '', go: 'amc' },
    { key: 'visits', label: 'Sales visits this week', value: visits.visited + ' / ' + visits.planned,
      sub: visits.enquiries + (visits.enquiries === 1 ? ' enquiry' : ' enquiries') + ' from visits', go: 'visits' },
    { key: 'tasks', label: 'Task score', value: tasks.score === null ? '—' : tasks.score + '%',
      sub: tasks.overdue + ' overdue · ' + tasks.open + ' open', go: 'tasks' }
  ];

  out.lists.push({ key: 'decisions', title: 'Waiting for your decision', count: escOpen.length,
    empty: 'Nothing waiting. Escalated deals appear here.',
    rows: escOpen.slice(0, 8).map(function (e) {
      return pdRow_(e.customerName, [e.label, e.desk, e.ownerName].filter(Boolean).join(' · '), e.value === '' ? '' : e.value,
        e.waitingDays + (e.waitingDays === 1 ? ' day' : ' days') + ' waiting', e.waitingDays > 3 ? 'warn' : '',
        { kind: e.kind, id: e.recordId });
    }) });

  var due = cards.filter(function (c) { return c.stage !== 'lost' && c.stage !== 'dispatched' && c.followUp && c.followUp <= ctx.tomorrow; })
    .sort(function (a, b) { return String(a.followUp).localeCompare(String(b.followUp)); });
  out.lists.push({ key: 'due', title: 'Follow-ups due', count: due.length, empty: 'No follow-ups due today or tomorrow.',
    rows: due.slice(0, 8).map(function (c) {
      var r = pdCardRow_(c, ctx);
      r.sub = c.no + ' · ' + (c.what || (c.stream === STREAM_COMPRESSOR ? 'Compressor' : 'Spares')) + ' · ' + (c.ownerName || '—');
      r.right = (c.followUp < ctx.today ? pdDay_(c.followUp) + ' · ' + daysBetween_(c.followUp, ctx.today) + ' d late'
        : c.followUp === ctx.today ? 'Today' : 'Tomorrow');
      r.rightSub = c.flag || '';
      r.tone = c.followUp < ctx.today ? 'bad' : '';
      r.chip = c.flag ? (/hot/i.test(c.flag) ? 'bad' : 'warn') : '';
      return r;
    }) });

  out.lists.push({ key: 'amc', title: 'AMC and service dues (overdue + 7 days)', count: amc.length, empty: 'No visits due.',
    rows: amc.slice(0, 8).map(function (d) { return pdAmcRow_(d, ctx); }) });

  var fits = jobsOpen.filter(function (j) { return (String(j.jobType || '') || 'Installation') === 'Installation'; })
    .sort(function (a, b) { return String(a.scheduledDate || '9999').localeCompare(String(b.scheduledDate || '9999')); });
  out.lists.push({ key: 'installations', title: 'Installations coming up', count: fits.length, empty: 'No installations waiting.',
    rows: fits.slice(0, 8).map(function (j) {
      return pdRow_(String(j.customerName || (customers[String(j.customerId)] || {}).name || ''),
        [j.jobNo, j.machineModel, j.serialNo].filter(Boolean).join(' · '),
        j.engineerEmail ? personLine_(j.engineerEmail, ctx.people) : '',
        j.engineerEmail ? (j.scheduledDate ? pdDay_(j.scheduledDate) : 'not scheduled') : 'Not assigned',
        '', { kind: 'job', id: String(j.id) }, j.engineerEmail ? '' : 'warn');
    }) });
}
