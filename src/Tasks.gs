/**
 * ERP 2.0's tasks with a scorecard: work given to a person, with a due date and a priority,
 * followed to the end, and people scored on finishing on time — ERP 2's rules, unchanged:
 *
 *   - A task is worth points by its priority: High 15, Normal 10, Low 5.
 *   - Done by the end of its due day earns all of them; done later earns a share (50%).
 *   - Still not done after its due day loses a share of them (−50%) until it is done.
 *   - Open tasks not yet due, and cancelled ones, neither earn nor lose.
 *   - A person's score is the points earned ÷ the points possible, over the tasks due in the
 *     period, never below 0%.
 *
 * Management can change the points and the two shares (ConfigLists, category TaskScore).
 *
 * Anybody can give a task to anybody. A task can be about a record — a spare enquiry, a
 * compressor lead, an opportunity, a quotation or a service job — and opens it.
 *
 * Who may do what, so the scorecard cannot be argued with:
 *   - The person doing it, whoever gave it, and Management mark it in progress, done, or open
 *     again.
 *   - Only whoever gave it, and Management, change what it says, who does it, when it is due
 *     or its priority, cancel it or delete it. Otherwise the person being scored could move
 *     their own due date, or cancel the task that is overdue.
 *   - A new task cannot be due before today, and a due date cannot be moved into the past:
 *     either would make a task overdue the moment it was written.
 *   - Management and ERP Admin see everybody's tasks and the whole scorecard. Everybody else
 *     sees the tasks given to them and the ones they gave, and their own line of the
 *     scorecard.
 *
 * Shown on the 2.0 face only. Nothing in ERP 1 reads the Tasks tab.
 */

var TASK_PRIORITIES = ['High', 'Normal', 'Low'];
var TASK_STATUSES = ['Open', 'In progress', 'Done', 'Cancelled'];
var TASK_SCORE_DEFAULTS = { High: 15, Normal: 10, Low: 5, latePct: 50, overduePct: 50 };
var TASK_PERIODS = [
  { key: 'month', label: 'This month' }, { key: 'lastmonth', label: 'Last month' },
  { key: 'quarter', label: 'This quarter' }, { key: 'fy', label: 'This financial year' },
  { key: 'custom', label: 'Custom range' }
];

/** The records a task can be about: where each lives and what its number is called. */
var TASK_LINKS = {
  enquiry: { table: 'SpareEnquiries', no: 'enquiryNo', word: 'Spare enquiry' },
  lead: { table: 'Leads', no: 'leadNo', word: 'Compressor lead' },
  opportunity: { table: 'Opportunities', no: 'opportunityNo', word: 'Opportunity' },
  quotation: { table: 'Quotations', no: 'quoteNo', word: 'Quotation' },
  service: { table: 'ServiceJobs', no: 'jobNo', word: 'Service job' }
};

