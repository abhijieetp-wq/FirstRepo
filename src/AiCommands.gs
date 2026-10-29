/**
 * ERP 2.0's AI commands: a request in plain words — typed, or spoken into the browser — read
 * by Claude into actions: give a task, plan a visit, log a compressor lead, log a spare
 * enquiry, log a service call, open a screen. Nothing is done until the person ticks the
 * actions and presses Do; each then goes through the portal's own save, with its own checks
 * and permissions, exactly as if it had been typed into the form.
 *
 * Claude sees the words, who is asking, today's date and the ERP's short lists — never the
 * customer list or any record. Names in the answer are matched to customers and staff here;
 * a name that matches nobody, or more than one, is said so on the action and it cannot be
 * done until put right by hand.
 *
 * Only on the server (server/ai.js, with ANTHROPIC_API_KEY set) and only on the 2.0 face.
 */

var AI_KINDS = ['task', 'visit', 'lead', 'enquiry', 'service', 'open'];
var AI_SCREENS = {
  dashboard: 'Dashboard', tasks: 'Tasks', escalations: 'Escalations', compressor: 'Compressor Sales',
  enquiries: 'Spare Sales', servicedue: 'SDR', visits: 'Visit plans', quotations: 'All Quotations',
  service: 'Service Jobs', amc: 'AMC', plan: 'Next-day plan', customers: 'Customers', engreport: 'Service engineers'
};
var AI_MAX_ACTIONS = 8;
// Each request is paid for; this keeps one person, or a stuck script, from running up the bill.
var AI_PER_HOUR = 40;

/** Counts this person's requests in the hour; past the limit, says so instead of asking. */
function aiRateCheck_(user) {
  var cache = CacheService.getScriptCache();
  var key = 'ai-asks:' + String(user.email || '').toLowerCase() + ':' + new Date().toISOString().slice(0, 13);
  var n = Number(cache.get(key) || 0);
  if (n >= AI_PER_HOUR) {
    throw new Error('That is ' + AI_PER_HOUR + ' requests this hour, the limit that keeps the AI bill in check. Try again next hour, or do it by hand.');
  }
  cache.put(key, String(n + 1), 3600);
}

/** Whether this server can read requests: the Claude service is there and has its key. */
function aiCommandsOn_() {
  if (typeof claudeStatus_ !== 'function') return false;
  try { return claudeStatus_().enabled === true; } catch (err) { return false; }
}
function aiOffReason_() {
  if (typeof claudeStatus_ !== 'function') return 'AI commands are only on the server version of the ERP.';
  try { return String(claudeStatus_().reason || 'AI commands are off on this server.'); } catch (err) { return 'AI commands are off on this server.'; }
}

/** What this person may ask for: what their role may already do by hand. */
function aiKindsFor_(user) {
  var role = String(user.role);
  var has = function (list) { return list.indexOf(role) !== -1; };
  return AI_KINDS.filter(function (k) {
    switch (k) {
      case 'visit': return has(VISIT_PLANNERS);
      case 'lead': return has(LEAD_EDITORS) && !isServiceOnly_(user) && streamAllowed_(user, STREAM_COMPRESSOR);
      case 'enquiry': return has(ENQUIRY_EDITORS) && !isServiceOnly_(user) && streamAllowed_(user, STREAM_SPARE);
      case 'service': return has(SERVICE_ROLES);
      default: return true;
    }
  });
}

var AI_EXAMPLES = {
  task: 'Remind Priya to send the revised offer to Topworth by Friday, high priority',
  visit: 'Plan a visit to Brightline Mills in Wardha next Tuesday for an air audit',
  lead: 'New lead: Sunrise Agro needs a 37 kW screw compressor, call Mr Rao on 98xxxxxx01, follow up Monday',
  enquiry: 'Spare enquiry from Topworth Urja: air filter and separator for EQ 18',
  service: 'Breakdown at Kalyani Steels, compressor tripping on high temperature, urgent',
  open: 'Show me the SDR list'
};

/** For the command window: whether it works here, and what may be asked. */
function getAiStatus() {
  var user = getCurrentUser();
  var kinds = aiKindsFor_(user);
  return {
    enabled: aiCommandsOn_(), reason: aiCommandsOn_() ? '' : aiOffReason_(), kinds: kinds,
    examples: kinds.map(function (k) { return AI_EXAMPLES[k]; })
  };
}