function taskBoss_(user) { return MASTER_EDITORS.indexOf(String(user.role)) !== -1; }
function taskLive_(t) { return String(t.active).toUpperCase() !== 'FALSE'; }
function taskSame_(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
/** Whoever gave it, or Management: the fields, cancelling and deleting. */
function taskMayEdit_(t, user) { return taskBoss_(user) || taskSame_(t.createdBy, user.email); }
/** Also the person doing it: in progress, done, open again. */
function taskMayTick_(t, user) { return taskMayEdit_(t, user) || taskSame_(t.assigneeEmail, user.email); }
function taskSees_(t, user) { return taskMayTick_(t, user); }

/** The points and shares in force: ERP 2's, unless Management has changed them. */
function taskScoring_() {
  var s = {};
  Object.keys(TASK_SCORE_DEFAULTS).forEach(function (k) { s[k] = TASK_SCORE_DEFAULTS[k]; });
  try {
    readTable_('ConfigLists').forEach(function (r) {
      if (String(r.category) !== 'TaskScore' || String(r.active).toUpperCase() === 'FALSE') return;
      var k = String(r.code);
      var n = Number(r.label);
      if (Object.prototype.hasOwnProperty.call(s, k) && String(r.label).trim() !== '' && isFinite(n)) s[k] = n;
    });
  } catch (err) {
    // A sheet without the tab scores by the standard rules.
  }
  return s;
}

/** The day, in the business's time, that a moment fell on. */
function taskDay_(stamp) {
  if (!stamp) return '';
  var d = new Date(stamp);
  if (isNaN(d.getTime())) return String(stamp).slice(0, 10);
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd');
}

/**
 * Where a task stands and what it scores today. ERP 2's taskEval, with days instead of
 * milliseconds: "late" is done on a day after the due day.
 */
function taskState_(t, s, today) {
  var points = Number(s[String(t.priority || 'Normal')]);
  if (!isFinite(points)) points = Number(s.Normal) || 0;
  var due = String(t.dueDate || '').slice(0, 10);
  var status = String(t.status || 'Open');
  if (status === 'Cancelled') return { state: 'cancelled', earned: 0, possible: 0, points: points };
  if (status === 'Done') {
    var day = taskDay_(t.doneAt);
    var late = !!(due && day && day > due);
    return { state: late ? 'late' : 'ontime', earned: late ? points * Number(s.latePct) / 100 : points, possible: points,
      points: points, doneDay: day, daysLate: late ? daysBetween_(due, day) : 0 };
  }
  if (due && due < today) {
    return { state: 'overdue', earned: -points * Number(s.overduePct) / 100, possible: points, points: points,
      daysOver: daysBetween_(due, today) };
  }
  return { state: due === today ? 'today' : status === 'In progress' ? 'progress' : 'open', earned: 0, possible: 0, points: points };
}

var TASK_STATE_LABELS = { ontime: 'Done on time', late: 'Done late', overdue: 'Overdue', today: 'Due today',
  progress: 'In progress', open: 'Open', cancelled: 'Cancelled' };

/** The period's first and last day, 'yyyy-mm-dd' both. Quarters and the year are April's. */
function taskPeriod_(opts, today) {
  var key = String(opts.period || 'month');
  if (!TASK_PERIODS.some(function (p) { return p.key === key; })) key = 'month';
  var pad = function (n) { return ('0' + n).slice(-2); };
  var first = function (y, m) { while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return y + '-' + pad(m) + '-01'; };
  var y = Number(today.slice(0, 4));
  var m = Number(today.slice(5, 7));
  var from;
  var to;
  if (key === 'custom') {
    from = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.from || '')) ? String(opts.from) : first(y, m);
    to = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.to || '')) ? String(opts.to) : addDays_(first(y, m + 1), -1);
    if (to < from) throw new Error('The range ends before it starts.');
  } else if (key === 'lastmonth') {
    from = first(y, m - 1);
    to = addDays_(first(y, m), -1);
  } else if (key === 'quarter') {
    var start = m - ((m - 4 + 12) % 3);
    from = first(y, start);
    to = addDays_(first(y, start + 3), -1);
  } else if (key === 'fy') {
    var fy = m >= 4 ? y : y - 1;
    from = fy + '-04-01';
    to = (fy + 1) + '-03-31';
  } else {
    from = first(y, m);
    to = addDays_(first(y, m + 1), -1);
  }
  return { key: key, from: from, to: to };
}

/** "SVJ2610-009 · Testwell Foods" for a record a task is about, or an error if it is gone. */
function taskLink_(kind, id) {
  var spec = TASK_LINKS[String(kind || '')];
  if (!spec) throw new Error('A task can be about an enquiry, a lead, an opportunity, a quotation or a service job.');
  var row = findRowById_(spec.table, id);
  if (!row) throw new Error('That ' + spec.word.toLowerCase() + ' is no longer there.');
  var customer = String(row.customerName || '');
  if (!customer && row.customerId) {
    var c = findRowById_('Customers', row.customerId);
    customer = c ? String(c.name || '') : '';
  }
  return { kind: String(kind), id: String(id), label: [String(row[spec.no] || spec.word), customer].filter(Boolean).join(' · ') };
}

function taskOut_(t, ctx) {
  var r = taskState_(t, ctx.scoring, ctx.today);
  var kind = String(t.linkKind || '');
  return {
    id: String(t.id), title: String(t.title || ''), details: String(t.details || ''),
    assigneeEmail: String(t.assigneeEmail || ''), assigneeName: personLine_(t.assigneeEmail, ctx.people),
    byEmail: String(t.createdBy || ''), byName: personLine_(t.createdBy, ctx.people),
    dueDate: String(t.dueDate || '').slice(0, 10), priority: String(t.priority || 'Normal'), status: String(t.status || 'Open'),
    link: kind && TASK_LINKS[kind] ? { kind: kind, id: String(t.linkId || ''), label: String(t.linkLabel || ''), word: TASK_LINKS[kind].word } : null,
    doneDay: r.doneDay || '', doneByName: personLine_(t.doneBy, ctx.people),
    cancelledDay: taskDay_(t.cancelledAt), createdDay: taskDay_(t.createdAt),
    state: r.state, label: TASK_STATE_LABELS[r.state], earned: r.earned, possible: r.possible, points: r.points,
    daysLate: r.daysLate || 0, daysOver: r.daysOver || 0,
    canEdit: taskMayEdit_(t, ctx.user), canTick: taskMayTick_(t, ctx.user)
  };
}

function taskCtx_(user) {
  return { user: user, today: todayIso_(), scoring: taskScoring_(), people: userNameMap_() };
}

/**
 * The scorecard: one line a person, over the tasks due in the period, best score first.
 * Cancelled tasks are left out altogether.
 */
function taskScorecard_(tasks, period, ctx, onlyEmail) {
  var users = {};
  readTable_('Users').forEach(function (u) {
    users[String(u.email || '').toLowerCase()] = { name: String(u.name || u.email || ''), role: String(u.role || '') };
  });
  var rows = {};
  tasks.forEach(function (t) {
    var due = String(t.dueDate || '').slice(0, 10);
    if (!due || due < period.from || due > period.to || String(t.status) === 'Cancelled') return;
    var e = String(t.assigneeEmail || '').toLowerCase();
    if (!e || (onlyEmail && e !== onlyEmail)) return;
    var u = users[e] || { name: String(t.assigneeEmail), role: '' };
    var row = rows[e] = rows[e] || { email: String(t.assigneeEmail), name: u.name, role: u.role,
      tasks: 0, onTime: 0, late: 0, overdue: 0, open: 0, earned: 0, possible: 0 };
    var r = taskState_(t, ctx.scoring, ctx.today);
    row.tasks++;
    if (r.state === 'ontime') row.onTime++;
    else if (r.state === 'late') row.late++;
    else if (r.state === 'overdue') row.overdue++;
    else row.open++;
    row.earned += r.earned;
    row.possible += r.possible;
  });
  return Object.keys(rows).map(function (k) {
    var row = rows[k];
    row.score = row.possible ? Math.max(0, Math.round(row.earned / row.possible * 100)) : null;
    return row;
  }).sort(function (a, b) {
    var x = a.score === null ? -1 : a.score;
    var y = b.score === null ? -1 : b.score;
    return y - x || a.name.localeCompare(b.name);
  });
}

/**
 * The Tasks screen: the tasks this person may see, the scorecard for the period, the people
 * a task can be given to, and the rules.
 *
 * @param options { period: 'month'|'lastmonth'|'quarter'|'fy'|'custom', from, to }
 */