function aiLists_() {
  var config = visitConfig_();
  return {
    purposes: visitLists_(config).purposes || [], areas: visitAreas_(config).map(function (a) { return a.name; }),
    callTypes: SERVICE_CALL_TYPES, urgencies: SERVICE_URGENCIES, priorities: TASK_PRIORITIES, enquiryTypes: SPARE_ENQUIRY_TYPES
  };
}

/** The standing instructions. Stable, so the same for everybody on the same lists. */
function aiSystem_(kinds, lists) {
  var line = function (k, text) { return kinds.indexOf(k) === -1 ? '' : '- ' + k + ': ' + text + '\n'; };
  return 'You read requests typed or spoken by staff of an industrial compressor dealer in India into actions in their ERP. ' +
    'You only propose; a person confirms each action before anything happens.\n\n' +
    'Actions this person may ask for, and the fields each uses (leave any other field an empty string):\n' +
    line('task', 'give someone a task. title (what to do, short, imperative), person (who does it, as said; "me" for the speaker), ' +
      'date (due date), priority (one of ' + lists.priorities.join(', ') + '; Normal unless said), details.') +
    line('visit', 'plan a customer visit. company, date, area (only one of: ' + (lists.areas.join(', ') || 'none') + '; else empty), ' +
      'purpose (one of: ' + lists.purposes.join(', ') + '; else empty), person (the engineer if someone other than the speaker), details.') +
    line('lead', 'log a compressor sales lead. company, details (what they need), contactName, phone, date (next follow-up), ' +
      'area (as for visits).') +
    line('enquiry', 'log a spare parts enquiry from an existing customer. company, details (the parts or problem, in their words), ' +
      'model (machine model), contactName, phone, type (one of: ' + lists.enquiryTypes.join(', ') + '; Spares unless said).') +
    line('service', 'log a service call. company, type (one of: ' + lists.callTypes.join(', ') + '; Breakdown for a fault), ' +
      'details (the problem in the caller\'s words), model, contactName, phone, priority (one of: ' + lists.urgencies.join(', ') + '; Normal unless said), ' +
      'area (as for visits).') +
    line('open', 'open a screen. screen (one of: ' + Object.keys(AI_SCREENS).map(function (k) { return k + ' = ' + AI_SCREENS[k]; }).join(', ') + ').') +
    '\nRules:\n' +
    '- One action per thing asked. Nothing asked for that is not in the list above: no action, and say so in reply.\n' +
    '- Dates as YYYY-MM-DD, worked out from today\'s date given with the request; "tomorrow", "Friday", "next week" (= next Monday).\n' +
    '- Copy names, numbers and models exactly as said; never invent a phone number, a person or a company.\n' +
    '- reply: one or two short sentences for the person, in plain English, saying what you propose or what you could not do.\n';
}

function aiUserText_(user, today, words) {
  var d = new Date(today + 'T00:00:00Z');
  var day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()];
  return 'Today is ' + day + ', ' + today + '. I am ' + String(user.name || user.email) + ' (' + String(user.role) + ').\n\nRequest: ' + words;
}

function aiSchema_(kinds) {
  var fields = ['title', 'person', 'company', 'date', 'area', 'purpose', 'details', 'contactName', 'phone', 'model', 'type', 'priority', 'screen'];
  var props = { kind: { type: 'string', enum: kinds } };
  fields.forEach(function (f) { props[f] = { type: 'string' }; });
  return {
    type: 'object', additionalProperties: false, required: ['reply', 'actions'],
    properties: {
      reply: { type: 'string' },
      actions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind'].concat(fields), properties: props } }
    }
  };
}

function aiSame_(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }

/** One person by name: the whole name, else the first name. "me" is the speaker. */
function aiPerson_(said, people, user) {
  var s = String(said || '').trim();
  if (!s || /^(me|myself|i)$/i.test(s)) return { person: { email: user.email, name: user.name || user.email } };
  var exact = people.filter(function (p) { return aiSame_(p.name, s) || aiSame_(p.email, s); });
  if (exact.length === 1) return { person: exact[0] };
  var first = people.filter(function (p) { return aiSame_(String(p.name || '').split(/\s+/)[0], s.split(/\s+/)[0]); });
  if (first.length === 1) return { person: first[0] };
  if (first.length > 1) return { problem: 'More than one ' + s + ': ' + first.map(function (p) { return p.name; }).join(', ') + '. Do it by hand.' };
  return { problem: 'Nobody called ' + s + ' in Users.' };
}

/** One customer by name: as written, else the one name that starts with it, else contains it. */
function aiCustomer_(said, customers) {
  var s = String(said || '').trim();
  if (!s) return { problem: 'No company was named.' };
  var low = s.toLowerCase();
  var tiers = [
    customers.filter(function (c) { return aiSame_(c.name, s); }),
    customers.filter(function (c) { return String(c.name || '').toLowerCase().indexOf(low) === 0; }),
    customers.filter(function (c) { return String(c.name || '').toLowerCase().indexOf(low) !== -1; })
  ];
  for (var t = 0; t < tiers.length; t++) {
    if (tiers[t].length === 1) return { customer: tiers[t][0] };
    if (tiers[t].length > 1) return { problem: 'More than one customer matches ' + s + '. Do it by hand.' };
  }
  return { problem: 'No customer called ' + s + '.' };
}