function getTasks(options) {
  var user = getCurrentUser();
  var ctx = taskCtx_(user);
  var boss = taskBoss_(user);
  var period = taskPeriod_(options || {}, ctx.today);
  var all = readTable_('Tasks').filter(taskLive_);
  var mine = all.filter(function (t) { return taskSees_(t, user); });
  var people = readTable_('Users').filter(function (u) { return String(u.active).toUpperCase() !== 'FALSE' && String(u.email || ''); })
    .map(function (u) { return { email: String(u.email), name: String(u.name || u.email), role: String(u.role || '') }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
  return {
    today: ctx.today, me: String(user.email), boss: boss, canScore: boss,
    period: period, periods: TASK_PERIODS, scoring: ctx.scoring, priorities: TASK_PRIORITIES, statuses: TASK_STATUSES,
    people: people,
    scorecard: taskScorecard_(boss ? all : mine, period, ctx, boss ? '' : String(user.email).toLowerCase()),
    tasks: mine.map(function (t) { return taskOut_(t, ctx); }).sort(function (a, b) {
      return (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.title.localeCompare(b.title);
    })
  };
}

/** One task, as the screen shows it. */
function getTask(id) {
  var user = getCurrentUser();
  var t = findRowById_('Tasks', id);
  if (!t || !taskLive_(t) || !taskSees_(t, user)) throw new Error('That task is no longer there.');
  return taskOut_(t, taskCtx_(user));
}

/**
 * A new task, or a change to one. The link to a record is set when the task is given and
 * stays with it.
 *
 * @param input { id?, title, details, assigneeEmail, dueDate, priority, linkKind?, linkId? }
 */
function saveTask(input) {
  var user = getCurrentUser();
  var i = input || {};
  var ctx = taskCtx_(user);
  var id = String(i.id || '').trim();
  var existing = id ? findRowById_('Tasks', id) : null;
  if (id && (!existing || !taskLive_(existing))) throw new Error('That task is no longer there.');
  if (existing && !taskMayEdit_(existing, user)) {
    throw new Error('Only whoever gave this task, or Management, can change it. You can mark it in progress or done.');
  }

  var title = String(i.title || '').trim();
  if (!title) throw new Error('Say what needs doing.');
  if (title.length > 200) throw new Error('Keep the task under 200 characters; put the rest in the details.');
  var email = String(i.assigneeEmail || '').trim().toLowerCase();
  if (!email) throw new Error('Pick who does it.');
  var person = readTable_('Users').filter(function (u) {
    return String(u.email || '').toLowerCase() === email && String(u.active).toUpperCase() !== 'FALSE';
  })[0];
  if (!person) throw new Error('There is nobody active with that address in Users.');
  var due = String(i.dueDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('Give the date it is due.');
  var oldDue = existing ? String(existing.dueDate || '').slice(0, 10) : '';
  if (due < ctx.today && due !== oldDue) {
    throw new Error(existing ? 'Move the due date to today or later.' : 'A new task cannot be due before today.');
  }
  var priority = TASK_PRIORITIES.indexOf(String(i.priority)) !== -1 ? String(i.priority) : 'Normal';
  var now = nowIso_();
  var record = {
    title: title, details: String(i.details || '').trim(), assigneeEmail: String(person.email), dueDate: due,
    priority: priority, updatedAt: now, updatedBy: user.email
  };
  if (existing) {
    updateRowById_('Tasks', 'id', id, record, 'Task changed');
  } else {
    if (String(i.linkKind || '')) {
      var link = taskLink_(i.linkKind, i.linkId);
      record.linkKind = link.kind;
      record.linkId = link.id;
      record.linkLabel = link.label;
    }
    id = generateId_('TK-');
    record.id = id;
    record.status = 'Open';
    record.active = 'TRUE';
    record.createdAt = now;
    record.createdBy = user.email;
    appendRow_('Tasks', record, 'Task given to ' + person.email);
  }
  return taskOut_(findRowById_('Tasks', id), ctx);
}

/** In progress, done, open again — or cancelled, by whoever gave it or Management. */
function setTaskStatus(id, status) {
  var user = getCurrentUser();
  var to = String(status || '');
  if (TASK_STATUSES.indexOf(to) === -1) throw new Error('A task is Open, In progress, Done or Cancelled.');
  var t = findRowById_('Tasks', id);
  if (!t || !taskLive_(t) || !taskSees_(t, user)) throw new Error('That task is no longer there.');
  var from = String(t.status || 'Open');
  if ((to === 'Cancelled' || from === 'Cancelled') && !taskMayEdit_(t, user)) {
    throw new Error('Only whoever gave this task, or Management, can cancel it or bring it back.');
  }
  if (!taskMayTick_(t, user)) throw new Error('This task is not yours to change.');
  var ctx = taskCtx_(user);
  if (from === to) return taskOut_(t, ctx);
  var now = nowIso_();
  var patch = { status: to, doneAt: '', doneBy: '', cancelledAt: '', cancelledBy: '', updatedAt: now, updatedBy: user.email };
  if (to === 'Done') { patch.doneAt = now; patch.doneBy = user.email; }
  if (to === 'Cancelled') { patch.cancelledAt = now; patch.cancelledBy = user.email; }
  updateRowById_('Tasks', 'id', id, patch, to === 'Done' ? 'Task done' : to === 'Cancelled' ? 'Task cancelled'
    : from === 'Done' || from === 'Cancelled' ? 'Task opened again' : 'Task ' + to.toLowerCase());
  return taskOut_(findRowById_('Tasks', id), ctx);
}

/** Takes a task off the list. It stays on record, as everything does. */
function deleteTask(id) {
  var user = getCurrentUser();
  var t = findRowById_('Tasks', id);
  if (!t || !taskLive_(t) || !taskSees_(t, user)) throw new Error('That task is no longer there.');
  if (!taskMayEdit_(t, user)) throw new Error('Only whoever gave this task, or Management, can delete it.');
  updateRowById_('Tasks', 'id', id, { active: 'FALSE', updatedAt: nowIso_(), updatedBy: user.email }, 'Task deleted');
  return { deleted: true, title: String(t.title || '') };
}

/** The points per priority and the two shares. Management and ERP Admin. */
function saveTaskScoring(input) {
  var user = getCurrentUser();
  requireRole_(user, MASTER_EDITORS);
  var i = input || {};
  var rules = {
    High: [1, 100, 'High priority points'], Normal: [1, 100, 'Normal priority points'], Low: [1, 100, 'Low priority points'],
    latePct: [0, 100, 'The share for finishing late'], overduePct: [0, 100, 'The share lost while overdue']
  };
  var clean = {};
  Object.keys(rules).forEach(function (k) {
    var raw = String(i[k] === undefined || i[k] === null ? '' : i[k]).trim();
    var n = Number(raw);
    if (raw === '' || !isFinite(n) || n !== Math.round(n) || n < rules[k][0] || n > rules[k][1]) {
      throw new Error(rules[k][2] + ' must be a whole number from ' + rules[k][0] + ' to ' + rules[k][1] + '.');
    }
    clean[k] = n;
  });
  var existing = {};
  readTable_('ConfigLists').forEach(function (r) { if (String(r.category) === 'TaskScore') existing[String(r.code)] = String(r.id); });
  var order = 0;
  for (var k of Object.keys(rules)) {
    order++;
    saveConfigListItem({ id: existing[k] || '', category: 'TaskScore', code: k, label: String(clean[k]), sortOrder: order });
  }
  return taskScoring_();
}

/**
 * The person's tasks in a line, for their dashboard: open, overdue, and their score in the
 * dashboard's period (this month unless asked). For Management, everybody's overdue tasks and
 * the team's score.
 */
function taskSummary_(email, everyone, period) {
  var ctx = { today: todayIso_(), scoring: taskScoring_() };
  var all = [];
  try { all = readTable_('Tasks').filter(taskLive_); } catch (err) { return null; }
  var e = String(email || '').toLowerCase();
  var theirs = everyone ? all : all.filter(function (t) { return String(t.assigneeEmail || '').toLowerCase() === e; });
  var open = 0;
  var overdue = 0;
  theirs.forEach(function (t) {
    var s = String(t.status || 'Open');
    if (s === 'Done' || s === 'Cancelled') return;
    open++;
    if (taskState_(t, ctx.scoring, ctx.today).state === 'overdue') overdue++;
  });
  var rows = taskScorecard_(theirs, period || taskPeriod_({ period: 'month' }, ctx.today), ctx, everyone ? '' : e);
  var earned = rows.reduce(function (s, r) { return s + r.earned; }, 0);
  var possible = rows.reduce(function (s, r) { return s + r.possible; }, 0);
  return { open: open, overdue: overdue, score: possible ? Math.max(0, Math.round(earned / possible * 100)) : null };
}