function aiDate_(s) { var d = String(s || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : ''; }
function aiPick_(s, list) { var hit = list.filter(function (x) { return aiSame_(x, s); })[0]; return hit || ''; }
function aiShortDate_(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? m[3] + '-' + m[2] + '-' + m[1] : ''; }

/** What Claude proposed, made into an action this ERP can do: its words, its exact input, or what stops it. */
function aiResolve_(a, ctx) {
  var t = function (k) { return String((a && a[k]) || '').trim(); };
  var kind = String((a && a.kind) || '');
  var out = { kind: kind, label: '', lines: [], input: null, problem: '' };
  if (ctx.kinds.indexOf(kind) === -1) { out.label = 'Something you cannot do here'; out.problem = 'Your role cannot do that by hand either.'; return out; }
  var area = t('area') ? aiPick_(t('area'), ctx.lists.areas) : '';
  var areaLine = t('area') && !area ? t('area') + ' is not on the area list, so left out' : area;
  if (kind === 'task') {
    var who = aiPerson_(t('person'), ctx.people, ctx.user);
    var due = aiDate_(t('date')) || ctx.tomorrow;
    out.label = 'Task: ' + (t('title') || '—');
    out.lines = [['For', who.person ? who.person.name : t('person')], ['Due', aiShortDate_(due)], ['Priority', aiPick_(t('priority'), ctx.lists.priorities) || 'Normal'], ['Details', t('details')]];
    if (!t('title')) out.problem = 'It does not say what needs doing.';
    else if (who.problem) out.problem = who.problem;
    else if (due < ctx.today) out.problem = 'A task cannot be due before today.';
    else out.input = { title: t('title').slice(0, 200), details: t('details'), assigneeEmail: who.person.email, dueDate: due,
      priority: aiPick_(t('priority'), ctx.lists.priorities) || 'Normal' };
  } else if (kind === 'visit') {
    var date = aiDate_(t('date'));
    var engineer = { person: { email: ctx.user.email, name: ctx.user.name } };
    if (t('person') && visitSeeAll_(ctx.user)) engineer = aiPerson_(t('person'), ctx.people, ctx.user);
    var known = t('company') ? aiCustomer_(t('company'), ctx.customers) : {};
    out.label = 'Visit: ' + (t('company') || '—');
    out.lines = [['On', aiShortDate_(date)], ['By', engineer.person ? engineer.person.name : t('person')], ['Area', areaLine],
      ['Purpose', aiPick_(t('purpose'), ctx.lists.purposes)], ['Customer', known.customer ? 'on the customer list' : 'a new prospect'], ['Notes', t('details')]];
    if (!t('company')) out.problem = 'No company was named.';
    else if (!date) out.problem = 'No date was given.';
    else if (engineer.problem) out.problem = engineer.problem;
    else out.input = { engineerEmail: engineer.person.email, visitDate: date, customerName: known.customer ? String(known.customer.name) : t('company'),
      customerId: known.customer ? String(known.customer.id) : '', area: area, purpose: aiPick_(t('purpose'), ctx.lists.purposes), discussion: t('details') };
  } else if (kind === 'lead') {
    var follow = aiDate_(t('date')) || ctx.inThree;
    var match = t('company') ? aiCustomer_(t('company'), ctx.customers) : {};
    out.label = 'Compressor lead: ' + (t('company') || '—');
    out.lines = [['Needs', t('details')], ['Contact', [t('contactName'), t('phone')].filter(Boolean).join(' · ')], ['Follow up', aiShortDate_(follow)],
      ['Area', areaLine], ['Customer', match.customer ? 'on the customer list' : 'a new prospect']];
    if (!t('company')) out.problem = 'No company was named.';
    else out.input = { customerName: match.customer ? String(match.customer.name) : t('company'), customerId: match.customer ? String(match.customer.id) : '',
      contactName: t('contactName'), contactPhone: t('phone'), requirementSummary: t('details'), source: 'Phone', status: 'New',
      nextActionDate: follow, area: area };
  } else if (kind === 'enquiry') {
    var cust = aiCustomer_(t('company'), ctx.customers);
    out.label = 'Spare enquiry: ' + (cust.customer ? cust.customer.name : t('company') || '—');
    out.lines = [['Asked for', t('details')], ['Machine', t('model')], ['Contact', [t('contactName'), t('phone')].filter(Boolean).join(' · ')],
      ['For', aiPick_(t('type'), ctx.lists.enquiryTypes) || 'Spares']];
    if (cust.problem) out.problem = cust.problem + ' A spare enquiry needs a customer on the list — add them first.';
    else if (!t('details')) out.problem = 'It does not say what they asked for.';
    else out.input = { customerId: String(cust.customer.id), customerName: String(cust.customer.name), contactName: t('contactName'),
      contactPhone: t('phone'), productModel: t('model'), requirementText: t('details'), source: 'Phone', urgency: 'Normal',
      enquiryType: aiPick_(t('type'), ctx.lists.enquiryTypes) || 'Spares' };
  } else if (kind === 'service') {
    var c = aiCustomer_(t('company'), ctx.customers);
    var type = aiPick_(t('type'), ctx.lists.callTypes) || 'Breakdown';
    var urgency = aiPick_(t('priority'), ctx.lists.urgencies) || 'Normal';
    out.label = type + ': ' + (c.customer ? c.customer.name : t('company') || '—');
    out.lines = [['Problem', t('details')], ['Machine', t('model')], ['Caller', [t('contactName'), t('phone')].filter(Boolean).join(' · ')],
      ['Urgency', urgency], ['Area', areaLine]];
    if (c.problem) out.problem = c.problem + ' A service call needs a customer on the list.';
    else if (!t('details')) out.problem = 'It does not say what the problem is.';
    else out.input = { customerId: String(c.customer.id), reportedBy: t('contactName'), contactName: t('contactName'), contactPhone: t('phone'),
      machineModel: t('model'), urgency: urgency, scopeText: t('details'), jobType: type, area: area, instruction: '' };
  } else if (kind === 'open') {
    var screen = AI_SCREENS[t('screen')] ? t('screen') : '';
    out.label = 'Open ' + (screen ? AI_SCREENS[screen] : t('screen') || 'a screen');
    if (!screen) out.problem = 'There is no screen called that.';
    else out.input = { view: screen };
  }
  out.lines = out.lines.filter(function (l) { return l[1]; });
  return out;
}

/**
 * Reads a request into proposed actions. Nothing is saved.
 *
 * @return { reply, actions: [{ kind, label, lines: [[label, value]], input, problem }] }
 */
function proposeAiCommand(text) {
  var user = getCurrentUser();
  var words = String(text || '').trim();
  if (!words) throw new Error('Say what you want done.');
  if (words.length > 1000) throw new Error('Keep it under 1,000 characters — ask for a few things at a time.');
  if (!aiCommandsOn_()) throw new Error(aiOffReason_());
  aiRateCheck_(user);
  var kinds = aiKindsFor_(user);
  var lists = aiLists_();
  var today = todayIso_();
  var answer = claudePropose_({ system: aiSystem_(kinds, lists), text: aiUserText_(user, today, words), schema: aiSchema_(kinds) }) || {};
  var ctx = {
    user: user, kinds: kinds, lists: lists, today: today, tomorrow: addDays_(today, 1), inThree: addDays_(today, 3),
    people: readTable_('Users').filter(function (u) { return String(u.active).toUpperCase() !== 'FALSE'; })
      .map(function (u) { return { email: String(u.email), name: String(u.name || u.email) }; }),
    customers: readTable_('Customers').filter(function (c) { return String(c.active).toUpperCase() !== 'FALSE'; })
  };
  var actions = (Array.isArray(answer.actions) ? answer.actions : []).slice(0, AI_MAX_ACTIONS).map(function (a) { return aiResolve_(a, ctx); });
  return { reply: String(answer.reply || '').slice(0, 600), actions: actions };
}

/**
 * Does the actions the person ticked, one by one, each through its own save. One that fails
 * says why and does not stop the rest.
 *
 * @param list [{ kind, input }] as proposeAiCommand gave them
 * @return [{ kind, ok, text, view? }]
 */
function applyAiActions(list) {
  var user = getCurrentUser();
  var kinds = aiKindsFor_(user);
  var items = Array.isArray(list) ? list.slice(0, AI_MAX_ACTIONS) : [];
  if (!items.length) throw new Error('Tick at least one thing to do.');
  var results = [];
  for (var a of items) {
    var kind = String((a && a.kind) || '');
    var input = (a && a.input) || {};
    try {
      if (kinds.indexOf(kind) === -1) throw new Error('Your role cannot do that.');
      if (kind === 'task') {
        var t = saveTask({ title: input.title, details: input.details, assigneeEmail: input.assigneeEmail, dueDate: input.dueDate, priority: input.priority });
        results.push({ kind: kind, ok: true, text: 'Task given to ' + (t.assigneeName || t.assigneeEmail) + '.' });
      } else if (kind === 'visit') {
        saveVisit({ engineerEmail: input.engineerEmail, visitDate: input.visitDate, customerName: input.customerName, customerId: input.customerId,
          area: input.area, purpose: input.purpose, discussion: input.discussion, status: 'Planned' });
        results.push({ kind: kind, ok: true, text: 'Visit to ' + input.customerName + ' planned for ' + aiShortDate_(input.visitDate) + '.' });
      } else if (kind === 'lead') {
        var lead = saveLead({ customerName: input.customerName, customerId: input.customerId, contactName: input.contactName, contactPhone: input.contactPhone,
          requirementSummary: input.requirementSummary, source: input.source || 'Phone', status: 'New', nextActionDate: input.nextActionDate, area: input.area || '' });
        results.push({ kind: kind, ok: true, text: 'Lead ' + (lead.leadNo || '') + ' logged for ' + input.customerName + '.' });
      } else if (kind === 'enquiry') {
        var e = saveSpareEnquiry({ customerId: input.customerId, customerName: input.customerName, contactName: input.contactName, contactPhone: input.contactPhone,
          productModel: input.productModel, requirementText: input.requirementText, source: input.source || 'Phone', urgency: 'Normal', enquiryType: input.enquiryType });
        results.push({ kind: kind, ok: true, text: 'Enquiry ' + (e.enquiryNo || '') + ' logged for ' + input.customerName + '.' });
      } else if (kind === 'service') {
        var job = createServiceJob({ customerId: input.customerId, reportedBy: input.reportedBy, contactName: input.contactName, contactPhone: input.contactPhone,
          machineModel: input.machineModel, urgency: input.urgency, scopeText: input.scopeText, jobType: input.jobType, area: input.area, instruction: '' });
        results.push({ kind: kind, ok: true, text: job.jobNo + ' logged as ' + job.jobType + '.' });
      } else if (kind === 'open') {
        if (!AI_SCREENS[String(input.view)]) throw new Error('There is no screen called that.');
        results.push({ kind: kind, ok: true, text: 'Opening ' + AI_SCREENS[String(input.view)] + '.', view: String(input.view) });
      }
    } catch (err) {
      results.push({ kind: kind, ok: false, text: String((err && err.message) || err) });
    }
  }
  return results;
}
